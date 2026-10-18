// The name a contact is shown by, for the modules that list what belongs to contacts (a
// conversation, an appointment) without owning them: the display name, or else the
// primary email address or phone number, as the Inbox shows a contact without a name.
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

export interface ContactName {
  /** Empty when the contact has neither a name nor a primary address. */
  readonly name: string;
  readonly trashed: boolean;
}

/** Each of these contacts of the request's business, by id. One the business lacks is absent. */
export async function readContactNames(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ContactName>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('crm.contacts as c')
    .select(['c.id'])
    .select(
      sql<string>`coalesce(c.display_name, (
        select i.value_normalized from crm.contact_identities i
        where i.business_id = c.business_id and i.contact_id = c.id and i.is_primary
        order by i.kind limit 1), '')`.as('name'),
    )
    .select(sql<boolean>`c.deleted_at is not null`.as('trashed'))
    .where('c.id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((row) => [row.id, { name: row.name, trashed: row.trashed }]));
}
