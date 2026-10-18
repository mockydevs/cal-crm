import { randomUUID } from 'node:crypto';
import { defineCommand, requireBusiness, type CommandContext } from '@repo/commands';
import {
  emailAddressInput,
  blockEmailAddressInput,
  unblockEmailAddressInput,
  emailVerification,
  updateEmailVerificationSettingsInput,
  suppressionReasons,
  type EmailVerification,
  type EmailVerificationSettings,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  parsePublicId,
  type TenantContext,
} from '@repo/kernel';
import { lockBookingContact } from '@repo/module-crm';
import { sql } from 'kysely';
import * as z from 'zod';
import type { OutboundAdmission, OutboundLeftOutCopy } from './outbound.js';

const suppressionReason = z.enum(suppressionReasons);

export interface VerificationRow {
  business_id: string;
  id: string;
  address_normalized: string;
  status: 'valid' | 'risky' | 'invalid' | 'unknown' | null;
  depth: 'domain' | 'mailbox' | null;
  reasons: string[];
  checked_at: Date | null;
  excluded: boolean;
  attempts: number;
  next_attempt_at: Date | null;
  current_check_id: string | null;
  claimed_check_id: string | null;
  claimed_at: Date | null;
  provider_reserved_at: Date | null;
  early_retry_check_id: string | null;
}

export async function verificationRow(
  trx: DatabaseTransaction,
  address: string,
): Promise<VerificationRow | undefined> {
  const { rows } = await sql<VerificationRow>`select * from messaging.email_verifications
    where business_id=app.business_id() and address_normalized=${address}`.execute(trx);
  return rows[0];
}

export async function readEmailVerification(
  trx: DatabaseTransaction,
  address: string,
): Promise<EmailVerification> {
  const row = await verificationRow(trx, address);
  const {
    rows: [settings],
  } = await sql<{ reverify: boolean }>`select email_reverify_after_90_days as reverify
    from messaging.settings where business_id=app.business_id()`.execute(trx);
  return emailVerification.parse({
    status: row?.status ?? 'unchecked',
    depth: row?.depth ?? null,
    reasons: row?.reasons ?? [],
    checkedAt: row?.checked_at?.toISOString() ?? null,
    excluded: row?.excluded ?? false,
    expiresAt:
      row?.checked_at === null || row?.checked_at === undefined || settings?.reverify === false
        ? null
        : new Date(row.checked_at.getTime() + 90 * 86400000).toISOString(),
  });
}

/**
 * Queues a check of an address, or the pending one again. A bulk action passes its own
 * priority and time for a new check, so its checks wait behind all other work.
 */
export async function queueEmailVerification(
  trx: DatabaseTransaction,
  address: string,
  bulk?: { readonly priority: number; readonly runAt: Date },
): Promise<void> {
  await sql`insert into messaging.email_verifications (business_id,address_normalized)
    values (app.business_id(),${address}) on conflict do nothing`.execute(trx);
  const {
    rows: [row],
  } = await sql<VerificationRow>`select * from messaging.email_verifications
    where business_id=app.business_id() and address_normalized=${address} for update`.execute(trx);
  if (row === undefined) throw new Error('Verification row not found.');
  if (row.excluded) return;
  const pending = row.claimed_check_id ?? row.current_check_id;
  if (pending !== null) {
    // Queue the pending check again: a job that was lost or gave up must not hold a deferred
    // send forever. The task's fences make a second run of the same check harmless.
    await sql`select private.enqueue_email_verification(${row.id}::uuid,${pending}::uuid,
      greatest(coalesce(${row.next_attempt_at}::timestamptz,now()),now()))`.execute(trx);
    return;
  }
  const checkId = randomUUID();
  await sql`update messaging.email_verifications set current_check_id=${checkId}::uuid,
    claimed_check_id=null, claimed_at=null, next_attempt_at=now(), attempts=0
    where business_id=app.business_id() and id=${row.id}::uuid`.execute(trx);
  if (bulk === undefined)
    await sql`select private.enqueue_email_verification(${row.id}::uuid,${checkId}::uuid)`.execute(
      trx,
    );
  else
    await sql`select private.enqueue_email_verification(${row.id}::uuid,${checkId}::uuid,
      greatest(${bulk.runAt}::timestamptz,now()),${bulk.priority}::integer)`.execute(trx);
}

async function addressFor(
  trx: DatabaseTransaction,
  input: { contactId: string; addressId: string },
  command: CommandContext,
) {
  const businessId = requireBusiness(command.context);
  // Business first, then the contact's public port, then messaging rows.
  await sql`select id from tenancy.businesses where id=${businessId}::uuid for no key update`.execute(
    trx,
  );
  const contactId = parsePublicId('contact', input.contactId);
  if (contactId === undefined || !(await lockBookingContact(trx, command.context, { contactId })))
    throw new NotFoundError('contact', input.contactId);
  const addressId = parsePublicId('contact_identity', input.addressId);
  const row = await trx
    .selectFrom('crm.contact_identities')
    .select('value_normalized')
    .where('contact_id', '=', contactId)
    .where('id', '=', addressId ?? '')
    .where('kind', '=', 'email')
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('email address', input.addressId);
  return row.value_normalized;
}

const invalid = (code: string, message: string) =>
  new ValidationError([{ path: '/addressId', code, message }]);
const audit = (input: { contactId: string; addressId: string }) => ({
  contactId: input.contactId,
  addressId: input.addressId,
});
const receipt = async (trx: DatabaseTransaction, address: string) => {
  const verification = await readEmailVerification(trx, address);
  const row = await verificationRow(trx, address);
  return {
    ...verification,
    pending: (row?.current_check_id ?? row?.claimed_check_id ?? null) !== null,
  };
};

const verify = defineCommand({
  name: 'email_address.verify',
  permission: 'contacts.manage',
  input: emailAddressInput,
  audit,
  async handle(trx, input, command) {
    const address = await addressFor(trx, input, command);
    if ((await verificationRow(trx, address))?.excluded)
      throw invalid('excluded', 'Include this address in verification first.');
    await queueEmailVerification(trx, address);
    return receipt(trx, address);
  },
});

function exclusion(excluded: boolean) {
  return defineCommand({
    name: excluded ? 'email_address.exclude' : 'email_address.include',
    permission: 'contacts.manage',
    input: emailAddressInput,
    audit,
    async handle(trx, input, command) {
      const address = await addressFor(trx, input, command);
      await sql`insert into messaging.email_verifications (business_id,address_normalized,excluded,excluded_by_kind,excluded_by_id,excluded_at)
        values (app.business_id(),${address},${excluded},${command.context.actorKind},${command.context.actorId ?? null}::uuid,now())
        on conflict (business_id,address_normalized) do update set excluded=excluded.excluded,
          excluded_by_kind=excluded.excluded_by_kind,excluded_by_id=excluded.excluded_by_id,excluded_at=excluded.excluded_at,
          current_check_id=case when messaging.email_verifications.claimed_check_id is null then null
            else messaging.email_verifications.current_check_id end,
          next_attempt_at=case when messaging.email_verifications.claimed_check_id is null then null
            else messaging.email_verifications.next_attempt_at end`.execute(trx);
      // A check that is already calling remains fenced, so its retry cannot call again.
      return receipt(trx, address);
    },
  });
}

const block = defineCommand({
  name: 'email_address.block',
  permission: 'contacts.manage',
  input: blockEmailAddressInput,
  audit,
  async handle(trx, input, command) {
    const address = await addressFor(trx, input, command);
    await sql`insert into messaging.suppressions (business_id,channel,address_normalized,reason,detail)
      values (app.business_id(),'email',${address},'manual',${input.reason ?? null})
      on conflict (business_id,channel,address_normalized) do update set reason='manual', detail=excluded.detail,expires_at=null,created_at=now()
      where messaging.suppressions.expires_at <= now()
        -- A person's block outranks a check's: a later valid result must not lift it.
        or (messaging.suppressions.reason='invalid' and messaging.suppressions.detail like 'verification:%')`.execute(
      trx,
    );
    return receipt(trx, address);
  },
});
const unblock = defineCommand({
  name: 'email_address.unblock',
  permission: 'contacts.manage',
  input: unblockEmailAddressInput,
  audit,
  async handle(trx, input, command) {
    const address = await addressFor(trx, input, command);
    const suppression = await trx
      .selectFrom('messaging.suppressions')
      .select(['reason', 'id'])
      .where('channel', '=', 'email')
      .where('address_normalized', '=', address)
      .where(sql<boolean>`(expires_at is null or expires_at>now())`)
      .forUpdate()
      .executeTakeFirst();
    if (suppression?.reason === 'complaint' || suppression?.reason === 'unsubscribe')
      throw invalid('consent_required', 'Record fresh consent instead of unblocking an opt-out.');
    if (suppression?.reason === 'hard_bounce') {
      if (command.permissions !== 'all' && !command.permissions.has('email.verification.manage'))
        throw new ForbiddenError(
          'Managing email verification is required to unblock a hard bounce.',
        );
      if (input.confirm !== 'unblock')
        throw invalid('confirmation_required', 'Type unblock to confirm.');
    }
    if (suppression !== undefined)
      await trx
        .updateTable('messaging.suppressions')
        .set({ expires_at: sql<Date>`now()` })
        .where('id', '=', suppression.id)
        .execute();
    return receipt(trx, address);
  },
});
export const emailAddressCommands = {
  verify,
  exclude: exclusion(true),
  include: exclusion(false),
  block,
  unblock,
};

export async function readVerificationSettings(
  trx: DatabaseTransaction,
): Promise<EmailVerificationSettings> {
  const {
    rows: [settings],
  } = await sql<{ enabled: boolean; reverifyAfter90Days: boolean; dailyLimit: number }>`
    select email_verification_enabled as enabled,email_reverify_after_90_days as "reverifyAfter90Days",
      email_verification_daily_limit as "dailyLimit" from messaging.settings where business_id=app.business_id()`.execute(
    trx,
  );
  const {
    rows: [connection],
  } = await sql<{
    status: 'connected' | 'failing' | 'disconnected';
    available_credits: number | null;
    test_mode: boolean | null;
  }>`
    select status,available_credits,test_mode from messaging.provider_connections
    where business_id=app.business_id() and provider='emailable'`.execute(trx);
  return {
    ...(settings ?? { enabled: true, reverifyAfter90Days: true, dailyLimit: 1000 }),
    provider: connection?.status ?? null,
    availableCredits: connection?.available_credits ?? null,
    testMode: connection?.test_mode ?? null,
  };
}
export const updateVerificationSettingsCommand = defineCommand({
  name: 'email_verification.settings',
  permission: 'email.verification.manage',
  input: updateEmailVerificationSettingsInput,
  async handle(trx, input, command) {
    const businessId = requireBusiness(command.context);
    await sql`select id from tenancy.businesses where id=${businessId}::uuid for no key update`.execute(
      trx,
    );
    await sql`insert into messaging.settings (business_id) values (${businessId}::uuid) on conflict do nothing`.execute(
      trx,
    );
    await sql`update messaging.settings set email_verification_enabled=coalesce(${input.enabled ?? null},email_verification_enabled),
      email_reverify_after_90_days=coalesce(${input.reverifyAfter90Days ?? null},email_reverify_after_90_days),
      email_verification_daily_limit=coalesce(${input.dailyLimit ?? null},email_verification_daily_limit)
      where business_id=app.business_id()`.execute(trx);
    return readVerificationSettings(trx);
  },
});

const liveSuppression = (trx: DatabaseTransaction, address: string) =>
  trx
    .selectFrom('messaging.suppressions')
    .select('reason')
    .where('channel', '=', 'email')
    .where('address_normalized', '=', address.toLowerCase())
    .where(sql<boolean>`(expires_at is null or expires_at>now())`)
    .executeTakeFirst();

/**
 * Admission composes before provider reservations; it never calls DNS or a mailbox API.
 * The main recipient waits for a check and a suppression refuses the email. A suppressed
 * Cc or Bcc is left out and the email goes to the rest; an unchecked one is not held.
 */
export function emailVerificationAdmission(next?: OutboundAdmission): OutboundAdmission {
  return async (trx, context, message) => {
    if (message.channel !== 'email')
      return next === undefined ? { action: 'allow' } : next(trx, context, message);
    if ((await liveSuppression(trx, message.to)) !== undefined)
      return { action: 'refuse', reason: 'suppressed' };
    const settings = await readVerificationSettings(trx);
    const {
      rows: [reply],
    } = await sql<{ known: boolean }>`select exists(select 1 from messaging.messages
      where business_id=app.business_id() and channel='email' and direction='inbound' and from_address=${message.to}) as known`.execute(
      trx,
    );
    if (settings.enabled && !(message.lane === 'reply' && reply?.known === true)) {
      const address = message.to.toLowerCase();
      const {
        rows: [row],
      } = await sql<{ needed: boolean }>`select (not v.excluded and (v.checked_at is null or
          (${settings.reverifyAfter90Days} and v.checked_at<now()-interval '90 days'))) as needed
          from messaging.email_verifications v where v.business_id=app.business_id() and v.address_normalized=${address}`.execute(
        trx,
      );
      if (row?.needed !== false) {
        await queueEmailVerification(trx, address);
        const {
          rows: [clock],
        } = await sql<{
          retryAt: Date;
        }>`select now()+interval '5 minutes' as "retryAt"`.execute(trx);
        if (clock === undefined) throw new Error('Database clock unavailable.');
        return { action: 'defer', reason: 'verification_pending', retryAt: clock.retryAt };
      }
    }
    const leftOut: OutboundLeftOutCopy[] = [];
    for (const [copy, addresses] of [
      ['cc', message.cc ?? []],
      ['bcc', message.bcc ?? []],
    ] as const)
      for (const address of addresses) {
        const suppression = await liveSuppression(trx, address);
        if (suppression !== undefined)
          leftOut.push({ copy, address, reason: suppressionReason.parse(suppression.reason) });
      }
    const left = (copy: 'cc' | 'bcc', addresses: readonly string[] | undefined) =>
      addresses?.filter(
        (address) => !leftOut.some((item) => item.copy === copy && item.address === address),
      );
    const cc = left('cc', message.cc);
    const bcc = left('bcc', message.bcc);
    const decision =
      next === undefined
        ? ({ action: 'allow' } as const)
        : await next(trx, context, {
            ...message,
            ...(cc === undefined ? {} : { cc }),
            ...(bcc === undefined ? {} : { bcc }),
          });
    return decision.action === 'allow' && leftOut.length > 0
      ? { ...decision, leftOut: [...(decision.leftOut ?? []), ...leftOut] }
      : decision;
  };
}

export async function readContactEmailVerifications(
  trx: DatabaseTransaction,
  _context: TenantContext,
  contactId: string,
): Promise<readonly { readonly value: string; readonly verification: EmailVerification }[]> {
  const identities = await trx
    .selectFrom('crm.contact_identities')
    .select('value_normalized')
    .where('contact_id', '=', contactId)
    .where('kind', '=', 'email')
    .execute();
  return Promise.all(
    identities.map(async (row) => ({
      value: row.value_normalized,
      verification: await readEmailVerification(trx, row.value_normalized),
    })),
  );
}
