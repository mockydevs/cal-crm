import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { tagGroup, tagGroupList, type TagGroup } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
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
function call(
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  params: Record<string, string> = {},
) {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query: {} }, services);
}
const editing = (group: TagGroup) => ({
  name: group.name,
  description: group.description,
  revision: group.revision,
});

it('creates and edits described groups with audit and change events', async () => {
  const invocation = await inBusiness();
  const created = tagGroup.parse(
    await call('createTagGroup', invocation, {
      name: ' Audience ',
      description: ' People we serve. ',
    }),
  );
  expect(created).toMatchObject({ name: 'Audience', description: 'People we serve.' });
  const saved = tagGroup.parse(
    await call(
      'updateTagGroup',
      invocation,
      { ...editing(created), description: 'Customer segments.' },
      { groupId: created.id },
    ),
  );
  expect(saved.description).toBe('Customer segments.');
  expect(saved.revision).not.toBe(created.revision);
  expect(tagGroupList.parse(await call('getTagGroups', invocation))).toEqual({
    items: [saved],
    canManage: true,
  });
  const events = await database.as('crm_owner', (sql) =>
    sql.query<{ type: string }>(
      'select type from events.events where subject_id = $1 order by id',
      [parsePublicId('tag_group', created.id)],
    ),
  );
  expect(events.map((event) => event.type)).toEqual(['tag_group.created', 'tag_group.updated']);
  const audits = await database.as('crm_owner', (sql) =>
    sql.query<{ command: string }>(
      "select command from audit.commands where correlation_id = $1 and outcome = 'ok' order by id",
      [invocation.context.correlationId],
    ),
  );
  expect(audits.map((audit) => audit.command)).toEqual(['tag_group.create', 'tag_group.update']);
});

it('rejects normalized duplicate names on creation and editing', async () => {
  const invocation = await inBusiness();
  await call('createTagGroup', invocation, { name: 'Audience' });
  await expect(call('createTagGroup', invocation, { name: ' audience ' })).rejects.toBeInstanceOf(
    ValidationError,
  );
  const other = tagGroup.parse(await call('createTagGroup', invocation, { name: 'Services' }));
  await expect(
    call(
      'updateTagGroup',
      invocation,
      { ...editing(other), name: 'AUDIENCE' },
      { groupId: other.id },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('serializes competing edits and refuses the stale revision', async () => {
  const invocation = await inBusiness();
  const group = tagGroup.parse(await call('createTagGroup', invocation, { name: 'Audience' }));
  const results = await Promise.allSettled(
    ['First', 'Second'].map((description) =>
      call('updateTagGroup', invocation, { ...editing(group), description }, { groupId: group.id }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const refused = results.find((result) => result.status === 'rejected');
  expect(refused?.status === 'rejected' ? refused.reason : undefined).toBeInstanceOf(ConflictError);
});

it('keeps group reads and updates inside their business, even for invalid input', async () => {
  const a = await inBusiness();
  const b = await inBusiness();
  const group = tagGroup.parse(await call('createTagGroup', b, { name: 'Private' }));
  expect(tagGroupList.parse(await call('getTagGroups', a)).items).toEqual([]);
  await expect(call('updateTagGroup', a, {}, { groupId: group.id })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(
    call('updateTagGroup', a, editing(group), { groupId: group.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(tagGroupList.parse(await call('getTagGroups', b)).items).toEqual([group]);
});

it('exposes read-only groups to members and viewers, including an empty list', async () => {
  const admin = await inBusiness();
  for (const permissions of [new Set<'tags.manage'>(['tags.manage']), new Set<'tags.manage'>()]) {
    const reader = { ...admin, permissions };
    expect(tagGroupList.parse(await call('getTagGroups', reader))).toEqual({
      items: [],
      canManage: false,
    });
    await expect(call('createTagGroup', reader, { name: 'No rights' })).rejects.toMatchObject({
      permission: 'tags.configure',
    });
  }
});

it.each(['ai_agent', 'automation'] as const)(
  'refuses group creation and editing by %s with full permissions',
  async (actorKind) => {
    const admin = await inBusiness();
    const group = tagGroup.parse(await call('createTagGroup', admin, { name: 'Audience' }));
    const actor: Invocation = { ...admin, context: { ...admin.context, actorKind } };
    await expect(call('createTagGroup', actor, { name: 'Invented' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      call('updateTagGroup', actor, editing(group), { groupId: group.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(tagGroupList.parse(await call('getTagGroups', actor)).canManage).toBe(false);
  },
);

it('requires a selected business for every group operation', async () => {
  const admin = await inBusiness();
  const group = tagGroup.parse(await call('createTagGroup', admin, { name: 'Audience' }));
  const { businessId: _business, ...context } = admin.context;
  const agency = { ...admin, context };
  await expect(call('getTagGroups', agency)).rejects.toThrow('Choose a business first.');
  await expect(call('createTagGroup', agency, { name: 'Audience' })).rejects.toThrow(
    'Choose a business first.',
  );
  await expect(
    call('updateTagGroup', agency, editing(group), { groupId: group.id }),
  ).rejects.toThrow('Choose a business first.');
});
