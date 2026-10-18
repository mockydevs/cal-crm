// The command bar's search: a few contacts, companies, deals and records of each custom
// object outside the trash, to go to. Contacts are found as the contact list finds them;
// companies, deals and custom records through private.search_companies, search_deals and
// search_custom_records, which read their indexes in the request's business, since
// row-level security keeps crm_app from using them.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  listContactsQuery,
  SEARCH_LIMIT,
  type FoundRecord,
  type searchRecordsQuery,
  type SearchResults,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import type * as z from 'zod';

import { readContactList } from '../contacts/list.js';
import { partPattern, prefixQuery } from './terms.js';

type SearchQuery = z.output<typeof searchRecordsQuery>;

/**
 * How many ids each lookup gives at most, and how many records of a kind are ranked. A
 * search that finds more is broad: these are some of its matches, and typing more narrows
 * it.
 */
const CANDIDATES = 50;

/** Names that start with the search first, keeping each one's place otherwise. */
function ranked(items: FoundRecord[], search: string): FoundRecord[] {
  const start = search.toLocaleLowerCase();
  const starts = (item: FoundRecord) =>
    item.name?.toLocaleLowerCase().startsWith(start) === true ? 0 : 1;
  return items
    .map((item, place) => ({ item, place }))
    .sort((a, b) => starts(a.item) - starts(b.item) || a.place - b.place)
    .slice(0, SEARCH_LIMIT)
    .map(({ item }) => item);
}

async function contacts(
  trx: DatabaseTransaction,
  invocation: Invocation,
  search: string,
): Promise<FoundRecord[]> {
  const list = await readContactList(
    trx,
    invocation,
    listContactsQuery.parse({ q: search, sort: 'name' }),
  );
  return list.items.map((contact) => {
    const address = contact.email ?? contact.phone?.display ?? null;
    return {
      id: contact.id,
      kind: 'contact',
      name: contact.name ?? address,
      detail: contact.name === null ? null : address,
    };
  });
}

async function companies(
  trx: DatabaseTransaction,
  businessId: string,
  words: string | null,
  part: string | null,
): Promise<FoundRecord[]> {
  const { rows } = await sql<{ id: string; name: string; domain: string | null }>`
    select c.id, c.name, c.domain from crm.companies c
    where c.business_id = ${businessId} and c.deleted_at is null
      and c.id = any(array(select id from private.search_companies(
        ${words}::text, ${part}::text, ${CANDIDATES}::integer) as found (id)))
    order by lower(c.name), c.id
    limit ${CANDIDATES}`.execute(trx);
  return rows.map((row) => ({
    id: toPublicId('company', row.id),
    kind: 'company',
    name: row.name,
    detail: row.domain,
  }));
}

async function deals(
  trx: DatabaseTransaction,
  businessId: string,
  words: string | null,
  part: string | null,
): Promise<FoundRecord[]> {
  const { rows } = await sql<{ id: string; name: string; pipeline: string; stage: string }>`
    select d.id, d.name, p.name as pipeline, s.name as stage from crm.deals d
    join crm.pipelines p on p.business_id = d.business_id and p.id = d.pipeline_id
    join crm.pipeline_stages s on s.business_id = d.business_id and s.id = d.stage_id
    where d.business_id = ${businessId} and d.deleted_at is null
      and d.id = any(array(select id from private.search_deals(
        ${words}::text, ${part}::text, ${CANDIDATES}::integer) as found (id)))
    order by lower(d.name), d.id
    limit ${CANDIDATES}`.execute(trx);
  return rows.map((row) => ({
    id: toPublicId('deal', row.id),
    kind: 'deal',
    name: row.name,
    detail: `${row.pipeline} · ${row.stage}`,
  }));
}

/**
 * Records of a custom object whose name has words starting with the search (`words`), or
 * whose name or a searchable field has it in any part (`part`, a LIKE pattern): by name, at
 * most CANDIDATES of them. The caller names an object that is not being deleted.
 */
export async function findCustomRecordIds(
  trx: DatabaseTransaction,
  objectTypeId: string,
  words: string | null,
  part: string | null,
): Promise<{ id: string; title: string }[]> {
  const { rows } = await sql<{ id: string; title: string }>`
    select c.id, c.title from crm.custom_records c
    where c.object_type_id = ${objectTypeId} and c.deleted_at is null
      and c.id = any(array(select id from private.search_custom_records(
        ${objectTypeId}::uuid, ${words}::text, ${part}::text, ${CANDIDATES}::integer) as found (id)))
    order by lower(c.title), c.id
    limit ${CANDIDATES}`.execute(trx);
  return rows;
}

/** Each custom object's records the search finds, a few of each, objects oldest first. */
async function customRecords(
  trx: DatabaseTransaction,
  search: string,
  words: string | null,
  part: string | null,
): Promise<FoundRecord[]> {
  const objects = await trx
    .selectFrom('crm.object_types')
    .select(['id', 'key', 'singular_label'])
    .where('kind', '=', 'custom')
    .where('archived_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const found: FoundRecord[] = [];
  for (const object of objects) {
    const rows = await findCustomRecordIds(trx, object.id, words, part);
    found.push(
      ...ranked(
        rows.map((row) => ({
          id: toPublicId('custom', row.id),
          kind: 'custom',
          name: row.title,
          object: { key: object.key, label: object.singular_label },
          detail: null,
        })),
        search,
      ),
    );
  }
  return found;
}

/** The records a search finds: contacts, then companies, then deals, then custom records. */
export async function searchRecords(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: SearchQuery,
): Promise<SearchResults> {
  const businessId = requireBusiness(invocation.context);
  const search = query.q;
  const words = prefixQuery(search) ?? null;
  const part = partPattern(search) ?? null;
  const found = ranked(await contacts(trx, invocation, search), search);
  // Punctuation alone, say, can match no name. The contact list decides for contacts, which
  // it also finds by phone number digits.
  if (words === null && part === null) return { items: found };
  return {
    items: [
      ...found,
      ...ranked(await companies(trx, businessId, words, part), search),
      ...ranked(await deals(trx, businessId, words, part), search),
      ...(await customRecords(trx, search, words, part)),
    ],
  };
}
