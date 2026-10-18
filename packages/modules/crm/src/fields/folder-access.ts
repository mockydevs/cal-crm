// Which folder a field goes in: one of its own object's, or the object's system folder when
// none is named. The database holds the same rule (field_definitions_folder_fkey); this
// says it in words before the transaction ends.
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, ValidationError } from '@repo/kernel';

/** A folder held for the rest of the transaction, so it can't be deleted under a writer. */
export interface HeldFolder {
  readonly id: string;
  readonly objectTypeId: string;
}

/** The object's system folder: every object type has exactly one, made with it. */
export async function systemFolderOf(
  trx: DatabaseTransaction,
  objectTypeId: string,
): Promise<string> {
  const folder = await trx
    .selectFrom('crm.field_folders')
    .select('id')
    .where('object_type_id', '=', objectTypeId)
    .where('is_system', '=', true)
    .executeTakeFirstOrThrow();
  return folder.id;
}

/**
 * Holds the folder named, if this business has it. A writer that also changes a field
 * takes the folder first: deleting a folder holds it and then moves its fields, so taking
 * them the other way round could leave the two waiting on each other.
 */
export async function holdFolder(
  trx: DatabaseTransaction,
  folderId: string,
): Promise<HeldFolder | undefined> {
  const folder = await trx
    .selectFrom('crm.field_folders')
    .select(['id', 'object_type_id'])
    .where('id', '=', parsePublicId('field_folder', folderId) ?? '')
    .forShare()
    .executeTakeFirst();
  return folder === undefined ? undefined : { id: folder.id, objectTypeId: folder.object_type_id };
}

/**
 * The held folder's id, when it is one a field of this object may be put in. A folder of
 * another object, or of another business, is refused as one that isn't there.
 */
export function folderOfObject(folder: HeldFolder | undefined, objectTypeId: string): string {
  if (folder?.objectTypeId !== objectTypeId)
    throw new ValidationError([
      {
        path: '/folderId',
        code: 'invalid_folder',
        message: 'Choose a folder of this object in this business.',
      },
    ]);
  return folder.id;
}

/**
 * The place of the folder's last field, archived ones counted, or -1 for a folder with
 * none: a field that arrives takes the place after it. Two fields arriving at the same
 * moment may be given the same place; every reader orders by place and then by id, so
 * both still come after everything that was there.
 */
export async function lastPlaceIn(trx: DatabaseTransaction, folderId: string): Promise<number> {
  const { last } = await trx
    .selectFrom('crm.field_definitions')
    .select((eb) => eb.fn.max<number | null>('position').as('last'))
    .where('folder_id', '=', folderId)
    .executeTakeFirstOrThrow();
  return last ?? -1;
}
