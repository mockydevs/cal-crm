// Which contacts a list holds, and how it is walked. The list, its count, a contact's
// neighbours and a bulk action over "the whole filtered list" all mean the same contacts in
// the same order, so all of them read it from here.
//
// A search matches names by word (full text) or any part (trigram), and email addresses and
// phone numbers by any part. Under row-level security Postgres won't use an index for
// ILIKE, LIKE, @@ or lower, which aren't LEAKPROOF, so the search's lookups run in
// private.search_contacts, and the by-name order compares sort_name.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  contactSortDirection,
  parseContactFilter,
  type ContactSort,
  type ContactSortDirection,
  type FieldListOptions,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { planContactFilter, type FilterPeople } from './filters.js';
import { planFieldList, type FieldListPlan } from '../fields/list-fields.js';
import { MIN_PART, partPattern, prefixQuery } from '../search/terms.js';

/** Digits with a phone number's punctuation, and nothing else: "+254 (0)712-345". */
const PHONE_LIKE = /^[\d\s()+.-]+$/;

/**
 * The digits of a phone number fragment, without the leading zeros of a national trunk
 * prefix, since numbers are kept in E.164: "0712 345" finds +254712345678. Only a search
 * that looks like a phone number is one: "first4999" searches names, not numbers.
 */
function phoneDigits(text: string): string | undefined {
  if (!PHONE_LIKE.test(text)) return undefined;
  const digits = text.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= MIN_PART ? digits : undefined;
}

/** What a search looks up: name words, any part of a name or address, phone digits. */
export interface SearchTerms {
  readonly words: string | undefined;
  readonly part: string | undefined;
  readonly digits: string | undefined;
}

/** The lookups a search makes, or undefined when it can match nothing, such as punctuation. */
export function searchTerms(search: string): SearchTerms | undefined {
  const words = prefixQuery(search);
  const digits = phoneDigits(search);
  const part = partPattern(search);
  if (words === undefined && part === undefined && digits === undefined) return undefined;
  return { words, part, digits };
}

/**
 * How many matches make a search or a filter broad. A narrow one's ids, fewer than this,
 * are read by their primary key; a broad one is tested contact by contact in the list's
 * order, which fills a page quickly when matches are that common.
 */
export const NARROW = 1000;

/** The search as a test of the contact `c`, contact by contact, without any index lookup. */
export function searchTest(terms: SearchTerms): RawBuilder<SqlBool> {
  const { words, digits, part } = terms;
  const identities = [
    ...(part === undefined
      ? []
      : [sql`(i.kind = 'email' and i.value_normalized like ${part.toLowerCase()})`]),
    ...(digits === undefined
      ? []
      : [sql`(i.kind = 'phone' and i.value_normalized like ${`%${digits}%`})`]),
  ];
  const conditions = [
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
  return sql`(${sql.join(conditions, sql` or `)})`;
}

/**
 * Keeps the contacts a search matches. private.search_contacts finds them through its
 * indexes (full-text word prefixes, and trigram on names, emails and phone numbers) and
 * stops at NARROW per lookup. A search that can match nothing, such as punctuation alone,
 * keeps none.
 */
async function matching(trx: DatabaseTransaction, search: string): Promise<RawBuilder<SqlBool>> {
  const terms = searchTerms(search);
  if (terms === undefined) return sql`false`;
  const { words, digits, part } = terms;
  const { rows } = await sql<{ id: string }>`select id from private.search_contacts(
    ${words ?? null}::text, ${part ?? null}::text, ${digits ?? null}::text, ${NARROW}::integer
  ) as found (id)`.execute(trx);
  if (rows.length < NARROW) {
    const ids = [...new Set(rows.map((row) => row.id))];
    return ids.length === 0 ? sql`false` : sql`c.id = any(${ids}::uuid[])`;
  }
  return searchTest(terms);
}

/** What narrows a list: the search and the filters, as the list, the count and a bulk action take them. */
export interface ContactListFilters extends FieldListOptions {
  readonly q?: string | undefined;
  readonly createdFrom?: string | undefined;
  readonly createdBefore?: string | undefined;
  readonly filter?: string | undefined;
}

/** The filters as tests of the contact `c`, the search left out. Refuses what the business lacks. */
export async function filterTests(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ContactListFilters,
  people: FilterPeople | undefined,
): Promise<{ tests: RawBuilder<SqlBool>[]; advanced: boolean }> {
  const businessId = requireBusiness(invocation.context);
  const filter = parseContactFilter(query.filter);
  const conditions =
    filter === undefined
      ? undefined
      : await planContactFilter(trx, invocation.context, businessId, filter, people);
  const fields = await planFieldList(trx, businessId, 'contact', 'c', {
    fieldId: query.fieldId,
    fieldOperator: query.fieldOperator,
    fieldValue: query.fieldValue,
  });
  return {
    tests: [
      ...(fields.filter === undefined ? [] : [fields.filter]),
      ...(conditions === undefined ? [] : [conditions]),
      ...(query.createdFrom === undefined
        ? []
        : [sql<SqlBool>`c.created_at >= ${new Date(query.createdFrom)}`]),
      ...(query.createdBefore === undefined
        ? []
        : [sql<SqlBool>`c.created_at < ${new Date(query.createdBefore)}`]),
    ],
    advanced: conditions !== undefined,
  };
}

/** A row of the list as it is walked: the contact, and what every row shows of it. */
export interface WalkedContact {
  readonly id: string;
  readonly display_name: string | null;
  readonly created_at: Date;
  readonly email: string | null;
  readonly phone: string | null;
}

/** A contact a walk starts from: its id, and whether it has the value the order goes by. */
export interface WalkAnchor {
  readonly id: string;
  readonly unordered: boolean;
}

interface Order {
  readonly column: 'c.created_at' | 'c.updated_at' | 'c.sort_name';
  /** Whether a contact can lack the value. Those that do come last, by id, either way. */
  readonly nullable: boolean;
  readonly direction: ContactSortDirection;
}

const ORDERS: Readonly<Record<ContactSort, Pick<Order, 'column' | 'nullable'>>> = {
  newest: { column: 'c.created_at', nullable: false },
  updated: { column: 'c.updated_at', nullable: false },
  name: { column: 'c.sort_name', nullable: true },
};

const flipped = (direction: ContactSortDirection): ContactSortDirection =>
  direction === 'asc' ? 'desc' : 'asc';

/** The contacts a list holds, and its walks. */
export interface ContactListScope {
  readonly businessId: string;
  /** Whether a search or a filter is in force. */
  readonly narrowed: boolean;
  /** The list as a test of the contact `c`: of this business, not in the trash, and kept. */
  readonly test: RawBuilder<SqlBool>;
  /**
   * The contact as a place to walk from. A page may start after any contact of the
   * business, as a cursor always could; a contact's neighbours are asked only of a contact
   * the list holds (`held`).
   */
  readonly anchorOf: (
    sort: ContactSort,
    id: string,
    held?: boolean,
  ) => Promise<WalkAnchor | undefined>;
  /**
   * Up to `limit` contacts after the anchor in the list's order, or before it, nearest
   * first, when `backwards`. Without an anchor, from the start of the list.
   */
  readonly walk: (
    sort: ContactSort,
    direction: ContactSortDirection | undefined,
    anchor: WalkAnchor | undefined,
    limit: number,
    backwards?: boolean,
  ) => Promise<WalkedContact[]>;
  /** A page in the order of a custom field, as fields/list-fields.ts planned it. */
  readonly walkByField: (
    plan: Pick<FieldListPlan, 'sortId' | 'order' | 'after'>,
    limit: number,
  ) => Promise<WalkedContact[]>;
  /** How many contacts come before the anchor, counted no further than `bound` when given. */
  readonly before: (
    sort: ContactSort,
    direction: ContactSortDirection | undefined,
    anchor: WalkAnchor,
    bound: number | undefined,
  ) => Promise<number>;
}

/**
 * The list a request describes. `narrowed` says whether a search or a filter is in force,
 * which is when counting stops at a limit.
 */
export async function contactListScope(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ContactListFilters,
  people?: FilterPeople,
): Promise<ContactListScope> {
  const businessId = requireBusiness(invocation.context);
  const search = query.q ?? '';
  const filters = await filterTests(trx, invocation, query, people);
  const found = search === '' ? undefined : await matching(trx, search);

  const all = () =>
    trx
      .selectFrom('crm.contacts as c')
      .where('c.business_id', '=', businessId)
      .where('c.deleted_at', 'is', null);

  /** The contacts the search and the filters keep, each test as it was given. */
  const tested = () => {
    let contacts = all();
    for (const test of filters.tests) contacts = contacts.where(test);
    if (found !== undefined) contacts = contacts.where(found);
    return contacts;
  };

  // The Filters panel's conditions can be rare, and a rare match is not found by walking
  // the list's order: every contact would be tested before a page filled. So the matches
  // are asked for first, in any order and no more than NARROW. Fewer means they are all of
  // them, and the list is read from those by primary key; NARROW means matches are common,
  // and walking the order fills a page quickly. This is the search's own method.
  let rare: RawBuilder<SqlBool> | undefined;
  if (filters.advanced) {
    const matches = await tested().select('c.id').limit(NARROW).execute();
    if (matches.length < NARROW)
      rare =
        matches.length === 0
          ? sql`false`
          : sql`c.id = any(${matches.map((row) => row.id)}::uuid[])`;
  }

  const kept = () => (rare === undefined ? tested() : all().where(rare));

  const rows = () =>
    kept()
      .select(['c.id', 'c.display_name', 'c.created_at'])
      .select((select) =>
        (['email', 'phone'] as const).map((kind) =>
          select
            .selectFrom('crm.contact_identities as i')
            .select('i.value_normalized')
            .whereRef('i.business_id', '=', 'c.business_id')
            .whereRef('i.contact_id', '=', 'c.id')
            .where('i.kind', '=', kind)
            .where('i.is_primary', '=', true)
            .as(kind),
        ),
      );

  /**
   * The contact as a place to walk from. A page may start after any contact of the
   * business, as a cursor always could; a contact's neighbours are asked only of a contact
   * the list holds (`held`).
   */
  async function anchorOf(
    sort: ContactSort,
    id: string,
    held = false,
  ): Promise<WalkAnchor | undefined> {
    const row = await (
      held ? kept() : trx.selectFrom('crm.contacts as c').where('c.business_id', '=', businessId)
    )
      .select(['c.id', 'c.sort_name'])
      .where('c.id', '=', id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return { id: row.id, unordered: ORDERS[sort].nullable && row.sort_name === null };
  }

  // Keyset paging: the anchor's place is read in SQL from the contact itself, so no
  // precision is lost on the way through the application.
  const beyond = (order: Order, direction: ContactSortDirection, anchor: string) => {
    const column = sql.ref(order.column);
    const place = sql`(select ${sql.ref(order.column.replace('c.', 'a.'))}, a.id
      from crm.contacts a where a.business_id = ${businessId} and a.id = ${anchor})`;
    return direction === 'desc'
      ? sql<SqlBool>`(${column}, c.id) < ${place}`
      : sql<SqlBool>`(${column}, c.id) > ${place}`;
  };

  /** The contacts that have the order's value, in `direction`, from the anchor or the start. */
  const ordered = (order: Order, direction: ContactSortDirection, anchor?: string) => {
    let contacts = rows();
    if (order.nullable) contacts = contacts.where(sql.ref(order.column), 'is not', null);
    if (anchor !== undefined) contacts = contacts.where(beyond(order, direction, anchor));
    return contacts.orderBy(sql.ref(order.column), direction).orderBy('c.id', direction);
  };

  /** The contacts without the order's value, by id. */
  const unordered = (order: Order, direction: ContactSortDirection, anchor?: string) => {
    let contacts = rows().where(sql.ref(order.column), 'is', null);
    if (anchor !== undefined)
      contacts = contacts.where('c.id', direction === 'asc' ? '>' : '<', anchor);
    return contacts.orderBy(sql.ref(order.column), direction).orderBy('c.id', direction);
  };

  /**
   * Up to `limit` contacts after the anchor in the list's order, or before it, nearest
   * first, when `backwards`. Without an anchor, from the start of the list. The contacts
   * that have the order's value come first, then those without it by id: two reads in index
   * order, since one keyset over both would have to read past the index's order.
   */
  async function walk(
    sort: ContactSort,
    requested: ContactSortDirection | undefined,
    anchor: WalkAnchor | undefined,
    limit: number,
    backwards = false,
  ): Promise<WalkedContact[]> {
    const order: Order = { ...ORDERS[sort], direction: contactSortDirection(sort, requested) };
    const direction = backwards ? flipped(order.direction) : order.direction;
    if (!backwards) {
      if (anchor?.unordered === true)
        return unordered(order, 'asc', anchor.id).limit(limit).execute();
      const first = await ordered(order, direction, anchor?.id).limit(limit).execute();
      if (!order.nullable || first.length === limit) return first;
      return [
        ...first,
        ...(await unordered(order, 'asc')
          .limit(limit - first.length)
          .execute()),
      ];
    }
    if (anchor === undefined) return [];
    if (!anchor.unordered) return ordered(order, direction, anchor.id).limit(limit).execute();
    const first = await unordered(order, 'desc', anchor.id).limit(limit).execute();
    if (first.length === limit) return first;
    return [
      ...first,
      ...(await ordered(order, direction)
        .limit(limit - first.length)
        .execute()),
    ];
  }

  /**
   * How many contacts come before the anchor, counted no further than `bound` when one is
   * given.
   */
  async function before(
    sort: ContactSort,
    requested: ContactSortDirection | undefined,
    anchor: WalkAnchor,
    bound: number | undefined,
  ): Promise<number> {
    const order: Order = { ...ORDERS[sort], direction: contactSortDirection(sort, requested) };
    const counted = async (contacts: ReturnType<typeof kept>): Promise<number> => {
      const inner =
        bound === undefined ? contacts.select('c.id') : contacts.select('c.id').limit(bound);
      const row = await trx
        .selectFrom(inner.as('counted'))
        .select((select) => select.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    };
    if (!anchor.unordered) {
      let contacts = kept().where(beyond(order, flipped(order.direction), anchor.id));
      if (order.nullable) contacts = contacts.where(sql.ref(order.column), 'is not', null);
      return counted(contacts);
    }
    const named = await counted(kept().where(sql.ref(order.column), 'is not', null));
    return (
      named +
      (await counted(kept().where(sql.ref(order.column), 'is', null).where('c.id', '<', anchor.id)))
    );
  }

  async function walkByField(
    plan: Pick<FieldListPlan, 'sortId' | 'order' | 'after'>,
    limit: number,
  ): Promise<WalkedContact[]> {
    let selection = rows().leftJoin('crm.field_values as field_sort', (join) =>
      join
        .onRef('field_sort.business_id', '=', 'c.business_id')
        .onRef('field_sort.record_id', '=', 'c.id')
        .on('field_sort.field_id', '=', plan.sortId ?? ''),
    );
    if (plan.after !== undefined) selection = selection.where(plan.after);
    return selection
      .orderBy(plan.order ?? sql`null`)
      .orderBy('c.id')
      .limit(limit)
      .execute();
  }

  const conditions =
    rare === undefined ? [...filters.tests, ...(found === undefined ? [] : [found])] : [rare];
  return {
    businessId,
    narrowed: found !== undefined || filters.tests.length > 0,
    test: sql`c.business_id = ${businessId} and c.deleted_at is null${sql.join(
      conditions.map((condition) => sql` and (${condition})`),
      sql``,
    )}`,
    anchorOf,
    walk,
    walkByField,
    before,
  };
}
