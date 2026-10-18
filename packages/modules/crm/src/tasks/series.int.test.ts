// Recurring tasks under row-level security: a series made from a task, each next task made
// at its time by the worker's command, once however often it runs, on the business's wall
// clock; this task or the whole series edited and deleted; and another business kept out.
import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type ApiRoute, type Invocation } from '@repo/commands';
import { task, taskList, type Task } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { crmRoutes, taskRoutes, type TaskOptions } from '../index.js';
import { createOccurrenceCommand, createTaskSeriesTasks } from './series.js';
import { updateTaskCommand } from './tasks.js';

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Who is on the team: tasks may be given to them, and the series keeps giving to them. */
function optionsFor(team: Set<string>): TaskOptions {
  return {
    actorNames: {},
    assignees: {
      resolve: (_trx, context, selection) =>
        Promise.resolve(selection === 'me' ? (context.userId ?? null) : null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: (_trx, _context, userIds) =>
        Promise.resolve(
          new Map(
            userIds
              .filter((id) => team.has(id))
              .map((id) => [id, toPublicId('membership', '01900000-0000-7000-8000-000000000002')]),
          ),
        ),
    },
  };
}

async function fixture(zone = 'UTC') {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await database.as('crm_owner', (sql) =>
    sql.query('update tenancy.businesses set timezone = $2 where id = $1', [business.id, zone]),
  );
  const user = await database.fixtures.user();
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
  const contact = await database.fixtures.contact(invocation.context, { firstName: 'Maya' });
  const team = new Set([user.id]);
  const options = optionsFor(team);
  const system: Invocation = {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
  return {
    invocation,
    system,
    team,
    options,
    routes: taskRoutes(options),
    userId: user.id,
    recordId: toPublicId('contact', contact.id),
  };
}

type Scene = Awaited<ReturnType<typeof fixture>>;

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

const create = async (scene: Scene, body: Record<string, unknown>): Promise<Task> =>
  task.parse(await call(scene.routes, 'createTask', scene.invocation, body));

const list = async (scene: Scene, status = 'all'): Promise<Task[]> =>
  taskList
    .parse(
      await call(
        scene.routes,
        'listTasks',
        scene.invocation,
        undefined,
        {},
        {
          status,
          sort: 'due',
        },
      ),
    )
    .items.filter((each) => each.recurrence !== undefined);

const seriesOf = (scene: Scene, taskId: string) =>
  database.withTenant(scene.invocation.context, (sql) =>
    sql.one<{
      id: string;
      next_occurrence: number;
      next_run_at: Date | null;
      ended_at: Date | null;
      created_count: number;
      lead_seconds: number;
    }>(
      `select s.id, s.next_occurrence, s.next_run_at, s.ended_at, s.created_count, s.lead_seconds
       from crm.task_series s join crm.tasks t on t.series_id = s.id where t.id = $1`,
      [taskId],
    ),
  );

async function taskUuid(scene: Scene, saved: Task): Promise<string> {
  const row = await database.withTenant(scene.invocation.context, (sql) =>
    sql.one<{ id: string }>(`select id from crm.tasks where title = $1 and occurrence = $2`, [
      saved.title,
      saved.recurrence?.occurrence ?? 0,
    ]),
  );
  expect(toPublicId('task', row.id)).toBe(saved.id);
  return row.id;
}

/** Moves a series and its tasks back in time, as if that long had passed. */
const rewind = (seriesId: string, ms: number) =>
  database.as('crm_owner', async (sql) => {
    const by = `${String(ms)} milliseconds`;
    await sql.query(
      `update crm.task_series set anchor_due_at = anchor_due_at - $2::interval,
         next_run_at = next_run_at - $2::interval where id = $1`,
      [seriesId, by],
    );
    await sql.query(
      `update crm.tasks set due_at = due_at - $2::interval, created_at = created_at - $2::interval
       where series_id = $1`,
      [seriesId, by],
    );
  });

const makeNext = (scene: Scene, seriesId: string) =>
  runCommand(
    { db, authorize: allowEveryone },
    createOccurrenceCommand(scene.options),
    { seriesId },
    scene.system,
  );

it('runs an unassigned series without a linked record through the worker once per occurrence', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Water the office plants',
    dueAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    recurrence: { frequency: 'daily', createIfOverdue: true },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, saved));
  await rewind(seriesId, DAY);
  const worker = createTaskSeriesTasks(scene.options).find(
    (entry) => entry.name === 'tasks.create_occurrence',
  );
  if (worker === undefined) throw new Error('The recurring-task job is missing.');
  const job = { invocation: scene.system, services: { db, authorize: allowEveryone } };
  await worker.run(worker.data.parse({ seriesId }), job);
  await worker.run(worker.data.parse({ seriesId }), job);
  const tasks = await list(scene);
  expect(tasks.map((each) => each.recurrence?.occurrence)).toEqual([0, 1]);
  expect(tasks.map((each) => each.assignee)).toEqual([null, null]);
});

const issues = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return error instanceof ValidationError ? error.issues.map((issue) => issue.code) : [];
};

it('makes a task recurring: the first is this one, and the series knows the next due time', async () => {
  const scene = await fixture('America/New_York');
  const dueAt = new Date(Date.now() + 2 * HOUR);
  const saved = await create(scene, {
    title: 'Daily check-in',
    recordId: scene.recordId,
    dueAt: dueAt.toISOString(),
    assignee: 'me',
    recurrence: { frequency: 'daily', ends: { type: 'after', occurrences: 3 } },
  });
  expect(saved.recurrence).toMatchObject({
    frequency: 'daily',
    every: 1,
    ends: { type: 'after', occurrences: 3 },
    createIfOverdue: false,
    occurrence: 0,
    active: true,
  });
  const next = saved.recurrence?.nextDueAt ?? '';
  // A day later on the wall clock in New York: 24 hours unless the clocks change between.
  expect(Math.abs(Date.parse(next) - dueAt.getTime() - DAY)).toBeLessThanOrEqual(HOUR);
  const series = await seriesOf(scene, await taskUuid(scene, saved));
  expect(series).toMatchObject({ next_occurrence: 1, created_count: 1, ended_at: null });
  expect(Math.abs(series.lead_seconds - 2 * 3600)).toBeLessThanOrEqual(5);
  // The series' job waits for the time the next task is made.
  expect(series.next_run_at?.getTime()).toBe(Date.parse(next) - series.lead_seconds * 1000);
});

it('refuses a rule it cannot run: no due date, or a last day before the first task', async () => {
  const scene = await fixture();
  expect(
    await issues(create(scene, { title: 'Undated', recurrence: { frequency: 'weekly' } })),
  ).toEqual(['recurrence_needs_due']);
  expect(
    await issues(
      create(scene, {
        title: 'Ends early',
        dueAt: '2026-11-10T09:00:00Z',
        recurrence: { frequency: 'weekly', ends: { type: 'on', date: '2026-11-09' } },
      }),
    ),
  ).toEqual(['ends_before_due']);
  expect(
    await database.withTenant(scene.invocation.context, (sql) =>
      sql.query('select id from crm.tasks'),
    ),
  ).toEqual([]);
});

it('makes the next task at its time once, however often the job runs, and then waits', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Water the plants',
    recordId: scene.recordId,
    dueAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    assignee: 'me',
    recurrence: { frequency: 'daily', createIfOverdue: true },
  });
  const first = await taskUuid(scene, saved);
  const { id: seriesId } = await seriesOf(scene, first);
  // Before its time the job makes nothing.
  expect(await makeNext(scene, seriesId)).toEqual({ created: false });
  // A day later, the next task's time (two hours before it is due, a day after the first) has come.
  await rewind(seriesId, DAY);
  const jobs = await database.as('crm_owner', (sql) =>
    sql.query<{ data: unknown; due: boolean }>(
      `select p.payload -> 'data' as data, j.run_at <= now() as due
       from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id = j.id
       where j.task_identifier = 'tasks.create_occurrence' and j.key = 'task-series:' || $1::text`,
      [seriesId],
    ),
  );
  expect(jobs).toEqual([{ data: { seriesId }, due: true }]);
  const results = await Promise.all([makeNext(scene, seriesId), makeNext(scene, seriesId)]);
  expect(results.filter((each) => each.created)).toHaveLength(1);
  expect(await makeNext(scene, seriesId)).toEqual({ created: false });
  const tasks = await list(scene);
  expect(tasks.map((each) => [each.recurrence?.occurrence, each.assignee?.you])).toEqual([
    [0, true],
    [1, true],
  ]);
  expect(Date.parse(tasks[1]?.dueAt ?? '') - Date.parse(tasks[0]?.dueAt ?? '')).toBe(DAY);
  expect(tasks[1]?.record?.id).toBe(scene.recordId);
  expect(await seriesOf(scene, first)).toMatchObject({ next_occurrence: 2, created_count: 2 });
  // The new task was told of as any new task is.
  const events = await database.withTenant(scene.invocation.context, (sql) =>
    sql.query<{ type: string; actor_kind: string; payload: { assignedUserId?: string } }>(
      `select type, actor_kind, payload from events.events where subject_kind = 'task'
       and type = 'task.created' order by recorded_at`,
    ),
  );
  expect(events.map((each) => [each.actor_kind, each.payload.assignedUserId])).toEqual([
    ['user', scene.userId],
    ['system', scene.userId],
  ]);
});

it('makes no task while the one before is overdue, unless asked to, and passes over a backlog', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Hourly ping',
    dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    recurrence: { frequency: 'hourly' },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, saved));
  // Five hours on: the first is overdue and open, so the series moves on without a task.
  await rewind(seriesId, 5 * HOUR);
  expect(await makeNext(scene, seriesId)).toEqual({ created: false });
  expect(await list(scene)).toHaveLength(1);
  const moved = await seriesOf(scene, await taskUuid(scene, saved));
  // The tasks that came due meanwhile were passed over: the series is at the newest.
  expect(moved.next_occurrence).toBe(6);
  expect(moved.created_count).toBe(1);
});

it('ends after its number of tasks, and on its last day', async () => {
  const scene = await fixture();
  const twice = await create(scene, {
    title: 'Twice',
    dueAt: new Date(Date.now() + HOUR).toISOString(),
    recurrence: {
      frequency: 'daily',
      ends: { type: 'after', occurrences: 2 },
      createIfOverdue: true,
    },
  });
  const { id: twiceSeries } = await seriesOf(scene, await taskUuid(scene, twice));
  await rewind(twiceSeries, DAY);
  expect(await makeNext(scene, twiceSeries)).toEqual({ created: true });
  const ended = await seriesOf(scene, await taskUuid(scene, twice));
  expect(ended.next_run_at).toBeNull();
  expect(ended.ended_at).not.toBeNull();
  expect((await list(scene)).map((each) => each.recurrence?.active)).toEqual([false, false]);

  const due = new Date(Date.now() + HOUR);
  const lastDay = due.toISOString().slice(0, 10);
  const once = await create(scene, {
    title: 'Today only',
    dueAt: due.toISOString(),
    recurrence: { frequency: 'weekly', ends: { type: 'on', date: lastDay } },
  });
  expect(once.recurrence).toMatchObject({ active: false, nextDueAt: null });
});

it('edits this task alone, or the series and its later open tasks, and stops a series', async () => {
  const scene = await fixture();
  const other = await database.fixtures.user();
  scene.team.add(other.id);
  const saved = await create(scene, {
    title: 'Report',
    dueAt: new Date(Date.now() + HOUR).toISOString(),
    assignee: 'me',
    recurrence: { frequency: 'daily', createIfOverdue: true },
  });
  const firstId = await taskUuid(scene, saved);
  const { id: seriesId } = await seriesOf(scene, firstId);
  // Two days on, a day at a time: the second and the third are made.
  await rewind(seriesId, DAY);
  await makeNext(scene, seriesId);
  await rewind(seriesId, DAY);
  await makeNext(scene, seriesId);
  const [first, second, third] = await list(scene);
  if (first === undefined || second === undefined || third === undefined)
    throw new Error('Expected three tasks.');
  // How it repeats is the series': not changed from one task.
  expect(
    await issues(
      call(
        scene.routes,
        'updateTask',
        scene.invocation,
        {
          title: second.title,
          description: '',
          dueAt: second.dueAt,
          assignee: 'me',
          revision: second.revision,
          recurrence: { frequency: 'weekly' },
        },
        { id: second.id },
      ),
    ),
  ).toEqual(['series_only']);
  // This one alone.
  await call(
    scene.routes,
    'updateTask',
    scene.invocation,
    {
      title: 'Report (late)',
      description: '',
      dueAt: second.dueAt,
      assignee: 'me',
      revision: second.revision,
    },
    { id: second.id },
  );
  expect((await list(scene)).map((each) => each.title)).toEqual([
    'Report',
    'Report (late)',
    'Report',
  ]);
  // The series from the second on: it and the third change, the first does not.
  const fresh = (await list(scene))[1];
  if (fresh === undefined) throw new Error('Expected the second task.');
  await call(
    scene.routes,
    'updateTask',
    scene.invocation,
    {
      title: 'Weekly report',
      description: 'Send it to the team.',
      dueAt: fresh.dueAt,
      assignee: null,
      revision: fresh.revision,
      applyTo: 'series',
      recurrence: null,
    },
    { id: fresh.id },
  );
  const after = await list(scene);
  expect(after.map((each) => [each.title, each.assignee === null])).toEqual([
    ['Report', false],
    ['Weekly report', true],
    ['Weekly report', true],
  ]);
  expect(after.every((each) => each.recurrence?.active === false)).toBe(true);
  expect(await seriesOf(scene, firstId)).toMatchObject({ next_run_at: null });
  expect(await makeNext(scene, seriesId)).toEqual({ created: false });
});

it('runs an edited rule on from the task it was edited at, and turns a task into a series', async () => {
  const scene = await fixture();
  const plain = await create(scene, {
    title: 'Plain',
    dueAt: '2027-01-04T09:00:00.000Z',
  });
  expect(plain.recurrence).toBeUndefined();
  const converted = task.parse(
    await call(
      scene.routes,
      'updateTask',
      scene.invocation,
      {
        title: 'Plain',
        description: '',
        dueAt: plain.dueAt,
        assignee: null,
        revision: plain.revision,
        recurrence: { frequency: 'monthly', every: 2 },
      },
      { id: plain.id },
    ),
  );
  expect(converted.recurrence).toMatchObject({
    occurrence: 0,
    nextDueAt: '2027-03-04T09:00:00.000Z',
  });
  const weekly = task.parse(
    await call(
      scene.routes,
      'updateTask',
      scene.invocation,
      {
        title: 'Plain',
        description: '',
        dueAt: '2027-01-05T10:00:00.000Z',
        assignee: null,
        revision: converted.revision,
        applyTo: 'series',
        recurrence: { frequency: 'weekly' },
      },
      { id: plain.id },
    ),
  );
  expect(weekly.recurrence).toMatchObject({
    frequency: 'weekly',
    nextDueAt: '2027-01-12T10:00:00.000Z',
  });
});

it('deletes the series from a task on: its later open tasks go, completed ones stay', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Stretch',
    dueAt: new Date(Date.now() + HOUR).toISOString(),
    recurrence: { frequency: 'daily', createIfOverdue: true },
  });
  const firstId = await taskUuid(scene, saved);
  const { id: seriesId } = await seriesOf(scene, firstId);
  await rewind(seriesId, DAY);
  await makeNext(scene, seriesId);
  await rewind(seriesId, DAY);
  await makeNext(scene, seriesId);
  const [first, second] = await list(scene);
  if (first === undefined || second === undefined) throw new Error('Expected the tasks.');
  const done = task.parse(
    await call(
      scene.routes,
      'completeTask',
      scene.invocation,
      { completed: true, revision: first.revision },
      { id: first.id },
    ),
  );
  expect(done.completedAt).not.toBeNull();
  // Deleting one task alone leaves the series running.
  await call(
    scene.routes,
    'deleteTask',
    scene.invocation,
    { revision: second.revision },
    { id: second.id },
  );
  expect((await seriesOf(scene, firstId)).next_run_at).not.toBeNull();
  const [, third] = await list(scene);
  if (third === undefined) throw new Error('Expected the third task.');
  await call(
    scene.routes,
    'deleteTask',
    scene.invocation,
    { revision: third.revision, applyTo: 'series' },
    { id: third.id },
  );
  expect((await list(scene)).map((each) => each.recurrence?.occurrence)).toEqual([0]);
  expect((await seriesOf(scene, firstId)).next_run_at).toBeNull();
  // A task that is not recurring has no series to delete.
  const alone = await create(scene, { title: 'Alone' });
  expect(
    await issues(
      call(
        scene.routes,
        'deleteTask',
        scene.invocation,
        { revision: alone.revision, applyTo: 'series' },
        { id: alone.id },
      ),
    ),
  ).toEqual(['not_recurring']);
});

it('gives a new task to nobody once its assignee left the team, and makes none on a trashed record', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Follow up',
    recordId: scene.recordId,
    dueAt: new Date(Date.now() + HOUR).toISOString(),
    assignee: 'me',
    recurrence: { frequency: 'daily', createIfOverdue: true },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, saved));
  scene.team.delete(scene.userId);
  await rewind(seriesId, DAY);
  expect(await makeNext(scene, seriesId)).toEqual({ created: true });
  expect((await list(scene)).map((each) => each.assignee === null)).toEqual([false, true]);
  await call(crmRoutes, 'trashContact', scene.invocation, undefined, { id: scene.recordId });
  await rewind(seriesId, DAY);
  expect(await makeNext(scene, seriesId)).toEqual({ created: false });
  expect(
    await database.withTenant(scene.invocation.context, (sql) =>
      sql.query('select id from crm.tasks where series_id = $1', [seriesId]),
    ),
  ).toHaveLength(2);
});

it('keeps another business out of a series: its tasks, its edits and its job', async () => {
  const scene = await fixture();
  const stranger = await fixture();
  const saved = await create(scene, {
    title: 'Ours',
    dueAt: new Date(Date.now() + HOUR).toISOString(),
    recurrence: { frequency: 'daily', createIfOverdue: true },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, saved));
  const edit = {
    title: 'Theirs',
    description: '',
    dueAt: saved.dueAt,
    assignee: null,
    revision: saved.revision,
    applyTo: 'series',
    recurrence: null,
  };
  await expect(
    call(stranger.routes, 'updateTask', stranger.invocation, edit, { id: saved.id }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call(
      stranger.routes,
      'deleteTask',
      stranger.invocation,
      { revision: saved.revision, applyTo: 'series' },
      { id: saved.id },
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  await rewind(seriesId, DAY);
  // The job run in another business finds no series.
  expect(await makeNext(stranger, seriesId)).toEqual({ created: false });
  expect(await list(stranger)).toEqual([]);
  expect(await makeNext(scene, seriesId)).toEqual({ created: true });
});

/** A task of the series made by hand, as if its time had come: occurrence n, due then. */
const occurrenceAt = (scene: Scene, seriesId: string, occurrence: number, dueAt: string) =>
  database.withTenant(scene.invocation.context, async (sql) => {
    await sql.query(
      `insert into crm.tasks (business_id, title, due_at, series_id, occurrence, created_by_kind)
       select business_id, title, $3, id, $2, 'system' from crm.task_series where id = $1`,
      [seriesId, occurrence, dueAt],
    );
    await sql.query(
      `update crm.task_series set next_occurrence = greatest(next_occurrence, $2 + 1) where id = $1`,
      [seriesId, occurrence],
    );
  });

const editSeriesFrom = async (
  scene: Scene,
  saved: Task,
  body: Record<string, unknown>,
): Promise<Task> =>
  task.parse(
    await call(
      scene.routes,
      'updateTask',
      scene.invocation,
      {
        title: saved.title,
        description: saved.description,
        dueAt: saved.dueAt,
        assignee: null,
        revision: saved.revision,
        applyTo: 'series',
        ...body,
      },
      { id: saved.id },
    ),
  );

const tasksOf = (scene: Scene, seriesId: string) =>
  database.withTenant(scene.invocation.context, (sql) =>
    sql.query('select id from crm.tasks where series_id = $1', [seriesId]),
  );

it('makes a 30-day-old task recurring without a flood: its lead is from now, one waits at a time', async () => {
  for (const frequency of ['daily', 'hourly'] as const) {
    const scene = await fixture();
    const title = `Made a month ago, ${frequency}`;
    await create(scene, { title, dueAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    await database.as('crm_owner', (sql) =>
      sql.query(`update crm.tasks set created_at = now() - interval '30 days' where title = $1`, [
        title,
      ]),
    );
    const [old] = taskList
      .parse(await call(scene.routes, 'listTasks', scene.invocation, undefined, {}, {}))
      .items.filter((each) => each.title === title);
    if (old === undefined) throw new Error('Expected the old task.');
    const converted = task.parse(
      await call(
        scene.routes,
        'updateTask',
        scene.invocation,
        {
          title,
          description: '',
          dueAt: old.dueAt,
          assignee: null,
          revision: old.revision,
          recurrence: { frequency },
        },
        { id: old.id },
      ),
    );
    const series = await seriesOf(scene, await taskUuid(scene, converted));
    // The half hour to its due time, not the thirty days since it was made.
    expect(Math.abs(series.lead_seconds - 1800)).toBeLessThanOrEqual(5);
    expect(await makeNext(scene, series.id)).toEqual({ created: false });
    expect(await tasksOf(scene, series.id)).toHaveLength(1);
  }
});

it('caps the lead at one step of the rule, however far ahead the first is due', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Far ahead',
    dueAt: new Date(Date.now() + 30 * DAY).toISOString(),
    recurrence: { frequency: 'hourly' },
  });
  const series = await seriesOf(scene, await taskUuid(scene, saved));
  expect(series.lead_seconds).toBe(3600);
  // The next is made an hour before it is due, a month on: not now.
  expect(await makeNext(scene, series.id)).toEqual({ created: false });
  expect(await tasksOf(scene, series.id)).toHaveLength(1);
});

it('refuses a recurring due date more than one repeat in the past, on the server too', async () => {
  const scene = await fixture();
  const plain = await create(scene, { title: 'Long ago', dueAt: '2001-01-01T09:00:00.000Z' });
  const error: unknown = await runCommand(
    { db, authorize: allowEveryone },
    updateTaskCommand(scene.options),
    {
      id: plain.id,
      title: plain.title,
      description: '',
      dueAt: plain.dueAt,
      assignee: null,
      revision: plain.revision,
      recurrence: { frequency: 'daily', every: 1, ends: { type: 'never' }, createIfOverdue: false },
    },
    scene.invocation,
  ).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ValidationError);
  expect(error instanceof ValidationError ? error.issues.map((each) => each.code) : []).toEqual([
    'due_too_old',
  ]);
  // Over the API the contract refuses it first, in the same words.
  expect(
    await issues(
      call(
        scene.routes,
        'updateTask',
        scene.invocation,
        {
          title: plain.title,
          description: '',
          dueAt: plain.dueAt,
          assignee: null,
          revision: plain.revision,
          recurrence: { frequency: 'daily' },
        },
        { id: plain.id },
      ),
    ),
  ).toHaveLength(1);
});

it('catches up ten years in one step, on the newest occurrence, without walking them', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Every day',
    dueAt: new Date(Date.now() + HOUR).toISOString(),
    recurrence: { frequency: 'daily', createIfOverdue: true },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, saved));
  await rewind(seriesId, 3650 * DAY);
  const started = Date.now();
  expect(await makeNext(scene, seriesId)).toEqual({ created: true });
  expect(Date.now() - started).toBeLessThan(5_000);
  const newest = (await list(scene)).at(-1);
  expect(newest?.recurrence?.occurrence).toBe(3650);
  expect(Math.abs(Date.parse(newest?.dueAt ?? '') - (Date.now() + HOUR))).toBeLessThan(2 * 60_000);
});

it('makes nothing while a task of the series is not due yet, and waits for it', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Waits',
    dueAt: new Date(Date.now() + HOUR).toISOString(),
    recurrence: { frequency: 'daily', createIfOverdue: true },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, saved));
  // Its time to make the next has come, but this one was moved a week on.
  const later = new Date(Date.now() + 7 * DAY);
  await database.as('crm_owner', async (sql) => {
    await sql.query(
      `update crm.task_series set next_run_at = now() - interval '1 minute' where id = $1`,
      [seriesId],
    );
    await sql.query('update crm.tasks set due_at = $2 where series_id = $1', [seriesId, later]);
  });
  expect(await makeNext(scene, seriesId)).toEqual({ created: false });
  const series = await seriesOf(scene, await taskUuid(scene, saved));
  expect(series.next_run_at?.getTime()).toBe(later.getTime());
  expect(series.next_occurrence).toBe(1);
});

it('keeps the schedule on an edit that changes neither the rule nor the due time', async () => {
  const scene = await fixture('America/New_York');
  const first = await create(scene, {
    title: 'Month end',
    dueAt: '2027-01-31T14:00:00.000Z',
    recurrence: { frequency: 'monthly' },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, first));
  // February's task, kept on the 28th.
  await occurrenceAt(scene, seriesId, 1, '2027-02-28T14:00:00.000Z');
  const february = (await list(scene)).find((each) => each.recurrence?.occurrence === 1);
  if (february === undefined) throw new Error('Expected February.');
  const renamed = await editSeriesFrom(scene, february, {
    title: 'Month-end close',
    recurrence: { frequency: 'monthly', every: 1, ends: { type: 'never' }, createIfOverdue: false },
  });
  expect(renamed.recurrence?.nextDueAt).toBe('2027-03-31T13:00:00.000Z');
  expect(
    await database.withTenant(scene.invocation.context, (sql) =>
      sql.one('select anchor_due_at, anchor_occurrence from crm.task_series where id = $1', [
        seriesId,
      ]),
    ),
  ).toEqual({ anchor_due_at: new Date('2027-01-31T14:00:00.000Z'), anchor_occurrence: 0 });
});

it('dates the later open tasks anew when the rule changes, so they stay in order', async () => {
  const scene = await fixture();
  const first = await create(scene, {
    title: 'Check',
    dueAt: '2027-03-01T09:00:00.000Z',
    recurrence: { frequency: 'weekly' },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, first));
  await occurrenceAt(scene, seriesId, 1, '2027-03-08T09:00:00.000Z');
  await occurrenceAt(scene, seriesId, 2, '2027-03-15T09:00:00.000Z');
  const daily = await editSeriesFrom(scene, first, {
    recurrence: { frequency: 'daily', every: 1, ends: { type: 'never' }, createIfOverdue: false },
  });
  expect(daily.recurrence?.nextDueAt).toBe('2027-03-04T09:00:00.000Z');
  expect((await list(scene)).map((each) => [each.recurrence?.occurrence, each.dueAt])).toEqual([
    [0, '2027-03-01T09:00:00.000Z'],
    [1, '2027-03-02T09:00:00.000Z'],
    [2, '2027-03-03T09:00:00.000Z'],
  ]);
});

it('leaves a stopped series stopped on an edit without a rule, and starts it again with one', async () => {
  const scene = await fixture();
  const first = await create(scene, {
    title: 'Paused',
    dueAt: '2027-03-01T09:00:00.000Z',
    recurrence: { frequency: 'weekly' },
  });
  const stopped = await editSeriesFrom(scene, first, { recurrence: null });
  expect(stopped.recurrence?.active).toBe(false);
  const renamed = await editSeriesFrom(scene, stopped, { title: 'Still paused' });
  expect(renamed.recurrence).toMatchObject({ active: false, nextDueAt: null });
  const moved = await editSeriesFrom(scene, renamed, { dueAt: '2027-03-02T09:00:00.000Z' });
  expect(moved.recurrence?.active).toBe(false);
  const again = await editSeriesFrom(scene, moved, {
    recurrence: { frequency: 'weekly', every: 1, ends: { type: 'never' }, createIfOverdue: false },
  });
  expect(again.recurrence).toMatchObject({ active: true, nextDueAt: '2027-03-09T09:00:00.000Z' });
});

it('counts every scheduled occurrence toward its end, a passed-over one included', async () => {
  const scene = await fixture();
  const saved = await create(scene, {
    title: 'Three in all',
    dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    recurrence: { frequency: 'hourly', ends: { type: 'after', occurrences: 3 } },
  });
  const { id: seriesId } = await seriesOf(scene, await taskUuid(scene, saved));
  // Three hours on, the first still open and overdue: the second and the third pass unmade.
  await rewind(seriesId, 3 * HOUR);
  expect(await makeNext(scene, seriesId)).toEqual({ created: false });
  const series = await seriesOf(scene, await taskUuid(scene, saved));
  expect(series.next_run_at).toBeNull();
  expect(series.ended_at).not.toBeNull();
  expect(await tasksOf(scene, seriesId)).toHaveLength(1);
});
