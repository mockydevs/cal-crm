// The AI gateway as the worker composes it: with the real vault, a real migrated Postgres
// under row-level security, and a local stand-in for Claude. No test here calls a real
// provider.
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { AI_KEY_PURPOSE, parseLocalServers, type AiGateway } from '@repo/module-ai';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { startFakeClaude, type FakeClaude } from '../../test/fake-claude.js';
import { createInstallAiGateway } from './ai.js';

const KEY = `sk-ant-fixture-${randomBytes(12).toString('hex')}`;

let database: TestDatabase;
let db: Database;
let vault: Vault;
let claude: FakeClaude;
let gateway: AiGateway;
const logged: Record<string, unknown>[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  claude = await startFakeClaude(KEY);
  const lines = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logged.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      done();
    },
  });
  gateway = createInstallAiGateway({
    db,
    vault,
    logger: pino({ level: 'info' }, lines),
    // The stand-in is listed as an install would list a model server of its own.
    localServers: parseLocalServers(claude.hostPort),
    baseUrls: { anthropic: claude.origin },
  });
});
afterAll(async () => {
  await claude.stop();
  await db.destroy();
  await database.close();
});
beforeEach(() => {
  logged.length = 0;
  claude.requests.length = 0;
});

/** A business that uses its own keys, with a key sealed for `purpose` as Settings will. */
async function business(purpose: string = AI_KEY_PURPOSE): Promise<{
  context: TenantContext;
  secretId: string;
}> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context: TenantContext = {
    ...created.context,
    actorKind: 'ai_agent',
    actorId: randomUUID(),
    correlationId: randomUUID(),
  };
  const secretId = await withTenant(db, context, async (trx) => {
    const id = await vault.store(
      trx,
      { agencyId: context.agencyId, businessId: created.id, purpose },
      KEY,
    );
    await trx
      .insertInto('ai.provider_keys')
      .values({
        agency_id: context.agencyId,
        business_id: created.id,
        provider: 'anthropic',
        secret_id: id,
        key_last4: KEY.slice(-4),
      })
      .execute();
    await trx
      .insertInto('ai.settings')
      .values({ business_id: created.id, key_source: 'own' })
      .execute();
    return id;
  });
  return { context, secretId };
}

const ask = {
  job: 'replies',
  promptVersion: 'replies/1',
  system: 'A private system prompt.',
  messages: [{ role: 'user', text: 'A private question from jordan@example.com.' }],
  maxOutputTokens: 256,
} as const;

describe('the worker’s AI gateway', () => {
  it('opens the sealed key in the worker, calls the provider with it and records the call', async () => {
    const { context } = await business();
    const result = await gateway.generate(context, ask);
    expect(result).toMatchObject({
      outcome: 'ok',
      text: 'Hello!',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      costMicros: 200n,
    });
    expect(claude.requests).toHaveLength(1);
    expect(claude.requests[0]?.headers['x-api-key']).toBe(KEY);
    const rows = await database.withTenant(context, (sql) =>
      sql.query<{ status: string; cost_estimate: string }>(
        'select status, cost_estimate from ai.requests',
      ),
    );
    expect(rows).toEqual([{ status: 'ok', cost_estimate: '0.000200' }]);
    // The key is in the database only as sealed bytes.
    const sealed = await database.as('postgres', (sql) =>
      sql.query<{ found: boolean }>(
        `select bool_or(position($1::bytea in ciphertext) > 0) as found from vault.secrets`,
        [Buffer.from(KEY, 'utf8')],
      ),
    );
    expect(sealed).toEqual([{ found: false }]);
  });

  it('logs what happened to the call, and nothing of the key, the prompt or the answer', async () => {
    const { context } = await business();
    await gateway.generate(context, ask);
    expect(logged).toMatchObject([
      {
        level: 30,
        source: 'ai',
        msg: 'AI call finished',
        type: 'request',
        businessId: context.businessId,
        correlationId: context.correlationId,
        job: 'replies',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        status: 'ok',
        attempt: 1,
        costMicros: '200',
        usage: { inputTokens: 25, outputTokens: 15 },
      },
    ]);
    const text = JSON.stringify(logged);
    for (const secret of [KEY, 'private', 'jordan@example.com', 'Hello!', '127.0.0.1'])
      expect(text).not.toContain(secret);
  });

  it('warns when a call fails, and says why AI was not called when it is not set up', async () => {
    const { context, secretId } = await business();
    // The key was replaced by one the provider refuses.
    await withTenant(db, context, (trx) => vault.replace(trx, secretId, 'sk-ant-revoked'));
    expect(await gateway.generate(context, ask)).toMatchObject({
      outcome: 'failed',
      code: 'authentication',
    });
    expect(logged).toMatchObject([
      { level: 40, msg: 'AI call failed', status: 'error', errorCode: 'authentication' },
    ]);
    expect(JSON.stringify(logged)).not.toContain('sk-ant-revoked');

    logged.length = 0;
    const agency = await database.fixtures.agency();
    const bare = await database.fixtures.business(agency.id);
    expect(await gateway.generate({ ...bare.context, correlationId: randomUUID() }, ask)).toEqual({
      outcome: 'not_configured',
      reason: 'no_key',
    });
    expect(logged).toMatchObject([
      { level: 30, msg: 'AI call not made', type: 'skipped', reason: 'no_key' },
    ]);
  });

  it('warns once when a business reaches its spending limit', async () => {
    const { context } = await business();
    await database.withTenant(context, (sql) =>
      sql.query(`update ai.settings set monthly_limit = 0.0001, at_limit = 'pause'`),
    );
    expect(await gateway.generate(context, ask)).toMatchObject({ outcome: 'ok' });
    logged.length = 0;
    expect(await gateway.generate(context, ask)).toEqual({
      outcome: 'paused',
      reason: 'limit_reached',
    });
    expect(await gateway.generate(context, ask)).toMatchObject({ outcome: 'paused' });
    expect(logged).toMatchObject([
      {
        level: 40,
        msg: 'AI spending limit reached',
        type: 'limit_reached',
        businessId: context.businessId,
        atLimit: 'pause',
        limitMicros: '100',
        spentMicros: '200',
      },
    ]);
    expect(claude.requests).toHaveLength(1);
  });

  it('opens nothing that was sealed for another purpose, or that was tampered with', async () => {
    // A mailbox password, named as an AI key by a provider's row.
    const wrongPurpose = await business('mailbox.password');
    expect(await gateway.generate(wrongPurpose.context, ask)).toEqual({
      outcome: 'not_configured',
      reason: 'key_unreadable',
    });

    const tampered = await business();
    await database.as('postgres', (sql) =>
      sql.query(
        `update vault.secrets set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) where id = $1`,
        [tampered.secretId],
      ),
    );
    expect(await gateway.generate(tampered.context, ask)).toEqual({
      outcome: 'not_configured',
      reason: 'key_unreadable',
    });
    expect(claude.requests).toHaveLength(0);
  });

  it('does not let one business spend with another’s key', async () => {
    const owner = await business();
    const sibling = await database.fixtures.business(owner.context.agencyId);
    // The sibling's row names the owner's secret: the vault finds nothing for it there.
    await database.as('postgres', (sql) =>
      sql.query(
        `insert into ai.provider_keys (agency_id, business_id, provider, secret_id, key_last4)
         values ($1, $2, 'anthropic', $3, 'a1f3')`,
        [owner.context.agencyId, sibling.id, owner.secretId],
      ),
    );
    await database.withTenant(sibling.context, (sql) =>
      sql.query(
        `insert into ai.settings (business_id, key_source) values (app.business_id(), 'own')`,
      ),
    );
    expect(
      await gateway.generate({ ...sibling.context, correlationId: randomUUID() }, ask),
    ).toEqual({ outcome: 'not_configured', reason: 'key_unreadable' });
    expect(claude.requests).toHaveLength(0);
  });
});
