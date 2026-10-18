// A custom object's records, as its list shows them: those outside the trash, kept by a
// search of the name and the searchable fields and by a field filter, in the order of a
// column or a field, a page at a time, with how many match. Paging is by keyset, the place
// read in SQL from the record the page starts after, as the Companies list pages.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  CUSTOM_RECORD_PAGE_SIZE,
  customRecordSortDirection,
  type CustomRecordList,
  type CustomRecordSort,
  type listCustomRecordsQuery,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type * as z from 'zod';

import { planFieldList } from '../fields/list-fields.js';
import { uuidOf } from '../records/public-ids.js';
import { literal } from '../search/terms.js';
import { liveObject, presentRecords, type RecordPeople } from './records.js';

type Query = z.output<typeof listCustomRecordsQuery>;

/** What an order compares on the record under `alias`. */
function keyOf(sort: CustomRecordSort, alias: 'c' | 'a'): RawBuilder<unknown> {
  if (sort === 'created') return sql`${sql.ref(`${alias}.created_at`)}`;
  if (sort === 'updated') return sql`${sql.ref(`${alias}.updated_at`)}`;
  return sql`lower(${sql.ref(`${alias}.title`)})`;
}

export async function readCustomRecordList(
  trx: DatabaseTransaction,
  invocation: Invocation,
  people: RecordPeople,
  key: string,
  input: Query,
): Promise<CustomRecordList> {
  const businessId = requireBusiness(invocation.context);
  const object = await liveObject(trx, key);
  const fields = await planFieldList(trx, businessId, { objectTypeId: object.id }, 'c', input);
  const size = input.limit ?? CUSTOM_RECORD_PAGE_SIZE;
  const matching = () => {
    let query = trx
      .selectFrom('crm.custom_records as c')
      .where('c.object_type_id', '=', object.id)
      .where('c.deleted_at', 'is', null);
    if (fields.filter !== undefined) query = query.where(fields.filter);
    if (input.q !== undefined && input.q !== '') {
      const pattern = `%${literal(input.q)}%`;
      query = query.where(
        sql<SqlBool>`(c.title ilike ${pattern} or exists (
          select 1 from crm.field_values v
          join crm.field_definitions f on f.business_id = v.business_id and f.id = v.field_id
          where v.business_id = c.business_id and v.record_id = c.id
            and f.is_searchable and f.archived_at is null
            and lower(v.value_text) like lower(${pattern})))`,
      );
    }
    return query;
  };

  let anchor: string | undefined;
  if (input.after !== undefined) {
    const found = await trx
      .selectFrom('crm.custom_records')
      .select('id')
      .where('id', '=', uuidOf('custom', input.after))
      .where('object_type_id', '=', object.id)
      .executeTakeFirst();
    if (found === undefined)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_record',
          message: `Start after a record of ${object.singular_label}.`,
        },
      ]);
    anchor = found.id;
  }

  let rows;
  if (fields.order !== undefined) {
    // By a field: the field plan pages itself from the record it names.
    const selection = matching()
      .selectAll('c')
      .leftJoin('crm.field_values as field_sort', (join) =>
        join
          .onRef('field_sort.business_id', '=', 'c.business_id')
          .onRef('field_sort.record_id', '=', 'c.id')
          .on('field_sort.field_id', '=', fields.sortId ?? ''),
      );
    rows = await (fields.after === undefined ? selection : selection.where(fields.after))
      .orderBy(fields.order)
      .orderBy('c.id')
      .limit(size + 1)
      .execute();
  } else {
    const sort = input.sort ?? 'updated';
    const direction = customRecordSortDirection(sort, input.direction);
    const order = keyOf(sort, 'c');
    const beyond = sql.raw(direction === 'asc' ? '>' : '<');
    let query = matching().selectAll('c');
    if (anchor !== undefined) {
      const from = sql`(select ${keyOf(sort, 'a')} from crm.custom_records a where a.id = ${anchor})`;
      query = query.where(
        sql<SqlBool>`(${order} ${beyond} ${from}
          or (${order} = ${from} and c.id ${beyond} ${anchor}::uuid))`,
      );
    }
    rows = await query
      .orderBy(sql`${order} ${sql.raw(direction)}`)
      .orderBy('c.id', direction)
      .limit(size + 1)
      .execute();
  }

  const { total } = await matching()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    items: await presentRecords(trx, invocation, people, object, page),
    next: rows.length > size && last !== undefined ? toPublicId('custom', last.id) : null,
    total: Number(total),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('records.manage'),
  };
}
