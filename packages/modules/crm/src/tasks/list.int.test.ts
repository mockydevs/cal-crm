// The Tasks page's list: a total and a page size, the due views in the business's time
// zone, a due range, one assignee, a title search, and the orders with their cursors. What
// a request without any of these gets is in tasks.int.test.ts.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type ApiRoute } from '@repo/commands';
import { task, taskList, type Task } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { taskRoutes } from '../index.js';

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

async function fixture(timezone?: string) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  if (timezone !== undefined)
    await database.as('crm_owner', (sql) =>
      sql.query('update tenancy.businesses set timezone = $1 where id = $2', [
        timezone,
        business.id,
      ]),
    );
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
  return { invocation, userId: user.id };
}

const jordanMembership = toPublicId('membership', '01900000-0000-7000-8000-000000000002');
const strangerMembership = toPublicId('membership', '01900000-0000-7000-8000-000000000009');

/** Routes where "me" is the caller and one other member, Jordan, can be named. */
function routesFor(userId: string, jordanId?: string): readonly ApiRoute[] {
  return taskRoutes({
    actorNames: {},
    assignees: {
      resolve: (_trx, _context, selection) => {
        if (selection === null) return Promise.resolve(null);
        if (selection === 'me') return Promise.resolve(userId);
        if (selection === jordanMembership && jordanId !== undefined)
          return Promise.resolve(jordanId);
        return Promise.reject(
          new ValidationError([
            { path: '/assignee', code: 'unavailable_assignee', message: 'Not on this team.' },
          ]),
        );
      },
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () =>
        Promise.resolve(
          jordanId === undefined
            ? new Map<string, string>()
            : new Map([[jordanId, jordanMembership]]),
        ),
    },
  });
}

async function call(
  routes: readonly ApiRoute[],
  operationId: string,
  invocation: Invocation,
  body?: unknown,
  query: Record<string, string> = {},
  params: Record<string, string> = {},
) {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, body, params, query }, { db, authorize: allowEveryone });
}

function workspace(routes: readonly ApiRoute[], invocation: Invocation) {
  const create = async (
    title: string,
    dueAt: string | null = null,
    assignee: string | null = null,
  ): Promise<Task> =>
    task.parse(await call(routes, 'createTask', invocation, { title, dueAt, assignee }));
  const list = async (query: Record<string, string> = {}) =>
    taskList.parse(await call(routes, 'listTasks', invocation, undefined, query));
  const titles = async (query: Record<string, string> = {}) =>
    (await list(query)).items.map((item) => item.title);
  /** Every page of a list, read to its end by its cursors. */
  const pages = async (query: Record<string, string>) => {
    const read: string[][] = [];
    const totals = new Set<number | undefined>();
    let after: string | null = null;
    do {
      const page = await list(after === null ? query : { ...query, after });
      read.push(page.items.map((item) => item.title));
      totals.add(page.total);
      after = page.nextCursor;
    } while (after !== null);
    return { read, totals: [...totals] };
  };
  const complete = (saved: Task) =>
    call(
      routes,
      'completeTask',
      invocation,
      { completed: true, revision: saved.revision },
      {},
      { id: saved.id },
    );
  return { create, list, titles, pages, complete };
}

it('counts the tasks that match and pages them at the size asked for', async () => {
  const { invocation, userId } = await fixture();
  const routes = routesFor(userId);
  const { create, list, pages, complete } = workspace(routes, invocation);
  const saved: Task[] = [];
  for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) saved.push(await create(title));
  const done = saved[0];
  if (done === undefined) throw new Error('Expected the first task.');
  await complete(done);

  // Without a size: every open task on the usual page of 50, and how many there are.
  const usual = await list();
  expect(usual.items.map((item) => item.title)).toEqual(['Five', 'Four', 'Three', 'Two']);
  expect(usual).toMatchObject({ total: 4, nextCursor: null });

  // A size of two: the total stays what the filters match, on every page.
  const first = await list({ limit: '2' });
  expect(first.items.map((item) => item.title)).toEqual(['Five', 'Four']);
  expect(first.total).toBe(4);
  expect(first.nextCursor).toBe(first.items.at(-1)?.id);
  expect(await pages({ limit: '2' })).toEqual({
    read: [
      ['Five', 'Four'],
      ['Three', 'Two'],
    ],
    totals: [4],
  });
  expect(await pages({ limit: '3', status: 'all' })).toEqual({
    read: [
      ['Five', 'Four', 'Three'],
      ['Two', 'One'],
    ],
    totals: [5],
  });
  expect(await list({ status: 'completed', limit: '1' })).toMatchObject({
    total: 1,
    nextCursor: null,
  });
  expect((await list({ limit: '100', status: 'all' })).items).toHaveLength(5);

  // The total is this business's and this record's alone.
  const other = await fixture();
  const theirs = workspace(routesFor(other.userId), other.invocation);
  await theirs.create('Hidden');
  expect((await theirs.list()).total).toBe(1);
  expect((await list()).total).toBe(4);
  const record = await database.fixtures.contact(invocation.context, { firstName: 'Maya' });
  const recordId = toPublicId('contact', record.id);
  await call(routes, 'createTask', invocation, { title: 'Call Maya', recordId });
  expect(await list({ recordId })).toMatchObject({ total: 1 });
  expect((await list()).total).toBe(5);

  for (const limit of ['0', '101', 'ten'])
    await expect(list({ limit })).rejects.toBeInstanceOf(ValidationError);
});

/** The instant a calendar day starts in a zone that keeps one offset all year. */
function dayStart(now: Date, offsetHours: number, days = 0): Date {
  const local = new Date(now.getTime() + offsetHours * 3_600_000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days) -
      offsetHours * 3_600_000,
  );
}

it("reads due today and upcoming by the business's calendar day in its own time zone", async () => {
  // Zones that keep one offset all year, ahead of UTC, behind it and on a half hour, and a
  // business that never chose one (UTC). Each day's edges are worked out here, apart from
  // the database, and none but UTC's falls on a UTC midnight.
  const now = new Date();
  const at = (date: Date, milliseconds = 0) =>
    new Date(date.getTime() + milliseconds).toISOString();
  for (const [zone, offsetHours] of [
    ['Pacific/Kiritimati', 14],
    ['Pacific/Pago_Pago', -11],
    ['Asia/Kolkata', 5.5],
    [undefined, 0],
  ] as const) {
    const start = dayStart(now, offsetHours);
    const tomorrow = dayStart(now, offsetHours, 1);
    const { invocation, userId } = await fixture(zone);
    const { create, complete, titles, list } = workspace(routesFor(userId), invocation);
    await create('Last moment of yesterday', at(start, -1));
    await create('First moment of today', at(start));
    await create('Last moment of today', at(tomorrow, -1));
    await create('First moment of tomorrow', at(tomorrow));
    await create('Next year', at(tomorrow, 365 * 86_400_000));
    await create('No due date');
    await complete(await create('Finished today', at(start, 1)));
    const order = { sort: 'due' };
    expect(await titles({ due: 'today', ...order }), zone).toEqual([
      'First moment of today',
      'Last moment of today',
    ]);
    expect((await list({ due: 'today' })).total).toBe(2);
    expect(await titles({ due: 'upcoming', ...order }), zone).toEqual([
      'First moment of tomorrow',
      'Next year',
    ]);
    // The status filter still applies: a finished task is due today among the completed.
    expect(await titles({ due: 'today', status: 'completed' })).toEqual(['Finished today']);
    expect(await titles({ due: 'today', status: 'all', ...order })).toEqual([
      'First moment of today',
      'Finished today',
      'Last moment of today',
    ]);
    // Overdue is as it was, by the clock: it can overlap today, and never upcoming.
    const overdue = await titles({ due: 'overdue', ...order });
    expect(overdue.slice(0, 2)).toEqual(['Last moment of yesterday', 'First moment of today']);
    expect(overdue).not.toContain('First moment of tomorrow');
    expect(overdue).not.toContain('No due date');
  }
});

it('keeps the tasks due in a range, from its start up to its end', async () => {
  const { invocation, userId } = await fixture();
  const { create, titles, list } = workspace(routesFor(userId), invocation);
  await create('Before', '2031-03-09T23:59:59.999Z');
  await create('At the start', '2031-03-10T00:00:00Z');
  await create('Inside', '2031-03-12T08:30:00Z');
  await create('At the end', '2031-03-17T00:00:00Z');
  await create('Undated');
  const order = { sort: 'due' };
  expect(
    await titles({ dueFrom: '2031-03-10T00:00:00Z', dueBefore: '2031-03-17T00:00:00Z', ...order }),
  ).toEqual(['At the start', 'Inside']);
  // An offset names the same moment: 03:00 at +03:00 is midnight UTC.
  expect(await titles({ dueFrom: '2031-03-10T03:00:00+03:00', ...order })).toEqual([
    'At the start',
    'Inside',
    'At the end',
  ]);
  expect(await titles({ dueBefore: '2031-03-10T00:00:00Z' })).toEqual(['Before']);
  expect(await list({ dueFrom: '2031-03-12T08:30:00Z' })).toMatchObject({ total: 2 });
  // With a due view, both must hold: these are all upcoming, none overdue.
  expect(
    await titles({ due: 'upcoming', dueBefore: '2031-03-10T00:00:00.001Z', ...order }),
  ).toEqual(['Before', 'At the start']);
  expect(await titles({ due: 'overdue', dueFrom: '2031-03-10T00:00:00Z' })).toEqual([]);
  await expect(
    list({ dueFrom: '2031-03-17T00:00:00Z', dueBefore: '2031-03-17T00:00:00Z' }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('keeps one member’s tasks, beside the scopes that were there', async () => {
  const { invocation, userId } = await fixture();
  const jordan = await database.fixtures.user({ name: 'Jordan Lee' });
  const routes = routesFor(userId, jordan.id);
  const { create, titles, list } = workspace(routes, invocation);
  await create('Mine', null, 'me');
  await create('Jordan first', '2031-01-02T00:00:00Z', jordanMembership);
  await create('Jordan second', null, jordanMembership);
  await create('Nobody');
  expect(await titles({ assignee: jordanMembership })).toEqual(['Jordan second', 'Jordan first']);
  expect(await list({ assignee: jordanMembership })).toMatchObject({ total: 2 });
  expect(await titles({ assignee: jordanMembership, dueFrom: '2031-01-01T00:00:00Z' })).toEqual([
    'Jordan first',
  ]);
  // The scopes answer as before.
  expect(await titles({ scope: 'mine' })).toEqual(['Mine']);
  expect(await titles({ scope: 'unassigned' })).toEqual(['Nobody']);
  expect(await titles({ scope: 'all' })).toEqual([
    'Nobody',
    'Jordan second',
    'Jordan first',
    'Mine',
  ]);
  // Someone who is not on the team is refused, not answered with an empty list.
  await expect(list({ assignee: strangerMembership })).rejects.toMatchObject({
    issues: [{ path: '/assignee', code: 'unavailable_assignee' }],
  });
  for (const scope of ['mine', 'unassigned'])
    await expect(list({ scope, assignee: jordanMembership })).rejects.toBeInstanceOf(
      ValidationError,
    );
});

it('finds tasks by any part of their title, in either case, taking % and _ as written', async () => {
  const { invocation, userId } = await fixture();
  const { create, titles, list } = workspace(routesFor(userId), invocation);
  await create('Call Maya about the venue');
  await create('CALL the caterer');
  await create('Send 100% of the deposit');
  await create('Rename file_name');
  await create('Rename filename');
  await create('Path C:\\temp');
  expect(await titles({ q: 'call' })).toEqual(['CALL the caterer', 'Call Maya about the venue']);
  expect(await titles({ q: '  VENUE ' })).toEqual(['Call Maya about the venue']);
  expect(await list({ q: 'call' })).toMatchObject({ total: 2 });
  expect(await titles({ q: '100%' })).toEqual(['Send 100% of the deposit']);
  expect(await titles({ q: '%' })).toEqual(['Send 100% of the deposit']);
  expect(await titles({ q: 'file_name' })).toEqual(['Rename file_name']);
  expect(await titles({ q: 'c:\\t' })).toEqual(['Path C:\\temp']);
  expect(await titles({ q: 'florist' })).toEqual([]);
  expect(await list({ q: 'florist' })).toMatchObject({ total: 0, nextCursor: null });
  // Nothing but spaces is no search.
  expect((await list({ q: '   ' })).total).toBe(6);
  // The description is not searched.
  await call(routesFor(userId), 'createTask', invocation, {
    title: 'Plain',
    description: 'call back',
  });
  expect(await list({ q: 'call' })).toMatchObject({ total: 2 });
  await expect(list({ q: 'a'.repeat(201) })).rejects.toBeInstanceOf(ValidationError);
});

it('orders by due date both ways, undated last, and pages each order to its end', async () => {
  const { invocation, userId } = await fixture();
  const { create, pages, titles } = workspace(routesFor(userId), invocation);
  // Made in this order, so ids rise down the list; two pairs share a due time.
  await create('March a', '2031-03-01T00:00:00Z');
  await create('Undated a');
  await create('January', '2031-01-01T00:00:00Z');
  await create('March b', '2031-03-01T00:00:00Z');
  await create('Undated b');
  await create('February', '2031-02-01T00:00:00Z');
  await create('Undated c');
  const soonest = [
    'January',
    'February',
    'March a',
    'March b',
    'Undated a',
    'Undated b',
    'Undated c',
  ];
  const latest = [
    'March b',
    'March a',
    'February',
    'January',
    'Undated c',
    'Undated b',
    'Undated a',
  ];
  expect(await titles({ sort: 'due' })).toEqual(soonest);
  expect(await titles({ sort: 'due', direction: 'asc' })).toEqual(soonest);
  expect(await titles({ sort: 'due', direction: 'desc' })).toEqual(latest);
  for (const [direction, expected] of [
    ['asc', soonest],
    ['desc', latest],
  ] as const)
    for (const limit of [1, 2, 3, 4, 5]) {
      const { read, totals } = await pages({ sort: 'due', direction, limit: String(limit) });
      expect(read.flat(), `${direction} by ${String(limit)}`).toEqual(expected);
      expect(read.slice(0, -1).every((page) => page.length === limit)).toBe(true);
      expect(totals).toEqual([7]);
    }
  // With a filter, the order and the cursor keep to what matches.
  expect((await pages({ sort: 'due', q: 'a', limit: '2' })).read).toEqual([
    ['January', 'February'],
    ['March a', 'March b'],
    ['Undated a', 'Undated b'],
    ['Undated c'],
  ]);
});

it('pages the due order at microsecond precision', async () => {
  const { invocation, userId } = await fixture();
  const { pages } = workspace(routesFor(userId), invocation);
  await database.withTenant(invocation.context, (sql) =>
    sql.query(
      `insert into crm.tasks(business_id,title,created_by_kind,due_at)
       select app.business_id(),'Import ' || n,'system',
         '2031-05-01T12:00:00Z'::timestamptz + n * interval '1 microsecond'
       from generate_series(1,5) n`,
    ),
  );
  const expected = ['Import 1', 'Import 2', 'Import 3', 'Import 4', 'Import 5'];
  expect((await pages({ sort: 'due', limit: '1' })).read.flat()).toEqual(expected);
  expect((await pages({ sort: 'due', direction: 'desc', limit: '2' })).read.flat()).toEqual(
    expected.toReversed(),
  );
});

it('orders by title both ways without regard to case, and by creation oldest first', async () => {
  const { invocation, userId } = await fixture();
  const { create, pages, titles } = workspace(routesFor(userId), invocation);
  for (const title of ['banana', 'Apple', 'cherry', 'apple', 'Banana', 'Date']) await create(title);
  // Titles that differ only in case tie, and ties are in the order of their ids.
  const fromA = ['Apple', 'apple', 'banana', 'Banana', 'cherry', 'Date'];
  const fromZ = ['Date', 'cherry', 'Banana', 'banana', 'apple', 'Apple'];
  const made = ['banana', 'Apple', 'cherry', 'apple', 'Banana', 'Date'];
  expect(await titles({ sort: 'title' })).toEqual(fromA);
  expect(await titles({ sort: 'title', direction: 'desc' })).toEqual(fromZ);
  expect(await titles({ sort: 'created' })).toEqual(made.toReversed());
  expect(await titles({ direction: 'asc' })).toEqual(made);
  for (const [query, expected] of [
    [{ sort: 'title' }, fromA],
    [{ sort: 'title', direction: 'desc' }, fromZ],
    [{ sort: 'created', direction: 'asc' }, made],
    [{ sort: 'created', direction: 'desc' }, made.toReversed()],
  ] as const)
    for (const limit of [1, 2, 4]) {
      const { read, totals } = await pages({ ...query, limit: String(limit) });
      expect(read.flat(), `${JSON.stringify(query)} by ${String(limit)}`).toEqual(expected);
      expect(totals).toEqual([6]);
    }
});

it('refuses a cursor from another business or record under every order', async () => {
  const { invocation, userId } = await fixture();
  const routes = routesFor(userId);
  const { create, list } = workspace(routes, invocation);
  const mine = await create('Mine', '2031-01-01T00:00:00Z');
  const other = await fixture();
  const theirs = await workspace(routesFor(other.userId), other.invocation).create(
    'Theirs',
    '2031-01-01T00:00:00Z',
  );
  const record = await database.fixtures.contact(invocation.context, { firstName: 'Maya' });
  const recordId = toPublicId('contact', record.id);
  for (const sort of ['created', 'due', 'title']) {
    for (const query of [
      { sort, after: theirs.id },
      { sort, after: toPublicId('task', '01900000-0000-7000-8000-000000000001') },
      { sort, recordId, after: mine.id },
    ])
      await expect(list(query)).rejects.toMatchObject({
        issues: [{ path: '/after', code: 'unknown_task' }],
      });
    // A cursor still reads on when its task no longer matches the filters.
    expect(await list({ sort, after: mine.id, status: 'completed' })).toMatchObject({
      items: [],
      total: 0,
    });
  }
});
