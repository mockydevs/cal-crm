// The public intake limiter against real Postgres (migration 0042): app instances share
// one count, only a digest is stored, and a slow or locked database ends in a refusal
// with nothing left running and the pool still usable.
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BOOKING_NOTIFICATION_WORDING, type PublicCalendarPage } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import type { PublicBookingHandlers } from '@repo/module-calendar';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from 'vitest';
import { INTAKE_GATE_RETRY_SECONDS } from './intake-gate.js';
import { registerPublicBooking } from './public-booking.js';
import {
  createPublicIntakeLimit,
  databaseAdmission,
  type PublicIntakeLimitOptions,
} from './public-intake-limit.js';

// An obvious fake: it protects nothing.
const SECRET = 'test-only-public-intake-secret-0123456789';

let database: TestDatabase;
const pools: Database[] = [];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((db) => db.destroy()));
});
afterAll(async () => {
  await database.close();
});

const owner = <T>(work: (sql: Sql) => Promise<T>): Promise<T> => database.as('crm_owner', work);

beforeEach(async () => {
  await owner(async (sql) => {
    await sql.query('delete from intake.public_rate_limit_clients');
    await sql.query(
      `update intake.public_rate_limit_totals
       set window_start = 'epoch', reads = 0, writes = 0, full_window = null`,
    );
    // Windows follow the database's clock. With under 20 seconds of this minute left, wait
    // for the next one, so a test's calls share a window.
    await sql.query(
      `select pg_sleep(case when extract(second from clock_timestamp()) > 40
                            then 60.05 - extract(second from clock_timestamp()) else 0 end)`,
    );
  });
});

/** An app instance's limiter: its own crm_app pool, as start.ts would compose it. */
function instance(
  maxConnections: number,
  options: Partial<Omit<PublicIntakeLimitOptions, 'admit'>> = {},
) {
  const db = connectDatabase({
    connectionString: database.url('crm_app'),
    maxConnections,
    onConnectionError: () => undefined,
  });
  pools.push(db);
  return createPublicIntakeLimit({ admit: databaseAdmission(db), secret: SECRET, ...options });
}

const from = (ipAddress: string) => ({ requestId: 'request-1', ipAddress });
const failureOf = (decision: Promise<unknown>): Promise<unknown> =>
  decision.then(
    () => undefined,
    (error: unknown) => error,
  );

/** Past the in-flight limit: told to wait, as a full line tells it, and never allowed. */
const busy = { allowed: false, retryAfterSeconds: INTAKE_GATE_RETRY_SECONDS };

/** What a call ended with: its decision, or the code it failed with. */
const outcomeOf = (decision: Promise<unknown>): Promise<unknown> =>
  decision.then(
    (answer) => answer,
    (error: unknown) => (error as { code: string }).code,
  );

const lockTotals = (sql: Sql) =>
  sql.query('select singleton from intake.public_rate_limit_totals for update');

/** Limiter statements of crm_app that are running or waiting for a lock right now. */
async function lingering(): Promise<number> {
  const { statements } = await database.as('postgres', (sql) =>
    sql.one<{ statements: number }>(
      `select count(*)::integer as statements from pg_stat_activity
       where datname = current_database() and usename = 'crm_app'
         and (state = 'active' or wait_event_type = 'Lock')
         and query like '%admit_public_intake%'`,
    ),
  );
  return statements;
}

async function untilNothingLingers(withinMs: number): Promise<void> {
  const deadline = performance.now() + withinMs;
  while ((await lingering()) > 0) {
    if (performance.now() > deadline) throw new Error('A limiter statement is still running.');
    await delay(25);
  }
}

const storedClients = () =>
  owner((sql) =>
    sql.query<{ digest: Buffer; reads: number; writes: number }>(
      `select client_digest as digest, reads, writes
       from intake.public_rate_limit_clients order by client_digest`,
    ),
  );

const totals = () =>
  owner((sql) =>
    sql.one<{ reads: number; writes: number }>(
      'select reads, writes from intake.public_rate_limit_totals',
    ),
  );

it('counts in Postgres and stores a keyed digest, never the address', async () => {
  const limit = instance(2);
  const ipAddress = '203.0.113.77';
  for (let write = 1; write <= 10; write += 1)
    expect(await limit(from(ipAddress), 'write')).toEqual({ allowed: true });
  const refusal = await limit(from(ipAddress), 'write');
  expect(refusal).toMatchObject({ allowed: false });
  if (!refusal.allowed) {
    expect(Number.isSafeInteger(refusal.retryAfterSeconds)).toBe(true);
    expect(refusal.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refusal.retryAfterSeconds).toBeLessThanOrEqual(60);
  }
  // Reads are counted apart from writes.
  expect(await limit(from(ipAddress), 'read')).toEqual({ allowed: true });

  const expected = createHmac('sha256', SECRET)
    .update('crm.public-intake.client.v1')
    .update(Buffer.from([0, 4, 203, 0, 113, 77]))
    .digest();
  const rows = await storedClients();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.digest.equals(expected)).toBe(true);
  expect(rows[0]).toMatchObject({ reads: 1, writes: 10 });
  expect(rows[0]?.digest.includes(Buffer.from([203, 0, 113, 77]))).toBe(false);
  expect(rows[0]?.digest.toString('latin1')).not.toContain(ipAddress);
});

// The ceilings of migration 0089. A change there must be made here too, on purpose.
const BUSINESS_WRITES = 100;
const BUSINESS_READS = 1200;
const GLOBAL_WRITES = 500;
const BUSINESS_A = '01890f3e-7b1c-7cc0-8a51-00000000000a';
const BUSINESS_B = '01890f3e-7b1c-7cc0-8a51-00000000000b';
/** A different address each time, so no address is at its own quota. */
let visitor = 0;
const stranger = (businessId?: string) => {
  visitor += 1;
  return {
    requestId: 'request-1',
    ipAddress: `198.51.${String(visitor >> 8)}.${String(visitor & 255)}`,
    ...(businessId === undefined ? {} : { businessId }),
  };
};

it('stops a flood on one business at that business’s ceiling, and leaves the others theirs', async () => {
  const limit = instance(4);
  // A hundred visitors, one submission each, all to business A: every one is admitted.
  for (let write = 1; write <= BUSINESS_WRITES; write += 1)
    expect(await limit(stranger(BUSINESS_A), 'write')).toEqual({ allowed: true });
  // The next is refused, whoever sends it, with the time to wait.
  for (let more = 0; more < 50; more += 1) {
    const refusal = await limit(stranger(BUSINESS_A), 'write');
    expect(refusal).toMatchObject({ allowed: false });
    if (!refusal.allowed) expect(refusal.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  }
  // What was refused was not counted for the install: A used a hundred of its five hundred.
  expect(await totals()).toEqual({ reads: 0, writes: BUSINESS_WRITES });
  // Business B is untouched: its own hundred are all there, during A's flood.
  for (let write = 1; write <= BUSINESS_WRITES; write += 1)
    expect(await limit(stranger(BUSINESS_B), 'write')).toEqual({ allowed: true });
  expect(await limit(stranger(BUSINESS_B), 'write')).toMatchObject({ allowed: false });
  // So is a request that names no business, and A's own pages can still be read.
  expect(await limit(stranger(), 'write')).toEqual({ allowed: true });
  expect(await limit(stranger(BUSINESS_A), 'read')).toEqual({ allowed: true });
  expect(await totals()).toEqual({ reads: 1, writes: 2 * BUSINESS_WRITES + 1 });

  // Each business is one row beside its visitors' rows, under a digest that is neither
  // the business nor any address.
  const rows = await storedClients();
  const busiest = rows.filter((row) => row.writes === BUSINESS_WRITES);
  expect(busiest).toHaveLength(2);
  const expected = createHmac('sha256', SECRET)
    .update('crm.public-intake.business.v1')
    .update(Buffer.from([0]))
    .update(BUSINESS_A)
    .digest();
  expect(busiest.some((row) => row.digest.equals(expected))).toBe(true);
  expect(busiest.find((row) => row.digest.equals(expected))).toMatchObject({ reads: 1 });
});

it('counts a business’s reads apart from its writes, to a ceiling of their own', async () => {
  const limit = instance(4);
  await owner((sql) =>
    sql.query(
      `insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
       values ($1, date_trunc('minute', clock_timestamp(), 'UTC'), $2, 0)`,
      [
        createHmac('sha256', SECRET)
          .update('crm.public-intake.business.v1')
          .update(Buffer.from([0]))
          .update(BUSINESS_A)
          .digest(),
        BUSINESS_READS - 1,
      ],
    ),
  );
  expect(await limit(stranger(BUSINESS_A), 'read')).toEqual({ allowed: true });
  expect(await limit(stranger(BUSINESS_A), 'read')).toMatchObject({ allowed: false });
  expect(await limit(stranger(BUSINESS_A), 'write')).toEqual({ allowed: true });
  expect(await limit(stranger(BUSINESS_B), 'read')).toEqual({ allowed: true });
});

it('keeps the install’s ceiling above every business: five flooded businesses fill it, and no more is taken', async () => {
  const limit = instance(4);
  const refusals: string[] = [];
  const counting = createPublicIntakeLimit({
    admit: databaseAdmission(pools[0] ?? never()),
    secret: SECRET,
    onRefusal: (reason) => refusals.push(reason),
  });
  // Each of five businesses at one short of its ceiling, and the install at one short of its own.
  const digestOf = (businessId: string) =>
    createHmac('sha256', SECRET)
      .update('crm.public-intake.business.v1')
      .update(Buffer.from([0]))
      .update(businessId)
      .digest();
  await owner(async (sql) => {
    await sql.query(
      `update intake.public_rate_limit_totals
       set window_start = date_trunc('minute', clock_timestamp(), 'UTC'), writes = $1`,
      [GLOBAL_WRITES - 1],
    );
    await sql.query(
      `insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
       values ($1, date_trunc('minute', clock_timestamp(), 'UTC'), 0, $2)`,
      [digestOf(BUSINESS_A), BUSINESS_WRITES],
    );
  });
  // A is at its own ceiling: refused there, and the install's last place is not taken.
  expect(await counting(stranger(BUSINESS_A), 'write')).toMatchObject({ allowed: false });
  expect(refusals).toEqual(['scope_quota']);
  expect((await totals()).writes).toBe(GLOBAL_WRITES - 1);
  // B takes the last place; after that the install itself is full, for everyone.
  expect(await limit(stranger(BUSINESS_B), 'write')).toEqual({ allowed: true });
  expect(await counting(stranger(BUSINESS_B), 'write')).toMatchObject({ allowed: false });
  expect(await counting(stranger(), 'write')).toMatchObject({ allowed: false });
  expect(refusals).toEqual(['scope_quota', 'global_ceiling', 'global_ceiling']);
  expect((await totals()).writes).toBe(GLOBAL_WRITES);
});

it('gives two app instances one ceiling for a business, also when they race', async () => {
  const one = instance(4);
  const two = instance(4);
  await owner((sql) =>
    sql.query(
      `insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
       values ($1, date_trunc('minute', clock_timestamp(), 'UTC'), 0, $2)`,
      [
        createHmac('sha256', SECRET)
          .update('crm.public-intake.business.v1')
          .update(Buffer.from([0]))
          .update(BUSINESS_A)
          .digest(),
        BUSINESS_WRITES - 3,
      ],
    ),
  );
  const decisions = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 === 0 ? one : two)(stranger(BUSINESS_A), 'write'),
    ),
  );
  expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
});

function never(): never {
  throw new Error('An instance was made first.');
}

it('gives two app instances one quota for the same client, also when they race', async () => {
  const one = instance(4);
  const two = instance(4);
  const decisions = [];
  for (let wave = 0; wave < 5; wave += 1)
    decisions.push(
      ...(await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          (index % 2 === 0 ? one : two)(from('198.51.100.5'), 'write'),
        ),
      )),
    );
  expect(decisions).toHaveLength(40);
  expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
  expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(30);
  expect(await totals()).toEqual({ reads: 0, writes: 10 });
});

it('counts an IPv6 /64 as one client and another /64 as another', async () => {
  const limit = instance(2);
  for (let write = 0; write < 10; write += 1)
    expect(await limit(from(`2001:db8:1:2::${String(write + 1)}`), 'write')).toEqual({
      allowed: true,
    });
  expect(await limit(from('2001:db8:1:2:ffff::1'), 'write')).toMatchObject({ allowed: false });
  expect(await limit(from('2001:db8:1:3::1'), 'write')).toEqual({ allowed: true });
  expect(await storedClients()).toHaveLength(2);
});

it('refuses the 121st read through the public transport before its handler runs', async () => {
  const calendar: PublicCalendarPage = {
    notificationWording: BOOKING_NOTIFICATION_WORDING,
    appearance: {
      style: 'neo',
      primaryColor: '#178af6',
      backgroundColor: '#ffffff',
      buttonText: '',
      logoUrl: null,
      coverUrl: null,
    },
    name: 'Consultation',
    description: 'Meet the team.',
    timezone: 'Africa/Nairobi',
    slotMinutes: 30,
    durations: [30],
    renderToken: `1793000000000.${'A'.repeat(43)}`,
  };
  const handlers = {
    calendar: vi.fn<PublicBookingHandlers['calendar']>().mockResolvedValue(calendar),
    slots: vi.fn<PublicBookingHandlers['slots']>(),
    book: vi.fn<PublicBookingHandlers['book']>(),
    appointment: vi.fn<PublicBookingHandlers['appointment']>(),
    cancel: vi.fn<PublicBookingHandlers['cancel']>(),
    reschedule: vi.fn<PublicBookingHandlers['reschedule']>(),
    appointmentSlots: vi.fn<PublicBookingHandlers['appointmentSlots']>(),
    challenge: vi.fn<PublicBookingHandlers['challenge']>(),
  };
  const app = Fastify();
  await registerPublicBooking(app, { handlers, rateLimit: instance(2) });
  try {
    const request = {
      url: '/api/v1/public/book/agency/business/calendar',
      remoteAddress: '192.0.2.44',
    };
    for (let read = 1; read <= 120; read += 1)
      expect((await app.inject(request)).statusCode).toBe(200);
    const refused = await app.inject(request);
    expect(refused.statusCode).toBe(429);
    const retryAfter = Number(refused.headers['retry-after']);
    expect(Number.isSafeInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60).toBe(true);
    expect(handlers.calendar).toHaveBeenCalledTimes(120);
    // Another address is still served.
    expect((await app.inject({ ...request, remoteAddress: '192.0.2.45' })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it('refuses within the deadline when the counter row is locked, leaves no statement behind, and keeps the pool usable', async () => {
  const limit = instance(2, { timeoutMs: 300 });
  const held = await owner(async (sql) => {
    await lockTotals(sql);
    const started = performance.now();
    const failure = await failureOf(limit(from('192.0.2.10'), 'write'));
    const refusedAfter = performance.now() - started;
    // The statement outlives the deadline: it is still waiting for the lock.
    const atRefusal = await lingering();
    // With the lock STILL held, Postgres ends it: the function's lock_timeout is 1s.
    await untilNothingLingers(5000);
    return { failure, refusedAfter, atRefusal, endedAfter: performance.now() - started };
  });
  expect(held.failure).toMatchObject({ name: 'PublicIntakeLimitError', code: 'timeout' });
  expect(held.refusedAfter).toBeGreaterThanOrEqual(250);
  expect(held.refusedAfter).toBeLessThan(900);
  expect(held.atRefusal).toBe(1);
  expect(held.endedAfter).toBeLessThan(5000);
  // The refused request was never counted, and both pooled connections work again.
  expect(await storedClients()).toEqual([]);
  expect(await totals()).toEqual({ reads: 0, writes: 0 });
  expect(
    await Promise.all([limit(from('192.0.2.10'), 'write'), limit(from('192.0.2.11'), 'write')]),
  ).toEqual([{ allowed: true }, { allowed: true }]);
  expect(await lingering()).toBe(0);
});

it('fails closed on the database lock timeout alone, about a second in', async () => {
  const limit = instance(1, { timeoutMs: 8000 });
  const held = await owner(async (sql) => {
    await lockTotals(sql);
    const started = performance.now();
    const failure = await failureOf(limit(from('192.0.2.20'), 'read'));
    return { failure, after: performance.now() - started, lingering: await lingering() };
  });
  expect(held.failure).toMatchObject({ code: 'unavailable', cause: { code: '55P03' } });
  expect(held.after).toBeGreaterThanOrEqual(900);
  expect(held.after).toBeLessThan(6000);
  expect(held.lingering).toBe(0);
  expect(await storedClients()).toEqual([]);
  expect(await limit(from('192.0.2.20'), 'read')).toEqual({ allowed: true });
});

it('with a pool of one connection: refuses, takes no second connection, and recovers', async () => {
  const limit = instance(1, { timeoutMs: 300, maxInFlight: 1 });
  const held = await owner(async (sql) => {
    await lockTotals(sql);
    const first = failureOf(limit(from('192.0.2.30'), 'write'));
    await delay(50);
    const started = performance.now();
    // The one place is taken, also after the first call's deadline: refused at once.
    const second = await outcomeOf(limit(from('192.0.2.31'), 'write'));
    const secondAfter = performance.now() - started;
    const firstFailure = await first;
    const third = await outcomeOf(limit(from('192.0.2.32'), 'write'));
    const most = await lingering();
    await untilNothingLingers(5000);
    return { firstFailure, second, secondAfter, third, most };
  });
  expect(held.firstFailure).toMatchObject({ code: 'timeout' });
  expect(held.second).toEqual(busy);
  expect(held.secondAfter).toBeLessThan(200);
  expect(held.third).toEqual(busy);
  expect(held.most).toBe(1);
  expect(await storedClients()).toEqual([]);
  // The single connection is back: the place and the pool are free again.
  await vi.waitFor(async () => {
    expect(await limit(from('192.0.2.30'), 'write')).toEqual({ allowed: true });
  });
});

it('never runs a call that was still waiting for a pooled connection at its deadline', async () => {
  const limit = instance(1, { timeoutMs: 300, maxInFlight: 2 });
  const failures = await owner(async (sql) => {
    await lockTotals(sql);
    // The first call takes the only connection and waits for the lock; the second waits
    // for the pool. Both pass their deadline.
    const first = failureOf(limit(from('192.0.2.40'), 'write'));
    await delay(50);
    const second = failureOf(limit(from('192.0.2.41'), 'write'));
    const both = await Promise.all([first, second]);
    expect(await lingering()).toBe(1);
    return both;
    // The lock is released here, at about 0.4s: before the first statement's lock wait ends.
  });
  expect(failures).toMatchObject([{ code: 'timeout' }, { code: 'timeout' }]);
  // The pool serves in order, so once a third call has run the second had its turn.
  await vi.waitFor(async () => {
    expect(await limit(from('192.0.2.42'), 'write')).toEqual({ allowed: true });
  });
  // The first statement was already sent, so it ran once the lock went: counted, though
  // refused. The second never started: two rows, not three.
  expect(await storedClients()).toHaveLength(2);
  expect(await totals()).toEqual({ reads: 0, writes: 2 });
  expect(await lingering()).toBe(0);
});

it('under saturation holds no more connections than its in-flight limit, and refuses the rest at once', async () => {
  const limit = instance(4, { timeoutMs: 300, maxInFlight: 2 });
  const held = await owner(async (sql) => {
    await lockTotals(sql);
    const started = performance.now();
    const calls = Array.from({ length: 8 }, (_unused, index) =>
      outcomeOf(limit(from(`192.0.2.${String(50 + index)}`), 'read')),
    );
    await delay(100);
    const most = await lingering();
    const failures = await Promise.all(calls);
    const after = performance.now() - started;
    await untilNothingLingers(5000);
    return { failures, most, after };
  });
  // None allowed: the two that reached the store failed at their deadline, and the six
  // past the limit were told to wait without asking it.
  expect(held.failures.filter((failure) => failure === 'timeout')).toHaveLength(2);
  expect(held.failures.filter((failure) => failure !== 'timeout')).toEqual(
    Array.from({ length: 6 }, () => busy),
  );
  expect(held.most).toBe(2);
  expect(held.after).toBeLessThan(900);
  expect(await storedClients()).toEqual([]);
  await vi.waitFor(async () => {
    expect(await limit(from('192.0.2.50'), 'read')).toEqual({ allowed: true });
  });
});

it("has the role's statement timeout as the last bound on any one statement", async () => {
  const setting = await database.as('crm_app', (sql) =>
    sql.one<{ statement_timeout: string }>('show statement_timeout'),
  );
  expect(setting).toEqual({ statement_timeout: '30s' });
});
