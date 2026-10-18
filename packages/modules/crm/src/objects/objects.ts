// Custom objects, as GoHighLevel's Settings → Objects makes them: an object is made with its
// primary field, whose value names each record, and up to ten of them live in a business.
// Its key and its primary field never change (the database holds both). Deleting one hides
// it at once and leaves a job that removes its records, fields and associations in batches;
// it is refused while a published workflow uses the object, which only the automation
// module can tell: the server hands that reader over.
import { createHash } from 'node:crypto';
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Command,
  type Invocation,
} from '@repo/commands';
import {
  MAX_CUSTOM_OBJECTS,
  createObjectInput,
  deleteObjectInput,
  mergeKeyFromName,
  objectDefinition,
  objectInternalName,
  objectKeyInput,
  updateObjectInput,
  type ObjectDefinition,
  type ObjectDetail,
  type ObjectList,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';
import { asField, type FieldRow } from '../fields/fields.js';
import { systemFolderOf } from '../fields/folder-access.js';

/** A workflow that uses an object, by public id and name. */
export interface ObjectUse {
  readonly id: string;
  readonly name: string;
}

/** The published workflows that use the object with this key. */
export type ObjectUsesReader = (
  trx: DatabaseTransaction,
  objectKey: string,
) => Promise<readonly ObjectUse[]>;

export interface ObjectOptions {
  readonly uses: ObjectUsesReader;
}

/** The text types a searchable field can have (the database holds the same list). */
const SEARCHABLE_TYPES: readonly string[] = ['text', 'long_text', 'email', 'phone', 'url'];

/** The standard objects first, in the order the product shows them, then custom ones by age. */
const STANDARD_ORDER: readonly string[] = ['contact', 'company', 'deal'];
const placeOf = (kind: string): number => {
  const at = STANDARD_ORDER.indexOf(kind);
  return at === -1 ? STANDARD_ORDER.length : at;
};

const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

const standardKept = (): ValidationError =>
  invalid('', 'standard_object', 'A standard object is kept as it is.');

const uniqueErrors = explainUniqueViolation({
  object_types_key_unique: () =>
    invalid('/key', 'invalid_object', 'This key already belongs to an object.'),
});

const objectColumns = [
  'o.id',
  'o.key',
  'o.kind',
  'o.singular_label',
  'o.plural_label',
  'o.description',
  'o.icon',
  'o.primary_field_id',
  'o.created_by_kind',
  'o.created_at',
  'o.archived_at',
] as const;

interface ObjectRow {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly singular_label: string;
  readonly plural_label: string;
  readonly description: string;
  readonly icon: string | null;
  readonly primary_field_id: string | null;
  readonly created_by_kind: string;
  readonly created_at: Date;
}

/** The object types of the business that aren't deleted. */
function liveObjects(trx: DatabaseTransaction) {
  return trx
    .selectFrom('crm.object_types as o')
    .select(objectColumns)
    .where('o.archived_at', 'is', null);
}

async function findObject(
  trx: DatabaseTransaction,
  key: string,
  lock: boolean,
): Promise<ObjectRow> {
  let query = liveObjects(trx).where('o.key', '=', key);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Object', key);
  return row;
}

/** No row has this id: it keeps a list that may be empty valid in `in (…)`. */
const NO_ID = '00000000-0000-0000-0000-000000000000';

/** What the API shows of each of these objects, with its primary and searchable fields. */
async function presenter(
  trx: DatabaseTransaction,
  rows: readonly ObjectRow[],
): Promise<(row: ObjectRow) => ObjectDefinition> {
  const ids = [...rows.map((row) => row.id), NO_ID];
  const fields = await trx
    .selectFrom('crm.field_definitions')
    .select(['id', 'object_type_id', 'key', 'label', 'value_type', 'is_unique', 'is_searchable'])
    .where('object_type_id', 'in', ids)
    .where((eb) => eb.or([eb('is_searchable', '=', true), eb('id', 'in', primaryIds(rows))]))
    .orderBy('position')
    .orderBy('id')
    .execute();
  const counts = await trx
    .selectFrom('crm.custom_records')
    .select(['object_type_id', (eb) => eb.fn.countAll<string>().as('records')])
    .where('object_type_id', 'in', ids)
    .where('deleted_at', 'is', null)
    .groupBy('object_type_id')
    .execute();
  return (row) => {
    const primary = fields.find((field) => field.id === row.primary_field_id);
    const searchable = fields
      .filter((field) => field.object_type_id === row.id && field.is_searchable)
      .filter((field) => field.id !== row.primary_field_id)
      .map((field) => toPublicId('field', field.id));
    const custom = row.kind === 'custom';
    const editable = [
      row.singular_label,
      row.plural_label,
      row.description,
      row.icon,
      [...searchable].sort(),
    ];
    return objectDefinition.parse({
      id: toPublicId('object_type', row.id),
      key: row.key,
      kind: row.kind,
      standard: !custom,
      internalName: objectInternalName(row.kind, row.key),
      singularLabel: row.singular_label,
      pluralLabel: row.plural_label,
      description: row.description,
      icon: row.icon,
      primaryField:
        primary === undefined
          ? null
          : {
              id: toPublicId('field', primary.id),
              key: primary.key,
              label: primary.label,
              valueType: primary.value_type,
              unique: primary.is_unique,
            },
      searchableFieldIds: searchable,
      records: custom
        ? Number(counts.find((count) => count.object_type_id === row.id)?.records ?? 0)
        : null,
      source: row.created_by_kind,
      createdAt: row.created_at.toISOString(),
      revision: createHash('sha256').update(JSON.stringify(editable)).digest('hex'),
    });
  };
}
function primaryIds(rows: readonly ObjectRow[]): string[] {
  return [
    ...rows.flatMap((row) => (row.primary_field_id === null ? [] : [row.primary_field_id])),
    NO_ID,
  ];
}
async function presentOne(trx: DatabaseTransaction, row: ObjectRow): Promise<ObjectDefinition> {
  return (await presenter(trx, [row]))(row);
}

const canManage = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('objects.manage');

/** Every object of the business: the standard ones, then custom ones, oldest first. */
export async function readObjects(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<ObjectList> {
  requireBusiness(invocation.context);
  const rows = await liveObjects(trx).orderBy('o.created_at').orderBy('o.id').execute();
  const ordered = [...rows].sort((a, b) => placeOf(a.kind) - placeOf(b.kind));
  return {
    items: ordered.map(await presenter(trx, ordered)),
    limit: MAX_CUSTOM_OBJECTS,
    canManage: canManage(invocation),
  };
}

/** One object with its fields, folder by folder. */
export async function readObject(
  trx: DatabaseTransaction,
  invocation: Invocation,
  key: string,
): Promise<ObjectDetail> {
  requireBusiness(invocation.context);
  const row = await findObject(trx, key, false);
  const object = await presentOne(trx, row);
  const fields = await trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.field_folders as d', (join) =>
      join.onRef('d.business_id', '=', 'f.business_id').onRef('d.id', '=', 'f.folder_id'),
    )
    .selectAll('f')
    .where('f.object_type_id', '=', row.id)
    .orderBy('d.position')
    .orderBy('d.created_at')
    .orderBy('d.id')
    .orderBy('f.position')
    .orderBy('f.id')
    .execute();
  return {
    ...object,
    fields: fields.map((field) =>
      asField({
        ...field,
        object_key: row.key,
        object_kind: row.kind,
        object_primary_field_id: row.primary_field_id,
      } satisfies FieldRow),
    ),
  };
}

/** The key made from a name, with _2, _3… after it when the business has it already. */
async function freeObjectKey(trx: DatabaseTransaction, name: string): Promise<string> {
  const base = mergeKeyFromName(name, 'object');
  // A business has three standard objects and at most ten live custom ones, plus those
  // being purged: read them all.
  const taken = new Set(
    (await trx.selectFrom('crm.object_types').select('key').execute()).map((row) => row.key),
  );
  if (!taken.has(base)) return base;
  let n = 2;
  const suffixed = (at: number) => `${base.slice(0, 63 - `_${String(at)}`.length)}_${String(at)}`;
  while (taken.has(suffixed(n))) n += 1;
  return suffixed(n);
}

export const createObjectCommand = defineCommand({
  name: 'object.create',
  permission: 'objects.manage',
  input: createObjectInput,
  async handle(trx, input, command): Promise<ObjectDefinition> {
    const businessId = requireBusiness(command.context);
    // Two objects made at once are counted one after the other: both hold the business's
    // contacts object, the object type a field of any object is made under too.
    await trx
      .selectFrom('crm.object_types')
      .select('id')
      .where('kind', '=', 'contact')
      .forUpdate()
      .execute();
    const { count } = await trx
      .selectFrom('crm.object_types')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('kind', '=', 'custom')
      .where('archived_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_CUSTOM_OBJECTS)
      throw invalid(
        '',
        'object_limit',
        `A business can have up to ${String(MAX_CUSTOM_OBJECTS)} custom objects.`,
      );
    const key = input.key ?? (await freeObjectKey(trx, input.singularLabel));
    // The object names its primary field before the field is made: the reference waits for
    // the end of the transaction (0128).
    const ids = await trx
      .selectNoFrom([sql<string>`uuidv7()`.as('object_id'), sql<string>`uuidv7()`.as('field_id')])
      .executeTakeFirstOrThrow();
    const by = {
      created_by_kind: command.context.actorKind,
      created_by_id: command.context.actorId ?? null,
    };
    await trx
      .insertInto('crm.object_types')
      .values({
        business_id: businessId,
        id: ids.object_id,
        kind: 'custom',
        key,
        singular_label: input.singularLabel,
        plural_label: input.pluralLabel,
        description: input.description,
        icon: input.icon,
        primary_field_id: ids.field_id,
        ...by,
      })
      .execute()
      .catch(uniqueErrors);
    const primary = input.primaryField;
    await trx
      .insertInto('crm.field_definitions')
      .values({
        business_id: businessId,
        id: ids.field_id,
        object_type_id: ids.object_id,
        key: primary.key ?? mergeKeyFromName(primary.label, 'field'),
        label: primary.label,
        description: `What each ${input.singularLabel} is called, wherever one is listed.`,
        value_type: primary.valueType,
        is_unique: primary.unique,
        folder_id: await systemFolderOf(trx, ids.object_id),
        ...by,
      })
      .execute();
    await command.emit({
      type: 'object.created',
      subject: { kind: 'object_type', id: ids.object_id },
      payload: {
        key,
        singularLabel: input.singularLabel,
        primaryField: primary.key ?? mergeKeyFromName(primary.label, 'field'),
      },
    });
    return presentOne(trx, await findObject(trx, key, false));
  },
});

const updateInput = updateObjectInput.extend(objectKeyInput.shape);

export const updateObjectCommand = defineCommand({
  name: 'object.update',
  permission: 'objects.manage',
  input: updateInput,
  async handle(trx, input, command): Promise<ObjectDefinition> {
    requireBusiness(command.context);
    const row = await findObject(trx, input.key, true);
    if (row.kind !== 'custom') throw standardKept();
    const current = await presentOne(trx, row);
    if (current.revision !== input.revision)
      throw new ConflictError('This object changed. Reload it before saving again.');
    // The fields that may be searched: text fields of this object, live, other than the
    // primary field, which always is.
    const eligible = (
      await trx
        .selectFrom('crm.field_definitions')
        .select('id')
        .where('object_type_id', '=', row.id)
        .where('archived_at', 'is', null)
        .where('value_type', 'in', SEARCHABLE_TYPES)
        .execute()
    ).filter((field) => field.id !== row.primary_field_id);
    const chosen = eligible
      .filter((field) => input.searchableFieldIds.includes(toPublicId('field', field.id)))
      .map((field) => field.id);
    if (chosen.length !== input.searchableFieldIds.length)
      throw invalid(
        '/searchableFieldIds',
        'invalid_field',
        'Choose text fields of this object, other than its primary field, which is always searched.',
      );
    // Only the fields whose setting changes are written, so the others keep their revision.
    for (const searchable of [false, true])
      await trx
        .updateTable('crm.field_definitions')
        .set({ is_searchable: searchable })
        .where('object_type_id', '=', row.id)
        .where('is_searchable', '=', !searchable)
        .where('id', searchable ? 'in' : 'not in', [...chosen, NO_ID])
        .execute();
    await trx
      .updateTable('crm.object_types')
      .set({
        singular_label: input.singularLabel,
        plural_label: input.pluralLabel,
        description: input.description,
        icon: input.icon,
      })
      .where('id', '=', row.id)
      .execute();
    await command.emit({
      type: 'object.updated',
      subject: { kind: 'object_type', id: row.id },
      payload: {
        key: row.key,
        singularLabel: input.singularLabel,
        searchableFields: input.searchableFieldIds.length,
      },
    });
    return presentOne(trx, await findObject(trx, row.key, false));
  },
});

/** One batch of an object's purge, and how many records each removes unless told. */
const PURGE_BATCH = 500;

const purgeData = z.strictObject({
  objectTypeId: z.uuid(),
  batch: z.int().min(1).max(PURGE_BATCH).default(PURGE_BATCH),
});

/** The worker's job that empties a deleted object, a batch at a time. */
export const purgeObjectReference = { name: 'objects.purge', data: purgeData } as const;

const deleteInput = deleteObjectInput.extend(objectKeyInput.shape);

export function deleteObjectCommand(options: ObjectOptions): Command<typeof deleteInput, void> {
  return defineCommand({
    name: 'object.delete',
    permission: 'objects.manage',
    input: deleteInput,
    async handle(trx, input, command): Promise<void> {
      requireBusiness(command.context);
      const row = await findObject(trx, input.key, true);
      if (row.kind !== 'custom') throw standardKept();
      if (input.confirm !== row.plural_label)
        throw invalid('/confirm', 'confirm', `Type ${row.plural_label} to delete it.`);
      const uses = await options.uses(trx, row.key);
      if (uses.length > 0)
        throw new ConflictError(
          `Published workflows use this object: ${uses.map((use) => use.name).join(', ')}. Change them first.`,
        );
      await trx
        .updateTable('crm.object_types')
        .set({ archived_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'object.deleted',
        subject: { kind: 'object_type', id: row.id },
        payload: { key: row.key, pluralLabel: row.plural_label },
      });
      command.enqueue(purgeObjectReference, { objectTypeId: row.id });
    },
  });
}

/**
 * One batch of a deleted object's purge: its records go through the registry, whose
 * cascades take their values, links, notes and tasks; once none is left, the object goes,
 * and its fields, folders and associations with it. Gives whether the purge is done.
 */
export const purgeObjectCommand = defineCommand({
  name: 'object.purge',
  permission: 'objects.manage',
  input: purgeData,
  async handle(trx, input, command): Promise<{ done: boolean }> {
    requireBusiness(command.context);
    const object = await trx
      .selectFrom('crm.object_types')
      .select(['id', 'key', 'kind', 'archived_at'])
      .where('id', '=', input.objectTypeId)
      .forUpdate()
      .executeTakeFirst();
    // Purged already, or never deleted: nothing to do.
    if (object?.kind !== 'custom' || object.archived_at === null) return { done: true };
    // Any batch of them, as the object's index finds them: no order is needed to empty it,
    // and none is paid for by sorting what is left each time.
    const purged = await trx
      .deleteFrom('crm.records')
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('crm.records')
          .select('id')
          .where('object_type_id', '=', object.id)
          .limit(input.batch),
      )
      .returning('id')
      .execute();
    if (purged.length > 0) return { done: false };
    await trx.deleteFrom('crm.object_types').where('id', '=', object.id).execute();
    await command.emit({
      type: 'object.purged',
      subject: { kind: 'object_type', id: object.id },
      payload: { key: object.key },
    });
    return { done: true };
  },
});

export const purgeObjectTask = defineTask({
  ...purgeObjectReference,
  async run(data, { invocation, services }) {
    for (;;) {
      const { done } = await runCommand(services, purgeObjectCommand, data, {
        ...invocation,
        permissions: 'all',
      });
      if (done) return;
    }
  },
});

/** Finds the object a path names: another business's, or a deleted one, is not found. */
export async function objectInPath(trx: DatabaseTransaction, key: string): Promise<void> {
  await findObject(trx, key, false);
}
