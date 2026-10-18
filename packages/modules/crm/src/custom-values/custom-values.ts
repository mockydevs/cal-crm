// Custom values: text a business writes once and messages fill in as
// {{custom_values.<key>}}. A value's key is made when it is created and never changes, so
// renaming a value breaks nothing that uses it. A value is in at most one folder.
//
// Lock order: a folder before a value. Deleting a folder holds the folder and then takes
// its values out of it, so a writer that needs both takes the folder first.
import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  CUSTOM_VALUE_LIMITS,
  createCustomValueInput,
  customValueMergeKey,
  deleteCustomValue,
  mergeKeyFromName,
  deleteCustomValuesInput,
  moveCustomValuesInput,
  updateCustomValue,
  updateCustomValueInput,
  type CustomValue,
  type CustomValueList,
  type ListCustomValuesQuery,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  isUuidV7,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';

export const invalid = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path, code, message }]);

const uniqueErrors = explainUniqueViolation({
  custom_values_key_unique: () =>
    invalid('/key', 'taken', 'This key already belongs to a custom value.'),
  custom_values_name_unique_idx: () =>
    invalid('/name', 'taken', 'A custom value with this name already exists.'),
});

/** May create, change, move and delete custom values: they are what templates send. */
export const mayManageCustomValues = (invocation: Invocation): boolean =>
  invocation.permissions === 'all' || invocation.permissions.has('templates.manage');

interface ValueRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly value: string;
  readonly folder_id: string | null;
  readonly folder_name: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

// Everything a save can change. The key is not in it: no save changes a key.
const revisionOf = (row: Pick<ValueRow, 'id' | 'name' | 'value' | 'folder_id'>): string =>
  createHash('sha256')
    .update(JSON.stringify([row.id, row.name, row.value, row.folder_id]))
    .digest('hex');

function asValue(row: ValueRow): CustomValue {
  return {
    id: toPublicId('custom_value', row.id),
    key: row.key,
    mergeKey: customValueMergeKey(row.key),
    name: row.name,
    value: row.value,
    folderId: row.folder_id === null ? null : toPublicId('custom_value_folder', row.folder_id),
    folderName: row.folder_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revision: revisionOf(row),
  };
}

function values(trx: DatabaseTransaction) {
  return trx
    .selectFrom('crm.custom_values as v')
    .leftJoin('crm.custom_value_folders as d', (join) =>
      join.onRef('d.business_id', '=', 'v.business_id').onRef('d.id', '=', 'v.folder_id'),
    )
    .select([
      'v.id',
      'v.key',
      'v.name',
      'v.value',
      'v.folder_id',
      'd.name as folder_name',
      'v.created_at',
      'v.updated_at',
    ]);
}

async function requireValue(
  trx: DatabaseTransaction,
  valueId: string,
  lock = false,
): Promise<ValueRow> {
  let query = values(trx).where('v.id', '=', parsePublicId('custom_value', valueId) ?? '');
  // Two saves from one revision take turns here, so the second sees the first.
  if (lock) query = query.forUpdate('v');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Custom value', valueId);
  return row;
}

/** Whether the value exists in this business: what a route checks before reading a body. */
export async function customValueExists(
  trx: DatabaseTransaction,
  valueId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('crm.custom_values')
    .select('id')
    .where('id', '=', parsePublicId('custom_value', valueId) ?? '')
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Holds the folder a value is to go in, so it can't be deleted on the way. Null is no
 * folder; undefined is a folder this business doesn't have.
 */
async function holdFolder(
  trx: DatabaseTransaction,
  folderId: string | null,
): Promise<string | null | undefined> {
  if (folderId === null) return null;
  const folder = await trx
    .selectFrom('crm.custom_value_folders')
    .select('id')
    .where('id', '=', parsePublicId('custom_value_folder', folderId) ?? '')
    .forShare()
    .executeTakeFirst();
  return folder?.id;
}

/** The held folder, or the refusal a folder that isn't there gets. */
function heldFolder(folder: string | null | undefined): string | null {
  if (folder === undefined)
    throw invalid('/folderId', 'invalid_folder', 'Choose a folder in this business.');
  return folder;
}

/**
 * One writer at a time adds to a business's custom values (or to their folders), so the
 * count it reads and the key it picks are still true when it inserts.
 */
export async function serializeAdditions(
  trx: DatabaseTransaction,
  businessId: string,
  what: 'values' | 'folders',
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(${`crm.custom_${what}:${businessId}`}, 0))
  `.execute(trx);
}

/** The base key, or the base with the smallest number from 2 that no value has yet. */
async function freeKey(trx: DatabaseTransaction, base: string): Promise<string> {
  const suffixed = (n: number): string => {
    const suffix = `_${String(n)}`;
    return `${base.slice(0, 63 - suffix.length)}${suffix}`;
  };
  // Keys are at most 63 characters and a business has at most 500 values: read them all.
  const rows = await trx.selectFrom('crm.custom_values').select('key').execute();
  const taken = new Set(rows.map((row) => row.key));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(suffixed(n))) n += 1;
  return suffixed(n);
}

// What a save keeps in the audit log: which value it was, never its text.
const auditOf = (
  input: { readonly value: string } & Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const { value, ...rest } = input;
  return { ...rest, valueLength: value.length };
};

export const createCustomValueCommand = defineCommand({
  name: 'custom_value.create',
  permission: 'templates.manage',
  input: createCustomValueInput,
  audit: auditOf,
  async handle(trx, input, command): Promise<CustomValue> {
    const businessId = requireBusiness(command.context);
    await serializeAdditions(trx, businessId, 'values');
    const folderId = heldFolder(await holdFolder(trx, input.folderId));
    const { count } = await trx
      .selectFrom('crm.custom_values')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(count) >= CUSTOM_VALUE_LIMITS.values)
      throw invalid(
        '/name',
        'limit_reached',
        `A business can have at most ${String(CUSTOM_VALUE_LIMITS.values)} custom values. Delete one first.`,
      );
    // A key the caller chose is taken or it isn't; one made from the name gets a number.
    const key = input.key ?? (await freeKey(trx, mergeKeyFromName(input.name, 'value')));
    const row = await trx
      .insertInto('crm.custom_values')
      .values({
        business_id: businessId,
        key,
        name: input.name,
        value: input.value,
        folder_id: folderId,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'custom_value.created',
      subject: { kind: 'custom_value', id: row.id },
      payload: { key, name: input.name },
    });
    return asValue(await requireValue(trx, toPublicId('custom_value', row.id)));
  },
});

export const updateCustomValueCommand = defineCommand({
  name: 'custom_value.update',
  permission: 'templates.manage',
  input: updateCustomValueInput.extend(updateCustomValue.params.shape),
  audit: auditOf,
  async handle(trx, input, command): Promise<CustomValue> {
    requireBusiness(command.context);
    // The folder before the value (the lock order above). Whether it is there is said
    // only after the revision is checked: a stale save is told it is stale first.
    const folder = await holdFolder(trx, input.folderId);
    const current = await requireValue(trx, input.valueId, true);
    if (revisionOf(current) !== input.revision)
      throw new ConflictError(
        'This custom value changed. Reload the saved version before editing it again.',
      );
    const folderId = heldFolder(folder);
    await trx
      .updateTable('crm.custom_values')
      .set({ name: input.name, value: input.value, folder_id: folderId })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'custom_value.updated',
      subject: { kind: 'custom_value', id: current.id },
      payload: {
        key: current.key,
        name: input.name,
        valueChanged: input.value !== current.value,
      },
    });
    return asValue(await requireValue(trx, input.valueId));
  },
});

export const deleteCustomValueCommand = defineCommand({
  name: 'custom_value.delete',
  permission: 'templates.manage',
  input: deleteCustomValue.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireValue(trx, input.valueId, true);
    await trx.deleteFrom('crm.custom_values').where('id', '=', current.id).execute();
    await command.emit({
      type: 'custom_value.deleted',
      subject: { kind: 'custom_value', id: current.id },
      payload: { key: current.key, name: current.name },
    });
  },
});

/** One custom value of this business, as it is saved. */
export async function readCustomValue(
  trx: DatabaseTransaction,
  invocation: Invocation,
  valueId: string,
): Promise<CustomValue> {
  requireBusiness(invocation.context);
  return asValue(await requireValue(trx, valueId));
}

export const deleteCustomValuesCommand = defineCommand({
  name: 'custom_value.delete_many',
  permission: 'templates.manage',
  input: deleteCustomValuesInput,
  async handle(trx, input, command): Promise<{ deleted: number }> {
    requireBusiness(command.context);
    const wanted = input.valueIds.map((id) => parsePublicId('custom_value', id) ?? '');
    // Taken in id order, as a move takes them, so the two never wait on each other.
    const held = await trx
      .selectFrom('crm.custom_values')
      .select(['id', 'key', 'name'])
      .where('id', 'in', wanted)
      .orderBy('id')
      .forUpdate()
      .execute();
    // All or none: a value that isn't this business's, or is already gone, deletes nothing.
    if (held.length !== wanted.length)
      throw invalid('/valueIds', 'invalid_value', 'Choose custom values in this business.');
    await trx.deleteFrom('crm.custom_values').where('id', 'in', wanted).execute();
    // One event for each, as deleting them one at a time would have said.
    for (const row of held)
      await command.emit({
        type: 'custom_value.deleted',
        subject: { kind: 'custom_value', id: row.id },
        payload: { key: row.key, name: row.name },
      });
    return { deleted: held.length };
  },
});

export const moveCustomValuesCommand = defineCommand({
  name: 'custom_value.move',
  permission: 'templates.manage',
  input: moveCustomValuesInput,
  async handle(trx, input, command): Promise<{ items: CustomValue[] }> {
    requireBusiness(command.context);
    const folderId = heldFolder(await holdFolder(trx, input.folderId));
    const wanted = input.valueIds.map((id) => parsePublicId('custom_value', id) ?? '');
    const held = await trx
      .selectFrom('crm.custom_values')
      .select(['id', 'folder_id'])
      .where('id', 'in', wanted)
      .orderBy('id')
      .forUpdate()
      .execute();
    // All or none: a value that isn't this business's moves nothing.
    if (held.length !== wanted.length)
      throw invalid('/valueIds', 'invalid_value', 'Choose custom values in this business.');
    const moving = held.filter((row) => row.folder_id !== folderId).map(({ id }) => id);
    if (moving.length > 0) {
      await trx
        .updateTable('crm.custom_values')
        .set({ folder_id: folderId })
        .where('id', 'in', moving)
        .execute();
      await command.emit({
        type: 'custom_value.moved',
        subject: { kind: 'business', id: requireBusiness(command.context) },
        payload: {
          folderId: input.folderId,
          valueIds: moving.map((id) => toPublicId('custom_value', id)),
        },
      });
    }
    const rows = await values(trx).where('v.id', 'in', wanted).execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return { items: wanted.flatMap((id) => byId.get(id) ?? []).map(asValue) };
  },
});

/** A search as a LIKE pattern: the text anywhere, with its own % and _ taken literally. */
export const containing = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

// Where a page ended: the last value's name as PostgreSQL orders it, and its id. Opaque to
// callers, and still good when that value has since been deleted.
export const encodeCursor = (sortName: string, id: string): string =>
  Buffer.from(JSON.stringify([sortName, id])).toString('base64url');

export function decodeCursor(cursor: string): readonly [sortName: string, id: string] {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(decoded) && decoded.length === 2) {
      const pair: readonly unknown[] = decoded;
      const [sortName, id] = pair;
      if (typeof sortName === 'string' && typeof id === 'string' && isUuidV7(id))
        return [sortName, id];
    }
  } catch {
    // Not a cursor this list gave: answered below, like any other that isn't.
  }
  throw invalid('/after', 'invalid_cursor', 'Start from the next a page of this list gave.');
}

/** A page of the business's custom values in name order, and how many match. */
export async function readCustomValues(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: ListCustomValuesQuery,
): Promise<CustomValueList> {
  requireBusiness(invocation.context);
  const sortName = sql<string>`lower(btrim(v.name))`;
  let matching = values(trx);
  if (query.q !== undefined && query.q !== '') {
    const pattern = containing(query.q);
    matching = matching.where(
      sql<SqlBool>`(v.name ilike ${pattern} or v.key ilike ${pattern} or v.value ilike ${pattern})`,
    );
  }
  if (query.folder === 'none') matching = matching.where('v.folder_id', 'is', null);
  else if (query.folder !== undefined)
    matching = matching.where(
      'v.folder_id',
      '=',
      parsePublicId('custom_value_folder', query.folder) ?? '',
    );
  const { total } = await matching
    .clearSelect()
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  let page = matching.select(sortName.as('sort_name'));
  if (query.after !== undefined) {
    const [afterName, afterId] = decodeCursor(query.after);
    page = page.where(sql<SqlBool>`(${sortName}, v.id) > (${afterName}, ${afterId}::uuid)`);
  }
  const rows = await page
    .orderBy(sortName)
    .orderBy('v.id')
    .limit(query.limit + 1)
    .execute();
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown.map(asValue),
    total: Number(total),
    next:
      rows.length > query.limit && last !== undefined
        ? encodeCursor(last.sort_name, last.id)
        : null,
    canManage: mayManageCustomValues(invocation),
  };
}
