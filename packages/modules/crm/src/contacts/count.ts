// How many contacts a list holds, for the chip beside its filters.
//
// The whole list is counted exactly, from the contacts not in the trash. A search or a
// filter is tested contact by contact, so its count is taken only as far as
// CONTACT_COUNT_LIMIT: past that the answer is the least the count can be, and says so.
// A search is counted from the ids its index lookups find (private.search_contacts, as the
// list finds them): each lookup stops at the limit, so the count is exact when none reached
// it, and otherwise a lower bound.
import { requireBusiness, type Invocation } from '@repo/commands';
import { CONTACT_COUNT_LIMIT, type ContactCount, type countContactsQuery } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql, type SqlBool } from 'kysely';
import type * as z from 'zod';

import type { FilterPeople } from './filters.js';
import { filterTests, searchTerms } from './list-scope.js';

type CountQuery = z.output<typeof countContactsQuery>;

export async function readContactCount(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: CountQuery,
  people?: FilterPeople,
): Promise<ContactCount> {
  const businessId = requireBusiness(invocation.context);
  const { tests: filters } = await filterTests(trx, invocation, query, people);
  const search = query.q ?? '';
  const terms = search === '' ? undefined : searchTerms(search);
  // A search that can match nothing, such as punctuation alone, holds no contact.
  if (search !== '' && terms === undefined) return { count: 0, exact: true };

  const kept = sql<SqlBool>`c.business_id = ${businessId} and c.deleted_at is null${sql.join(
    filters.map((filter) => sql` and (${filter})`),
    sql``,
  )}`;
  const bound = CONTACT_COUNT_LIMIT + 1;

  if (terms === undefined) {
    if (filters.length === 0) {
      const { rows } = await sql<{ count: number }>`
        select count(*)::integer as count from crm.contacts c where ${kept}
      `.execute(trx);
      return { count: rows[0]?.count ?? 0, exact: true };
    }
    const { rows } = await sql<{ count: number }>`
      select count(*)::integer as count
      from (select 1 from crm.contacts c where ${kept} limit ${bound}) counted
    `.execute(trx);
    const count = rows[0]?.count ?? 0;
    return count > CONTACT_COUNT_LIMIT
      ? { count: CONTACT_COUNT_LIMIT, exact: false }
      : { count, exact: true };
  }

  // `found` is every id the lookups gave, repeats included: no lookup gives more than
  // `bound`, so when all of them together are under it, none was cut short.
  const { rows } = await sql<{ found: number; count: number }>`
    with found as materialized (
      select id from private.search_contacts(
        ${terms.words ?? null}::text, ${terms.part ?? null}::text, ${terms.digits ?? null}::text,
        ${bound}::integer
      ) as looked_up (id)
    )
    select (select count(*)::integer from found) as found,
           (select count(*)::integer from (
              select 1 from crm.contacts c
              where ${kept} and c.id in (select id from found)
              limit ${bound}) counted) as count
  `.execute(trx);
  const found = rows[0]?.found ?? 0;
  const count = rows[0]?.count ?? 0;
  return found > CONTACT_COUNT_LIMIT
    ? { count: Math.min(count, CONTACT_COUNT_LIMIT), exact: false }
    : { count, exact: true };
}
