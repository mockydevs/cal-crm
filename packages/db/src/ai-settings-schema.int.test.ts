// Migration 0051 (Settings → AI models) at the database's own level: the result of a test
// kept on a provider's key, the new ai.connection_tests with its grants and policy, and
// what the migration does to keys an install already had. What Settings and the gateway do
// with these tables is the AI module's to prove (packages/modules/ai).
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TenantContext } from '@repo/kernel';
import { startPostgres, testDatabase, type Postgres, type TestDatabase } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const SETTINGS = '0051_ai_settings.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Every way a test can end: what a provider said, then why it was not asked. */
const OUTCOMES = [
  'ok',
  'authentication',
  'billing',
  'rate_limited',
  'unavailable',
  'timeout',
  'invalid_request',
  'invalid_response',
  'blocked_address',
  'not_found',
  'limit_reached',
  'price_unknown',
  'ai_off',
  'key_unreadable',
  'not_supported',
  'no_model',
  'expired',
];

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function business(agencyId?: string) {
  const agency = agencyId ?? (await database.fixtures.agency()).id;
  const created = await database.fixtures.business(agency);
  const context: TenantContext = { ...created.context, correlationId: randomUUID() };
  const agencyContext: TenantContext = {
    agencyId: context.agencyId,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  return { context, agencyContext };
}
const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

/** A key for a model server that asks for none, in the context's own place. */
const connection = (context: TenantContext, columns: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    provider: 'openai_compatible',
    base_url: 'http://ollama:11434/v1',
    ...columns,
  };
  const names = Object.keys(row);
  return database.withTenant(context, (sql) =>
    sql.one<{ id: string }>(
      `insert into ai.provider_keys (agency_id, business_id, ${names.join(', ')})
       values (app.agency_id(), app.business_id(), ${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
       returning *`,
      names.map((name) => row[name]),
    ),
  );
};

/** One test of a connection; every column a test does not name is as the app writes it. */
const test = (
  context: TenantContext,
  connectionId: string,
  columns: Record<string, unknown> = {},
) => {
  const row: Record<string, unknown> = { connection_id: connectionId, ...columns };
  const names = Object.keys(row);
  return database.withTenant(context, (sql) =>
    sql.one(
      `insert into ai.connection_tests (agency_id, business_id, ${names.join(', ')})
       values (app.agency_id(), app.business_id(), ${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
       returning *`,
      names.map((name) => row[name]),
    ),
  );
};
const finished = { status: 'finished', outcome: 'ok', finished_at: '2026-10-10T09:00:01Z' };

describe('a provider’s key, tested', () => {
  it('is untested until a test reached the provider, and then says what the test found', async () => {
    const { context } = await business();
    const { id } = await connection(context);
    const read = () =>
      database.withTenant(context, (sql) =>
        sql.one(
          `select status, last_tested_at, last_test_latency_ms, last_test_outcome
           from ai.provider_keys where id = $1`,
          [id],
        ),
      );
    expect(await read()).toEqual({
      status: 'untested',
      last_tested_at: null,
      last_test_latency_ms: null,
      last_test_outcome: null,
    });
    await database.withTenant(context, (sql) =>
      sql.query(
        `update ai.provider_keys
         set status = 'failing', last_tested_at = '2026-10-10T09:00:00Z',
             last_test_latency_ms = 812, last_test_outcome = 'authentication'
         where id = $1`,
        [id],
      ),
    );
    expect(await read()).toEqual({
      status: 'failing',
      last_tested_at: new Date('2026-10-10T09:00:00Z'),
      last_test_latency_ms: 812,
      last_test_outcome: 'authentication',
    });
  });

  it('cannot say it works with no test behind it, or keep a result it calls untested', async () => {
    const { context } = await business();
    await refused(
      connection(context, { status: 'working' }),
      'provider_keys_untested_has_no_result',
    );
    await refused(
      connection(context, {
        status: 'working',
        last_tested_at: '2026-10-10T09:00:00Z',
      }),
      'provider_keys_tested_together',
    );
    await refused(
      connection(context, {
        last_tested_at: '2026-10-10T09:00:00Z',
        last_test_outcome: 'ok',
      }),
      'provider_keys_untested_has_no_result',
    );
    await refused(
      connection(context, { last_test_outcome: 'ok' }),
      'provider_keys_tested_together',
    );
  });

  it('keeps every outcome a test can have, and no other word', async () => {
    const { context } = await business();
    for (const [index, outcome] of OUTCOMES.entries())
      await connection(context, {
        label: `server ${String(index)}`,
        status: outcome === 'ok' ? 'working' : 'failing',
        last_tested_at: '2026-10-10T09:00:00Z',
        last_test_outcome: outcome,
      });
    await refused(
      connection(context, {
        label: 'another',
        status: 'failing',
        last_tested_at: '2026-10-10T09:00:00Z',
        last_test_outcome: 'broken',
      }),
      'provider_keys_last_test_outcome_valid',
    );
  });

  it('has a model name and an address of a length a person could have typed', async () => {
    const { context } = await business();
    await refused(connection(context, { default_model: '' }), 'provider_keys_model_length');
    await refused(
      connection(context, { default_model: 'm'.repeat(201) }),
      'provider_keys_model_length',
    );
    await refused(connection(context, { base_url: '' }), 'provider_keys_base_url_length');
    await refused(
      connection(context, { base_url: `https://${'a'.repeat(2000)}` }),
      'provider_keys_base_url_length',
    );
    await connection(context, { default_model: 'm'.repeat(200) });
  });
});

describe('ai.connection_tests', () => {
  it('has forced row-level security with the scoped policy', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                array(select format('%s %s %s', p.policyname, p.permissive, p.cmd)
                      from pg_policies p
                      where p.schemaname = 'ai' and p.tablename = 'connection_tests' order by 1) as policies
         from pg_class c where c.oid = 'ai.connection_tests'::regclass`,
      ),
    );
    expect(rows).toEqual([
      { enabled: true, forced: true, policies: ['scoped_isolation PERMISSIVE ALL'] },
    ]);
  });

  it('grants crm_app what it uses and nothing to the other runtime roles', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ grantee: string; privileges: string[] }>(
        `select grantee::text, array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema = 'ai' and table_name = 'connection_tests'
           and grantee in ('crm_app', 'crm_auth', 'crm_worker', 'PUBLIC')
         group by 1 order by 1`,
      ),
    );
    expect(grants).toEqual([
      { grantee: 'crm_app', privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
    ]);
  });

  it('has an index for each thing it points at, and for the month’s spend by job', async () => {
    const indexes = await database.as('crm_owner', (sql) =>
      sql.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
         where schemaname = 'ai'
           and indexname in ('connection_tests_connection_idx', 'connection_tests_business_idx',
                             'connection_tests_request_idx', 'requests_month_job_idx')
         order by indexname`,
      ),
    );
    expect(indexes.map((index) => index.indexdef)).toEqual([
      'CREATE INDEX connection_tests_business_idx ON ai.connection_tests USING btree (agency_id, business_id)',
      'CREATE INDEX connection_tests_connection_idx ON ai.connection_tests USING btree (connection_id, created_at DESC)',
      'CREATE INDEX connection_tests_request_idx ON ai.connection_tests USING btree (business_id, request_id)',
      'CREATE INDEX requests_month_job_idx ON ai.requests USING btree (business_id, started_at, job) INCLUDE (cost_estimate, status)',
    ]);
  });

  it('starts pending, with two minutes for a worker to run it, and ends with what happened', async () => {
    const { context } = await business();
    const { id } = await connection(context);
    const started = await test(context, id);
    expect(started).toMatchObject({
      status: 'pending',
      outcome: null,
      latency_ms: null,
      request_id: null,
      finished_at: null,
    });
    const { created_at: createdAt, expires_at: expiresAt } = started as {
      created_at: Date;
      expires_at: Date;
    };
    expect(expiresAt.getTime() - createdAt.getTime()).toBe(120_000);
    const [ended] = await database.withTenant(context, (sql) =>
      sql.query(
        `update ai.connection_tests
         set status = 'finished', outcome = 'authentication', latency_ms = 640, finished_at = now()
         where id = $1 returning status, outcome, latency_ms`,
        [started['id']],
      ),
    );
    expect(ended).toEqual({ status: 'finished', outcome: 'authentication', latency_ms: 640 });
  });

  it('is finished exactly when it has an end and an outcome', async () => {
    const { context } = await business();
    const { id } = await connection(context);
    await refused(
      test(context, id, { status: 'finished', outcome: 'ok' }),
      'connection_tests_finished_together',
    );
    await refused(
      test(context, id, { status: 'finished', finished_at: '2026-10-10T09:00:01Z' }),
      'connection_tests_finished_together',
    );
    await refused(test(context, id, { outcome: 'ok' }), 'connection_tests_finished_together');
    await refused(
      test(context, id, { finished_at: '2026-10-10T09:00:01Z' }),
      'connection_tests_finished_together',
    );
    await refused(
      test(context, id, { ...finished, status: 'running' }),
      'connection_tests_status_valid',
    );
    await refused(
      test(context, id, { ...finished, outcome: 'broken' }),
      'connection_tests_outcome_valid',
    );
    await refused(
      test(context, id, { ...finished, latency_ms: -1 }),
      'connection_tests_latency_nonnegative',
    );
    for (const outcome of OUTCOMES)
      expect(await test(context, id, { ...finished, outcome })).toMatchObject({ outcome });
  });

  it('names the call it made, in its own business, and outlives that call’s row', async () => {
    const { context, agencyContext } = await business();
    const other = await business(context.agencyId);
    const { id } = await connection(context);
    const call = (where: TenantContext) =>
      database.withTenant(where, (sql) =>
        sql.one<{ id: string }>(
          `insert into ai.requests (business_id, job, provider, model, key_source, status, actor_kind, finished_at)
           values (app.business_id(), 'connection_test', 'openai_compatible', 'llama3.2', 'own', 'ok',
                   'user', now()) returning id`,
        ),
      );
    const mine = await call(context);
    const tested = await test(context, id, { ...finished, request_id: mine.id });
    expect(tested).toMatchObject({ request_id: mine.id });

    // Another business's call cannot be named: the pair (business, call) must exist.
    const theirs = await call(other.context);
    await expect(test(context, id, { ...finished, request_id: theirs.id })).rejects.toMatchObject({
      code: '23503',
    });

    // A test asked at the agency called no model, so it has no call to name.
    const shared = await connection(agencyContext);
    await refused(
      test(agencyContext, shared.id, { ...finished, request_id: mine.id }),
      'connection_tests_call_needs_business',
    );

    await database.as('crm_owner', (sql) =>
      sql.query('delete from ai.requests where id = $1', [mine.id]),
    );
    const [left] = await database.withTenant(context, (sql) =>
      sql.query('select request_id, outcome from ai.connection_tests where id = $1', [
        tested['id'],
      ]),
    );
    expect(left).toEqual({ request_id: null, outcome: 'ok' });
  });

  it('goes with its connection', async () => {
    const { context } = await business();
    const { id } = await connection(context);
    await test(context, id);
    const left = await database.withTenant(context, async (sql) => {
      await sql.query('delete from ai.provider_keys where id = $1', [id]);
      return sql.query('select 1 from ai.connection_tests where connection_id = $1', [id]);
    });
    expect(left).toEqual([]);
  });

  it('is seen by its own business and its agency, by no sibling business and by no other agency', async () => {
    const one = await business();
    const sibling = await business(one.context.agencyId);
    const stranger = await business();
    const own = await connection(one.context);
    const shared = await connection(one.agencyContext);
    const inBusiness = await test(one.context, own.id);
    const atAgency = await test(one.agencyContext, shared.id);
    const seen = async (context: TenantContext) =>
      (
        await database.withTenant(context, (sql) =>
          sql.query<{ id: string }>('select id from ai.connection_tests order by created_at, id'),
        )
      ).map((row) => row.id);
    expect(await seen(one.context)).toEqual([inBusiness['id'], atAgency['id']]);
    // The agency's own test is the agency's; a sibling business sees it, and not the
    // other business's.
    expect(await seen(sibling.context)).toEqual([atAgency['id']]);
    expect(await seen(one.agencyContext)).toEqual([inBusiness['id'], atAgency['id']]);
    expect(await seen(stranger.context)).toEqual([]);
    expect(await seen(stranger.agencyContext)).toEqual([]);
    expect(
      await database.as('crm_app', (sql) => sql.query('select 1 from ai.connection_tests')),
    ).toEqual([]);

    // Neither a sibling nor a stranger can write a test in this business's name.
    for (const context of [sibling.context, stranger.context])
      await expect(
        database.withTenant(context, (sql) =>
          sql.query(
            `insert into ai.connection_tests (agency_id, business_id, connection_id)
             values ($1, $2, $3)`,
            [one.context.agencyId, one.context.businessId, own.id],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    expect(
      await database.withTenant(stranger.agencyContext, (sql) =>
        sql.query(`delete from ai.connection_tests returning id`),
      ),
    ).toEqual([]);
  });
});

describe('an install that already had provider keys', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-ai-settings-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < SETTINGS) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('keeps every key, and calls a key untested that no release could have tested', async () => {
    const connectionString = postgres.url(await postgres.createDatabase());
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(SETTINGS);
    // crm_owner, as an import or a repair would write: it is not held to a tenant.
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    try {
      const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
        const { rows } = await owner.query<{ id: string }>(text, [...values]);
        const [row] = rows;
        if (row === undefined) throw new Error(`No row: ${text}`);
        return row.id;
      };
      const agency = await one(
        "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
      );
      const secret = await one(
        `insert into vault.secrets (agency_id, purpose, key_version, enc, ciphertext)
         values ($1, 'ai.provider_key', 1, decode(repeat('04', 32), 'hex'), decode(repeat('aa', 32), 'hex'))
         returning id`,
        [agency],
      );
      const marked = await one(
        `insert into ai.provider_keys (agency_id, provider, label, secret_id, key_last4, status,
                                       last_tested_at, last_test_latency_ms)
         values ($1, 'anthropic', 'Marked by hand', $2, 'a1f3', 'working', '2026-10-01T10:00:00Z', 800)
         returning id`,
        [agency, secret],
      );
      const plain = await one(
        `insert into ai.provider_keys (agency_id, provider, label, base_url, default_model)
         values ($1, 'openai_compatible', 'Plain', 'http://ollama:11434/v1', 'llama3.2') returning id`,
        [agency],
      );

      const upgrade = await migrate({ connectionString });
      expect(upgrade.applied).toContain(SETTINGS);

      const keys = await owner.query(
        `select id, provider, secret_id, key_last4, base_url, default_model, status, last_tested_at,
                last_test_latency_ms, last_test_outcome
         from ai.provider_keys order by label`,
      );
      expect(keys.rows).toEqual([
        {
          id: marked,
          provider: 'anthropic',
          secret_id: secret,
          key_last4: 'a1f3',
          base_url: null,
          default_model: null,
          status: 'untested',
          last_tested_at: null,
          last_test_latency_ms: null,
          last_test_outcome: null,
        },
        {
          id: plain,
          provider: 'openai_compatible',
          secret_id: null,
          key_last4: null,
          base_url: 'http://ollama:11434/v1',
          default_model: 'llama3.2',
          status: 'untested',
          last_tested_at: null,
          last_test_latency_ms: null,
          last_test_outcome: null,
        },
      ]);
    } finally {
      await owner.end();
    }
  });
});
