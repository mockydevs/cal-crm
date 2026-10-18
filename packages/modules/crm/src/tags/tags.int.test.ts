import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { tag, tagList } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, parsePublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

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

function route(operationId: string) {
  const found = crmRoutes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) {
    throw new Error(`No route for ${operationId}.`);
  }
  return found;
}

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

const createTag = (invocation: Invocation, body: unknown) =>
  route('createTag').run({ invocation, params: {}, query: {}, body }, services);

const listTags = (invocation: Invocation) =>
  route('listTags').run({ invocation, params: {}, query: {}, body: undefined }, services);

describe('POST /tags (tag.create)', () => {
  it.each(['ai_agent', 'automation'] as const)(
    'refuses tag creation by %s even with full permissions',
    async (actorKind) => {
      const original = await inBusiness();
      const invocation: Invocation = {
        ...original,
        context: { ...original.context, actorKind },
      };
      await expect(createTag(invocation, { name: 'Invented tag' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(tagList.parse(await listTags(original)).items).toEqual([]);
    },
  );
  it('lets the in-app assistant create one exactly where the person it works for could', async () => {
    const person = await inBusiness();
    // As the assistant's job builds it: the person's id, and no actor id of its own.
    const { actorId: _person, ...context } = person.context;
    const copilot = (permissions: Invocation['permissions']): Invocation => ({
      context: { ...context, actorKind: 'ai_agent' },
      permissions,
      agent: 'copilot',
    });
    // Tags are created by whoever configures them, until the business says everyone may.
    await expect(
      createTag(copilot(new Set(['tags.manage'])), { name: 'Wedding lead' }),
    ).rejects.toThrow('Only someone who configures tags may create them');
    const made = tag.parse(
      await createTag(copilot(new Set(['tags.manage', 'tags.configure'])), {
        name: 'Wedding lead',
      }),
    );
    expect(made.name).toBe('Wedding lead');
    // Without the person's own permission it is refused like anyone, naming it.
    await expect(createTag(copilot(new Set()), { name: 'No role' })).rejects.toThrow(
      'it needs tags.manage',
    );
    // Any other assistant still only applies tags that exist, whatever it is allowed.
    await expect(
      createTag({ ...copilot('all'), agent: 'extraction' }, { name: 'Invented by another' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(tagList.parse(await listTags(person)).items.map((item) => item.name)).toEqual([
      'Wedding lead',
    ]);
    // And the business can take building drafts away from it.
    await database.withTenant(person.context, (sql) =>
      sql.query(
        `insert into ai.autonomy_rules (business_id, agent, action, level)
         values (app.business_id(), 'copilot', 'build_draft', 'ask')`,
      ),
    );
    await expect(
      createTag(copilot(new Set(['tags.manage', 'tags.configure'])), { name: 'Held' }),
    ).rejects.toThrow('The assistant may only propose this');
  });
  it("creates the tag and answers with it, in the contract's shape", async () => {
    const invocation = await inBusiness();

    const created = tag.parse(
      await createTag(invocation, { name: '  Hot lead ', description: 'Asked for a quote.' }),
    );

    expect(created).toMatchObject({ name: 'Hot lead', description: 'Asked for a quote.' });
    expect(parsePublicId('tag', created.id)).toBeDefined();
  });

  it('records a tag.created event and an audit row for the change', async () => {
    const invocation = await inBusiness();

    const created = tag.parse(await createTag(invocation, { name: 'VIP' }));

    const [event] = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; payload: unknown }>(
        'select type, payload from events.events where subject_id = $1',
        [parsePublicId('tag', created.id)],
      ),
    );
    expect(event).toEqual({ type: 'tag.created', payload: { name: 'VIP', description: '' } });
    const [audit] = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string }>(
        'select command, outcome from audit.commands where correlation_id = $1',
        [invocation.context.correlationId],
      ),
    );
    expect(audit).toEqual({ command: 'tag.create', outcome: 'ok' });
  });

  it('refuses a name that matches an existing tag, however it is spelled', async () => {
    const invocation = await inBusiness();
    await createTag(invocation, { name: 'Hot lead' });

    const error: unknown = await createTag(invocation, { name: 'hot-lead' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      issues: [{ path: '/name', code: 'taken', message: 'A tag with this name already exists.' }],
    });
  });

  it('needs a business to be chosen', async () => {
    const { context } = await inBusiness();
    const { businessId: _none, ...agencyStaff } = context;

    await expect(
      createTag({ context: agencyStaff, permissions: 'all' }, { name: 'Nowhere' }),
    ).rejects.toThrow('Choose a business first.');
  });

  it('records who made the tag: a person, or the system with no id', async () => {
    const byPerson = await inBusiness();
    const { userId: _user, actorId: _actor, ...rest } = byPerson.context;
    const bySystem: Invocation = { context: { ...rest, actorKind: 'system' }, permissions: 'all' };

    const ids = [
      tag.parse(await createTag(byPerson, { name: 'Picked by Dana' })).id,
      tag.parse(await createTag(bySystem, { name: 'Picked by the system' })).id,
    ].map((id) => parsePublicId('tag', id));

    const makers = await database.as('crm_owner', (sql) =>
      sql.query<{ created_by_kind: string; created_by_id: string | null }>(
        'select created_by_kind, created_by_id from crm.tags where id = any($1) order by name',
        [ids],
      ),
    );
    expect(makers).toEqual([
      { created_by_kind: 'user', created_by_id: byPerson.context.actorId },
      { created_by_kind: 'system', created_by_id: null },
    ]);
  });
});

describe('GET /tags', () => {
  it("lists the business's own tags, by name", async () => {
    const harbor = await inBusiness();
    const bakery = await inBusiness();
    await createTag(harbor, { name: 'wedding' });
    await createTag(harbor, { name: 'Corporate' });
    await createTag(bakery, { name: 'Wholesale' });

    const list = tagList.parse(await listTags(harbor));

    expect(list.items.map((item) => item.name)).toEqual(['Corporate', 'wedding']);
  });

  it('needs a business to be chosen', async () => {
    const { context } = await inBusiness();
    const { businessId: _none, ...agencyStaff } = context;

    await expect(listTags({ context: agencyStaff, permissions: 'all' })).rejects.toThrow(
      'Choose a business first.',
    );
  });
});
