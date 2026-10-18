// Associations, as GoHighLevel's Settings → Objects → Associations makes them: each is a
// link type (one of its association labels) between two objects, with a label each way and
// how many records each side may link. A business makes up to ten for a pair of objects.
// The three every business starts with are the product's: code reads them by key, so only
// their labels change and they stay (the database holds both).
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  MAX_ASSOCIATION_LABELS,
  association,
  associationIdInput,
  createAssociationInput,
  mergeKeyFromName,
  updateAssociationInput,
  type Association,
  type AssociationList,
  type listAssociationsQuery,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import type * as z from 'zod';

const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

const uniqueErrors = explainUniqueViolation({
  link_types_key_unique: () =>
    invalid('/key', 'invalid_association', 'This key already belongs to an association.'),
  link_types_label_unique_idx: () =>
    invalid(
      '/label',
      'invalid_association',
      'These objects already have an association with these labels.',
    ),
});

const systemKept = (what: string): ValidationError =>
  invalid('', 'system_association', `A system association's ${what}.`);

/** Link types between live objects, with their objects' keys and names. */
function liveTypes(trx: DatabaseTransaction) {
  return trx
    .selectFrom('crm.link_types as l')
    .innerJoin('crm.object_types as f', (join) =>
      join.onRef('f.business_id', '=', 'l.business_id').onRef('f.id', '=', 'l.from_object_type_id'),
    )
    .innerJoin('crm.object_types as t', (join) =>
      join.onRef('t.business_id', '=', 'l.business_id').onRef('t.id', '=', 'l.to_object_type_id'),
    )
    .selectAll('l')
    .select([
      'f.key as from_key',
      't.key as to_key',
      'f.singular_label as from_name',
      't.singular_label as to_name',
    ])
    .where('l.archived_at', 'is', null)
    .where('f.archived_at', 'is', null)
    .where('t.archived_at', 'is', null);
}
type TypeRow = Awaited<ReturnType<ReturnType<typeof liveTypes>['executeTakeFirstOrThrow']>>;

function present(row: TypeRow): Association {
  return association.parse({
    id: toPublicId('link_type', row.id),
    key: row.key,
    fromObjectKey: row.from_key,
    toObjectKey: row.to_key,
    label: row.label,
    reverseLabel: row.reverse_label,
    description: row.description,
    system: row.is_system,
    allowsPrimary: row.allows_primary,
    fromLimit: row.from_limit,
    toLimit: row.to_limit,
    source: row.created_by_kind,
    createdAt: row.created_at.toISOString(),
  });
}

async function findType(trx: DatabaseTransaction, id: string, lock: boolean): Promise<TypeRow> {
  let query = liveTypes(trx).where('l.id', '=', parsePublicId('link_type', id) ?? '');
  if (lock) query = query.forUpdate('l');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Association', id);
  return row;
}

const canManage = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('objects.manage');

/** The business's associations by key, or those touching one object. */
export async function readAssociations(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof listAssociationsQuery>,
): Promise<AssociationList> {
  requireBusiness(invocation.context);
  let rows = liveTypes(trx).orderBy('l.key');
  if (query.objectKey !== undefined) {
    const object = await trx
      .selectFrom('crm.object_types')
      .select('id')
      .where('key', '=', query.objectKey)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (object === undefined) throw new NotFoundError('Object', query.objectKey);
    rows = rows.where((eb) =>
      eb.or([
        eb('l.from_object_type_id', '=', object.id),
        eb('l.to_object_type_id', '=', object.id),
      ]),
    );
  }
  return { items: (await rows.execute()).map(present), canManage: canManage(invocation) };
}

export async function readAssociation(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<Association> {
  requireBusiness(invocation.context);
  return present(await findType(trx, id, false));
}

/** The key made from the objects and the label, with _2, _3… when the business has it. */
async function freeTypeKey(trx: DatabaseTransaction, name: string): Promise<string> {
  const base = mergeKeyFromName(name, 'association');
  const taken = new Set(
    (await trx.selectFrom('crm.link_types').select('key').execute()).map((row) => row.key),
  );
  if (!taken.has(base)) return base;
  let n = 2;
  const suffixed = (at: number) => `${base.slice(0, 63 - `_${String(at)}`.length)}_${String(at)}`;
  while (taken.has(suffixed(n))) n += 1;
  return suffixed(n);
}

export const createAssociationCommand = defineCommand({
  name: 'association.create',
  permission: 'objects.manage',
  input: createAssociationInput,
  async handle(trx, input, command): Promise<Association> {
    const businessId = requireBusiness(command.context);
    // Both objects held, in id order as every writer of associations takes them, so two
    // labels made at once for one pair are counted one after the other.
    const objects = await trx
      .selectFrom('crm.object_types')
      .select(['id', 'key'])
      .where('key', 'in', [input.fromObjectKey, input.toObjectKey])
      .where('archived_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute();
    const from = objects.find((object) => object.key === input.fromObjectKey);
    const to = objects.find((object) => object.key === input.toObjectKey);
    if (from === undefined)
      throw invalid('/fromObjectKey', 'invalid_association', 'Choose an object of this business.');
    if (to === undefined)
      throw invalid('/toObjectKey', 'invalid_association', 'Choose an object of this business.');
    const { count } = await trx
      .selectFrom('crm.link_types')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('archived_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([eb('from_object_type_id', '=', from.id), eb('to_object_type_id', '=', to.id)]),
          eb.and([eb('from_object_type_id', '=', to.id), eb('to_object_type_id', '=', from.id)]),
        ]),
      )
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_ASSOCIATION_LABELS)
      throw invalid(
        '',
        'association_limit',
        `Two objects can have up to ${String(MAX_ASSOCIATION_LABELS)} associations.`,
      );
    const key = input.key ?? (await freeTypeKey(trx, `${from.key} ${input.label}`));
    const made = await trx
      .insertInto('crm.link_types')
      .values({
        business_id: businessId,
        key,
        from_object_type_id: from.id,
        to_object_type_id: to.id,
        label: input.label,
        reverse_label: input.reverseLabel,
        description: input.description,
        from_limit: input.fromLimit,
        to_limit: input.toLimit,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'association.created',
      subject: { kind: 'link_type', id: made.id },
      payload: {
        key,
        fromObjectKey: input.fromObjectKey,
        toObjectKey: input.toObjectKey,
        label: input.label,
        reverseLabel: input.reverseLabel,
      },
    });
    return present(await findType(trx, toPublicId('link_type', made.id), false));
  },
});

/** The most records of one side that a record of the other already links under the type. */
async function mostLinked(
  trx: DatabaseTransaction,
  typeId: string,
  per: 'from_record_id' | 'to_record_id',
): Promise<number> {
  const row = await trx
    .selectFrom('crm.record_links')
    .select((eb) => eb.fn.countAll<string>().as('linked'))
    .where('link_type_id', '=', typeId)
    .groupBy(per)
    .orderBy('linked', 'desc')
    .limit(1)
    .executeTakeFirst();
  return Number(row?.linked ?? 0);
}

const updateInput = updateAssociationInput.extend(associationIdInput.shape);

export const updateAssociationCommand = defineCommand({
  name: 'association.update',
  permission: 'objects.manage',
  input: updateInput,
  async handle(trx, input, command): Promise<Association> {
    requireBusiness(command.context);
    const row = await findType(trx, input.id, true);
    if (row.is_system && (input.fromLimit !== undefined || input.toLimit !== undefined))
      throw systemKept('limits never change');
    for (const [limit, per, path, name] of [
      [input.toLimit, 'from_record_id', '/toLimit', row.from_name],
      [input.fromLimit, 'to_record_id', '/fromLimit', row.to_name],
    ] as const) {
      if (limit === undefined) continue;
      const most = await mostLinked(trx, row.id, per);
      if (most > limit)
        throw invalid(
          path,
          'limit_exceeded',
          `A ${name} already has ${String(most)} of these: allow at least ${String(most)}.`,
        );
    }
    await trx
      .updateTable('crm.link_types')
      .set({
        label: input.label,
        reverse_label: input.reverseLabel,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.fromLimit === undefined ? {} : { from_limit: input.fromLimit }),
        ...(input.toLimit === undefined ? {} : { to_limit: input.toLimit }),
      })
      .where('id', '=', row.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'association.updated',
      subject: { kind: 'link_type', id: row.id },
      payload: { key: row.key, label: input.label, reverseLabel: input.reverseLabel },
    });
    return present(await findType(trx, input.id, false));
  },
});

export const deleteAssociationCommand = defineCommand({
  name: 'association.delete',
  permission: 'objects.manage',
  input: associationIdInput,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const row = await findType(trx, input.id, true);
    if (row.is_system) throw systemKept('place is kept: it can’t be deleted');
    // GoHighLevel: "deleting an association will also [delete] all the relations for that
    // association". The records stay.
    const removed = await trx
      .deleteFrom('crm.record_links')
      .where('link_type_id', '=', row.id)
      .returning('id')
      .execute();
    await trx.deleteFrom('crm.link_types').where('id', '=', row.id).execute();
    await command.emit({
      type: 'association.deleted',
      subject: { kind: 'link_type', id: row.id },
      payload: { key: row.key, label: row.label, relations: removed.length },
    });
  },
});

/** Finds the association a path names: another business's is not found. */
export async function associationInPath(trx: DatabaseTransaction, id: string): Promise<void> {
  await findType(trx, id, false);
}
