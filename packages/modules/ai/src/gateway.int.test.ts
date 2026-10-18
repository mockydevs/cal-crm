// The AI gateway against real Postgres under row-level security, with local stand-ins for
// the providers (test/fake-anthropic.ts, test/fake-openai.ts). No test calls a real
// provider.
import { randomBytes, randomUUID } from 'node:crypto';

import { connectDatabase, type Database, type DatabaseTransaction } from '@repo/db';
import { NotFoundError, ValidationError, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { anthropicError, FAKE_ANTHROPIC_KEY, startFakeAnthropic } from '../test/fake-anthropic.js';
import { FAKE_OPENAI_KEY, openAiError, startFakeOpenAi } from '../test/fake-openai.js';
import { fixture, json, stream, type FakeProvider } from '../test/fake-provider.js';
import { parseLocalServers } from './addresses.js';
import {
  AI_KEY_PURPOSE,
  createAiGateway,
  JOB_CACHE_TTL,
  type AiGateway,
  type AiGatewayOptions,
  type GatewayEvent,
  type GatewayRequest,
  type SecretReader,
} from './gateway.js';
import { AiTransportError, createAiTransport } from './transport.js';

let database: TestDatabase;
let db: Database;
let claude: FakeProvider;
let ollama: FakeProvider;
let keyless: FakeProvider;

/** What the vault would open: plaintext by secret id, for secrets this file sealed. */
const plaintexts = new Map<string, string>();
/**
 * Stands in for the worker's vault (the real one is proven with the gateway in
 * apps/server). Like the vault, it finds a secret only under the caller's row-level
 * security and only for the purpose asked.
 */
const secrets: SecretReader = {
  async read(trx: DatabaseTransaction, secretId: string, purpose: string): Promise<string> {
    const row = await trx
      .selectFrom('vault.secrets')
      .select('id')
      .where('id', '=', secretId)
      .where('purpose', '=', purpose)
      .executeTakeFirst();
    const plaintext = plaintexts.get(secretId);
    if (row === undefined || plaintext === undefined) throw new NotFoundError('secret', secretId);
    return plaintext;
  },
};

const clock = { now: new Date('2026-10-10T09:00:00.000Z') };
const slept: number[] = [];
const events: GatewayEvent[] = [];

function gatewayWith(more: Partial<AiGatewayOptions> = {}): AiGateway {
  return createAiGateway({
    db,
    secrets,
    // The stand-ins are listed as an install lists its own model servers.
    localServers: parseLocalServers(`${claude.hostPort},${ollama.hostPort},${keyless.hostPort}`),
    baseUrls: { anthropic: claude.origin, openai: `${ollama.origin}/v1` },
    now: () => clock.now,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    jitter: () => 0,
    onEvent: (event) => events.push(event),
    ...more,
  });
}
let gateway: AiGateway;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  claude = await startFakeAnthropic();
  ollama = await startFakeOpenAi();
  keyless = await startFakeOpenAi(null);
  gateway = gatewayWith();
});
afterAll(async () => {
  await Promise.all([claude.stop(), ollama.stop(), keyless.stop()]);
  await db.destroy();
  await database.close();
});
beforeEach(() => {
  clock.now = new Date('2026-10-10T09:00:00.000Z');
  slept.length = 0;
  events.length = 0;
});

interface KeyOptions {
  readonly provider?: 'anthropic' | 'openai' | 'openai_compatible' | 'gemini';
  /** Null for a key the whole agency shares. */
  readonly scope?: 'business' | 'agency';
  readonly secret?: string | null;
  readonly baseUrl?: string;
  readonly label?: string;
}

/** A business with nothing saved about AI at all. */
async function bare(agencyId?: string): Promise<TenantContext> {
  const agency = agencyId ?? (await database.fixtures.agency()).id;
  const created = await database.fixtures.business(agency);
  return {
    ...created.context,
    actorKind: 'ai_agent',
    actorId: randomUUID(),
    correlationId: randomUUID(),
  };
}

/** A business that uses its own keys, and has none yet. */
async function business(agencyId?: string): Promise<TenantContext> {
  const context = await bare(agencyId);
  await settings(context);
  return context;
}

/** Seals a key (as Settings will) and saves the provider's row. */
async function addKey(context: TenantContext, options: KeyOptions = {}): Promise<string | null> {
  const provider = options.provider ?? 'anthropic';
  const scope = options.scope ?? 'business';
  const secret = options.secret === undefined ? FAKE_ANTHROPIC_KEY : options.secret;
  const writer: TenantContext =
    scope === 'agency'
      ? { agencyId: context.agencyId, actorKind: 'system', correlationId: randomUUID() }
      : context;
  return database.withTenant(writer, async (sql) => {
    const businessId = scope === 'agency' ? null : context.businessId;
    let secretId: string | null = null;
    if (secret !== null) {
      ({ id: secretId } = await sql.one<{ id: string }>(
        `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         values ($1, $2, $3, 1, $4, $5) returning id`,
        [context.agencyId, businessId, AI_KEY_PURPOSE, randomBytes(32), randomBytes(48)],
      ));
      plaintexts.set(secretId, secret);
    }
    await sql.query(
      `insert into ai.provider_keys (agency_id, business_id, provider, label, base_url, secret_id, key_last4)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        context.agencyId,
        businessId,
        provider,
        options.label ?? '',
        options.baseUrl ?? null,
        secretId,
        secret === null ? null : secret.slice(-4),
      ],
    );
    return secretId;
  });
}

interface SettingsOptions {
  readonly enabled?: boolean;
  readonly keySource?: 'own' | 'agency';
  readonly monthlyLimit?: string | null;
  readonly atLimit?: 'pause' | 'continue';
  readonly mask?: boolean;
  readonly logDays?: number;
  readonly backup?: readonly [provider: string, model: string];
}
const settings = (context: TenantContext, options: SettingsOptions = {}) =>
  database.withTenant(context, (sql) =>
    sql.query(
      `insert into ai.settings (business_id, enabled, key_source, monthly_limit, at_limit,
                                mask_contact_details, request_log_days, backup_provider, backup_model)
       values (app.business_id(), $1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (business_id) do update set
         enabled = excluded.enabled, key_source = excluded.key_source,
         monthly_limit = excluded.monthly_limit, at_limit = excluded.at_limit,
         mask_contact_details = excluded.mask_contact_details,
         request_log_days = excluded.request_log_days,
         backup_provider = excluded.backup_provider, backup_model = excluded.backup_model`,
      [
        options.enabled ?? true,
        options.keySource ?? 'own',
        options.monthlyLimit ?? null,
        options.atLimit ?? 'pause',
        options.mask ?? false,
        options.logDays ?? 30,
        options.backup?.[0] ?? null,
        options.backup?.[1] ?? null,
      ],
    ),
  );
const jobModel = (context: TenantContext, job: string, provider: string, model: string) =>
  database.withTenant(context, (sql) =>
    sql.query(
      `insert into ai.job_models (business_id, job, provider, model)
       values (app.business_id(), $1, $2, $3)
       on conflict (business_id, job) do update set provider = excluded.provider, model = excluded.model`,
      [job, provider, model],
    ),
  );

/** A business with its own Claude key and settings: the usual starting point. */
async function ready(options: SettingsOptions = {}): Promise<TenantContext> {
  const context = await business();
  await addKey(context);
  await settings(context, options);
  return context;
}

interface RequestRow {
  id: string;
  job: string;
  provider: string;
  model: string;
  key_source: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
  usage_reported: boolean;
  cost_estimate: string | null;
  latency_ms: number | null;
  actor_kind: string;
  actor_id: string | null;
  correlation_id: string | null;
  error_code: string | null;
  log: { request?: unknown; response?: unknown } | null;
  log_expires_at: Date | null;
  started_at: Date;
  finished_at: Date | null;
  call_id: string;
  attempt: number;
  prompt_version: string | null;
  reserved_estimate: string;
  reserved_until: Date | null;
}
const rows = (context: TenantContext) =>
  database.withTenant(context, (sql) =>
    sql.query<RequestRow>('select * from ai.requests order by started_at, attempt, id'),
  );
const reachedAt = async (context: TenantContext): Promise<Date | null> =>
  (
    await database.withTenant(context, (sql) =>
      sql.one<{ limit_reached_at: Date | null }>('select limit_reached_at from ai.settings'),
    )
  ).limit_reached_at;
/** A finished call of some earlier time, for the month's spend. */
const spent = (context: TenantContext, dollars: string, at = '2026-10-05T12:00:00Z') =>
  database.withTenant(context, (sql) =>
    sql.query(
      `insert into ai.requests (business_id, job, provider, model, key_source, status,
                                cost_estimate, actor_kind, started_at, finished_at)
       values (app.business_id(), 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'ok',
               $1, 'ai_agent', $2, $2)`,
      [dollars, at],
    ),
  );

const ask = (
  text = 'Draft a reply to Jordan.',
  more: Partial<GatewayRequest> = {},
): GatewayRequest => ({
  job: 'replies',
  promptVersion: 'replies/1',
  system: 'You help a small business answer its customers.',
  messages: [{ role: 'user', text }],
  maxOutputTokens: 1000,
  ...more,
});
const sse = (name: string) => fixture('anthropic', name);
const lastTo = (provider: FakeProvider) => {
  const request = provider.requests.at(-1);
  if (request === undefined) throw new Error('The stand-in saw no request.');
  return request;
};

describe('every call writes ai.requests', () => {
  it('records a call that answered: who, which model, what it used and what it cost', async () => {
    const context = await ready();
    claude.next(stream(sse('text.sse')));
    const before = claude.requests.length;
    const result = await gateway.generate(context, ask());
    expect(result).toMatchObject({
      outcome: 'ok',
      text: 'Hello!',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'end',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      usedBackup: false,
      usage: { inputTokens: 25, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
      // 25 input tokens at $2 and 15 output tokens at $10 for a million: $0.0002.
      costMicros: 200n,
    });
    expect(claude.requests.length).toBe(before + 1);
    const [row, ...others] = await rows(context);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      job: 'replies',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      key_source: 'own',
      status: 'ok',
      input_tokens: 25,
      output_tokens: 15,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      usage_reported: true,
      cost_estimate: '0.000200',
      actor_kind: 'ai_agent',
      actor_id: context.actorId,
      correlation_id: context.correlationId,
      error_code: null,
      attempt: 1,
      prompt_version: 'replies/1',
      reserved_estimate: '0.000000',
      reserved_until: null,
    });
    expect(result).toMatchObject({ requestId: row?.id });
    expect(row?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row?.started_at.toISOString()).toBe('2026-10-10T09:00:00.000Z');
    expect(row?.finished_at).not.toBeNull();
    expect(row?.log).toEqual({
      request: {
        system: 'You help a small business answer its customers.',
        messages: [{ role: 'user', text: 'Draft a reply to Jordan.' }],
        tools: [],
      },
      response: { text: 'Hello!', toolCalls: [] },
    });
    // Kept for 30 days unless the business says otherwise.
    expect(row?.log_expires_at?.toISOString()).toBe('2026-11-09T09:00:00.000Z');
  });

  it('records a refusal as a refusal, and does not try another model for it', async () => {
    const context = await ready({ backup: ['openai', 'gpt-test'] });
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    claude.next(stream(sse('refusal.sse')));
    const calls = ollama.requests.length;
    const result = await gateway.generate(context, ask());
    expect(result).toMatchObject({
      outcome: 'refused',
      category: 'cyber',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
    expect(ollama.requests.length).toBe(calls);
    expect(await rows(context)).toMatchObject([
      {
        status: 'refused',
        input_tokens: 31,
        output_tokens: 4,
        // Billed all the same: 31 at $2 and 4 at $10 for a million.
        cost_estimate: '0.000102',
        log: { response: { refused: 'cyber' } },
      },
    ]);
  });

  it('records a call that failed, with the kind of failure and nothing of the vendor’s words', async () => {
    const context = await ready();
    claude.next(anthropicError(400, 'invalid_request_error'));
    const result = await gateway.generate(context, ask());
    const [row] = await rows(context);
    expect(result).toEqual({ outcome: 'failed', code: 'invalid_request', requestId: row?.id });
    expect(row).toMatchObject({
      status: 'error',
      error_code: 'invalid_request',
      usage_reported: false,
      input_tokens: 0,
      output_tokens: 0,
      // Nothing was reported, so the cost is unknown: never a made-up zero.
      cost_estimate: null,
      reserved_estimate: '0.000000',
      reserved_until: null,
      log: { response: { error: 'invalid_request' } },
    });
    expect(JSON.stringify(row)).not.toContain('A fixture error.');
  });

  it('records what was billed before a stream broke', async () => {
    const context = await ready();
    claude.next(stream(sse('overloaded.sse')));
    claude.next(stream(sse('overloaded.sse')));
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'failed',
      code: 'unavailable',
    });
    expect(await rows(context)).toMatchObject([
      {
        status: 'error',
        error_code: 'unavailable',
        input_tokens: 25,
        output_tokens: 1,
        attempt: 1,
      },
      {
        status: 'error',
        error_code: 'unavailable',
        input_tokens: 25,
        output_tokens: 1,
        attempt: 2,
      },
    ]);
  });

  it('leaves a call on record even when the worker dies in the middle of it', async () => {
    const context = await ready({ monthlyLimit: '50' });
    const dying = gatewayWith({
      transport: () => Promise.reject(new Error('the worker was killed')),
    });
    await expect(dying.generate(context, ask())).rejects.toThrow('the worker was killed');
    const [row] = await rows(context);
    expect(row).toMatchObject({
      status: 'started',
      finished_at: null,
      cost_estimate: null,
      prompt_version: 'replies/1',
      log: { request: { messages: [{ role: 'user', text: 'Draft a reply to Jordan.' }] } },
    });
    // The hold on the budget ends by itself: the call's deadline plus a minute.
    expect(Number(row?.reserved_estimate)).toBeGreaterThan(0);
    expect(row?.reserved_until?.toISOString()).toBe('2026-10-10T09:06:00.000Z');

    // The next call after the hold lapsed closes the abandoned one.
    clock.now = new Date('2026-10-10T09:07:00.000Z');
    claude.next(stream(sse('text.sse')));
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    expect(await rows(context)).toMatchObject([
      {
        status: 'error',
        error_code: 'abandoned',
        reserved_estimate: '0.000000',
        reserved_until: null,
        cost_estimate: null,
      },
      { status: 'ok' },
    ]);
  });

  it('keeps no log when the business keeps none, and keeps one for as long as it says', async () => {
    const none = await ready({ logDays: 0 });
    claude.next(stream(sse('text.sse')));
    await gateway.generate(none, ask());
    expect(await rows(none)).toMatchObject([{ status: 'ok', log: null, log_expires_at: null }]);

    const week = await ready({ logDays: 7 });
    await gateway.generate(week, ask());
    const [row] = await rows(week);
    expect(row?.log_expires_at?.toISOString()).toBe('2026-10-17T09:00:00.000Z');
  });
});

describe('jobs go to the model chosen for them', () => {
  it('uses each job’s default model until Settings chooses another', async () => {
    const context = await ready();
    for (const [job, model] of [
      ['automation_builder', 'claude-opus-5-5'],
      ['replies', 'claude-sonnet-5-5'],
      ['briefings', 'claude-opus-5-5'],
      ['sorting', 'claude-haiku-4-5-20251001'],
    ] as const) {
      expect(await gateway.generate(context, ask('Hi', { job }))).toMatchObject({
        outcome: 'ok',
        provider: 'anthropic',
        model,
      });
      expect(lastTo(claude).json).toMatchObject({ model });
    }
    await jobModel(context, 'sorting', 'anthropic', 'claude-sonnet-5-5');
    expect(await gateway.generate(context, ask('Hi', { job: 'sorting' }))).toMatchObject({
      model: 'claude-sonnet-5-5',
    });
  });

  it('calls a model server of the business’s own at its address, with or without a key', async () => {
    const context = await business();
    await addKey(context, {
      provider: 'openai_compatible',
      secret: FAKE_OPENAI_KEY,
      baseUrl: `${ollama.origin}/v1`,
    });
    await jobModel(context, 'replies', 'openai_compatible', 'llama3.2');
    const result = await gateway.generate(context, ask());
    expect(result).toMatchObject({
      outcome: 'ok',
      provider: 'openai_compatible',
      model: 'llama3.2',
      text: 'Hello!',
      // The install has entered no price for this model.
      costMicros: null,
    });
    expect(lastTo(ollama).json).toMatchObject({ model: 'llama3.2', max_tokens: 1000 });
    expect(await rows(context)).toMatchObject([
      { provider: 'openai_compatible', model: 'llama3.2', input_tokens: 19, cost_estimate: null },
    ]);

    const local = await business();
    await addKey(local, {
      provider: 'openai_compatible',
      secret: null,
      baseUrl: `${keyless.origin}/v1`,
    });
    await jobModel(local, 'replies', 'openai_compatible', 'llama3.2');
    expect(await gateway.generate(local, ask())).toMatchObject({ outcome: 'ok', text: 'Hello!' });
    expect(lastTo(keyless).headers.authorization).toBeUndefined();
  });

  it('calls OpenAI at OpenAI’s address with its own name for the token limit', async () => {
    const context = await business();
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    await jobModel(context, 'replies', 'openai', 'gpt-test');
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'ok',
      provider: 'openai',
      model: 'gpt-test',
    });
    expect(lastTo(ollama).json).toMatchObject({ model: 'gpt-test', max_completion_tokens: 1000 });
    expect(lastTo(ollama).headers).toMatchObject({ authorization: `Bearer ${FAKE_OPENAI_KEY}` });
  });

  it('uses the agency’s key or the business’s own, as the business chose', async () => {
    const context = await business();
    await addKey(context, { scope: 'agency', secret: FAKE_ANTHROPIC_KEY });
    await addKey(context, { scope: 'business', secret: 'sk-ant-the-business-own' });
    await settings(context, { keySource: 'agency' });
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    expect(lastTo(claude).headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
    expect(await rows(context)).toMatchObject([{ key_source: 'agency', status: 'ok' }]);

    await settings(context, { keySource: 'own' });
    // The stand-in refuses the business's own made-up key, as Anthropic would a wrong one.
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'failed',
      code: 'authentication',
    });
    expect(lastTo(claude).headers['x-api-key']).toBe('sk-ant-the-business-own');
    expect((await rows(context)).at(-1)).toMatchObject({ key_source: 'own', status: 'error' });
  });

  it('takes the first of several keys by label, the same one every time', async () => {
    const context = await business();
    await addKey(context, { label: 'B spare', secret: 'sk-ant-spare' });
    await addKey(context, { label: 'A main', secret: FAKE_ANTHROPIC_KEY });
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    expect(lastTo(claude).headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
  });

  it('runs on the defaults when nothing was ever saved: the agency key, no limit, a 30-day log', async () => {
    const context = await bare();
    await addKey(context, { scope: 'agency' });
    claude.next(stream(sse('text.sse')));
    expect(await gateway.generate(context, ask('Write to jordan@example.com'))).toMatchObject({
      outcome: 'ok',
      model: 'claude-sonnet-5-5',
    });
    // Masking is off until someone turns it on.
    expect(lastTo(claude).body).toContain('jordan@example.com');
    const [row] = await rows(context);
    expect(row).toMatchObject({ key_source: 'agency', status: 'ok' });
    expect(row?.log_expires_at?.toISOString()).toBe('2026-11-09T09:00:00.000Z');
  });

  it('hands the answer text to a listener as it arrives', async () => {
    const context = await ready();
    claude.next(stream(sse('text.sse')));
    const heard: string[] = [];
    await gateway.generate(context, ask(), { onTextDelta: (text) => heard.push(text) });
    expect(heard).toEqual(['Hello', '!']);
  });
});

describe('the backup model', () => {
  it('takes over when the main model fails, and both calls are on record', async () => {
    const context = await ready({ backup: ['openai', 'gpt-test'] });
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    claude.next(anthropicError(400, 'invalid_request_error'));
    const result = await gateway.generate(context, ask());
    expect(result).toMatchObject({
      outcome: 'ok',
      provider: 'openai',
      model: 'gpt-test',
      usedBackup: true,
      text: 'Hello!',
    });
    const [first, second, ...others] = await rows(context);
    expect(others).toEqual([]);
    expect(first).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      status: 'fell_back',
      error_code: 'invalid_request',
      attempt: 1,
    });
    expect(second).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      status: 'ok',
      attempt: 2,
    });
    expect(second?.call_id).toBe(first?.call_id);
    expect(result).toMatchObject({ requestId: second?.id });
  });

  it('tries the main model again first when it is only busy, waiting as long as it asked', async () => {
    const context = await ready({ backup: ['openai', 'gpt-test'] });
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    claude.next(anthropicError(529, 'overloaded_error', { 'retry-after': '3' }));
    claude.next(stream(sse('text.sse')));
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'ok',
      provider: 'anthropic',
      usedBackup: false,
    });
    expect(slept).toEqual([3000]);
    expect(await rows(context)).toMatchObject([
      { provider: 'anthropic', status: 'error', error_code: 'unavailable', attempt: 1 },
      { provider: 'anthropic', status: 'ok', attempt: 2 },
    ]);
  });

  it('backs off by itself when the provider names no wait, then goes to the backup', async () => {
    const context = await ready({ backup: ['openai', 'gpt-test'] });
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    claude.next(anthropicError(500, 'api_error'));
    claude.next(anthropicError(500, 'api_error'));
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'ok',
      provider: 'openai',
      usedBackup: true,
    });
    expect(slept).toEqual([1000]);
    expect(await rows(context)).toMatchObject([
      { provider: 'anthropic', status: 'error', attempt: 1 },
      { provider: 'anthropic', status: 'fell_back', attempt: 2 },
      { provider: 'openai', status: 'ok', attempt: 3 },
    ]);
  });

  it('does not wait on a rate limit that names no end, or one that asks for too long', async () => {
    const context = await ready();
    // A spend-cap 429 carries no retry-after, and repeating it changes nothing.
    claude.next(anthropicError(429, 'rate_limit_error'));
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'failed',
      code: 'rate_limited',
    });
    claude.next(anthropicError(429, 'rate_limit_error', { 'retry-after': '600' }));
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'failed',
      code: 'rate_limited',
    });
    expect(slept).toEqual([]);
    claude.next(anthropicError(429, 'rate_limit_error', { 'retry-after': '2' }));
    claude.next(stream(sse('text.sse')));
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    expect(slept).toEqual([2000]);
  });

  it('does not repeat a call that ran out its deadline, and reports the last failure when both fail', async () => {
    const context = await ready({ backup: ['openai', 'gpt-test'] });
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    claude.next({ status: 200, then: 'hang' });
    ollama.next(openAiError(401, 'invalid_request_error'));
    const result = await gateway.generate(context, ask(), { timeoutMs: 150 });
    expect(result).toMatchObject({ outcome: 'failed', code: 'authentication' });
    expect(slept).toEqual([]);
    expect(await rows(context)).toMatchObject([
      { provider: 'anthropic', status: 'fell_back', error_code: 'timeout' },
      { provider: 'openai', status: 'error', error_code: 'authentication' },
    ]);
  });

  it('is used straight away when the main model has no key', async () => {
    const context = await business();
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    await settings(context, { backup: ['openai', 'gpt-test'] });
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'ok',
      provider: 'openai',
      usedBackup: true,
    });
    expect(await rows(context)).toMatchObject([{ provider: 'openai', status: 'ok', attempt: 1 }]);
  });

  it('is not called when it is the same model as the main one, or has no key', async () => {
    const same = await ready({ backup: ['anthropic', 'claude-sonnet-5-5'] });
    claude.next(anthropicError(400, 'invalid_request_error'));
    expect(await gateway.generate(same, ask())).toMatchObject({
      outcome: 'failed',
      code: 'invalid_request',
    });
    expect(await rows(same)).toMatchObject([{ status: 'error' }]);

    const keyMissing = await ready({ backup: ['openai', 'gpt-test'] });
    claude.next(anthropicError(400, 'invalid_request_error'));
    expect(await gateway.generate(keyMissing, ask())).toMatchObject({
      outcome: 'failed',
      code: 'invalid_request',
    });
    expect(await rows(keyMissing)).toMatchObject([{ provider: 'anthropic', status: 'error' }]);
  });
});

describe('left to itself', () => {
  it('keeps its own time, and really waits before it tries again', async () => {
    const context = await ready();
    const plain = createAiGateway({
      db,
      secrets,
      localServers: parseLocalServers(claude.hostPort),
      baseUrls: { anthropic: claude.origin },
    });
    claude.next(anthropicError(529, 'overloaded_error', { 'retry-after': '0.05' }));
    claude.next(stream(sse('text.sse')));
    const before = Date.now();
    expect(await plain.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    const [first, second] = await rows(context);
    expect(first).toMatchObject({ status: 'error', attempt: 1 });
    expect(second).toMatchObject({ status: 'ok', attempt: 2 });
    expect(first?.started_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // At least the 50 milliseconds the provider asked for lie between the two calls.
    expect(
      (second?.started_at.getTime() ?? 0) - (first?.started_at.getTime() ?? 0),
    ).toBeGreaterThanOrEqual(50);
    expect(slept).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('the spending limit', () => {
  it('pauses AI work once the month’s spend reaches it, without calling anyone', async () => {
    const context = await ready({ monthlyLimit: '50', atLimit: 'pause' });
    await spent(context, '49.999999');
    claude.next(stream(sse('text.sse')));
    // Under the limit, by a millionth of a dollar: the call goes ahead.
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    expect(await reachedAt(context)).toBeNull();

    // That call cost $0.0002: the month is now over the limit.
    const calls = claude.requests.length;
    const recorded = (await rows(context)).length;
    expect(await gateway.generate(context, ask())).toEqual({
      outcome: 'paused',
      reason: 'limit_reached',
    });
    expect(claude.requests.length).toBe(calls);
    expect((await rows(context)).length).toBe(recorded);
    expect((await reachedAt(context))?.toISOString()).toBe('2026-10-10T09:00:00.000Z');
  });

  it('tells the owner once in a month, not on every paused call', async () => {
    const context = await ready({ monthlyLimit: '10', atLimit: 'pause' });
    await spent(context, '10');
    await gateway.generate(context, ask());
    clock.now = new Date('2026-10-20T09:00:00.000Z');
    await gateway.generate(context, ask());
    const told = events.filter((event) => event.type === 'limit_reached');
    expect(told).toEqual([
      {
        type: 'limit_reached',
        agencyId: context.agencyId,
        businessId: context.businessId,
        atLimit: 'pause',
        limitMicros: '10000000',
        spentMicros: '10000000',
      },
    ]);
    expect((await reachedAt(context))?.toISOString()).toBe('2026-10-10T09:00:00.000Z');
  });

  it('writes one event when the limit is reached, for the people who are to be told of it', async () => {
    const limitEvents = (context: TenantContext) =>
      database.as('crm_owner', (sql) =>
        sql.query(
          `select agency_id, type, actor_kind, actor_id, subject_kind, subject_id, payload,
                  correlation_id
           from events.events where business_id = $1 and type = 'ai_settings.limit_reached'
           order by recorded_at, id`,
          [context.businessId],
        ),
      );
    const context = await ready({ monthlyLimit: '10', atLimit: 'pause' });
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    // Under the limit nothing is written.
    expect(await limitEvents(context)).toEqual([]);
    await spent(context, '10');
    await gateway.generate(context, ask());
    // The paused calls that follow in the same month write nothing more.
    clock.now = new Date('2026-10-20T09:00:00.000Z');
    await gateway.generate(context, ask());
    // The amounts are the ones the gateway told the log: the month's spend, over the limit.
    const [told] = events.flatMap((event) => (event.type === 'limit_reached' ? [event] : []));
    expect(BigInt(told?.spentMicros ?? '0')).toBeGreaterThan(10_000_000n);
    expect(await limitEvents(context)).toEqual([
      {
        agency_id: context.agencyId,
        type: 'ai_settings.limit_reached',
        // The gateway noticed it: nobody did it, so everyone who manages AI is told.
        actor_kind: 'system',
        actor_id: null,
        subject_kind: 'business',
        subject_id: context.businessId,
        payload: {
          atLimit: 'pause',
          limitMicros: '10000000',
          spentMicros: told?.spentMicros,
        },
        correlation_id: context.correlationId,
      },
    ]);
    // The next month's limit is told of again.
    clock.now = new Date('2026-11-02T00:00:00.000Z');
    await spent(context, '10', '2026-11-01T00:00:00Z');
    await gateway.generate(context, ask());
    expect(await limitEvents(context)).toHaveLength(2);
  });

  it('keeps going past the limit when the business chose that, and still tells the owner', async () => {
    const context = await ready({ monthlyLimit: '10', atLimit: 'continue' });
    await spent(context, '12.5');
    claude.next(stream(sse('text.sse')));
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    expect(events.filter((event) => event.type === 'limit_reached')).toMatchObject([
      { atLimit: 'continue', limitMicros: '10000000', spentMicros: '12500000' },
    ]);
    expect(await reachedAt(context)).not.toBeNull();
  });

  it('starts over with the month, and tells the owner again when the new month fills up', async () => {
    const context = await ready({ monthlyLimit: '10', atLimit: 'pause' });
    await spent(context, '10', '2026-09-30T23:59:59Z');
    // Last month's spend is last month's.
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    await spent(context, '10', '2026-10-01T00:00:00Z');
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'paused' });
    clock.now = new Date('2026-11-01T00:00:00.000Z');
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    await spent(context, '10', '2026-11-01T00:00:00Z');
    clock.now = new Date('2026-11-02T00:00:00.000Z');
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'paused' });
    expect(events.filter((event) => event.type === 'limit_reached')).toHaveLength(2);
    expect((await reachedAt(context))?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('is never checked for a business that set none', async () => {
    const context = await ready();
    await spent(context, '100000');
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
    expect(events.filter((event) => event.type === 'limit_reached')).toEqual([]);
  });

  it('pauses a model with no known price rather than spend an amount nobody can count', async () => {
    const context = await business();
    await addKey(context, {
      provider: 'openai_compatible',
      secret: FAKE_OPENAI_KEY,
      baseUrl: `${ollama.origin}/v1`,
    });
    await jobModel(context, 'replies', 'openai_compatible', 'llama3.2');
    await settings(context, { monthlyLimit: '10', atLimit: 'pause' });
    const calls = ollama.requests.length;
    expect(await gateway.generate(context, ask())).toEqual({
      outcome: 'paused',
      reason: 'price_unknown',
    });
    expect(ollama.requests.length).toBe(calls);

    // Once the install says what the model costs (here: nothing), it runs under the limit.
    await database.withTenant(
      { agencyId: context.agencyId, actorKind: 'system', correlationId: randomUUID() },
      (sql) =>
        sql.query(
          `insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                                        cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
           values (app.agency_id(), 'openai_compatible', 'llama3.2', 0, 0, 0, 0, 'Our own server', '2026-10-10')`,
        ),
    );
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok', costMicros: 0n });
    expect(await rows(context)).toMatchObject([{ status: 'ok', cost_estimate: '0.000000' }]);

    // With "keep going", an unpriced model runs: there is nothing to pause for.
    const going = await business();
    await addKey(going, {
      provider: 'openai_compatible',
      secret: FAKE_OPENAI_KEY,
      baseUrl: `${ollama.origin}/v1`,
    });
    await jobModel(going, 'replies', 'openai_compatible', 'another-model');
    await settings(going, { monthlyLimit: '10', atLimit: 'continue' });
    expect(await gateway.generate(going, ask())).toMatchObject({ outcome: 'ok', costMicros: null });
  });

  it('falls to a priced backup when only the main model has no price', async () => {
    const context = await ready({
      monthlyLimit: '10',
      atLimit: 'pause',
      backup: ['anthropic', 'claude-sonnet-5-5'],
    });
    await jobModel(context, 'replies', 'anthropic', 'claude-not-in-any-price-table');
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'ok',
      model: 'claude-sonnet-5-5',
      usedBackup: true,
    });
  });

  it('cannot be passed by two calls at once: the second waits, then sees the first one’s hold', async () => {
    const context = await ready({ monthlyLimit: '1', atLimit: 'pause' });
    await spent(context, '0.99');
    // The first call is held inside its admission, after it has taken the business's lock
    // and found room under the limit, and before it has written its hold.
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const admitted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const open = createAiTransport({ localServers: parseLocalServers(claude.hostPort) });
    let reads = 0;
    const gated = gatewayWith({
      // The provider's answer waits too, so the first call is still in flight, its hold in
      // place, when the second is decided.
      transport: async (call) => {
        await answered;
        return open(call);
      },
      secrets: {
        async read(trx, secretId, purpose) {
          reads += 1;
          if (reads === 1) {
            reached();
            await held;
          }
          return secrets.read(trx, secretId, purpose);
        },
      },
    });
    claude.next(stream(sse('text.sse')));
    const calls = claude.requests.length;
    // Room for 4,000 output tokens at $10 a million is $0.04: more than the cent left.
    const first = gated.generate(context, ask('First', { maxOutputTokens: 4000 }));
    await admitted;
    const second = gated.generate(
      { ...context, correlationId: randomUUID() },
      ask('Second', { maxOutputTokens: 4000 }),
    );
    // Another role's wait events are hidden from crm_app, so the superuser watches.
    await expect
      .poll(
        () =>
          database.as('postgres', async (sql) => {
            const [row] = await sql.query<{ waiting: number }>(
              `select count(*)::int as waiting from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'`,
            );
            return row?.waiting ?? 0;
          }),
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);
    release();
    expect(await second).toEqual({ outcome: 'paused', reason: 'limit_reached' });
    answer();
    expect(await first).toMatchObject({ outcome: 'ok' });
    // One call was made, not two.
    expect(claude.requests.length).toBe(calls + 1);

    // Once the first call is settled at what it really cost ($0.0002), there is room again.
    claude.next(stream(sse('text.sse')));
    expect(await gateway.generate(context, ask('Third', { maxOutputTokens: 100 }))).toMatchObject({
      outcome: 'ok',
    });
  });

  it('counts the calls still in flight, but not a hold that has lapsed', async () => {
    const context = await ready({ monthlyLimit: '1', atLimit: 'pause' });
    const inFlight = (until: string) =>
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into ai.requests (business_id, job, provider, model, key_source, status,
                                    cost_estimate, actor_kind, started_at, reserved_estimate, reserved_until)
           values (app.business_id(), 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'started',
                   null, 'ai_agent', '2026-10-10T08:59:00Z', 1, $1)`,
          [until],
        ),
      );
    await inFlight('2026-10-10T09:05:00Z');
    expect(await gateway.generate(context, ask())).toEqual({
      outcome: 'paused',
      reason: 'limit_reached',
    });
    clock.now = new Date('2026-10-10T09:05:01.000Z');
    expect(await gateway.generate(context, ask())).toMatchObject({ outcome: 'ok' });
  });
});

describe('masking', () => {
  const sensitive = ask('Reply to jordan@example.com, who called from 0712 345 678.', {
    system: 'You work for Harbor Lights (hello@harborlights.example, +1 415 555 0123).',
  });

  it('hides phone numbers and email addresses from the provider when the business asks', async () => {
    const context = await ready({ mask: true });
    await gateway.generate(context, sensitive);
    const sent = lastTo(claude);
    expect(sent.json).toMatchObject({
      system: [{ text: 'You work for Harbor Lights ([email], [phone]).' }],
      messages: [{ role: 'user', content: 'Reply to [email], who called from [phone].' }],
    });
    for (const detail of [
      'jordan@example.com',
      '0712 345 678',
      'harborlights.example',
      '415 555 0123',
    ])
      expect(sent.body).not.toContain(detail);
  });

  it('masks what tools return too, and hands the model’s own turn back unchanged', async () => {
    const context = await ready({ mask: true });
    claude.next(stream(sse('tool-use.sse')));
    const turn = await gateway.generate(context, ask('Who asked about June?'));
    if (turn.outcome !== 'ok') throw new Error('Expected a turn.');
    expect(turn.stop).toBe('tool_calls');
    await gateway.generate(
      context,
      ask('', {
        messages: [
          { role: 'user', text: 'Who asked about June?' },
          { role: 'assistant', parts: turn.parts },
          {
            role: 'tool',
            results: [
              {
                toolCallId: 'toolu_01FixtureToolUse0000000',
                text: '{"email":"jordan@example.com"}',
              },
              { toolCallId: 'toolu_01FixtureToolUse0000001', text: '4' },
            ],
          },
        ],
      }),
    );
    const sent = lastTo(claude);
    expect(sent.body).not.toContain('jordan@example.com');
    expect(sent.json).toMatchObject({
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', signature: 'EqQBCgIYAhIMfixture+signature/0123456789==' },
            { type: 'text', text: 'Let me look that up.' },
            { type: 'tool_use', input: { query: 'wedding in June', limit: 5 } },
            { type: 'tool_use', name: 'count_deals' },
          ],
        },
        { role: 'user', content: [{ content: '{"email":"[email]"}' }, { content: '4' }] },
      ],
    });
  });

  it('sends everything as written when the business has not asked, and masks the log all the same', async () => {
    const context = await ready({ mask: false });
    await gateway.generate(context, sensitive);
    expect(lastTo(claude).json).toMatchObject({
      messages: [
        { role: 'user', content: 'Reply to jordan@example.com, who called from 0712 345 678.' },
      ],
    });
    const [row] = await rows(context);
    expect(row?.log).toMatchObject({
      request: {
        system: 'You work for Harbor Lights ([email], [phone]).',
        messages: [{ role: 'user', text: 'Reply to [email], who called from [phone].' }],
      },
    });
    expect(JSON.stringify(row)).not.toContain('jordan@example.com');
  });

  it('cannot be turned off by the caller: the setting is read by the gateway, per call', async () => {
    const context = await ready({ mask: true });
    const smuggled = { ...sensitive, mask: false, maskContactDetails: false };
    await gateway.generate(context, smuggled);
    expect(lastTo(claude).body).not.toContain('jordan@example.com');
    await settings(context, { mask: false });
    await gateway.generate(context, sensitive);
    expect(lastTo(claude).body).toContain('jordan@example.com');
  });

  it('applies to the backup model as it does to the main one', async () => {
    const context = await ready({ mask: true, backup: ['openai', 'gpt-test'] });
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    claude.next(anthropicError(400, 'invalid_request_error'));
    await gateway.generate(context, sensitive);
    expect(lastTo(ollama).body).not.toContain('jordan@example.com');
    expect(lastTo(ollama).json).toMatchObject({
      messages: [
        { role: 'system', content: 'You work for Harbor Lights ([email], [phone]).' },
        { role: 'user', content: 'Reply to [email], who called from [phone].' },
      ],
    });
  });
});

describe('prices', () => {
  it('uses the install’s own price for a model over the one shipped', async () => {
    const context = await ready();
    await database.withTenant(
      { agencyId: context.agencyId, actorKind: 'system', correlationId: randomUUID() },
      (sql) =>
        sql.query(
          `insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                                        cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
           values (app.agency_id(), 'anthropic', 'claude-sonnet-5-5', 3, 15, 0.30, 3.75,
                   'Negotiated rate', '2026-10-01')`,
        ),
    );
    claude.next(stream(sse('text.sse')));
    // 25 input tokens at $3 and 15 output tokens at $15 for a million: $0.0003.
    expect(await gateway.generate(context, ask())).toMatchObject({ costMicros: 300n });
    expect(await rows(context)).toMatchObject([{ cost_estimate: '0.000300' }]);
  });

  it('records an unknown cost as unknown: no price, or no usage from the server', async () => {
    const unpriced = await ready();
    await jobModel(unpriced, 'replies', 'anthropic', 'claude-not-in-any-price-table');
    claude.next(stream(sse('text.sse')));
    expect(await gateway.generate(unpriced, ask())).toMatchObject({
      outcome: 'ok',
      costMicros: null,
      usage: { inputTokens: 25 },
    });
    expect(await rows(unpriced)).toMatchObject([
      { status: 'ok', input_tokens: 25, usage_reported: true, cost_estimate: null },
    ]);

    const silent = await business();
    await addKey(silent, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    await jobModel(silent, 'replies', 'openai', 'gpt-test');
    const { usage: _usage, ...withoutUsage } = JSON.parse(
      fixture('openai', 'chat-completion.json'),
    ) as Record<string, unknown>;
    ollama.next(json(200, withoutUsage));
    expect(await gateway.generate(silent, ask())).toMatchObject({
      outcome: 'ok',
      usage: null,
      costMicros: null,
    });
    expect(await rows(silent)).toMatchObject([
      {
        status: 'ok',
        usage_reported: false,
        input_tokens: 0,
        output_tokens: 0,
        cost_estimate: null,
      },
    ]);
  });

  it('shows a cache hit in the record and in the cost of the second call', async () => {
    const system = `You are the assistant of a small business. ${'Answer briefly and kindly. '.repeat(200)}`;
    const one = await ready();
    const other = await ready();
    const first = await gateway.generate(one, ask('What did Jordan ask?', { system }));
    // Another business, the same prompt: it reads what the first wrote.
    const second = await gateway.generate(other, ask('What did Priya ask?', { system }));
    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('Expected two answers.');
    const [written] = await rows(one);
    const [read] = await rows(other);
    expect(written?.cache_write_tokens).toBeGreaterThan(1000);
    expect(written?.cache_read_tokens).toBe(0);
    expect(read?.cache_read_tokens).toBe(written?.cache_write_tokens);
    expect(read?.cache_write_tokens).toBe(0);
    // A cache read costs a twentieth of fresh input on this model; a write costs more.
    expect(Number(read?.cost_estimate)).toBeLessThan(Number(written?.cost_estimate) / 10);
    expect(second.costMicros).toBeLessThan(first.costMicros ?? 0n);
  });

  it('asks for the hour’s cache for a job that keeps one, and counts its writes at that price', async () => {
    const system = `Kept for an hour. ${'Write as the business would. '.repeat(200)}`;
    const context = await ready();
    const result = await gateway.generate(context, ask('What did Jordan ask?', { system }));
    if (result.outcome !== 'ok' || result.usage === null) throw new Error('Expected an answer.');
    expect(JOB_CACHE_TTL.replies).toBe('1h');
    expect(lastTo(claude).json).toMatchObject({
      system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
    const { inputTokens, outputTokens, cacheWriteTokens } = result.usage;
    expect(result.usage.cacheWrite1hTokens).toBe(cacheWriteTokens);
    const [row] = await rows(context);
    expect(row).toMatchObject({
      cache_write_tokens: cacheWriteTokens,
      cache_write_1h_tokens: cacheWriteTokens,
    });
    // Claude Sonnet 5.5: $2 input, $10 output and $4 for a million tokens written for an
    // hour, not the five minutes' $2.50. A dollar a million tokens is a micro a token.
    expect(result.costMicros).toBe(
      BigInt(inputTokens * 2 + outputTokens * 10 + cacheWriteTokens * 4),
    );
    // The logs are told the hour's part as well.
    expect(events.find((event) => event.type === 'request')).toMatchObject({
      usage: { cacheWrite1hTokens: cacheWriteTokens },
    });
  });

  it('asks for five minutes for briefings, and wherever the model has no price for an hour', async () => {
    const context = await ready();
    expect(JOB_CACHE_TTL.briefings).toBe('5m');
    claude.next(stream(sse('text.sse')));
    await gateway.generate(context, ask('Brief me.', { job: 'briefings' }));
    expect(lastTo(claude).json).toMatchObject({
      system: [{ cache_control: { type: 'ephemeral' } }],
    });
    expect(lastTo(claude).json).not.toHaveProperty(['system', 0, 'cache_control', 'ttl']);

    // The agency's own price says nothing of an hour: the hour is not used, not guessed at.
    const agency: TenantContext = {
      agencyId: context.agencyId,
      actorKind: 'system',
      correlationId: randomUUID(),
    };
    await database.withTenant(agency, (sql) =>
      sql.query(
        `insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                                      cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
         values (app.agency_id(), 'anthropic', 'claude-sonnet-5-5', 2, 10, 0.10, 2.50,
                 'Entered before the hour had a price', '2026-10-01')`,
      ),
    );
    claude.next(stream(sse('text.sse')));
    await gateway.generate(context, ask());
    expect(lastTo(claude).json).not.toHaveProperty(['system', 0, 'cache_control', 'ttl']);
    await database.withTenant(agency, (sql) =>
      sql.query(`update ai.model_prices set cache_write_1h_per_mtok = 4`),
    );
    claude.next(stream(sse('text.sse')));
    await gateway.generate(context, ask());
    expect(lastTo(claude).json).toMatchObject({
      system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
  });

  it('holds the hour’s dearer write against the limit while such a call is in flight', async () => {
    // A worker that dies mid-call leaves the call in flight with its hold.
    const dying = gatewayWith({
      transport: () => Promise.reject(new Error('the worker was killed')),
    });
    const heldFor = async (job: 'replies' | 'briefings'): Promise<number> => {
      const context = await ready({ monthlyLimit: '50' });
      await jobModel(context, job, 'anthropic', 'claude-sonnet-5-5');
      await expect(dying.generate(context, ask('Hold this.', { job }))).rejects.toThrow();
      const [row] = await rows(context);
      return Number(row?.reserved_estimate);
    };
    const fiveMinutes = await heldFor('briefings');
    // The same request, its input allowance at $4 for an hour's write against $2.50.
    expect(await heldFor('replies')).toBeGreaterThan(fiveMinutes);
    expect(fiveMinutes).toBeGreaterThan(0);
  });

  it('leaves a cost unknown when an hour’s writes come back for a model with no such price', async () => {
    const context = await ready();
    await database.withTenant(
      { agencyId: context.agencyId, actorKind: 'system', correlationId: randomUUID() },
      (sql) =>
        sql.query(
          `insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                                        cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
           values (app.agency_id(), 'anthropic', 'claude-sonnet-5-5', 2, 10, 0.10, 2.50,
                   'No hour', '2026-10-01')`,
        ),
    );
    // A server that wrote to the hour's cache though five minutes were asked for.
    claude.next(
      stream(
        sse('text.sse').replace(
          '"cache_creation_input_tokens":0,"cache_read_input_tokens":0',
          '"cache_creation_input_tokens":900,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":900}',
        ),
      ),
    );
    expect(await gateway.generate(context, ask())).toMatchObject({
      outcome: 'ok',
      costMicros: null,
      usage: { cacheWriteTokens: 900, cacheWrite1hTokens: 900 },
    });
    expect(await rows(context)).toMatchObject([
      { cache_write_tokens: 900, cache_write_1h_tokens: 900, cost_estimate: null },
    ]);
  });
});

describe('when AI is off or not set up', () => {
  it('calls nobody for a business that turned AI off', async () => {
    const context = await ready({ enabled: false });
    const calls = claude.requests.length;
    expect(await gateway.generate(context, ask())).toEqual({ outcome: 'off' });
    expect(claude.requests.length).toBe(calls);
    expect(await rows(context)).toEqual([]);
  });

  it('says there is no key when there is none: AI stays off until someone adds one', async () => {
    const context = await business();
    expect(await gateway.generate(context, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'no_key',
    });
    // The agency has a key, but this business uses its own and has none.
    await addKey(context, { scope: 'agency' });
    await settings(context, { keySource: 'own' });
    expect(await gateway.generate(context, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'no_key',
    });
    expect(await rows(context)).toEqual([]);
    expect(events).toMatchObject([
      { type: 'skipped', reason: 'no_key', job: 'replies' },
      { type: 'skipped', reason: 'no_key', job: 'replies' },
    ]);
  });

  it('says so for a provider it has no adapter for, and for a hosted key with no secret', async () => {
    const gemini = await business();
    await addKey(gemini, { provider: 'gemini', secret: 'gemini-key' });
    await jobModel(gemini, 'replies', 'gemini', 'gemini-test');
    expect(await gateway.generate(gemini, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'provider_not_supported',
    });
    const builtIn = await ready();
    await jobModel(builtIn, 'replies', 'builtin', 'voyage-4-nano');
    expect(await gateway.generate(builtIn, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'provider_not_supported',
    });
  });

  it('says so when the key cannot be opened, without calling anyone', async () => {
    const context = await business();
    const secretId = await addKey(context);
    if (secretId === null) throw new Error('Expected a secret.');
    plaintexts.delete(secretId);
    const calls = claude.requests.length;
    expect(await gateway.generate(context, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'key_unreadable',
    });
    expect(claude.requests.length).toBe(calls);
    expect(await rows(context)).toEqual([]);
  });

  it('never opens a secret that is not an AI key, whatever a row points at', async () => {
    const context = await business();
    // A mailbox password, referenced from a provider's row as if it were its key.
    const mailboxSecret = await database.withTenant(context, async (sql) => {
      const { id } = await sql.one<{ id: string }>(
        `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         values ($1, $2, 'mailbox.password', 1, $3, $4) returning id`,
        [context.agencyId, context.businessId, randomBytes(32), randomBytes(48)],
      );
      await sql.query(
        `insert into ai.provider_keys (agency_id, business_id, provider, secret_id, key_last4)
         values ($1, $2, 'anthropic', $3, 'word')`,
        [context.agencyId, context.businessId, id],
      );
      return id;
    });
    plaintexts.set(mailboxSecret, 'the-mailbox-password');
    const calls = claude.requests.length;
    expect(await gateway.generate(context, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'key_unreadable',
    });
    expect(claude.requests.length).toBe(calls);
  });
});

describe('where a key may be sent', () => {
  it('refuses a model server the install has not listed, and sends it nothing', async () => {
    const unlisted = await startFakeOpenAi();
    try {
      const context = await business();
      await addKey(context, {
        provider: 'openai_compatible',
        secret: FAKE_OPENAI_KEY,
        baseUrl: `${unlisted.origin}/v1`,
      });
      await jobModel(context, 'replies', 'openai_compatible', 'llama3.2');
      expect(await gateway.generate(context, ask())).toMatchObject({
        outcome: 'failed',
        code: 'blocked_address',
      });
      expect(unlisted.requests).toEqual([]);
      expect(await rows(context)).toMatchObject([
        { status: 'error', error_code: 'blocked_address' },
      ]);
    } finally {
      await unlisted.stop();
    }
  });

  it('refuses the cloud metadata address and other private addresses a row may name', async () => {
    const context = await business();
    for (const [index, baseUrl] of [
      'http://169.254.169.254/latest',
      'https://169.254.169.254/latest',
      'https://10.0.0.5/v1',
      'http://localhost:5432/v1',
      'https://user:pass@api.example.com/v1',
    ].entries()) {
      await addKey(context, {
        provider: 'openai_compatible',
        secret: FAKE_OPENAI_KEY,
        baseUrl,
        // Each row sorts before the last, so the gateway picks the newest.
        label: `server ${String(9 - index)}`,
      });
      await jobModel(context, 'replies', 'openai_compatible', 'llama3.2');
      expect(await gateway.generate(context, ask())).toMatchObject({
        outcome: 'failed',
        code: 'blocked_address',
      });
    }
  });
});

describe('tenant isolation', () => {
  it('keeps one business’s key, settings, spend and records from another', async () => {
    const one = await ready({ monthlyLimit: '10', mask: true });
    const sameAgency = await business(one.agencyId);
    const otherAgency = await business();
    await spent(one, '10');

    // Neither can use the first business's own key.
    expect(await gateway.generate(sameAgency, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'no_key',
    });
    expect(await gateway.generate(otherAgency, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'no_key',
    });

    // With keys of their own, the first business's limit and spend are not theirs.
    await addKey(sameAgency);
    await addKey(otherAgency);
    expect(await rows(sameAgency)).toEqual([]);
    expect(await gateway.generate(one, ask())).toMatchObject({ outcome: 'paused' });
    expect(await gateway.generate(sameAgency, ask())).toMatchObject({ outcome: 'ok' });
    expect(await gateway.generate(otherAgency, ask())).toMatchObject({ outcome: 'ok' });

    // Each sees its own records only.
    const [mine] = await rows(sameAgency);
    const [theirs] = await rows(otherAgency);
    expect((await rows(one)).map((row) => row.id)).not.toContain(mine?.id);
    expect(await rows(sameAgency)).toHaveLength(1);
    expect(await rows(otherAgency)).toHaveLength(1);
    expect(mine?.id).not.toBe(theirs?.id);
  });

  it('shares an agency’s key with its own businesses only', async () => {
    const one = await business();
    await addKey(one, { scope: 'agency' });
    await settings(one, { keySource: 'agency' });
    const sibling = await business(one.agencyId);
    await settings(sibling, { keySource: 'agency' });
    const stranger = await business();
    await settings(stranger, { keySource: 'agency' });
    expect(await gateway.generate(one, ask())).toMatchObject({ outcome: 'ok' });
    expect(await gateway.generate(sibling, ask())).toMatchObject({ outcome: 'ok' });
    expect(await gateway.generate(stranger, ask())).toEqual({
      outcome: 'not_configured',
      reason: 'no_key',
    });
  });

  it('keeps an agency’s prices to that agency', async () => {
    const one = await ready();
    const stranger = await ready();
    await database.withTenant(
      { agencyId: one.agencyId, actorKind: 'system', correlationId: randomUUID() },
      (sql) =>
        sql.query(
          `insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                                        cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
           values (app.agency_id(), 'anthropic', 'claude-sonnet-5-5', 100, 100, 100, 100, 'Test', '2026-10-01')`,
        ),
    );
    claude.next(stream(sse('text.sse')));
    claude.next(stream(sse('text.sse')));
    expect(await gateway.generate(one, ask())).toMatchObject({ costMicros: 4000n });
    expect(await gateway.generate(stranger, ask())).toMatchObject({ costMicros: 200n });
  });

  it('needs a business: agency staff with none selected cannot spend anyone’s budget', async () => {
    const context = await ready();
    const { businessId: _businessId, ...agencyOnly } = context;
    await expect(gateway.generate(agencyOnly, ask())).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the one way to a provider', () => {
  it('is the gateway: the module hands out no adapter and no client to call one around it', async () => {
    // Another module can import this entry point only (the module boundary rule), so what
    // is not here cannot be reached: no adapter, no transport, no way past the masking.
    expect(Object.keys(await import('./index.js')).sort()).toEqual([
      'AI_JOBS',
      'AI_KEY_PURPOSE',
      'AI_PROVIDERS',
      'BUILT_IN_PRICES',
      'CONNECTION_TEST_JOB',
      'DEFAULT_JOB_MODELS',
      'PROVIDER_ERROR_CODES',
      'aiRoutes',
      'checkBaseUrl',
      'createAiGateway',
      'createAiSettingsRoutes',
      // The in-app assistant: its conversations' routes, its tools (the API's own routes,
      // which it is handed) and the job that runs a turn, which is handed a gateway.
      'createAssistantChatRoutes',
      // Proposals and reply drafts: routes, a job, a store and a sweep. None of them is a
      // way to a provider: the job is handed a gateway.
      'createAssistantRoutes',
      'createAssistantToolbox',
      'createAssistantTurnTask',
      'createContactJourneyRoute',
      'createDraftReplyTask',
      // Field extraction and contact memory: a job that is handed a gateway, the routes
      // people read and correct facts by, and the one command to propose.
      'createExtractContactTask',
      'createMemoryProposables',
      'createMemoryRoutes',
      'createTestAiConnectionTask',
      'dollarsToMicros',
      'estimateCostMicros',
      'expireAiProposals',
      'expireAiRequestLogs',
      'expireAssistantThreads',
      'maskContactDetails',
      'microsToDollars',
      'parseLocalServers',
      'priceKey',
      'storeProposal',
      'textOf',
      'toolCallsOf',
    ]);
  });

  it('calls a hosted provider at its own address unless a test says otherwise', async () => {
    // No stand-in address is given, so the key would go to api.anthropic.com: the transport
    // that stands in for the network sees where the call was going, and sends nothing.
    const context = await ready();
    const asked: string[] = [];
    const real = gatewayWith({
      baseUrls: {},
      transport: (call) => {
        asked.push(`${call.method} ${call.url}`);
        return Promise.reject(new AiTransportError('network'));
      },
      maxCallsPerModel: 1,
    });
    expect(await real.generate(context, ask())).toMatchObject({
      outcome: 'failed',
      code: 'unavailable',
    });
    await jobModel(context, 'replies', 'openai', 'gpt-test');
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    await real.generate(context, ask());
    expect(asked).toEqual([
      'POST https://api.anthropic.com/v1/messages',
      'POST https://api.openai.com/v1/chat/completions',
    ]);
  });
});

describe('what is told to the logs', () => {
  it('says what happened to each call, and nothing of what was said or which key was used', async () => {
    const context = await ready({ backup: ['openai', 'gpt-test'] });
    await addKey(context, { provider: 'openai', secret: FAKE_OPENAI_KEY });
    claude.next(anthropicError(400, 'invalid_request_error'));
    const result = await gateway.generate(
      context,
      ask('A private question about jordan@example.com', { system: 'A private system prompt.' }),
    );
    const [first, second] = await rows(context);
    expect(events).toEqual([
      {
        type: 'request',
        agencyId: context.agencyId,
        businessId: context.businessId,
        correlationId: context.correlationId,
        callId: first?.call_id,
        requestId: first?.id,
        job: 'replies',
        promptVersion: 'replies/1',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        keySource: 'own',
        attempt: 1,
        // As it stood when the call ended; the record says fell_back once the backup ran.
        status: 'error',
        errorCode: 'invalid_request',
        latencyMs: expect.any(Number) as number,
        usage: null,
        costMicros: null,
      },
      {
        type: 'request',
        agencyId: context.agencyId,
        businessId: context.businessId,
        correlationId: context.correlationId,
        callId: first?.call_id,
        requestId: second?.id,
        job: 'replies',
        promptVersion: 'replies/1',
        provider: 'openai',
        model: 'gpt-test',
        keySource: 'own',
        attempt: 2,
        status: 'ok',
        errorCode: null,
        latencyMs: expect.any(Number) as number,
        usage: { inputTokens: 19, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costMicros: null,
      },
    ]);
    const told = JSON.stringify(events);
    for (const secret of [
      'private',
      'jordan@example.com',
      FAKE_ANTHROPIC_KEY,
      FAKE_OPENAI_KEY,
      'Hello!',
      '127.0.0.1',
    ])
      expect(told).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(FAKE_OPENAI_KEY);
  });
});

describe('a request that makes no sense', () => {
  it.each([
    ['a job it does not know', { job: 'search' }],
    ['no prompt version', { promptVersion: '' }],
    ['a prompt version too long to keep', { promptVersion: 'v'.repeat(101) }],
    ['no messages', { messages: [] }],
    ['a conversation that starts with the model', { messages: [{ role: 'assistant', parts: [] }] }],
    ['an empty message from a person', { messages: [{ role: 'user', text: '' }] }],
    ['no room to answer', { maxOutputTokens: 0 }],
    ['a fractional token limit', { maxOutputTokens: 10.5 }],
    ['a token limit beyond any model', { maxOutputTokens: 1_000_001 }],
    [
      'a tool with a name no provider takes',
      { tools: [{ name: 'find contacts', description: '', inputSchema: { type: 'object' } }] },
    ],
    [
      'two tools with one name',
      {
        tools: [
          { name: 'find', description: '', inputSchema: { type: 'object' } },
          { name: 'find', description: '', inputSchema: { type: 'object' } },
        ],
      },
    ],
    [
      'a tool whose schema is not an object’s',
      { tools: [{ name: 'find', description: '', inputSchema: { type: 'string' } }] },
    ],
  ])('is refused before anything is read or sent: %s', async (_name, change) => {
    const context = await ready();
    const calls = claude.requests.length;
    await expect(
      gateway.generate(context, { ...ask(), ...(change as Partial<GatewayRequest>) }),
    ).rejects.toThrow(RangeError);
    expect(claude.requests.length).toBe(calls);
    expect(await rows(context)).toEqual([]);
  });

  it('refuses a deadline out of range', async () => {
    const context = await ready();
    for (const timeoutMs of [0, 99, 900_001, 1.5])
      await expect(gateway.generate(context, ask(), { timeoutMs })).rejects.toThrow(RangeError);
  });
});
