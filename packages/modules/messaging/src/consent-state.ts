// The one rule for "may this address be sent this?". Among the ledger
// rows that count for a contact and the address a message goes to, the latest recorded_at
// wins, and the greater id breaks a tie. The rows that count:
//
// - a grant only for its own contact, and only when it names that address or names none
//   (a person's or an API's grant for the contact as a whole, and every row written before
//   addresses were recorded). A form's box, a keyword and a booking name the address they
//   were given for, so a box ticked beside another number never grants this one;
// - a withdrawal for every address of its contact, and for its address whichever contact
//   holds it now or later. An unsubscribe or a STOP outlives the contact that sent it: the
//   address deleted and imported again is still opted out.
//
// Sending, campaign audiences, the forms that record consent and the contact page build
// their queries from these fragments, so none of them can disagree.
import { createHash } from 'node:crypto';
import type { DatabaseTransaction } from '@repo/db';
import { sql, type RawBuilder } from 'kysely';

/** Newest first. The order stays in SQL: a JavaScript Date would drop the microseconds. */
export const latestConsentFirst = sql`recorded_at desc,id desc`;

export type CurrentConsent = 'granted' | 'withdrawn' | 'unknown';

/** The kind of contact identity a consent channel's messages go to. */
export const identityKindOf = (channel: string): 'email' | 'phone' =>
  channel === 'email' ? 'email' : 'phone';

/**
 * The current status for one contact as a scalar subquery: its own rows, and the
 * withdrawals of any address it holds now, whoever recorded them. The contact is named by
 * SQL expressions, such as c.business_id. Granted here is not proof for every address: a
 * send asks addressConsentStatus.
 */
export function latestConsentStatus(
  businessId: RawBuilder<unknown>,
  contactId: RawBuilder<unknown>,
  channel: string,
  purpose: string,
): RawBuilder<CurrentConsent> {
  return sql<CurrentConsent>`coalesce((select status from (
      (select status, recorded_at, id from messaging.consents
        where business_id=${businessId} and contact_id=${contactId} and channel=${channel} and purpose=${purpose}
        order by ${latestConsentFirst} limit 1)
      union all
      (select k.status, k.recorded_at, k.id from messaging.consents k
        join crm.contact_identities ci on ci.business_id=k.business_id
          and ci.value_normalized=k.address_normalized and ci.kind=${identityKindOf(channel)}
        where k.business_id=${businessId} and ci.contact_id=${contactId}
          and k.channel=${channel} and k.purpose=${purpose} and k.status='withdrawn'
        order by k.recorded_at desc, k.id desc limit 1)
    ) latest order by ${latestConsentFirst} limit 1),'unknown')`;
}

/**
 * The current status for a message to one address of a contact, by the rule at the top.
 * `contactId` may be SQL null: an address whose contact is gone has only its withdrawals.
 */
export function addressConsentStatus(
  businessId: RawBuilder<unknown>,
  contactId: RawBuilder<unknown>,
  address: RawBuilder<unknown>,
  channel: string,
  purpose: string,
): RawBuilder<CurrentConsent> {
  return sql<CurrentConsent>`coalesce((select status from (
      (select status, recorded_at, id from messaging.consents
        where business_id=${businessId} and contact_id=${contactId} and channel=${channel} and purpose=${purpose}
          and (status='withdrawn' or address_normalized is null or address_normalized=${address})
        order by ${latestConsentFirst} limit 1)
      union all
      (select status, recorded_at, id from messaging.consents
        where business_id=${businessId} and address_normalized=${address}
          and channel=${channel} and purpose=${purpose} and status='withdrawn'
        order by ${latestConsentFirst} limit 1)
    ) latest order by ${latestConsentFirst} limit 1),'unknown')`;
}

async function advisoryLock(trx: DatabaseTransaction, name: string): Promise<void> {
  // PostgreSQL's advisory locks take a 64-bit key; any stable one does, and two names
  // sharing a key only wait for each other.
  const key = createHash('sha256').update(name).digest().readBigInt64BE(0);
  await sql`select pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(trx);
}

/**
 * Makes consent changes for one contact take turns until the transaction ends. Each then
 * stamps the real time it was written, so the latest row is the change made last. Without
 * this, a row's time is its transaction's start, and a slow withdrawal could sort under a
 * grant that began after it.
 */
export async function lockContactConsent(
  trx: DatabaseTransaction,
  contactId: string,
): Promise<void> {
  await advisoryLock(trx, `consent:${contactId}`);
}

/**
 * The same for one address, for a change that names it. Taken after the contact's lock,
 * always in that order, so two writers never wait for each other in a circle.
 */
export async function lockAddressConsent(
  trx: DatabaseTransaction,
  businessId: string,
  channel: string,
  address: string,
): Promise<void> {
  await advisoryLock(trx, `consent:${businessId}:${identityKindOf(channel)}:${address}`);
}
