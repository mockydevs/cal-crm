// The budget for the board's headers and columns and the dashboard's opportunity numbers:
// in a business with 100,000 contacts and 100,000 deals in one pipeline, each read in under
// 200 ms at p95, as crm_app under row-level security. A timing, so it runs alone with `pnpm
// --filter @repo/module-crm test:budget`, as the contact list's budget does, and each p95
// is reported as an annotation.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { dealList, dealStageSummary, opportunityReport } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions } from '../../test/contact-details.js';
import { seedContacts } from '../../test/contacts.js';
import { seedDeals, type SeededPipeline } from '../../test/deals.js';
import { createDealRoutes } from './routes.js';

const COUNT = 100_000;
const RUNS = 25;
const BUDGET_MS = 200;
const DAY = 86_400_000;
// The server hands the team's lookups over, so a row can name its owner.
const dealRoutes = createDealRoutes(detailOptions());

let database: TestDatabase;
let db: Database;
let services: Services;
let invocation: Invocation;
let seeded: SeededPipeline;
/** The database's clock when the deals were written: every range is counted back from it. */
let now: number;
/** A deal far into the busiest column, to page from. */
let deep: string;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  invocation = {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  await seedContacts(database, business.id, COUNT);
  seeded = await seedDeals(database, business.id, COUNT);
  const clock = await database.as('crm_owner', (sql) =>
    sql.one<{ at: Date }>('select now() as at'),
  );
  now = clock.at.getTime();
  const [first] = seeded.stageIds;
  const page = dealList.parse(
    await call('getDeals', {
      pipelineId: seeded.pipelineId,
      stageId: first ?? '',
      status: 'all',
      limit: '200',
    }),
  );
  deep = page.items.at(-1)?.id ?? '';
}, 300_000);

afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function call(operationId: string, query: Record<string, string>): Promise<unknown> {
  const route = dealRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run({ invocation, params: {}, query, body: undefined }, services);
}

/** The 95th percentile of a request's time, in milliseconds, after warming up. */
async function p95<Answer>(request: () => Promise<Answer>): Promise<[number, Answer]> {
  for (let run = 0; run < 3; run += 1) await request();
  const times: number[] = [];
  let answer = await request();
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    answer = await request();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return [times[Math.ceil(RUNS * 0.95) - 1] ?? Number.POSITIVE_INFINITY, answer];
}

/** The range that ends at the seeding and began this many days before it. */
const lastDays = (days: number) => ({
  from: new Date(now - days * DAY).toISOString(),
  to: new Date(now + 1000).toISOString(),
});

describe(`at ${COUNT.toLocaleString('en')} deals in one pipeline`, () => {
  it.for([
    ['open deals', {}, 60_000],
    ['every deal', { status: 'all' }, COUNT],
    ['won deals', { status: 'won' }, 20_000],
  ] as const)(
    `counts and totals the board's columns for %s within ${String(BUDGET_MS)} ms at p95`,
    async ([, filters, expected], { annotate }) => {
      const [time, answer] = await p95(async () =>
        dealStageSummary.parse(
          await call('getDealStageSummary', { pipelineId: seeded.pipelineId, ...filters }),
        ),
      );
      await annotate(`p95 ${time.toFixed(1)} ms`);
      // Every deal of the seed is counted, in its six stages and two currencies.
      expect(answer.count).toBe(expected);
      expect(answer.stages).toHaveLength(6);
      expect(answer.totals.map((total) => total.currency)).toEqual(
        'status' in filters && filters.status === 'won' ? ['KES'] : ['KES', 'USD'],
      );
      expect(time).toBeLessThan(BUDGET_MS);
    },
  );

  it.for([
    ['the first page of a column', {}],
    ['a page deep in a column', { after: 'deep' }],
  ] as const)(`pages %s within ${String(BUDGET_MS)} ms at p95`, async ([, query], { annotate }) => {
    const [first] = seeded.stageIds;
    const [time, page] = await p95(async () =>
      dealList.parse(
        await call('getDeals', {
          pipelineId: seeded.pipelineId,
          stageId: first ?? '',
          status: 'all',
          ...('after' in query ? { after: deep } : {}),
        }),
      ),
    );
    await annotate(`p95 ${time.toFixed(1)} ms`);
    expect(page.items).toHaveLength(100);
    expect(page.next).not.toBeNull();
    expect(time).toBeLessThan(BUDGET_MS);
  });

  // The list's built-in orders and its search, over the whole pipeline.
  it.for([
    ['by name', { sort: 'name' }],
    ['by name from Z, open deals', { sort: 'name', direction: 'desc', status: 'open' }],
    ['by value', { sort: 'value' }],
    ['by value, smallest first, won deals', { sort: 'value', direction: 'asc', status: 'won' }],
    ['by last change', { sort: 'updated' }],
    ['oldest first', { sort: 'created', direction: 'asc' }],
    ['with the contact, owner and tags of each row', { include: 'contact,owner,tags' }],
    ['for a search every deal matches', { q: 'deal', sort: 'name' }],
  ] as const)(
    `pages the list %s, and the page after it, within ${String(BUDGET_MS)} ms at p95`,
    async ([, query], { annotate }) => {
      const read = (after?: string) => async () =>
        dealList.parse(
          await call('getDeals', {
            pipelineId: seeded.pipelineId,
            status: 'all',
            ...query,
            ...(after === undefined ? {} : { after }),
          }),
        );
      const [time, page] = await p95(read());
      expect(page.items).toHaveLength(100);
      const [next, second] = await p95(read(page.next ?? ''));
      await annotate(`p95 ${time.toFixed(1)} ms, then ${next.toFixed(1)} ms`);
      expect(second.items).toHaveLength(100);
      // The second page carries on where the first ended: no deal twice.
      const seen = new Set(page.items.map((item) => item.id));
      expect(second.items.filter((item) => seen.has(item.id))).toEqual([]);
      expect(time).toBeLessThan(BUDGET_MS);
      expect(next).toBeLessThan(BUDGET_MS);
    },
  );

  it(`finds the few deals a search names, and counts them, within ${String(BUDGET_MS)} ms at p95`, async ({
    annotate,
  }) => {
    const [time, page] = await p95(async () =>
      dealList.parse(
        await call('getDeals', { pipelineId: seeded.pipelineId, status: 'all', q: 'Deal 4999' }),
      ),
    );
    const [counted, summary] = await p95(async () =>
      dealStageSummary.parse(
        await call('getDealStageSummary', {
          pipelineId: seeded.pipelineId,
          status: 'all',
          q: 'Deal 4999',
        }),
      ),
    );
    await annotate(`p95 ${time.toFixed(1)} ms, counted in ${counted.toFixed(1)} ms`);
    // "Deal 4999" and "Deal 49990" to "Deal 49999".
    expect(page.items).toHaveLength(11);
    expect(summary.count).toBe(11);
    expect(time).toBeLessThan(BUDGET_MS);
    expect(counted).toBeLessThan(BUDGET_MS);
  });

  it.for([
    ['the last 30 days, by status change', 30, 'status_changed'],
    ['the last 30 days, by creation', 30, 'created'],
    ['the last 90 days, by status change', 90, 'status_changed'],
    // The whole seed: every deal of the pipeline is read and grouped.
    ['the last 365 days, by status change', 365, 'status_changed'],
  ] as const)(
    `answers the dashboard's opportunity numbers for %s within ${String(BUDGET_MS)} ms at p95`,
    async ([, days, dateProperty], { annotate }) => {
      const [time, answer] = await p95(async () =>
        opportunityReport.parse(
          await call('getOpportunityReport', {
            pipelineId: seeded.pipelineId,
            ...lastDays(days),
            dateProperty,
          }),
        ),
      );
      await annotate(`p95 ${time.toFixed(1)} ms, ${String(answer.count)} deals`);
      // A deal every 5 minutes: 288 a day, to within the one the range's edge may cut.
      const expected = Math.min(COUNT, days * 288);
      expect(Math.abs(answer.count - expected)).toBeLessThanOrEqual(1);
      expect(answer.funnel).toHaveLength(6);
      expect(answer.conversion.rate).toBeCloseTo(0.2, 2);
      expect(time).toBeLessThan(BUDGET_MS);
    },
  );
});
