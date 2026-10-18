// Starting and stopping an import, and reading the history of imports.
//
// Starting one does nothing a person could not do a row at a time: besides contacts.import
// it needs what its rows need (contacts.manage, and tags.manage or fields.values when it
// adds tags or fills custom fields). The rows themselves are applied by the worker
// (apply.ts, run.ts); this only stores what was asked for and queues the job.
import {
  defineCommand,
  requireBusiness,
  type CommandContext,
  type Invocation,
  type TaskReference,
} from '@repo/commands';
import {
  importIdInput,
  importPlanInput,
  importRowOutcomes,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  type ImportJob,
  type ImportList,
  type ImportRowList,
  type listImportRowsQuery,
  type listImportsQuery,
  type Permission,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type Json } from '@repo/db';
import {
  ConflictError,
  csvDelimiters,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type Issue,
} from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import * as z from 'zod';

import type { ActorNames } from '../activity/activity.js';
import { readFields } from '../fields/fields.js';
import { checkMapping } from './mapping.js';
import {
  findImport,
  presentImport,
  presentImports,
  startersOf,
  type ImportRow,
  type StoredMapping,
  type StoredSettings,
} from './store.js';

/** The job that applies an import's rows. The worker holds its handler (run.ts). */
export const runImportReference = {
  name: 'imports.run',
  data: z.strictObject({ importId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

const asJson = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;

const notFound = (id: string) => new NotFoundError('Import', id);

function requireAlso(command: CommandContext, permission: Permission): void {
  if (command.permissions === 'all' || command.permissions.has(permission)) return;
  throw new ForbiddenError(`Your role doesn't allow this: it needs ${permission}.`, permission);
}

function refuse(issues: readonly Issue[]): void {
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
}

/**
 * Refuses a plan no import could run: a mapping that can't work for the file's columns and
 * the business's fields (mapping.ts), or a tag that isn't the business's. The preview and
 * the start of an import both ask, so the preview never shows what starting would refuse.
 */
export async function checkImportPlan(
  trx: DatabaseTransaction,
  invocation: Invocation,
  plan: Pick<z.output<typeof importPlanInput>, 'mapping' | 'mode' | 'tagIds'>,
  columns: number,
): Promise<void> {
  const { items } = await readFields(trx, invocation);
  refuse(
    checkMapping(plan.mapping, {
      columns,
      fields: items.filter((field) => field.objectKey === 'contact'),
      mode: plan.mode,
    }),
  );
  // Each tag is read under row-level security before an import may add it.
  const tagIds = plan.tagIds.map((id) => parsePublicId('tag', id) ?? '');
  const tags =
    tagIds.length === 0
      ? []
      : await trx.selectFrom('crm.tags').select('id').where('id', 'in', tagIds).execute();
  refuse(
    tagIds.flatMap((id, index): Issue[] =>
      tags.some((tag) => tag.id === id)
        ? []
        : [
            {
              path: `/tagIds/${String(index)}`,
              code: 'not_found',
              message: "This tag doesn't exist.",
            },
          ],
    ),
  );
}

/**
 * What import.start takes: the plan as the API took it, and what reading the file found.
 * The route reads the file before the command runs, so no transaction is held open while
 * a large file is read.
 */
export const startImportInput = z.strictObject({
  plan: importPlanInput,
  file: z.strictObject({
    name: z.string().min(1).max(255),
    header: z.array(z.string()).min(1).max(MAX_IMPORT_COLUMNS),
    rowCount: z.int().min(1).max(MAX_IMPORT_ROWS),
    delimiter: z.enum(csvDelimiters),
  }),
});

export const startImportCommand = defineCommand({
  name: 'import.start',
  permission: 'contacts.import',
  input: startImportInput,
  // Identifiers and counts: no file name, header or value reaches the audit log.
  audit: ({ plan, file }) => ({
    fileId: plan.fileId,
    object: plan.object,
    mode: plan.mode,
    columns: plan.mapping.length,
    tags: plan.tagIds.length,
    rows: file.rowCount,
  }),
  async handle(trx, { plan, file }, command): Promise<{ id: string }> {
    const businessId = requireBusiness(command.context);
    const fillsFields = plan.mapping.some(({ target }) => target.kind === 'field');
    const addsTags =
      plan.tagIds.length > 0 ||
      plan.mapping.some(({ target }) => target.kind === 'attribute' && target.attribute === 'tags');
    requireAlso(command, 'contacts.manage');
    if (addsTags) requireAlso(command, 'tags.manage');
    if (fillsFields) requireAlso(command, 'fields.values');

    await checkImportPlan(trx, command, plan, file.header.length);

    const settings: StoredSettings = {
      object: plan.object,
      mode: plan.mode,
      delimiter: file.delimiter,
      columns: file.header.length,
      tagIds: plan.tagIds,
    };
    const mapping: StoredMapping = plan.mapping.map(({ column, target }) => ({
      column,
      header: file.header[column] ?? '',
      target,
    }));
    const { id } = await trx
      .insertInto('imports.jobs')
      .values({
        business_id: businessId,
        source: 'csv',
        objects: [plan.object],
        status: 'pending',
        settings: asJson(settings),
        mapping: asJson(mapping),
        file_id: parsePublicId('file', plan.fileId) ?? null,
        file_name: file.name,
        row_count: file.rowCount,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
        heartbeat_at: sql<Date>`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(
        explainUniqueViolation({
          jobs_one_active_idx: () =>
            new ConflictError(
              'An import is already waiting or running in this business. Wait for it to finish, or stop it.',
            ),
        }),
      );
    await command.emit({
      type: 'import.started',
      subject: { kind: 'import', id },
      payload: { source: 'csv', objects: [plan.object], mode: plan.mode, rows: file.rowCount },
    });
    command.enqueue(runImportReference, { importId: id });
    return { id: toPublicId('import', id) };
  },
});

export const cancelImportCommand = defineCommand({
  name: 'import.cancel',
  permission: 'contacts.import',
  input: importIdInput,
  async handle(trx, input, command): Promise<{ id: string }> {
    const businessId = requireBusiness(command.context);
    const row = await findImport(trx, businessId, input.id, true);
    if (row === undefined) throw notFound(input.id);
    // Not yet taken up: it ends here, and the job that finds it ended does nothing.
    if (row.status === 'pending') {
      await trx
        .updateTable('imports.jobs')
        .set({
          status: 'cancelled',
          cancel_requested_at: sql<Date>`now()`,
          finished_at: sql<Date>`now()`,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'import.cancelled',
        subject: { kind: 'import', id: row.id },
        payload: { processed: 0 },
      });
    }
    // Being applied: the worker stops before its next batch of rows, and ends it then.
    if (row.status === 'running' && row.cancel_requested_at === null) {
      await trx
        .updateTable('imports.jobs')
        .set({ cancel_requested_at: sql<Date>`now()` })
        .where('business_id', '=', businessId)
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'import.cancel_requested',
        subject: { kind: 'import', id: row.id },
      });
    }
    return { id: input.id };
  },
});

/** An import of the invocation's business, as the API shows it, or not found. */
export async function readImport(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  actorNames: ActorNames,
): Promise<ImportJob> {
  const row = await findImport(trx, requireBusiness(invocation.context), id);
  if (row === undefined) throw notFound(id);
  return presentImport(trx, invocation, row, actorNames);
}

/**
 * What each order of the history compares, for the import `j` and the name `n` of whoever
 * started it. Never null, so every import has one place in every order: an import that
 * has not finished is after every finished one, and one whose starter is gone is first.
 */
const SORT_KEYS: Readonly<
  Record<z.output<typeof listImportsQuery>['sort'], (j: string, n: string) => RawBuilder<unknown>>
> = {
  started: (j) => sql`${sql.ref(`${j}.created_at`)}`,
  completed: (j) => sql`coalesce(${sql.ref(`${j}.finished_at`)}, 'infinity'::timestamptz)`,
  source: (j) => sql`${sql.ref(`${j}.source`)}`,
  importedBy: (_j, n) => sql`lower(coalesce(${sql.ref(`${n}.name`)}, ''))`,
  status: (j) => sql`${sql.ref(`${j}.status`)}`,
  objects: (j) => sql`array_to_string(${sql.ref(`${j}.objects`)}, ',')`,
  found: (j) => sql`${sql.ref(`${j}.row_count`)}`,
  errors: (j) => sql`${sql.ref(`${j}.failed_count`)}`,
};

/**
 * A page of the business's imports with how many match in all: newest first, or in the
 * order of any column of the history. A page starts after an import by the value it is
 * ordered by and its id, both read from the stored row, so paging keeps its place under
 * every order.
 */
export async function readImportList(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof listImportsQuery>,
  actorNames: ActorNames,
): Promise<ImportList> {
  const businessId = requireBusiness(invocation.context);
  const { status, source, object, startedFrom, startedBefore, after, limit, sort, direction } =
    query;
  const filters: RawBuilder<SqlBool>[] = [sql<SqlBool>`j.business_id = ${businessId}`];
  if (status !== undefined) filters.push(sql<SqlBool>`j.status = ${status}`);
  if (source !== undefined) filters.push(sql<SqlBool>`j.source = ${source}`);
  if (object !== undefined) filters.push(sql<SqlBool>`j.objects @> array[${object}]::text[]`);
  if (startedFrom !== undefined)
    filters.push(sql<SqlBool>`j.created_at >= ${new Date(startedFrom)}`);
  if (startedBefore !== undefined)
    filters.push(sql<SqlBool>`j.created_at < ${new Date(startedBefore)}`);
  const matching = sql.join(filters, sql` and `);

  const {
    rows: [counted],
  } = await sql<{ total: string }>`
    select count(*) as total from imports.jobs j where ${matching}
  `.execute(trx);

  // "Imported by" is ordered by the name the row shows. Who that is belongs to other
  // modules, so the names of everyone who started a matching import are read first (a
  // team's worth) and joined in.
  let names = sql`(select null::text as kind, null::uuid as id, null::text as name where false)`;
  if (sort === 'importedBy') {
    const { rows: starters } = await sql<Pick<ImportRow, 'created_by_kind' | 'created_by_id'>>`
      select distinct j.created_by_kind, j.created_by_id from imports.jobs j where ${matching}
    `.execute(trx);
    const known = [...(await startersOf(trx, starters, actorNames))].map(([key, name]) => {
      const [kind = '', id = ''] = key.split(':');
      return sql`(${kind}::text, ${id}::uuid, ${name}::text)`;
    });
    if (known.length > 0) names = sql`(values ${sql.join(known)})`;
  }
  const named = (j: string, n: string) => sql`
    left join ${names} as ${sql.ref(n)} (kind, id, name)
      on ${sql.ref(`${n}.kind`)} = ${sql.ref(`${j}.created_by_kind`)}
     and ${sql.ref(`${n}.id`)} = ${sql.ref(`${j}.created_by_id`)}`;

  const cursor = after === undefined ? undefined : parsePublicId('import', after);
  if (after !== undefined) {
    const anchor = await findImport(trx, businessId, after);
    if (anchor === undefined)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_import',
          message: 'Start after an import in this business.',
        },
      ]);
  }
  const key = SORT_KEYS[sort];
  const beyond = direction === 'asc' ? sql`>` : sql`<`;
  const way = direction === 'asc' ? sql`asc` : sql`desc`;
  const { rows } = await sql<ImportRow>`
    select j.* from imports.jobs j ${named('j', 'n')}
    where ${matching}
      ${
        cursor === undefined
          ? sql``
          : sql`and (${key('j', 'n')}, j.id) ${beyond} (
              select ${key('a', 'an')}, a.id from imports.jobs a ${named('a', 'an')}
              where a.id = ${cursor})`
      }
    order by ${key('j', 'n')} ${way}, j.id ${way}
    limit ${limit + 1}
  `.execute(trx);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await presentImports(trx, invocation, page, actorNames),
    next: rows.length > limit && last !== undefined ? toPublicId('import', last.id) : null,
    total: Number(counted?.total ?? 0),
  };
}

// What the database's own check holds the column to (0054).
const rowOutcome = z.enum(importRowOutcomes);

/**
 * What became of an import's rows, in the file's order: the rows the error file lists
 * unless another outcome is asked for. imports.job_rows keeps the outcome and the reason
 * and nothing a row contained, so neither does this.
 */
export async function readImportRows(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  query: z.output<typeof listImportRowsQuery>,
): Promise<ImportRowList> {
  const businessId = requireBusiness(invocation.context);
  const job = await findImport(trx, businessId, id);
  if (job === undefined) throw notFound(id);
  const outcomes =
    query.outcome === 'not_applied' ? (['skipped', 'failed'] as const) : ([query.outcome] as const);
  const matching = trx
    .selectFrom('imports.job_rows')
    .where('business_id', '=', businessId)
    .where('job_id', '=', job.id)
    .where('outcome', 'in', outcomes);
  const { total } = await matching
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  const rows = await (
    query.after === undefined ? matching : matching.where('row_number', '>', query.after)
  )
    .select(['row_number', 'outcome', 'code', 'detail'])
    .orderBy('row_number')
    .limit(query.limit + 1)
    .execute();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      row: row.row_number,
      outcome: rowOutcome.parse(row.outcome),
      code: row.code,
      message: row.detail,
    })),
    next: rows.length > query.limit && last !== undefined ? last.row_number : null,
    total: Number(total),
  };
}

/**
 * Whether a record was made or changed by an import: the condition behind "view imported
 * contacts", for whoever lists records. `record` is the column holding the record's id
 * (crm.records.id, which a contact, a company and a deal share with their row); `importId`
 * is the import's stored id. A row that was skipped or failed wrote no record, and a purged
 * record's row no longer names one, so neither is found.
 */
export function writtenByImport(record: string, importId: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`exists (
    select 1 from imports.job_rows imported
    where imported.business_id = app.business_id()
      and imported.job_id = ${importId}
      and imported.record_id = ${sql.ref(record)}
      and imported.outcome in ('created', 'updated'))`;
}
