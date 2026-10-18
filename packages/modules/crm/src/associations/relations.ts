// Relations: two records linked under an association, GoHighLevel's relations. The two
// system associations that have commands of their own keep them: a deal's contact is linked
// by linkDealContactCommand (owner rules, primary contact) and a contact's company by
// linkContactCompanyCommand, so their rows, events and rules stay exactly as they are; the
// routes send those there. Every other association, deal↔company among them, is written
// here.
//
// Every relation write locks its two records in one order: deal, contact, company, custom,
// then by id, which is the order the built-in commands take theirs in (deal then contact,
// contact then company), so none of them can deadlock with another. Then it takes the
// association FOR SHARE, which a change of the association's limits (FOR UPDATE) waits
// for, and counts each side against its limit: two writes to one record wait for each
// other on its lock, so the count is the count written.
import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import {
  publicId,
  recordId,
  type Permission,
  type RecordKind,
  type Relation,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  publicIdPrefixes,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import type { SelectQueryBuilder } from 'kysely';
import * as z from 'zod';

import { DEAL_CONTACT_LINK } from '../deals/link-type.js';
import { holdOwnerRules } from '../deals/owner-rules.js';
import { requireRecord } from '../records/access.js';
import { uuidOf } from '../records/public-ids.js';

/** The association key of a contact's company links (companies/links.ts). */
export const CONTACT_COMPANY_LINK = 'contact_company';

/** The permission that changes records of each kind, and so their relations. */
export const managedBy = {
  contact: 'contacts.manage',
  company: 'companies.manage',
  deal: 'deals.manage',
  custom: 'records.manage',
} as const satisfies Record<RecordKind, Permission>;

/** The order relation writes lock records in, by kind. */
const lockOrder: readonly RecordKind[] = ['deal', 'contact', 'company', 'custom'];

const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

/** An association between live objects, with what its relations need of it. */
export interface RelationType {
  readonly id: string;
  readonly key: string;
  readonly is_system: boolean;
  readonly label: string;
  readonly reverse_label: string;
  readonly allows_primary: boolean;
  readonly from_limit: number | null;
  readonly to_limit: number | null;
  readonly from_object_type_id: string;
  readonly to_object_type_id: string;
  readonly from_name: string;
  readonly to_plural: string;
  readonly from_plural: string;
}

/** The system associations whose relations their own commands write (see the top). */
export const builtIn = (type: Pick<RelationType, 'is_system' | 'key'>): boolean =>
  type.is_system && (type.key === DEAL_CONTACT_LINK || type.key === CONTACT_COMPANY_LINK);

/** An association that joins an object to itself with one label reads the same both ways. */
export const symmetric = (type: RelationType): boolean =>
  type.from_object_type_id === type.to_object_type_id && type.label === type.reverse_label;

/** The association, between objects not being deleted; FOR SHARE when a relation is written. */
export async function relationType(
  trx: DatabaseTransaction,
  id: string,
  share = false,
): Promise<RelationType> {
  let query = trx
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
      'f.singular_label as from_name',
      'f.plural_label as from_plural',
      't.plural_label as to_plural',
    ])
    .where('l.id', '=', uuidOf('link_type', id))
    .where('l.archived_at', 'is', null)
    .where('f.archived_at', 'is', null)
    .where('t.archived_at', 'is', null);
  if (share) query = query.forShare('l');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Association', id);
  return row;
}

type Held = Awaited<ReturnType<typeof requireRecord>>;

/**
 * Where a record comes in the lock order: its kind's place, then its id. A public id's text
 * after the prefix is its UUID in TypeID's base32, whose characters sort as the bits do, so
 * two records of one kind come in UUID order, as the contact merge takes contacts.
 */
const lockPlace = (id: string): string => {
  const kind = lockOrder.findIndex((each) => id.startsWith(`${publicIdPrefixes[each]}_`));
  return `${String(kind)}:${id.slice(id.indexOf('_') + 1)}`;
};

/**
 * Both records, held in the order every relation write takes them. One in the trash is
 * refused: it is restored before it is related.
 */
async function holdBoth(
  trx: DatabaseTransaction,
  fromId: string,
  toId: string,
): Promise<{ from: Held; to: Held }> {
  const fromFirst = lockPlace(fromId) < lockPlace(toId);
  const first = await requireRecord(trx, fromFirst ? fromId : toId, true);
  const second = await requireRecord(trx, fromFirst ? toId : fromId, true);
  return fromFirst ? { from: first, to: second } : { from: second, to: first };
}

/** Refuses a relation whose records aren't of the association's objects, either way round. */
export function orient(
  type: Pick<RelationType, 'from_object_type_id' | 'to_object_type_id'>,
  first: { readonly id: string; readonly objectTypeId: string },
  second: { readonly id: string; readonly objectTypeId: string },
): { fromId: string; toId: string } {
  if (
    first.objectTypeId === type.from_object_type_id &&
    second.objectTypeId === type.to_object_type_id
  )
    return { fromId: first.id, toId: second.id };
  if (
    second.objectTypeId === type.from_object_type_id &&
    first.objectTypeId === type.to_object_type_id
  )
    return { fromId: second.id, toId: first.id };
  throw invalid(
    '/secondRecordId',
    'wrong_object',
    "Choose a record of each of the association's two objects.",
  );
}

/** Whether the invocation may change records of both kinds, and so relate them. */
export function mayRelate(
  permissions: CommandContext['permissions'],
  kinds: readonly RecordKind[],
): boolean {
  return permissions === 'all' || kinds.every((kind) => permissions.has(managedBy[kind]));
}

function requireBoth(command: CommandContext, kinds: readonly RecordKind[]): void {
  for (const kind of kinds)
    if (command.permissions !== 'all' && !command.permissions.has(managedBy[kind]))
      throw new ForbiddenError(
        `Your role doesn't allow this: it needs ${managedBy[kind]}.`,
        managedBy[kind],
      );
}

const relationColumns = [
  'id',
  'link_type_id',
  'from_record_id',
  'to_record_id',
  'is_primary',
  'created_at',
] as const;

/** A relation as the API shows it. */
export async function presentRelation(trx: DatabaseTransaction, id: string): Promise<Relation> {
  const row = await trx
    .selectFrom('crm.record_links as l')
    .innerJoin('crm.records as f', (join) =>
      join.onRef('f.business_id', '=', 'l.business_id').onRef('f.id', '=', 'l.from_record_id'),
    )
    .innerJoin('crm.records as t', (join) =>
      join.onRef('t.business_id', '=', 'l.business_id').onRef('t.id', '=', 'l.to_record_id'),
    )
    .select(relationColumns.map((column) => `l.${column}` as const))
    .select(['f.kind as from_kind', 't.kind as to_kind'])
    .where('l.id', '=', id)
    .executeTakeFirstOrThrow();
  const kind = z.enum(['contact', 'company', 'deal', 'custom']);
  return {
    id: toPublicId('record_link', row.id),
    associationId: toPublicId('link_type', row.link_type_id),
    fromRecordId: toPublicId(kind.parse(row.from_kind), row.from_record_id),
    toRecordId: toPublicId(kind.parse(row.to_kind), row.to_record_id),
    isPrimary: row.is_primary,
    createdAt: row.created_at.toISOString(),
  };
}

/** The relation of the type between the two records, whichever is from, to read. */
export function relationBetween(
  trx: DatabaseTransaction,
  typeId: string,
  a: string,
  b: string,
): SelectQueryBuilder<
  DB,
  'crm.record_links',
  { id: string; from_record_id: string; is_primary: boolean }
> {
  return trx
    .selectFrom('crm.record_links')
    .select(['id', 'from_record_id', 'is_primary'])
    .where('link_type_id', '=', typeId)
    .where((eb) =>
      eb.or([
        eb.and([eb('from_record_id', '=', a), eb('to_record_id', '=', b)]),
        eb.and([eb('from_record_id', '=', b), eb('to_record_id', '=', a)]),
      ]),
    );
}

/** How many relations of the type a record has on a side, or on either for a symmetric one. */
async function countOn(
  trx: DatabaseTransaction,
  type: RelationType,
  record: string,
  side: 'from_record_id' | 'to_record_id',
): Promise<number> {
  let query = trx
    .selectFrom('crm.record_links')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('link_type_id', '=', type.id);
  query = symmetric(type)
    ? query.where((eb) =>
        eb.or([eb('from_record_id', '=', record), eb('to_record_id', '=', record)]),
      )
    : query.where(side, '=', record);
  const { count } = await query.executeTakeFirstOrThrow();
  return Number(count);
}

export const writeRelationInput = z.strictObject({
  associationId: publicId('link_type'),
  fromRecordId: recordId,
  toRecordId: recordId,
  primary: z.boolean().optional(),
});
export const removeRelationInput = z.strictObject({ relationId: publicId('record_link') });

function writeCommand(kind: RecordKind): Command<typeof writeRelationInput, Relation> {
  return defineCommand({
    name: 'relation.create',
    permission: managedBy[kind],
    input: writeRelationInput,
    async handle(trx, input, command): Promise<Relation> {
      const businessId = requireBusiness(command.context);
      if (input.fromRecordId === input.toRecordId)
        throw invalid(
          '/toRecordId',
          'same_record',
          'Choose another record: a record is not related to itself.',
        );
      const { from, to } = await holdBoth(trx, input.fromRecordId, input.toRecordId);
      requireBoth(command, [from.kind, to.kind]);
      const type = await relationType(trx, input.associationId, true);
      if (builtIn(type))
        throw invalid(
          '/associationId',
          'system_association',
          'This association is written by its own command, which keeps its rules.',
        );
      if (
        from.objectTypeId !== type.from_object_type_id ||
        to.objectTypeId !== type.to_object_type_id
      )
        throw invalid(
          '/toRecordId',
          'wrong_object',
          "Choose a record of each of the association's two objects, from then to.",
        );
      if (input.primary === true && !type.allows_primary)
        throw invalid('/primary', 'no_primary', 'This association has no primary record.');
      const existing = await relationBetween(trx, type.id, from.id, to.id).executeTakeFirst();
      const source = {
        source_kind: command.context.actorKind,
        source_id: command.context.actorId ?? null,
      };
      const events = {
        subject: { kind: from.kind, id: from.id },
        payload: {
          linkTypeId: input.associationId,
          fromId: input.fromRecordId,
          toId: input.toRecordId,
        },
      };
      const primary = input.primary ?? existing?.is_primary ?? false;
      const changed = new Set([from.id, to.id]);
      if (primary && existing?.is_primary !== true) {
        // One primary per record on the from side: the one before steps down first.
        const previous = await trx
          .updateTable('crm.record_links')
          .set({ is_primary: false, ...source })
          .where('link_type_id', '=', type.id)
          .where('from_record_id', '=', from.id)
          .where('is_primary', '=', true)
          .returning('to_record_id')
          .execute();
        for (const row of previous) changed.add(row.to_record_id);
      }
      if (existing !== undefined) {
        if (existing.is_primary !== primary) {
          await trx
            .updateTable('crm.record_links')
            .set({ is_primary: primary, ...source })
            .where('id', '=', existing.id)
            .execute();
          await command.emit({
            type: 'record.association_changed',
            ...events,
            records: [...changed],
            payload: { ...events.payload, primary },
          });
        }
        return presentRelation(trx, existing.id);
      }
      for (const [limit, record, side, name] of [
        [type.to_limit, from.id, 'from_record_id', type.from_name],
        [type.from_limit, to.id, 'to_record_id', null],
      ] as const) {
        if (limit === null) continue;
        const count = await countOn(trx, type, record, side);
        if (count >= limit)
          throw invalid(
            '',
            'limit_reached',
            name === null
              ? `This record already has the most ${type.from_plural} it may have as ${type.reverse_label} (${String(limit)}).`
              : `This ${name} already has the most ${type.to_plural} it may have as ${type.label} (${String(limit)}).`,
          );
      }
      const made = await trx
        .insertInto('crm.record_links')
        .values({
          business_id: businessId,
          link_type_id: type.id,
          from_record_id: from.id,
          to_record_id: to.id,
          is_primary: primary,
          ...source,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'record.associated',
        ...events,
        records: [...changed],
        payload: { ...events.payload, primary },
      });
      return presentRelation(trx, made.id);
    },
  });
}

function removeCommand(kind: RecordKind): Command<typeof removeRelationInput, undefined> {
  return defineCommand({
    name: 'relation.delete',
    permission: managedBy[kind],
    input: removeRelationInput,
    async handle(trx, input, command): Promise<undefined> {
      const businessId = requireBusiness(command.context);
      const read = await relationRow(trx, input.relationId);
      const type = await relationType(trx, toPublicId('link_type', read.link_type_id));
      if (type.is_system && type.key === CONTACT_COMPANY_LINK)
        throw invalid(
          '/relationId',
          'system_association',
          'This association is written by its own command, which keeps its rules.',
        );
      // A deal's contacts change in turn with the owner rules, as the opportunity dialog
      // changes them (deals/contacts.ts). The rules come before any row, as every deal link
      // change takes them: holding the relation first would deadlock with one.
      const dealContact = type.is_system && type.key === DEAL_CONTACT_LINK;
      if (dealContact) await holdOwnerRules(trx, businessId);
      // Held, so the relation removed is the one read, and its event is told once.
      const relation = await relationRow(trx, input.relationId, true);
      // Removing a relation is allowed while either record is in the trash, as removing a
      // contact's company is: the records are held, not changed.
      const from = await requireRecord(
        trx,
        toPublicId(relation.from_kind, relation.from_record_id),
      );
      const to = await requireRecord(trx, toPublicId(relation.to_kind, relation.to_record_id));
      // A deal's contact is the deal's to change, as setting a deal's contacts is.
      requireBoth(command, dealContact ? ['deal'] : [from.kind, to.kind]);
      await trx.deleteFrom('crm.record_links').where('id', '=', relation.id).execute();
      await command.emit(
        dealContact
          ? {
              type: 'deal.contact_unlinked',
              subject: { kind: 'deal', id: from.id },
              records: [from.id, to.id],
              payload: { contactId: toPublicId('contact', to.id) },
            }
          : {
              type: 'record.unassociated',
              subject: { kind: from.kind, id: from.id },
              records: [from.id, to.id],
              payload: {
                linkTypeId: toPublicId('link_type', type.id),
                fromId: toPublicId(from.kind, from.id),
                toId: toPublicId(to.kind, to.id),
              },
            },
      );
      return undefined;
    },
  });
}

/** A relation of this business with its records' kinds; another business's is not found. */
export async function relationRow(
  trx: DatabaseTransaction,
  id: string,
  lock = false,
): Promise<{
  readonly id: string;
  readonly link_type_id: string;
  readonly from_record_id: string;
  readonly to_record_id: string;
  readonly from_kind: RecordKind;
  readonly to_kind: RecordKind;
}> {
  let query = trx
    .selectFrom('crm.record_links as l')
    .innerJoin('crm.records as f', (join) =>
      join.onRef('f.business_id', '=', 'l.business_id').onRef('f.id', '=', 'l.from_record_id'),
    )
    .innerJoin('crm.records as t', (join) =>
      join.onRef('t.business_id', '=', 'l.business_id').onRef('t.id', '=', 'l.to_record_id'),
    )
    .select(['l.id', 'l.link_type_id', 'l.from_record_id', 'l.to_record_id'])
    .select(['f.kind as from_kind', 't.kind as to_kind'])
    .where('l.id', '=', uuidOf('record_link', id));
  if (lock) query = query.forUpdate('l');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Relation', id);
  const kind = z.enum(['contact', 'company', 'deal', 'custom']);
  return { ...row, from_kind: kind.parse(row.from_kind), to_kind: kind.parse(row.to_kind) };
}

/** The relation commands, one for each kind of the from record, which names its permission. */
export const writeRelationCommands = {
  contact: writeCommand('contact'),
  company: writeCommand('company'),
  deal: writeCommand('deal'),
  custom: writeCommand('custom'),
} as const satisfies Record<RecordKind, Command<typeof writeRelationInput, Relation>>;

export const removeRelationCommands = {
  contact: removeCommand('contact'),
  company: removeCommand('company'),
  deal: removeCommand('deal'),
  custom: removeCommand('custom'),
} as const satisfies Record<RecordKind, Command<typeof removeRelationInput, undefined>>;
