// "Deal closed in pipeline X" starts when a deal really closes: through the CRM's own
// update command and its bulk action, on real Postgres. Until then deal.won and deal.lost
// said only why, and a trigger filtered by pipeline never matched one.
import { randomUUID } from 'node:crypto';

import { runCommand, type ApiRoute } from '@repo/commands';
import type { AutomationDocumentInput, Deal } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import {
  createDealCommand,
  dealPeopleRoutes,
  seedBusinessDefaults,
  updateDealCommand,
  type DealPeopleOptions,
} from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { withDealClosePlace } from './deal-close-place.js';

let h: Harness;
let bulkRoutes: readonly ApiRoute[];
beforeAll(async () => {
  h = await startHarness();
  // Setting a status asks nothing of the team; only assigning an owner does.
  bulkRoutes = dealPeopleRoutes({
    assignees: {
      resolve: () => Promise.resolve(null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map<string, string>()),
    },
    actorNames: {},
  } as unknown as DealPeopleOptions);
});
afterAll(async () => {
  await h.close();
});

const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});

async function scene() {
  const agency = await h.database.fixtures.agency();
  const suffix = randomUUID().slice(0, 8);
  const staff = { agencyId: agency.id, actorKind: 'system' as const, correlationId: randomUUID() };
  const { id: businessId } = await h.database.withTenant(staff, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $3) returning id',
      [agency.id, `Business ${suffix}`, `business-${suffix}`],
    ),
  );
  const tenant: Tenant = { ...staff, businessId };
  await withTenant(h.db, tenant, (trx) => seedBusinessDefaults(trx, businessId));
  const stageRows = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; pipeline_id: string }>(
      'select id, pipeline_id from crm.pipeline_stages order by position',
    ),
  );
  const pipeline = toPublicId('pipeline', stageRows[0]?.pipeline_id ?? '');
  const stages = stageRows.map((row) => toPublicId('stage', row.id));
  const closed = (
    name: string,
    config: { pipeline?: string; outcome?: 'won' | 'lost' },
  ): AutomationDocumentInput => ({
    name,
    triggers: [{ id: 'closed', type: 'deal.closed', config }],
    start: 'pause',
    steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
  });
  const published = {
    wonHere: await h.publish(tenant, closed('Won here', { pipeline, outcome: 'won' })),
    lostHere: await h.publish(tenant, closed('Lost here', { pipeline, outcome: 'lost' })),
    anyHere: await h.publish(tenant, closed('Closed here', { pipeline })),
    // A pipeline of no business: nothing closes in it.
    elsewhere: await h.publish(
      tenant,
      closed('Closed elsewhere', { pipeline: toPublicId('pipeline', agency.id) }),
    ),
    anywhere: await h.publish(tenant, closed('Closed anywhere', {})),
  };
  const deal = (name: string): Promise<Deal> =>
    runCommand(
      h.services,
      createDealCommand,
      {
        name,
        pipelineId: pipeline,
        stageId: stages[1],
        amount: '1200.00',
        currency: 'USD',
        status: 'open',
        outcomeReason: null,
      },
      all(tenant),
    );
  /** The automations, by name, that have a run for this deal. */
  const started = async (dealId: string): Promise<string[]> => {
    const rows = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ name: string }>(
        `select a.name from automation.enrolments e
         join automation.automations a on a.id = e.automation_id
         where e.record_id = $1 order by a.name`,
        [parsePublicId('deal', dealId)],
      ),
    );
    return rows.map((row) => row.name);
  };
  const lastEvent = async (type: string, dealId: string) => {
    const events = (await h.events(tenant, type)).filter(
      (event) => event.subject_id === parsePublicId('deal', dealId),
    );
    const [row] = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ id: string }>(
        `select id from events.events where type = $1 and subject_id = $2
         order by recorded_at desc, id desc limit 1`,
        [type, parsePublicId('deal', dealId)],
      ),
    );
    if (row === undefined) throw new Error(`No ${type} event.`);
    return { id: row.id, payload: events.at(-1)?.payload ?? {} };
  };
  return { tenant, pipeline, stages, published, deal, started, lastEvent };
}

it('starts a pipeline-filtered workflow when a deal is closed through the update command', async () => {
  const s = await scene();
  const deal = await s.deal('Roof repair');
  await runCommand(
    h.services,
    updateDealCommand,
    {
      id: deal.id,
      revision: deal.revision,
      name: deal.name,
      pipelineId: deal.pipelineId,
      stageId: deal.stageId,
      amount: deal.amount,
      currency: deal.currency,
      expectedCloseDate: deal.expectedCloseDate,
      status: 'won',
      outcomeReason: 'Signed',
    },
    all(s.tenant),
  );
  const event = await s.lastEvent('deal.won', deal.id);
  expect(event.payload).toEqual({
    reason: 'Signed',
    status: 'won',
    pipelineId: s.pipeline,
    stageId: s.stages[1],
    amount: deal.amount,
    currency: 'USD',
  });
  expect(await h.match(s.tenant, event.id)).toMatchObject({ enrolled: 3 });
  expect(await s.started(deal.id)).toEqual(['Closed anywhere', 'Closed here', 'Won here']);
  // The same event matched again starts nothing new.
  expect(await h.match(s.tenant, event.id)).toMatchObject({ enrolled: 0 });
});

it('starts it when deals are closed by the bulk action, each for its own deal', async () => {
  const s = await scene();
  const first = await s.deal('Kitchen');
  const second = await s.deal('Bathroom');
  const bulk = bulkRoutes.find((route) => route.endpoint.operationId === 'bulkUpdateDeals');
  if (bulk === undefined) throw new Error('The bulk route is required.');
  await bulk.run(
    {
      invocation: all(s.tenant),
      params: {},
      query: {},
      body: {
        action: 'set_status',
        ids: [first.id, second.id],
        status: 'lost',
        outcomeReason: 'Too dear',
      },
    },
    h.services,
  );
  for (const deal of [first, second]) {
    const event = await s.lastEvent('deal.lost', deal.id);
    expect(event.payload).toEqual({
      reason: 'Too dear',
      status: 'lost',
      pipelineId: s.pipeline,
      stageId: s.stages[1],
    });
    expect(await h.match(s.tenant, event.id)).toMatchObject({ enrolled: 3 });
    expect(await s.started(deal.id)).toEqual(['Closed anywhere', 'Closed here', 'Lost here']);
  }
});

it('reads the pipeline from the deal for a close recorded before events carried it', async () => {
  const s = await scene();
  const deal = await s.deal('Old close');
  const event = {
    type: 'deal.won',
    subject_kind: 'deal',
    subject_id: parsePublicId('deal', deal.id) ?? '',
  };
  const placed = await withTenant(h.db, s.tenant, (trx) =>
    withDealClosePlace(trx, event, { reason: 'Signed' }),
  );
  expect(placed).toEqual({ reason: 'Signed', pipelineId: s.pipeline, stageId: s.stages[1] });
  // What an event says itself is never replaced, and other events are left alone.
  const own = { reason: null, pipelineId: 'pipe_own' };
  const untouched = await withTenant(h.db, s.tenant, async (trx) => [
    await withDealClosePlace(trx, event, own),
    await withDealClosePlace(trx, { ...event, type: 'deal.reopened' }, { reason: null }),
    await withDealClosePlace(trx, { ...event, subject_id: randomUUID() }, { reason: null }),
    await withDealClosePlace(trx, { ...event, subject_kind: 'contact' }, { reason: null }),
  ]);
  expect(untouched).toEqual([own, { reason: null }, { reason: null }, { reason: null }]);
});
