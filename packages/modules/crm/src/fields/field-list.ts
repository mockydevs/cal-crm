// The Custom Fields list: fields across objects, filtered and paged on the server, with the
// counts the page's cards show. Paging is by keyset on (created_at, id), so a field created
// while someone pages is never shown twice and never hides another.
import { requireBusiness, type Invocation } from '@repo/commands';
import { customField, type CustomFieldList, type ListCustomFieldsQuery } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';
import { asField } from './fields.js';

/** A search as a LIKE pattern: the text anywhere, with its own % and _ taken literally. */
const containing = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

export async function readCustomFields(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListCustomFieldsQuery,
): Promise<CustomFieldList> {
  requireBusiness(invocation.context);
  let matching = trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.business_id', '=', 'f.business_id').onRef('o.id', '=', 'f.object_type_id'),
    )
    .innerJoin('crm.field_folders as d', (join) =>
      join.onRef('d.business_id', '=', 'f.business_id').onRef('d.id', '=', 'f.folder_id'),
    );
  if (query.objectKey !== undefined) matching = matching.where('o.key', '=', query.objectKey);
  if (query.valueType !== undefined)
    matching = matching.where('f.value_type', '=', query.valueType);
  if (query.display === 'dropdown')
    matching = matching
      .where('f.value_type', 'in', ['single_choice', 'multi_choice'])
      .where('f.choice_display', 'is', null);
  else if (query.display !== undefined)
    matching = matching.where('f.choice_display', '=', query.display);
  if (query.folderId !== undefined)
    matching = matching.where(
      'f.folder_id',
      '=',
      parsePublicId('field_folder', query.folderId) ?? '',
    );
  if (query.source !== undefined) matching = matching.where('f.created_by_kind', '=', query.source);
  // Compared in PostgreSQL as written, so no part of the moment is rounded away.
  if (query.createdFrom !== undefined)
    matching = matching.where(sql<SqlBool>`f.created_at >= ${query.createdFrom}::timestamptz`);
  if (query.createdBefore !== undefined)
    matching = matching.where(sql<SqlBool>`f.created_at < ${query.createdBefore}::timestamptz`);
  if (query.q !== undefined && query.q !== '') {
    const pattern = containing(query.q);
    matching = matching.where(sql<SqlBool>`(f.label ilike ${pattern} or f.key ilike ${pattern})`);
  }
  if (query.archived === 'exclude') matching = matching.where('f.archived_at', 'is', null);
  if (query.archived === 'only') matching = matching.where('f.archived_at', 'is not', null);

  const { total } = await matching
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();

  let page = matching
    .selectAll('f')
    .select(['o.key as object_key', 'o.kind as object_kind', 'd.name as folder_name']);
  if (query.after !== undefined) {
    const anchor = parsePublicId('field', query.after) ?? '';
    const known = await trx
      .selectFrom('crm.field_definitions')
      .select('id')
      .where('id', '=', anchor)
      .executeTakeFirst();
    if (known === undefined)
      throw new ValidationError([
        { path: '/after', code: 'unknown_field', message: 'Start after a field in this business.' },
      ]);
    // The anchor's own stored moment, never a JavaScript date, which keeps no microseconds.
    const position = sql`(select a.created_at, a.id from crm.field_definitions a where a.id = ${anchor})`;
    // By place: where the anchor is now, among the folders in their order.
    const place = sql`(
      select ao.key, ad.position, ad.created_at, ad.id, a.position, a.id
      from crm.field_definitions a
      join crm.object_types ao on ao.business_id = a.business_id and ao.id = a.object_type_id
      join crm.field_folders ad on ad.business_id = a.business_id and ad.id = a.folder_id
      where a.id = ${anchor})`;
    page = page.where(
      query.sort === 'position'
        ? sql<SqlBool>`(o.key, d.position, d.created_at, d.id, f.position, f.id) > ${place}`
        : query.sort === 'created_asc'
          ? sql<SqlBool>`(f.created_at, f.id) > ${position}`
          : sql<SqlBool>`(f.created_at, f.id) < ${position}`,
    );
  }
  const direction = query.sort === 'created_asc' ? 'asc' : 'desc';
  const ordered =
    query.sort === 'position'
      ? page
          .orderBy('o.key')
          .orderBy('d.position')
          .orderBy('d.created_at')
          .orderBy('d.id')
          .orderBy('f.position')
          .orderBy('f.id')
      : page.orderBy('f.created_at', direction).orderBy('f.id', direction);
  const rows = await ordered.limit(query.limit + 1).execute();
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);

  const objects = await trx
    .selectFrom('crm.object_types as o')
    .select([
      'o.key',
      'o.singular_label as label',
      sql<number>`(
        select count(*)::int from crm.field_definitions f
        where f.business_id = o.business_id and f.object_type_id = o.id
          and f.archived_at is null
      )`.as('fields'),
      sql<number>`(
        select count(*)::int from crm.field_folders d
        where d.business_id = o.business_id and d.object_type_id = o.id
      )`.as('folders'),
    ])
    .where('o.archived_at', 'is', null)
    .orderBy('o.key')
    .execute();

  return {
    items: shown.map((row) => customField.parse({ ...asField(row), folderName: row.folder_name })),
    total: Number(total),
    next: rows.length > query.limit && last !== undefined ? toPublicId('field', last.id) : null,
    objects,
    canManage: invocation.permissions === 'all' || invocation.permissions.has('fields.manage'),
  };
}
