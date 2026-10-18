// Reporting: the catalogue, the one query engine, saved reports with their templates, and
// the two fixed reports. Every read runs in the request's tenant transaction as the person
// who asked, with a short statement timeout and a per-person limit on how many queries a
// minute.
import {
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Route,
} from '@repo/commands';
import {
  appointmentOverviewQuery,
  attributionReportQuery,
  cloneReport,
  cloneReportInput,
  createReport,
  createReportInput,
  deleteReport,
  deleteReportInput,
  getAppointmentOverview,
  getAttributionReport,
  getReport,
  getReportCatalog,
  listReports,
  listReportsQuery,
  listReportTemplates,
  parseInput,
  REPORT_LIMITS,
  reportFilterOperators,
  reportPresets,
  reportQuery,
  reportSourceKeys,
  reportSources,
  runReportQuery,
  updateReport,
  updateReportInput,
  type ReportCatalog,
  type ReportSourceSpec,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { ValidationError } from '@repo/kernel';
import { sql } from 'kysely';

import {
  granted,
  missingForSource,
  requireReader,
  runQuery,
  type ReportingOptions,
} from './engine.js';
import { readAppointmentOverview, readAttributionReport } from './fixed.js';
import { createQueryLimiter } from './rate-limit.js';
import {
  cloneReportCommand,
  createReportCommand,
  deleteReportCommand,
  readReport,
  readReports,
  updateReportCommand,
} from './reports.js';
import { reportTemplates } from './templates/index.js';

export { runQuery, type ReportingOptions } from './engine.js';
export { readAppointmentOverview, readAttributionReport } from './fixed.js';
export { buildTemplate, reportTemplates } from './templates/index.js';

/** The catalogue as the API gives it, with what this reader's role allows. */
export function readCatalog(invocation: Invocation): ReportCatalog {
  requireReader(invocation);
  return {
    sources: reportSourceKeys.map((key) => {
      const spec: ReportSourceSpec = reportSources[key];
      return {
        key,
        label: spec.label,
        description: spec.description,
        allowed: missingForSource(invocation, spec) === undefined,
        permission: spec.permission,
        measures: Object.entries(spec.measures).map(([measure, each]) => ({
          key: measure,
          label: each.label,
          kind: each.kind,
          description: each.description,
        })),
        dimensions: Object.entries(spec.dimensions).map(([dimension, each]) => ({
          key: dimension,
          label: each.label,
          kind: each.kind,
          ...(each.choices === undefined ? {} : { choices: [...each.choices] }),
          ...(each.reference === undefined ? {} : { reference: each.reference }),
          attribution: each.attribution === true,
          multiple: each.multiple === true,
          operators: [...reportFilterOperators(each.kind)],
        })),
        numberFilters: spec.numberFilters.map((field) => ({
          key: field,
          label: spec.measures[field]?.label ?? field,
          operators: [...reportFilterOperators('number')],
        })),
        dateProperties: Object.entries(spec.dateProperties).map(([property, each]) => ({
          key: property,
          label: each.label,
        })),
        defaultDate: spec.defaultDate,
        attribution: [...spec.attribution],
      };
    }),
    presets: [...reportPresets],
    limits: {
      measures: REPORT_LIMITS.measures,
      groupBy: REPORT_LIMITS.groupBy,
      rangeDays: REPORT_LIMITS.rangeDays,
      rows: REPORT_LIMITS.rows,
      widgetsPerPage: REPORT_LIMITS.widgetsPerPage,
      pages: REPORT_LIMITS.pages,
    },
    canManage: granted(invocation, 'reports.manage'),
  };
}

/** PostgreSQL's code for a statement cancelled, which is what its timeout does. */
const QUERY_CANCELED = '57014';

/**
 * Runs a report's reads in the request's tenant transaction, with the statement timeout
 * set for that transaction alone. A statement that runs out of time is the reader's to
 * narrow, not a fault of the server: it is answered as a refusal that says so.
 */
export async function withReportRead<T>(
  db: Database,
  invocation: Invocation,
  timeoutMs: number,
  work: (trx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withTenant(db, invocation.context, async (trx) => {
      await sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`.execute(trx);
      return work(trx);
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === QUERY_CANCELED)
      throw new ValidationError([
        {
          path: '',
          code: 'query_timeout',
          message: 'This took too long to count. Use a shorter range or fewer groups.',
        },
      ]);
    throw error;
  }
}

export function createReportingRoutes(options: ReportingOptions): readonly ApiRoute[] {
  const timeoutMs = options.limits?.statementTimeoutMs ?? REPORT_LIMITS.statementTimeoutMs;
  const limiter = createQueryLimiter(
    options.limits?.queriesPerMinute ?? REPORT_LIMITS.queriesPerMinute,
  );
  /** One request of a person's minute. The reader is checked first: a refusal costs nothing. */
  const admit = (invocation: Invocation): void => {
    requireReader(invocation);
    requireBusiness(invocation.context);
    const { userId, actorId, actorKind } = invocation.context;
    if (!limiter.admit(`${invocation.context.businessId ?? ''}:${userId ?? actorId ?? actorKind}`))
      throw new ValidationError([
        {
          path: '',
          code: 'rate_limited',
          message: 'Too many report queries in a minute. Wait a moment and try again.',
        },
      ]);
  };
  const create = createReportCommand(options);
  const update = updateReportCommand(options);
  const clone = cloneReportCommand(options);

  return [
    {
      endpoint: getReportCatalog,
      run: ({ invocation }) => {
        requireBusiness(invocation.context);
        return Promise.resolve(readCatalog(invocation));
      },
    } satisfies Route<typeof getReportCatalog>,
    {
      endpoint: runReportQuery,
      run: ({ invocation, body }, { db }) => {
        admit(invocation);
        const query = parseInput(reportQuery, body);
        return withReportRead(db, invocation, timeoutMs, (trx) =>
          runQuery(trx, invocation, query, options),
        );
      },
    } satisfies Route<typeof runReportQuery>,
    {
      endpoint: listReportTemplates,
      run: ({ invocation }) => {
        requireReader(invocation);
        return Promise.resolve({ items: [...reportTemplates] });
      },
    } satisfies Route<typeof listReportTemplates>,
    {
      endpoint: getAppointmentOverview,
      run: ({ invocation, query }, { db }) => {
        admit(invocation);
        const parsed = parseInput(appointmentOverviewQuery, query);
        return withReportRead(db, invocation, timeoutMs, (trx) =>
          readAppointmentOverview(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof getAppointmentOverview>,
    {
      endpoint: getAttributionReport,
      run: ({ invocation, query }, { db }) => {
        admit(invocation);
        const parsed = parseInput(attributionReportQuery, query);
        return withReportRead(db, invocation, timeoutMs, (trx) =>
          readAttributionReport(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof getAttributionReport>,
    {
      endpoint: listReports,
      run: ({ invocation, query }, { db }) => {
        const parsed = parseInput(listReportsQuery, query);
        return withTenant(db, invocation.context, (trx) =>
          readReports(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof listReports>,
    {
      endpoint: createReport,
      command: create,
      run: ({ invocation, body }, services) =>
        runCommand(services, create, parseInput(createReportInput, body), invocation),
    } satisfies Route<typeof createReport>,
    {
      endpoint: getReport,
      run: ({ invocation, params }, { db }) => {
        const { id } = parseInput(getReport.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readReport(trx, invocation, id, options),
        );
      },
    } satisfies Route<typeof getReport>,
    {
      endpoint: updateReport,
      command: update,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          update,
          { ...parseInput(updateReportInput, body), ...parseInput(updateReport.params, params) },
          invocation,
        ),
    } satisfies Route<typeof updateReport>,
    {
      endpoint: cloneReport,
      command: clone,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          clone,
          {
            ...parseInput(cloneReportInput, body ?? {}),
            ...parseInput(cloneReport.params, params),
          },
          invocation,
        ),
    } satisfies Route<typeof cloneReport>,
    {
      endpoint: deleteReport,
      command: deleteReportCommand,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          deleteReportCommand,
          { ...parseInput(deleteReportInput, body), ...parseInput(deleteReport.params, params) },
          invocation,
        ),
    } satisfies Route<typeof deleteReport>,
  ];
}
