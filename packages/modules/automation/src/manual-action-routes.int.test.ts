// The manual actions routes as the server runs them: every operation, each answer checked
// against the schema the API documents, and the permission each caller is held to. Real
// Postgres.
import { createHash, randomUUID } from 'node:crypto';
import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  manualAction,
  manualActionEndpoints,
  manualActionList,
  permissions,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createManualActionRoutes } from './manual-action-routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let routes: readonly ApiRoute[];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  // Tenancy's part, stood in for: nobody is on a team but the caller, as "me".
  routes = createManualActionRoutes({
    actorNames: { user: (_trx, ids) => Promise.resolve(new Map(ids.map((id) => [id, 'Mia']))) },
    assignees: {
      resolve: (_trx, context, selection) =>
        Promise.resolve(selection === 'me' ? (context.userId ?? null) : null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: (_trx, _context, userIds) =>
        Promise.resolve(new Map(userIds.map((id) => [id, toPublicId('membership', id)]))),
    },
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const everythingBut = (...denied: Permission[]): ReadonlySet<Permission> =>
  new Set(permissions.filter((each) => !denied.includes(each)));

/** A business with a pending call for one of its contacts, added directly. */
async function queued() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const contact = await database.fixtures.contact(business.context, { firstName: 'Ada' });
  const as = (granted: Invocation['permissions'] = 'all'): Invocation => ({
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: granted,
  });
  const add = () =>
    database.withTenant(business.context, async (sql) => {
      const automation = await sql.one<{ id: string }>(
        `insert into automation.automations (business_id, name, draft, created_by_kind)
         values (app.business_id(), $1, '{}', 'system') returning id`,
        [`Calls ${randomUUID()}`],
      );
      const version = await sql.one<{ id: string }>(
        `insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
         values (app.business_id(), $1, 1, '{}', 'system') returning id`,
        [automation.id],
      );
      const enrolment = await sql.one<{ id: string }>(
        `insert into automation.enrolments
           (business_id, automation_id, version_id, record_id, status, reentry_key, current_step, correlation_id)
         values (app.business_id(), $1, $2, $3, 'waiting', uuidv7(), 'call', uuidv7()) returning id`,
        [automation.id, version.id, contact.id],
      );
      const action = await sql.one<{ id: string }>(
        `insert into automation.manual_actions
           (business_id, automation_id, enrolment_id, step_key, contact_id, kind, body)
         values (app.business_id(), $1, $2, 'call', $3, 'call', 'Ask about the quote') returning id`,
        [automation.id, enrolment.id, contact.id],
      );
      return {
        actionId: toPublicId('manual_action', action.id),
        revision: createHash('sha256')
          .update(JSON.stringify([action.id, 'pending', null]))
          .digest('hex'),
      };
    });
  return { as, add };
}

/** Calls a route as the server does, and checks the answer against its documented schema. */
async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`No route for ${operationId}.`);
  const answer = await route.run(
    {
      invocation,
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    services,
  );
  const schema = route.endpoint.response.schema;
  if (schema === undefined) throw new Error(`${operationId} documents no response.`);
  return schema.parse(answer);
}

it('serves every manual action operation the contract lists, once each, with its command', () => {
  expect(routes.map((route) => route.endpoint)).toHaveLength(manualActionEndpoints.length);
  expect(new Set(routes.map((route) => route.endpoint))).toEqual(new Set(manualActionEndpoints));
  expect(
    routes
      .map((route) => [route.endpoint.operationId, route.command?.name, route.command?.permission])
      .sort(([left = ''], [right = '']) => left.localeCompare(right)),
  ).toEqual([
    ['assignManualAction', 'manual_action.assign', 'conversations.manage'],
    ['completeManualAction', 'manual_action.complete', 'conversations.manage'],
    ['getManualAction', undefined, undefined],
    ['listManualActions', undefined, undefined],
    ['skipManualAction', 'manual_action.skip', 'conversations.manage'],
  ]);
});

it('takes someone from the queue through taking an action, completing it and skipping another', async () => {
  const { as, add } = await queued();
  const first = await add();
  const second = await add();
  const listed = manualActionList.parse(
    await call('listManualActions', as(), { query: { type: 'call', limit: '1' } }),
  );
  expect(listed).toMatchObject({ total: 2, canWork: true, canAssign: true });
  expect(listed.items).toHaveLength(1);
  expect(listed.next).not.toBeNull();
  const read = manualAction.parse(
    await call('getManualAction', as(), { params: { actionId: first.actionId } }),
  );
  expect(read).toMatchObject({
    id: first.actionId,
    type: 'call',
    status: 'pending',
    body: 'Ask about the quote',
    contact: { name: 'Ada', phone: null },
    assignee: null,
    revision: first.revision,
  });
  const mine = manualAction.parse(
    await call('assignManualAction', as(), {
      params: { actionId: first.actionId },
      body: { assignee: 'me', revision: first.revision },
    }),
  );
  expect(mine.assignee).toMatchObject({ name: 'Mia', you: true });
  await expect(
    call('completeManualAction', as(), {
      params: { actionId: first.actionId },
      body: { revision: first.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    await call('completeManualAction', as(), {
      params: { actionId: first.actionId },
      body: { revision: mine.revision },
    }),
  ).toMatchObject({ status: 'completed', closedBy: { name: 'Mia', you: true } });
  expect(
    await call('skipManualAction', as(), {
      params: { actionId: second.actionId },
      body: { revision: second.revision },
    }),
  ).toMatchObject({ status: 'skipped' });
  expect(await call('listManualActions', as())).toMatchObject({ items: [], total: 0 });
  expect(await call('listManualActions', as(), { query: { status: 'all' } })).toMatchObject({
    total: 2,
  });
});

it('lets someone who only replies work the queue under their own permission', async () => {
  const { as, add } = await queued();
  const { actionId, revision } = await add();
  const replier = as(everythingBut('conversations.manage'));
  expect(await call('listManualActions', replier)).toMatchObject({
    total: 1,
    canWork: true,
    canAssign: false,
  });
  const taken = manualAction.parse(
    await call('assignManualAction', replier, {
      params: { actionId },
      body: { assignee: 'me', revision },
    }),
  );
  expect(
    await call('completeManualAction', replier, {
      params: { actionId },
      body: { revision: taken.revision },
    }),
  ).toMatchObject({ status: 'completed' });
  const another = await add();
  expect(
    await call('skipManualAction', replier, {
      params: { actionId: another.actionId },
      body: { revision: another.revision },
    }),
  ).toMatchObject({ status: 'skipped' });
});

it('refuses someone who does not work conversations everything, reads included', async () => {
  const { as, add } = await queued();
  const { actionId, revision } = await add();
  const viewer = as(everythingBut('conversations.manage', 'conversations.reply'));
  const requests: readonly (readonly [string, object])[] = [
    ['listManualActions', {}],
    ['getManualAction', { params: { actionId } }],
    ['assignManualAction', { params: { actionId }, body: { assignee: null, revision } }],
    ['completeManualAction', { params: { actionId }, body: { revision } }],
    ['skipManualAction', { params: { actionId }, body: { revision } }],
  ];
  for (const [operationId, request] of requests)
    await expect(call(operationId, viewer, request), operationId).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  expect(await call('getManualAction', as(), { params: { actionId } })).toMatchObject({
    status: 'pending',
    revision,
  });
});

it('refuses an id of another kind in a path, and says an action is not found by name', async () => {
  const { as } = await queued();
  const wrong = toPublicId('task', '01900000-0000-7000-8000-00000000000a');
  const missing = toPublicId('manual_action', '01900000-0000-7000-8000-00000000000a');
  for (const operationId of [
    'getManualAction',
    'assignManualAction',
    'completeManualAction',
    'skipManualAction',
  ]) {
    await expect(
      call(operationId, as(), { params: { actionId: wrong }, body: {} }),
      operationId,
    ).rejects.toBeInstanceOf(ValidationError);
    const revision = 'f'.repeat(64);
    await expect(
      call(operationId, as(), {
        params: { actionId: missing },
        body: operationId === 'assignManualAction' ? { assignee: null, revision } : { revision },
      }),
      operationId,
    ).rejects.toBeInstanceOf(NotFoundError);
  }
});
