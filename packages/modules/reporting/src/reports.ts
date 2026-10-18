// Saved reports: a name and a definition, a document of pages and widgets the contract
// checks. Reading one needs reports.view; making, changing, copying and deleting one needs
// reports.manage. A save names the revision it read, and is refused when the report has
// changed since. Deleting moves a report out of the list; its row stays
// (reporting.reports.deleted_at).
import { defineCommand, requireBusiness, type Command, type Invocation } from '@repo/commands';
import {
  BLANK_REPORT_DEFINITION,
  cloneReportCommandInput,
  createReportInput,
  deleteReportCommandInput,
  REPORT_DEFINITION_VERSION,
  reportDefinition,
  updateReportCommandInput,
  type listReportsQuery,
  type Report,
  type ReportDefinition,
  type ReportList,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import type * as z from 'zod';

import { granted, requireReader, type ReportingOptions } from './engine.js';
import { buildTemplate } from './templates/index.js';

type ReportRow = Selectable<DB['reporting.reports']>;
type People = Pick<ReportingOptions, 'people'>;

/** The most reports a business keeps: a list, not an archive. */
export const REPORT_LIMIT = 500;

const asJson = (definition: ReportDefinition) => sql<string>`${JSON.stringify(definition)}::jsonb`;

async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly ReportRow[],
  options: People,
) {
  const users = [
    ...new Set(
      rows.flatMap((row) =>
        row.created_by_kind === 'user' && row.created_by_id !== null && row.template_key === null
          ? [row.created_by_id]
          : [],
      ),
    ),
  ];
  const names = await options.people.names(trx, users);
  return rows.map((row) => ({
    id: toPublicId('report', row.id),
    name: row.name,
    templateKey: row.template_key,
    createdBy:
      row.template_key !== null
        ? { kind: 'template_library' as const, name: 'Template Library' }
        : row.created_by_kind === 'user'
          ? { kind: 'user' as const, name: names.get(row.created_by_id ?? '') ?? null }
          : { kind: 'other' as const, name: null },
    scheduleFrequency: null,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    // Written by this module only, and checked by the contract on the way in.
    definition: reportDefinition.parse(row.definition),
    canManage: granted(invocation, 'reports.manage'),
  }));
}

async function presentOne(
  trx: DatabaseTransaction,
  invocation: Invocation,
  row: ReportRow,
  options: People,
): Promise<Report> {
  const [saved] = await present(trx, invocation, [row], options);
  if (saved === undefined) throw new TypeError('The report must be present.');
  return saved;
}

async function requireReport(
  trx: DatabaseTransaction,
  businessId: string,
  id: string,
  lock: boolean,
): Promise<ReportRow> {
  const uuid = parsePublicId('report', id);
  const query = trx
    .selectFrom('reporting.reports')
    .selectAll()
    .where('business_id', '=', businessId)
    .where('id', '=', uuid ?? '')
    .where('deleted_at', 'is', null);
  const row =
    uuid === undefined ? undefined : await (lock ? query.forUpdate() : query).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Report', id);
  return row;
}

function requireRevision(row: ReportRow, revision: number): void {
  if (row.revision !== revision)
    throw new ConflictError('This report changed. Open it again before saving or deleting it.');
}

async function insert(
  trx: DatabaseTransaction,
  invocation: Invocation,
  businessId: string,
  values: { name: string; definition: ReportDefinition; templateKey: string | null },
): Promise<ReportRow> {
  // One at a time for a business, so the count below holds.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`reports:${businessId}`}, 0))`.execute(
    trx,
  );
  const held = await trx
    .selectFrom('reporting.reports')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('business_id', '=', businessId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  if (Number(held.count) >= REPORT_LIMIT)
    throw new ValidationError([
      {
        path: '',
        code: 'report_limit',
        message: `A business keeps up to ${String(REPORT_LIMIT)} reports. Delete one before making another.`,
      },
    ]);
  return trx
    .insertInto('reporting.reports')
    .values({
      business_id: businessId,
      name: values.name,
      definition: asJson(values.definition),
      definition_version: REPORT_DEFINITION_VERSION,
      template_key: values.templateKey,
      created_by_kind: invocation.context.actorKind,
      created_by_id: invocation.context.actorId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function createReportCommand(options: People): Command<typeof createReportInput, Report> {
  return defineCommand({
    name: 'report.create',
    permission: 'reports.manage',
    input: createReportInput,
    audit: ({ name, templateKey }) => ({ name, templateKey }),
    async handle(trx, input, command): Promise<Report> {
      const businessId = requireBusiness(command.context);
      let name = input.name ?? 'Untitled report';
      let definition = input.definition ?? BLANK_REPORT_DEFINITION;
      if (input.templateKey !== undefined) {
        // The funnel of a template is of the business's first pipeline.
        const pipeline = await trx
          .selectFrom('crm.pipelines')
          .select('id')
          .where('business_id', '=', businessId)
          .where('archived_at', 'is', null)
          .orderBy('position')
          .orderBy('id')
          .executeTakeFirst();
        const template = buildTemplate(input.templateKey, {
          pipelineId: pipeline === undefined ? undefined : toPublicId('pipeline', pipeline.id),
        });
        if (template === undefined)
          throw new ValidationError([
            {
              path: '/templateKey',
              code: 'unknown_template',
              message: 'Choose a template of the library.',
            },
          ]);
        name = input.name ?? template.name;
        definition = template.definition;
      }
      const row = await insert(trx, command, businessId, {
        name,
        definition,
        templateKey: input.templateKey ?? null,
      });
      return presentOne(trx, command, row, options);
    },
  });
}

export function updateReportCommand(
  options: People,
): Command<typeof updateReportCommandInput, Report> {
  return defineCommand({
    name: 'report.update',
    permission: 'reports.manage',
    input: updateReportCommandInput,
    audit: ({ id, name }) => ({ id, name }),
    async handle(trx, input, command): Promise<Report> {
      const businessId = requireBusiness(command.context);
      const current = await requireReport(trx, businessId, input.id, true);
      requireRevision(current, input.revision);
      const row = await trx
        .updateTable('reporting.reports')
        .set({
          name: input.name,
          definition: asJson(input.definition),
          definition_version: REPORT_DEFINITION_VERSION,
          revision: current.revision + 1,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', current.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return presentOne(trx, command, row, options);
    },
  });
}

export function cloneReportCommand(
  options: People,
): Command<typeof cloneReportCommandInput, Report> {
  return defineCommand({
    name: 'report.clone',
    permission: 'reports.manage',
    input: cloneReportCommandInput,
    audit: ({ id }) => ({ id }),
    async handle(trx, input, command): Promise<Report> {
      const businessId = requireBusiness(command.context);
      const source = await requireReport(trx, businessId, input.id, false);
      const row = await insert(trx, command, businessId, {
        name: input.name ?? `Copy of ${source.name}`.slice(0, 120),
        definition: reportDefinition.parse(source.definition),
        // A copy is its maker's own: the list names them, not the library.
        templateKey: null,
      });
      return presentOne(trx, command, row, options);
    },
  });
}

export const deleteReportCommand = defineCommand({
  name: 'report.delete',
  permission: 'reports.manage',
  input: deleteReportCommandInput,
  audit: ({ id }) => ({ id }),
  async handle(trx, input, command): Promise<undefined> {
    const businessId = requireBusiness(command.context);
    const current = await requireReport(trx, businessId, input.id, true);
    requireRevision(current, input.revision);
    await trx
      .updateTable('reporting.reports')
      .set({ deleted_at: sql<Date>`now()`, revision: current.revision + 1 })
      .where('business_id', '=', businessId)
      .where('id', '=', current.id)
      .execute();
    return undefined;
  },
});

export async function readReport(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: People,
): Promise<Report> {
  requireReader(invocation);
  const row = await requireReport(trx, requireBusiness(invocation.context), id, false);
  return presentOne(trx, invocation, row, options);
}

/** A page of the business's reports, newest first, found by any part of their name. */
export async function readReports(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof listReportsQuery>,
  options: People,
): Promise<ReportList> {
  requireReader(invocation);
  const businessId = requireBusiness(invocation.context);
  const after = query.after === undefined ? undefined : parsePublicId('report', query.after);
  let select = trx
    .selectFrom('reporting.reports')
    .selectAll()
    .where('business_id', '=', businessId)
    .where('deleted_at', 'is', null);
  if (query.q !== undefined && query.q !== '')
    select = select.where(
      sql<boolean>`lower(name) like ${`%${query.q.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`}`,
    );
  // Ids are made in order of time, so the newest report has the largest.
  if (after !== undefined) select = select.where('id', '<', after);
  const rows = await select
    .orderBy('id', 'desc')
    .limit(query.limit + 1)
    .execute();
  const page = rows.slice(0, query.limit);
  const items = (await present(trx, invocation, page, options)).map(
    ({ definition: _definition, canManage: _canManage, ...item }) => item,
  );
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > query.limit && last !== undefined ? toPublicId('report', last.id) : null,
    canManage: granted(invocation, 'reports.manage'),
  };
}
