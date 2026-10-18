import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import {
  tag,
  tagConfiguration,
  tagDefinition,
  tagGroup,
  tagRules,
  type TagDefinition,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
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
  body?: unknown,
  params: Record<string, string> = {},
) {
  const route = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query: {} }, services);
}
async function configuration(invocation: Invocation) {
  return tagConfiguration.parse(await call('getTagConfiguration', invocation));
}
const editing = (item: TagDefinition) => ({
  name: item.name,
  description: item.description,
  groupId: item.groupId,
  revision: item.revision,
});

it('enforces the default admin creation policy for empty and populated businesses', async () => {
  const admin = await inBusiness();
  const member: Invocation = { ...admin, permissions: new Set(['tags.manage']) };
  expect(await configuration(admin)).toMatchObject({
    items: [],
    groups: [],
    rules: { creation: 'admins', suggestSimilar: true },
    canManage: true,
    canCreate: true,
  });
  expect(await configuration(member)).toMatchObject({ canManage: false, canCreate: false });
  await expect(
    call('createTag', member, { name: 'Unauthorized definition' }),
  ).rejects.toMatchObject({ permission: 'tags.configure' });
  const current = (await configuration(admin)).rules;
  await call('updateTagRules', admin, { ...current, creation: 'everyone', suggestSimilar: false });
  const made = tag.parse(await call('createTag', member, { name: 'Allowed definition' }));
  expect(made.name).toBe('Allowed definition');
  expect(await configuration(member)).toMatchObject({
    canManage: false,
    canCreate: true,
    rules: { creation: 'everyone', suggestSimilar: false },
  });
  expect(await configuration({ ...admin, permissions: new Set() })).toMatchObject({
    canManage: false,
    canCreate: false,
  });
  await expect(call('updateTagRules', member, current)).rejects.toBeInstanceOf(ForbiddenError);
  const next = (await configuration(admin)).rules;
  await call('updateTagRules', admin, { ...next, creation: 'admins' });
  await expect(call('createTag', member, { name: 'No longer allowed' })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
});

it('uses revision locks for policy changes, including the first saved settings row', async () => {
  const admin = await inBusiness();
  const current = (await configuration(admin)).rules;
  const results = await Promise.allSettled([
    call('updateTagRules', admin, { ...current, creation: 'everyone' }),
    call('updateTagRules', admin, { ...current, suggestSimilar: false }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const failed = results.find((result) => result.status === 'rejected');
  expect(failed?.status === 'rejected' ? failed.reason : undefined).toBeInstanceOf(ConflictError);
  const other = await inBusiness();
  expect((await configuration(other)).rules).toMatchObject({
    creation: 'admins',
    suggestSimilar: true,
  });
});

it('creates, groups, edits and ungroups a definition without changing its public identity', async () => {
  const admin = await inBusiness();
  const group = tagGroup.parse(await call('createTagGroup', admin, { name: 'Audience' }));
  const created = tag.parse(
    await call('createTag', admin, {
      name: 'VIP',
      description: 'Returning customers.',
      groupId: group.id,
    }),
  );
  const initial = (await configuration(admin)).items[0];
  expect(initial).toMatchObject({
    id: created.id,
    groupId: group.id,
    description: 'Returning customers.',
  });
  if (initial === undefined) throw new Error('Missing definition.');
  const saved = tagDefinition.parse(
    await call(
      'updateTag',
      admin,
      { ...editing(initial), name: 'Returning VIP', description: 'Repeat orders.', groupId: null },
      { id: initial.id },
    ),
  );
  expect(saved).toMatchObject({
    id: initial.id,
    name: 'Returning VIP',
    groupId: null,
    description: 'Repeat orders.',
  });
  await expect(
    call('updateTag', admin, editing(initial), { id: initial.id }),
  ).rejects.toBeInstanceOf(ConflictError);
  expect((await configuration(admin)).items).toEqual([saved]);
});

it('rejects duplicate definition names and foreign groups for creation and editing', async () => {
  const admin = await inBusiness();
  const other = await inBusiness();
  const foreign = tagGroup.parse(await call('createTagGroup', other, { name: 'Private group' }));
  await expect(
    call('createTag', admin, { name: 'Outside', groupId: foreign.id }),
  ).rejects.toBeInstanceOf(ValidationError);
  const first = tag.parse(await call('createTag', admin, { name: 'Hot lead' }));
  await call('createTag', admin, { name: 'VIP' });
  const initial = (await configuration(admin)).items.find((item) => item.id === first.id);
  if (initial === undefined) throw new Error('Missing definition.');
  await expect(
    call('updateTag', admin, { ...editing(initial), name: 'vip' }, { id: first.id }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('updateTag', admin, { ...editing(initial), groupId: foreign.id }, { id: first.id }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(call('updateTag', other, {}, { id: first.id })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect((await configuration(other)).items).toEqual([]);
});

it.each(['ai_agent', 'automation'] as const)(
  'refuses %s definition and rule changes even when everyone may create tags',
  async (actorKind) => {
    const admin = await inBusiness();
    const current = (await configuration(admin)).rules;
    const rules = tagRules.parse(
      await call('updateTagRules', admin, { ...current, creation: 'everyone' }),
    );
    await call('createTag', admin, { name: 'VIP' });
    const definition = (await configuration(admin)).items[0];
    if (definition === undefined) throw new Error('Missing definition.');
    const actor: Invocation = { ...admin, context: { ...admin.context, actorKind } };
    expect(await configuration(actor)).toMatchObject({ canManage: false, canCreate: false });
    await expect(call('createTag', actor, { name: 'Invented' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      call('updateTag', actor, editing(definition), { id: definition.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(call('updateTagRules', actor, rules)).rejects.toBeInstanceOf(ForbiddenError);
  },
);

it('requires a business for configuration and rule changes', async () => {
  const admin = await inBusiness();
  const current = (await configuration(admin)).rules;
  const { businessId: _business, ...context } = admin.context;
  const agency = { ...admin, context };
  await expect(configuration(agency)).rejects.toThrow('Choose a business first.');
  await expect(call('updateTagRules', agency, current)).rejects.toThrow('Choose a business first.');
});
