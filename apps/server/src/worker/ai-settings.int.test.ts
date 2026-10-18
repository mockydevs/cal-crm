// Settings → AI models as the install composes it: the app's routes with the app's half of
// the real vault, which can only seal; the worker's test task with the worker's half, which
// opens; a real migrated Postgres under row-level security; and a local stand-in for
// Claude. No test here calls a real provider.
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  aiConnectionSaved,
  aiConnectionTest,
  aiUsage,
  connectAiProvider,
  getAiConnectionTest,
  getAiUsage,
  listAiConnections,
  type Endpoint,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  createAiSettingsRoutes,
  createTestAiConnectionTask,
  parseLocalServers,
} from '@repo/module-ai';
import {
  createSealingVault,
  createVault,
  newSecretsKey,
  parseSecretsKeys,
  parseSecretsPublicKey,
  type SealingVault,
} from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { startFakeClaude, type FakeClaude } from '../../test/fake-claude.js';
import { createInstallAiGateway } from './ai.js';

// Made up for this file: no provider issued it.
const KEY = `sk-ant-fixture-${randomBytes(12).toString('hex')}`;

let database: TestDatabase;
let db: Database;
let sealer: SealingVault;
let claude: FakeClaude;
let routes: readonly ApiRoute[];
let services: Services;
let task: ReturnType<typeof createTestAiConnectionTask>;
const logged: Record<string, unknown>[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const keys = await newSecretsKey(1);
  // The two roles' halves of one key: the app's seals, the worker's opens.
  sealer = await createSealingVault(parseSecretsPublicKey(keys.publicKey));
  const vault = await createVault(parseSecretsKeys(keys.secretsKey));
  claude = await startFakeClaude(KEY);
  const lines = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logged.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      done();
    },
  });
  services = { db, authorize: allowEveryone };
  routes = createAiSettingsRoutes({
    vault: sealer,
    localServers: [],
    people: () => Promise.resolve(new Map()),
  });
  task = createTestAiConnectionTask(
    createInstallAiGateway({
      db,
      vault,
      logger: pino({ level: 'info' }, lines),
      // The stand-in is listed as an install would list a model server of its own.
      localServers: parseLocalServers(claude.hostPort),
      baseUrls: { anthropic: claude.origin },
    }),
  );
});
afterAll(async () => {
  await claude.stop();
  await db.destroy();
  await database.close();
});
beforeEach(async () => {
  await database.runJobs(['ai.test_connection']);
  logged.length = 0;
  claude.requests.length = 0;
  claude.modelLists.length = 0;
});

async function call(
  endpoint: Endpoint,
  invocation: Invocation,
  input: { params?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint === endpoint);
  if (route === undefined) throw new Error(`No route for ${endpoint.operationId}.`);
  const answer = await route.run(
    { invocation, params: input.params ?? {}, query: {}, body: input.body },
    services,
  );
  return answer === undefined ? undefined : (JSON.parse(JSON.stringify(answer)) as unknown);
}

/** Runs the queued tests as the worker does: each in the place it was asked for. */
async function runTests(): Promise<number> {
  const jobs = await database.runJobs(['ai.test_connection']);
  for (const job of jobs) {
    const payload = job.payload as {
      agencyId: string;
      businessId: string | null;
      correlationId: string;
      data: { testId: string };
    };
    await task.run(payload.data, {
      invocation: {
        context: {
          agencyId: payload.agencyId,
          ...(payload.businessId === null ? {} : { businessId: payload.businessId }),
          actorKind: 'system',
          correlationId: payload.correlationId,
        },
        permissions: 'all',
      },
      services,
    });
  }
  return jobs.length;
}

async function people(): Promise<{ inBusiness: Invocation; atAgency: Invocation }> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const acting = { actorKind: 'user', actorId: user.id, userId: user.id } as const;
  return {
    inBusiness: {
      context: { ...business.context, ...acting, correlationId: randomUUID() },
      permissions: 'all',
    },
    atAgency: {
      context: { agencyId: agency.id, ...acting, correlationId: randomUUID() },
      permissions: 'all',
    },
  };
}

describe('Settings → AI models, with the real vault', () => {
  it('seals a key the app can never open, and the worker tests it with one recorded call', async () => {
    const { inBusiness } = await people();
    const saved = aiConnectionSaved.parse(
      await call(connectAiProvider, inBusiness, { body: { provider: 'anthropic', apiKey: KEY } }),
    );
    expect(saved.connection).toMatchObject({ keyLast4: KEY.slice(-4), status: 'untested' });

    // The app's half of the vault has no way to open what it sealed.
    expect('read' in sealer).toBe(false);
    // The key is in the database only as sealed bytes, for the purpose the gateway opens.
    const sealed = await database.as('postgres', (sql) =>
      sql.query<{ purpose: string; found: boolean }>(
        `select purpose, position($1::bytea in ciphertext) > 0 as found from vault.secrets
         where business_id = $2`,
        [Buffer.from(KEY, 'utf8'), inBusiness.context.businessId],
      ),
    );
    expect(sealed).toEqual([{ purpose: 'ai.provider_key', found: false }]);
    const everywhere = await database.as('postgres', (sql) =>
      sql.query<{ found: boolean }>(
        `select (select count(*) from audit.commands where input::text like '%' || $1 || '%')
              + (select count(*) from events.events where payload::text like '%' || $1 || '%')
              + (select count(*) from ai.provider_keys k where row_to_json(k)::text like '%' || $1 || '%')
              > 0 as found`,
        [KEY],
      ),
    );
    expect(everywhere).toEqual([{ found: false }]);

    expect(await runTests()).toBe(1);
    expect(claude.requests).toHaveLength(1);
    expect(claude.requests[0]?.headers['x-api-key']).toBe(KEY);
    const finished = aiConnectionTest.parse(
      await call(getAiConnectionTest, inBusiness, { params: { id: saved.test.id } }),
    );
    expect(finished).toMatchObject({
      status: 'finished',
      outcome: 'ok',
      kind: 'model_call',
      // 25 tokens in and 15 out of Claude Haiku 4.5, at its shipped price.
      call: { costEstimate: '0.000100' },
    });
    expect(typeof finished.latencyMs).toBe('number');

    // The month's spend and the latest calls show the test, with its cost.
    const usage = aiUsage.parse(await call(getAiUsage, inBusiness));
    expect(usage).toMatchObject({
      spent: '0.000100',
      calls: 1,
      unknownCostCalls: 0,
      byJob: [{ job: 'connection_test', spent: '0.000100', calls: 1 }],
    });
    expect(usage.recent).toMatchObject([
      {
        job: 'connection_test',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        status: 'ok',
        costEstimate: '0.000100',
        keySource: 'own',
      },
    ]);

    // The server's log says a call was made, and nothing of the key.
    expect(logged).toMatchObject([
      {
        level: 30,
        source: 'ai',
        msg: 'AI call finished',
        job: 'connection_test',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        status: 'ok',
        costMicros: '100',
      },
    ]);
    const answers = JSON.stringify([
      saved,
      finished,
      usage,
      await call(listAiConnections, inBusiness),
      logged,
    ]);
    expect(answers).not.toContain(KEY);
    expect(answers).not.toContain(KEY.slice(0, 20));
  });

  it('says a wrong key is wrong, and logs the failure without the key', async () => {
    const { inBusiness } = await people();
    const wrong = 'sk-ant-fixture-not-the-right-key';
    const saved = aiConnectionSaved.parse(
      await call(connectAiProvider, inBusiness, { body: { provider: 'anthropic', apiKey: wrong } }),
    );
    await runTests();
    expect(
      aiConnectionTest.parse(
        await call(getAiConnectionTest, inBusiness, { params: { id: saved.test.id } }),
      ),
    ).toMatchObject({ status: 'finished', outcome: 'authentication' });
    expect(logged).toMatchObject([
      { level: 40, msg: 'AI call failed', job: 'connection_test', errorCode: 'authentication' },
    ]);
    expect(JSON.stringify(logged)).not.toContain(wrong);
  });

  it('checks the agency’s key by asking for the provider’s models: no model is called', async () => {
    const { atAgency, inBusiness } = await people();
    const saved = aiConnectionSaved.parse(
      await call(connectAiProvider, atAgency, { body: { provider: 'anthropic', apiKey: KEY } }),
    );
    expect(saved.test.kind).toBe('key_check');
    await runTests();
    expect(claude.modelLists).toHaveLength(1);
    expect(claude.modelLists[0]?.headers['x-api-key']).toBe(KEY);
    expect(claude.requests).toHaveLength(0);
    expect(
      aiConnectionTest.parse(
        await call(getAiConnectionTest, atAgency, { params: { id: saved.test.id } }),
      ),
    ).toMatchObject({ status: 'finished', outcome: 'ok', kind: 'key_check', call: null });
    expect(logged).toMatchObject([
      {
        level: 30,
        source: 'ai',
        msg: 'AI provider key checked',
        type: 'key_check',
        provider: 'anthropic',
        status: 'ok',
        businessId: null,
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain(KEY);
    // No business of the agency was charged for it.
    expect(aiUsage.parse(await call(getAiUsage, inBusiness))).toMatchObject({ calls: 0 });
  });

  it('warns when the agency’s key is refused', async () => {
    const { atAgency } = await people();
    const saved = aiConnectionSaved.parse(
      await call(connectAiProvider, atAgency, {
        body: { provider: 'anthropic', apiKey: 'sk-ant-fixture-revoked-key' },
      }),
    );
    await runTests();
    expect(
      aiConnectionTest.parse(
        await call(getAiConnectionTest, atAgency, { params: { id: saved.test.id } }),
      ),
    ).toMatchObject({ outcome: 'authentication' });
    expect(logged).toMatchObject([
      { level: 40, msg: 'AI provider key checked', status: 'error', errorCode: 'authentication' },
    ]);
  });
});
