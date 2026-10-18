// Migration 0104 (Claude's one-hour prompt cache) at the database's own level: the ledger's
// count of the hour's writes, the price of one, and what the migration does to rows an
// install already had. What the gateway does with them is the AI module's to prove.
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

const ONE_HOUR_CACHE = '0104_ai_one_hour_cache.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function business() {
  const agency = (await database.fixtures.agency()).id;
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

/** One finished call; every column a test does not name has a value the rules accept. */
function call(context: TenantContext, columns: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    job: 'replies',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    key_source: 'own',
    status: 'ok',
    actor_kind: 'ai_agent',
    finished_at: '2026-10-14T09:00:05Z',
    ...columns,
  };
  const names = Object.keys(row);
  return database.withTenant(context, (sql) =>
    sql.one(
      `insert into ai.requests (business_id, ${names.join(', ')})
       values (app.business_id(), ${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
       returning cache_write_tokens, cache_write_1h_tokens`,
      names.map((name) => row[name]),
    ),
  );
}

const PRICE = `
  insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                               cache_read_per_mtok, cache_write_per_mtok, cache_write_1h_per_mtok,
                               source, checked_on)
  values (app.agency_id(), 'anthropic', $1, 2, 10, 0.10, 2.50, $2, 'The pricing page', '2026-10-14')
  returning cache_write_1h_per_mtok`;

describe('a call in ai.requests', () => {
  it('counts no writes to the hour’s cache unless it says so', async () => {
    const { context } = await business();
    expect(await call(context, { cache_write_tokens: 1800 })).toEqual({
      cache_write_tokens: 1800,
      cache_write_1h_tokens: 0,
    });
    expect(await call(context, { cache_write_tokens: 1800, cache_write_1h_tokens: 1500 })).toEqual({
      cache_write_tokens: 1800,
      cache_write_1h_tokens: 1500,
    });
  });

  it('counts the hour’s writes within all its writes, and never below nothing', async () => {
    const { context } = await business();
    expect(
      await call(context, { cache_write_tokens: 900, cache_write_1h_tokens: 900 }),
    ).toMatchObject({ cache_write_1h_tokens: 900 });
    await refused(
      call(context, { cache_write_tokens: 900, cache_write_1h_tokens: 901 }),
      'requests_cache_write_1h_within_writes',
    );
    await refused(
      call(context, { cache_write_1h_tokens: -1 }),
      'requests_cache_write_1h_nonnegative',
    );
    // A server that reported no usage reported no writes of any lifetime.
    await refused(
      call(context, { usage_reported: false, cache_write_1h_tokens: 1 }),
      'requests_cache_write_1h_within_writes',
    );
  });
});

describe('ai.model_prices', () => {
  it('may have no price for the hour’s cache, and has none below nothing', async () => {
    const { agencyContext } = await business();
    const price = (model: string, hour: string | null) =>
      database.withTenant(agencyContext, (sql) => sql.one(PRICE, [model, hour]));
    expect(await price('claude-sonnet-5-5', null)).toEqual({ cache_write_1h_per_mtok: null });
    expect(await price('claude-opus-5-5', '8')).toEqual({ cache_write_1h_per_mtok: '8.000000' });
    await refused(price('claude-haiku-4-5', '-0.01'), 'model_prices_cache_write_1h_nonnegative');
  });
});

describe('an install that already had AI rows', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-one-hour-cache-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < ONE_HOUR_CACHE) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('keeps every call’s writes as the five minutes’, and gives no price an hour it never had', async () => {
    const connectionString = postgres.url(await postgres.createDatabase());
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(ONE_HOUR_CACHE);
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
      await one(
        `insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                                      cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
         values ($1, 'anthropic', 'claude-sonnet-5-5', 2, 10, 0.10, 2.50, 'Entered earlier', '2026-10-10')
         returning id`,
        [agency],
      );
      await one(
        `insert into ai.requests (business_id, job, provider, model, key_source, status,
                                  cache_write_tokens, cost_estimate, actor_kind, started_at, finished_at)
         values ($1, 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'ok', 1800, 0.0045,
                 'ai_agent', '2026-10-13T10:00:00Z', '2026-10-13T10:00:04Z') returning id`,
        [owned],
      );

      const upgrade = await migrate({ connectionString });
      expect(upgrade.applied).toContain(ONE_HOUR_CACHE);

      const calls = await owner.query(
        'select cache_write_tokens, cache_write_1h_tokens, cost_estimate from ai.requests',
      );
      expect(calls.rows).toEqual([
        { cache_write_tokens: 1800, cache_write_1h_tokens: 0, cost_estimate: '0.004500' },
      ]);
      const prices = await owner.query(
        'select cache_write_per_mtok, cache_write_1h_per_mtok from ai.model_prices',
      );
      expect(prices.rows).toEqual([
        { cache_write_per_mtok: '2.500000', cache_write_1h_per_mtok: null },
      ]);
    } finally {
      await owner.end();
    }
  });
});
