// The Companies list: a business's live companies,
// kept by a search and a custom-field filter, in the order of any column of the table or
// of a custom field, a page at a time, with how many match.
//
// Paging is by keyset. The cursor is the last company of the page before: its place in the
// order is read in SQL from that company, so no precision is lost and nothing about the
// order is in the cursor itself. A company without a value in the column the list is
// ordered by comes after every company with one, whichever way the list runs.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  COMPANY_PAGE_SIZE,
  companySortDirection,
  type CompanyList,
  type CompanySort,
  type listCompaniesQuery,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type * as z from 'zod';
import type { ActorNames } from '../activity/activity.js';
import { asCompany, creatorNamesOf } from './companies.js';
import { planFieldList } from '../fields/list-fields.js';

type Query = z.output<typeof listCompaniesQuery>;

/** The column each order of text compares, without regard to case. */
const textColumns = {
  name: 'name',
  phone: 'phone_e164',
  email: 'email',
  website: 'website',
  address: 'address_line',
  state: 'state',
  city: 'city',
  description: 'description',
  postalCode: 'postal_code',
  country: 'country',
} as const satisfies Record<Exclude<CompanySort, 'created' | 'updated' | 'createdBy'>, string>;

/**
 * What an order compares on the company under `alias`: null when the company has no
 * value. "Created by" is the name the row shows, from `names` (kind, id, name).
 */
function keyOf(
  sort: CompanySort,
  alias: 'c' | 'a',
  names: RawBuilder<unknown>,
): RawBuilder<unknown> {
  if (sort === 'created') return sql`${sql.ref(`${alias}.created_at`)}`;
  if (sort === 'updated') return sql`${sql.ref(`${alias}.updated_at`)}`;
  if (sort === 'createdBy')
    return sql`(select lower(n.name) from ${names} as n (kind, id, name)
      where n.kind = ${sql.ref(`${alias}.created_by_kind`)}
        and n.id = ${sql.ref(`${alias}.created_by_id`)})`;
  return sql`lower(${sql.ref(`${alias}.${textColumns[sort]}`)})`;
}

const escaped = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

export async function readCompanyList(
  trx: DatabaseTransaction,
  invocation: Invocation,
  input: Query,
  actorNames: ActorNames = {},
): Promise<CompanyList> {
  const businessId = requireBusiness(invocation.context);
  const fields = await planFieldList(trx, businessId, 'company', 'c', input);
  const size = input.limit ?? COMPANY_PAGE_SIZE;
  // The companies the list is of, before any page is cut from them.
  const matching = () => {
    let query = trx
      .selectFrom('crm.companies as c')
      .where('c.business_id', '=', businessId)
      .where('c.deleted_at', 'is', null);
    if (fields.filter !== undefined) query = query.where(fields.filter);
    if (input.q !== undefined && input.q !== '') {
      const pattern = `%${escaped(input.q)}%`;
      // A number as it is dialled at home ("0712 345") is found in its stored form.
      const digits = input.q.replace(/\D/g, '').replace(/^0+/, '');
      query = query.where((eb) =>
        eb.or([
          eb('c.name', 'ilike', pattern),
          eb('c.domain', 'ilike', pattern),
          eb('c.email', 'ilike', pattern),
          eb('c.website', 'ilike', pattern),
          eb('c.phone_e164', 'ilike', pattern),
          ...(digits.length >= 3 ? [eb('c.phone_e164', 'like', `%${digits}%`)] : []),
        ]),
      );
    }
    return query;
  };

  let anchor: { id: string } | undefined;
  if (input.after !== undefined && fields.order === undefined) {
    const uuid = parsePublicId('company', input.after);
    anchor =
      uuid === undefined
        ? undefined
        : await trx
            .selectFrom('crm.companies')
            .select('id')
            .where('business_id', '=', businessId)
            .where('id', '=', uuid)
            .executeTakeFirst();
    if (anchor === undefined)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_company',
          message: 'Start after a company of this business.',
        },
      ]);
  }

  let rows;
  if (input.sort === undefined) {
    // Newest first, or by a custom field: as the list has always read.
    let query = matching().selectAll('c');
    if (anchor !== undefined) query = query.where('c.id', '<', anchor.id);
    const selection = query.$if(fields.sortId !== undefined, (qb) =>
      qb.leftJoin('crm.field_values as field_sort', (join) =>
        join
          .onRef('field_sort.business_id', '=', 'c.business_id')
          .onRef('field_sort.record_id', '=', 'c.id')
          .on('field_sort.field_id', '=', fields.sortId ?? ''),
      ),
    );
    const kept = fields.after === undefined ? selection : selection.where(fields.after);
    rows = await (
      fields.order === undefined
        ? kept.orderBy('c.id', 'desc')
        : kept.orderBy(fields.order).orderBy('c.id')
    )
      .limit(size + 1)
      .execute();
  } else {
    const sort = input.sort;
    const direction = companySortDirection(sort, input.direction);
    // "Created by" is ordered by the name the row shows. Who that is belongs to other
    // modules, so the names of everyone who made a matching company are read first (a
    // team's worth) and compared as a list of values.
    let names = sql`(select null::text, null::uuid, null::text where false)`;
    if (sort === 'createdBy') {
      const creators = await matching()
        .select(['c.created_by_kind', 'c.created_by_id'])
        .distinct()
        .execute();
      const known = [...(await creatorNamesOf(trx, creators, actorNames))].map(([key, name]) => {
        const [kind = '', id = ''] = key.split(':');
        return sql`(${kind}::text, ${id}::uuid, ${name}::text)`;
      });
      if (known.length > 0) names = sql`(values ${sql.join(known)})`;
    }
    const key = keyOf(sort, 'c', names);
    const beyond = sql.raw(direction === 'asc' ? '>' : '<');
    let query = matching().selectAll('c');
    if (anchor !== undefined) {
      const from = sql`(select ${keyOf(sort, 'a', names)} from crm.companies a
        where a.business_id = ${businessId} and a.id = ${anchor.id})`;
      query = query.where(
        sql<SqlBool>`((${key} is null and ${from} is not null)
          or ${key} ${beyond} ${from}
          or (${key} is not distinct from ${from} and c.id ${beyond} ${anchor.id}::uuid))`,
      );
    }
    rows = await query
      .orderBy(sql`${key} ${sql.raw(direction)} nulls last`)
      .orderBy('c.id', direction)
      .limit(size + 1)
      .execute();
  }

  const { total } = await matching()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  const page = rows.slice(0, size);
  const last = page.at(-1);
  const creators = await creatorNamesOf(trx, page, actorNames);
  return {
    items: page.map((row) => asCompany(row, invocation, creators)),
    next: rows.length > size && last !== undefined ? toPublicId('company', last.id) : null,
    total: Number(total),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('companies.manage'),
  };
}
