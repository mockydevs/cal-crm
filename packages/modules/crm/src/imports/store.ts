// An import's record (imports.jobs) as this module reads and shows it. The record is the
// history too: one row for each import, kept after it ends.
import type { Invocation } from '@repo/commands';
import {
  importedObjects,
  importModes,
  importObjects,
  importSources,
  importStatuses,
  importTarget,
  MAX_IMPORT_COLUMNS,
  type ImportJob,
  type ImportMode,
  type ImportTarget,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import {
  actorKinds,
  csvDelimiters,
  parsePublicId,
  toPublicId,
  type CsvDelimiter,
} from '@repo/kernel';
import type { Selectable } from 'kysely';
import * as z from 'zod';

import type { ActorNames, NameLookup } from '../activity/activity.js';

export type ImportRow = Selectable<DB['imports.jobs']>;

/** The choices an import from a file was started with, as imports.jobs.settings keeps them. */
export const storedSettings = z.strictObject({
  object: z.enum(importObjects),
  mode: z.enum(importModes),
  delimiter: z.enum(csvDelimiters),
  /** How many columns the file's header has: a row may have fewer cells, never more. */
  columns: z.int().min(1).max(MAX_IMPORT_COLUMNS),
  /** Public ids, as the start command took them. */
  tagIds: z.array(z.string()),
});
export type StoredSettings = z.infer<typeof storedSettings>;

/** A mapped column, as imports.jobs.mapping keeps it: with the header it had. */
export const storedMapping = z.array(
  z.strictObject({ column: z.int().min(0), header: z.string(), target: importTarget }),
);
export type StoredMapping = z.infer<typeof storedMapping>;

/** What a file import runs with. Another source's import has none of it. */
export interface ImportPlan {
  readonly mode: ImportMode;
  readonly delimiter: CsvDelimiter;
  readonly columns: number;
  readonly tagIds: readonly string[];
  readonly mapping: readonly { column: number; header: string; target: ImportTarget }[];
}

/** The plan a file import was started with; undefined for a row another source wrote. */
export function planOf(row: Pick<ImportRow, 'settings' | 'mapping'>): ImportPlan | undefined {
  const settings = storedSettings.safeParse(row.settings);
  const mapping = storedMapping.safeParse(row.mapping);
  if (!settings.success || !mapping.success) return undefined;
  return {
    mode: settings.data.mode,
    delimiter: settings.data.delimiter,
    columns: settings.data.columns,
    tagIds: settings.data.tagIds,
    mapping: mapping.data,
  };
}

/** An import of the business, by its public id; locked for a change when asked. */
export async function findImport(
  trx: DatabaseTransaction,
  businessId: string,
  id: string,
  lock = false,
): Promise<ImportRow | undefined> {
  const uuid = parsePublicId('import', id);
  if (uuid === undefined) return undefined;
  let query = trx
    .selectFrom('imports.jobs')
    .selectAll()
    .where('business_id', '=', businessId)
    .where('id', '=', uuid);
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst();
}

const ended = (status: string): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

/** Whether the invocation's role lets it start, stop and read imports. */
export function mayImport(invocation: Invocation): boolean {
  return invocation.permissions === 'all' || invocation.permissions.has('contacts.import');
}

// What the database's own checks hold each column to (0011, 0054): read through these, a
// value outside them is a fault that is thrown, not shown.
const stored = {
  source: z.enum(importSources),
  objects: z.array(z.enum(importedObjects)),
  status: z.enum(importStatuses),
  actorKind: z.enum(actorKinds),
};

/** The names of whoever started these imports, by `kind:id`, as far as a reader may see. */
export async function startersOf(
  trx: DatabaseTransaction,
  rows: readonly Pick<ImportRow, 'created_by_kind' | 'created_by_id'>[],
  actorNames: ActorNames,
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  for (const kind of actorKinds) {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row.created_by_kind === kind && row.created_by_id !== null ? [row.created_by_id] : [],
        ),
      ),
    ];
    const lookup = actorNames[kind];
    if (lookup === undefined || ids.length === 0) continue;
    for (const [id, name] of await lookup(trx, ids)) names.set(`${kind}:${id}`, name);
  }
  return names;
}

function present(
  row: ImportRow,
  invocation: Invocation,
  names: ReadonlyMap<string, string>,
): ImportJob {
  const plan = planOf(row);
  const kind = stored.actorKind.parse(row.created_by_kind);
  return {
    id: toPublicId('import', row.id),
    source: stored.source.parse(row.source),
    objects: stored.objects.parse(row.objects),
    status: stored.status.parse(row.status),
    fileName: row.file_name,
    mode: plan?.mode ?? null,
    mapping: plan?.mapping.map(({ column, header, target }) => ({ column, header, target })) ?? [],
    tagIds: [...(plan?.tagIds ?? [])],
    counts: {
      found: row.row_count,
      processed: row.processed_count,
      created: row.created_count,
      updated: row.updated_count,
      skipped: row.skipped_count,
      failed: row.failed_count,
    },
    hasErrorFile: row.error_file_id !== null,
    error:
      row.status === 'failed'
        ? {
            code: row.error_code ?? 'unknown',
            message: row.error ?? 'The import could not be finished.',
          }
        : null,
    cancelRequested: row.cancel_requested_at !== null,
    startedBy: {
      kind,
      name: names.get(`${kind}:${row.created_by_id ?? ''}`) ?? null,
      you: kind === 'user' && row.created_by_id === invocation.context.userId,
    },
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    canCancel: !ended(row.status) && row.cancel_requested_at === null && mayImport(invocation),
  };
}

/** Imports as the API shows them, with the names of who started each. */
export async function presentImports(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly ImportRow[],
  actorNames: ActorNames,
): Promise<ImportJob[]> {
  const names = await startersOf(trx, rows, actorNames);
  return rows.map((row) => present(row, invocation, names));
}

/** One import, as the API shows it. */
export async function presentImport(
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: ImportRow,
  actorNames: ActorNames,
): Promise<ImportJob> {
  return present(row, invocation, await startersOf(trx, [row], actorNames));
}

/**
 * Imports by the name of the file each read, for showing which import acted: on a
 * contact's timeline, and as the source of a value or a tag it set (ActorNames).
 */
export const readImportNames: NameLookup = async (trx, ids) => {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('imports.jobs')
    .select(['id', 'file_name'])
    .where('id', 'in', [...ids])
    .execute();
  return new Map(
    rows.flatMap((row) => (row.file_name === null ? [] : [[row.id, row.file_name] as const])),
  );
};
