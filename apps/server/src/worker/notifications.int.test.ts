// The bell, end to end, as the install composes it: a person does something through the API
// with real sign-in, the database queues the job, the real worker runs the install's own
// task list, and the person it concerns reads it through the API, with the refresh hint
// arriving on a real socket. Nothing here stands in for the product.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Services } from '@repo/commands';
import {
  notification,
  notificationList,
  problem,
  task,
  taskAssigneeList,
  unreadNotificationCount,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { createAuthentication, type Authentication } from '@repo/module-auth';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { apiRoutes } from '../api-routes.js';
import { API_PREFIX, buildServer, type Server } from '../server.js';
import { workerTasks } from '../worker-tasks.js';
import { startWorker, type Worker } from './worker.js';

const PUBLIC_URL = 'https://crm.example.test';
const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
let db: Database;
let authentication: Authentication;
let server: Server;
let listeningAt: string;
let worker: Worker;
const sockets: Socket[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    maxConnections: 4,
    onConnectionError: () => undefined,
  });
  const services: Services = { db, authorize: allowEveryone };
  const logger = pino({ level: 'silent' });
  authentication = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
    publicUrl: PUBLIC_URL,
    onConnectionError: () => undefined,
    log: () => undefined,
    sendMail: () => Promise.resolve(),
  });
  server = await buildServer({
    config: {
      nodeEnv: 'test',
      role: 'all',
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      databaseAppUrl: database.url('crm_app'),
      databaseWorkerUrl: database.url('crm_worker'),
      databasePoolSize: 4,
      shutdownTimeoutMs: 1000,
      dashboardDir: undefined,
      devTenantContext: undefined,
      publicUrl: PUBLIC_URL,
      authentication: undefined,
      trustProxy: [],
      mail: undefined,
      files: undefined,
      vault: undefined,
    },
    logger,
    serveApi: true,
    routes: apiRoutes(authentication),
    services,
    authentication,
    realtime: true,
    readinessChecks: {},
  });
  // A real port, for the socket: the API itself is called without one.
  listeningAt = await server.app.listen({ host: '127.0.0.1', port: 0 });
  worker = await startWorker({
    connectionString: database.url('crm_worker'),
    services,
    // The install's own task list: the notification jobs are whatever it registers.
    tasks: workerTasks(),
    logger,
    shutdownTimeoutMs: 5000,
  });
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await worker.stop();
  await server.close(1000);
  await authentication.close();
  await db.destroy();
  await database.close();
});

let people = 0;

interface SignedInPerson {
  readonly userId: string;
  readonly cookie: string;
  call(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
    businessId?: string,
  ): Promise<{ status: number; body: unknown }>;
}

/** Someone with this built-in role in the business, signed in with a password. */
async function person(
  business: { id: string; agencyId: string },
  role: 'owner' | 'member' | 'viewer',
  name: string,
): Promise<SignedInPerson> {
  const email = `bell-${String(++people)}@harborlights.example`;
  const { id: userId } = await authentication.createUser({
    email,
    name,
    password: PASSWORD,
    emailVerified: true,
  });
  await database.as('crm_owner', async (sql) => {
    const stored = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       values ($1, 'business', $2, $2, true)
       on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
      [business.agencyId, role],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, $3, $4)`,
      [userId, business.agencyId, business.id, stored.id],
    );
  });
  const signIn = await server.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
    payload: { email, password: PASSWORD },
    // A client of its own, so sign-in's rate limit counts each person apart.
    remoteAddress: `198.18.0.${String(people)}`,
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  const setCookie = signIn.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((each) => each.split(';')[0] ?? '')
    .join('; ');
  return {
    userId,
    cookie,
    async call(method, path, payload, businessId = business.id) {
      const response = await server.app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: {
          cookie,
          origin: PUBLIC_URL,
          'business-id': toPublicId('business', businessId),
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return {
        status: response.statusCode,
        body: response.body === '' ? undefined : response.json<unknown>(),
      };
    },
  };
}

const unreadOf = async (who: SignedInPerson) => {
  const answer = await who.call('GET', '/notifications/unread-count');
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return unreadNotificationCount.parse(answer.body).unread;
};
const listOf = async (who: SignedInPerson) => {
  const answer = await who.call('GET', '/notifications');
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return notificationList.parse(answer.body).items;
};

/** A socket as the dashboard opens one, and every refresh hint it has heard. */
async function tab(who: SignedInPerson, businessId: string): Promise<{ heard: unknown[] }> {
  const heard: unknown[] = [];
  const socket = io(listeningAt, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: { businessId: toPublicId('business', businessId) },
    extraHeaders: { origin: PUBLIC_URL, cookie: who.cookie },
  });
  sockets.push(socket);
  socket.on('business.changed', (payload: unknown) => {
    heard.push(payload);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return { heard };
}

it('tells the person a task was given to, through the API, the queue and the worker, and nobody else', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const elsewhere = await database.fixtures.business(agency.id);
  const sam = await person(business, 'owner', 'Sam Okoro');
  const dana = await person(business, 'member', 'Dana Brooks');
  const amina = await person(business, 'viewer', 'Amina Yusuf');
  const outsider = await person(elsewhere, 'owner', 'Otis Reed');
  const contact = await database.fixtures.contact(business.context, {
    firstName: 'Jordan',
    lastName: 'Lee',
  });

  expect(await unreadOf(dana)).toBe(0);
  const danasTab = await tab(dana, business.id);

  // Sam gives Dana a task, as the dashboard would: by her membership.
  const assignees = await sam.call('GET', '/tasks/assignees');
  expect(assignees.status, JSON.stringify(assignees.body)).toBe(200);
  const danasMembership = taskAssigneeList
    .parse(assignees.body)
    .items.find((each) => each.name === 'Dana Brooks')?.id;
  const created = await sam.call('POST', '/tasks', {
    title: 'Call the venue back',
    recordId: toPublicId('contact', contact.id),
    assignee: danasMembership,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const made = task.parse(created.body);

  // The event queued the job in the task's own transaction; the worker runs it.
  await expect.poll(() => unreadOf(dana), { timeout: 30_000, interval: 100 }).toBe(1);
  const [told, ...rest] = await listOf(dana);
  expect(rest).toEqual([]);
  expect(told).toEqual({
    id: told?.id,
    kind: 'task.assigned',
    target: { kind: 'task', id: made.id },
    record: { id: toPublicId('contact', contact.id), name: 'Jordan Lee', trashed: false },
    title: 'Call the venue back',
    body: null,
    actor: { kind: 'user', name: 'Sam Okoro', you: false },
    readAt: null,
    createdAt: told?.createdAt,
  });

  // Sam did it, so Sam is told nothing; and nobody else is told of it either.
  expect(await unreadOf(sam)).toBe(0);
  expect(await listOf(sam)).toEqual([]);
  expect(await listOf(amina)).toEqual([]);

  // Nobody but Dana marks it: not a member of her own business, its owner included, and
  // not someone from another business. Each gets the same answer as for an id that names
  // nothing.
  const nothing = toPublicId('notification', `ffffffff-ffff-7${randomUUID().slice(15)}`);
  const refusals = [
    await sam.call('POST', `/notifications/${told?.id ?? ''}/read`),
    await amina.call('POST', `/notifications/${told?.id ?? ''}/read`),
    await outsider.call('POST', `/notifications/${told?.id ?? ''}/read`),
    await dana.call('POST', `/notifications/${nothing}/read`),
  ];
  expect(refusals.map((answer) => answer.status)).toEqual([404, 404, 404, 404]);
  expect(
    new Set(refusals.map((answer) => problem.parse(answer.body).detail?.replace(/ntf_\w+/, 'ntf'))),
  ).toEqual(new Set([problem.parse(refusals[3]?.body).detail?.replace(/ntf_\w+/, 'ntf')]));
  // Someone from another business who names Dana's business is refused before any read.
  expect((await outsider.call('GET', '/notifications', undefined, business.id)).status).toBe(403);
  expect(await unreadOf(dana)).toBe(1);

  // Dana reads it in one tab. Her other tab hears the hint, and the count comes down.
  // Marking read runs no command, so this hint is the notification's own.
  const before = danasTab.heard.length;
  const read = await dana.call('POST', `/notifications/${told?.id ?? ''}/read`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(notification.parse(read.body).readAt).not.toBeNull();
  expect(await unreadOf(dana)).toBe(0);
  await expect
    .poll(() => danasTab.heard.length, { timeout: 10_000, interval: 50 })
    .toBeGreaterThan(before);
  // Only the business's public id ever travels: no notification, no count, no person.
  expect(new Set(danasTab.heard.map((payload) => JSON.stringify(payload)))).toEqual(
    new Set([JSON.stringify({ businessId: toPublicId('business', business.id) })]),
  );
});

it('tells a task’s assignee when it is due, from the job the task’s own event queued', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const sam = await person(business, 'owner', 'Sam Okoro');
  // Sam makes a task for himself, due tomorrow: nobody is told of that.
  const created = await sam.call('POST', '/tasks', {
    title: 'Send the quote',
    assignee: 'me',
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const made = task.parse(created.body);
  const taskId = parsePublicId('task', made.id) ?? '';
  const key = `notify-task-due:${taskId}`;
  // The task's event queued one job, for the task's due time.
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query<{ atDueTime: boolean }>(
        `select j.run_at = t.due_at as "atDueTime"
         from graphile_worker._private_jobs j, crm.tasks t where j.key = $1 and t.id = $2`,
        [key, taskId],
      ),
    ),
  ).toEqual([{ atDueTime: true }]);
  expect(await unreadOf(sam)).toBe(0);

  // The due time comes: the task and its job are moved to the past together, as if the
  // day had gone by. Nothing here waits on a clock.
  const tabOfSam = await tab(sam, business.id);
  await database.as('crm_owner', async (sql) => {
    await sql.query("update crm.tasks set due_at = now() - interval '1 minute' where id = $1", [
      taskId,
    ]);
    await sql.query('update graphile_worker._private_jobs set run_at = now() where key = $1', [
      key,
    ]);
  });
  await expect.poll(() => unreadOf(sam), { timeout: 30_000, interval: 100 }).toBe(1);
  const [due] = await listOf(sam);
  expect(due).toMatchObject({
    kind: 'task.due',
    target: { kind: 'task', id: made.id },
    record: null,
    title: 'Send the quote',
    actor: { kind: 'system', name: null, you: false },
  });
  // No command ran when it came due: the hint his tab hears is the notification's own.
  await expect
    .poll(() => tabOfSam.heard.length, { timeout: 10_000, interval: 50 })
    .toBeGreaterThan(0);

  // Everything read, up to what he was shown.
  const all = await sam.call('POST', '/notifications/read-all', { through: due?.id });
  expect(all.status, JSON.stringify(all.body)).toBe(200);
  expect(unreadNotificationCount.parse(all.body)).toEqual({ unread: 0, more: false });
});

it('removes expired notifications when the worker’s hourly cleanup runs', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const sam = await person(business, 'owner', 'Sam Okoro');
  await database.as('crm_owner', (sql) =>
    sql.query(
      `insert into notifications.notifications
         (agency_id, business_id, user_id, kind, source_key, actor_kind, subject_kind, expires_at)
       values ($1, $2, $3, 'ai.limit_reached', 'old', 'system', 'ai_settings', now() - interval '1 day'),
              ($1, $2, $3, 'ai.limit_reached', 'new', 'system', 'ai_settings', now() + interval '1 day')`,
      [agency.id, business.id, sam.userId],
    ),
  );
  expect(await unreadOf(sam)).toBe(2);
  // The registered cron task is asked for directly, without waiting for its minute.
  await database.as('crm_owner', (sql) =>
    sql.query('select graphile_worker.add_job($1)', ['notifications.maintain']),
  );
  await expect.poll(() => unreadOf(sam), { timeout: 30_000, interval: 100 }).toBe(1);
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query<{ source_key: string }>(
        'select source_key from notifications.notifications where business_id = $1',
        [business.id],
      ),
    ),
  ).toEqual([{ source_key: 'new' }]);
});
