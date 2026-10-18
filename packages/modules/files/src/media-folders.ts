// The media library's folders, shaped like the message template folders: a bounded tree,
// sibling names unique without regard to case, and one lock for every change to the tree or
// to where a file sits in it.
import { defineCommand, requireBusiness, type Command, type Invocation } from '@repo/commands';
import {
  createMediaFolderInput,
  MEDIA_FOLDER_LIMIT,
  MEDIA_FOLDER_MAX_DEPTH,
  publicId,
  updateMediaFolderInput,
  type MediaFolder,
  type MediaFolderList,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

interface FolderRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly name_normalized: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const columns = ['id', 'parent_id', 'name', 'name_normalized', 'created_at', 'updated_at'] as const;

const updateInput = updateMediaFolderInput.safeExtend({ id: publicId('media_folder') });
const removeInput = z.strictObject({ id: publicId('media_folder') });

const present = (row: FolderRow, files: number): MediaFolder => ({
  id: toPublicId('media_folder', row.id),
  parentId: row.parent_id === null ? null : toPublicId('media_folder', row.parent_id),
  name: row.name,
  fileCount: files,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** Whether the invocation's role may change the library. */
export const canManageMedia = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('media.manage');

/** Every folder of the business, by name, with the live library files directly in each. */
export async function readMediaFolders(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<MediaFolderList> {
  requireBusiness(invocation.context);
  const rows = await trx
    .selectFrom('files.folders as folder')
    .select(columns.map((column) => `folder.${column}` as const))
    .select((eb) =>
      eb
        .selectFrom('files.files as file')
        .select((inner) => inner.fn.countAll<string>().as('count'))
        .whereRef('file.folder_id', '=', 'folder.id')
        .where('file.library', '=', true)
        .where('file.deleted_at', 'is', null)
        .as('files'),
    )
    .orderBy('folder.name_normalized')
    .orderBy('folder.id')
    .limit(MEDIA_FOLDER_LIMIT)
    .execute();
  return {
    canManage: canManageMedia(invocation),
    items: rows.map((row) => present(row, Number(row.files ?? 0))),
  };
}

interface Tree {
  readonly rows: readonly FolderRow[];
  readonly byId: ReadonlyMap<string, FolderRow>;
  depth(id: string | null): number;
  within(id: string, ancestor: string): boolean;
  height(id: string): number;
  nameTaken(parent: string | null, normalizedName: string, except?: string): boolean;
}

/**
 * Taken by everything that changes the tree or puts a file in a folder, so a folder can't
 * be removed while a file moves into it.
 */
export async function lockMediaFolders(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`media-folders:${businessId}`}, 0))`.execute(
    trx,
  );
}

const tooDeep = () =>
  new ValidationError([
    {
      path: '/parentId',
      code: 'folder_too_deep',
      message: `Folders nest at most ${String(MEDIA_FOLDER_MAX_DEPTH)} levels deep.`,
    },
  ]);

const taken = () => new ConflictError('A folder with that name already exists there.');

async function lockTree(trx: DatabaseTransaction, businessId: string): Promise<Tree> {
  await lockMediaFolders(trx, businessId);
  const rows = await trx.selectFrom('files.folders').select(columns).execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parentOf = (id: string) => byId.get(id)?.parent_id ?? null;
  const depth = (id: string | null) => {
    let count = 0;
    // The database refuses a folder as its own parent, and every move is checked for a
    // cycle under this lock, so the walk ends; the bound is for a tree changed by hand.
    for (let at = id; at !== null && count <= MEDIA_FOLDER_LIMIT; at = parentOf(at)) count += 1;
    return count;
  };
  const within = (id: string, ancestor: string) => {
    let steps = 0;
    for (
      let at: string | null = id;
      at !== null && steps <= MEDIA_FOLDER_LIMIT;
      at = parentOf(at)
    ) {
      if (at === ancestor) return true;
      steps += 1;
    }
    return false;
  };
  return {
    rows,
    byId,
    depth,
    within,
    height: (id) =>
      Math.max(...rows.filter((row) => within(row.id, id)).map((row) => depth(row.id))) -
      depth(id) +
      1,
    nameTaken: (parent, normalizedName, except) =>
      rows.some(
        (row) =>
          row.id !== except && row.parent_id === parent && row.name_normalized === normalizedName,
      ),
  };
}

/** The name as the database compares it, so the check here and the constraint agree. */
async function normalizeName(trx: DatabaseTransaction, name: string): Promise<string> {
  const { normalized } = await trx
    .selectNoFrom(sql<string>`lower(btrim(${name}))`.as('normalized'))
    .executeTakeFirstOrThrow();
  return normalized;
}

/** The folder's own id, when the business has it. */
function place(tree: Tree, given: string | null): string | null {
  if (given === null) return null;
  const id = parsePublicId('media_folder', given);
  if (id === undefined || !tree.byId.has(id)) throw new NotFoundError('Media folder', given);
  return id;
}

/**
 * The folder a file is put in, checked under the tree's lock: undefined ids and folders of
 * another business are both "not found", since row-level security shows neither.
 */
export async function lockedFolder(
  trx: DatabaseTransaction,
  businessId: string,
  given: string | null,
): Promise<string | null> {
  await lockMediaFolders(trx, businessId);
  if (given === null) return null;
  const id = parsePublicId('media_folder', given);
  const found =
    id === undefined
      ? undefined
      : await trx.selectFrom('files.folders').select('id').where('id', '=', id).executeTakeFirst();
  if (found === undefined) throw new NotFoundError('Media folder', given);
  return found.id;
}

async function readFolder(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
): Promise<MediaFolder> {
  const publicFolderId = toPublicId('media_folder', id);
  const folder = (await readMediaFolders(trx, invocation)).items.find(
    (item) => item.id === publicFolderId,
  );
  if (folder === undefined) throw new NotFoundError('Media folder', publicFolderId);
  return folder;
}

export interface MediaFolderCommands {
  readonly create: Command<typeof createMediaFolderInput, MediaFolder>;
  readonly update: Command<typeof updateInput, MediaFolder>;
  readonly remove: Command<typeof removeInput, undefined>;
}

export function createMediaFolderCommands(): MediaFolderCommands {
  const create = defineCommand({
    name: 'media.create_folder',
    permission: 'media.manage',
    input: createMediaFolderInput,
    async handle(trx, input, command): Promise<MediaFolder> {
      const businessId = requireBusiness(command.context);
      const tree = await lockTree(trx, businessId);
      if (tree.rows.length >= MEDIA_FOLDER_LIMIT)
        throw new ConflictError(
          `A business keeps at most ${String(MEDIA_FOLDER_LIMIT)} media folders.`,
        );
      const parentId = place(tree, input.parentId);
      if (tree.depth(parentId) + 1 > MEDIA_FOLDER_MAX_DEPTH) throw tooDeep();
      if (tree.nameTaken(parentId, await normalizeName(trx, input.name))) throw taken();
      const { id } = await trx
        .insertInto('files.folders')
        .values({
          business_id: businessId,
          parent_id: parentId,
          name: input.name,
          created_by_kind: command.context.actorKind,
          created_by_id: command.context.actorId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'media.folder_created',
        subject: { kind: 'media_folder', id },
        payload: { name: input.name },
      });
      return readFolder(trx, command, id);
    },
  });

  const update = defineCommand({
    name: 'media.update_folder',
    permission: 'media.manage',
    input: updateInput,
    async handle(trx, input, command): Promise<MediaFolder> {
      const tree = await lockTree(trx, requireBusiness(command.context));
      const id = place(tree, input.id);
      const folder = id === null ? undefined : tree.byId.get(id);
      if (folder === undefined) throw new NotFoundError('Media folder', input.id);
      const parentId =
        input.parentId === undefined ? folder.parent_id : place(tree, input.parentId);
      const name = input.name ?? folder.name;
      if (parentId !== null && tree.within(parentId, folder.id))
        throw new ValidationError([
          {
            path: '/parentId',
            code: 'folder_inside_itself',
            message: "A folder can't move into itself or a folder inside it.",
          },
        ]);
      if (tree.depth(parentId) + tree.height(folder.id) > MEDIA_FOLDER_MAX_DEPTH) throw tooDeep();
      if (tree.nameTaken(parentId, await normalizeName(trx, name), folder.id)) throw taken();
      const moved = parentId !== folder.parent_id;
      const renamed = name !== folder.name;
      if (!moved && !renamed) return readFolder(trx, command, folder.id);
      await trx
        .updateTable('files.folders')
        .set({ parent_id: parentId, name })
        .where('id', '=', folder.id)
        .execute();
      await command.emit({
        type: 'media.folder_updated',
        subject: { kind: 'media_folder', id: folder.id },
        payload: { moved, renamed },
      });
      return readFolder(trx, command, folder.id);
    },
  });

  const remove = defineCommand({
    name: 'media.remove_folder',
    permission: 'media.manage',
    input: removeInput,
    async handle(trx, input, command): Promise<undefined> {
      const tree = await lockTree(trx, requireBusiness(command.context));
      const id = place(tree, input.id);
      const folder = id === null ? undefined : tree.byId.get(id);
      if (folder === undefined) throw new NotFoundError('Media folder', input.id);
      const children = tree.rows.filter((row) => row.parent_id === folder.id);
      if (
        children.some(
          (child) =>
            child.name_normalized !== null &&
            tree.nameTaken(folder.parent_id, child.name_normalized, folder.id),
        )
      )
        throw taken();
      // A folder inside may have the removed folder's own name: names are checked once the
      // folder has gone, in this locked transaction.
      await sql`set constraints files.folders_name_unique deferred`.execute(trx);
      await trx
        .updateTable('files.folders')
        .set({ parent_id: folder.parent_id })
        .where('parent_id', '=', folder.id)
        .execute();
      const files = await trx
        .updateTable('files.files')
        .set({ folder_id: folder.parent_id })
        .where('folder_id', '=', folder.id)
        .executeTakeFirst();
      await trx.deleteFrom('files.folders').where('id', '=', folder.id).execute();
      await sql`set constraints files.folders_name_unique immediate`.execute(trx);
      await command.emit({
        type: 'media.folder_removed',
        subject: { kind: 'media_folder', id: folder.id },
        payload: {
          name: folder.name,
          movedFolders: children.length,
          movedFiles: Number(files.numUpdatedRows),
        },
      });
      return undefined;
    },
  });

  return { create, update, remove };
}
