// The numbers of the Dashboard's opportunity widgets, counted from real deals with fixed
// dates and held against a recount by hand, as crm_app under row-level security. The rules
// that turn the counts into widgets are report-rules.test.ts.
import type { Invocation } from '@repo/commands';
import {
  OPPORTUNITY_REPORT_MAX_DAYS,
  opportunityReport,
  type OpportunityReport,
} from '@repo/contracts';
import { parsePublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { lists, type World } from '../../test/lists-boards.js';

let world: World;
beforeAll(async () => {
  world = await lists(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

interface Place {
  readonly me: Invocation;
  readonly pipelineId: string;
  readonly stageIds: readonly string[];
}
async function pipeline(stages: readonly string[] = ['New', 'Quoted', 'Booked']): Promise<Place> {
  const me = await world.inBusiness();
  return { me, ...(await world.pipeline(me, stages)) };
}
/**
 * A deal with the dates given, written as an import of history would write it: the
 * database dates its status from its close, or else its creation.
 */
async function deal(
  { me, pipelineId }: Place,
  stageId: string | undefined,
  values: {
    status?: 'open' | 'won' | 'lost';
    amount?: string | null;
    currency?: string;
    createdAt: string;
    closedAt?: string;
  },
): Promise<string> {
  const status = values.status ?? 'open';
  const row = await world.database.withTenant(me.context, (sql) =>
    sql.one<{ id: string }>(
      `with record as (
         insert into crm.records (business_id, kind, object_type_id)
         select app.business_id(), 'deal', id from crm.object_types where kind = 'deal'
         returning id)
       insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, amount,
                              status, closed_at, lost_note, created_by_kind, created_at)
       select app.business_id(), id, 'Roof repair', $1, $2, $3, $4, $5, $6::timestamptz, $7,
              'import', $8::timestamptz
       from record returning id`,
      [
        parsePublicId('pipeline', pipelineId),
        parsePublicId('stage', stageId ?? ''),
        values.currency ?? 'KES',
        values.amount === undefined ? '0' : values.amount,
        status,
        values.closedAt ?? null,
        status === 'lost' ? 'Price' : null,
        values.createdAt,
      ],
    ),
  );
  return row.id;
}
const report = async (me: Invocation, query: Record<string, string>): Promise<OpportunityReport> =>
  opportunityReport.parse(await world.call('getOpportunityReport', me, { query }));
const MARCH = { from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z' };
const kes = (amount: string) => [{ currency: 'KES', amount }];

/** Eight deals dated in March 2026 by their status, and three that must not be counted. */
async function march(): Promise<Place> {
  const place = await pipeline();
  const [first, second, third] = place.stageIds;
  await deal(place, first, { amount: '100', createdAt: '2026-03-05T08:00:00Z' });
  await deal(place, first, { amount: '50', currency: 'USD', createdAt: '2026-03-06T08:00:00Z' });
  await deal(place, second, { amount: '200', createdAt: '2026-03-07T08:00:00Z' });
  await deal(place, third, { amount: null, createdAt: '2026-03-08T08:00:00Z' });
  await deal(place, third, {
    status: 'won',
    amount: '1000',
    createdAt: '2026-02-01T08:00:00Z',
    closedAt: '2026-03-10T08:00:00Z',
  });
  await deal(place, second, {
    status: 'won',
    amount: '300',
    createdAt: '2026-03-02T08:00:00Z',
    closedAt: '2026-03-11T08:00:00Z',
  });
  await deal(place, first, {
    status: 'lost',
    amount: '400',
    createdAt: '2026-03-03T08:00:00Z',
    closedAt: '2026-03-12T08:00:00Z',
  });
  await deal(place, second, {
    status: 'lost',
    amount: '70',
    currency: 'USD',
    createdAt: '2026-01-15T08:00:00Z',
    closedAt: '2026-03-13T08:00:00Z',
  });
  // After the range; in the trash; and in another pipeline.
  await deal(place, first, { amount: '999', createdAt: '2026-04-02T08:00:00Z' });
  const trashed = await deal(place, first, { amount: '888', createdAt: '2026-03-09T08:00:00Z' });
  await world.database.withTenant(place.me.context, (sql) =>
    sql.query('update crm.deals set deleted_at = now() where id = $1', [trashed]),
  );
  const other = await world.pipeline(place.me, ['Elsewhere']);
  await deal({ ...place, ...other }, other.stageIds[0], {
    amount: '777',
    createdAt: '2026-03-09T08:00:00Z',
  });
  return place;
}

describe('the opportunity numbers of a pipeline over a range', () => {
  it('equal a recount by hand of the deals whose status changed in the range', async () => {
    const place = await march();
    const [first, second, third] = place.stageIds;
    expect(await report(place.me, { pipelineId: place.pipelineId, ...MARCH })).toEqual({
      pipelineId: place.pipelineId,
      ...MARCH,
      dateProperty: 'status_changed',
      count: 8,
      statuses: [
        {
          status: 'open',
          count: 4,
          totals: [
            { currency: 'KES', amount: '300.0000' },
            { currency: 'USD', amount: '50.0000' },
          ],
        },
        { status: 'won', count: 2, totals: kes('1300.0000') },
        {
          status: 'lost',
          count: 2,
          totals: [
            { currency: 'KES', amount: '400.0000' },
            { currency: 'USD', amount: '70.0000' },
          ],
        },
      ],
      conversion: { won: 2, total: 8, rate: 0.25, wonTotals: kes('1300.0000') },
      funnel: [
        {
          stageId: first,
          name: 'New',
          count: 6,
          totals: [
            { currency: 'KES', amount: '1600.0000' },
            { currency: 'USD', amount: '50.0000' },
          ],
          cumulativeRate: 1,
          nextStepRate: null,
        },
        {
          stageId: second,
          name: 'Quoted',
          count: 4,
          totals: kes('1500.0000'),
          cumulativeRate: 4 / 6,
          nextStepRate: 4 / 6,
        },
        {
          stageId: third,
          name: 'Booked',
          count: 2,
          totals: kes('1000.0000'),
          cumulativeRate: 2 / 6,
          nextStepRate: 2 / 4,
        },
      ],
      stages: [
        {
          stageId: first,
          name: 'New',
          archived: false,
          count: 2,
          totals: [
            { currency: 'KES', amount: '100.0000' },
            { currency: 'USD', amount: '50.0000' },
          ],
        },
        { stageId: second, name: 'Quoted', archived: false, count: 1, totals: kes('200.0000') },
        { stageId: third, name: 'Booked', archived: false, count: 1, totals: kes('0.0000') },
      ],
    });
  });

  it('go by when a deal was created when asked to', async () => {
    const place = await march();
    const created = await report(place.me, {
      pipelineId: place.pipelineId,
      ...MARCH,
      dateProperty: 'created',
    });
    // Created in March: the four open deals, the deal won on the 11th and the one lost on
    // the 12th. The two closed in March but created earlier are not.
    expect(created).toMatchObject({
      dateProperty: 'created',
      count: 6,
      conversion: { won: 1, total: 6, rate: 1 / 6, wonTotals: kes('300.0000') },
    });
    expect(created.statuses.map((status) => [status.status, status.count])).toEqual([
      ['open', 4],
      ['won', 1],
      ['lost', 1],
    ]);
    // January holds only the deal created then, by its creation; by its status it is March's.
    const january = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
    const inJanuary = async (dateProperty: string) =>
      (await report(place.me, { pipelineId: place.pipelineId, ...january, dateProperty })).count;
    expect([await inJanuary('created'), await inJanuary('status_changed')]).toEqual([1, 0]);
  });

  it('take the start of the range in and the end out, to the microsecond', async () => {
    const place = await pipeline(['New']);
    const [stage] = place.stageIds;
    await deal(place, stage, { createdAt: '2026-02-28T23:59:59.999999Z' });
    await deal(place, stage, { createdAt: '2026-03-01T00:00:00.000000Z' });
    await deal(place, stage, { createdAt: '2026-03-31T23:59:59.999999Z' });
    await deal(place, stage, { createdAt: '2026-04-01T00:00:00.000000Z' });
    for (const dateProperty of ['status_changed', 'created'])
      expect(
        (await report(place.me, { pipelineId: place.pipelineId, ...MARCH, dateProperty })).count,
        dateProperty,
      ).toBe(2);
  });

  it('date a reopened deal from its reopening, and a closed one from its close', async () => {
    const place = await pipeline(['New']);
    const id = await deal(place, place.stageIds[0], {
      status: 'won',
      amount: '500',
      createdAt: '2026-01-10T08:00:00Z',
      closedAt: '2026-03-10T08:00:00Z',
    });
    const inMarch = async () =>
      (await report(place.me, { pipelineId: place.pipelineId, ...MARCH })).statuses.map(
        (status) => status.count,
      );
    expect(await inMarch()).toEqual([0, 1, 0]);

    // Reopened now, by the database's clock: read on both sides of the change, so the range
    // that must hold the deal is known whatever day this runs.
    const clock = () =>
      world.database.as('crm_owner', (sql) =>
        sql.one<{ at: Date }>('select clock_timestamp() as at'),
      );
    const before = await clock();
    await world.database.withTenant(place.me.context, (sql) =>
      sql.query(`update crm.deals set status = 'open', closed_at = null where id = $1`, [id]),
    );
    const after = await clock();
    expect(await inMarch()).toEqual([0, 0, 0]);
    const around = {
      pipelineId: place.pipelineId,
      from: before.at.toISOString(),
      // The end is left out of a range, and an instant is cut to its millisecond here.
      to: new Date(after.at.getTime() + 1).toISOString(),
    };
    expect((await report(place.me, around)).statuses.map((status) => status.count)).toEqual([
      1, 0, 0,
    ]);
    // By its creation it never moved.
    const january = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };
    expect(
      (
        await report(place.me, {
          pipelineId: place.pipelineId,
          ...january,
          dateProperty: 'created',
        })
      ).count,
    ).toBe(1);
  });

  it('count a deal where it is today, in an archived stage too', async () => {
    const place = await pipeline(['New', 'Old', 'Booked']);
    const [first, old, last] = place.stageIds;
    await deal(place, first, { amount: '10', createdAt: '2026-03-05T08:00:00Z' });
    await deal(place, old, { amount: '20', createdAt: '2026-03-05T08:00:00Z' });
    await deal(place, last, { amount: '40', createdAt: '2026-03-05T08:00:00Z' });
    await world.database.withTenant(place.me.context, (sql) =>
      sql.query(`update crm.pipeline_stages set archived_at = now() where id = $1`, [
        parsePublicId('stage', old ?? ''),
      ]),
    );
    const answer = await report(place.me, { pipelineId: place.pipelineId, ...MARCH });
    expect(answer.funnel.map((section) => [section.name, section.count, section.totals])).toEqual([
      ['New', 3, kes('70.0000')],
      ['Booked', 1, kes('40.0000')],
    ]);
    expect(answer.stages.map((stage) => [stage.name, stage.archived, stage.count])).toEqual([
      ['New', false, 1],
      ['Old', true, 1],
      ['Booked', false, 1],
    ]);
  });
});

describe('what a read may ask for', () => {
  it("refuses another business's pipeline, and answers none of its numbers", async () => {
    const mine = await pipeline();
    const theirs = await march();
    const refusal = world.call('getOpportunityReport', mine.me, {
      query: { pipelineId: theirs.pipelineId, ...MARCH },
    });
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(refusal).rejects.toMatchObject({
      issues: [{ path: '/pipelineId', code: 'unknown_pipeline' }],
    });
    // The same range in my own pipeline holds nothing of theirs.
    expect(await report(mine.me, { pipelineId: mine.pipelineId, ...MARCH })).toMatchObject({
      count: 0,
      conversion: { won: 0, total: 0, rate: null },
    });
  });

  it(`takes a pipeline and a range of at most ${String(OPPORTUNITY_REPORT_MAX_DAYS)} days, the right way round`, async () => {
    const place = await pipeline();
    const ask = (query: Record<string, string>) =>
      report(place.me, { pipelineId: place.pipelineId, ...query });
    expect((await ask({ from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' })).count).toBe(0);
    for (const query of [
      { from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00.001Z' },
      { from: MARCH.to, to: MARCH.from },
      { from: MARCH.from, to: MARCH.from },
      { from: '2026-03-01', to: '2026-04-01' },
      { from: MARCH.from },
      { ...MARCH, dateProperty: 'closed' },
      { ...MARCH, status: 'open' },
    ])
      await expect(ask(query), JSON.stringify(query)).rejects.toBeInstanceOf(ValidationError);
    await expect(report(place.me, MARCH)).rejects.toBeInstanceOf(ValidationError);
  });

  it('is open to someone who may only look', async () => {
    const place = await march();
    const viewer: Invocation = { ...place.me, permissions: new Set() };
    expect((await report(viewer, { pipelineId: place.pipelineId, ...MARCH })).count).toBe(8);
  });

  it('reads each date from an index on the pipeline and that date', async () => {
    const indexes = await world.database.as('crm_owner', (sql) =>
      sql.query<{ definition: string }>(
        `select pg_get_indexdef(indexrelid) as definition from pg_index
         where indexrelid = any($1::regclass[]) order by indexrelid::regclass::text`,
        [['crm.deals_created_idx', 'crm.deals_status_changed_idx']],
      ),
    );
    expect(indexes.map((index) => index.definition.replace(/^.* USING /, ''))).toEqual([
      'btree (business_id, pipeline_id, created_at) WHERE (deleted_at IS NULL)',
      'btree (business_id, pipeline_id, status_changed_at) WHERE (deleted_at IS NULL)',
    ]);
  });
});
