// A record's Associations panel, as GoHighLevel's record page shows it: for each association
// of the record's object, the records related on each side, labelled as they are to this
// record, a page at a time. An association that joins an object to itself shows two sides
// (Parent, Child), or one when it has a single label (Spouse).
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  RELATION_PAGE_SIZE,
  recordKinds,
  type AssociationGroup,
  type AssociationSide,
  type RecordAssociations,
  type RecordKind,
  type recordAssociationsQuery,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import * as z from 'zod';

import { requireRecord } from '../records/access.js';
import { uuidOf } from '../records/public-ids.js';
import { recordNames } from '../tasks/rows.js';
import { DEAL_CONTACT_LINK } from '../deals/link-type.js';
import { CONTACT_COMPANY_LINK, mayRelate } from './relations.js';

type Query = z.output<typeof recordAssociationsQuery>;

/** The associations touching an object, between live objects, the system ones first. */
function typesOf(trx: DatabaseTransaction, objectTypeId: string) {
  return trx
    .selectFrom('crm.link_types as l')
    .innerJoin('crm.object_types as f', (join) =>
      join.onRef('f.business_id', '=', 'l.business_id').onRef('f.id', '=', 'l.from_object_type_id'),
    )
    .innerJoin('crm.object_types as t', (join) =>
      join.onRef('t.business_id', '=', 'l.business_id').onRef('t.id', '=', 'l.to_object_type_id'),
    )
    .select([
      'l.id',
      'l.key',
      'l.is_system',
      'l.label',
      'l.reverse_label',
      'l.allows_primary',
      'l.from_limit',
      'l.to_limit',
      'l.from_object_type_id',
      'l.to_object_type_id',
      'f.key as from_key',
      'f.kind as from_kind',
      'f.plural_label as from_plural',
      't.key as to_key',
      't.kind as to_kind',
      't.plural_label as to_plural',
    ])
    .where('l.archived_at', 'is', null)
    .where('f.archived_at', 'is', null)
    .where('t.archived_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('l.from_object_type_id', '=', objectTypeId),
        eb('l.to_object_type_id', '=', objectTypeId),
      ]),
    )
    .orderBy('l.is_system', 'desc')
    .orderBy('l.created_at')
    .orderBy('l.id');
}
type TypeRow = Awaited<ReturnType<ReturnType<typeof typesOf>['execute']>>[number];

const recordKind = z.enum(recordKinds);
const kindOf = (kind: string): RecordKind => recordKind.parse(kind);

/** The sides of an association this object's records are on. */
function sidesOf(type: TypeRow, objectTypeId: string): AssociationSide[] {
  if (type.from_object_type_id === type.to_object_type_id)
    return type.label === type.reverse_label ? ['both'] : ['from', 'to'];
  return type.from_object_type_id === objectTypeId ? ['from'] : ['to'];
}

/** Who may change a side's relations: a deal's contacts are the deal's, a contact's companies the contact's. */
function managers(type: TypeRow): RecordKind[] {
  if (type.is_system && type.key === DEAL_CONTACT_LINK) return ['deal'];
  if (type.is_system && type.key === CONTACT_COMPANY_LINK) return ['contact'];
  return [kindOf(type.from_kind), kindOf(type.to_kind)];
}

async function groupOf(
  trx: DatabaseTransaction,
  invocation: Invocation,
  record: { readonly id: string; readonly trashed: boolean },
  type: TypeRow,
  side: AssociationSide,
  after: string | undefined,
): Promise<AssociationGroup> {
  const relations = () => {
    const query = trx.selectFrom('crm.record_links as l').where('l.link_type_id', '=', type.id);
    if (side === 'from') return query.where('l.from_record_id', '=', record.id);
    if (side === 'to') return query.where('l.to_record_id', '=', record.id);
    return query.where((eb) =>
      eb.or([eb('l.from_record_id', '=', record.id), eb('l.to_record_id', '=', record.id)]),
    );
  };
  let page = relations().select([
    'l.id',
    'l.from_record_id',
    'l.to_record_id',
    'l.is_primary',
    'l.created_at',
  ]);
  if (after !== undefined) {
    const found = await relations()
      .select('l.id')
      .where('l.id', '=', uuidOf('record_link', after))
      .executeTakeFirst();
    if (found === undefined)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_relation',
          message: 'Start after a relation of this record on this side.',
        },
      ]);
    page = page.where('l.id', '<', found.id);
  }
  const rows = await page
    .orderBy('l.id', 'desc')
    .limit(RELATION_PAGE_SIZE + 1)
    .execute();
  const { total } = await relations()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  const shown = rows.slice(0, RELATION_PAGE_SIZE);
  const other = (row: (typeof shown)[number]) =>
    row.from_record_id === record.id ? row.to_record_id : row.from_record_id;
  const names = new Map(
    (shown.length === 0 ? [] : await recordNames(trx, shown.map(other))).map((row) => [
      row.id,
      row,
    ]),
  );
  const last = shown.at(-1);
  return {
    associationId: toPublicId('link_type', type.id),
    side,
    label: side === 'to' ? type.reverse_label : type.label,
    objectKey: side === 'to' ? type.from_key : type.to_key,
    objectLabel: side === 'to' ? type.from_plural : type.to_plural,
    system: type.is_system,
    allowsPrimary: type.allows_primary,
    limit: side === 'to' ? type.from_limit : type.to_limit,
    records: shown.map((row) => {
      const found = names.get(other(row));
      // Both records of a relation are the business's, which reads them all.
      if (found === undefined) throw new NotFoundError('Record', other(row));
      const kind = kindOf(found.kind);
      return {
        relationId: toPublicId('record_link', row.id),
        id: toPublicId(kind, other(row)),
        kind,
        name: found.name,
        inTrash: found.trashed,
        isPrimary: row.is_primary,
        linkedAt: row.created_at.toISOString(),
      };
    }),
    total: Number(total),
    next:
      rows.length > RELATION_PAGE_SIZE && last !== undefined
        ? toPublicId('record_link', last.id)
        : null,
    canManage: !record.trashed && mayRelate(invocation.permissions, managers(type)),
  };
}

/** The record's associations, or one side of one of them a page further on. */
export async function readRecordAssociations(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  query: Query,
): Promise<RecordAssociations> {
  requireBusiness(invocation.context);
  const record = await requireRecord(trx, id);
  let types = typesOf(trx, record.objectTypeId);
  if (query.associationId !== undefined)
    types = types.where('l.id', '=', uuidOf('link_type', query.associationId));
  const rows = await types.execute();
  if (query.associationId !== undefined && rows.length === 0)
    throw new NotFoundError('Association', query.associationId);
  const items: AssociationGroup[] = [];
  for (const type of rows)
    for (const side of sidesOf(type, record.objectTypeId)) {
      if (query.side !== undefined && side !== query.side) continue;
      items.push(await groupOf(trx, invocation, record, type, side, query.after));
    }
  if (query.side !== undefined && items.length === 0)
    throw new ValidationError([
      { path: '/side', code: 'unknown_side', message: 'This record is not on that side.' },
    ]);
  return { items };
}
