// What other modules ask of email verification. A workflow's Email verification step
// checks one address now, reusing a result that is recent enough (checkEmailAddressNow). A
// bulk action on contacts counts what checking many would do (previewContactEmailChecks) and
// queues each contact's check within the day's limit, behind all other work
// (startContactEmailChecks). Conditions read what was found (emailVerificationState).
//
// A result is current when it is as deep as a check can go now and recent enough: with a
// provider connected, a mailbox result (valid, risky or invalid); without one, any valid,
// risky or invalid result. An unknown result is never current. A bulk action counts 90 days
// and the step its own maxAgeDays, whatever "Re-verify after 90 days" says: that setting
// is the send gate's.
import { randomUUID } from 'node:crypto';

import { requireBusiness, type Invocation, type Services } from '@repo/commands';
import type {
  ContactEmailCheckPreview,
  ContactEmailVerification,
  EmailVerificationSettings,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import type { BulkEmailChecks } from '@repo/module-crm';
import { sql } from 'kysely';

import {
  queueEmailVerification,
  readVerificationSettings,
  verificationRow,
  type VerificationRow,
} from './email-verification.js';
import {
  businessLock,
  runEmailVerificationCheck,
  type VerificationTaskOptions,
} from './email-verification-task.js';

/** How long a bulk action counts a result as current. */
const CURRENT_DAYS = 90;

/**
 * The priority of a bulk action's checks. graphile-worker takes the lowest number first,
 * and every other job here is 0 to 8, so these wait behind all other work.
 */
export const BULK_CHECK_PRIORITY = 100;

/** How far apart a bulk action's checks are queued: one provider check a second. */
const PACE_MS = 1000;
/** And without a provider, whose checks are DNS lookups only. */
const FREE_PACE_MS = 100;

/**
 * Whether the result in `v` is current: as deep as a check can go now, not unknown, and
 * checked in the last `days` days.
 */
const current = (connected: boolean, days: number) =>
  sql<boolean>`coalesce(v.status in ('valid','risky','invalid')
    and ${connected ? sql`v.depth = 'mailbox'` : sql`true`}
    and v.checked_at > now() - make_interval(days => ${days}::integer), false)`;

/** What verification says of an address in one word: a status, unchecked or excluded. */
export async function emailVerificationState(
  trx: DatabaseTransaction,
  address: string,
): Promise<ContactEmailVerification> {
  const row = await verificationRow(trx, address.toLowerCase());
  if (row?.excluded === true) return 'excluded';
  return row?.status ?? 'unchecked';
}

/** What a check asked for now came to. */
export type EmailCheckNow =
  | {
      readonly kind: 'checked';
      /** True when a result recent enough was used as it is, with no new check. */
      readonly reused: boolean;
      readonly status: 'valid' | 'risky' | 'invalid' | 'unknown';
      readonly depth: 'domain' | 'mailbox';
    }
  | { readonly kind: 'excluded' }
  | { readonly kind: 'off' }
  /** Another run of the check is under way, or the provider asked to wait: ask again then. */
  | { readonly kind: 'waiting'; readonly retryAt: Date };

type Decision = EmailCheckNow | Run;
interface Run {
  readonly kind: 'run';
  readonly verificationId: string;
  readonly checkId: string;
}

const checked = (row: VerificationRow, reused: boolean): EmailCheckNow | undefined =>
  row.status === null || row.depth === null
    ? undefined
    : { kind: 'checked', reused, status: row.status, depth: row.depth };

/**
 * Checks an address now and answers what was found, reusing a result at most maxAgeDays
 * old. The check is the job's own (runEmailVerificationCheck): it is claimed in a short
 * transaction, made with no transaction open, and recorded in another, so nothing here
 * holds a lock while the provider answers, and the daily limit, the ledger and the
 * suppressions are kept exactly as a check from the contact page keeps them. A check that
 * is already pending is the one made, so a second is never paid for.
 */
export async function checkEmailAddressNow(
  services: Services,
  invocation: Invocation,
  input: { readonly address: string; readonly maxAgeDays: number },
  options: VerificationTaskOptions = {},
): Promise<EmailCheckNow> {
  const address = input.address.toLowerCase();
  const decided = await withTenant(
    services.db,
    invocation.context,
    async (trx): Promise<Decision> => {
      await businessLock(trx, requireBusiness(invocation.context));
      const settings = await readVerificationSettings(trx);
      if (!settings.enabled) return { kind: 'off' };
      await sql`insert into messaging.email_verifications (business_id,address_normalized)
      values (app.business_id(),${address}) on conflict do nothing`.execute(trx);
      const {
        rows: [row],
      } = await sql<VerificationRow>`select * from messaging.email_verifications
      where business_id=app.business_id() and address_normalized=${address} for update`.execute(
        trx,
      );
      if (row === undefined) throw new Error('Verification row not found.');
      if (row.excluded) return { kind: 'excluded' };
      const connected = settings.provider === 'connected';
      const {
        rows: [clock],
      } = await sql<{ fresh: boolean; busyUntil: Date | null; early: boolean | null }>`select
      ${current(connected, input.maxAgeDays)} as fresh,
      case when v.claimed_at > now() - interval '2 minutes'
        then v.claimed_at + interval '2 minutes' end as "busyUntil",
      v.next_attempt_at > now() as early
      from messaging.email_verifications v
      where v.business_id = app.business_id() and v.id = ${row.id}::uuid`.execute(trx);
      const reused = clock?.fresh === true ? checked(row, true) : undefined;
      if (reused !== undefined) return reused;
      // Another run is calling the provider for this address now.
      const busyUntil = clock?.busyUntil ?? null;
      if (row.claimed_check_id !== null && busyUntil !== null)
        return { kind: 'waiting', retryAt: busyUntil };
      // The provider asked to wait before the pending check is asked again.
      if (row.current_check_id !== null && clock?.early === true && row.next_attempt_at !== null)
        return { kind: 'waiting', retryAt: row.next_attempt_at };
      const pending = row.claimed_check_id ?? row.current_check_id;
      if (pending !== null) return { kind: 'run', verificationId: row.id, checkId: pending };
      const checkId = randomUUID();
      await sql`update messaging.email_verifications set current_check_id=${checkId}::uuid,
      claimed_check_id=null, claimed_at=null, next_attempt_at=now(), attempts=0
      where business_id=app.business_id() and id=${row.id}::uuid`.execute(trx);
      return { kind: 'run', verificationId: row.id, checkId };
    },
  );
  if (decided.kind !== 'run') return decided;
  await runEmailVerificationCheck(
    services,
    invocation,
    { verificationId: decided.verificationId, checkId: decided.checkId },
    options,
  );
  return withTenant(services.db, invocation.context, async (trx): Promise<EmailCheckNow> => {
    const row = await verificationRow(trx, address);
    if (row === undefined) throw new Error('Verification row not found.');
    if (row.excluded) return { kind: 'excluded' };
    const {
      rows: [clock],
    } = await sql<{
      early: boolean | null;
    }>`select ${row.next_attempt_at}::timestamptz > now() as early`.execute(trx);
    // The provider asked to wait: the same check is asked again then.
    if (row.current_check_id === decided.checkId && clock?.early === true)
      return { kind: 'waiting', retryAt: row.next_attempt_at ?? new Date() };
    // Only a check this run recorded is answered as checked: an older result is not.
    const {
      rows: [recorded],
    } = await sql<{ id: string }>`select id from messaging.email_verification_checks
      where business_id = app.business_id() and id = ${decided.checkId}::uuid`.execute(trx);
    const found = recorded === undefined ? undefined : checked(row, false);
    if (found !== undefined) return found;
    // Verification was turned off meanwhile, or the check could not be made yet.
    if (!(await readVerificationSettings(trx)).enabled) return { kind: 'off' };
    return { kind: 'waiting', retryAt: new Date(Date.now() + 60_000) };
  });
}

/**
 * How many more checks the provider may make today under the daily limit: the day's used
 * and reserved checks, and every check already waiting to be made today, are counted.
 * Null without a working provider, since the free checks have no limit.
 */
async function remainingToday(
  trx: DatabaseTransaction,
  settings: EmailVerificationSettings,
): Promise<number | null> {
  if (settings.provider !== 'connected') return null;
  const {
    rows: [usage],
  } = await sql<{ n: number }>`with day as (
      select (date_trunc('day', now() at time zone b.timezone) at time zone b.timezone) as starts
      from tenancy.businesses b where b.id = app.business_id())
    select (
      (select count(*) from messaging.email_verification_checks c, day
        where c.business_id = app.business_id() and (c.charged or c.outcome = 'abandoned')
          and c.created_at >= day.starts) +
      (select count(*) from messaging.email_verifications v, day
        where v.business_id = app.business_id()
          -- email_verifications_pending_idx holds exactly the rows this first test keeps.
          and (v.provider_reserved_at is not null or v.current_check_id is not null)
          and (v.provider_reserved_at is not null
            or (v.claimed_check_id is null and not v.excluded
              and coalesce(v.next_attempt_at, now()) < day.starts + interval '1 day')))
    )::integer as n`.execute(trx);
  return Math.max(0, settings.dailyLimit - (usage?.n ?? 0));
}

/** What became of one contact's check, for a bulk action on contacts. */
export type ContactEmailCheckOutcome =
  'queued' | 'current' | 'no_email' | 'excluded' | 'daily_limit' | 'off';

/** Where a contact's check falls in its bulk action: its place, and when the action began. */
export interface ContactEmailCheckPlace {
  readonly position: number;
  readonly since: Date;
}

/** One batch of a bulk action's checks, which reads the day's limit once and counts down. */
export interface ContactEmailCheckBatch {
  /**
   * Queues a check of a contact's primary email address, unless the address is excluded,
   * already has a current result (kept as it is, at no cost), or the day's provider checks
   * are used up. A check already pending is left as it is queued: never doubled, and never
   * moved behind other work.
   */
  queue(
    trx: DatabaseTransaction,
    contactId: string,
    place: ContactEmailCheckPlace,
  ): Promise<ContactEmailCheckOutcome>;
}

/**
 * Starts a batch of a bulk action's checks. Each new check is queued at
 * BULK_CHECK_PRIORITY, at the action's start plus its place times the pace, so a quiet
 * business's job and a send held for a check always go before the action's checks.
 */
export async function startContactEmailChecks(
  trx: DatabaseTransaction,
): Promise<ContactEmailCheckBatch> {
  const settings = await readVerificationSettings(trx);
  const connected = settings.provider === 'connected';
  let left = settings.enabled ? await remainingToday(trx, settings) : null;
  const pace = connected ? PACE_MS : FREE_PACE_MS;
  return {
    async queue(trx, contactId, place) {
      if (!settings.enabled) return 'off';
      const identity = await trx
        .selectFrom('crm.contact_identities')
        .select('value_normalized')
        .where('contact_id', '=', contactId)
        .where('kind', '=', 'email')
        .where('is_primary', '=', true)
        .executeTakeFirst();
      if (identity === undefined) return 'no_email';
      const address = identity.value_normalized;
      const {
        rows: [row],
      } = await sql<{ excluded: boolean; current: boolean; pending: boolean }>`select v.excluded,
          ${current(connected, CURRENT_DAYS)} as current,
          (v.current_check_id is not null or v.claimed_check_id is not null) as pending
        from messaging.email_verifications v
        where v.business_id = app.business_id() and v.address_normalized = ${address}`.execute(trx);
      if (row?.excluded === true) return 'excluded';
      if (row?.current === true) return 'current';
      if (row?.pending === true) return 'queued';
      if (left !== null) {
        if (left <= 0) return 'daily_limit';
        left -= 1;
      }
      await queueEmailVerification(trx, address, {
        priority: BULK_CHECK_PRIORITY,
        runAt: new Date(place.since.getTime() + (place.position - 1) * pace),
      });
      return 'queued';
    },
  };
}

/**
 * What checking these contacts' primary email addresses would do, counted as a batch
 * decides each: without an address, excluded, current (free), or
 * checked, and of those how many the provider would make within today's limit.
 */
export async function previewContactEmailChecks(
  trx: DatabaseTransaction,
  contactIds: readonly string[],
): Promise<ContactEmailCheckPreview> {
  const settings = await readVerificationSettings(trx);
  const connected = settings.provider === 'connected';
  const {
    rows: [counts],
  } = await sql<{
    contacts: number;
    no_email: number;
    excluded: number;
    current: number;
    checks: number;
  }>`with chosen as (select distinct unnest(${[...contactIds]}::uuid[]) as id),
    found as (
      select chosen.id, i.value_normalized as address, v.excluded, v.status,
        ${current(connected, CURRENT_DAYS)} as current
      from chosen
      left join crm.contact_identities i
        on i.contact_id = chosen.id and i.kind = 'email' and i.is_primary
      left join messaging.email_verifications v
        on v.business_id = app.business_id() and v.address_normalized = i.value_normalized)
    select count(*)::integer as contacts,
      count(*) filter (where address is null)::integer as no_email,
      count(*) filter (where address is not null and coalesce(excluded, false))::integer as excluded,
      count(*) filter (where address is not null and not coalesce(excluded, false) and current)::integer as current,
      count(*) filter (where address is not null and not coalesce(excluded, false) and not current)::integer as checks
    from found`.execute(trx);
  const checks = counts?.checks ?? 0;
  const left = await remainingToday(trx, settings);
  const overLimit = left === null ? 0 : Math.max(0, checks - left);
  return {
    contacts: counts?.contacts ?? 0,
    noEmail: counts?.no_email ?? 0,
    excluded: counts?.excluded ?? 0,
    current: counts?.current ?? 0,
    checks,
    providerCalls: left === null ? 0 : checks - overLimit,
    overLimit,
    remainingToday: left,
    provider: settings.provider,
    enabled: settings.enabled,
  };
}

/** Email verification as a bulk action on contacts asks for it (crm's bulk-options.ts). */
export const bulkEmailChecks: BulkEmailChecks = {
  enabled: async (trx) => (await readVerificationSettings(trx)).enabled,
  preview: (trx, _invocation, contactIds) => previewContactEmailChecks(trx, contactIds),
  start: async (trx) => {
    const batch = await startContactEmailChecks(trx);
    return { queue: (trx, _invocation, contactId, place) => batch.queue(trx, contactId, place) };
  },
};
