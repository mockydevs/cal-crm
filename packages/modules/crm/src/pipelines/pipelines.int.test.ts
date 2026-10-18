import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { pipelineConfiguration } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ConflictError, parsePublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { crmRoutes } from '../index.js';

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
async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}
async function call(operationId: string, invocation: Invocation, body?: unknown) {
  const route = crmRoutes.find((item) => item.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return pipelineConfiguration.parse(
    await route.run({ invocation, body, params: {}, query: {} }, services),
  );
}
const initial = [
  {
    name: 'Bookings',
    description: 'Event sales',
    archived: false,
    stages: [
      { name: 'Enquiry', description: 'New enquiries', archived: false },
      { name: 'Quoted', description: 'Quote sent', archived: false },
    ],
  },
];
it('creates, edits, reorders and archives without replacing pipeline or stage IDs', async () => {
  const invocation = await inBusiness();
  const empty = await call('getPipelines', invocation);
  expect((await call('getPipelines', { ...invocation, permissions: new Set() })).canManage).toBe(
    false,
  );
  expect(empty).toMatchObject({ items: [], canManage: true });
  const created = await call('savePipelines', invocation, {
    revision: empty.revision,
    items: initial,
  });
  const first = created.items[0];
  if (first === undefined) throw new Error('Missing pipeline');
  const updated = await call('savePipelines', invocation, {
    revision: created.revision,
    items: [
      {
        ...first,
        name: 'Events',
        stages: first.stages.toReversed().map((stage) => ({ ...stage, archived: true })),
      },
    ],
  });
  expect(updated.items[0]).toMatchObject({
    id: first.id,
    name: 'Events',
    stages: first.stages.toReversed().map((stage) => ({ ...stage, archived: true })),
  });
  expect(await call('getPipelines', invocation)).toEqual(updated);
  const events = await database.as('crm_owner', (sql) =>
    sql.query<{ type: string }>(
      'select type from events.events where business_id = $1 order by id',
      [invocation.context.businessId],
    ),
  );
  expect(events.map((event) => event.type)).toEqual(['pipelines.updated', 'pipelines.updated']);
});
it('rejects a stale concurrent reorder without overwriting the winning edit', async () => {
  const invocation = await inBusiness();
  const empty = await call('getPipelines', invocation);
  const current = await call('savePipelines', invocation, {
    revision: empty.revision,
    items: initial,
  });
  const attempts = await Promise.allSettled(
    ['A', 'B'].map((name) =>
      call('savePipelines', invocation, {
        revision: current.revision,
        items: current.items.map((item) => ({ ...item, name })),
      }),
    ),
  );
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
  const reason: unknown = attempts.find((attempt) => attempt.status === 'rejected')?.reason;
  expect(reason).toBeInstanceOf(ConflictError);
});
it('does not let a different business read or submit existing IDs, or omit historical stages', async () => {
  const owner = await inBusiness();
  const other = await inBusiness();
  const empty = await call('getPipelines', owner);
  const created = await call('savePipelines', owner, { revision: empty.revision, items: initial });
  const foreign = await call('getPipelines', other);
  expect(foreign.items).toEqual([]);
  await expect(
    call('savePipelines', other, { revision: foreign.revision, items: created.items }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('savePipelines', owner, { revision: created.revision, items: [] }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('savePipelines', owner, {
      revision: created.revision,
      items: created.items.map((item) => ({ ...item, stages: [] })),
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(await call('getPipelines', owner)).toEqual(created);
});
it('rejects duplicate live names and restores an archived pipeline', async () => {
  const invocation = await inBusiness();
  const empty = await call('getPipelines', invocation);
  await expect(
    call('savePipelines', invocation, {
      revision: empty.revision,
      items: [...initial, ...initial],
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('savePipelines', invocation, {
      revision: empty.revision,
      items: initial.map((item) => ({ ...item, stages: [...item.stages, ...item.stages] })),
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  const archived = await call('savePipelines', invocation, {
    revision: empty.revision,
    items: initial.map((item) => ({ ...item, archived: true })),
  });
  const restored = await call('savePipelines', invocation, {
    revision: archived.revision,
    items: archived.items.map((item) => ({ ...item, archived: false })),
  });
  expect(restored.items[0]?.archived).toBe(false);
});
it('reorders pipelines, renames stages, swaps names and refuses moving existing stages between pipelines', async () => {
  const invocation = await inBusiness();
  const empty = await call('getPipelines', invocation);
  const created = await call('savePipelines', invocation, {
    revision: empty.revision,
    items: [
      ...initial,
      { ...initial[0], name: 'Renewals', description: '', archived: false, stages: [] },
    ],
  });
  const first = created.items[0];
  const second = created.items[1];
  if (first === undefined || second === undefined) throw new Error('Missing pipelines');
  await expect(
    call('savePipelines', invocation, {
      revision: created.revision,
      items: [first, { ...second, stages: first.stages }],
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  const changed = await call('savePipelines', invocation, {
    revision: created.revision,
    items: [
      { ...second, name: first.name },
      {
        ...first,
        name: second.name,
        stages: first.stages.map((stage, index) => ({
          ...stage,
          name: index === 0 ? 'Quoted' : 'Enquiry',
        })),
      },
    ],
  });
  expect(changed.items.map((item) => item.id)).toEqual([second.id, first.id]);
  expect(changed.items[1]?.stages.map((stage) => stage.name)).toEqual(['Quoted', 'Enquiry']);
});
it('archives a stage that has deals without changing their stage history', async () => {
  const invocation = await inBusiness();
  const empty = await call('getPipelines', invocation);
  const created = await call('savePipelines', invocation, {
    revision: empty.revision,
    items: initial,
  });
  const pipeline = created.items[0];
  const stage = pipeline?.stages[0];
  if (pipeline === undefined || stage === undefined) throw new Error('Missing pipeline stage');
  const businessId = invocation.context.businessId;
  const pipelineId = parsePublicId('pipeline', pipeline.id);
  const stageId = parsePublicId('stage', stage.id);
  const deal = await database.as('crm_owner', async (sql) => {
    const record = await sql.one<{ id: string }>(
      `insert into crm.records (business_id,kind,object_type_id)
       select $1,'deal',id from crm.object_types where business_id=$1 and kind='deal' returning id`,
      [businessId],
    );
    await sql.query(
      `insert into crm.deals (business_id,id,name,pipeline_id,stage_id,currency,created_by_kind)
      values ($1,$2,'Wedding',$3,$4,'USD','system')`,
      [businessId, record.id, pipelineId, stageId],
    );
    await sql.query(
      `insert into crm.deal_stage_history (business_id,deal_id,pipeline_id,stage_id,entered_by_kind,entered_at)
      values ($1,$2,$3,$4,'system',now())`,
      [businessId, record.id, pipelineId, stageId],
    );
    return record;
  });
  await call('savePipelines', invocation, {
    revision: created.revision,
    items: created.items.map((item) => ({
      ...item,
      archived: true,
      stages: item.stages.map((each) => ({ ...each, archived: true })),
    })),
  });
  const history = await database.as('crm_owner', (sql) =>
    sql.query<{ stage_id: string; exited_at: Date | null }>(
      'select stage_id,exited_at from crm.deal_stage_history where business_id=$1 and deal_id=$2',
      [businessId, deal.id],
    ),
  );
  expect(history).toEqual([{ stage_id: stageId, exited_at: null }]);
});
