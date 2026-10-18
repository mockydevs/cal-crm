import { randomUUID } from 'node:crypto';
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Invocation,
  type Services,
  type Task,
} from '@repo/commands';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  emailableProvider,
  verifyEmail,
  type MailboxOutcome,
  type MailboxProvider,
  type VerifyEmailOptions,
} from '@repo/email-checks';
import { ForbiddenError } from '@repo/kernel';
import type { Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';
import { readVerificationSettings, type VerificationRow } from './email-verification.js';

export const EMAIL_VERIFICATION_SECRET = 'email.emailable.key';
export const verifyAddressData = z.strictObject({ verificationId: z.uuid(), checkId: z.uuid() });
const recordedResult = z.strictObject({
  status: z.enum(['valid', 'risky', 'invalid', 'unknown']),
  depth: z.enum(['domain', 'mailbox']),
  reasons: z.array(z.string().max(80)).max(18),
  provider: z.literal('emailable').nullable(),
  charged: z.boolean(),
  state: z.string().max(40).nullable(),
  reason: z.string().max(80).nullable(),
  connectionId: z.uuid().nullable(),
  connectionRevision: z.string().max(100).nullable(),
  connectionFailing: z.boolean(),
  limited: z.boolean(),
  retryAfterMs: z.int().min(0).max(86400000).nullable(),
  abandoned: z.boolean(),
  /** A first check the provider asked to wait for: asked again this long from now. */
  retryInMs: z.int().min(0).max(60_000).nullable(),
});
const recordInput = verifyAddressData.extend({
  result: recordedResult,
  /** The priority the check's job ran at, which every job it queues again keeps. */
  priority: z.int().min(0).default(0),
});

/**
 * How far past 00:05 a check the daily limit deferred is queued: a share of the hour taken
 * from its check id, so a day's backlog arrives spread over the hour, not at once.
 */
export function limitOffsetMs(checkId: string): number {
  return Number.parseInt(checkId.replaceAll('-', '').slice(0, 8), 16) % 3_600_000;
}

export async function businessLock(trx: DatabaseTransaction, businessId: string): Promise<void> {
  await sql`select id from tenancy.businesses where id=${businessId}::uuid for no key update`.execute(
    trx,
  );
}

const recordVerificationCommand = defineCommand({
  name: 'email_verification.record',
  permission: 'email.verification.manage',
  input: recordInput,
  audit: ({ verificationId, checkId }) => ({ verificationId, checkId }),
  async handle(trx, { verificationId, checkId, result, priority }, command) {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the verification worker records results.');
    const businessId = requireBusiness(command.context);
    await businessLock(trx, businessId);
    const {
      rows: [row],
    } = await sql<VerificationRow>`select * from messaging.email_verifications
      where business_id=app.business_id() and id=${verificationId}::uuid for update`.execute(trx);
    if (row?.claimed_check_id !== checkId) return;
    // A first check the provider asked to wait for is asked once more soon, as the same
    // check: its claim and the day's reservation are released and nothing is recorded yet.
    if (
      result.retryInMs !== null &&
      !row.excluded &&
      row.current_check_id === checkId &&
      row.early_retry_check_id !== checkId
    ) {
      const {
        rows: [early],
      } = await sql<{ at: Date }>`update messaging.email_verifications set claimed_check_id=null,
        claimed_at=null,provider_reserved_at=null,early_retry_check_id=${checkId}::uuid,
        next_attempt_at=now()+${result.retryInMs}::integer*interval '1 millisecond'
        where business_id=app.business_id() and id=${verificationId}::uuid
        returning next_attempt_at as at`.execute(trx);
      if (early === undefined) throw new Error('Verification row not found.');
      await sql`select private.enqueue_email_verification(${verificationId}::uuid,${checkId}::uuid,${early.at},${priority}::integer)`.execute(
        trx,
      );
      return;
    }
    const { rows: kept } = await sql<{ id: string }>`insert into messaging.email_verification_checks
      (business_id,id,address_normalized,provider,charged,outcome,actor_kind,actor_id)
      values (${businessId}::uuid,${checkId}::uuid,${row.address_normalized},${result.provider},${result.charged},
        ${result.abandoned ? 'abandoned' : result.status},${command.context.actorKind},${command.context.actorId ?? null}::uuid)
      on conflict do nothing returning id`.execute(trx);
    if (kept.length === 0) return;
    await sql`update messaging.email_verifications set claimed_check_id=null,claimed_at=null,provider_reserved_at=null,
      current_check_id=case when excluded then null else current_check_id end,
      next_attempt_at=case when excluded then null else next_attempt_at end
      where business_id=app.business_id() and id=${verificationId}::uuid`.execute(trx);
    if (result.connectionFailing && result.connectionId !== null)
      await sql`update messaging.provider_connections set status='failing',last_checked_at=now()
        where business_id=app.business_id() and id=${result.connectionId}::uuid and provider='emailable'
          and updated_at::text=${result.connectionRevision}`.execute(trx);
    // Exclude, hard bounce or a newer explicit request invalidates the old callback.
    if (row.excluded || row.current_check_id !== checkId) return;
    const retry = result.limited || (result.status === 'unknown' && row.attempts < 3);
    const nextCheckId = retry ? randomUUID() : null;
    const hours = [1, 6, 24][Math.min(row.attempts, 2)] ?? 24;
    const {
      rows: [clock],
    } = await sql<{ next: Date | null }>`select case when ${result.limited} then
      ((date_trunc('day',now() at time zone b.timezone)+interval '1 day 5 minutes') at time zone b.timezone)
        + ${nextCheckId === null ? 0 : limitOffsetMs(nextCheckId)}::integer * interval '1 millisecond'
      when ${retry} then now()+ greatest(${hours * 3600000}::integer,${result.retryAfterMs ?? 0}::integer) * interval '1 millisecond'
      else null end as next from tenancy.businesses b where b.id=app.business_id()`.execute(trx);
    await sql`update messaging.email_verifications set status=${result.status},depth=${result.depth},
      reasons=${result.reasons}::text[],checked_at=now(),provider=${result.provider},
      provider_result=case when ${result.state}::text is null then null else
        jsonb_build_object('state',${result.state}::text,'reason',${result.reason}::text) end,
      attempts=attempts+1,current_check_id=${nextCheckId}::uuid,next_attempt_at=${clock?.next ?? null}
      where business_id=app.business_id() and id=${verificationId}::uuid`.execute(trx);
    if (result.status === 'invalid') {
      await sql`insert into messaging.suppressions (business_id,channel,address_normalized,reason,detail)
        values (${businessId}::uuid,'email',${row.address_normalized},'invalid',${`verification:${result.reasons[0] ?? 'invalid'}`})
        on conflict (business_id,channel,address_normalized) do update set reason='invalid',detail=excluded.detail,
          expires_at=null,created_at=now() where messaging.suppressions.expires_at<=now()`.execute(
        trx,
      );
    } else if (result.status === 'valid') {
      await sql`update messaging.suppressions set expires_at=now() where business_id=app.business_id()
        and channel='email' and address_normalized=${row.address_normalized} and reason='invalid'
        and detail like 'verification:%' and (expires_at is null or expires_at>now())`.execute(trx);
    }
    const contacts = await trx
      .selectFrom('crm.contact_identities')
      .select('contact_id')
      .where('kind', '=', 'email')
      .where('value_normalized', '=', row.address_normalized)
      .execute();
    await command.emit({
      type: 'email.verification.changed',
      subject: { kind: 'business', id: businessId },
      payload: { status: result.status },
      records: contacts.map((contact) => contact.contact_id),
    });
    // Wake the existing dispatch jobs, whose normal policy rechecks suppression/consent.
    const waiting = await sql<{ id: string }>`update messaging.messages set scheduled_for=now()
      where business_id=app.business_id() and channel='email' and status='queued'
        and error_code='verification_pending' and (${row.address_normalized}=any(to_addresses)
          or ${row.address_normalized}=any(cc_addresses) or ${row.address_normalized}=any(bcc_addresses)) returning id`.execute(
      trx,
    );
    for (const message of waiting.rows)
      await sql`select private.wake_verified_outbound(${message.id}::uuid)`.execute(trx);
    if (nextCheckId !== null && clock?.next !== null && clock?.next !== undefined)
      await sql`select private.enqueue_email_verification(${verificationId}::uuid,${nextCheckId}::uuid,${clock.next},${priority}::integer)`.execute(
        trx,
      );
  },
});

export interface VerificationTaskOptions {
  readonly vault?: Vault;
  readonly resolve?: VerifyEmailOptions['resolve'];
  /** Tests supply the provider, so no real mailbox or DNS request is needed. */
  readonly provider?: MailboxProvider;
}

/** The longest wait before a first check is asked again early. */
const EARLY_RETRY_CAP_MS = 60_000;
/** The wait when the provider does not say how long. */
const EARLY_RETRY_DEFAULT_MS = 5000;

/**
 * A first check the provider turned away without answering (a rate limit, still checking,
 * unavailable) is queued once more after the wait it asks for, rather than an hour later.
 * Nothing waits in the job, which would hold up the worker. A timeout, an unreadable
 * answer or a network failure may already have been charged, so those are not asked again
 * early, nor is anything a person must fix.
 */
function earlyRetryWait(outcome: MailboxOutcome | undefined): number | null {
  if (outcome?.kind !== 'failed' || outcome.connectionFailing) return null;
  if (!['rate_limited', 'slow', 'unavailable'].includes(outcome.problem)) return null;
  return Math.min(outcome.retryAfterMs ?? EARLY_RETRY_DEFAULT_MS, EARLY_RETRY_CAP_MS);
}

/**
 * Runs one check of an address: claims it in a short transaction, checks with no
 * transaction open, then records the result in a new one. The job runs it, and so does a
 * workflow's Email verification step, which needs the result before it goes on.
 */
export async function runEmailVerificationCheck(
  services: Services,
  invocation: Invocation,
  data: z.output<typeof verifyAddressData>,
  options: VerificationTaskOptions = {},
  /** The priority the check's job ran at: a bulk action's checks wait behind other work. */
  priority = 0,
): Promise<void> {
  if (invocation.context.actorKind !== 'system')
    throw new ForbiddenError('Only the verification worker runs checks.');
  const prepared = await withTenant(services.db, invocation.context, async (trx) => {
    await businessLock(trx, requireBusiness(invocation.context));
    const {
      rows: [row],
    } = await sql<VerificationRow>`select * from messaging.email_verifications
          where business_id=app.business_id() and id=${data.verificationId}::uuid for update`.execute(
      trx,
    );
    if (row === undefined) return null;
    const recovering = row.claimed_check_id === data.checkId;
    if (!recovering && (row.excluded || row.current_check_id !== data.checkId)) return null;
    const {
      rows: [clock],
    } = await sql<{ early: boolean; busy: boolean }>`select
          ${row.next_attempt_at}::timestamptz>now() as early,
          ${row.claimed_at}::timestamptz>now()-interval '2 minutes' as busy`.execute(trx);
    if (clock?.early === true || clock?.busy === true) {
      await sql`select private.enqueue_email_verification(${row.id}::uuid,${data.checkId}::uuid,
            greatest(coalesce(${row.next_attempt_at}::timestamptz,now()),now()+interval '2 minutes'),
            ${priority}::integer)`.execute(trx);
      return null;
    }
    if (row.claimed_check_id !== null)
      return {
        row,
        abandoned: true,
        provider: undefined,
        connectionId: null,
        connectionRevision: null,
        limited: false,
      };
    const settings = await readVerificationSettings(trx);
    if (!settings.enabled) {
      await sql`update messaging.email_verifications set current_check_id=null,next_attempt_at=null
            where business_id=app.business_id() and id=${row.id}::uuid`.execute(trx);
      return null;
    }
    const {
      rows: [usage],
    } = await sql<{ n: number }>`select (
          (select count(*) from messaging.email_verification_checks c where c.business_id=b.id and (c.charged or c.outcome='abandoned')
            and c.created_at >= (date_trunc('day',now() at time zone b.timezone) at time zone b.timezone)) +
          (select count(*) from messaging.email_verifications v where v.business_id=b.id and v.provider_reserved_at is not null)
          )::integer as n from tenancy.businesses b where b.id=app.business_id()`.execute(trx);
    const limited = (usage?.n ?? 0) >= settings.dailyLimit;
    const {
      rows: [connection],
    } = await sql<{
      id: string;
      secret_id: string;
      revision: string;
    }>`select id,secret_id,updated_at::text as revision from messaging.provider_connections
          where business_id=app.business_id() and provider='emailable' and status='connected' for share`.execute(
      trx,
    );
    let provider: MailboxProvider | undefined = options.provider;
    if (
      provider === undefined &&
      options.vault !== undefined &&
      connection !== undefined &&
      !limited
    ) {
      // Vault failures are private; a typed unknown result is recorded outside this transaction.
      try {
        provider = emailableProvider({
          apiKey: await options.vault.read(trx, connection.secret_id, EMAIL_VERIFICATION_SECRET),
        });
      } catch {
        provider = {
          name: 'emailable',
          verify: () =>
            Promise.resolve({
              kind: 'failed',
              problem: 'unauthorized',
              connectionFailing: true,
            }),
          account: () =>
            Promise.resolve({
              kind: 'failed',
              problem: 'unauthorized',
              connectionFailing: true,
            }),
        };
      }
    }
    if (limited) provider = undefined;
    await sql`update messaging.email_verifications set claimed_check_id=${data.checkId}::uuid,claimed_at=now(),
          provider_reserved_at=case when ${provider !== undefined} then now() else null end
          where business_id=app.business_id() and id=${row.id}::uuid`.execute(trx);
    return {
      row,
      abandoned: false,
      provider,
      connectionId: connection?.id ?? null,
      connectionRevision: connection?.revision ?? null,
      limited: limited && (connection !== undefined || options.provider !== undefined),
    };
  });
  if (prepared === null) return;
  const checked = prepared.abandoned
    ? { status: 'unknown' as const, depth: 'domain' as const, reasons: ['provider_error'] }
    : await verifyEmail(prepared.row.address_normalized, {
        ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
        ...(prepared.provider === undefined ? {} : { provider: prepared.provider }),
      });
  const outcome = 'provider' in checked ? checked.provider.outcome : undefined;
  await runCommand(
    services,
    recordVerificationCommand,
    {
      ...data,
      result: {
        status: checked.status,
        depth: checked.depth,
        reasons: checked.reasons,
        provider: outcome === undefined ? null : 'emailable',
        charged: outcome?.kind === 'result' && outcome.charged,
        state: outcome?.kind === 'result' ? outcome.status : null,
        // Our stable reason code is safe; arbitrary vendor strings are never persisted.
        reason: outcome?.kind === 'result' ? (outcome.reasons[0] ?? null) : null,
        connectionId: prepared.connectionId,
        connectionRevision: prepared.connectionRevision,
        connectionFailing: outcome?.kind === 'failed' && outcome.connectionFailing,
        limited: prepared.limited,
        retryAfterMs: outcome?.kind === 'failed' ? (outcome.retryAfterMs ?? null) : null,
        abandoned: prepared.abandoned,
        retryInMs: prepared.row.attempts === 0 ? earlyRetryWait(outcome) : null,
      },
      priority,
    },
    invocation,
  );
}

export function createVerifyEmailAddressTask(
  options: VerificationTaskOptions = {},
): Task<typeof verifyAddressData> {
  return defineTask({
    name: 'messaging.verify_address',
    data: verifyAddressData,
    run: (data, { invocation, services, job }) =>
      runEmailVerificationCheck(services, invocation, data, options, job?.priority ?? 0),
  });
}

const testProviderData = z.strictObject({});
export function createTestEmailVerificationProviderTask(
  vault?: Vault,
  provider: (key: string) => MailboxProvider = (apiKey) => emailableProvider({ apiKey }),
): Task<typeof testProviderData> {
  return defineTask({
    name: 'messaging.test_email_verification_provider',
    data: testProviderData,
    async run(_data, { invocation, services }) {
      if (invocation.context.actorKind !== 'system')
        throw new ForbiddenError('Only the worker tests stored provider credentials.');
      if (vault === undefined) return;
      const prepared = await withTenant(services.db, invocation.context, async (trx) => {
        const {
          rows: [row],
        } = await sql<{
          id: string;
          secret_id: string;
          revision: string;
        }>`select id,secret_id,updated_at::text as revision from messaging.provider_connections
          where business_id=app.business_id() and provider='emailable' and status<>'disconnected'`.execute(
          trx,
        );
        if (row === undefined) return null;
        try {
          return { ...row, key: await vault.read(trx, row.secret_id, EMAIL_VERIFICATION_SECRET) };
        } catch {
          return { ...row, key: null };
        }
      });
      if (prepared === null) return;
      const outcome =
        prepared.key === null || prepared.key.trim() === ''
          ? null
          : await provider(prepared.key).account();
      await withTenant(services.db, invocation.context, async (trx) => {
        await businessLock(trx, requireBusiness(invocation.context));
        await sql`update messaging.provider_connections set status=${outcome?.kind === 'ok' ? 'connected' : 'failing'},
          available_credits=${outcome?.kind === 'ok' ? outcome.availableCredits : null},
          test_mode=${outcome?.kind === 'ok' ? outcome.testMode : null},last_checked_at=now()
          where business_id=app.business_id() and id=${prepared.id}::uuid and updated_at::text=${prepared.revision}`.execute(
          trx,
        );
      });
    },
  });
}
