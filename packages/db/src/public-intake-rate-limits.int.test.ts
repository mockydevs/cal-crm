// Migrations 0042 and 0089: the shared limiter for the public endpoints. One narrow
// function admits or refuses; the tables behind it are closed to every runtime role, hold
// no address, and stay bounded whatever callers do. Since 0089 the decision is made by the
// function's three-argument form, which also counts the business a request is for; the
// two-argument form calls it with no business, so every test below of the two-argument form
// is a test of the one body there is.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { testDatabase, type Role, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

// The limits in the function. A change there must be made here too, on purpose.
const CLIENT_READS = 120;
const CLIENT_WRITES = 10;
const GLOBAL_READS = 6000;
const GLOBAL_WRITES = 500;
const BUSINESS_READS = 1200;
const BUSINESS_WRITES = 100;
const MAX_CLIENTS = 4096;
const CLEANUP_BATCH = 8;

/** The current window, as the function works it out. */
const WINDOW = "date_trunc('minute', clock_timestamp(), 'UTC')";
const TABLES = ['intake.public_rate_limit_clients', 'intake.public_rate_limit_totals'];
const FUNCTION = 'private.admit_public_intake(text, bytea, bytea)';
const WITHOUT_BUSINESS = 'private.admit_public_intake(text, bytea)';

interface Decision {
  allowed: boolean;
  retry_after_seconds: number;
  reason: string;
}

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

const owner = <T>(work: (sql: Sql) => Promise<T>): Promise<T> => database.as('crm_owner', work);

const admit = (
  operation: string | null,
  digest: Buffer | null,
  role: Role = 'crm_app',
): Promise<Decision> =>
  database.as(role, (sql) =>
    sql.one<Decision>(
      'select allowed, retry_after_seconds, reason from private.admit_public_intake($1, $2)',
      [operation, digest],
    ),
  );

/** A 32-byte stand-in for a client's digest; sha256('seed-7') is also what seedMany stores. */
const digestOf = (name: string): Buffer => createHash('sha256').update(name).digest();

const seedClient = (digest: Buffer, reads: number, writes: number, minutesAgo = 0) =>
  owner((sql) =>
    sql.query(
      `insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
       values ($1, ${WINDOW} - make_interval(mins => $4), $2, $3)`,
      [digest, reads, writes, minutesAgo],
    ),
  );

/** Rows for sha256('<prefix>-1') to sha256('<prefix>-<count>'), one read each. */
const seedMany = (prefix: string, count: number, minutesAgo = 0) =>
  owner((sql) =>
    sql.query(
      `insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
       select sha256(convert_to($1::text || '-' || n::text, 'UTF8')), ${WINDOW} - make_interval(mins => $3), 1, 0
       from generate_series(1, $2::integer) as n`,
      [prefix, count, minutesAgo],
    ),
  );

const seedTotals = (reads: number, writes: number) =>
  owner((sql) =>
    sql.query(
      `update intake.public_rate_limit_totals
       set window_start = ${WINDOW}, reads = $1, writes = $2, full_window = null`,
      [reads, writes],
    ),
  );

const stored = () =>
  owner((sql) =>
    sql.one<{ rows: number; expired: number }>(
      `select count(*)::integer as rows,
              (count(*) filter (where window_start < ${WINDOW}))::integer as expired
       from intake.public_rate_limit_clients`,
    ),
  );

const client = (digest: Buffer) =>
  owner((sql) =>
    sql.query<{ reads: number; writes: number; current: boolean }>(
      `select reads, writes, window_start = ${WINDOW} as "current"
       from intake.public_rate_limit_clients where client_digest = $1`,
      [digest],
    ),
  );

const totals = () =>
  owner((sql) =>
    sql.one<{ reads: number; writes: number; current: boolean; full: boolean }>(
      `select reads, writes, window_start = ${WINDOW} as "current",
              coalesce(full_window = ${WINDOW}, false) as "full"
       from intake.public_rate_limit_totals`,
    ),
  );

const lockTotals = (sql: Sql) =>
  sql.query('select singleton from intake.public_rate_limit_totals for update');

/** Waits until this many crm_app sessions wait for a lock; the superuser may see them. */
async function waitForLockWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { waiting } = await database.as('postgres', (sql) =>
      sql.one<{ waiting: number }>(
        `select count(*)::integer as waiting from pg_stat_activity
         where datname = current_database() and usename = 'crm_app' and wait_event_type = 'Lock'`,
      ),
    );
    if (waiting >= count) return;
    await delay(10);
  }
  throw new Error(`Expected ${String(count)} sessions to wait for the totals lock.`);
}

beforeEach(async () => {
  await owner(async (sql) => {
    await sql.query('delete from intake.public_rate_limit_clients');
    await sql.query(
      `update intake.public_rate_limit_totals
       set window_start = 'epoch', reads = 0, writes = 0, full_window = null`,
    );
    // Windows follow the database's clock. With under 20 seconds of this minute left, wait
    // for the next one, so a test's seeded rows and its calls share a window.
    await sql.query(
      `select pg_sleep(case when extract(second from clock_timestamp()) > 40
                            then 60.05 - extract(second from clock_timestamp()) else 0 end)`,
    );
  });
});

describe('what is stored, and who may reach it', () => {
  it('has no column that could hold an address, a path, a token or a contact', async () => {
    const columns = await owner((sql) =>
      sql.query<{ name: string; type: string }>(
        `select table_name || '.' || column_name as name, data_type as type
         from information_schema.columns
         where table_schema = 'intake' and table_name like 'public_rate_limit%'
         order by table_name, ordinal_position`,
      ),
    );
    expect(columns).toEqual([
      { name: 'public_rate_limit_clients.client_digest', type: 'bytea' },
      { name: 'public_rate_limit_clients.window_start', type: 'timestamp with time zone' },
      { name: 'public_rate_limit_clients.reads', type: 'integer' },
      { name: 'public_rate_limit_clients.writes', type: 'integer' },
      { name: 'public_rate_limit_totals.singleton', type: 'boolean' },
      { name: 'public_rate_limit_totals.window_start', type: 'timestamp with time zone' },
      { name: 'public_rate_limit_totals.reads', type: 'integer' },
      { name: 'public_rate_limit_totals.writes', type: 'integer' },
      { name: 'public_rate_limit_totals.full_window', type: 'timestamp with time zone' },
    ]);
  });

  it('stores a digest of exactly 32 bytes, and one totals row only', async () => {
    await expect(seedClient(Buffer.alloc(31, 1), 0, 0)).rejects.toMatchObject({
      code: '23514',
      constraint: 'public_rate_limit_clients_digest_length',
    });
    await expect(
      owner((sql) =>
        sql.query(
          `insert into intake.public_rate_limit_totals (singleton, window_start, reads, writes)
           values (false, 'epoch', 0, 0)`,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'public_rate_limit_totals_one_row' });
    await expect(
      owner((sql) =>
        sql.query(
          `insert into intake.public_rate_limit_totals (window_start, reads, writes)
           values ('epoch', 0, 0)`,
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('forces row-level security with a policy that matches no row', async () => {
    const tables = await owner((sql) =>
      sql.query<{ name: string; enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.oid::regclass::text as name, c.relrowsecurity as enabled,
                c.relforcerowsecurity as forced,
                array(select p.polname || ' ' || pg_get_expr(p.polqual, p.polrelid) || ' '
                             || pg_get_expr(p.polwithcheck, p.polrelid)
                      from pg_policy p where p.polrelid = c.oid)::text[] as policies
         from pg_class c where c.oid = any($1::regclass[]) order by 1`,
        [TABLES],
      ),
    );
    expect(tables).toEqual(
      TABLES.map((name) => ({
        name,
        enabled: true,
        forced: true,
        policies: ['limiter_function_only false false'],
      })),
    );
  });

  it('grants no runtime role anything on the tables', async () => {
    const granted = await owner((sql) =>
      sql.query<{ granted: string }>(
        `select r.rolname || ' ' || p.verb || ' ' || t.name as granted
         from unnest($1::text[]) as t (name)
         cross join unnest(array['crm_app', 'crm_auth', 'crm_worker']) as r (rolname)
         cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate']) as p (verb)
         where has_table_privilege(r.rolname, t.name, p.verb)`,
        [TABLES],
      ),
    );
    expect(granted).toEqual([]);
  });

  it.each(['crm_app', 'crm_auth', 'crm_worker'] as const)(
    'refuses %s direct reads and writes of both tables',
    async (role) => {
      for (const statement of [
        'select * from intake.public_rate_limit_clients',
        `insert into intake.public_rate_limit_clients (client_digest, window_start, reads, writes)
         values (sha256('x'::bytea), now(), 0, 0)`,
        'update intake.public_rate_limit_clients set reads = 0',
        'delete from intake.public_rate_limit_clients',
        'select * from intake.public_rate_limit_totals',
        'update intake.public_rate_limit_totals set reads = 0, writes = 0',
        'delete from intake.public_rate_limit_totals',
      ])
        await expect(database.as(role, (sql) => sql.query(statement))).rejects.toMatchObject({
          code: '42501',
        });
    },
  );

  it('is one SECURITY DEFINER function with an empty search_path, for crm_app alone', async () => {
    const [definition, ...others] = await owner((sql) =>
      sql.query<{
        owner: string;
        definer: boolean;
        volatility: string;
        settings: string[];
        public_may_execute: boolean;
        grantees: string[];
      }>(
        `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
                p.provolatile::text as volatility,
                array(select unnest(p.proconfig) order by 1)::text[] as settings,
                p.proacl is null
                  or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
                  as public_may_execute,
                array(select a.grantee::regrole::text from aclexplode(p.proacl) a
                      where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
                      order by 1)::text[] as grantees
         from pg_proc p where p.oid = $1::regprocedure`,
        [FUNCTION],
      ),
    );
    expect(others).toEqual([]);
    expect(definition).toEqual({
      owner: 'crm_owner',
      definer: true,
      volatility: 'v',
      settings: ['lock_timeout=1s', 'search_path=""'],
      public_may_execute: false,
      grantees: ['crm_app'],
    });
    // Its two-argument form, for a server of the release before: closed the same way, and
    // nothing of its own to decide with.
    const [older] = await owner((sql) =>
      sql.query<{ definer: boolean; settings: string[]; grantees: string[]; body: string }>(
        `select p.prosecdef as definer,
                array(select unnest(p.proconfig) order by 1)::text[] as settings,
                array(select a.grantee::regrole::text from aclexplode(p.proacl) a
                      where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
                      order by 1)::text[] as grantees,
                p.prosrc as body
         from pg_proc p where p.oid = $1::regprocedure`,
        [WITHOUT_BUSINESS],
      ),
    );
    expect(older).toMatchObject({
      definer: true,
      settings: ['search_path=""'],
      grantees: ['crm_app'],
    });
    expect(older?.body).toContain('private.admit_public_intake(p_operation, p_client_digest, null');
    expect(older?.body).not.toMatch(/intake\.public_rate_limit/);
    const overloads = await owner((sql) =>
      sql.one<{ count: number }>(
        "select count(*)::integer as count from pg_proc where proname = 'admit_public_intake'",
      ),
    );
    expect(overloads).toEqual({ count: 2 });
  });

  it.each(['crm_auth', 'crm_worker'] as const)('refuses %s the function', async (role) => {
    await expect(admit('read', digestOf('other-role'), role)).rejects.toMatchObject({
      code: '42501',
    });
    expect(await stored()).toMatchObject({ rows: 0 });
  });
});

describe('what a caller may pass', () => {
  it.each([
    null,
    '',
    'READ',
    'read ',
    'delete',
    'read; drop table intake.public_rate_limit_totals',
  ])('refuses the operation %s', async (operation) => {
    const failure: unknown = await admit(operation, digestOf('caller')).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: '22023' });
    expect(failure).toHaveProperty('message', 'the operation must be read or write');
    expect(await stored()).toMatchObject({ rows: 0 });
  });

  it.each([
    ['none', null],
    ['an empty one', Buffer.alloc(0)],
    ['31 bytes', Buffer.alloc(31, 7)],
    ['33 bytes', Buffer.alloc(33, 7)],
    ['an address as text', Buffer.from('203.0.113.9')],
  ])('refuses a digest that is not 32 bytes: %s', async (_name, digest) => {
    const failure: unknown = await admit('write', digest).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: '22023' });
    expect(failure).toHaveProperty('message', 'the client digest must be 32 bytes');
    // Whatever was passed is not repeated back, in any field of the error.
    expect(JSON.stringify(failure)).not.toContain('203.0.113.9');
    expect(await stored()).toMatchObject({ rows: 0 });
  });
});

describe('the quotas of one client', () => {
  it('admits 120 reads and 10 writes a minute, counted apart, and refuses the next of each', async () => {
    const one = digestOf('one');
    const other = digestOf('other');
    for (let read = 1; read <= CLIENT_READS; read += 1)
      expect(await admit('read', one)).toEqual({
        allowed: true,
        retry_after_seconds: 0,
        reason: 'admitted',
      });
    const refusedRead = await admit('read', one);
    expect(refusedRead).toMatchObject({ allowed: false, reason: 'client_quota' });

    for (let write = 1; write <= CLIENT_WRITES; write += 1)
      expect(await admit('write', one)).toMatchObject({ allowed: true, reason: 'admitted' });
    expect(await admit('write', one)).toMatchObject({ allowed: false, reason: 'client_quota' });
    expect(await admit('read', one)).toMatchObject({ allowed: false, reason: 'client_quota' });

    // Another client has its own quota, and a refusal counted nowhere.
    expect(await admit('read', other)).toMatchObject({ allowed: true });
    expect(await admit('write', other)).toMatchObject({ allowed: true });
    expect(await client(one)).toEqual([
      { reads: CLIENT_READS, writes: CLIENT_WRITES, current: true },
    ]);
    expect(await totals()).toMatchObject({
      reads: CLIENT_READS + 1,
      writes: CLIENT_WRITES + 1,
      current: true,
    });
  });

  it('says how many whole seconds remain of the minute, from 1 to 60', async () => {
    const one = digestOf('retry');
    await seedClient(one, CLIENT_READS, 0);
    const before = await owner((sql) =>
      sql.one<{ remaining: number }>(
        `select ceil(extract(epoch from ${WINDOW} + interval '1 minute' - clock_timestamp()))::integer
                as remaining`,
      ),
    );
    const refusal = await admit('read', one);
    expect(refusal).toMatchObject({ allowed: false, reason: 'client_quota' });
    expect(Number.isInteger(refusal.retry_after_seconds)).toBe(true);
    expect(refusal.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(refusal.retry_after_seconds).toBeLessThanOrEqual(60);
    // Time only passed between the two readings, by far less than the 20 seconds left.
    expect(refusal.retry_after_seconds).toBeLessThanOrEqual(before.remaining);
    expect(refusal.retry_after_seconds).toBeGreaterThanOrEqual(before.remaining - 5);
  });

  it('admits again in a new minute, and reuses the row', async () => {
    const one = digestOf('next-minute');
    await seedClient(one, CLIENT_READS, CLIENT_WRITES, 1);
    await owner((sql) =>
      sql.query(
        `update intake.public_rate_limit_totals
         set window_start = ${WINDOW} - interval '1 minute', reads = $1, writes = $2`,
        [GLOBAL_READS, GLOBAL_WRITES],
      ),
    );
    expect(await admit('write', one)).toMatchObject({ allowed: true });
    expect(await admit('read', one)).toMatchObject({ allowed: true });
    expect(await client(one)).toEqual([{ reads: 1, writes: 1, current: true }]);
    expect(await totals()).toMatchObject({ reads: 1, writes: 1, current: true });
  });
});

describe('atomic admission', () => {
  it('admits exactly the quota when many connections race for it', async () => {
    const one = digestOf('racer');
    const reads = await Promise.all(Array.from({ length: 150 }, () => admit('read', one)));
    const writes = await Promise.all(Array.from({ length: 40 }, () => admit('write', one)));
    expect(reads.filter((decision) => decision.allowed)).toHaveLength(CLIENT_READS);
    expect(writes.filter((decision) => decision.allowed)).toHaveLength(CLIENT_WRITES);
    for (const decision of [...reads, ...writes].filter((each) => !each.allowed))
      expect(decision).toMatchObject({ reason: 'client_quota' });
    expect(await client(one)).toEqual([
      { reads: CLIENT_READS, writes: CLIENT_WRITES, current: true },
    ]);
    expect(await totals()).toMatchObject({ reads: CLIENT_READS, writes: CLIENT_WRITES });
  });

  it('admits one of two calls that both saw the last free slot before the lock', async () => {
    const one = digestOf('last-slot');
    await seedClient(one, CLIENT_READS - 1, 0);
    await seedTotals(CLIENT_READS - 1, 0);
    // Both calls pass the first, unlocked pass (119 of 120) and then wait for the lock.
    const { racing } = await owner(async (sql) => {
      await lockTotals(sql);
      const both = Promise.all([admit('read', one), admit('read', one)]);
      both.catch(() => undefined);
      await waitForLockWaiters(2);
      return { racing: both };
    });
    const decisions = await racing;
    expect(decisions.map((decision) => decision.reason).sort()).toEqual([
      'admitted',
      'client_quota',
    ]);
    expect(await client(one)).toEqual([{ reads: CLIENT_READS, writes: 0, current: true }]);
    expect(await totals()).toMatchObject({ reads: CLIENT_READS });
  });

  it('refuses a caller in a repeatable-read transaction once another admission committed', async () => {
    const one = digestOf('repeatable');
    await expect(
      database.as('crm_app', async (sql) => {
        await sql.query('set transaction isolation level repeatable read');
        // The transaction's snapshot is taken here, before the other admission.
        await sql.query('select 1');
        await admit('read', digestOf('someone-else'));
        return sql.one<Decision>(
          'select allowed, retry_after_seconds, reason from private.admit_public_intake($1, $2)',
          ['read', one],
        );
      }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(await client(one)).toEqual([]);
  });
});

describe('the lock', () => {
  it('is not needed to refuse what is already decided, and is waited for one second at most', async () => {
    const over = digestOf('over-quota');
    await seedClient(over, CLIENT_READS, 0);
    const waited = await owner(async (sql) => {
      await lockTotals(sql);
      // Read-only refusals return while the lock is held by someone else.
      expect(await admit('read', over)).toMatchObject({ allowed: false, reason: 'client_quota' });
      const started = performance.now();
      await expect(admit('read', digestOf('fresh'))).rejects.toMatchObject({ code: '55P03' });
      return performance.now() - started;
    });
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(10_000);
    expect(await client(digestOf('fresh'))).toEqual([]);
  });

  it('is not needed to refuse at the global ceiling or at a full table', async () => {
    await seedTotals(GLOBAL_READS, 0);
    await owner(async (sql) => {
      await lockTotals(sql);
      expect(await admit('read', digestOf('late'))).toMatchObject({
        allowed: false,
        reason: 'global_ceiling',
      });
    });
    await seedTotals(0, 0);
    await owner((sql) =>
      sql.query(`update intake.public_rate_limit_totals set full_window = ${WINDOW}`),
    );
    await owner(async (sql) => {
      await lockTotals(sql);
      expect(await admit('read', digestOf('late'))).toMatchObject({
        allowed: false,
        reason: 'storage_full',
      });
    });
    expect(await stored()).toMatchObject({ rows: 0 });
  });

  it('fails, rather than admit, when the totals row is gone', async () => {
    await owner((sql) => sql.query('delete from intake.public_rate_limit_totals'));
    try {
      const failure: unknown = await admit('read', digestOf('no-totals')).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'P0001' });
      expect(failure).toHaveProperty('message', 'the public intake totals row is missing');
      expect(await stored()).toMatchObject({ rows: 0 });
    } finally {
      await owner((sql) =>
        sql.query(
          `insert into intake.public_rate_limit_totals (window_start, reads, writes)
           values ('epoch', 0, 0)`,
        ),
      );
    }
  });
});

describe('the global ceiling', () => {
  it('refuses fresh clients once all clients together reached it, and counts nothing for them', async () => {
    await seedTotals(GLOBAL_READS - 1, GLOBAL_WRITES - 1);
    expect(await admit('read', digestOf('reader-1'))).toMatchObject({ allowed: true });
    expect(await admit('write', digestOf('writer-1'))).toMatchObject({ allowed: true });

    const read = await admit('read', digestOf('reader-2'));
    expect(read).toMatchObject({ allowed: false, reason: 'global_ceiling' });
    expect(read.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(read.retry_after_seconds).toBeLessThanOrEqual(60);
    expect(await admit('write', digestOf('writer-2'))).toMatchObject({
      allowed: false,
      reason: 'global_ceiling',
    });

    // No row for the refused clients, and no counter moved.
    expect(await stored()).toMatchObject({ rows: 2 });
    expect(await client(digestOf('reader-2'))).toEqual([]);
    expect(await totals()).toMatchObject({ reads: GLOBAL_READS, writes: GLOBAL_WRITES });
  });

  it('keeps reads and writes apart: a full read ceiling leaves writes open', async () => {
    await seedTotals(GLOBAL_READS, 0);
    expect(await admit('write', digestOf('writer'))).toMatchObject({ allowed: true });
    expect(await admit('read', digestOf('writer'))).toMatchObject({
      allowed: false,
      reason: 'global_ceiling',
    });
  });

  it('is exact when many fresh clients race for its last slots', async () => {
    await seedTotals(0, GLOBAL_WRITES - 10);
    const decisions = await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        admit('write', digestOf(`racer-${String(index)}`)),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(decisions.filter((decision) => decision.reason === 'global_ceiling')).toHaveLength(30);
    expect(await stored()).toMatchObject({ rows: 10 });
    expect(await totals()).toMatchObject({ writes: GLOBAL_WRITES });
  });

  it('is not used up by a client over its own quota', async () => {
    const greedy = digestOf('greedy');
    await seedClient(greedy, 0, CLIENT_WRITES);
    await seedTotals(0, CLIENT_WRITES);
    for (let attempt = 0; attempt < 25; attempt += 1)
      expect(await admit('write', greedy)).toMatchObject({ reason: 'client_quota' });
    expect(await totals()).toMatchObject({ writes: CLIENT_WRITES });
  });
});

describe('bounded storage', () => {
  it('refuses a new client at the row cap, inserts nothing, and still serves known clients', async () => {
    await seedMany('seed', MAX_CLIENTS);
    await seedTotals(MAX_CLIENTS, 0);
    const refusal = await admit('read', digestOf('one-too-many'));
    expect(refusal).toMatchObject({ allowed: false, reason: 'storage_full' });
    expect(refusal.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(refusal.retry_after_seconds).toBeLessThanOrEqual(60);
    expect(await stored()).toEqual({ rows: MAX_CLIENTS, expired: 0 });
    expect(await client(digestOf('one-too-many'))).toEqual([]);
    // Found full of rows that still count: remembered for this minute, and nothing counted.
    expect(await totals()).toMatchObject({ reads: MAX_CLIENTS, full: true });

    expect(await admit('write', digestOf('another-new-one'))).toMatchObject({
      allowed: false,
      reason: 'storage_full',
    });
    expect(await admit('read', digestOf('seed-7'))).toMatchObject({ allowed: true });
    expect(await client(digestOf('seed-7'))).toEqual([{ reads: 2, writes: 0, current: true }]);
    expect(await stored()).toEqual({ rows: MAX_CLIENTS, expired: 0 });
  });

  it('makes room at the cap by deleting expired rows, eight a call', async () => {
    await seedMany('old', MAX_CLIENTS, 1);
    expect(await admit('read', digestOf('new-1'))).toMatchObject({ allowed: true });
    expect(await stored()).toEqual({
      rows: MAX_CLIENTS - CLEANUP_BATCH + 1,
      expired: MAX_CLIENTS - CLEANUP_BATCH,
    });
    expect(await totals()).toMatchObject({ full: false });
    expect(await admit('read', digestOf('new-2'))).toMatchObject({ allowed: true });
    expect(await stored()).toEqual({
      rows: MAX_CLIENTS - 2 * CLEANUP_BATCH + 2,
      expired: MAX_CLIENTS - 2 * CLEANUP_BATCH,
    });
  });

  it('deletes the oldest rows first and never a row that still counts', async () => {
    await seedMany('older', CLEANUP_BATCH, 3);
    await seedMany('old', 12, 1);
    await seedMany('current', 5);
    expect(await admit('read', digestOf('new-1'))).toMatchObject({ allowed: true });
    const older = await owner((sql) =>
      sql.one<{ rows: number }>(
        `select count(*)::integer as rows from intake.public_rate_limit_clients
         where window_start < ${WINDOW} - interval '2 minutes'`,
      ),
    );
    expect(older).toEqual({ rows: 0 });
    expect(await stored()).toEqual({ rows: 12 + 5 + 1, expired: 12 });
    expect(await admit('read', digestOf('new-2'))).toMatchObject({ allowed: true });
    expect(await admit('read', digestOf('new-3'))).toMatchObject({ allowed: true });
    expect(await stored()).toEqual({ rows: 5 + 3, expired: 0 });
    expect(await client(digestOf('current-3'))).toEqual([{ reads: 1, writes: 0, current: true }]);
  });

  it('cleans on calls from known clients too, and does not clean on refusals', async () => {
    await seedMany('old', 20, 1);
    await seedClient(digestOf('known'), 1, 0);
    await seedClient(digestOf('over'), CLIENT_READS, 0);
    expect(await admit('read', digestOf('over'))).toMatchObject({ reason: 'client_quota' });
    expect(await stored()).toEqual({ rows: 22, expired: 20 });
    expect(await admit('read', digestOf('known'))).toMatchObject({ allowed: true });
    expect(await stored()).toEqual({ rows: 22 - CLEANUP_BATCH, expired: 20 - CLEANUP_BATCH });
  });

  it('stays at the cap while addresses churn, and does the same bounded work for each', async () => {
    // A full minute of new addresses: 96 fit, the rest are refused, none is stored past the cap.
    await seedMany('seed', MAX_CLIENTS - 96);
    const decisions: Decision[] = [];
    for (let address = 0; address < 300; address += 1) {
      decisions.push(await admit('read', digestOf(`churn-${String(address)}`)));
      if (address % 50 === 0) expect((await stored()).rows).toBeLessThanOrEqual(MAX_CLIENTS);
    }
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(96);
    expect(decisions.filter((decision) => decision.reason === 'storage_full')).toHaveLength(204);
    expect(await stored()).toEqual({ rows: MAX_CLIENTS, expired: 0 });
    expect(await totals()).toMatchObject({ reads: 96, full: true });
  });

  it('shrinks a table of expired rows by exactly eight for each churned address', async () => {
    await seedMany('old', MAX_CLIENTS, 1);
    for (let address = 0; address < 300; address += 1)
      expect(await admit('read', digestOf(`churn-${String(address)}`))).toMatchObject({
        allowed: true,
      });
    // 300 calls deleted 8 each, no more: the work per call does not grow with the backlog.
    expect(await stored()).toEqual({
      rows: MAX_CLIENTS - 300 * CLEANUP_BATCH + 300,
      expired: MAX_CLIENTS - 300 * CLEANUP_BATCH,
    });
  });
});

describe('the ceiling of one business (0089)', () => {
  const admitFor = (
    operation: string,
    digest: Buffer,
    business: Buffer | null,
    role: Role = 'crm_app',
  ): Promise<Decision> =>
    database.as(role, (sql) =>
      sql.one<Decision>(
        'select allowed, retry_after_seconds, reason from private.admit_public_intake($1, $2, $3)',
        [operation, digest, business],
      ),
    );
  const harbor = digestOf('business-harbor');
  const summit = digestOf('business-summit');

  it('admits a business its writes from any number of clients, and refuses the next there', async () => {
    await seedClient(harbor, 0, BUSINESS_WRITES - 2);
    expect(await admitFor('write', digestOf('visitor-1'), harbor)).toMatchObject({
      allowed: true,
      reason: 'admitted',
    });
    expect(await admitFor('write', digestOf('visitor-2'), harbor)).toMatchObject({ allowed: true });
    const refused = await admitFor('write', digestOf('visitor-3'), harbor);
    expect(refused).toMatchObject({ allowed: false, reason: 'scope_quota' });
    expect(refused.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(refused.retry_after_seconds).toBeLessThanOrEqual(60);
    // What was refused is counted nowhere: not for the visitor, not for the install.
    expect(await client(digestOf('visitor-3'))).toEqual([]);
    expect(await totals()).toMatchObject({ reads: 0, writes: 2 });
    expect(await client(harbor)).toEqual([{ reads: 0, writes: BUSINESS_WRITES, current: true }]);
    // Its reads are counted apart, and another business has a ceiling of its own.
    expect(await admitFor('read', digestOf('visitor-3'), harbor)).toMatchObject({ allowed: true });
    expect(await admitFor('write', digestOf('visitor-3'), summit)).toMatchObject({ allowed: true });
    // So has a request that names no business.
    expect(await admitFor('write', digestOf('visitor-4'), null)).toMatchObject({ allowed: true });
    expect(await admit('write', digestOf('visitor-5'))).toMatchObject({ allowed: true });
  });

  it('refuses a business its reads past their own ceiling, and no sooner', async () => {
    await seedClient(harbor, BUSINESS_READS - 1, 0);
    expect(await admitFor('read', digestOf('reader-1'), harbor)).toMatchObject({ allowed: true });
    expect(await admitFor('read', digestOf('reader-2'), harbor)).toMatchObject({
      allowed: false,
      reason: 'scope_quota',
    });
    expect(await admitFor('write', digestOf('reader-2'), harbor)).toMatchObject({ allowed: true });
  });

  it('says a client is over its own quota before it looks at the business, and counts nothing', async () => {
    const greedy = digestOf('greedy');
    await seedClient(greedy, 0, CLIENT_WRITES);
    await seedClient(harbor, 0, 5);
    expect(await admitFor('write', greedy, harbor)).toMatchObject({ reason: 'client_quota' });
    expect(await client(harbor)).toEqual([{ reads: 0, writes: 5, current: true }]);
  });

  it('leaves the install’s ceiling to the others: a business at its own adds nothing to it', async () => {
    await seedTotals(0, GLOBAL_WRITES - 1);
    await seedClient(harbor, 0, BUSINESS_WRITES);
    for (let attempt = 0; attempt < 20; attempt += 1)
      expect(await admitFor('write', digestOf(`flood-${String(attempt)}`), harbor)).toMatchObject({
        reason: 'scope_quota',
      });
    expect(await totals()).toMatchObject({ writes: GLOBAL_WRITES - 1 });
    // The install's last place is still there for another business, and then it is full.
    expect(await admitFor('write', digestOf('other-1'), summit)).toMatchObject({ allowed: true });
    expect(await admitFor('write', digestOf('other-2'), summit)).toMatchObject({
      allowed: false,
      reason: 'global_ceiling',
    });
  });

  it('admits exactly a business’s ceiling when many clients race for its last places', async () => {
    await seedClient(harbor, 0, BUSINESS_WRITES - 5);
    const decisions = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        admitFor('write', digestOf(`racer-${String(index)}`), harbor),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions.filter((decision) => decision.reason === 'scope_quota')).toHaveLength(25);
    expect(await client(harbor)).toEqual([{ reads: 0, writes: BUSINESS_WRITES, current: true }]);
  });

  it('starts a business’s minute again with the clock, reusing its row', async () => {
    await seedClient(harbor, BUSINESS_READS, BUSINESS_WRITES, 1);
    expect(await admitFor('write', digestOf('visitor'), harbor)).toMatchObject({ allowed: true });
    expect(await client(harbor)).toEqual([{ reads: 0, writes: 1, current: true }]);
  });

  it('keeps a business’s row within the table’s bound: at the cap a new one is refused, a known one served', async () => {
    await seedMany('seed', MAX_CLIENTS - 1);
    // One place left, and this request needs two rows (its client's and its business's).
    expect(await admitFor('read', digestOf('newcomer'), harbor)).toMatchObject({
      allowed: false,
      reason: 'storage_full',
    });
    expect(await stored()).toMatchObject({ rows: MAX_CLIENTS - 1 });
    // A known client of a known business adds no row, and is served.
    await owner((sql) =>
      sql.query('delete from intake.public_rate_limit_clients where client_digest = $1', [
        digestOf('seed-1'),
      ]),
    );
    await seedClient(harbor, 0, 0);
    expect(await admitFor('read', digestOf('seed-7'), harbor)).toMatchObject({ allowed: true });
    expect(await stored()).toMatchObject({ rows: MAX_CLIENTS - 1 });
  });

  it('never deletes the row of the business it is counting, however old', async () => {
    await seedClient(harbor, 3, 3, 5);
    await seedMany('old', CLEANUP_BATCH + 4, 9);
    expect(await admitFor('read', digestOf('visitor'), harbor)).toMatchObject({ allowed: true });
    expect(await client(harbor)).toEqual([{ reads: 1, writes: 0, current: true }]);
    expect(await stored()).toMatchObject({ rows: 4 + 2 });
  });

  it.each([Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(0)])(
    'refuses a business digest that is not 32 bytes',
    async (business) => {
      await expect(admitFor('read', digestOf('visitor'), business)).rejects.toMatchObject({
        code: '22023',
      });
    },
  );

  it('refuses a business digest that is the client’s own, which would count one row twice', async () => {
    const same = digestOf('same');
    await expect(admitFor('read', same, same)).rejects.toMatchObject({ code: '22023' });
    expect(await stored()).toMatchObject({ rows: 0 });
  });

  it.each(['crm_auth', 'crm_worker'] as const)('refuses %s the function', async (role) => {
    await expect(admitFor('read', digestOf('other-role'), harbor, role)).rejects.toMatchObject({
      code: '42501',
    });
  });
});
