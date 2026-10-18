// Reporting at the size of a large business: every query the reporting module can send,
// timed as the server runs it, on a real, migrated Postgres (Testcontainers) that holds one
// large US business beside three small neighbours (reports-seed.ts says what is in it, and
// why).
//
// What is timed is a route's whole run, as the server runs it: the tenant transaction, its
// statement timeout, every statement under row-level security as crm_app, and the folding.
// HTTP is left out (about a millisecond here: pages.bench.ts), and so is the per-person
// limit of 120 queries a minute, which a measurement of hundreds of runs would trip.
//
// Run: pnpm --filter @repo/server run bench:reports (needs Docker; several minutes). The
// numbers go to apps/server/reports/bench-reports.json, and the plans of the slowest
// statements to apps/server/reports/bench-reports-plans.txt.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { allowEveryone, type ApiRoute } from '@repo/commands';
import { connectPool, withTenant, type DB } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { readUserNames } from '@repo/module-auth';
import { createReportingRoutes, type ReportingOptions } from '@repo/module-reporting';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { taskOptions } from '../src/task-options.js';
import { machine, percentile, report } from './harness.js';
import { seedReporting, type Business } from './reports-seed.js';

/** What the budget is: a widget's p95, and a fixed report's. */
const WIDGET_BUDGET_MS = 300;
const FIXED_BUDGET_MS = 1000;
/** Runs of each case after two that warm it: fewer when one run is slow. */
const RUNS = 20;
const CASE_BUDGET_MS = 20_000;
const MIN_RUNS = 5;

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly ms: number;
}

let database: TestDatabase;
let pool: ReturnType<typeof connectPool>;
let db: Kysely<DB>;
/** The statements of the run being traced, when one is. */
let trace: Statement[] | undefined;

let large: Business;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  pool = connectPool({
    connectionString: database.url('crm_app'),
    // The server's own pool (start.ts: DATABASE_POOL_SIZE, ten by default).
    maxConnections: 10,
    onConnectionError: () => undefined,
  });
  db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log: (event) => {
      if (trace !== undefined)
        trace.push({
          sql: event.query.sql,
          parameters: event.query.parameters,
          ms: event.queryDurationMillis,
        });
    },
  });
  const started = performance.now();
  large = await seedReporting(database);
  process.stdout.write(
    `\nSeeded in ${String(Math.round((performance.now() - started) / 1000))} s\n`,
  );
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

// The cases ---------------------------------------------------------------------------------

type Range = { preset: string } | { from: string; to: string };
interface RangeCase {
  readonly key: string;
  readonly range: Range;
  /** The grain a series asks for: a day while it fits the 500 rows of an answer. */
  readonly grain: 'day' | 'week';
}

const day = (offset: number): string =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const RANGES: readonly RangeCase[] = [
  { key: 'last_7_days', range: { preset: 'last_7_days' }, grain: 'day' },
  { key: 'last_30_days', range: { preset: 'last_30_days' }, grain: 'day' },
  { key: 'last_90_days', range: { preset: 'last_90_days' }, grain: 'day' },
  { key: 'last_12_months', range: { preset: 'last_12_months' }, grain: 'week' },
  // The longest a query may ask for: 1,096 days.
  { key: 'three_years', range: { from: day(1095), to: day(0) }, grain: 'week' },
];

const only = (field: string, values: string[]) => ({
  match: 'all',
  groups: [{ match: 'all', conditions: [{ field, operator: 'any_of', values }] }],
});

interface Case {
  readonly key: string;
  readonly kind: 'widget' | 'fixed';
  readonly operationId: string;
  /** The body (a widget) or the query (a fixed report) for a range. */
  readonly request: (range: RangeCase, business: Business) => { body?: unknown; query?: unknown };
}

const widget = (key: string, query: (range: RangeCase, business: Business) => object): Case => ({
  key,
  kind: 'widget',
  operationId: 'runReportQuery',
  request: (range, business) => ({ body: { ...query(range, business), range: range.range } }),
});
const presetQuery = (range: Range): Record<string, string> =>
  'preset' in range ? { preset: range.preset } : { from: range.from, to: range.to };

/** The Pipeline & Attribution template's widgets first (a report's first page), then more. */
const CASES: readonly Case[] = [
  widget('template: open opportunities (stat, compared)', () => ({
    source: 'opportunities',
    measures: ['count', 'value'],
    filters: only('status', ['open']),
    time: { property: 'created' },
    compare: 'previous_period',
  })),
  widget('template: won opportunities (stat, compared)', () => ({
    source: 'opportunities',
    measures: ['count', 'value'],
    filters: only('status', ['won']),
    time: { property: 'closed' },
    compare: 'previous_period',
  })),
  widget('template: funnel by stage of a pipeline', (_range, business) => ({
    source: 'opportunities',
    measures: ['count', 'value'],
    groupBy: ['stage'],
    order: { by: 'group', direction: 'asc' },
    filters: only('pipeline', [toPublicId('pipeline', business.pipelineId)]),
    compare: 'previous_period',
  })),
  widget('template: leads by session source', () => ({
    source: 'contacts',
    measures: ['count'],
    groupBy: ['sessionSource'],
    compare: 'previous_period',
  })),
  widget('template: won value by session source', () => ({
    source: 'opportunities',
    measures: ['value', 'count'],
    groupBy: ['sessionSource'],
    filters: only('status', ['won']),
    time: { property: 'closed' },
    compare: 'previous_period',
  })),
  widget('template: leads over time', (range) => ({
    source: 'contacts',
    measures: ['count'],
    time: { grain: range.grain },
    compare: 'previous_period',
  })),
  widget('template: appointments by status', () => ({
    source: 'appointments',
    measures: ['count'],
    groupBy: ['status'],
    order: { by: 'group', direction: 'asc' },
    compare: 'previous_period',
  })),
  widget('contacts by tag', () => ({ source: 'contacts', measures: ['count'], groupBy: ['tag'] })),
  widget('contacts by owner', () => ({
    source: 'contacts',
    measures: ['count'],
    groupBy: ['owner'],
  })),
  widget('contacts with a tag, by week', (_range, business) => ({
    source: 'contacts',
    measures: ['count'],
    time: { grain: 'week' },
    filters: only('tag', [toPublicId('tag', business.tagId)]),
  })),
  widget('contacts whose source contains "ad"', () => ({
    source: 'contacts',
    measures: ['count'],
    groupBy: ['source'],
    filters: {
      match: 'all',
      groups: [
        { match: 'all', conditions: [{ field: 'source', operator: 'contains', value: 'ad' }] },
      ],
    },
  })),
  widget('contacts by UTM source and campaign (latest touch)', () => ({
    source: 'contacts',
    measures: ['count'],
    groupBy: ['utmSource', 'utmCampaign'],
    attribution: 'latest',
  })),
  widget('every touch by session source, with contacts', () => ({
    source: 'attribution',
    measures: ['touches', 'contacts'],
    groupBy: ['sessionSource'],
    attribution: 'all',
  })),
  widget('opportunities by owner, average value', () => ({
    source: 'opportunities',
    measures: ['count', 'averageValue'],
    groupBy: ['owner'],
  })),
  widget('opportunities by lost reason', () => ({
    source: 'opportunities',
    measures: ['count'],
    groupBy: ['lostReason'],
    time: { property: 'statusChanged' },
    filters: only('status', ['lost']),
  })),
  widget('appointments by calendar, by week', (range) => ({
    source: 'appointments',
    measures: ['count'],
    groupBy: ['calendar'],
    time: { grain: range.grain === 'day' ? 'week' : 'month' },
  })),
  widget('appointments by weekday and team member', () => ({
    source: 'appointments',
    measures: ['count'],
    groupBy: ['weekday', 'assignee'],
  })),
  {
    key: 'fixed: Appointment report',
    kind: 'fixed',
    operationId: 'getAppointmentOverview',
    request: (range) => ({ query: presetQuery(range.range) }),
  },
  {
    key: 'fixed: Attribution report',
    kind: 'fixed',
    operationId: 'getAttributionReport',
    request: (range) => ({ query: presetQuery(range.range) }),
  },
];

// Running them -------------------------------------------------------------------------------

/** The server's options for the module (api-routes.ts), without the per-person limit. */
const options: ReportingOptions = {
  members: {
    resolve: taskOptions.assignees.resolve,
    memberships: taskOptions.assignees.memberships,
  },
  people: { names: readUserNames },
  limits: { queriesPerMinute: 1_000_000 },
};
const routes: readonly ApiRoute[] = createReportingRoutes(options);

async function runCase(each: Case, range: RangeCase, business: Business): Promise<unknown> {
  const route = routes.find((candidate) => candidate.endpoint.operationId === each.operationId);
  if (route === undefined) throw new Error(`No route for ${each.operationId}.`);
  const request = each.request(range, business);
  return route.run(
    {
      invocation: {
        ...business.invocation,
        context: { ...business.invocation.context, correlationId: randomUUID() },
      },
      params: {},
      query: request.query ?? {},
      body: request.body,
    },
    { db, authorize: allowEveryone },
  );
}

const round = (value: number): number => Number(value.toFixed(1));

interface Measured {
  readonly case: string;
  readonly kind: Case['kind'];
  readonly range: string;
  readonly runs: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly statements: number;
  /** The slowest statements of a traced run, slowest first. */
  readonly slowest: readonly { readonly ms: number; readonly sql: string }[];
}

async function measure(each: Case, range: RangeCase): Promise<Measured & { traced: Statement[] }> {
  // Two runs to warm the plan and the pages, then one traced, then the timed runs.
  await runCase(each, range, large);
  await runCase(each, range, large);
  trace = [];
  await runCase(each, range, large);
  const traced = trace;
  trace = undefined;
  const times: number[] = [];
  const began = performance.now();
  while (
    times.length < RUNS &&
    (times.length < MIN_RUNS || performance.now() - began < CASE_BUDGET_MS)
  ) {
    const started = performance.now();
    await runCase(each, range, large);
    times.push(performance.now() - started);
  }
  return {
    case: each.key,
    kind: each.kind,
    range: range.key,
    runs: times.length,
    p50: round(percentile(times, 0.5)),
    p95: round(percentile(times, 0.95)),
    max: round(Math.max(...times)),
    statements: traced.length,
    slowest: [...traced]
      .sort((left, right) => right.ms - left.ms)
      .slice(0, 3)
      .map((statement) => ({
        ms: round(statement.ms),
        sql: statement.sql.replaceAll(/\s+/g, ' ').slice(0, 160),
      })),
    traced,
  };
}

/** EXPLAIN (ANALYZE, BUFFERS) of a statement, as crm_app in the business's transaction. */
async function explain(statement: Statement): Promise<string> {
  return withTenant(db, large.invocation.context, async (trx) => {
    const result = await trx.executeQuery<{ 'QUERY PLAN': string }>(
      CompiledQuery.raw(`explain (analyze, buffers, settings) ${statement.sql}`, [
        ...statement.parameters,
      ]),
    );
    return result.rows.map((row) => row['QUERY PLAN']).join('\n');
  });
}

it('measures every report at the size of a large business', async () => {
  const sizes = await database.as('crm_owner', (sql) =>
    sql.query<{ table: string; rows: string }>(
      `select 'contacts' as table, count(*)::text as rows from crm.contacts where business_id = $1
       union all select 'touches', count(*)::text from crm.contact_attributions where business_id = $1
       union all select 'tags on contacts', count(*)::text from crm.record_tags where business_id = $1
       union all select 'opportunities', count(*)::text from crm.deals where business_id = $1
       union all select 'appointments', count(*)::text from calendar.appointments where business_id = $1
       union all select 'every business: contacts', count(*)::text from crm.contacts
       union all select 'database size', pg_size_pretty(pg_database_size(current_database()))`,
      [large.id],
    ),
  );
  process.stdout.write(`${JSON.stringify(sizes)}\n`);

  const results: (Measured & { traced: Statement[] })[] = [];
  for (const range of RANGES)
    for (const each of CASES) {
      const result = await measure(each, range);
      results.push(result);
      process.stdout.write(
        `${result.range.padEnd(15)} ${result.case.padEnd(55)} p50 ${String(result.p50).padStart(7)}  p95 ${String(result.p95).padStart(7)}  (${String(result.statements)} statements)\n`,
      );
    }

  // A report's first page as the browser opens it: its widgets at once, on the pool of ten.
  const page = CASES.filter((each) => each.key.startsWith('template:'));
  const pages: { range: string; widgets: number; p50: number; p95: number }[] = [];
  for (const range of RANGES) {
    const times: number[] = [];
    for (let run = 0; run < 12; run += 1) {
      const started = performance.now();
      await Promise.all(page.map((each) => runCase(each, range, large)));
      if (run >= 2) times.push(performance.now() - started);
    }
    pages.push({
      range: range.key,
      widgets: page.length,
      p50: round(percentile(times, 0.5)),
      p95: round(percentile(times, 0.95)),
    });
  }

  // The plans of the slowest statements of each case over budget, at its longest range.
  const over = results.filter(
    (each) => each.p95 > (each.kind === 'widget' ? WIDGET_BUDGET_MS : FIXED_BUDGET_MS),
  );
  const plans: string[] = [];
  const explained = new Set<string>();
  for (const each of over) {
    const [slowest] = [...each.traced].sort((left, right) => right.ms - left.ms);
    if (slowest === undefined || explained.has(slowest.sql)) continue;
    explained.add(slowest.sql);
    plans.push(
      `== ${each.case} / ${each.range}: ${String(round(slowest.ms))} ms of p95 ${String(each.p95)} ms\n` +
        `${slowest.sql}\n-- parameters: ${JSON.stringify(slowest.parameters)}\n${await explain(slowest)}\n`,
    );
  }
  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(
    new URL('../reports/bench-reports-plans.txt', import.meta.url),
    plans.length === 0 ? 'Nothing was over budget.\n' : plans.join('\n'),
  );

  report('bench-reports', {
    machine: machine(),
    sizes: Object.fromEntries(sizes.map((row) => [row.table, row.rows])),
    budgetMs: { widgetP95: WIDGET_BUDGET_MS, fixedReportP95: FIXED_BUDGET_MS },
    results: results.map(({ traced: _traced, ...rest }) => rest),
    firstPage: pages,
    overBudget: over.map((each) => `${each.range}: ${each.case} p95 ${String(each.p95)} ms`),
  });

  // Every case answered: a refusal (a timeout, a limit) would have thrown above.
  expect(results).toHaveLength(RANGES.length * CASES.length);
});
