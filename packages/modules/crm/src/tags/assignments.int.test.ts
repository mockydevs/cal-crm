import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { deal, recordTag, recordTagList, tag, type RecordTag } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  actorKinds,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
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
  const user = await database.fixtures.user();
  return {
    context: {
      ...business.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
}
async function call(
  operationId: string,
  invocation: Invocation,
  params: Record<string, string> = {},
  body?: unknown,
) {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query: {} }, services);
}
async function fixture(kind: 'contact' | 'deal' = 'contact') {
  const invocation = await inBusiness();
  const created = tag.parse(await call('createTag', invocation, {}, { name: 'VIP' }));
  if (kind === 'contact')
    return {
      invocation,
      tagId: created.id,
      id: toPublicId('contact', (await database.fixtures.contact(invocation.context)).id),
    };
  const stage = await database.withTenant(invocation.context, async (sql) => {
    const pipeline = await sql.one<{ id: string }>(
      "insert into crm.pipelines (business_id, name) values ($1, 'Assignments') returning id",
      [invocation.context.businessId],
    );
    return {
      pipelineId: pipeline.id,
      ...(await sql.one<{ id: string }>(
        "insert into crm.pipeline_stages (business_id, pipeline_id, name, position) values ($1, $2, 'New', 0) returning id",
        [invocation.context.businessId, pipeline.id],
      )),
    };
  });
  const createdDeal = deal.parse(
    await call(
      'createDeal',
      invocation,
      {},
      {
        name: 'Assigned deal',
        currency: 'KES',
        pipelineId: toPublicId('pipeline', stage.pipelineId),
        stageId: toPublicId('stage', stage.id),
      },
    ),
  );
  return { invocation, tagId: created.id, id: createdDeal.id };
}
const assign = async (
  invocation: Invocation,
  id: string,
  tagId: string,
  body: unknown = {},
): Promise<RecordTag> =>
  recordTag.parse(await call('assignRecordTag', invocation, { id, tagId }, body));

it.each(['contact', 'deal'] as const)(
  'records an idempotent %s assignment, its trusted source, cause and timeline',
  async (kind) => {
    const { invocation, id, tagId } = await fixture(kind);
    const origin = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        "select id from events.events where subject_id = $1 and type = 'tag.created'",
        [parsePublicId('tag', tagId)],
      ),
    );
    const caused: Invocation = { ...invocation, causationId: origin.id };
    const [first, repeated] = await Promise.all([
      assign(caused, id, tagId),
      assign(caused, id, tagId),
    ]);
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ tag: { id: tagId }, source: { kind: 'user', you: true } });
    expect(first.source.eventId).not.toBeNull();
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ source_kind: string; source_id: string; source_event_id: string }>(
        'select source_kind, source_id, source_event_id from crm.record_tags where record_id = $1',
        [parsePublicId(kind, id)],
      ),
    );
    expect(rows).toEqual([
      {
        source_kind: 'user',
        source_id: invocation.context.actorId,
        source_event_id: parsePublicId('event', first.source.eventId ?? ''),
      },
    ]);
    const event = await database.as('crm_owner', (sql) =>
      sql.one<{ causation_id: string }>('select causation_id from events.events where id = $1', [
        parsePublicId('event', first.source.eventId ?? ''),
      ]),
    );
    expect(event.causation_id).toBe(origin.id);
    expect(recordTagList.parse(await call('getRecordTags', invocation, { id }))).toEqual({
      items: [first],
      canManage: true,
    });
    await call('removeRecordTag', invocation, { id, tagId });
    await call('removeRecordTag', invocation, { id, tagId });
    expect(recordTagList.parse(await call('getRecordTags', invocation, { id })).items).toEqual([]);
    const timeline = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string }>(
        "select e.type from crm.timeline_entries t join events.events e on e.id = t.event_id and e.recorded_at = t.event_recorded_at where t.record_id = $1 and e.type in ('tag.assigned', 'tag.removed') order by e.id",
        [parsePublicId(kind, id)],
      ),
    );
    expect(timeline.map((entry) => entry.type)).toEqual(['tag.assigned', 'tag.removed']);
  },
);

it.each(actorKinds)(
  'permits %s to apply an existing tag and keeps its provenance',
  async (actorKind) => {
    const { invocation, id, tagId } = await fixture();
    const actor: Invocation = {
      ...invocation,
      context: { ...invocation.context, actorKind },
      permissions: new Set(['tags.manage']),
    };
    const assignment = await assign(actor, id, tagId);
    expect(assignment.source).toMatchObject({ kind: actorKind, you: actorKind === 'user' });
    await call('removeRecordTag', actor, { id, tagId });
  },
);

it('never accepts caller-selected provenance or assigns an unknown tag name', async () => {
  const { invocation, id, tagId } = await fixture();
  await expect(assign(invocation, id, tagId, { sourceKind: 'system' })).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(assign(invocation, id, 'New tag')).rejects.toBeInstanceOf(ValidationError);
  expect(recordTagList.parse(await call('getRecordTags', invocation, { id })).items).toEqual([]);
});

it('isolates records, definitions and assignments between businesses before validating the body', async () => {
  const a = await fixture();
  const b = await fixture();
  await assign(b.invocation, b.id, b.tagId);
  await expect(call('getRecordTags', a.invocation, { id: b.id })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(assign(a.invocation, a.id, b.tagId)).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    assign(a.invocation, b.id, a.tagId, { sourceKind: 'system' }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('removeRecordTag', a.invocation, { id: b.id, tagId: b.tagId }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(
    recordTagList.parse(await call('getRecordTags', a.invocation, { id: a.id })).items,
  ).toEqual([]);
});

it.each(['contact', 'deal'] as const)(
  'retains a trashed %s’s tags but refuses assignment or removal',
  async (kind) => {
    const { invocation, id, tagId } = await fixture(kind);
    const assigned = await assign(invocation, id, tagId);
    await database.withTenant(invocation.context, (sql) =>
      sql.query(
        kind === 'contact'
          ? 'update crm.contacts set deleted_at = now() where id = $1'
          : 'update crm.deals set deleted_at = now() where id = $1',
        [parsePublicId(kind, id)],
      ),
    );
    expect(recordTagList.parse(await call('getRecordTags', invocation, { id }))).toEqual({
      items: [assigned],
      canManage: false,
    });
    await expect(assign(invocation, id, tagId)).rejects.toBeInstanceOf(ConflictError);
    await expect(call('removeRecordTag', invocation, { id, tagId })).rejects.toBeInstanceOf(
      ConflictError,
    );
  },
);

it('permits daily-work members, while viewers and configuration-only keys cannot change assignments', async () => {
  const { invocation, id, tagId } = await fixture();
  for (const permissions of [
    new Set<'tags.configure'>(['tags.configure']),
    new Set<'tags.configure'>(),
  ]) {
    const reader = { ...invocation, permissions };
    expect(recordTagList.parse(await call('getRecordTags', reader, { id })).canManage).toBe(false);
    await expect(assign(reader, id, tagId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(call('removeRecordTag', reader, { id, tagId })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  }
  await assign({ ...invocation, permissions: new Set(['tags.manage']) }, id, tagId);
});

it('waits for an in-flight trash change, then refuses to tag the trashed contact', async () => {
  const { invocation, id, tagId } = await fixture();
  const updated = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const trash = database.withTenant(invocation.context, async (sql) => {
    await sql.query('update crm.contacts set deleted_at = now() where id = $1', [
      parsePublicId('contact', id),
    ]);
    updated.resolve(undefined);
    await release.promise;
  });
  await updated.promise;
  const assignment = assign(invocation, id, tagId).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  try {
    // Observe PostgreSQL's lock wait, rather than relying on a scheduling delay.
    await expect
      .poll(
        async () => {
          const row = await database.as('crm_app', (sql) =>
            sql.one<{ waiting: boolean }>(
              "select exists(select from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%contacts%') as waiting",
            ),
          );
          return row.waiting;
        },
        { timeout: 1000 },
      )
      .toBe(true);
  } finally {
    release.resolve(undefined);
    await trash;
  }
  expect((await assignment).error).toBeInstanceOf(ConflictError);
  expect(recordTagList.parse(await call('getRecordTags', invocation, { id })).items).toEqual([]);
});
