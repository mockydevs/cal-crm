// What email verification found of a contact's primary email address, in one word, as the
// list's "Email verification" column and filter read it. Messaging keeps the results in
// messaging.email_verifications, one row per address, under the same row-level security as
// the contact; this reads that table as other modules' tables are read here (an export's
// file in files.files), without importing messaging.
import type { ContactEmailVerification } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql, type RawBuilder } from 'kysely';

/**
 * The state of the address `i` with its result `v` (left joined): excluded when it is left
 * out of verification, else the last check's status, else unchecked.
 */
export const primaryEmailState = sql<string>`(case when v.excluded then 'excluded'
  else coalesce(v.status, 'unchecked') end)`;

/** The state of the contact `c`'s primary email address; null without an address. */
export const emailVerificationOf = (contact: RawBuilder<unknown>): RawBuilder<string | null> =>
  sql<string | null>`(select ${primaryEmailState}
    from crm.contact_identities i
    left join messaging.email_verifications v
      on v.business_id = i.business_id and v.address_normalized = i.value_normalized
    where i.business_id = ${contact}.business_id and i.contact_id = ${contact}.id
      and i.kind = 'email' and i.is_primary
    limit 1)`;

/** Each of these contacts' state, by contact id; a contact without an address is left out. */
export async function readEmailVerifications(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, ContactEmailVerification>> {
  const { rows } = await sql<{ id: string; state: ContactEmailVerification | null }>`
    select c.id, ${emailVerificationOf(sql`c`)} as state
    from crm.contacts c
    where c.business_id = ${businessId} and c.id = any(${[...ids]}::uuid[])`.execute(trx);
  return new Map(rows.flatMap((row) => (row.state === null ? [] : [[row.id, row.state]])));
}
