// Setting up browser calling on a connected Twilio account. Calling needs a Standard API
// key to sign each person's access token, and Twilio shows its secret once, in the answer
// to the request that creates it. So the worker marks the setup creating and commits before
// it asks, and records the answer in a second transaction: a lost answer, or a run that
// finds the setup still creating, ends as unknown and is never asked again by itself.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  type Command,
  type Task,
  type TaskReference,
} from '@repo/commands';
import {
  callingSetup,
  callingSetupFailureCodes,
  type CallingSetup,
  type CallingSetupList,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import type { Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { openSmsCredentials } from './sms-connect.js';
import type { VoiceTransport } from './voice/twilio-voice.js';
import { createVoiceSigningKey } from './voice/voice-signing-key.js';

/** The vault purpose of a voice key's secret; only the worker opens it. */
export const VOICE_SIGNING_KEY = 'voice.twilio.signing_key';

export const setUpCallingReference = {
  name: 'voice.set_up_calling',
  data: z.strictObject({ connectionId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

const failureMessages = {
  credentials_unreadable:
    'The Twilio account’s credentials could not be read. Connect the account again, then set up calling.',
  connection_unavailable: 'The Twilio account is no longer connected. Connect it again first.',
  provider_rejected: 'Twilio refused to create the key calling needs. Check the account in Twilio.',
} as const;
type FailureCode = keyof typeof failureMessages;

interface AccountRow {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly created_at: Date;
  readonly voice_numbers: number | null;
  readonly setup_status: string | null;
  readonly failure_code: string | null;
  readonly provider_error_code: number | null;
  readonly requested_at: Date | null;
  readonly finished_at: Date | null;
}

function accounts(trx: DatabaseTransaction) {
  return trx
    .selectFrom('messaging.provider_connections as connection')
    .leftJoin('messaging.voice_setups as setup', (join) =>
      join
        .onRef('setup.connection_id', '=', 'connection.id')
        .onRef('setup.business_id', '=', 'connection.business_id'),
    )
    .select((eb) => [
      'connection.id',
      'connection.label',
      'connection.status',
      'connection.created_at',
      'setup.status as setup_status',
      'setup.failure_code',
      'setup.provider_error_code',
      'setup.requested_at',
      'setup.finished_at',
      eb
        .selectFrom('messaging.phone_numbers as number')
        .innerJoin('messaging.channel_accounts as channel', (join) =>
          join
            .onRef('channel.id', '=', 'number.id')
            .onRef('channel.business_id', '=', 'number.business_id'),
        )
        .select(sql<number>`count(*)::int`.as('n'))
        .whereRef('number.provider_connection_id', '=', 'connection.id')
        .where('channel.status', '=', 'active')
        .where((inner) => inner(inner.val('voice'), '=', inner.fn.any('number.capabilities')))
        .as('voice_numbers'),
    ])
    .where('connection.provider', '=', 'twilio');
}

const inProgress = (status: string | null): boolean =>
  status === 'requested' || status === 'creating';

function present(row: AccountRow): CallingSetup {
  const code = z.enum(callingSetupFailureCodes).safeParse(row.failure_code);
  const failure =
    row.setup_status === 'failed' && code.success
      ? {
          code: code.data,
          providerErrorCode: row.provider_error_code,
          message: failureMessages[code.data],
        }
      : null;
  return callingSetup.parse({
    connectionId: toPublicId('sms_connection', row.id),
    label: row.label,
    connectionStatus: row.status,
    voiceNumbers: row.voice_numbers ?? 0,
    setup:
      row.setup_status === null || row.requested_at === null
        ? null
        : {
            status: row.setup_status,
            failure,
            requestedAt: row.requested_at.toISOString(),
            finishedAt: row.finished_at?.toISOString() ?? null,
          },
    canSetUp:
      row.status === 'connected' && row.setup_status !== 'ready' && !inProgress(row.setup_status),
  });
}

/** Every Twilio account of the business, in the order it was connected. */
export async function readCallingSetups(trx: DatabaseTransaction): Promise<CallingSetupList> {
  const rows = await accounts(trx)
    .orderBy('connection.created_at')
    .orderBy('connection.id')
    .execute();
  return { data: rows.map(present) };
}

const setUpInput = z.strictObject({ id: z.string() });

/**
 * Queues setting up calling on one of the business's own Twilio accounts. While a setup is
 * in progress, asking again returns it as it is; a ready one is refused, since a second key
 * would only be another credential on the account.
 */
export const setUpCallingCommand: Command<typeof setUpInput, CallingSetup> = defineCommand({
  name: 'phone.set_up_calling',
  permission: 'phone.manage',
  input: setUpInput,
  async handle(trx, input, command): Promise<CallingSetup> {
    const businessId = requireBusiness(command.context);
    const id = parsePublicId('sms_connection', input.id);
    const connection =
      id === undefined
        ? undefined
        : await trx
            .selectFrom('messaging.provider_connections')
            .select(['id', 'status'])
            .where('id', '=', id)
            .where('business_id', '=', businessId)
            .where('provider', '=', 'twilio')
            .forShare()
            .executeTakeFirst();
    if (connection === undefined) throw new NotFoundError('SMS connection', input.id);
    const current = await trx
      .selectFrom('messaging.voice_setups')
      .select('status')
      .where('connection_id', '=', connection.id)
      .forUpdate()
      .executeTakeFirst();
    if (current?.status === 'ready')
      throw new ConflictError('Calling is already set up on this Twilio account.');
    if (!inProgress(current?.status ?? null)) {
      if (connection.status !== 'connected')
        throw new ConflictError('Connect this Twilio account again before setting up calling.');
      const values = {
        status: 'requested',
        key_sid: null,
        secret_id: null,
        failure_code: null,
        provider_error_code: null,
        finished_at: null,
        requested_by: command.context.userId ?? null,
        requested_at: sql<Date>`now()`,
      } as const;
      await trx
        .insertInto('messaging.voice_setups')
        .values({ business_id: businessId, connection_id: connection.id, ...values })
        .onConflict((conflict) =>
          conflict.columns(['business_id', 'connection_id']).doUpdateSet(values),
        )
        .execute();
      command.enqueue(setUpCallingReference, { connectionId: connection.id });
      await command.emit({
        type: 'phone.calling_setup_requested',
        subject: { kind: 'sms_connection', id: connection.id },
        payload: {},
      });
    }
    const row = await accounts(trx)
      .where('connection.id', '=', connection.id)
      .executeTakeFirstOrThrow();
    return present(row);
  },
});

async function finish(
  trx: DatabaseTransaction,
  connectionId: string,
  values:
    | { readonly status: 'ready'; readonly key_sid: string; readonly secret_id: string }
    | {
        readonly status: 'failed';
        readonly failure_code: FailureCode;
        readonly provider_error_code?: number | null;
      }
    | { readonly status: 'unknown' },
): Promise<void> {
  await trx
    .updateTable('messaging.voice_setups')
    .set({ ...values, finished_at: sql<Date>`now()` })
    .where('connection_id', '=', connectionId)
    .execute();
}

/**
 * The worker's half: opens the account's credentials, creates the key and seals its secret.
 * Only the worker's vault opens credentials; Twilio is asked with no transaction open.
 */
export function createSetUpCallingTask(
  vault: Vault,
  transport: VoiceTransport,
): Task<typeof setUpCallingReference.data> {
  return defineTask({
    ...setUpCallingReference,
    async run({ connectionId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      const credentials = await withTenant(services.db, invocation.context, async (trx) => {
        const setup = await trx
          .selectFrom('messaging.voice_setups')
          .select('status')
          .where('connection_id', '=', connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (setup?.status === 'creating') {
          // A run before this one asked Twilio and never recorded the answer: a key may exist.
          await finish(trx, connectionId, { status: 'unknown' });
          return null;
        }
        if (setup?.status !== 'requested') return null;
        const connection = await trx
          .selectFrom('messaging.provider_connections')
          .select(['status', 'secret_id', 'account_ref'])
          .where('id', '=', connectionId)
          .where('business_id', '=', businessId)
          .executeTakeFirst();
        if (connection?.status !== 'connected') {
          await finish(trx, connectionId, {
            status: 'failed',
            failure_code: 'connection_unavailable',
          });
          return null;
        }
        const opened = await openSmsCredentials(trx, vault, connection.secret_id);
        if (opened?.accountSid !== connection.account_ref) {
          await finish(trx, connectionId, {
            status: 'failed',
            failure_code: 'credentials_unreadable',
          });
          return null;
        }
        await trx
          .updateTable('messaging.voice_setups')
          .set({ status: 'creating' })
          .where('connection_id', '=', connectionId)
          .execute();
        return opened;
      });
      if (credentials === null) return;

      const result = await createVoiceSigningKey(transport, credentials);

      await withTenant(services.db, invocation.context, async (trx) => {
        const setup = await trx
          .selectFrom('messaging.voice_setups')
          .select('status')
          .where('connection_id', '=', connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (setup?.status !== 'creating') return;
        if (result.outcome === 'created') {
          const secretId = await vault.store(
            trx,
            { agencyId: invocation.context.agencyId, businessId, purpose: VOICE_SIGNING_KEY },
            JSON.stringify(result.key),
          );
          await finish(trx, connectionId, {
            status: 'ready',
            key_sid: result.key.sid,
            secret_id: secretId,
          });
        } else if (result.outcome === 'rejected')
          await finish(trx, connectionId, {
            status: 'failed',
            failure_code: 'provider_rejected',
            provider_error_code: result.code,
          });
        else await finish(trx, connectionId, { status: 'unknown' });
      });
    },
  });
}
