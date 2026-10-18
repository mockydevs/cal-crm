import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { deal, dealList, type Deal } from '@repo/contracts';
import { dealRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});
async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const invocation: Invocation = {
    context: { ...business.context, correlationId: randomUUID(), actorKind: 'system' },
    permissions: 'all',
  };
  const pipeline = await database.withTenant(invocation.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into crm.pipelines (business_id, name, position) values ($1, 'Bookings', 0) returning id",
      [business.id],
    ),
  );
  const stages = await database.withTenant(invocation.context, (sql) =>
    sql.query<{ id: string }>(
      "insert into crm.pipeline_stages (business_id, pipeline_id, name, position) values ($1, $2, 'Enquiry', 0), ($1, $2, 'Quoted', 1) returning id",
      [business.id, pipeline.id],
    ),
  );
  const first = stages[0];
  const second = stages[1];
  if (first === undefined || second === undefined) throw new Error('Missing stages.');
  const input = {
    name: 'Reception',
    pipelineId: toPublicId('pipeline', pipeline.id),
    stageId: toPublicId('stage', first.id),
    amount: '123456789.1234',
    currency: 'KES',
    expectedCloseDate: '2026-12-01',
    status: 'open',
    outcomeReason: null,
  };
  return {
    invocation,
    input,
    secondStageId: toPublicId('stage', second.id),
    businessId: business.id,
  };
}
async function call(
  operation: string,
  invocation: Invocation,
  body?: unknown,
  id?: string,
  query: unknown = {},
): Promise<unknown> {
  const route = dealRoutes.find((item) => item.endpoint.operationId === operation);
  if (route === undefined) throw new Error(`Missing ${operation}`);
  return route.run({ invocation, params: id === undefined ? {} : { id }, body, query }, services);
}
const create = async (invocation: Invocation, body: unknown) =>
  deal.parse(await call('createDeal', invocation, body));
const update = async (invocation: Invocation, current: Deal, changes: object) =>
  deal.parse(
    await call(
      'updateDeal',
      invocation,
      {
        name: current.name,
        pipelineId: current.pipelineId,
        stageId: current.stageId,
        status: current.status,
        amount: current.amount,
        currency: current.currency,
        expectedCloseDate: current.expectedCloseDate,
        outcomeReason: current.outcomeReason,
        revision: current.revision,
        ...changes,
      },
      current.id,
    ),
  );
const history = async (current: Deal) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ stage_id: string; entered_at: string; exited_at: string | null }>(
      'select stage_id, entered_at::text, exited_at::text from crm.deal_stage_history where deal_id = $1 order by entered_at, id',
      [parsePublicId('deal', current.id)],
    ),
  );

it('creates the registry, deal, exact initial history, event and timeline in one tenant transaction', async () => {
  const f = await fixture();
  const current = await create(f.invocation, f.input);
  expect(current).toMatchObject({ ...f.input, canManage: true, closedAt: null });
  expect(await history(current)).toMatchObject([
    { stage_id: parsePublicId('stage', current.stageId), exited_at: null },
  ]);
  const rows = await database.as('crm_owner', (sql) =>
    sql.query<{ event_type: string }>(
      'select event_type from crm.timeline_entries where record_id = $1',
      [parsePublicId('deal', current.id)],
    ),
  );
  expect(rows).toEqual([{ event_type: 'deal.created' }]);
});
it('changes stages with contiguous microsecond-precise history and one open entry', async () => {
  const f = await fixture();
  const original = await create(f.invocation, f.input);
  const changed = await update(f.invocation, original, { stageId: f.secondStageId });
  const entries = await history(changed);
  expect(entries).toHaveLength(2);
  expect(entries[0]?.exited_at).toBe(entries[1]?.entered_at);
  expect(entries.filter((entry) => entry.exited_at === null)).toHaveLength(1);
  await update(f.invocation, changed, { name: 'New name' });
  expect(await history(changed)).toHaveLength(2);
});
it('keeps the closing stage, persists won/lost reasons and clears close details on reopening', async () => {
  const f = await fixture();
  let current = await create(f.invocation, f.input);
  current = await update(f.invocation, current, {
    status: 'won',
    outcomeReason: 'Signed contract.',
  });
  expect(current.closedAt).not.toBeNull();
  expect(current.outcomeReason).toBe('Signed contract.');
  expect(deal.parse(await call('getDeal', f.invocation, undefined, current.id))).toEqual(current);
  current = await update(f.invocation, current, {
    status: 'lost',
    outcomeReason: 'Event cancelled.',
  });
  expect(current.outcomeReason).toBe('Event cancelled.');
  current = await update(f.invocation, current, { status: 'open', outcomeReason: null });
  expect(current.closedAt).toBeNull();
  expect(current.outcomeReason).toBeNull();
  expect(await history(current)).toHaveLength(1);
});
it('serializes competing edits: one wins and the stale edit cannot alter history', async () => {
  const f = await fixture();
  const current = await create(f.invocation, f.input);
  const outcomes = await Promise.allSettled([
    update(f.invocation, current, { stageId: f.secondStageId }),
    update(f.invocation, current, { name: 'Other edit' }),
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const refused = outcomes.find((result) => result.status === 'rejected');
  expect(refused?.status === 'rejected' ? refused.reason : undefined).toBeInstanceOf(ConflictError);
  expect((await history(current)).filter((entry) => entry.exited_at === null)).toHaveLength(1);
});
it('refuses another business, a stage from another pipeline and archived destinations without partial writes', async () => {
  const f = await fixture();
  const foreign = await fixture();
  const current = await create(f.invocation, f.input);
  await expect(call('getDeal', foreign.invocation, undefined, current.id)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(update(foreign.invocation, current, { name: 'Stolen' })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(
    create(f.invocation, { ...f.input, stageId: foreign.input.stageId }),
  ).rejects.toBeInstanceOf(ValidationError);
  await database.as('crm_owner', (sql) =>
    sql.query('update crm.pipeline_stages set archived_at = now() where id = $1', [
      parsePublicId('stage', f.secondStageId),
    ]),
  );
  await expect(update(f.invocation, current, { stageId: f.secondStageId })).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect(await history(current)).toHaveLength(1);
});
it('paginates by stable deal ID with filters and keeps viewers read-only', async () => {
  const f = await fixture();
  const first = await create(f.invocation, f.input);
  await create(f.invocation, { ...f.input, name: 'Second' });
  const list = dealList.parse(
    await call('getDeals', f.invocation, undefined, undefined, { limit: '1', status: 'all' }),
  );
  expect(list.items).toHaveLength(1);
  expect(list.next).not.toBeNull();
  const next = dealList.parse(
    await call('getDeals', { ...f.invocation, permissions: new Set() }, undefined, undefined, {
      after: list.next,
      status: 'all',
    }),
  );
  expect(next.items.map((item) => item.id)).toEqual([first.id]);
  expect(next.items[0]?.canManage).toBe(false);
  expect(next).toMatchObject({ canManage: false });
});

it('filters outcomes and pipelines and excludes trashed deals from lists', async () => {
  const f = await fixture();
  const other = await fixture();
  const won = await create(f.invocation, { ...f.input, status: 'won', outcomeReason: 'Signed.' });
  const open = await create(f.invocation, { ...f.input, name: 'Still open' });
  expect(won.closedAt).not.toBeNull();
  for (const [query, ids] of [
    [{}, [open.id]],
    [{ status: 'won', pipelineId: f.input.pipelineId }, [won.id]],
    [{ status: 'all', pipelineId: other.input.pipelineId }, []],
  ] as const) {
    const result = dealList.parse(
      await call('getDeals', f.invocation, undefined, undefined, query),
    );
    expect(result.items.map((item) => item.id)).toEqual(ids);
    expect(result.next).toBeNull();
  }
  await database.as('crm_owner', (sql) =>
    sql.query('update crm.deals set deleted_at = now() where id = $1', [
      parsePublicId('deal', open.id),
    ]),
  );
  await expect(update(f.invocation, open, { name: 'Trashed' })).rejects.toBeInstanceOf(
    ConflictError,
  );
  expect(dealList.parse(await call('getDeals', f.invocation)).items).toEqual([]);
});

it('lets an existing deal keep an archived stage, refuses stale revisions and records outcome events', async () => {
  const f = await fixture();
  let current = await create(f.invocation, { ...f.input, amount: null, expectedCloseDate: null });
  const original = current;
  await database.as('crm_owner', (sql) =>
    sql.query('update crm.pipeline_stages set archived_at = now() where id = $1', [
      parsePublicId('stage', current.stageId),
    ]),
  );
  current = await update(f.invocation, current, { status: 'lost', outcomeReason: 'Budget.' });
  current = await update(f.invocation, current, { name: 'Renamed' });
  await expect(update(f.invocation, original, { name: 'Stale' })).rejects.toBeInstanceOf(
    ConflictError,
  );
  const events = await database.as('crm_owner', (sql) =>
    sql.query<{ type: string }>(
      'select type from events.events where subject_id = $1 order by recorded_at, id',
      [parsePublicId('deal', current.id)],
    ),
  );
  expect(events.map((event) => event.type)).toEqual([
    'deal.created',
    'deal.updated',
    'deal.lost',
    'deal.updated',
  ]);
  expect(await history(current)).toHaveLength(1);
});
