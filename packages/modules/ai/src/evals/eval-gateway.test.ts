// The eval gateway against the module's local stand-ins, over real sockets on loopback.
// Nothing here reaches a real provider, and every key is made up.
import { afterEach, describe, expect, it } from 'vitest';

import {
  anthropicError,
  FAKE_ANTHROPIC_KEY,
  startFakeAnthropic,
} from '../../test/fake-anthropic.js';
import { FAKE_OPENAI_KEY, openAiError, startFakeOpenAi } from '../../test/fake-openai.js';
import { fixture, json, stream, type FakeProvider } from '../../test/fake-provider.js';
import { parseLocalServers } from '../addresses.js';
import type { GatewayRequest, GatewayResult } from '../gateway.js';
import {
  BUILT_IN_PRICES,
  dollarsToMicros,
  estimateCostMicros,
  microsToDollars,
  priceKey,
  worstCaseMicros,
} from '../pricing.js';
import type { ModelPrices } from '../provider.js';
import { AiTransportError, type AiHttpCall, type AiTransport } from '../transport.js';
import {
  createEvalGateway,
  EvalConfigError,
  type EvalGatewayOptions,
  type LiveSession,
} from './eval-gateway.js';
import { fixtureSuite } from './fixtures/suite.js';
import { requestHash } from './recording.js';
import { EVAL_CONTEXT, runSuite } from './runner.js';
import type { EvalSuite } from './types.js';

const SONNET = 'claude-sonnet-5-5';
const fakes: FakeProvider[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

async function anthropic(): Promise<FakeProvider> {
  const fake = await startFakeAnthropic();
  fakes.push(fake);
  return fake;
}
async function openAi(apiKey: string | null = FAKE_OPENAI_KEY): Promise<FakeProvider> {
  const fake = await startFakeOpenAi(apiKey);
  fakes.push(fake);
  return fake;
}

function sonnetPrices(): ModelPrices {
  const found = BUILT_IN_PRICES[priceKey('anthropic', SONNET)];
  if (found === undefined) throw new Error('The model has no built-in price.');
  return found.prices;
}
const FREE: ModelPrices = { input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n };
const SOME: ModelPrices = {
  input: dollarsToMicros('3'),
  output: dollarsToMicros('12'),
  cacheRead: dollarsToMicros('3'),
  cacheWrite: dollarsToMicros('3'),
};

const request = (text = 'Hi there'): GatewayRequest => ({
  job: 'replies',
  promptVersion: 'fixture/1',
  system: 'Greet the person in one short line.',
  messages: [{ role: 'user', text }],
  maxOutputTokens: 64,
});
const bytesOf = (sent: GatewayRequest): number =>
  Buffer.byteLength(JSON.stringify([sent.system, sent.messages, sent.tools ?? []]));

/** A gateway for Claude, pointed at the stand-in the way a test's composition may. */
function toAnthropic(
  fake: FakeProvider,
  options: Partial<EvalGatewayOptions> = {},
): { session: LiveSession; waits: number[] } {
  const waits: number[] = [];
  const session = createEvalGateway({
    provider: 'anthropic',
    model: SONNET,
    budgetMicros: dollarsToMicros('1'),
    apiKey: FAKE_ANTHROPIC_KEY,
    baseUrls: { anthropic: fake.origin },
    localServers: parseLocalServers(fake.hostPort),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  return { session, waits };
}

async function ask(
  session: LiveSession,
  sent = request(),
  caseId = 'greets',
): Promise<GatewayResult> {
  session.begin(caseId);
  return session.generate(EVAL_CONTEXT, sent);
}

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof EvalConfigError) return error.message;
    throw error;
  }
  throw new Error('Expected the gateway to be refused.');
}

describe('a call through the eval gateway', () => {
  it('reaches the one model it was made for, and hands back the answer as the gateway would', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake);
    const result = await ask(session);
    expect(result).toMatchObject({
      outcome: 'ok',
      text: 'Hello!',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'end',
      provider: 'anthropic',
      model: SONNET,
      usedBackup: false,
      requestId: 'eval-greets-1',
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
    expect(fake.requests[0]?.json).toMatchObject({ model: SONNET, max_tokens: 64 });
  });

  it('prices each call with the price table, to the millionth of a dollar', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake);
    const first = await ask(session);
    const second = await session.generate(EVAL_CONTEXT, request('Good morning'));
    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('Expected two answers.');
    if (first.usage === null || second.usage === null) throw new Error('Expected usage.');
    // The stand-in reports the system prompt as a cache write, then as a cache read.
    expect(first.usage.cacheWriteTokens).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens).toBe(first.usage.cacheWriteTokens);
    const costs = [first.usage, second.usage].map((usage) =>
      estimateCostMicros(usage, sonnetPrices()),
    );
    expect(first.costMicros).toBe(costs[0]);
    expect(second.costMicros).toBe(costs[1]);
    expect(first.costMicros).toBeGreaterThan(0n);

    const trace = session.end();
    expect(trace.stale).toBe(false);
    expect(trace.calls.map((call) => call.cost)).toEqual(costs.map(microsToDollars));
    expect(trace.calls.map((call) => call.usage)).toEqual([first.usage, second.usage]);
    expect(trace.calls.map((call) => call.attempts)).toEqual([1, 1]);
    expect(trace.costMicros).toBe((costs[0] ?? 0n) + (costs[1] ?? 0n));
    expect(session.spentMicros()).toBe(trace.costMicros);
  });

  it('records each call of a case in order: the hash of what was asked, and the answer', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake);
    await ask(session, request('one'), 'first');
    await session.generate(EVAL_CONTEXT, request('two'));
    const first = session.end();
    await ask(session, request('three'), 'second');
    const second = session.end();
    expect(first.calls.map((call) => call.request)).toEqual([
      requestHash(request('one')),
      requestHash(request('two')),
    ]);
    expect(second.calls.map((call) => call.request)).toEqual([requestHash(request('three'))]);
    expect(first.calls[0]?.result).toEqual({
      outcome: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'end',
    });
    expect(
      JSON.stringify([first, second], (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain(FAKE_ANTHROPIC_KEY);
  });

  it("records a refusal as the model's answer", async () => {
    const fake = await anthropic();
    fake.next(stream(fixture('anthropic', 'refusal.sse')));
    const { session } = toAnthropic(fake);
    const result = await ask(session);
    expect(result.outcome).toBe('refused');
    expect(session.end().calls[0]?.result.outcome).toBe('refused');
  });

  it("carries tool calls and the model's own thinking, so a tool loop can be replayed", async () => {
    const fake = await anthropic();
    fake.next(stream(fixture('anthropic', 'tool-use.sse')));
    const { session } = toAnthropic(fake);
    const result = await ask(session);
    if (result.outcome !== 'ok') throw new Error('Expected an answer.');
    expect(result.stop).toBe('tool_calls');
    expect(result.parts.map((part) => part.type)).toEqual([
      'reasoning',
      'text',
      'tool_call',
      'tool_call',
    ]);
    const [call] = session.end().calls;
    expect(call?.result).toMatchObject({ outcome: 'ok', stop: 'tool_calls', parts: result.parts });
  });

  it('refuses to be used outside a case, and calls nobody once it was stopped', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake);
    await expect(session.generate(EVAL_CONTEXT, request())).rejects.toThrow(
      'The eval gateway was called outside a case.',
    );
    session.begin('greets');
    session.stop();
    expect(await session.generate(EVAL_CONTEXT, request())).toEqual({ outcome: 'off' });
    expect(fake.requests).toHaveLength(0);
    expect(session.end().calls).toEqual([]);
  });

  it('refuses a request no model could be held to: a token limit that is not a count', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake);
    session.begin('greets');
    await expect(
      session.generate(EVAL_CONTEXT, { ...request(), maxOutputTokens: 0 }),
    ).rejects.toThrow(RangeError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('the budget cap', () => {
  it('stops before the call that would pass it, and calls nobody', async () => {
    const fake = await anthropic();
    const worst = worstCaseMicros(bytesOf(request()), 64, sonnetPrices());
    // Room for exactly one call at its worst case.
    const { session } = toAnthropic(fake, { budgetMicros: worst });
    const first = await ask(session);
    expect(first.outcome).toBe('ok');
    const second = await session.generate(EVAL_CONTEXT, request());
    expect(second).toEqual({ outcome: 'paused', reason: 'limit_reached' });
    expect(fake.requests).toHaveLength(1);
    const trace = session.end();
    expect(trace.calls.map((call) => call.result.outcome)).toEqual(['ok', 'paused']);
    expect(trace.calls[1]).toMatchObject({ attempts: 0, usage: null, cost: null });
    expect(session.spentMicros()).toBeLessThanOrEqual(worst);
  });

  it('admits a call that fits exactly, and none when even the first would pass it', async () => {
    const fake = await anthropic();
    const worst = worstCaseMicros(bytesOf(request()), 64, sonnetPrices());
    const tight = toAnthropic(fake, { budgetMicros: worst - 1n }).session;
    expect(await ask(tight)).toEqual({ outcome: 'paused', reason: 'limit_reached' });
    expect(fake.requests).toHaveLength(0);
    expect(tight.spentMicros()).toBe(0n);
  });

  it('counts a call whose usage nobody reported at its worst case', async () => {
    const fake = await openAi(null);
    const completion = JSON.parse(fixture('openai', 'chat-completion.json')) as Record<
      string,
      unknown
    >;
    fake.next(json(200, { ...completion, usage: undefined }));
    const session = createEvalGateway({
      provider: 'openai_compatible',
      model: 'fixture-model',
      budgetMicros: dollarsToMicros('1'),
      baseUrl: `${fake.origin}/v1`,
      localServers: parseLocalServers(fake.hostPort),
      prices: SOME,
    });
    const result = await ask(session);
    expect(result).toMatchObject({ outcome: 'ok', usage: null, costMicros: null });
    expect(session.spentMicros()).toBe(worstCaseMicros(bytesOf(request()), 64, SOME));
    expect(session.end().calls[0]).toMatchObject({ usage: null, cost: null });
  });

  it('runs a model that costs nothing under a budget of nothing', async () => {
    const fake = await openAi(null);
    const session = createEvalGateway({
      provider: 'openai_compatible',
      model: 'fixture-model',
      budgetMicros: 0n,
      baseUrl: `${fake.origin}/v1`,
      localServers: parseLocalServers(fake.hostPort),
      prices: FREE,
    });
    const result = await ask(session);
    expect(result).toMatchObject({ outcome: 'ok', text: 'Hello!', costMicros: 0n });
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    expect(fake.requests[0]?.json).toMatchObject({ model: 'fixture-model', max_tokens: 64 });
    expect(session.end().calls[0]?.cost).toBe('0.000000');
  });
});

describe('a model with no known price', () => {
  it('is refused before anything runs, since no cap could hold it', () => {
    expect(
      refusal(() =>
        createEvalGateway({
          provider: 'openai',
          model: 'gpt-fixture',
          budgetMicros: dollarsToMicros('1'),
          apiKey: FAKE_OPENAI_KEY,
        }),
      ),
    ).toBe(
      'No price is known for openai/gpt-fixture. Give --price-input and --price-output (US dollars for a million tokens); without them the run cannot be held to its budget.',
    );
  });

  it("runs once its price is given, at OpenAI's own name for the token limit", async () => {
    const fake = await openAi();
    const session = createEvalGateway({
      provider: 'openai',
      model: 'gpt-fixture',
      budgetMicros: dollarsToMicros('1'),
      apiKey: FAKE_OPENAI_KEY,
      prices: SOME,
      baseUrls: { openai: `${fake.origin}/v1` },
      localServers: parseLocalServers(fake.hostPort),
    });
    const result = await ask(session);
    if (result.outcome !== 'ok' || result.usage === null) throw new Error('Expected an answer.');
    expect(result.costMicros).toBe(estimateCostMicros(result.usage, SOME));
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${FAKE_OPENAI_KEY}`);
    expect(fake.requests[0]?.json).toMatchObject({ max_completion_tokens: 64 });
  });

  it('cannot be given a price of its own when the price is built in', () => {
    expect(
      refusal(() =>
        createEvalGateway({
          provider: 'anthropic',
          model: SONNET,
          budgetMicros: 0n,
          apiKey: FAKE_ANTHROPIC_KEY,
          prices: FREE,
        }),
      ),
    ).toBe(
      'The price of anthropic/claude-sonnet-5-5 is built in (src/pricing.ts) and cannot be given on the command line.',
    );
  });
});

describe('what the eval gateway refuses to be made with', () => {
  it.each<[string, Partial<EvalGatewayOptions>, string]>([
    [
      'no key for a hosted provider',
      { apiKey: undefined },
      'EVAL_API_KEY is not set: anthropic needs a key.',
    ],
    ['an empty key', { apiKey: '' }, 'EVAL_API_KEY is not set: anthropic needs a key.'],
    [
      'an address for a hosted provider',
      { baseUrl: 'https://example.com/v1' },
      '--base-url is only for openai_compatible: anthropic is called at its own address.',
    ],
    [
      'no address for a model server',
      { provider: 'openai_compatible', model: 'm', prices: FREE },
      'openai_compatible needs --base-url, the address of the model server.',
    ],
    [
      'a model id that is not one',
      { model: 'claude sonnet' },
      "The model's id must be 1 to 200 of",
    ],
    ['a model id with a quote', { model: "claude'" }, "The model's id must be 1 to 200 of"],
    ['a budget below nothing', { budgetMicros: -1n }, 'The budget must be an amount from 0.'],
    [
      'a negative price',
      { provider: 'openai', model: 'gpt-fixture', prices: { ...SOME, output: -1n } },
      'A price must be an amount from 0.',
    ],
  ])('%s', (_name, options, message) => {
    expect(
      refusal(() =>
        createEvalGateway({
          provider: 'anthropic',
          model: SONNET,
          budgetMicros: dollarsToMicros('1'),
          apiKey: FAKE_ANTHROPIC_KEY,
          ...options,
        }),
      ),
    ).toContain(message);
  });
});

describe('the address rule', () => {
  it('refuses a model server on a private address until the person running names it', async () => {
    const fake = await openAi(null);
    const options: EvalGatewayOptions = {
      provider: 'openai_compatible',
      model: 'fixture-model',
      budgetMicros: 0n,
      baseUrl: `${fake.origin}/v1`,
      prices: FREE,
    };
    const said = refusal(() => createEvalGateway(options));
    expect(said).toBe(
      'The address is not one this run may call (not_https). A model server on a private address or on plain http must be named with --local-server host:port.',
    );
    expect(said).not.toContain('127.0.0.1');
    expect(fake.requests).toHaveLength(0);

    const listed = createEvalGateway({
      ...options,
      localServers: parseLocalServers(fake.hostPort),
    });
    expect((await ask(listed)).outcome).toBe('ok');
    expect(fake.requests).toHaveLength(1);
  });

  it('refuses an address with a query, a port of its own, or a name and password', () => {
    for (const [baseUrl, reason] of [
      ['https://example.com/v1?key=1', 'has_query'],
      ['https://example.com:8443/v1', 'port_not_allowed'],
      ['https://user:pass@example.com/v1', 'has_credentials'],
      ['not an address', 'not_a_url'],
    ] as const)
      expect(
        refusal(() =>
          createEvalGateway({
            provider: 'openai_compatible',
            model: 'm',
            budgetMicros: 0n,
            baseUrl,
            prices: FREE,
          }),
        ),
      ).toContain(`(${reason})`);
  });

  it('is kept by the transport too: an unlisted stand-in is never connected to', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake, { localServers: [] });
    const result = await ask(session);
    expect(result).toEqual({
      outcome: 'failed',
      code: 'blocked_address',
      requestId: 'eval-greets-1',
    });
    expect(fake.requests).toHaveLength(0);
    // Nothing left this machine, so nothing is counted against the budget.
    expect(session.spentMicros()).toBe(0n);
    expect(session.end().calls[0]).toMatchObject({
      attempts: 1,
      result: { outcome: 'failed', code: 'blocked_address' },
    });
  });
});

describe('a busy provider', () => {
  const busy = (seconds?: string) =>
    anthropicError(
      529,
      'overloaded_error',
      seconds === undefined ? {} : { 'retry-after': seconds },
    );

  it('is asked again after the wait it named', async () => {
    const fake = await anthropic();
    fake.next(busy('2'));
    const { session, waits } = toAnthropic(fake);
    const result = await ask(session);
    expect(result.outcome).toBe('ok');
    expect(waits).toEqual([2000]);
    expect(fake.requests).toHaveLength(2);
    expect(session.end().calls).toMatchObject([{ attempts: 2, result: { outcome: 'ok' } }]);
  });

  it('is asked at most twice more, then the call has failed', async () => {
    const fake = await anthropic();
    for (let index = 0; index < 4; index += 1) fake.next(busy());
    const { session, waits } = toAnthropic(fake);
    const result = await ask(session);
    expect(result).toMatchObject({ outcome: 'failed', code: 'unavailable' });
    // With no wait named: one second, then two.
    expect(waits).toEqual([1000, 2000]);
    expect(fake.requests).toHaveLength(3);
    expect(session.end().calls).toMatchObject([{ attempts: 3, result: { outcome: 'failed' } }]);
  });

  it('is asked again after a rate limit that names a wait of at most thirty seconds', async () => {
    const fake = await anthropic();
    fake.next(anthropicError(429, 'rate_limit_error', { 'retry-after': '30' }));
    const { session, waits } = toAnthropic(fake);
    expect((await ask(session)).outcome).toBe('ok');
    expect(waits).toEqual([30_000]);
  });

  it.each([
    [
      'a rate limit that names a longer wait',
      anthropicError(429, 'rate_limit_error', { 'retry-after': '31' }),
      'rate_limited',
    ],
    ['a rate limit that names no wait', anthropicError(429, 'rate_limit_error'), 'rate_limited'],
    ['an overloaded server that names a longer wait', busy('31'), 'unavailable'],
    ['a refused key', anthropicError(401, 'authentication_error'), 'authentication'],
    ['a refused request', anthropicError(400, 'invalid_request_error'), 'invalid_request'],
  ])('is not asked again after %s', async (_name, answer, code) => {
    const fake = await anthropic();
    fake.next(answer);
    const { session, waits } = toAnthropic(fake);
    expect(await ask(session)).toMatchObject({ outcome: 'failed', code });
    expect(waits).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  it('is not asked again once the handle was stopped while it waited', async () => {
    const fake = await anthropic();
    fake.next(busy('1'));
    const session = createEvalGateway({
      provider: 'anthropic',
      model: SONNET,
      budgetMicros: dollarsToMicros('1'),
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrls: { anthropic: fake.origin },
      localServers: parseLocalServers(fake.hostPort),
      sleep: () => {
        session.stop();
        return Promise.resolve();
      },
    });
    expect(await ask(session)).toEqual({ outcome: 'off' });
    expect(fake.requests).toHaveLength(1);
    // What the first attempt may have cost stays counted.
    expect(session.spentMicros()).toBeGreaterThan(0n);
  });

  it('keeps what a case recorded as it was when the case ended', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake);
    session.begin('first');
    const late = session.generate(EVAL_CONTEXT, request());
    const trace = session.end();
    await late;
    expect(trace.calls).toEqual([]);
    expect(session.end().calls).toEqual([]);
  });

  it('holds each further attempt to the budget as well', async () => {
    const fake = await anthropic();
    fake.next(busy('1'));
    const worst = worstCaseMicros(bytesOf(request()), 64, sonnetPrices());
    // The failed attempt reported no usage, so it is counted at its worst case.
    const { session } = toAnthropic(fake, { budgetMicros: worst });
    expect(await ask(session)).toEqual({ outcome: 'paused', reason: 'limit_reached' });
    expect(fake.requests).toHaveLength(1);
    expect(session.end().calls[0]).toMatchObject({ attempts: 1 });
  });

  it('ends a call that outlasts its deadline as a timeout', async () => {
    const fake = await anthropic();
    fake.next({ status: 200, headers: { 'content-type': 'text/event-stream' }, then: 'hang' });
    const { session } = toAnthropic(fake, { callTimeoutMs: 200 });
    expect(await ask(session)).toMatchObject({ outcome: 'failed', code: 'timeout' });
  });
});

describe('masking', () => {
  const withDetails = request('Write to me at amina@example.com or 0712 345 678');

  it('hides phone numbers and email addresses from the provider when asked', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake, { mask: true });
    await ask(session, withDetails);
    expect(fake.requests[0]?.body).toContain('[email]');
    expect(fake.requests[0]?.body).toContain('[phone]');
    expect(fake.requests[0]?.body).not.toContain('amina@example.com');
    // The recording is keyed on what the suite asked, so a replay needs no masking.
    expect(session.end().calls[0]?.request).toBe(requestHash(withDetails));
  });

  it('sends everything as written otherwise', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake);
    await ask(session, withDetails);
    expect(fake.requests[0]?.body).toContain('amina@example.com');
  });
});

describe('a caller that listens for text', () => {
  it('hears it as it arrives', async () => {
    const fake = await openAi(null);
    const session = createEvalGateway({
      provider: 'openai_compatible',
      model: 'fixture-model',
      budgetMicros: 0n,
      baseUrl: `${fake.origin}/v1`,
      localServers: parseLocalServers(fake.hostPort),
      prices: FREE,
    });
    session.begin('greets');
    const heard: string[] = [];
    const result = await session.generate(EVAL_CONTEXT, request(), {
      onTextDelta: (text) => heard.push(text),
    });
    expect(result.outcome).toBe('ok');
    expect(heard.join('')).toBe(result.outcome === 'ok' ? result.text : '');
    expect(fake.requests[0]?.json).toMatchObject({ stream: true });
  });

  it('an error from the hosted stand-in for OpenAI is a failure of the call', async () => {
    const fake = await openAi();
    fake.next(openAiError(500, 'server_error'));
    fake.next(openAiError(500, 'server_error'));
    fake.next(openAiError(500, 'server_error'));
    const session = createEvalGateway({
      provider: 'openai',
      model: 'gpt-fixture',
      budgetMicros: dollarsToMicros('1'),
      apiKey: FAKE_OPENAI_KEY,
      prices: SOME,
      baseUrls: { openai: `${fake.origin}/v1` },
      localServers: parseLocalServers(fake.hostPort),
      sleep: () => Promise.resolve(),
    });
    expect(await ask(session)).toMatchObject({ outcome: 'failed', code: 'unavailable' });
  });
});

describe('where a call goes', () => {
  /** Stands in for the network: keeps where each call was sent, and answers none. */
  function unreachable(): { transport: AiTransport; calls: AiHttpCall[] } {
    const calls: AiHttpCall[] = [];
    return {
      calls,
      transport: (call) => {
        calls.push(call);
        return Promise.reject(new AiTransportError('timeout'));
      },
    };
  }

  it("is the provider's own address for a hosted provider, with the key in its own header", async () => {
    const claude = unreachable();
    const toClaude = createEvalGateway({
      provider: 'anthropic',
      model: SONNET,
      budgetMicros: dollarsToMicros('1'),
      apiKey: FAKE_ANTHROPIC_KEY,
      transport: claude.transport,
    });
    expect(await ask(toClaude)).toMatchObject({ outcome: 'failed', code: 'timeout' });
    expect(claude.calls.map((call) => call.url)).toEqual(['https://api.anthropic.com/v1/messages']);
    expect(claude.calls[0]?.headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);

    const openAiCalls = unreachable();
    const toOpenAi = createEvalGateway({
      provider: 'openai',
      model: 'gpt-fixture',
      budgetMicros: dollarsToMicros('1'),
      apiKey: FAKE_OPENAI_KEY,
      prices: SOME,
      transport: openAiCalls.transport,
    });
    await ask(toOpenAi);
    expect(openAiCalls.calls.map((call) => call.url)).toEqual([
      'https://api.openai.com/v1/chat/completions',
    ]);
    expect(openAiCalls.calls[0]?.headers['authorization']).toBe(`Bearer ${FAKE_OPENAI_KEY}`);
  });

  it('is the model server named, with its key when it asks for one', async () => {
    const fake = await openAi();
    const session = createEvalGateway({
      provider: 'openai_compatible',
      model: 'fixture-model',
      budgetMicros: 0n,
      apiKey: FAKE_OPENAI_KEY,
      baseUrl: `${fake.origin}/v1`,
      localServers: parseLocalServers(fake.hostPort),
      prices: FREE,
    });
    expect((await ask(session)).outcome).toBe('ok');
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${FAKE_OPENAI_KEY}`);
  });

  it('carries the tools a suite offers', async () => {
    const fake = await anthropic();
    const { session } = toAnthropic(fake);
    const tools = [
      { name: 'find_contacts', description: 'Finds contacts.', inputSchema: { type: 'object' } },
    ];
    await ask(session, { ...request(), tools });
    expect(fake.requests[0]?.json).toMatchObject({ tools: [{ name: 'find_contacts' }] });
    expect(session.end().calls[0]?.request).toBe(requestHash({ ...request(), tools }));
  });

  it('waits by the clock when no test stands in for it', async () => {
    const fake = await anthropic();
    fake.next(anthropicError(529, 'overloaded_error', { 'retry-after': '0' }));
    const session = createEvalGateway({
      provider: 'anthropic',
      model: SONNET,
      budgetMicros: dollarsToMicros('1'),
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrls: { anthropic: fake.origin },
      localServers: parseLocalServers(fake.hostPort),
    });
    expect((await ask(session)).outcome).toBe('ok');
    expect(fake.requests).toHaveLength(2);
  });
});

describe('a suite that reads tool calls', () => {
  it('is scored on the tools the model asked for', async () => {
    const fake = await anthropic();
    fake.next(stream(fixture('anthropic', 'tool-use.sse')));
    const { session } = toAnthropic(fake);
    const suite: EvalSuite = {
      ...fixtureSuite({ threshold: 1 }),
      cases: [
        {
          id: 'looks-it-up',
          input: { message: 'Who asked about a wedding in June?' },
          expect: [
            { type: 'tool_called', name: 'find_contacts', input: { limit: 5 } },
            { type: 'tool_called', name: 'count_deals' },
            { type: 'equals', path: 'stop', value: 'tool_calls' },
            { type: 'length_at_most', path: 'toolCalls', value: 2 },
          ],
        },
      ],
    };
    const result = await runSuite(suite, session);
    expect(result).toMatchObject({ passed: 1, total: 1, pass: true });
    expect(result.cases[0]?.output).toMatchObject({
      toolCalls: [
        { name: 'find_contacts', input: { query: 'wedding in June', limit: 5 } },
        { name: 'count_deals', input: {} },
      ],
    });
  });
});
