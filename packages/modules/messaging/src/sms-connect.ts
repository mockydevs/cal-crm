// Connecting a Twilio account. As with a mailbox (attempts.ts, verify.ts): the app seals
// the credentials and queues a check; only the worker can open them, so only the worker
// asks Twilio whether they work. Nothing here buys or changes anything at Twilio: the check
// is two reads.
import { randomUUID } from 'node:crypto';

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
  connectSmsInput,
  smsConnection,
  smsConnectionAttempt,
  smsConnectionResult,
  type SmsConnection,
  type SmsConnectionAttempt,
  type SmsConnectionResult,
  type SmsConnectionStarted,
} from '@repo/contracts';
import { explainUniqueViolation, withTenant, type DatabaseTransaction, type DB } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { SecretUnreadableError, type SealingVault, type Vault } from '@repo/module-vault';
import { sql, type Selectable } from 'kysely';
import * as z from 'zod';

import {
  inboundWebhookUrl,
  isWebhookToken,
  newWebhookToken,
  smsWebhookOrigin,
  webhookDigest,
} from './sms-webhook-url.js';
import {
  fetchAccount,
  listIncomingPhoneNumbers,
  type TwilioCredentials,
  type TwilioNumber,
  type TwilioTransport,
} from './twilio-api.js';

export const SMS_CREDENTIALS = 'sms.twilio.credentials';

export const verifySmsConnectionReference = {
  name: 'sms.verify_connection',
  data: z.strictObject({ attemptId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;
export const syncSmsNumbersReference = {
  name: 'sms.sync_numbers',
  data: z.strictObject({ connectionId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

// The vault's plaintext: what the customer gave, and the token of the webhook URLs.
const sealedCredentials = z.strictObject({
  accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  authToken: z.string().min(1),
  apiKey: z.strictObject({ sid: z.string().min(1), secret: z.string().min(1) }).optional(),
  webhookToken: z.string().refine(isWebhookToken),
});
export type SmsCredentials = TwilioCredentials & { readonly webhookToken: string };

/**
 * Opens a connection's credentials, or gives null when they can't be read. Worker only.
 * Nothing about a failure is passed on: a parse error can quote the decrypted text.
 */
export async function openSmsCredentials(
  trx: DatabaseTransaction,
  vault: Vault,
  secretId: string,
): Promise<SmsCredentials | null> {
  let opened: unknown;
  try {
    opened = JSON.parse(await vault.read(trx, secretId, SMS_CREDENTIALS));
  } catch (failure) {
    if (!(failure instanceof SecretUnreadableError || failure instanceof SyntaxError))
      throw failure;
    return null;
  }
  const parsed = sealedCredentials.safeParse(opened);
  return parsed.success ? parsed.data : null;
}

type AttemptRow = Selectable<DB['messaging.sms_connection_attempts']>;
type Failure = Extract<SmsConnectionAttempt, { status: 'failed' }>['failure'];

async function findAttempt(
  trx: DatabaseTransaction,
  id: string,
  lock = false,
): Promise<AttemptRow | undefined> {
  const query = trx
    .selectFrom('messaging.sms_connection_attempts')
    .selectAll()
    .where('id', '=', id);
  return (lock ? query.forUpdate() : query).executeTakeFirst();
}

export async function readSmsConnectionAttempt(
  trx: DatabaseTransaction,
  publicId: string,
): Promise<SmsConnectionAttempt> {
  const id = parsePublicId('sms_attempt', publicId);
  const row = id === undefined ? undefined : await findAttempt(trx, id);
  if (row === undefined) throw new NotFoundError('SMS connection attempt', publicId);
  const common = {
    id: toPublicId('sms_attempt', row.id),
    createdAt: row.created_at.toISOString(),
  };
  if (row.status === 'connected' && row.connection_id !== null)
    return smsConnectionAttempt.parse({
      ...common,
      status: 'connected',
      connectionId: toPublicId('sms_connection', row.connection_id),
      result: smsConnectionResult.parse(row.result),
    });
  return smsConnectionAttempt.parse({
    ...common,
    status: row.status,
    connectionId: null,
    result: null,
    ...(row.status === 'failed' ? { failure: row.failure_code } : {}),
  });
}

/** Clear the reference before removing its secret; a connected account never uses this path. */
async function failAttempt(
  trx: DatabaseTransaction,
  vault: SealingVault,
  row: AttemptRow,
  failure: Failure,
): Promise<void> {
  await trx
    .updateTable('messaging.sms_connection_attempts')
    .set({
      status: 'failed',
      failure_code: failure,
      secret_id: null,
      finished_at: sql<Date>`now()`,
    })
    .where('id', '=', row.id)
    .execute();
  if (row.secret_id !== null) await vault.remove(trx, row.secret_id);
}

/**
 * Seals the credentials and queues their check. The answer carries the inbound webhook
 * address once: its token is sealed with the credentials, and the app can't open them
 * again. The audit record keeps the label and the Account SID, which is not a secret.
 */
export function createConnectSmsCommand(
  vault: SealingVault,
  publicUrl: string,
): Command<typeof connectSmsInput, SmsConnectionStarted> {
  const origin = smsWebhookOrigin(publicUrl);
  return defineCommand({
    name: 'sms.connect',
    permission: 'sms.manage',
    input: connectSmsInput,
    audit: ({ provider, label, accountSid }) => ({ provider, label, accountSid }),
    async handle(trx, input, command): Promise<SmsConnectionStarted> {
      const businessId = requireBusiness(command.context);
      const existing = await trx
        .selectFrom('messaging.provider_connections')
        .select('id')
        .where('business_id', '=', businessId)
        .where('provider', '=', input.provider)
        .where('account_ref', '=', input.accountSid)
        .executeTakeFirst();
      if (existing !== undefined)
        throw new ConflictError('This Twilio account is already connected.');
      const pending = await trx
        .selectFrom('messaging.sms_connection_attempts')
        .selectAll()
        .where('provider', '=', input.provider)
        .where('account_ref', '=', input.accountSid)
        .where('status', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      if (pending !== undefined) {
        if (pending.expires_at.getTime() > Date.now())
          throw new ConflictError('This Twilio account is already being checked.');
        await failAttempt(trx, vault, pending, 'expired');
      }
      const webhookToken = newWebhookToken();
      const secretId = await vault.store(
        trx,
        { agencyId: command.context.agencyId, businessId, purpose: SMS_CREDENTIALS },
        JSON.stringify({
          accountSid: input.accountSid,
          authToken: input.authToken,
          ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
          webhookToken,
        }),
      );
      const row = await trx
        .insertInto('messaging.sms_connection_attempts')
        .values({
          business_id: businessId,
          provider: input.provider,
          label: input.label,
          account_ref: input.accountSid,
          secret_id: secretId,
        })
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow()
        .catch(
          explainUniqueViolation({
            sms_attempts_pending_account_unique: () =>
              new ConflictError('This Twilio account is already being checked.'),
          }),
        );
      await command.emit({
        type: 'sms.connection_requested',
        subject: { kind: 'sms_attempt', id: row.id },
      });
      command.enqueue(verifySmsConnectionReference, { attemptId: row.id });
      return {
        attempt: {
          id: toPublicId('sms_attempt', row.id),
          status: 'pending',
          connectionId: null,
          result: null,
          createdAt: row.created_at.toISOString(),
        },
        inboundWebhookUrl: origin === null ? null : inboundWebhookUrl(origin, webhookToken),
      };
    },
  });
}

async function saveNumbers(
  trx: DatabaseTransaction,
  businessId: string,
  connectionId: string,
  numbers: readonly TwilioNumber[],
): Promise<void> {
  // The cache mirrors the last read: a number the account no longer has is dropped from
  // the list. A number already registered keeps its own row in messaging.phone_numbers.
  await trx
    .deleteFrom('messaging.provider_numbers')
    .where('connection_id', '=', connectionId)
    .execute();
  if (numbers.length === 0) return;
  await trx
    .insertInto('messaging.provider_numbers')
    .values(
      numbers.map((number) => ({
        business_id: businessId,
        connection_id: connectionId,
        provider_number_ref: number.sid,
        e164: number.e164,
        friendly_name: number.friendlyName.slice(0, 120),
        capabilities: [...number.capabilities],
      })),
    )
    .execute();
}

/**
 * Checks pending credentials with Twilio and, if they work, saves the connection with the
 * numbers the account owns. Only the worker gets a vault that can open credentials; the
 * two Twilio reads hold no database transaction.
 */
export function createVerifySmsConnectionTask(
  vault: Vault,
  transport: TwilioTransport,
): Task<typeof verifySmsConnectionReference.data> {
  return defineTask({
    ...verifySmsConnectionReference,
    async run({ attemptId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await findAttempt(trx, attemptId, true);
        if (row?.status !== 'pending' || row.secret_id === null) return null;
        if (row.expires_at.getTime() <= Date.now()) {
          await failAttempt(trx, vault, row, 'expired');
          return null;
        }
        const credentials = await openSmsCredentials(trx, vault, row.secret_id);
        if (credentials?.accountSid !== row.account_ref) {
          await failAttempt(trx, vault, row, 'credentials_unreadable');
          return null;
        }
        return { secretId: row.secret_id, credentials };
      });
      if (prepared === null) return;

      const { credentials } = prepared;
      let failure: Failure | null = null;
      let result: SmsConnectionResult | null = null;
      let numbers: readonly TwilioNumber[] = [];
      const account = await fetchAccount(transport, credentials);
      if (account.outcome === 'refused') failure = 'authentication';
      else if (account.outcome === 'unavailable' || account.account.sid !== credentials.accountSid)
        failure = 'provider_unavailable';
      else if (account.account.status !== 'active') failure = 'account_inactive';
      else {
        const listed = await listIncomingPhoneNumbers(transport, credentials);
        if (listed.outcome === 'refused') failure = 'authentication';
        else if (listed.outcome === 'unavailable') failure = 'provider_unavailable';
        else {
          numbers = listed.numbers;
          result = {
            accountType: account.account.type,
            accountStatus: account.account.status,
            subaccount: account.account.subaccount,
            numbersFound: numbers.length,
          };
        }
      }

      await withTenant(services.db, invocation.context, async (trx) => {
        const row = await findAttempt(trx, attemptId, true);
        if (row?.status !== 'pending' || row.secret_id !== prepared.secretId) return;
        const taken = await trx
          .selectFrom('messaging.provider_connections')
          .select('id')
          .where('business_id', '=', businessId)
          .where('provider', '=', row.provider)
          .where('account_ref', '=', row.account_ref)
          .executeTakeFirst();
        if (row.expires_at.getTime() <= Date.now()) await failAttempt(trx, vault, row, 'expired');
        else if (failure !== null || result === null)
          await failAttempt(trx, vault, row, failure ?? 'provider_unavailable');
        else if (taken !== undefined) await failAttempt(trx, vault, row, 'already_connected');
        else {
          const connection = await trx
            .insertInto('messaging.provider_connections')
            .values({
              agency_id: invocation.context.agencyId,
              business_id: businessId,
              provider: row.provider,
              label: row.label,
              account_ref: row.account_ref,
              secret_id: prepared.secretId,
              status: 'connected',
              last_checked_at: sql<Date>`now()`,
              account_type: result.accountType,
              account_status: result.accountStatus,
              webhook_digest: webhookDigest(credentials.webhookToken),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await saveNumbers(trx, businessId, connection.id, numbers);
          await trx
            .updateTable('messaging.sms_connection_attempts')
            .set({
              status: 'connected',
              secret_id: null,
              connection_id: connection.id,
              result: sql`${JSON.stringify(result)}::jsonb`,
              finished_at: sql<Date>`now()`,
            })
            .where('id', '=', attemptId)
            .execute();
        }
        await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
      });
    },
  });
}

/** Reads a connected account's numbers again. A read that fails changes nothing. */
export function createSyncSmsNumbersTask(
  vault: Vault,
  transport: TwilioTransport,
): Task<typeof syncSmsNumbersReference.data> {
  return defineTask({
    ...syncSmsNumbersReference,
    async run({ connectionId }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await trx
          .selectFrom('messaging.provider_connections')
          .select(['secret_id', 'account_ref'])
          .where('id', '=', connectionId)
          .where('business_id', '=', businessId)
          .where('provider', '=', 'twilio')
          .where('status', '<>', 'disconnected')
          .executeTakeFirst();
        if (row === undefined) return null;
        const credentials = await openSmsCredentials(trx, vault, row.secret_id);
        return credentials?.accountSid === row.account_ref ? credentials : null;
      });
      if (prepared === null) return;
      const listed = await listIncomingPhoneNumbers(transport, prepared);
      if (listed.outcome !== 'ok') return;
      await withTenant(services.db, invocation.context, async (trx) => {
        const current = await trx
          .selectFrom('messaging.provider_connections')
          .select('id')
          .where('id', '=', connectionId)
          .where('business_id', '=', businessId)
          .where('account_ref', '=', prepared.accountSid)
          .forUpdate()
          .executeTakeFirst();
        if (current === undefined) return;
        await saveNumbers(trx, businessId, connectionId, listed.numbers);
        await trx
          .updateTable('messaging.provider_connections')
          .set({ last_checked_at: sql<Date>`now()` })
          .where('id', '=', connectionId)
          .execute();
        await sql`select pg_notify('crm_business_changed', ${businessId})`.execute(trx);
      });
    },
  });
}

/** The business's own connections, without credentials. Call in the reader's transaction. */
export async function readSmsConnections(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<SmsConnection[]> {
  const rows = await trx
    .selectFrom('messaging.provider_connections')
    .select([
      'id',
      'label',
      'account_ref',
      'status',
      'account_type',
      'account_status',
      'last_checked_at',
      'created_at',
    ])
    // A connection shared by the whole agency is visible here too; it isn't offered yet.
    .where('business_id', '=', businessId)
    .where('provider', '=', 'twilio')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map((row) =>
    smsConnection.parse({
      id: toPublicId('sms_connection', row.id),
      provider: 'twilio',
      label: row.label,
      accountSid: row.account_ref,
      status: row.status,
      accountType: row.account_type,
      accountStatus: row.account_status,
      warnings: [
        ...(row.account_type === 'trial' ? ['trial_account'] : []),
        ...(row.account_status !== null && row.account_status !== 'active'
          ? ['account_not_active']
          : []),
      ],
      lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    }),
  );
}

/** Bounded, tenant-scoped cleanup of attempts nobody finished; their secrets go with them. */
export async function expireSmsConnectionAttempts(
  services: Services,
  vault: SealingVault,
): Promise<number> {
  const { rows } = await sql<{
    agency_id: string;
    business_id: string;
    attempt_id: string;
  }>`select * from private.expired_sms_connection_attempts(1000)`.execute(services.db);
  let removed = 0;
  for (const row of rows) {
    const expired = await withTenant(
      services.db,
      {
        agencyId: row.agency_id,
        businessId: row.business_id,
        actorKind: 'system',
        correlationId: randomUUID(),
      },
      async (trx) => {
        const attempt = await findAttempt(trx, row.attempt_id, true);
        if (attempt?.status !== 'pending' || attempt.expires_at.getTime() > Date.now())
          return false;
        await failAttempt(trx, vault, attempt, 'expired');
        await sql`select pg_notify('crm_business_changed', ${row.business_id})`.execute(trx);
        return true;
      },
    );
    if (expired) removed += 1;
  }
  return removed;
}
