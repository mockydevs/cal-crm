// Folders for custom values. They are not nested, a value is in at most one, and deleting a
// folder leaves its values where they were, in no folder (the database's "on delete set
// null").
import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  CUSTOM_VALUE_LIMITS,
  createCustomValueFolderInput,
  deleteCustomValueFolder,
  renameCustomValueFolder,
  renameCustomValueFolderInput,
  type CustomValueFolder,
  type CustomValueFolderList,
  type ListCustomValueFoldersQuery,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';
import {
  containing,
  decodeCursor,
  encodeCursor,
  invalid,
  mayManageCustomValues,
  serializeAdditions,
} from './custom-values.js';

const uniqueErrors = explainUniqueViolation({
  custom_value_folders_name_unique_idx: () =>
    invalid('/name', 'taken', 'A folder with this name already exists.'),
});

interface FolderRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly value_count: number;
}

const revisionOf = (row: Pick<FolderRow, 'id' | 'name'>): string =>
  createHash('sha256')
    .update(JSON.stringify([row.id, row.name]))
    .digest('hex');

function asFolder(row: FolderRow): CustomValueFolder {
  return {
    id: toPublicId('custom_value_folder', row.id),
    name: row.name,
    valueCount: row.value_count,
    createdAt: row.created_at.toISOString(),
    revision: revisionOf(row),
  };
}

function folders(trx: DatabaseTransaction) {
  return trx.selectFrom('crm.custom_value_folders as d').select([
    'd.id',
    'd.name',
    'd.created_at',
    sql<number>`(
        select count(*)::int from crm.custom_values v
        where v.business_id = d.business_id and v.folder_id = d.id
      )`.as('value_count'),
  ]);
}

async function requireFolder(
  trx: DatabaseTransaction,
  folderId: string,
  lock = false,
): Promise<FolderRow> {
  let query = folders(trx).where('d.id', '=', parsePublicId('custom_value_folder', folderId) ?? '');
  if (lock) query = query.forUpdate('d');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Custom value folder', folderId);
  return row;
}

/** Whether the folder exists in this business: what a route checks before reading a body. */
export async function customValueFolderExists(
  trx: DatabaseTransaction,
  folderId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('crm.custom_value_folders')
    .select('id')
    .where('id', '=', parsePublicId('custom_value_folder', folderId) ?? '')
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The business's folders by name, each with how many values it holds: every one that
 * matches, or a page of them when a limit is asked for. A page starts after the name and id
 * the last one ended on, so it keeps its place when that folder is renamed or deleted
 * meanwhile.
 */
export async function readCustomValueFolders(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListCustomValueFoldersQuery = {},
): Promise<CustomValueFolderList> {
  requireBusiness(invocation.context);
  const sortName = sql<string>`lower(btrim(d.name))`;
  let matching = folders(trx);
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
  let page = matching.select(sortName.as('sort_name'));
  if (query.after !== undefined) {
    const [afterName, afterId] = decodeCursor(query.after);
    page = page.where(sql<SqlBool>`(${sortName}, d.id) > (${afterName}, ${afterId}::uuid)`);
  }
  const ordered = page.orderBy(sortName).orderBy('d.id');
  const rows = await (
    query.limit === undefined ? ordered : ordered.limit(query.limit + 1)
  ).execute();
  const shown = query.limit === undefined ? rows : rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown.map(asFolder),
    canManage: mayManageCustomValues(invocation),
    total: Number(total),
    next:
      rows.length > shown.length && last !== undefined
        ? encodeCursor(last.sort_name, last.id)
        : null,
  };
}

export const createCustomValueFolderCommand = defineCommand({
  name: 'custom_value_folder.create',
  permission: 'templates.manage',
  input: createCustomValueFolderInput,
  async handle(trx, input, command): Promise<CustomValueFolder> {
    const businessId = requireBusiness(command.context);
    await serializeAdditions(trx, businessId, 'folders');
    const { count } = await trx
      .selectFrom('crm.custom_value_folders')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(count) >= CUSTOM_VALUE_LIMITS.folders)
      throw invalid(
        '/name',
        'limit_reached',
        `A business can have at most ${String(CUSTOM_VALUE_LIMITS.folders)} custom value folders. Delete one first.`,
      );
    const row = await trx
      .insertInto('crm.custom_value_folders')
      .values({
        business_id: businessId,
        name: input.name,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning(['id', 'name', 'created_at'])
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'custom_value_folder.created',
      subject: { kind: 'custom_value_folder', id: row.id },
      payload: { name: row.name },
    });
    return asFolder({ ...row, value_count: 0 });
  },
});

export const renameCustomValueFolderCommand = defineCommand({
  name: 'custom_value_folder.rename',
  permission: 'templates.manage',
  input: renameCustomValueFolderInput.extend(renameCustomValueFolder.params.shape),
  async handle(trx, input, command): Promise<CustomValueFolder> {
    requireBusiness(command.context);
    // Two renames from one revision take turns here, so the second sees the first.
    const current = await requireFolder(trx, input.folderId, true);
    if (revisionOf(current) !== input.revision)
      throw new ConflictError(
        'This folder changed. Reload the saved version before renaming it again.',
      );
    await trx
      .updateTable('crm.custom_value_folders')
      .set({ name: input.name })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'custom_value_folder.renamed',
      subject: { kind: 'custom_value_folder', id: current.id },
      payload: { name: input.name, previousName: current.name },
    });
    return asFolder({ ...current, name: input.name });
  },
});

export const deleteCustomValueFolderCommand = defineCommand({
  name: 'custom_value_folder.delete',
  permission: 'templates.manage',
  input: deleteCustomValueFolder.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireFolder(trx, input.folderId, true);
    // Its values are taken in id order, as a move takes them, so a delete and a move that
    // meet in the same values queue up and never wait on each other.
    const inside = await trx
      .selectFrom('crm.custom_values')
      .select('id')
      .where('folder_id', '=', current.id)
      .orderBy('id')
      .forUpdate()
      .execute();
    // They stay: the foreign key takes them out of the folder as it goes.
    await trx.deleteFrom('crm.custom_value_folders').where('id', '=', current.id).execute();
    await command.emit({
      type: 'custom_value_folder.deleted',
      subject: { kind: 'custom_value_folder', id: current.id },
      payload: { name: current.name, valuesLeftWithoutFolder: inside.length },
    });
  },
});
