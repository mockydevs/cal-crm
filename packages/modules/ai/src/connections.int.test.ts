// Settings → AI models: connecting a provider and testing it, against real Postgres under
// row-level security, through the routes the app registers and the task the worker runs,
// with the real gateway, adapters and transport and local stand-ins for the providers. No
// test calls a real provider.
import {
  connectAiProvider,
  getAiConnectionTest,
  listAiConnections,
  removeAiConnection,
  startAiConnectionTest,
  updateAiConnection,
  type AiConnectionSaved,
} from '@repo/contracts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { anthropicError } from '../test/fake-anthropic.js';
import { openAiError } from '../test/fake-openai.js';
import { fixture, stream } from '../test/fake-provider.js';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_OPENAI_KEY,
  startSettingsWorld,
  type Person,
  type SettingsWorld,
} from '../test/settings-world.js';
import { TEST_WINDOW_MS } from './connection-tests.js';
import { AI_KEY_PURPOSE } from './gateway.js';
import { BUILT_IN_PRICES, estimateCostMicros, microsToDollars, priceKey } from './pricing.js';

let world: SettingsWorld;
beforeAll(async () => {
  world = await startSettingsWorld(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});
beforeEach(async () => {
  world.clock.now = new Date('2026-10-10T09:00:00.000Z');
  // Tests an earlier case queued and never ran are not this case's to run.
  await world.discardQueuedTests();
  world.events.length = 0;
  for (const fake of [world.claude, world.openai, world.ollama]) fake.requests.length = 0;
});

const claudeKey = { provider: 'anthropic', apiKey: FAKE_ANTHROPIC_KEY } as const;
const server = () =>
  ({
    provider: 'openai_compatible',
    baseUrl: `${world.ollama.origin}/v1`,
    model: 'fixture-model',
  }) as const;

const connect = (person: Person, body: unknown = claudeKey): Promise<AiConnectionSaved> =>
  world.call(connectAiProvider, person, { body });
const list = async (person: Person) => (await world.call(listAiConnections, person)).data;
const readTest = (person: Person, id: string) =>
  world.call(getAiConnectionTest, person, { params: { id } });

interface KeyRow {
  id: string;
  business_id: string | null;
  provider: string;
  base_url: string | null;
  default_model: string | null;
  secret_id: string | null;
  key_last4: string | null;
  status: string;
  last_test_outcome: string | null;
  last_test_latency_ms: number | null;
  created_by_id: string | null;
}
const keyRows = (person: Person) =>
  world.database.withTenant(person.context, (sql) =>
    sql.query<KeyRow>(
      `select * from ai.provider_keys
       where business_id is not distinct from app.business_id() order by created_at, id`,
    ),
  );
const secretRows = (person: Person) =>
  world.database.withTenant(person.context, (sql) =>
    sql.query<{ id: string; purpose: string; business_id: string | null }>(
      `select id, purpose, business_id from vault.secrets
       where business_id is not distinct from app.business_id() order by id`,
    ),
  );
interface CallRow {
  id: string;
  job: string;
  provider: string;
  model: string;
  key_source: string;
  status: string;
  error_code: string | null;
  cost_estimate: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  prompt_version: string | null;
  attempt: number;
  actor_kind: string;
}
const calls = (person: Person) =>
  world.database.withTenant(person.context, (sql) =>
    sql.query<CallRow>('select * from ai.requests order by started_at, id'),
  );
/** Everything the product wrote down about what a person did: the audit log and events. */
const written = (agencyId: string) =>
  world.database.as('crm_owner', async (sql) =>
    JSON.stringify([
      await sql.query('select command, outcome, input from audit.commands where agency_id = $1', [
        agencyId,
      ]),
      await sql.query('select type, payload from events.events where agency_id = $1', [agencyId]),
    ]),
  );
const setSettings = (person: Person, columns: Record<string, unknown>) => {
  const names = Object.keys(columns);
  return world.database.withTenant(person.context, (sql) =>
    sql.query(
      `insert into ai.settings (business_id, ${names.join(', ')})
       values (app.business_id(), ${names.map((_, index) => `$${String(index + 1)}`).join(', ')})
       on conflict (business_id) do update set
         ${names.map((name) => `${name} = excluded.${name}`).join(', ')}`,
      names.map((name) => columns[name]),
    ),
  );
};

describe('connecting a provider', () => {
  it('seals the key for the worker, keeps its last four characters, and never gives it back', async () => {
    const dana = await world.admin();
    const saved = await connect(dana);
    expect(saved.connection).toMatchObject({
      provider: 'anthropic',
      owner: 'business',
      canManage: true,
      hasKey: true,
      keyLast4: FAKE_ANTHROPIC_KEY.slice(-4),
      baseUrl: null,
      model: null,
      status: 'untested',
      lastTest: null,
      addedBy: dana.name,
    });
    expect(saved.test).toMatchObject({ status: 'pending', kind: 'model_call', outcome: null });

    // The row names a sealed secret; the key itself is nowhere in the database's rows.
    const [row] = await keyRows(dana);
    const [secret] = await secretRows(dana);
    expect(row).toMatchObject({ provider: 'anthropic', created_by_id: dana.userId });
    expect(secret).toMatchObject({ id: row?.secret_id, purpose: AI_KEY_PURPOSE });
    expect(world.sealed.get(secret?.id ?? '')).toBe(FAKE_ANTHROPIC_KEY);

    // Nothing the API answers, and nothing the product wrote down, has the key in it.
    const everything = JSON.stringify([
      saved,
      await list(dana),
      await readTest(dana, saved.test.id),
    ]);
    expect(everything).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(everything).not.toContain(FAKE_ANTHROPIC_KEY.slice(0, 12));
    const log = await written(dana.context.agencyId);
    expect(log).toContain('ai.connect_provider');
    expect(log).toContain('ai_connection.connected');
    expect(log).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(log).not.toContain(FAKE_ANTHROPIC_KEY.slice(0, 12));
  });

  it('shows no part of a key too short or too odd to tell apart by its ending', async () => {
    const dana = await world.admin();
    expect(
      (await connect(dana, { provider: 'anthropic', apiKey: 'short-key' })).connection,
    ).toMatchObject({
      hasKey: true,
      keyLast4: null,
    });
    const other = await world.admin();
    expect(
      (await connect(other, { provider: 'anthropic', apiKey: 'a-longer-key-ending-in+/==' }))
        .connection.keyLast4,
    ).toBeNull();
  });

  it('has one connection of a provider in each place: the business’s, and the agency’s', async () => {
    const dana = await world.admin();
    const agency = await world.agencyAdmin(dana.context.agencyId);
    await connect(dana);
    await expect(connect(dana)).rejects.toThrow(ConflictError);
    await expect(connect(dana)).rejects.toThrow(
      'This provider is already connected here. Replace its key instead.',
    );
    // The agency's own is another place, and so is a sibling business's.
    await connect(agency);
    await expect(connect(agency)).rejects.toThrow(ConflictError);
    await connect(await world.admin(dana.context.agencyId));
    // The refused attempts sealed nothing.
    expect(await secretRows(dana)).toHaveLength(1);
    expect(await secretRows(agency)).toHaveLength(1);
  });

  it('lets only one of two people connecting the same provider at once succeed', async () => {
    const dana = await world.admin();
    // A row for the provider, written and not yet committed, as the first of two would have.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written: () => void = () => undefined;
    const wrote = new Promise<void>((resolve) => {
      written = resolve;
    });
    const first = world.database.withTenant(dana.context, async (sql) => {
      await sql.query(
        `insert into ai.provider_keys (agency_id, business_id, provider, base_url, default_model)
         values (app.agency_id(), app.business_id(), 'openai_compatible', 'http://ollama:11434/v1', 'm')`,
      );
      written();
      await held;
    });
    await wrote;
    const second = connect(dana, server());
    // Another role's wait events are hidden from crm_app, so the superuser watches.
    await expect
      .poll(
        () =>
          world.database.as('postgres', async (sql) => {
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
    await first;
    await expect(second).rejects.toThrow(
      'This provider is already connected here. Replace its key instead.',
    );
    expect(await keyRows(dana)).toHaveLength(1);
    // The one that lost sealed nothing that stays.
    expect(await secretRows(dana)).toEqual([]);
  });

  it('needs a business or the agency’s own place, and a role that allows it', async () => {
    const dana = await world.admin();
    await expect(connect(world.limited(dana, ['contacts.manage']))).rejects.toMatchObject({
      name: 'ForbiddenError',
      permission: 'ai.manage',
    });
    expect(await keyRows(dana)).toEqual([]);
    expect(await secretRows(dana)).toEqual([]);
  });
});

describe('a model server’s address', () => {
  it('is saved when it is one the operator listed, even over plain http, or public https', async () => {
    const dana = await world.admin();
    const saved = await connect(dana, { ...server(), baseUrl: `${world.ollama.origin}/v1/` });
    expect(saved.connection).toMatchObject({
      provider: 'openai_compatible',
      baseUrl: `${world.ollama.origin}/v1`,
      model: 'fixture-model',
      hasKey: false,
      keyLast4: null,
    });
    expect(await secretRows(dana)).toEqual([]);

    const other = await world.admin();
    expect(
      (
        await connect(other, {
          provider: 'openai_compatible',
          baseUrl: 'https://models.example.com/v1',
          model: 'llama3.2',
          apiKey: FAKE_OPENAI_KEY,
        })
      ).connection,
    ).toMatchObject({ baseUrl: 'https://models.example.com/v1', hasKey: true });
  });

  it.each([
    ['a private address nobody listed', 'http://ollama:11434/v1', 'address_not_https', true],
    ['a listed host on another port', 'http://127.0.0.1:1/v1', 'address_not_https', true],
    ['the cloud’s metadata address', 'http://169.254.169.254/latest', 'address_not_https', true],
    [
      'https on a port of its own',
      'https://models.example.com:8443/v1',
      'address_port_not_allowed',
      true,
    ],
    ['another kind of address', 'ftp://models.example.com/v1', 'address_not_https', true],
    ['something that is not an address', 'models example', 'address_not_a_url', false],
    [
      'a name and password in it',
      'https://dana:hunter2@models.example.com/v1',
      'address_has_credentials',
      false,
    ],
    ['a query in it', 'https://models.example.com/v1?key=abc', 'address_has_query', false],
    ['a fragment in it', 'https://models.example.com/v1#top', 'address_has_query', false],
  ])('is refused with what to do when it is %s', async (_name, baseUrl, code, operator) => {
    const dana = await world.admin();
    const refusal = await connect(dana, { ...server(), baseUrl, apiKey: FAKE_OPENAI_KEY }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ValidationError);
    const [issue] = (refusal as ValidationError).issues;
    expect(issue).toMatchObject({ path: '/baseUrl', code });
    // What the person who runs the install has to set, and where: said exactly when that
    // is what would let the address through.
    expect(issue.suggestion?.includes('AI_LOCAL_SERVERS') ?? false).toBe(operator);
    // Nothing was saved, and the key that came with the address was not sealed.
    expect(await keyRows(dana)).toEqual([]);
    expect(await secretRows(dana)).toEqual([]);
    // Which servers the operator did list is never said.
    const said = JSON.stringify([issue, (refusal as ValidationError).message]);
    expect(said).not.toContain(world.ollama.hostPort);
    expect(said).not.toContain(new URL(world.ollama.origin).port);
  });

  it('keeps only where a refused address pointed, never a name, a password or a key in it', async () => {
    const dana = await world.admin();
    await expect(
      connect(dana, {
        ...server(),
        baseUrl: 'https://dana:hunter2@models.example.com/v1?token=s3cret',
        apiKey: FAKE_OPENAI_KEY,
      }),
    ).rejects.toThrow(ValidationError);
    const log = await written(dana.context.agencyId);
    expect(log).toContain('https://models.example.com');
    for (const secret of ['hunter2', 'dana:', 's3cret', FAKE_OPENAI_KEY])
      expect(log).not.toContain(secret);
  });

  it('is checked again when it is changed', async () => {
    const dana = await world.admin();
    const { connection } = await connect(dana, server());
    await expect(
      world.call(updateAiConnection, dana, {
        params: { id: connection.id },
        body: { baseUrl: 'http://10.0.0.5:11434/v1' },
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/baseUrl', code: 'address_not_https' }] });
    expect((await keyRows(dana))[0]?.base_url).toBe(`${world.ollama.origin}/v1`);
  });
});

describe('testing a connection in a business', () => {
  it('makes one short call to the model, says how long the provider took, and records the call with its cost', async () => {
    const dana = await world.admin();
    const { connection, test } = await connect(dana);
    world.clock.now = new Date('2026-10-10T09:00:02.000Z');
    expect(await world.runTests()).toBe(1);

    // One request, to the Messages API, for a few tokens of the cheapest Claude.
    expect(world.claude.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /v1/messages',
    ]);
    const [sent] = world.claude.requests;
    expect(sent?.json).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
    });
    expect(sent?.headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);

    const [call] = await calls(dana);
    expect(call).toMatchObject({
      job: 'connection_test',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      key_source: 'own',
      status: 'ok',
      prompt_version: 'connection_test/1',
      attempt: 1,
      actor_kind: 'system',
    });
    const haiku = BUILT_IN_PRICES[priceKey('anthropic', 'claude-haiku-4-5-20251001')];
    if (call === undefined || haiku === undefined) throw new Error('No call, or no price.');
    const cost = microsToDollars(
      estimateCostMicros(
        {
          inputTokens: call.input_tokens,
          outputTokens: call.output_tokens,
          cacheReadTokens: call.cache_read_tokens,
          cacheWriteTokens: call.cache_write_tokens,
        },
        haiku.prices,
      ),
    );
    expect(call.output_tokens).toBe(15);
    expect(Number(cost)).toBeGreaterThan(0);
    expect(call.cost_estimate).toBe(cost);

    const finished = await readTest(dana, test.id);
    expect(finished).toMatchObject({
      id: test.id,
      connectionId: connection.id,
      kind: 'model_call',
      status: 'finished',
      outcome: 'ok',
      call: { costEstimate: cost },
    });
    expect(typeof finished.latencyMs).toBe('number');
    expect(finished.finishedAt).toBe('2026-10-10T09:00:02.000Z');

    const [after] = await list(dana);
    expect(after).toMatchObject({
      status: 'working',
      lastTest: { outcome: 'ok', at: '2026-10-10T09:00:02.000Z', latencyMs: finished.latencyMs },
    });
    // What was told to the logs: that a call was made, and nothing of the key.
    expect(world.events).toMatchObject([
      { type: 'request', job: 'connection_test', status: 'ok', keySource: 'own' },
    ]);
    expect(JSON.stringify(world.events)).not.toContain(FAKE_ANTHROPIC_KEY);
  });

  it.each([
    ['401', () => anthropicError(401, 'authentication_error'), 'authentication'],
    ['403', () => anthropicError(403, 'permission_error'), 'authentication'],
    ['402', () => anthropicError(402, 'billing_error'), 'billing'],
    ['404', () => anthropicError(404, 'not_found_error'), 'not_found'],
    ['400', () => anthropicError(400, 'invalid_request_error'), 'invalid_request'],
    ['429', () => anthropicError(429, 'rate_limit_error'), 'rate_limited'],
    [
      '429 and a wait',
      () => anthropicError(429, 'rate_limit_error', { 'retry-after': '1' }),
      'rate_limited',
    ],
    ['529', () => anthropicError(529, 'overloaded_error'), 'unavailable'],
    [
      'a stream that ends for a reason nobody documented',
      () => stream(fixture('anthropic', 'text.sse').replace('"end_turn"', '"brand_new_reason"')),
      'invalid_response',
    ],
  ] as const)(
    'says what is wrong, once, when the provider answers %s',
    async (_name, answer, outcome) => {
      const dana = await world.admin();
      const { test } = await connect(dana);
      world.claude.next(answer());
      await world.runTests();
      expect(await readTest(dana, test.id)).toMatchObject({ status: 'finished', outcome });
      expect((await list(dana))[0]).toMatchObject({ status: 'failing', lastTest: { outcome } });
      // A test is one request: a busy provider is not asked again, and no other model is.
      expect(world.claude.requests).toHaveLength(1);
      expect(await calls(dana)).toMatchObject([
        { job: 'connection_test', status: 'error', error_code: outcome, attempt: 1 },
      ]);
    },
  );

  it('reports a wrong key as a wrong key', async () => {
    const dana = await world.admin();
    const { test } = await connect(dana, {
      provider: 'anthropic',
      apiKey: 'sk-ant-not-the-right-key',
    });
    await world.runTests();
    expect(await readTest(dana, test.id)).toMatchObject({ outcome: 'authentication' });
  });

  it('calls a model server of the business’s own with the model it was given, at a cost nobody knows until it is priced', async () => {
    const dana = await world.admin();
    const { test } = await connect(dana, server());
    await world.runTests();
    expect(world.ollama.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /v1/chat/completions',
    ]);
    expect(world.ollama.requests[0]?.json).toMatchObject({
      model: 'fixture-model',
      max_tokens: 16,
    });
    expect(world.ollama.requests[0]?.headers.authorization).toBeUndefined();
    const finished = await readTest(dana, test.id);
    expect(finished).toMatchObject({ outcome: 'ok', call: { costEstimate: null } });
    expect(await calls(dana)).toMatchObject([
      { job: 'connection_test', provider: 'openai_compatible', status: 'ok', cost_estimate: null },
    ]);
  });

  it('calls OpenAI at OpenAI’s address with the model named when it was connected', async () => {
    const dana = await world.admin();
    const { connection, test } = await connect(dana, {
      provider: 'openai',
      apiKey: FAKE_OPENAI_KEY,
      model: 'gpt-fixture',
    });
    expect(connection).toMatchObject({ provider: 'openai', model: 'gpt-fixture', baseUrl: null });
    await world.runTests();
    expect(world.openai.requests[0]?.json).toMatchObject({
      model: 'gpt-fixture',
      max_completion_tokens: 16,
    });
    expect(await readTest(dana, test.id)).toMatchObject({ outcome: 'ok' });

    // The provider's own word for a model it does not have.
    world.openai.next(openAiError(404, 'invalid_request_error', 'model_not_found'));
    const again = await world.call(startAiConnectionTest, dana, {
      body: { connectionId: connection.id },
    });
    await world.runTests();
    expect(await readTest(dana, again.id)).toMatchObject({ outcome: 'not_found' });
  });

  it('is refused by the transport when a public-looking address turns out to be private', async () => {
    const dana = await world.admin();
    // https on the standard port passes the check of its shape; where it points is checked
    // when the worker connects.
    const { test } = await connect(dana, {
      provider: 'openai_compatible',
      baseUrl: 'https://127.0.0.1/v1',
      model: 'fixture-model',
    });
    await world.runTests();
    expect(await readTest(dana, test.id)).toMatchObject({ outcome: 'blocked_address' });
    expect(world.ollama.requests).toEqual([]);
  });

  it('asks the provider once however often "Test" is pressed while one is waiting', async () => {
    const dana = await world.admin();
    const { connection, test } = await connect(dana);
    const press = () =>
      world.call(startAiConnectionTest, dana, { body: { connectionId: connection.id } });
    expect((await press()).id).toBe(test.id);
    expect((await press()).id).toBe(test.id);
    expect(await world.runTests()).toBe(1);
    expect(world.claude.requests).toHaveLength(1);
    // Once it has ended, a press is a new test.
    const next = await press();
    expect(next.id).not.toBe(test.id);
    expect(await world.runTests()).toBe(1);
    expect(world.claude.requests).toHaveLength(2);
  });

  it('is shown as expired when no worker ran it in two minutes, and is then never run', async () => {
    const dana = await world.admin();
    const { test } = await connect(dana);
    world.clock.now = new Date(world.clock.now.getTime() + TEST_WINDOW_MS - 1);
    expect(await readTest(dana, test.id)).toMatchObject({ status: 'pending', outcome: null });
    world.clock.now = new Date(world.clock.now.getTime() + 1);
    expect(await readTest(dana, test.id)).toMatchObject({
      status: 'finished',
      outcome: 'expired',
      finishedAt: '2026-10-10T09:02:00.000Z',
    });
    // The worker comes back: the test is closed, and the provider is not asked.
    expect(await world.runTests()).toBe(1);
    expect(world.claude.requests).toEqual([]);
    expect(await calls(dana)).toEqual([]);
    expect(await readTest(dana, test.id)).toMatchObject({ status: 'finished', outcome: 'expired' });
    expect((await list(dana))[0]).toMatchObject({ status: 'untested', lastTest: null });
  });

  it('is not made once the month’s limit is reached, and says so without blaming the key', async () => {
    const dana = await world.admin();
    const { test } = await connect(dana);
    await setSettings(dana, { monthly_limit: '0', at_limit: 'pause' });
    await world.runTests();
    expect(await readTest(dana, test.id)).toMatchObject({
      outcome: 'limit_reached',
      latencyMs: null,
      call: null,
    });
    expect(world.claude.requests).toEqual([]);
    expect((await list(dana))[0]).toMatchObject({ status: 'untested', lastTest: null });
  });

  it('is not made for a model with no price while the limit pauses, until a price is entered', async () => {
    const dana = await world.admin();
    const { connection, test } = await connect(dana, server());
    await setSettings(dana, { monthly_limit: '50', at_limit: 'pause' });
    await world.runTests();
    expect(await readTest(dana, test.id)).toMatchObject({ outcome: 'price_unknown', call: null });
    expect(world.ollama.requests).toEqual([]);

    // The agency says what its own server costs: nothing.
    await world.database.withTenant(dana.context, (sql) =>
      sql.query(
        `insert into ai.model_prices (agency_id, provider, model, input_per_mtok, output_per_mtok,
                                      cache_read_per_mtok, cache_write_per_mtok, source, checked_on)
         values (app.agency_id(), 'openai_compatible', 'fixture-model', 0, 0, 0, 0, 'Our own server',
                 '2026-10-10')`,
      ),
    );
    const again = await world.call(startAiConnectionTest, dana, {
      body: { connectionId: connection.id },
    });
    await world.runTests();
    expect(await readTest(dana, again.id)).toMatchObject({
      outcome: 'ok',
      call: { costEstimate: '0.000000' },
    });
  });

  it('is not made while AI is turned off for the business', async () => {
    const dana = await world.admin();
    const { test } = await connect(dana);
    await setSettings(dana, { enabled: false });
    await world.runTests();
    expect(await readTest(dana, test.id)).toMatchObject({ outcome: 'ai_off', call: null });
    expect(world.claude.requests).toEqual([]);
  });

  it('says the key cannot be opened when the secret is not an AI key, and sends it nowhere', async () => {
    const dana = await world.admin();
    const { test } = await connect(dana);
    // A reference to another kind of secret: a mailbox's password named as an AI key.
    await world.database.as('crm_owner', (sql) =>
      sql.query(`update vault.secrets set purpose = 'mailbox.password' where business_id = $1`, [
        dana.context.businessId,
      ]),
    );
    await world.runTests();
    expect(await readTest(dana, test.id)).toMatchObject({ outcome: 'key_unreadable', call: null });
    expect(world.claude.requests).toEqual([]);
    expect((await list(dana))[0]).toMatchObject({
      status: 'failing',
      lastTest: { outcome: 'key_unreadable', latencyMs: null },
    });
  });

  it('is asked for by someone whose role allows it, of a connection they can see', async () => {
    const dana = await world.admin();
    const { connection } = await connect(dana);
    const body = { connectionId: connection.id };
    await expect(
      world.call(startAiConnectionTest, world.limited(dana, ['contacts.manage']), { body }),
    ).rejects.toMatchObject({ permission: 'ai.manage' });
    const stranger = await world.admin();
    await expect(world.call(startAiConnectionTest, stranger, { body })).rejects.toThrow(
      NotFoundError,
    );
    const sibling = await world.admin(dana.context.agencyId);
    await expect(world.call(startAiConnectionTest, sibling, { body })).rejects.toThrow(
      NotFoundError,
    );
    await world.runTests();
    expect(world.claude.requests).toHaveLength(1);
  });
});

describe('changing and removing a connection', () => {
  it('replaces the key, destroys the old one, and tests the new one', async () => {
    const dana = await world.admin();
    const { connection } = await connect(dana, {
      provider: 'anthropic',
      apiKey: 'sk-ant-the-old-key-0000',
    });
    await world.runTests();
    expect((await list(dana))[0]).toMatchObject({ status: 'failing', keyLast4: '0000' });
    const [before] = await secretRows(dana);

    world.claude.requests.length = 0;
    const saved = await world.call(updateAiConnection, dana, {
      params: { id: connection.id },
      body: { apiKey: FAKE_ANTHROPIC_KEY },
    });
    expect(saved.connection).toMatchObject({
      id: connection.id,
      keyLast4: FAKE_ANTHROPIC_KEY.slice(-4),
      // What was known of the old key says nothing of the new.
      status: 'untested',
      lastTest: null,
    });
    const secrets = await secretRows(dana);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.id).not.toBe(before?.id);
    expect(world.sealed.has(before?.id ?? '')).toBe(false);

    await world.runTests();
    expect(await readTest(dana, saved.test.id)).toMatchObject({ outcome: 'ok' });
    expect(world.claude.requests[0]?.headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
    const log = await written(dana.context.agencyId);
    expect(log).toContain('"key":"replaced"');
    expect(log).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(log).not.toContain('sk-ant-the-old-key-0000');
  });

  it('changes a model server’s model and address, and takes its key away when it needs none', async () => {
    const dana = await world.admin();
    const { connection } = await connect(dana, { ...server(), apiKey: FAKE_OPENAI_KEY });
    const [sealedBefore] = await secretRows(dana);
    expect(world.sealed.get(sealedBefore?.id ?? '')).toBe(FAKE_OPENAI_KEY);
    const saved = await world.call(updateAiConnection, dana, {
      params: { id: connection.id },
      body: { apiKey: null, model: 'another-model' },
    });
    expect(saved.connection).toMatchObject({
      hasKey: false,
      keyLast4: null,
      model: 'another-model',
    });
    expect(await secretRows(dana)).toEqual([]);
    expect(world.sealed.has(sealedBefore?.id ?? '')).toBe(false);
  });

  it.each([
    [
      'an address for a provider whose address is fixed',
      claudeKey,
      { baseUrl: 'https://elsewhere.example/v1' },
      '/baseUrl',
      'not_for_provider',
    ],
    [
      'no key for a provider that needs one',
      claudeKey,
      { apiKey: null },
      '/apiKey',
      'key_required',
    ],
    [
      'a model on Claude’s connection',
      claudeKey,
      { model: 'claude-opus-5-5' },
      '/model',
      'not_for_provider',
    ],
  ])('refuses %s', async (_name, first, changes, path, code) => {
    const dana = await world.admin();
    const { connection } = await connect(dana, first);
    await expect(
      world.call(updateAiConnection, dana, { params: { id: connection.id }, body: changes }),
    ).rejects.toMatchObject({ issues: [{ path, code }] });
    // A key that went to Anthropic's address still would: the row is as it was.
    expect((await keyRows(dana))[0]).toMatchObject({ base_url: null, default_model: null });
    expect(await secretRows(dana)).toHaveLength(1);
  });

  it('removes a connection with its key and its tests', async () => {
    const dana = await world.admin();
    const { connection, test } = await connect(dana);
    await world.runTests();
    const [sealedBefore] = await secretRows(dana);
    expect(world.sealed.get(sealedBefore?.id ?? '')).toBe(FAKE_ANTHROPIC_KEY);
    await world.call(removeAiConnection, dana, { params: { id: connection.id } });
    expect(await list(dana)).toEqual([]);
    expect(await keyRows(dana)).toEqual([]);
    expect(await secretRows(dana)).toEqual([]);
    expect(world.sealed.has(sealedBefore?.id ?? '')).toBe(false);
    await expect(readTest(dana, test.id)).rejects.toThrow(NotFoundError);
    // The call the test made stays on the month's record.
    expect(await calls(dana)).toHaveLength(1);
    await expect(
      world.call(removeAiConnection, dana, { params: { id: connection.id } }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('the agency’s connections and a business’s', () => {
  it('are each managed where they are owned; a business sees its agency’s without its details', async () => {
    const dana = await world.admin();
    const agency = await world.agencyAdmin(dana.context.agencyId);
    const shared = await connect(agency, { ...server(), apiKey: FAKE_OPENAI_KEY });
    expect(shared.connection).toMatchObject({
      owner: 'agency',
      canManage: true,
      baseUrl: `${world.ollama.origin}/v1`,
      keyLast4: FAKE_OPENAI_KEY.slice(-4),
      addedBy: agency.name,
    });
    const own = await connect(dana);

    // The business: its own first, then the agency's with nothing but what choosing needs.
    expect(await list(dana)).toMatchObject([
      { id: own.connection.id, owner: 'business', canManage: true, addedBy: dana.name },
      {
        id: shared.connection.id,
        owner: 'agency',
        canManage: false,
        provider: 'openai_compatible',
        model: 'fixture-model',
        hasKey: true,
        keyLast4: null,
        baseUrl: null,
        addedBy: null,
      },
    ]);
    // The agency, outside any business: its own only, though row-level security would
    // show it every business's.
    expect((await list(agency)).map((each) => each.id)).toEqual([shared.connection.id]);

    // Neither can change the other's.
    const agencys = { id: shared.connection.id };
    await expect(
      world.call(updateAiConnection, dana, { params: agencys, body: { model: 'x' } }),
    ).rejects.toThrow(ForbiddenError);
    await expect(world.call(removeAiConnection, dana, { params: agencys })).rejects.toThrow(
      'This connection is the agency’s. It is changed in the agency’s own settings.',
    );
    await expect(
      world.call(updateAiConnection, agency, {
        params: { id: own.connection.id },
        body: { apiKey: 'sk-ant-someone-elses' },
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      world.call(removeAiConnection, agency, { params: { id: own.connection.id } }),
    ).rejects.toThrow(NotFoundError);
    expect(await keyRows(dana)).toHaveLength(1);
    expect(await keyRows(agency)).toHaveLength(1);
  });

  it('keeps one business’s connections and tests from its sibling and from another agency', async () => {
    const dana = await world.admin();
    const sibling = await world.admin(dana.context.agencyId);
    const stranger = await world.admin();
    const { connection, test } = await connect(dana);
    for (const other of [sibling, stranger]) {
      expect(await list(other)).toEqual([]);
      await expect(readTest(other, test.id)).rejects.toThrow(NotFoundError);
      await expect(
        world.call(updateAiConnection, other, {
          params: { id: connection.id },
          body: { apiKey: 'sk-ant-someone-elses' },
        }),
      ).rejects.toThrow(NotFoundError);
      await expect(
        world.call(removeAiConnection, other, { params: { id: connection.id } }),
      ).rejects.toThrow(NotFoundError);
    }
    // Another agency's staff, at their own agency, see nothing either.
    const theirs = await world.agencyAdmin(stranger.context.agencyId);
    expect(await list(theirs)).toEqual([]);
    await expect(readTest(theirs, test.id)).rejects.toThrow(NotFoundError);
    expect(world.sealed.get((await secretRows(dana))[0]?.id ?? '')).toBe(FAKE_ANTHROPIC_KEY);
  });

  it('tests an agency’s connection in a business with a call on that business’s record', async () => {
    const dana = await world.admin();
    const agency = await world.agencyAdmin(dana.context.agencyId);
    const shared = await connect(agency);
    // The agency's own test of it comes first, and is not this test's concern.
    await world.runTests();
    world.claude.requests.length = 0;

    const test = await world.call(startAiConnectionTest, dana, {
      body: { connectionId: shared.connection.id },
    });
    expect(test).toMatchObject({ kind: 'model_call', status: 'pending' });
    await world.runTests();
    expect(await readTest(dana, test.id)).toMatchObject({ outcome: 'ok' });
    expect(await calls(dana)).toMatchObject([
      { job: 'connection_test', key_source: 'agency', status: 'ok' },
    ]);
    // The agency cannot read the business's test; it sees what it found on the connection.
    await expect(readTest(agency, test.id)).rejects.toThrow(NotFoundError);
    expect((await list(agency))[0]).toMatchObject({ status: 'working' });
  });
});

describe('testing a connection at the agency', () => {
  it('asks the provider whether it takes the key, calls no model, and puts no call on any record', async () => {
    const dana = await world.admin();
    const agency = await world.agencyAdmin(dana.context.agencyId);
    const { connection, test } = await connect(agency);
    expect(test).toMatchObject({ kind: 'key_check', status: 'pending' });
    world.clock.now = new Date('2026-10-10T09:00:03.000Z');
    expect(await world.runTests()).toBe(1);
    expect(world.claude.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/models?limit=1000',
    ]);
    const finished = await readTest(agency, test.id);
    expect(finished).toMatchObject({
      connectionId: connection.id,
      kind: 'key_check',
      status: 'finished',
      outcome: 'ok',
      call: null,
    });
    expect(typeof finished.latencyMs).toBe('number');
    expect((await list(agency))[0]).toMatchObject({
      status: 'working',
      lastTest: { outcome: 'ok' },
    });
    // No call is on any business's record.
    expect(
      await world.database.as('crm_owner', (sql) =>
        sql.query(
          `select 1 from ai.requests r join tenancy.businesses b on b.id = r.business_id
           where b.agency_id = $1`,
          [agency.context.agencyId],
        ),
      ),
    ).toEqual([]);
    expect(world.events).toMatchObject([
      { type: 'key_check', provider: 'anthropic', status: 'ok', businessId: null },
    ]);
    // A business of the agency cannot read the agency's test.
    await expect(readTest(dana, test.id)).rejects.toThrow(NotFoundError);
  });

  it('says a wrong key is wrong, and a server that is not there is not there', async () => {
    const agency = await world.agencyAdmin((await world.database.fixtures.agency()).id);
    const wrong = await connect(agency, {
      provider: 'anthropic',
      apiKey: 'sk-ant-not-the-right-key',
    });
    await world.runTests();
    expect(await readTest(agency, wrong.test.id)).toMatchObject({
      outcome: 'authentication',
      call: null,
    });
    expect((await list(agency))[0]).toMatchObject({
      status: 'failing',
      lastTest: { outcome: 'authentication' },
    });
    expect(world.events).toMatchObject([
      { type: 'key_check', status: 'error', errorCode: 'authentication' },
    ]);

    // Nothing listens on port 9 of a public-looking address that is this machine.
    const gone = await connect(agency, {
      provider: 'openai_compatible',
      baseUrl: 'https://127.0.0.1/v1',
      model: 'm',
    });
    await world.runTests();
    expect(await readTest(agency, gone.test.id)).toMatchObject({ outcome: 'blocked_address' });
  });

  it('cannot be reached from a business: a business’s test always calls a model', async () => {
    const dana = await world.admin();
    const { test } = await connect(dana);
    await world.runTests();
    expect(await readTest(dana, test.id)).toMatchObject({ kind: 'model_call' });
    expect(world.claude.requests.map((request) => request.method)).toEqual(['POST']);
    expect(world.events.map((event) => event.type)).toEqual(['request']);
  });
});
