// A person's browser calling token. The app stores the request and the worker signs the
// token, since only the worker can open the account's API key. The token names the person in
// this business as its identity, may receive calls and never dials, and lasts ten minutes;
// the browser asks for the next one before it runs out.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  type Command,
  type Services,
  type Task,
  type TaskReference,
} from '@repo/commands';
import {
  voiceGrant,
  voiceGrantFailureCodes,
  type VoiceGrant,
  type VoiceGrantFailureCode,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
} from '@repo/kernel';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import type { ReadCallGrants } from './call-ledger.js';
import { mintVoiceDeviceToken } from './voice/device-token.js';
import { voiceIdentity } from './voice/voice-identity.js';
import { VOICE_SIGNING_KEY } from './voice-setup.js';

/** How long a token works; the browser renews it before then. */
export const VOICE_TOKEN_SECONDS = 600;

export const issueVoiceGrantReference = {
  name: 'voice.issue_grant',
  data: z.strictObject({ grantId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

const failureMessages = {
  expired: 'The calling token took too long to prepare. Try again.',
  member_unavailable: 'You can no longer make calls in this business.',
  not_set_up: 'Calling is no longer set up on this Twilio account.',
  key_unreadable: 'The key calling uses could not be read. Set up calling again.',
} as const satisfies Record<VoiceGrantFailureCode, string>;

interface GrantRow {
  readonly id: string;
  readonly status: string;
  readonly token: string | null;
  readonly token_expires_at: Date | null;
  readonly failure_code: string | null;
}

function present(row: GrantRow): VoiceGrant {
  const failure = z.enum(voiceGrantFailureCodes).safeParse(row.failure_code);
  const live = row.token_expires_at !== null && row.token_expires_at.getTime() > Date.now();
  return voiceGrant.parse({
    id: toPublicId('voice_grant', row.id),
    status: row.status,
    token: live ? row.token : null,
    expiresAt: row.token_expires_at?.toISOString() ?? null,
    failure:
      row.status === 'failed' && failure.success
        ? { code: failure.data, message: failureMessages[failure.data] }
        : null,
  });
}

const columns = ['id', 'status', 'token', 'token_expires_at', 'failure_code'] as const;

/**
 * Stores the request for a token and queues the worker. Only a person signed in has a
 * browser to ring; the account is the default number's, if calling is set up there.
 */
const requestInput = z.strictObject({});

export const requestVoiceGrantCommand: Command<typeof requestInput, VoiceGrant> = defineCommand({
  name: 'calls.request_voice_grant',
  permission: 'calls.place',
  input: requestInput,
  async handle(trx, _input, command): Promise<VoiceGrant> {
    const businessId = requireBusiness(command.context);
    const userId = command.context.userId;
    if (command.context.actorKind !== 'user' || userId === undefined)
      throw new ForbiddenError('Only a person signed in can have a calling token.');
    const setup = await trx
      .selectFrom('messaging.voice_setups as setup')
      .innerJoin('messaging.provider_connections as connection', (join) =>
        join
          .onRef('connection.id', '=', 'setup.connection_id')
          .onRef('connection.business_id', '=', 'setup.business_id'),
      )
      .select('setup.connection_id')
      .where('setup.status', '=', 'ready')
      .where('connection.status', '=', 'connected')
      // The default number's account first, when calling is set up there.
      .orderBy(
        sql`setup.connection_id = (
          select number.provider_connection_id
          from messaging.phone_system_settings settings
          join messaging.phone_numbers number
            on number.id = settings.default_phone_number_id
           and number.business_id = settings.business_id
        ) desc nulls last`,
      )
      .orderBy('setup.finished_at')
      .orderBy('setup.connection_id')
      .executeTakeFirst();
    if (setup === undefined)
      throw new ConflictError(
        'Calling isn’t set up yet. Set it up on a Twilio account in Settings → Phone System.',
      );
    const row = await trx
      .insertInto('messaging.voice_grants')
      .values({ business_id: businessId, user_id: userId, connection_id: setup.connection_id })
      .returning(columns)
      .executeTakeFirstOrThrow();
    command.enqueue(issueVoiceGrantReference, { grantId: row.id });
    return present(row);
  },
});

/** The request, as the person who made it reads it; anyone else finds nothing. */
export async function readVoiceGrant(
  trx: DatabaseTransaction,
  publicId: string,
): Promise<VoiceGrant> {
  const id = parsePublicId('voice_grant', publicId);
  const row =
    id === undefined
      ? undefined
      : await trx
          .selectFrom('messaging.voice_grants')
          .select(columns)
          .where('id', '=', id)
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Calling token', publicId);
  return present(row);
}

const signingKey = z.strictObject({
  sid: z.string(),
  secret: z.string(),
  type: z.literal('standard'),
});

type Signed =
  | { readonly token: string; readonly expiresAt: string }
  | { readonly failure: VoiceGrantFailureCode };

/** Signs the token, or says why it can't be signed. Opens the key; reaches nobody outside. */
async function sign(
  trx: DatabaseTransaction,
  request: {
    readonly businessId: string;
    readonly context: Parameters<ReadCallGrants>[1];
    readonly userId: string;
    readonly connectionId: string;
    readonly expired: boolean;
  },
  vault: Vault,
  readGrants: ReadCallGrants,
): Promise<Signed> {
  if (request.expired) return { failure: 'expired' };
  const grants = await readGrants(trx, request.context, request.userId);
  if (grants?.has('calls.place') !== true) return { failure: 'member_unavailable' };
  const setup = await trx
    .selectFrom('messaging.voice_setups as setup')
    .innerJoin('messaging.provider_connections as connection', (join) =>
      join
        .onRef('connection.id', '=', 'setup.connection_id')
        .onRef('connection.business_id', '=', 'setup.business_id'),
    )
    .select([
      'setup.status',
      'setup.secret_id',
      'connection.status as connection_status',
      'connection.account_ref',
    ])
    .where('setup.connection_id', '=', request.connectionId)
    .executeTakeFirst();
  if (
    setup?.status !== 'ready' ||
    setup.connection_status !== 'connected' ||
    setup.secret_id === null
  )
    return { failure: 'not_set_up' };
  let opened: unknown;
  try {
    opened = JSON.parse(await vault.read(trx, setup.secret_id, VOICE_SIGNING_KEY));
  } catch (failure) {
    // Nothing of a failure is passed on: a parse error can quote the decrypted text.
    if (!(failure instanceof SecretUnreadableError || failure instanceof SyntaxError))
      throw failure;
    return { failure: 'key_unreadable' };
  }
  const key = signingKey.safeParse(opened);
  if (!key.success) return { failure: 'key_unreadable' };
  return mintVoiceDeviceToken({
    accountSid: setup.account_ref,
    keySid: key.data.sid,
    keySecret: key.data.secret,
    keyType: key.data.type,
    identity: voiceIdentity(request.businessId, request.userId),
    incomingAllowed: true,
    ttlSeconds: VOICE_TOKEN_SECONDS,
  });
}

/**
 * The worker's half: rechecks that the person may still place calls here, opens the key and
 * signs the token. Nothing here reaches Twilio; the token is a signed statement it checks.
 */
export function createIssueVoiceGrantTask(
  vault: Vault,
  readGrants: ReadCallGrants,
): Task<typeof issueVoiceGrantReference.data> {
  return defineTask({
    ...issueVoiceGrantReference,
    async run({ grantId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      await withTenant(services.db, invocation.context, async (trx) => {
        const grant = await trx
          .selectFrom('messaging.voice_grants')
          .select(['status', 'user_id', 'connection_id', 'expires_at'])
          .where('id', '=', grantId)
          .forUpdate()
          .executeTakeFirst();
        if (grant?.status !== 'requested') return;
        const outcome = await sign(
          trx,
          {
            businessId,
            context: invocation.context,
            userId: grant.user_id,
            connectionId: grant.connection_id,
            expired: grant.expires_at.getTime() <= Date.now(),
          },
          vault,
          readGrants,
        );
        await trx
          .updateTable('messaging.voice_grants')
          .set(
            'failure' in outcome
              ? { status: 'failed', failure_code: outcome.failure }
              : {
                  status: 'issued',
                  token: outcome.token,
                  token_expires_at: new Date(outcome.expiresAt),
                  issued_at: sql<Date>`now()`,
                },
          )
          .where('id', '=', grantId)
          .execute();
      });
    },
  });
}

/** Clears expired tokens and old requests in every business; for the worker's schedule. */
export async function expireVoiceGrants(services: Services): Promise<number> {
  const {
    rows: [row],
  } = await sql<{ changed: number }>`
    select private.expire_voice_grants(5000::integer) as changed
  `.execute(services.db);
  return row?.changed ?? 0;
}
