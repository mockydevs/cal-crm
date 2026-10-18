import { parseRecordId, type RecordKind } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError } from '@repo/kernel';

const recordTables = {
  contact: 'crm.contacts',
  company: 'crm.companies',
  deal: 'crm.deals',
} as const satisfies Record<RecordKind, string>;

/** A visible registry record and its owning entity. Optional locks coordinate writes with trash. */
export async function requireRecord(
  trx: DatabaseTransaction,
  id: string,
  lock = false,
): Promise<{ id: string; kind: RecordKind; objectTypeId: string; trashed: boolean }> {
  const record = parseRecordId(id);
  if (record === undefined) throw new NotFoundError('Record', id);
  let registry = trx
    .selectFrom('crm.records')
    .select(['id', 'object_type_id'])
    .where('id', '=', record.id)
    .where('kind', '=', record.kind);
  // Keep purge out while allowing an entity-first writer's foreign-key KEY SHARE lock.
  if (lock) registry = registry.forNoKeyUpdate();
  const registered = await registry.executeTakeFirst();
  if (registered === undefined) throw new NotFoundError('Record', id);
  let entity = trx
    .selectFrom(recordTables[record.kind])
    .select('deleted_at')
    .where('id', '=', record.id);
  // Trash commands lock their owning entity row, rather than the registry. FOR NO KEY
  // UPDATE still makes two changes to one record wait, and leaves the row free for the
  // foreign keys of rows written beside it (a reply's message names the contact), which a
  // writer holding other rows takes in the other order.
  if (lock) entity = entity.forNoKeyUpdate();
  const row = await entity.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Record', id);
  if (lock && row.deleted_at !== null)
    throw new ConflictError('Restore this record before changing it.');
  return { ...record, objectTypeId: registered.object_type_id, trashed: row.deleted_at !== null };
}
