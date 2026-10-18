// The deal list's search: a deal is kept when its name matches, or when a contact it is
// with matches by name, email address or phone number, as GoHighLevel's search box does
// ("Opportunity names, Phone, Email, ... and Contact name").
//
// Under row-level security Postgres does not use an index for ILIKE or @@, so the lookups
// run in private.search_deals and private.search_contacts, which read their indexes for the
// request's business alone. A search few records match becomes a list of deal ids; one that
// many match is tested deal by deal in the list's order, which fills a page quickly when
// matches are that common.
import type { DatabaseTransaction } from '@repo/db';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { searchTerms } from '../contacts/list.js';
import { DEAL_CONTACT_LINK } from './link-type.js';

/** How many matches make a lookup broad, as the contact list has it. */
const NARROW = 1000;

/** The condition on `d` (crm.deals) that keeps the deals a search matches. */
export async function dealsMatching(
  trx: DatabaseTransaction,
  businessId: string,
  search: string,
): Promise<RawBuilder<SqlBool>> {
  const terms = searchTerms(search);
  if (terms === undefined) return sql`false`;
  const { words, part, digits } = terms;
  const ids = new Set<string>();
  const tested: RawBuilder<SqlBool>[] = [];

  if (words !== undefined || part !== undefined) {
    const { rows } = await sql<{ id: string }>`select id from private.search_deals(
      ${words ?? null}::text, ${part ?? null}::text, ${NARROW}::integer
    ) as found (id)`.execute(trx);
    if (rows.length < NARROW) for (const row of rows) ids.add(row.id);
    else
      tested.push(
        sql.join(
          [
            ...(words === undefined ? [] : [sql`d.search @@ to_tsquery('simple', ${words})`]),
            ...(part === undefined ? [] : [sql`d.name ilike ${part}`]),
          ],
          sql` or `,
        ),
      );
  }

  // The links from a deal to one of these contacts, whichever way the contacts are named.
  const linked = (contacts: RawBuilder<SqlBool>) => sql`
    from crm.record_links l
    join crm.link_types t on t.business_id = l.business_id and t.id = l.link_type_id
    where l.business_id = ${businessId} and t.key = ${DEAL_CONTACT_LINK} and ${contacts}`;
  const contacts = await sql<{ id: string }>`select id from private.search_contacts(
    ${words ?? null}::text, ${part ?? null}::text, ${digits ?? null}::text, ${NARROW}::integer
  ) as found (id)`.execute(trx);
  const contactIds = [...new Set(contacts.rows.map((row) => row.id))];
  let narrow = contacts.rows.length < NARROW;
  if (narrow && contactIds.length > 0) {
    const deals = await sql<{ id: string }>`select l.from_record_id as id
      ${linked(sql`l.to_record_id = any(${contactIds}::uuid[])`)} limit ${NARROW}`.execute(trx);
    if (deals.rows.length < NARROW) for (const row of deals.rows) ids.add(row.id);
    else narrow = false;
  }
  if (!narrow) {
    const identities = [
      ...(part === undefined
        ? []
        : [sql`(i.kind = 'email' and i.value_normalized like ${part.toLowerCase()})`]),
      ...(digits === undefined
        ? []
        : [sql`(i.kind = 'phone' and i.value_normalized like ${`%${digits}%`})`]),
    ];
    const named = [
      ...(words === undefined ? [] : [sql`c.search @@ to_tsquery('simple', ${words})`]),
      ...(part === undefined ? [] : [sql`c.display_name ilike ${part}`]),
      ...(identities.length === 0
        ? []
        : [
            sql`exists (select 1 from crm.contact_identities i
              where i.business_id = c.business_id and i.contact_id = c.id
                and (${sql.join(identities, sql` or `)}))`,
          ]),
    ];
    const ofDeal = sql<SqlBool>`l.from_record_id = d.id
      and exists (select 1 from crm.contacts c
        where c.business_id = l.business_id and c.id = l.to_record_id
          and (${sql.join(named, sql` or `)}))`;
    tested.push(sql`exists (select 1 ${linked(ofDeal)})`);
  }

  const kept = [
    ...(ids.size === 0 ? [] : [sql`d.id = any(${[...ids]}::uuid[])`]),
    ...tested.map((condition) => sql`(${condition})`),
  ];
  return kept.length === 0 ? sql`false` : sql`(${sql.join(kept, sql` or `)})`;
}
