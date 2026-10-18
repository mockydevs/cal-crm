import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type ApiRoute } from '@repo/commands';
import {
  task,
  taskList,
  taskAssigneeList,
  recordActivity,
  company,
  contact,
  deal,
  pipelineConfiguration,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  toPublicId,
  ConflictError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { taskRoutes, activityRoutes, crmRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  const invocation: Invocation = {
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const record = await database.fixtures.contact(invocation.context, { firstName: 'Maya' });
  return { invocation, id: toPublicId('contact', record.id) };
}

async function call(
  routes: readonly ApiRoute[],
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, { db, authorize: allowEveryone });
}

function unassignedRoutes(): readonly ApiRoute[] {
  return taskRoutes({
    actorNames: {},
    assignees: {
      resolve: (_trx, _context, selection) => {
        if (selection !== null) throw new Error('This fixture only creates unassigned tasks.');
        return Promise.resolve(null);
      },
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map<string, string>()),
    },
  });
}

it('reads eligible assignees through public membership IDs with names and human-only self identity', async () => {
  const { invocation } = await fixture();
  const userId = invocation.context.userId;
  if (userId === undefined) throw new Error('Expected the signed-in user.');
  const other = await database.fixtures.user();
  const firstId = toPublicId('membership', '01900000-0000-7000-8000-000000000002');
  const secondId = toPublicId('membership', '01900000-0000-7000-8000-000000000003');
  const routes = taskRoutes({
    actorNames: { user: () => Promise.resolve(new Map([[userId, 'Dana Brooks']])) },
    assignees: {
      resolve: () => Promise.resolve(null),
      memberships: () => Promise.resolve(new Map()),
      read: (_trx, _context, after) =>
        Promise.resolve(
          after === undefined
            ? { items: [{ id: firstId, userId }], nextCursor: firstId }
            : { items: [{ id: secondId, userId: other.id }], nextCursor: null },
        ),
    },
  });
  const viewer: Invocation = { ...invocation, permissions: new Set() };
  expect(taskAssigneeList.parse(await call(routes, 'listTaskAssignees', viewer))).toEqual({
    items: [{ id: firstId, name: 'Dana Brooks', you: true }],
    nextCursor: firstId,
  });
  expect(
    taskAssigneeList.parse(
      await call(routes, 'listTaskAssignees', invocation, undefined, {}, { after: firstId }),
    ),
  ).toEqual({
    items: [{ id: secondId, name: null, you: false }],
    nextCursor: null,
  });
  const { actorId: _actorId, ...systemContext } = invocation.context;
  const machine: Invocation = {
    ...invocation,
    context: { ...systemContext, actorKind: 'system' },
  };
  expect(
    taskAssigneeList.parse(await call(routes, 'listTaskAssignees', machine)).items[0]?.you,
  ).toBe(false);
});

it('enforces tenant visibility and tasks.manage, and refuses forged or mutable ownership', async () => {
  const { invocation, id: recordId } = await fixture();
  const foreign = await fixture();
  const routes = unassignedRoutes();
  const saved = task.parse(
    await call(routes, 'createTask', invocation, { title: 'Call Maya', recordId }),
  );
  const theirs = task.parse(
    await call(routes, 'createTask', foreign.invocation, {
      title: 'Hidden task',
      recordId: foreign.id,
    }),
  );
  await expect(
    call(routes, 'listTasks', invocation, undefined, {}, { recordId: foreign.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call(routes, 'createTask', invocation, { title: 'Foreign link', recordId: foreign.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
  for (const operation of ['updateTask', 'completeTask', 'deleteTask'])
    await expect(call(routes, operation, invocation, {}, { id: theirs.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  const viewer: Invocation = { ...invocation, permissions: new Set() };
  expect(taskList.parse(await call(routes, 'listTasks', viewer))).toEqual({
    items: [saved],
    canManage: false,
    nextCursor: null,
    total: 1,
  });
  for (const [operation, body] of [
    ['createTask', { title: 'Denied' }],
    [
      'updateTask',
      { title: 'Denied', description: '', dueAt: null, assignee: null, revision: saved.revision },
    ],
    ['completeTask', { completed: true, revision: saved.revision }],
    ['deleteTask', { revision: saved.revision }],
  ] as const)
    await expect(call(routes, operation, viewer, body, { id: saved.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  for (const body of [
    { title: 'Forged creator', createdBy: { kind: 'system' } },
    { title: 'Forged completion', completedAt: '2026-01-01T00:00:00Z' },
    { title: 'Raw user ID', assignee: invocation.context.userId },
  ])
    await expect(call(routes, 'createTask', invocation, body)).rejects.toBeInstanceOf(
      ValidationError,
    );
  await expect(
    call(
      routes,
      'updateTask',
      invocation,
      { title: 'Move record', recordId: foreign.id, revision: saved.revision },
      { id: saved.id },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call(
      routes,
      'completeTask',
      invocation,
      { completed: true, revision: saved.revision, completedBy: { kind: 'system' } },
      { id: saved.id },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  const { businessId: _businessId, ...agencyContext } = invocation.context;
  for (const operation of ['listTasks', 'createTask', 'updateTask', 'completeTask', 'deleteTask'])
    await expect(
      call(routes, operation, { ...invocation, context: agencyContext }, {}, { id: saved.id }),
    ).rejects.toBeInstanceOf(ValidationError);
});

it('creates and mutates tasks for contacts known only by email or phone', async () => {
  const { invocation } = await fixture();
  const routes = [...unassignedRoutes(), ...crmRoutes];
  for (const [input, name] of [
    [{ emails: ['maya@example.test'] }, 'maya@example.test'],
    [{ phones: ['+254712345678'] }, '+254712345678'],
  ] as const) {
    const record = contact.parse(await call(routes, 'createContact', invocation, input));
    const saved = task.parse(
      await call(routes, 'createTask', invocation, { recordId: record.id, title: 'Call customer' }),
    );
    expect(saved.record).toEqual({ id: record.id, name, trashed: false });
    const edited = task.parse(
      await call(
        routes,
        'updateTask',
        invocation,
        {
          title: 'Confirm venue',
          description: '',
          dueAt: null,
          assignee: null,
          revision: saved.revision,
        },
        { id: saved.id },
      ),
    );
    expect(edited.record).toEqual(saved.record);
    const done = task.parse(
      await call(
        routes,
        'completeTask',
        invocation,
        { completed: true, revision: edited.revision },
        { id: saved.id },
      ),
    );
    expect(
      taskList.parse(
        await call(
          routes,
          'listTasks',
          invocation,
          undefined,
          {},
          { recordId: record.id, status: 'all' },
        ),
      ).items,
    ).toEqual([done]);
  }
});

it('filters assignment and overdue work without treating a machine as a signed-in person', async () => {
  const { invocation } = await fixture();
  const userId = invocation.context.userId;
  if (userId === undefined) throw new Error('Expected the signed-in user.');
  const other = await database.fixtures.user({ name: 'Jordan Lee' });
  const membershipId = toPublicId('membership', '01900000-0000-7000-8000-000000000002');
  const names = new Map([
    [userId, 'Dana Brooks'],
    [other.id, 'Jordan Lee'],
  ]);
  const routes = taskRoutes({
    actorNames: {
      user: (_trx, ids) => Promise.resolve(new Map(ids.map((id) => [id, names.get(id) ?? '']))),
    },
    assignees: {
      resolve: (_trx, _context, selection) =>
        Promise.resolve(selection === null ? null : selection === 'me' ? userId : other.id),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map([[other.id, membershipId]])),
    },
  });
  const create = async (title: string, assignee: string | null, dueAt: string | null) =>
    task.parse(await call(routes, 'createTask', invocation, { title, assignee, dueAt }));
  const past = '2001-01-01T12:00:00Z';
  const mine = await create('My overdue call', 'me', past);
  const theirs = await create('Jordan overdue call', membershipId, past);
  const unassigned = await create('Unassigned overdue call', null, past);
  const future = await create('My future call', 'me', '2999-01-01T12:00:00Z');
  const undated = await create('My undated call', 'me', null);
  const completed = await create('My finished call', 'me', past);
  await call(
    routes,
    'completeTask',
    invocation,
    { completed: true, revision: completed.revision },
    { id: completed.id },
  );
  const ids = async (query: Record<string, string>, caller = invocation) =>
    taskList
      .parse(await call(routes, 'listTasks', caller, undefined, {}, query))
      .items.map((item) => item.id);
  expect(await ids({ scope: 'mine' })).toEqual([undated.id, future.id, mine.id]);
  expect(await ids({ scope: 'unassigned' })).toEqual([unassigned.id]);
  expect(await ids({ due: 'overdue' })).toEqual([unassigned.id, theirs.id, mine.id]);
  expect(await ids({ scope: 'mine', due: 'overdue' })).toEqual([mine.id]);
  expect(await ids({ scope: 'mine', status: 'completed' })).toEqual([completed.id]);
  expect(theirs.assignee).toEqual({ membershipId, name: 'Jordan Lee', you: false });
  expect(mine.assignee).toEqual({ membershipId: null, name: 'Dana Brooks', you: true });
  const machine: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorKind: 'api_key', actorId: randomUUID() },
  };
  expect(await ids({ scope: 'mine' }, machine)).toEqual([]);
  const { userId: _userId, ...anonymousContext } = invocation.context;
  expect(await ids({ scope: 'mine' }, { ...invocation, context: anonymousContext })).toEqual([]);
});

it('hides trashed record tasks from the workspace but preserves their read-only record history', async () => {
  const { invocation, id: recordId } = await fixture();
  const routes = [...unassignedRoutes(), ...crmRoutes];
  const linked = task.parse(
    await call(routes, 'createTask', invocation, { recordId, title: 'Call Maya' }),
  );
  const workspace = task.parse(
    await call(routes, 'createTask', invocation, { title: 'Prepare week' }),
  );
  await call(routes, 'trashContact', invocation, undefined, { id: recordId });
  expect(taskList.parse(await call(routes, 'listTasks', invocation)).items).toEqual([workspace]);
  const history = taskList.parse(
    await call(routes, 'listTasks', invocation, undefined, {}, { recordId }),
  );
  expect(history).toEqual({
    items: [{ ...linked, record: { ...linked.record, trashed: true } }],
    canManage: false,
    nextCursor: null,
    total: 1,
  });
  await expect(
    call(routes, 'createTask', invocation, { recordId, title: 'Another call' }),
  ).rejects.toBeInstanceOf(ConflictError);
  for (const [operation, body] of [
    [
      'updateTask',
      { title: 'Changed', description: '', dueAt: null, assignee: null, revision: linked.revision },
    ],
    ['completeTask', { completed: true, revision: linked.revision }],
    ['deleteTask', { revision: linked.revision }],
  ] as const)
    await expect(
      call(routes, operation, invocation, body, { id: linked.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  await call(routes, 'restoreContact', invocation, undefined, { id: recordId });
  expect(taskList.parse(await call(routes, 'listTasks', invocation)).items).toEqual([
    workspace,
    linked,
  ]);
});

it('creates record and workspace tasks, normalizes due dates and reads the record separately', async () => {
  const { invocation, id } = await fixture();
  const routes = unassignedRoutes();
  const saved = task.parse(
    await call(routes, 'createTask', invocation, {
      recordId: id,
      title: '  Confirm the garden venue  ',
      description: 'Ask about rain cover.',
      dueAt: '2026-10-10T10:00:00+03:00',
    }),
  );
  expect(saved).toMatchObject({
    record: { id, name: 'Maya', trashed: false },
    title: 'Confirm the garden venue',
    description: 'Ask about rain cover.',
    dueAt: '2026-10-10T07:00:00.000Z',
    assignee: null,
    completedAt: null,
    completedBy: null,
  });
  const unlinked = task.parse(
    await call(routes, 'createTask', invocation, { title: 'Prepare week' }),
  );
  expect(unlinked).toMatchObject({ record: null, assignee: null, dueAt: null, description: '' });
  expect(taskList.parse(await call(routes, 'listTasks', invocation))).toEqual({
    items: [unlinked, saved],
    canManage: true,
    nextCursor: null,
    total: 2,
  });
  expect(
    taskList.parse(await call(routes, 'listTasks', invocation, undefined, {}, { recordId: id })),
  ).toEqual({ items: [saved], canManage: true, nextCursor: null, total: 1 });
});

it('pages newest tasks after completion and refuses cursors from another business or record', async () => {
  const { invocation, id: recordId } = await fixture();
  const routes = unassignedRoutes();
  const created: string[] = [];
  for (let index = 0; index < 52; index++) {
    const saved = task.parse(
      await call(routes, 'createTask', invocation, { title: `Call ${String(index)}`, recordId }),
    );
    created.push(saved.id);
  }
  const first = taskList.parse(await call(routes, 'listTasks', invocation));
  expect(first.items.map((item) => item.id)).toEqual(created.toReversed().slice(0, 50));
  expect(first.nextCursor).toBe(first.items.at(-1)?.id);
  if (first.nextCursor === null) throw new Error('Expected a second task page.');
  const anchor = first.items.at(-1);
  if (anchor === undefined) throw new Error('Expected the cursor task.');
  await call(
    routes,
    'completeTask',
    invocation,
    { completed: true, revision: anchor.revision },
    { id: anchor.id },
  );
  const second = taskList.parse(
    await call(routes, 'listTasks', invocation, undefined, {}, { after: first.nextCursor }),
  );
  expect(second.items.map((item) => item.id)).toEqual(created.toReversed().slice(50));
  expect(second.nextCursor).toBeNull();
  const foreign = await fixture();
  const foreignTask = task.parse(
    await call(routes, 'createTask', foreign.invocation, { title: 'Hidden task' }),
  );
  const unlinked = task.parse(
    await call(routes, 'createTask', invocation, { title: 'Workspace only' }),
  );
  for (const query of [
    { after: foreignTask.id },
    { after: toPublicId('task', '01900000-0000-7000-8000-000000000001') },
    { recordId, after: unlinked.id },
  ])
    await expect(
      call(routes, 'listTasks', invocation, undefined, {}, query),
    ).rejects.toBeInstanceOf(ValidationError);
});

it('pages imported timestamps at microsecond precision with deterministic id ties', async () => {
  const { invocation } = await fixture();
  const rows = await database.withTenant(invocation.context, (sql) =>
    sql.query<{ id: string; title: string }>(
      `insert into crm.tasks(business_id,title,created_by_kind,created_at)
       select app.business_id(),'Imported ' || n,'system',
         case when n <= 55 then '2001-01-01T12:00:00Z'::timestamptz + n * interval '1 microsecond'
         else '1999-01-01T12:00:00Z'::timestamptz end
       from generate_series(1,60) n returning id,title`,
    ),
  );
  const routes = unassignedRoutes();
  const first = taskList.parse(await call(routes, 'listTasks', invocation));
  if (first.nextCursor === null) throw new Error('Expected another imported task page.');
  const second = taskList.parse(
    await call(routes, 'listTasks', invocation, undefined, {}, { after: first.nextCursor }),
  );
  const expected = [
    ...rows.slice(0, 55).toReversed(),
    ...rows.slice(55).sort((a, b) => b.id.localeCompare(a.id)),
  ];
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(10);
  expect(second.nextCursor).toBeNull();
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
    expected.map((row) => toPublicId('task', row.id)),
  );
});

it('allows only one concurrent edit and keeps private content out of successful and refused audits', async () => {
  const { invocation, id: recordId } = await fixture();
  const routes = unassignedRoutes();
  const saved = task.parse(
    await call(routes, 'createTask', invocation, {
      recordId,
      title: 'Private title',
      description: 'Private venue details.',
    }),
  );
  const writes = await Promise.allSettled(
    ['First private change', 'Second private change'].map((title) =>
      call(
        routes,
        'updateTask',
        invocation,
        {
          title,
          description: 'Private venue details.',
          dueAt: null,
          assignee: null,
          revision: saved.revision,
        },
        { id: saved.id },
      ),
    ),
  );
  expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const failed = writes.find((result) => result.status === 'rejected');
  if (failed?.status !== 'rejected') throw new Error('Expected a stale concurrent update.');
  expect(failed.reason).toBeInstanceOf(ConflictError);
  const viewer: Invocation = { ...invocation, permissions: new Set() };
  await expect(
    call(routes, 'createTask', viewer, { title: 'Private denied title', recordId }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const current = taskList.parse(await call(routes, 'listTasks', invocation)).items[0];
  if (current === undefined) throw new Error('Expected the saved task.');
  const done = task.parse(
    await call(
      routes,
      'completeTask',
      invocation,
      { completed: true, revision: current.revision },
      { id: current.id },
    ),
  );
  await call(routes, 'deleteTask', invocation, { revision: done.revision }, { id: current.id });
  const audits = await database.as('crm_owner', (sql) =>
    sql.query<{ command: string; outcome: string; input: Record<string, unknown> }>(
      "select command,outcome,input from audit.commands where business_id=$1 and command like 'task.%' order by recorded_at,id",
      [invocation.context.businessId],
    ),
  );
  expect(
    audits
      .filter((row) => row.command === 'task.update')
      .map((row) => [row.outcome, Object.keys(row.input)])
      .sort(),
  ).toEqual([
    ['failed', ['id']],
    ['ok', ['id']],
  ]);
  expect(
    audits
      .filter((row) => row.command !== 'task.update')
      .map((row) => [row.command, row.outcome, Object.keys(row.input).sort()]),
  ).toEqual([
    ['task.create', 'ok', ['recordId']],
    ['task.create', 'denied', ['recordId']],
    ['task.complete', 'ok', ['completed', 'id']],
    ['task.delete', 'ok', ['id']],
  ]);
  expect(JSON.stringify(audits)).not.toMatch(/Private|private|revision/);
});

it('links companies and deals, keeps their trash history and trusts machine completion actors', async () => {
  const { invocation } = await fixture();
  const routes = [...unassignedRoutes(), ...crmRoutes];
  const savedCompany = company.parse(
    await call(routes, 'createCompany', invocation, { name: 'Garden venue' }),
  );
  const current = pipelineConfiguration.parse(await call(routes, 'getPipelines', invocation));
  const pipelines = pipelineConfiguration.parse(
    await call(routes, 'savePipelines', invocation, {
      revision: current.revision,
      items: [
        {
          name: 'Events',
          description: '',
          archived: false,
          stages: [{ name: 'New', description: '', archived: false }],
        },
      ],
    }),
  );
  const pipeline = pipelines.items[0];
  const stage = pipeline?.stages[0];
  if (pipeline === undefined || stage === undefined) throw new Error('Expected the pipeline.');
  const savedDeal = deal.parse(
    await call(routes, 'createDeal', invocation, {
      name: 'Maya wedding',
      pipelineId: pipeline.id,
      stageId: stage.id,
      currency: 'KES',
    }),
  );
  for (const [recordId, name, trash, restore] of [
    [savedCompany.id, savedCompany.name, 'trashCompany', 'restoreCompany'],
    [savedDeal.id, savedDeal.name, 'trashDeal', 'restoreDeal'],
  ] as const) {
    const saved = task.parse(
      await call(routes, 'createTask', invocation, { title: 'Confirm venue', recordId }),
    );
    expect(saved.record).toEqual({ id: recordId, name, trashed: false });
    await call(routes, trash, invocation, undefined, { id: recordId });
    expect(taskList.parse(await call(routes, 'listTasks', invocation)).items).not.toContainEqual(
      saved,
    );
    expect(
      taskList.parse(await call(routes, 'listTasks', invocation, undefined, {}, { recordId }))
        .items[0]?.record,
    ).toEqual({ id: recordId, name, trashed: true });
    await expect(
      call(
        routes,
        'completeTask',
        invocation,
        { completed: true, revision: saved.revision },
        { id: saved.id },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await call(routes, restore, invocation, undefined, { id: recordId });
    const machine: Invocation = {
      ...invocation,
      context: { ...invocation.context, actorKind: 'api_key', actorId: randomUUID() },
    };
    const done = task.parse(
      await call(
        routes,
        'completeTask',
        machine,
        { completed: true, revision: saved.revision },
        { id: saved.id },
      ),
    );
    expect(done.completedBy).toEqual({ kind: 'api_key', name: null, you: false });
    const human = task.parse(
      await call(
        routes,
        'completeTask',
        invocation,
        { completed: false, revision: done.revision },
        { id: saved.id },
      ),
    );
    const humanDone = task.parse(
      await call(
        routes,
        'completeTask',
        invocation,
        { completed: true, revision: human.revision },
        { id: saved.id },
      ),
    );
    expect(humanDone.completedBy?.you).toBe(true);
    expect(
      taskList.parse(
        await call(routes, 'listTasks', machine, undefined, {}, { recordId, status: 'completed' }),
      ).items[0]?.completedBy?.you,
    ).toBe(false);
  }
});

it('edits, completes, reopens and deletes with current revisions and trusted private activity', async () => {
  const { invocation, id: recordId } = await fixture();
  const routes = [...unassignedRoutes(), ...activityRoutes({ actorNames: {} })];
  const saved = task.parse(
    await call(routes, 'createTask', invocation, {
      recordId,
      title: 'Call Maya',
      description: 'Private venue details.',
    }),
  );
  const input = {
    title: 'Confirm indoor venue',
    description: 'Private venue details.',
    dueAt: null,
    assignee: null,
  };
  const edited = task.parse(
    await call(
      routes,
      'updateTask',
      invocation,
      {
        ...input,
        revision: saved.revision,
      },
      { id: saved.id },
    ),
  );
  expect(edited).toMatchObject({ ...input, assignee: null, record: saved.record });
  expect(edited.revision).not.toBe(saved.revision);
  await expect(
    call(
      routes,
      'updateTask',
      invocation,
      {
        ...input,
        revision: saved.revision,
      },
      { id: saved.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    call(
      routes,
      'completeTask',
      invocation,
      {
        completed: true,
        revision: saved.revision,
      },
      { id: saved.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  const jordan = await database.fixtures.user({ name: 'Jordan Lee' });
  const editor: Invocation = {
    ...invocation,
    context: { ...invocation.context, actorId: jordan.id, userId: jordan.id },
  };
  const completed = task.parse(
    await call(
      routes,
      'completeTask',
      editor,
      {
        completed: true,
        revision: edited.revision,
      },
      { id: saved.id },
    ),
  );
  expect(completed.completedAt).not.toBeNull();
  expect(completed.completedBy).toEqual({ kind: 'user', name: null, you: true });
  expect(completed.revision).not.toBe(edited.revision);
  const same = task.parse(
    await call(
      routes,
      'completeTask',
      editor,
      {
        completed: true,
        revision: completed.revision,
      },
      { id: saved.id },
    ),
  );
  expect(same).toEqual(completed);
  expect(taskList.parse(await call(routes, 'listTasks', invocation)).items).toEqual([]);
  expect(
    taskList.parse(
      await call(routes, 'listTasks', invocation, undefined, {}, { status: 'completed' }),
    ).items,
  ).toEqual([{ ...completed, completedBy: { kind: 'user', name: null, you: false } }]);
  const reopened = task.parse(
    await call(
      routes,
      'completeTask',
      invocation,
      {
        completed: false,
        revision: completed.revision,
      },
      { id: saved.id },
    ),
  );
  expect(reopened).toMatchObject({ completedAt: null, completedBy: null });
  expect(reopened.revision).not.toBe(completed.revision);
  await expect(
    call(
      routes,
      'deleteTask',
      invocation,
      {
        revision: completed.revision,
      },
      { id: saved.id },
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    call(
      routes,
      'deleteTask',
      invocation,
      {
        revision: reopened.revision,
      },
      { id: saved.id },
    ),
  ).resolves.toBeUndefined();
  expect(taskList.parse(await call(routes, 'listTasks', invocation)).items).toEqual([]);
  await expect(call(routes, 'updateTask', invocation, {}, { id: saved.id })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  const activity = recordActivity.parse(
    await call(routes, 'listRecordActivity', invocation, undefined, { id: recordId }),
  );
  expect(activity.items.map((entry) => [entry.type, entry.subject, entry.payload])).toEqual([
    ['task.deleted', { kind: 'task', id: saved.id }, { recordId }],
    ['task.reopened', { kind: 'task', id: saved.id }, { recordId }],
    ['task.completed', { kind: 'task', id: saved.id }, { recordId }],
    ['task.updated', { kind: 'task', id: saved.id }, { recordId }],
    ['task.created', { kind: 'task', id: saved.id }, { recordId }],
  ]);
});

it('says in its events who a task was given to, only when the event gave it to someone', async () => {
  const { invocation, id: recordId } = await fixture();
  const userId = invocation.context.userId;
  if (userId === undefined) throw new Error('Expected the signed-in user.');
  const other = await database.fixtures.user();
  const membershipId = toPublicId('membership', '01900000-0000-7000-8000-000000000002');
  const routes = taskRoutes({
    actorNames: {},
    assignees: {
      resolve: (_trx, _context, selection) =>
        Promise.resolve(selection === null ? null : selection === 'me' ? userId : other.id),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map([[other.id, membershipId]])),
    },
  });
  const edit = async (current: { id: string; revision: string }, input: object) =>
    task.parse(
      await call(
        routes,
        'updateTask',
        invocation,
        { title: 'Call Maya', description: '', dueAt: null, ...input, revision: current.revision },
        { id: current.id },
      ),
    );
  // Made for someone, renamed, given to someone else, renamed again, then given back.
  const created = task.parse(
    await call(routes, 'createTask', invocation, {
      title: 'Call Maya',
      recordId,
      assignee: membershipId,
    }),
  );
  const renamed = await edit(created, { title: 'Call Maya back', assignee: membershipId });
  const taken = await edit(renamed, { assignee: 'me' });
  const renamedAgain = await edit(taken, { title: 'Call Maya today', assignee: 'me' });
  await edit(renamedAgain, { assignee: null });
  const unassigned = task.parse(
    await call(routes, 'createTask', invocation, { title: 'Nobody’s yet', recordId }),
  );

  // Read from the events themselves: the timeline gives out no internal user id.
  const events = await database.withTenant(invocation.context, (sql) =>
    sql.query<{ type: string; subject_id: string; payload: Record<string, unknown> }>(
      `select type, subject_id, payload from events.events
       where type like 'task.%' order by recorded_at desc, id desc`,
    ),
  );
  expect(
    events.map((event) => [event.type, toPublicId('task', event.subject_id), event.payload]),
  ).toEqual([
    ['task.created', unassigned.id, { recordId }],
    ['task.updated', created.id, { recordId }],
    ['task.updated', created.id, { recordId }],
    ['task.updated', created.id, { recordId, assignedUserId: userId }],
    ['task.updated', created.id, { recordId }],
    ['task.created', created.id, { recordId, assignedUserId: other.id }],
  ]);
});
