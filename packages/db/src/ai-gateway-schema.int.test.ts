// Migration 0050 (the AI gateway) at the database's own level: what it adds to ai.requests,
// ai.settings and ai.provider_keys, the new ai.model_prices with its grants and policy, and
// what it does to rows an install already had. What the gateway does with these tables is
// the AI module's to prove (packages/modules/ai).
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

const GATEWAY = '0050_ai_gateway.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

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

/** One call's row; every column a test does not name has a value the rules accept. */
function call(context: TenantContext, columns: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    job: 'replies',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    key_source: 'own',
    status: 'ok',
    actor_kind: 'ai_agent',
    finished_at: '2026-10-10T09:00:05Z',
    ...columns,
  };
  const names = Object.keys(row);
  return database.withTenant(context, (sql) =>
    sql.one(
      `insert into ai.requests (business_id, ${names.join(', ')})
       values (app.business_id(), ${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
       returning *`,
      names.map((name) => row[name]),
    ),
  );
}
const inFlight = { status: 'started', finished_at: null, reserved_until: '2026-10-10T09:06:00Z' };

const PRICE = `
  insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                               cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
  values (app.agency_id(), $1, $2, $3, $4, $5, $6, $7, '2026-10-10') returning id`;
const price = (context: TenantContext, values: readonly unknown[]) =>
  database.withTenant(context, (sql) => sql.one<{ id: string }>(PRICE, values));

describe('a call in ai.requests', () => {
  it('starts with a hold on the budget and no cost, and ends with the hold let go', async () => {
    const { context } = await business();
    const started = await call(context, { ...inFlight, reserved_estimate: '0.25' });
    expect(started).toMatchObject({
      status: 'started',
      cost_estimate: null,
      reserved_estimate: '0.250000',
      finished_at: null,
      attempt: 1,
      usage_reported: true,
      prompt_version: null,
    });
    expect(started['call_id']).toMatch(/^[0-9a-f-]{36}$/);
    const [ended] = await database.withTenant(context, (sql) =>
      sql.query(
        `update ai.requests set status = 'ok', finished_at = now(), cost_estimate = 0.0054,
                                reserved_estimate = 0, reserved_until = null
         where id = $1 returning status, cost_estimate, reserved_estimate`,
        [started['id']],
      ),
    );
    expect(ended).toEqual({
      status: 'ok',
      cost_estimate: '0.005400',
      reserved_estimate: '0.000000',
    });
  });

  it('may have a cost nobody knows, which is not a cost of nothing', async () => {
    const { context } = await business();
    expect(await call(context)).toMatchObject({ status: 'ok', cost_estimate: null });
    expect(await call(context, { cost_estimate: 0 })).toMatchObject({ cost_estimate: '0.000000' });
    await refused(call(context, { cost_estimate: -1 }), 'requests_cost_nonnegative');
  });

  it('is in flight exactly while it has no end, and holds money only while in flight', async () => {
    const { context } = await business();
    await refused(
      call(context, { ...inFlight, finished_at: '2026-10-10T09:00:05Z' }),
      'requests_started_is_unfinished',
    );
    await refused(call(context, { finished_at: null }), 'requests_started_is_unfinished');
    await refused(
      call(context, { status: 'started', finished_at: null }),
      'requests_started_has_hold_end',
    );
    await refused(call(context, { reserved_estimate: '0.25' }), 'requests_hold_only_in_flight');
    await refused(
      call(context, { reserved_until: '2026-10-10T09:06:00Z' }),
      'requests_hold_only_in_flight',
    );
    await refused(
      call(context, { ...inFlight, reserved_estimate: -1 }),
      'requests_reserved_nonnegative',
    );
  });

  it('ends in one of the ways a call can end', async () => {
    const { context } = await business();
    for (const status of ['ok', 'error', 'refused', 'fell_back'])
      expect(await call(context, { status })).toMatchObject({ status });
    await refused(call(context, { status: 'paused' }), 'requests_status_valid');
  });

  it('says so when the server reported no usage, and then counts no tokens', async () => {
    const { context } = await business();
    expect(await call(context, { usage_reported: false })).toMatchObject({
      usage_reported: false,
      input_tokens: 0,
    });
    for (const column of [
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
    ])
      await refused(
        call(context, { usage_reported: false, [column]: 1 }),
        'requests_unreported_usage_is_zero',
      );
  });

  it('numbers its attempts from one and keeps a short prompt version', async () => {
    const { context } = await business();
    const callId = randomUUID();
    expect(
      await call(context, { call_id: callId, attempt: 2, prompt_version: 'replies/3' }),
    ).toMatchObject({ call_id: callId, attempt: 2, prompt_version: 'replies/3' });
    await refused(call(context, { attempt: 0 }), 'requests_attempt_positive');
    await refused(call(context, { prompt_version: '' }), 'requests_prompt_version_length');
    await refused(
      call(context, { prompt_version: 'v'.repeat(101) }),
      'requests_prompt_version_length',
    );
  });

  it('is found by its business and status, and by its call, through an index', async () => {
    const indexes = await database.as('crm_owner', (sql) =>
      sql.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'ai' and tablename = 'requests'
           and indexname in ('requests_in_flight_idx', 'requests_call_idx') order by indexname`,
      ),
    );
    expect(indexes.map((index) => index.indexdef)).toEqual([
      'CREATE INDEX requests_call_idx ON ai.requests USING btree (business_id, call_id)',
      "CREATE INDEX requests_in_flight_idx ON ai.requests USING btree (business_id) WHERE (status = 'started'::text)",
    ]);
  });
});

describe('a business’s AI settings', () => {
  it('remember when the spending limit was last reached', async () => {
    const { context } = await business();
    const [row] = await database.withTenant(context, async (sql) => {
      await sql.query(
        `insert into ai.settings (business_id, monthly_limit) values (app.business_id(), 50)`,
      );
      return sql.query<{ limit_reached_at: Date | null }>(
        `update ai.settings set limit_reached_at = '2026-10-10T09:00:00Z' returning limit_reached_at`,
      );
    });
    expect(row?.limit_reached_at?.toISOString()).toBe('2026-10-10T09:00:00.000Z');
  });
});

describe('a provider’s key', () => {
  const key = (context: TenantContext, provider: string, baseUrl: string | null) =>
    database.withTenant(context, async (sql) => {
      const { id } = await sql.one<{ id: string }>(
        `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         values (app.agency_id(), app.business_id(), 'ai.provider_key', 1,
                 decode(repeat('04', 32), 'hex'), decode(repeat('aa', 32), 'hex')) returning id`,
      );
      return sql.query(
        `insert into ai.provider_keys (agency_id, business_id, provider, base_url, secret_id, key_last4)
         values (app.agency_id(), app.business_id(), $1, $2, $3, 'a1f3')`,
        [provider, baseUrl, id],
      );
    });

  it('has an address only when it is for a model server of the install’s own', async () => {
    const { context } = await business();
    await key(context, 'openai_compatible', 'http://ollama:11434/v1');
    await key(context, 'anthropic', null);
    for (const provider of ['openai', 'gemini'])
      await refused(
        key(context, provider, 'https://elsewhere.example/v1'),
        'provider_keys_only_compatible_has_url',
      );
    await refused(key(context, 'openai_compatible', null), 'provider_keys_compatible_needs_url');
  });
});

describe('ai.model_prices', () => {
  it('has forced row-level security with the agency policy', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                array(select format('%s %s %s', p.policyname, p.permissive, p.cmd)
                      from pg_policies p
                      where p.schemaname = 'ai' and p.tablename = 'model_prices' order by 1) as policies
         from pg_class c where c.oid = 'ai.model_prices'::regclass`,
      ),
    );
    expect(rows).toEqual([
      { enabled: true, forced: true, policies: ['agency_isolation PERMISSIVE ALL'] },
    ]);
  });

  it('grants crm_app what it uses and nothing to the other runtime roles', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ grantee: string; privileges: string[] }>(
        `select grantee::text, array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema = 'ai' and table_name = 'model_prices'
           and grantee in ('crm_app', 'crm_auth', 'crm_worker', 'PUBLIC')
         group by 1 order by 1`,
      ),
    );
    expect(grants).toEqual([
      { grantee: 'crm_app', privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
    ]);
  });

  it('is read by every business of its agency, by no other agency, and by nobody without a context', async () => {
    const one = await business();
    const sibling = await business(one.context.agencyId);
    const stranger = await business();
    const { id } = await price(one.agencyContext, [
      'openai_compatible',
      'llama3.2',
      0,
      0,
      0,
      0,
      'Our own server',
    ]);
    const seen = (context: TenantContext) =>
      database.withTenant(context, (sql) =>
        sql.query<{ id: string }>('select id from ai.model_prices'),
      );
    expect(await seen(one.context)).toEqual([{ id }]);
    expect(await seen(sibling.context)).toEqual([{ id }]);
    expect(await seen(one.agencyContext)).toEqual([{ id }]);
    expect(await seen(stranger.context)).toEqual([]);
    expect(await seen(stranger.agencyContext)).toEqual([]);
    expect(
      await database.as('crm_app', (sql) => sql.query('select 1 from ai.model_prices')),
    ).toEqual([]);

    // Another agency can neither change it nor write one in its name.
    const changed = await database.withTenant(stranger.agencyContext, (sql) =>
      sql.query(`update ai.model_prices set input_per_mtok = 99 returning id`),
    );
    expect(changed).toEqual([]);
    await expect(
      database.withTenant(stranger.agencyContext, (sql) =>
        sql.query(
          `insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                                        cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
           values ($1, 'openai', 'gpt-test', 1, 1, 1, 1, 'Smuggled', '2026-10-10')`,
          [one.context.agencyId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('has one price for a model in an agency, and the same model again in another', async () => {
    const one = await business();
    const other = await business();
    const values = ['anthropic', 'claude-sonnet-5-5', 2, 10, '0.10', '2.50', 'The pricing page'];
    await price(one.agencyContext, values);
    await refused(price(one.agencyContext, values), 'model_prices_model_unique');
    await price(other.agencyContext, values);
    await price(one.agencyContext, [
      'openai',
      'claude-sonnet-5-5',
      2,
      10,
      0,
      0,
      'Another provider',
    ]);
  });

  it('keeps a price exact, says where it came from, and has its time of change kept for it', async () => {
    const { agencyContext } = await business();
    const { id } = await price(agencyContext, [
      'anthropic',
      'claude-opus-5-5',
      4,
      20,
      '0.20',
      5,
      'The pricing page',
    ]);
    const read = () =>
      database.withTenant(agencyContext, (sql) =>
        sql.one(
          `select input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
                  source, checked_on::text, updated_at > created_at as touched
           from ai.model_prices where id = $1`,
          [id],
        ),
      );
    expect(await read()).toEqual({
      input_per_mtok: '4.000000',
      output_per_mtok: '20.000000',
      cache_read_per_mtok: '0.200000',
      cache_write_per_mtok: '5.000000',
      source: 'The pricing page',
      checked_on: '2026-10-10',
      touched: false,
    });
    await database.withTenant(agencyContext, (sql) =>
      sql.query(`update ai.model_prices set input_per_mtok = 5 where id = $1`, [id]),
    );
    expect(await read()).toMatchObject({ input_per_mtok: '5.000000', touched: true });
  });

  it('refuses a price below nothing, a provider or model it cannot name, and no source', async () => {
    const { agencyContext } = await business();
    const ok = ['anthropic', 'claude-test', 1, 1, 1, 1, 'A source'];
    const changed = (index: number, value: unknown) =>
      ok.map((each, at) => (at === index ? value : each));
    await refused(price(agencyContext, changed(2, -1)), 'model_prices_input_nonnegative');
    await refused(price(agencyContext, changed(3, -1)), 'model_prices_output_nonnegative');
    await refused(price(agencyContext, changed(4, -1)), 'model_prices_cache_read_nonnegative');
    await refused(price(agencyContext, changed(5, -1)), 'model_prices_cache_write_nonnegative');
    await refused(price(agencyContext, changed(0, 'builtin')), 'model_prices_provider_valid');
    await refused(price(agencyContext, changed(1, '')), 'model_prices_model_length');
    await refused(price(agencyContext, changed(1, 'm'.repeat(201))), 'model_prices_model_length');
    await refused(price(agencyContext, changed(6, '   ')), 'model_prices_source_length');
    await refused(price(agencyContext, changed(6, 's'.repeat(501))), 'model_prices_source_length');
  });

  it('goes with its agency', async () => {
    const { agencyContext } = await business();
    await price(agencyContext, ['anthropic', 'claude-test', 1, 1, 1, 1, 'A source']);
    const left = await database.as('crm_owner', async (sql) => {
      await sql.query('delete from tenancy.agencies where id = $1', [agencyContext.agencyId]);
      return sql.query('select 1 from ai.model_prices where agency_id = $1', [
        agencyContext.agencyId,
      ]);
    });
    expect(left).toEqual([]);
  });
});

describe('an install that already had AI rows', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-ai-gateway-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < GATEWAY) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('keeps every call with its cost, gives each an end, and drops an address no release read', async () => {
    const connectionString = postgres.url(await postgres.createDatabase());
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(GATEWAY);
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
      const owned = await one(
        "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
        [agency],
      );
      const secret = await one(
        `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         values ($1, $2, 'ai.provider_key', 1, decode(repeat('04', 32), 'hex'), decode(repeat('aa', 32), 'hex'))
         returning id`,
        [agency, owned],
      );
      const hosted = await one(
        `insert into ai.provider_keys (agency_id, business_id, provider, label, base_url, secret_id, key_last4)
         values ($1, $2, 'openai', 'Hosted', 'https://proxy.example/v1', $3, 'a1f3') returning id`,
        [agency, owned, secret],
      );
      const local = await one(
        `insert into ai.provider_keys (agency_id, business_id, provider, label, base_url)
         values ($1, $2, 'openai_compatible', 'Local', 'http://ollama:11434/v1') returning id`,
        [agency, owned],
      );
      await owner.query(`insert into ai.settings (business_id, monthly_limit) values ($1, 50)`, [
        owned,
      ]);
      const unfinished = await one(
        `insert into ai.requests (business_id, job, provider, model, key_source, status,
                                  input_tokens, output_tokens, cost_estimate, actor_kind, started_at)
         values ($1, 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'ok', 1200, 300, 0.0054,
                 'ai_agent', '2026-10-01T10:00:00Z') returning id`,
        [owned],
      );
      const finished = await one(
        `insert into ai.requests (business_id, job, provider, model, key_source, status,
                                  actor_kind, started_at, finished_at)
         values ($1, 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'error', 'ai_agent',
                 '2026-10-02T10:00:00Z', '2026-10-02T10:00:09Z') returning id`,
        [owned],
      );

      const upgrade = await migrate({ connectionString });
      expect(upgrade.applied).toContain(GATEWAY);

      const calls = await owner.query(
        `select id, status, cost_estimate, input_tokens, started_at = finished_at as ended_at_start,
                finished_at, attempt, usage_reported, reserved_estimate, reserved_until,
                prompt_version, call_id is not null as has_call
         from ai.requests order by started_at`,
      );
      expect(calls.rows).toEqual([
        {
          id: unfinished,
          status: 'ok',
          cost_estimate: '0.005400',
          input_tokens: 1200,
          ended_at_start: true,
          finished_at: new Date('2026-10-01T10:00:00Z'),
          attempt: 1,
          usage_reported: true,
          reserved_estimate: '0.000000',
          reserved_until: null,
          prompt_version: null,
          has_call: true,
        },
        {
          id: finished,
          status: 'error',
          // The old default: a call recorded with no cost had cost nothing.
          cost_estimate: '0.000000',
          input_tokens: 0,
          ended_at_start: false,
          finished_at: new Date('2026-10-02T10:00:09Z'),
          attempt: 1,
          usage_reported: true,
          reserved_estimate: '0.000000',
          reserved_until: null,
          prompt_version: null,
          has_call: true,
        },
      ]);
      const keys = await owner.query(
        'select id, provider, base_url, secret_id from ai.provider_keys order by label',
      );
      expect(keys.rows).toEqual([
        { id: hosted, provider: 'openai', base_url: null, secret_id: secret },
        {
          id: local,
          provider: 'openai_compatible',
          base_url: 'http://ollama:11434/v1',
          secret_id: null,
        },
      ]);
      const settings = await owner.query('select monthly_limit, limit_reached_at from ai.settings');
      expect(settings.rows).toEqual([{ monthly_limit: '50.0000', limit_reached_at: null }]);
    } finally {
      await owner.end();
    }
  });
});
