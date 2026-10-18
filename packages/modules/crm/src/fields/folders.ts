// Field folders: every field definition is in exactly one folder of its own object. Each
// object has a system folder that can't be renamed or deleted; it is where a field goes
// when nobody chose a folder, and where a deleted folder's fields move.
//
// Lock order, so two of these never wait on each other in a circle: the object type, then
// folders, then field definitions. A writer that needs a folder and a field takes the
// folder first (updateFieldCommand does too).
import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  FIELD_FOLDER_LIMITS,
  createFieldFolderInput,
  deleteFieldFolder,
  moveFieldsInput,
  moveFieldsToFolder,
  renameFieldFolder,
  renameFieldFolderInput,
  reorderFieldFoldersInput,
  reorderFolderFields,
  reorderFolderFieldsInput,
  type FieldFolder,
  type FieldFolderList,
  type FolderFieldOrder,
  type ListFieldFoldersQuery,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';
import { lastPlaceIn, systemFolderOf } from './folder-access.js';

const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

const uniqueErrors = explainUniqueViolation({
  field_folders_name_unique_idx: () =>
    invalid('/name', 'taken', 'This object already has a folder with this name.'),
});

interface FolderRow {
  readonly id: string;
  readonly object_type_id: string;
  readonly object_key: string;
  readonly name: string;
  readonly is_system: boolean;
  readonly position: number;
  readonly created_at: Date;
  readonly field_count: number;
}

// A rename is made from a name: the revision is the folder and the name it had.
const revisionOf = (row: Pick<FolderRow, 'id' | 'name'>): string =>
  createHash('sha256')
    .update(JSON.stringify([row.id, row.name]))
    .digest('hex');

function asFolder(row: FolderRow): FieldFolder {
  return {
    id: toPublicId('field_folder', row.id),
    objectKey: row.object_key,
    name: row.name,
    system: row.is_system,
    position: row.position,
    fieldCount: row.field_count,
    createdAt: row.created_at.toISOString(),
    revision: revisionOf(row),
  };
}

const mayManage = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('fields.manage');

function folders(trx: DatabaseTransaction) {
  return trx
    .selectFrom('crm.field_folders as d')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.business_id', '=', 'd.business_id').onRef('o.id', '=', 'd.object_type_id'),
    )
    .select([
      'd.id',
      'd.object_type_id',
      'o.key as object_key',
      'd.name',
      'd.is_system',
      'd.position',
      'd.created_at',
      // Archived fields keep their folder but aren't counted: the list leaves them out too.
      sql<number>`(
        select count(*)::int from crm.field_definitions f
        where f.business_id = d.business_id and f.folder_id = d.id and f.archived_at is null
      )`.as('field_count'),
    ]);
}

/** One folder of this business, or the error a folder that isn't there gets. */
async function requireFolder(
  trx: DatabaseTransaction,
  folderId: string,
  lock?: 'update' | 'share',
): Promise<FolderRow> {
  let query = folders(trx).where('d.id', '=', parsePublicId('field_folder', folderId) ?? '');
  if (lock === 'update') query = query.forUpdate('d');
  if (lock === 'share') query = query.forShare('d');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Field folder', folderId);
  return row;
}

/** Whether the folder exists in this business: what a route checks before reading a body. */
export async function fieldFolderExists(
  trx: DatabaseTransaction,
  folderId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('crm.field_folders')
    .select('id')
    .where('id', '=', parsePublicId('field_folder', folderId) ?? '')
    .executeTakeFirst();
  return row !== undefined;
}

/** A search as a LIKE pattern: the text anywhere, with its own % and _ taken literally. */
const containing = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/**
 * The business's folders by object, then in the order each object's are kept: every one
 * that matches, or a page of them when a limit is asked for. A page starts after a folder
 * by its own stored place in that order, so a folder made while someone pages is never
 * shown twice and never hides another.
 */
export async function readFieldFolders(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListFieldFoldersQuery = {},
): Promise<FieldFolderList> {
  requireBusiness(invocation.context);
  let matching = folders(trx);
  if (query.objectKey !== undefined) matching = matching.where('o.key', '=', query.objectKey);
  if (query.q !== undefined && query.q !== '')
    matching = matching.where(sql<SqlBool>`d.name ilike ${containing(query.q)}`);
  // Compared in PostgreSQL as written, so no part of the moment is rounded away.
  if (query.createdFrom !== undefined)
    matching = matching.where(sql<SqlBool>`d.created_at >= ${query.createdFrom}::timestamptz`);
  if (query.createdBefore !== undefined)
    matching = matching.where(sql<SqlBool>`d.created_at < ${query.createdBefore}::timestamptz`);

  const { total } = await matching
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();

  let page = matching;
  if (query.after !== undefined) {
    const anchor = parsePublicId('field_folder', query.after) ?? '';
    const known = await trx
      .selectFrom('crm.field_folders')
      .select('id')
      .where('id', '=', anchor)
      .executeTakeFirst();
    if (known === undefined)
      throw invalid('/after', 'unknown_folder', 'Start after a folder in this business.');
    page = page.where(
      sql<SqlBool>`(o.key, d.position, d.created_at, d.id) > (
        select ao.key, a.position, a.created_at, a.id
        from crm.field_folders a
        join crm.object_types ao on ao.business_id = a.business_id and ao.id = a.object_type_id
        where a.id = ${anchor})`,
    );
  }
  const ordered = page
    .orderBy('o.key')
    .orderBy('d.position')
    .orderBy('d.created_at')
    .orderBy('d.id');
  const rows = await (
    query.limit === undefined ? ordered : ordered.limit(query.limit + 1)
  ).execute();
  const shown = query.limit === undefined ? rows : rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown.map(asFolder),
    canManage: mayManage(invocation),
    total: Number(total),
    next:
      rows.length > shown.length && last !== undefined ? toPublicId('field_folder', last.id) : null,
  };
}

/** The object the folder commands act on, held so that its set of folders stays still. */
async function lockObject(trx: DatabaseTransaction, objectKey: string): Promise<string> {
  const object = await trx
    .selectFrom('crm.object_types')
    .select('id')
    .where('key', '=', objectKey)
    .where('archived_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (object === undefined)
    throw invalid('/objectKey', 'invalid_object', 'Choose an object in this business.');
  return object.id;
}

export const createFieldFolderCommand = defineCommand({
  name: 'field_folder.create',
  permission: 'fields.manage',
  input: createFieldFolderInput,
  async handle(trx, input, command): Promise<FieldFolder> {
    const businessId = requireBusiness(command.context);
    const objectTypeId = await lockObject(trx, input.objectKey);
    const existing = await trx
      .selectFrom('crm.field_folders')
      .select((eb) => [eb.fn.countAll<string>().as('folders'), eb.fn.max('position').as('last')])
      .where('object_type_id', '=', objectTypeId)
      .executeTakeFirstOrThrow();
    if (Number(existing.folders) >= FIELD_FOLDER_LIMITS.perObject)
      throw invalid(
        '/name',
        'limit_reached',
        `An object can have at most ${String(FIELD_FOLDER_LIMITS.perObject)} folders. Delete one first.`,
      );
    const row = await trx
      .insertInto('crm.field_folders')
      .values({
        business_id: businessId,
        object_type_id: objectTypeId,
        name: input.name,
        position: existing.last + 1,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'field_folder.created',
      subject: { kind: 'field_folder', id: row.id },
      payload: { objectKey: input.objectKey, name: input.name },
    });
    return asFolder(await requireFolder(trx, toPublicId('field_folder', row.id)));
  },
});

export const renameFieldFolderCommand = defineCommand({
  name: 'field_folder.rename',
  permission: 'fields.manage',
  input: renameFieldFolderInput.extend(renameFieldFolder.params.shape),
  async handle(trx, input, command): Promise<FieldFolder> {
    requireBusiness(command.context);
    // Two renames from one revision take turns here, so the second sees the first.
    const current = await requireFolder(trx, input.folderId, 'update');
    if (revisionOf(current) !== input.revision)
      throw new ConflictError(
        'This folder changed. Reload the saved version before renaming it again.',
      );
    if (current.is_system)
      throw invalid('/name', 'system_folder', 'A system folder keeps its name.');
    await trx
      .updateTable('crm.field_folders')
      .set({ name: input.name })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'field_folder.renamed',
      subject: { kind: 'field_folder', id: current.id },
      payload: { objectKey: current.object_key, name: input.name, previousName: current.name },
    });
    return asFolder({ ...current, name: input.name });
  },
});

export const reorderFieldFoldersCommand = defineCommand({
  name: 'field_folder.reorder',
  permission: 'fields.manage',
  input: reorderFieldFoldersInput,
  async handle(trx, input, command): Promise<FieldFolderList> {
    requireBusiness(command.context);
    const objectTypeId = await lockObject(trx, input.objectKey);
    const current = await trx
      .selectFrom('crm.field_folders')
      .select('id')
      .where('object_type_id', '=', objectTypeId)
      .orderBy('id')
      .forUpdate()
      .execute();
    const wanted = input.folderIds.map((id) => parsePublicId('field_folder', id) ?? '');
    const existing = new Set(current.map((row) => row.id));
    // An order made from a list that has since gained or lost a folder is not applied. A
    // folder of another object or business is the same answer: it isn't one of these.
    if (wanted.length !== existing.size || wanted.some((id) => !existing.has(id)))
      throw new ConflictError(
        'The folders of this object changed. Reload them before ordering them again.',
      );
    await sql`
      update crm.field_folders d
      set position = ordered.place - 1
      from unnest(${wanted}::uuid[]) with ordinality as ordered (id, place)
      where d.id = ordered.id and d.position is distinct from ordered.place - 1
    `.execute(trx);
    await command.emit({
      type: 'field_folder.reordered',
      subject: { kind: 'object_type', id: objectTypeId },
      payload: { objectKey: input.objectKey, folderIds: input.folderIds },
    });
    return readFieldFolders(trx, command, { objectKey: input.objectKey });
  },
});

export const deleteFieldFolderCommand = defineCommand({
  name: 'field_folder.delete',
  permission: 'fields.manage',
  input: deleteFieldFolder.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireFolder(trx, input.folderId, 'update');
    if (current.is_system)
      throw invalid('/folderId', 'system_folder', 'A system folder can’t be deleted.');
    const system = await systemFolderOf(trx, current.object_type_id);
    // Its fields are taken in id order, as a move takes them, so a delete and a move that
    // meet in the same fields queue up and never wait on each other.
    const moved = await trx
      .selectFrom('crm.field_definitions')
      .select('id')
      .where('folder_id', '=', current.id)
      .orderBy('id')
      .forUpdate()
      .execute();
    // No field, archived or not, and none of its values, goes with the folder. They
    // arrive after the system folder's own fields, in the order they had.
    if (moved.length > 0) {
      const base = (await lastPlaceIn(trx, system)) + 1;
      await sql`
        update crm.field_definitions f
        set folder_id = ${system}, position = ${base} + arriving.place
        from (
          select id, (row_number() over (order by position, id) - 1)::integer as place
          from crm.field_definitions
          where folder_id = ${current.id}
        ) arriving
        where f.id = arriving.id
      `.execute(trx);
    }
    await trx.deleteFrom('crm.field_folders').where('id', '=', current.id).execute();
    await command.emit({
      type: 'field_folder.deleted',
      subject: { kind: 'field_folder', id: current.id },
      payload: {
        objectKey: current.object_key,
        name: current.name,
        movedFields: moved.length,
        movedTo: toPublicId('field_folder', system),
      },
    });
  },
});

export const moveFieldsCommand = defineCommand({
  name: 'field.move',
  permission: 'fields.manage',
  input: moveFieldsInput.extend(moveFieldsToFolder.params.shape),
  async handle(trx, input, command): Promise<FieldFolder> {
    requireBusiness(command.context);
    // Held so the folder can't be deleted while fields are on their way into it.
    const target = await requireFolder(trx, input.folderId, 'share');
    const wanted = input.fieldIds.map((id) => parsePublicId('field', id) ?? '');
    const fields = await trx
      .selectFrom('crm.field_definitions')
      .select(['id', 'folder_id'])
      .where('id', 'in', wanted)
      .where('object_type_id', '=', target.object_type_id)
      .orderBy('id')
      .forUpdate()
      .execute();
    // All or none: a field of another object, or one that isn't this business's, moves nothing.
    if (fields.length !== wanted.length)
      throw invalid(
        '/fieldIds',
        'invalid_field',
        'Choose fields of this folder’s object in this business.',
      );
    const elsewhere = new Set(
      fields.filter((field) => field.folder_id !== target.id).map(({ id }) => id),
    );
    const moving = wanted.filter((id) => elsewhere.has(id));
    if (moving.length > 0) {
      // Last in the folder they arrive in, in the order they were named.
      const base = (await lastPlaceIn(trx, target.id)) + 1;
      await sql`
        update crm.field_definitions f
        set folder_id = ${target.id}, position = ${base} + arriving.place - 1
        from unnest(${moving}::uuid[]) with ordinality as arriving (id, place)
        where f.id = arriving.id
      `.execute(trx);
      await command.emit({
        type: 'field.moved',
        subject: { kind: 'field_folder', id: target.id },
        payload: {
          objectKey: target.object_key,
          folderName: target.name,
          fieldIds: moving.map((id) => toPublicId('field', id)),
        },
      });
    }
    return asFolder(await requireFolder(trx, input.folderId));
  },
});

export const reorderFolderFieldsCommand = defineCommand({
  name: 'field.reorder',
  permission: 'fields.manage',
  input: reorderFolderFieldsInput.extend(reorderFolderFields.params.shape),
  async handle(trx, input, command): Promise<FolderFieldOrder> {
    requireBusiness(command.context);
    // Held against moves into the folder, which take it shared: the set of fields ordered
    // here is the set that is there when the order is written.
    const folder = await requireFolder(trx, input.folderId, 'update');
    const current = await trx
      .selectFrom('crm.field_definitions')
      .select('id')
      .where('folder_id', '=', folder.id)
      .where('archived_at', 'is', null)
      .orderBy('id')
      .forUpdate()
      .execute();
    const wanted = input.fieldIds.map((id) => parsePublicId('field', id) ?? '');
    const existing = new Set(current.map((row) => row.id));
    // An order made from a list that has since gained or lost a field is not applied. A
    // field of another folder, object or business is the same answer: it isn't one of these.
    if (wanted.length !== existing.size || wanted.some((id) => !existing.has(id)))
      throw new ConflictError(
        'The fields of this folder changed. Reload them before ordering them again.',
      );
    await sql`
      update crm.field_definitions f
      set position = ordered.place - 1
      from unnest(${wanted}::uuid[]) with ordinality as ordered (id, place)
      where f.id = ordered.id and f.position is distinct from ordered.place - 1
    `.execute(trx);
    await command.emit({
      type: 'field.reordered',
      subject: { kind: 'field_folder', id: folder.id },
      payload: { objectKey: folder.object_key, folderName: folder.name, fieldIds: input.fieldIds },
    });
    return { folder: asFolder(folder), fieldIds: input.fieldIds };
  },
});
