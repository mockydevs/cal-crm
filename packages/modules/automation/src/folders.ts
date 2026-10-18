// Folders for automations: they nest, an automation is in one folder or at the top level,
// and deleting a folder moves what was in it up one level and deletes nothing else. Every
// change to the tree takes one lock for the business first, so the checks it makes (a free
// name, no folder inside itself, the depth) still hold when it writes; two people's changes
// take turns instead of crossing.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  AUTOMATION_FOLDER_LIMIT,
  AUTOMATION_FOLDER_MAX_DEPTH,
  createAutomationFolderInput,
  moveAutomationInput,
  updateAutomationFolderInput,
  type Automation,
  type AutomationFolder,
  type AutomationFolderList,
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

import { readAutomation } from './drafts.js';

interface FolderRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const columns = ['id', 'parent_id', 'name', 'revision', 'created_at', 'updated_at'] as const;

const present = (row: FolderRow, automationCount: number): AutomationFolder => ({
  id: toPublicId('automation_folder', row.id),
  parentId: row.parent_id === null ? null : toPublicId('automation_folder', row.parent_id),
  name: row.name,
  revision: row.revision,
  automationCount,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** Every folder of the business, by name, each with how many automations are in it. */
export async function readFolders(
  trx: DatabaseTransaction,
): Promise<Pick<AutomationFolderList, 'items'>> {
  const rows = await trx
    .selectFrom('automation.folders as folder')
    .select(columns.map((column) => `folder.${column}` as const))
    .select((eb) =>
      eb
        .selectFrom('automation.automations as automation')
        .select((inner) => inner.fn.countAll<string>().as('count'))
        .whereRef('automation.folder_id', '=', 'folder.id')
        .as('automations'),
    )
    .orderBy(sql`lower(folder.name)`)
    .orderBy('folder.id')
    .execute();
  return { items: rows.map((row) => present(row, Number(row.automations ?? 0))) };
}

async function readFolder(trx: DatabaseTransaction, id: string): Promise<AutomationFolder> {
  const { items } = await readFolders(trx);
  const found = items.find((folder) => folder.id === toPublicId('automation_folder', id));
  if (found === undefined) throw new NotFoundError('automation_folder', id);
  return found;
}

/** The business's folders as they are, read under the tree's lock. */
interface Tree {
  readonly rows: readonly FolderRow[];
  /** How deep a folder is: 1 at the top level. */
  depthOf(id: string | null): number;
  /** How many levels a folder holds, itself included. */
  heightOf(id: string): number;
  /** Whether a folder is another, or somewhere inside it. */
  isWithin(id: string, ancestor: string): boolean;
  /** Whether a name is taken in a place, by any folder but one. */
  nameTaken(parentId: string | null, name: string, except?: string): boolean;
}

// One lock per business for its folder tree, held to the end of the transaction, and then
// the tree as it stands. Small by its limit, so it is read whole and reasoned about here.
async function lockTree(trx: DatabaseTransaction, businessId: string): Promise<Tree> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`automation-folders:${businessId}`}, 0))`.execute(
    trx,
  );
  const rows = await trx.selectFrom('automation.folders').select(columns).execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depthOf = (id: string | null): number => {
    let depth = 0;
    // Bounded by the number of folders, should a row ever be made its own ancestor.
    for (let at = id, steps = 0; at !== null && steps <= rows.length; steps += 1) {
      depth += 1;
      at = byId.get(at)?.parent_id ?? null;
    }
    return depth;
  };
  const isWithin = (id: string, ancestor: string): boolean => {
    for (let at: string | null = id, steps = 0; at !== null && steps <= rows.length; steps += 1) {
      if (at === ancestor) return true;
      at = byId.get(at)?.parent_id ?? null;
    }
    return false;
  };
  return {
    rows,
    depthOf,
    isWithin,
    heightOf: (id) =>
      Math.max(...rows.filter((row) => isWithin(row.id, id)).map((row) => depthOf(row.id))) -
      depthOf(id) +
      1,
    nameTaken: (parentId, name, except) =>
      rows.some(
        (row) =>
          row.id !== except &&
          row.parent_id === parentId &&
          row.name.toLowerCase() === name.toLowerCase(),
      ),
  };
}

const taken = (name: string) =>
  new ConflictError(`A folder named “${name}” is already there. Folder names differ in one place.`);

const tooDeep = () =>
  new ValidationError([
    {
      path: '/parentId',
      code: 'folder_too_deep',
      message: `Folders nest at most ${String(AUTOMATION_FOLDER_MAX_DEPTH)} deep.`,
    },
  ]);

// The folder a change names as the new place, or null for the top level; a 404 when it
// isn't one of this business's.
function placeOf(tree: Tree, given: string | null): string | null {
  if (given === null) return null;
  const id = parsePublicId('automation_folder', given);
  if (id === undefined || !tree.rows.some((row) => row.id === id))
    throw new NotFoundError('automation_folder', given);
  return id;
}

const updateInput = updateAutomationFolderInput.extend({ id: z.string() });
const idInput = z.strictObject({ id: z.string() });
const moveInput = moveAutomationInput.extend({ id: z.string() });

export interface FolderCommands {
  readonly create: Command<typeof createAutomationFolderInput, AutomationFolder>;
  readonly update: Command<typeof updateInput, AutomationFolder>;
  readonly remove: Command<typeof idInput, undefined>;
  readonly moveAutomation: Command<typeof moveInput, Automation>;
}

/** The folder commands, and moving an automation between folders. */
export function createFolderCommands(): FolderCommands {
  const create = defineCommand({
    name: 'automation.create_folder',
    permission: 'automations.manage',
    input: createAutomationFolderInput,
    async handle(trx, input, command): Promise<AutomationFolder> {
      const businessId = requireBusiness(command.context);
      const tree = await lockTree(trx, businessId);
      if (tree.rows.length >= AUTOMATION_FOLDER_LIMIT)
        throw new ConflictError(
          `A business keeps at most ${String(AUTOMATION_FOLDER_LIMIT)} automation folders. Delete one first.`,
        );
      const parentId = placeOf(tree, input.parentId);
      if (tree.depthOf(parentId) + 1 > AUTOMATION_FOLDER_MAX_DEPTH) throw tooDeep();
      if (tree.nameTaken(parentId, input.name)) throw taken(input.name);
      const { id } = await trx
        .insertInto('automation.folders')
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
        type: 'automation.folder_created',
        subject: { kind: 'automation_folder', id },
        records: [],
        payload: {},
      });
      return readFolder(trx, id);
    },
  });

  const update = defineCommand({
    name: 'automation.update_folder',
    permission: 'automations.manage',
    input: updateInput,
    async handle(trx, input, command): Promise<AutomationFolder> {
      const businessId = requireBusiness(command.context);
      const tree = await lockTree(trx, businessId);
      const id = parsePublicId('automation_folder', input.id);
      const folder = tree.rows.find((row) => row.id === id);
      if (folder === undefined) throw new NotFoundError('automation_folder', input.id);
      if (folder.revision !== input.revision)
        throw new ConflictError(
          `The folder is at revision ${String(folder.revision)}, not ${String(input.revision)}: someone changed it since. Read it again and reapply your change.`,
        );
      if (input.name === undefined && input.parentId === undefined)
        throw new ValidationError([
          {
            path: '',
            code: 'nothing_to_change',
            message: 'Give a new name, a new place, or both.',
          },
        ]);
      const name = input.name ?? folder.name;
      const parentId =
        input.parentId === undefined ? folder.parent_id : placeOf(tree, input.parentId);
      const moved = parentId !== folder.parent_id;
      if (moved && parentId !== null) {
        if (tree.isWithin(parentId, folder.id))
          throw new ValidationError([
            {
              path: '/parentId',
              code: 'folder_inside_itself',
              message: "A folder can't be moved into itself or a folder inside it.",
            },
          ]);
        if (tree.depthOf(parentId) + tree.heightOf(folder.id) > AUTOMATION_FOLDER_MAX_DEPTH)
          throw tooDeep();
      }
      const renamed = name !== folder.name;
      if ((moved || renamed) && tree.nameTaken(parentId, name, folder.id)) throw taken(name);
      // Saved as it already is, it changes nothing and says nothing.
      if (!moved && !renamed) return readFolder(trx, folder.id);
      await trx
        .updateTable('automation.folders')
        .set({ name, parent_id: parentId, revision: folder.revision + 1 })
        .where('id', '=', folder.id)
        .execute();
      await command.emit({
        type: 'automation.folder_updated',
        subject: { kind: 'automation_folder', id: folder.id },
        records: [],
        payload: { renamed, moved },
      });
      return readFolder(trx, folder.id);
    },
  });

  const remove = defineCommand({
    name: 'automation.delete_folder',
    permission: 'automations.manage',
    input: idInput,
    async handle(trx, input, command): Promise<undefined> {
      const businessId = requireBusiness(command.context);
      const tree = await lockTree(trx, businessId);
      const id = parsePublicId('automation_folder', input.id);
      const folder = tree.rows.find((row) => row.id === id);
      if (folder === undefined) throw new NotFoundError('automation_folder', input.id);
      // What is in it moves up one level, to where the folder itself was. A folder that
      // would meet its own name there stays put: nothing is renamed without being asked.
      const inside = tree.rows.filter((row) => row.parent_id === folder.id);
      const clash = inside.find((row) => tree.nameTaken(folder.parent_id, row.name, folder.id));
      if (clash !== undefined)
        throw new ConflictError(
          `It holds a folder named “${clash.name}”, and one of that name is already a level up. Rename one of them first.`,
        );
      // A folder inside it may carry its name, and is about to stand where it stood: the
      // folder gives its name up first, taking its own id for the moment it has left.
      await trx
        .updateTable('automation.folders')
        .set({ name: folder.id })
        .where('id', '=', folder.id)
        .execute();
      await trx
        .updateTable('automation.folders')
        .set({ parent_id: folder.parent_id, revision: sql<number>`revision + 1` })
        .where('parent_id', '=', folder.id)
        .execute();
      const automations = await trx
        .updateTable('automation.automations')
        .set({ folder_id: folder.parent_id })
        .where('folder_id', '=', folder.id)
        .returning('id')
        .execute();
      await trx.deleteFrom('automation.folders').where('id', '=', folder.id).execute();
      await command.emit({
        type: 'automation.folder_deleted',
        subject: { kind: 'automation_folder', id: folder.id },
        records: [],
        payload: { movedFolders: inside.length, movedAutomations: automations.length },
      });
      return undefined;
    },
  });

  const moveAutomation = defineCommand({
    name: 'automation.move',
    permission: 'automations.manage',
    input: moveInput,
    async handle(trx, input, command): Promise<Automation> {
      const businessId = requireBusiness(command.context);
      // The same lock a folder's delete takes, so the folder named here is still there when
      // the automation is put in it.
      const tree = await lockTree(trx, businessId);
      const folderId = placeOf(tree, input.folderId);
      const id = parsePublicId('automation', input.id);
      const automation =
        id === undefined
          ? undefined
          : await trx
              .selectFrom('automation.automations')
              .select(['id', 'folder_id'])
              .where('id', '=', id)
              // A deleted automation is in no folder until it is restored.
              .where('status', '<>', 'archived')
              .forNoKeyUpdate()
              .executeTakeFirst();
      if (automation === undefined) throw new NotFoundError('automation', input.id);
      if (automation.folder_id !== folderId) {
        await trx
          .updateTable('automation.automations')
          .set({ folder_id: folderId })
          .where('id', '=', automation.id)
          .execute();
        await command.emit({
          type: 'automation.moved',
          subject: { kind: 'automation', id: automation.id },
          records: [],
          payload: {
            folderId: folderId === null ? null : toPublicId('automation_folder', folderId),
          },
        });
      }
      return readAutomation(trx, input.id);
    },
  });

  return { create, update, remove, moveAutomation };
}
