// The Claude adapter, over a real socket to a local stand-in that replays fixtures written
// from Anthropic's documentation (src/fixtures/anthropic). No test calls Anthropic.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { anthropicError, FAKE_ANTHROPIC_KEY, startFakeAnthropic } from '../test/fake-anthropic.js';
import { fixture, stream, type FakeProvider } from '../test/fake-provider.js';
import { parseLocalServers } from './addresses.js';
import { ANTHROPIC_VERSION, createAnthropicProvider } from './anthropic.js';
import type { AiMessage, AiProvider, ProviderRequest, ToolDefinition } from './provider.js';
import { createAiTransport } from './transport.js';

let fake: FakeProvider;
let claude: AiProvider;
beforeAll(async () => {
  fake = await startFakeAnthropic();
  claude = createAnthropicProvider({
    apiKey: FAKE_ANTHROPIC_KEY,
    baseUrl: fake.origin,
    transport: createAiTransport({ localServers: parseLocalServers(fake.hostPort) }),
  });
});
afterAll(async () => {
  await fake.stop();
});

const findContacts: ToolDefinition = {
  name: 'find_contacts',
  description: 'Finds contacts by what they said.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    additionalProperties: false,
  },
};
const countDeals: ToolDefinition = {
  name: 'count_deals',
  description: 'Counts open deals.',
  inputSchema: { type: 'object', properties: {} },
};
const ask = (text: string, more: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'claude-opus-5-5',
  system: 'You help a small business answer its customers.',
  messages: [{ role: 'user', text }],
  maxOutputTokens: 1024,
  ...more,
});
const last = () => {
  const request = fake.requests.at(-1);
  if (request === undefined) throw new Error('The stand-in saw no request.');
  return request;
};
const sse = (name: string) => fixture('anthropic', name);

describe('the request', () => {
  it('is the Messages API request the documentation describes, and nothing more', async () => {
    const response = await claude.generate(ask('Hello', { tools: [findContacts, countDeals] }));
    expect(response.status).toBe('ok');
    const request = last();
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/messages');
    expect(request.headers).toMatchObject({
      'x-api-key': FAKE_ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    expect(ANTHROPIC_VERSION).toBe('2023-06-01');
    // The key goes in its header and nowhere else.
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(request.json).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      stream: true,
      // The breakpoint is on the system prompt: tools and system are the shared prefix.
      system: [
        {
          type: 'text',
          text: 'You help a small business answer its customers.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      // By name, so that the list is the same bytes however the caller ordered it.
      tools: [
        {
          name: 'count_deals',
          description: 'Counts open deals.',
          input_schema: { properties: {}, type: 'object' },
        },
        {
          name: 'find_contacts',
          description: 'Finds contacts by what they said.',
          input_schema: {
            additionalProperties: false,
            properties: { limit: { type: 'integer' }, query: { type: 'string' } },
            required: ['query'],
            type: 'object',
          },
        },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('leaves out what it has none of, and marks the tools when there is no system prompt', async () => {
    await claude.generate(ask('Hello', { system: '' }));
    expect(last().json).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    await claude.generate(ask('Hello', { system: '', tools: [findContacts, countDeals] }));
    expect(last().json).toMatchObject({
      tools: [
        { name: 'count_deals' },
        { name: 'find_contacts', cache_control: { type: 'ephemeral' } },
      ],
    });
    expect(last().json).not.toHaveProperty('system');
  });

  it('asks for the hour’s cache on the same breakpoint, and for five minutes as it always did', async () => {
    await claude.generate(ask('Hello', { tools: [findContacts], cacheTtl: '1h' }));
    expect(last().json).toMatchObject({
      system: [{ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: [{ name: 'find_contacts' }],
    });
    expect(last().json).not.toHaveProperty(['tools', 0, 'cache_control']);
    // No beta header: the hour's cache is part of the API.
    expect(Object.keys(last().headers).filter((name) => name.includes('beta'))).toEqual([]);
    await claude.generate(ask('Hello', { system: '', tools: [findContacts], cacheTtl: '1h' }));
    expect(last().json).toMatchObject({
      tools: [{ name: 'find_contacts', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
    // Five minutes is the API's default, so it is sent without a ttl: the same bytes as before.
    await claude.generate(ask('Hello', { cacheTtl: '5m' }));
    const fiveMinutes = last().body;
    await claude.generate(ask('Hello'));
    expect(last().body).toBe(fiveMinutes);
    expect(last().json).toMatchObject({ system: [{ cache_control: { type: 'ephemeral' } }] });
    expect(last().json).not.toHaveProperty(['system', 0, 'cache_control', 'ttl']);
  });

  it('writes the same bytes for the same prompt and tools, whatever order they were given in', async () => {
    await claude.generate(ask('First question', { tools: [findContacts, countDeals] }));
    const first = last().body;
    const reordered: ToolDefinition = {
      ...findContacts,
      inputSchema: {
        additionalProperties: false,
        properties: { limit: { type: 'integer' }, query: { type: 'string' } },
        required: ['query'],
        type: 'object',
      },
    };
    await claude.generate(ask('First question', { tools: [countDeals, reordered] }));
    expect(last().body).toBe(first);
  });

  it('sends a tool turn back as the API wants it: the model’s own blocks unchanged, then the results', async () => {
    fake.next(stream(sse('tool-use.sse')));
    const turn = await claude.generate(ask('Who asked about June?', { tools: [findContacts] }));
    if (turn.status !== 'ok') throw new Error('Expected a turn.');
    const messages: AiMessage[] = [
      { role: 'user', text: 'Who asked about June?' },
      { role: 'assistant', parts: turn.parts },
      {
        role: 'tool',
        results: [
          { toolCallId: 'toolu_01FixtureToolUse0000000', text: '[{"name":"Jordan Lee"}]' },
          { toolCallId: 'toolu_01FixtureToolUse0000001', text: 'No such tool.', isError: true },
        ],
      },
    ];
    await claude.generate(ask('', { messages, tools: [findContacts] }));
    expect(last().json).toMatchObject({
      messages: [
        { role: 'user', content: 'Who asked about June?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '',
              signature: 'EqQBCgIYAhIMfixture+signature/0123456789==',
            },
            { type: 'text', text: 'Let me look that up.' },
            {
              type: 'tool_use',
              id: 'toolu_01FixtureToolUse0000000',
              name: 'find_contacts',
              input: { query: 'wedding in June', limit: 5 },
            },
            {
              type: 'tool_use',
              id: 'toolu_01FixtureToolUse0000001',
              name: 'count_deals',
              input: {},
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01FixtureToolUse0000000',
              content: '[{"name":"Jordan Lee"}]',
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01FixtureToolUse0000001',
              content: 'No such tool.',
              is_error: true,
            },
          ],
        },
      ],
    });
  });

  it('keeps another provider’s thinking to itself, and drops a turn with nothing left in it', async () => {
    await claude.generate(
      ask('', {
        messages: [
          { role: 'user', text: 'Hi' },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', provider: 'openai', data: { secret: 'theirs' } },
              { type: 'reasoning', provider: 'anthropic', data: { type: 'unknown_block' } },
              { type: 'text', text: '' },
            ],
          },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', provider: 'openai', data: { secret: 'theirs' } },
              {
                type: 'reasoning',
                provider: 'anthropic',
                data: { type: 'redacted_thinking', data: 'AAAA' },
              },
              { type: 'text', text: 'Hello.' },
            ],
          },
          { role: 'user', text: 'And now?' },
        ],
      }),
    );
    expect(last().json).toMatchObject({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'AAAA' },
            { type: 'text', text: 'Hello.' },
          ],
        },
        { role: 'user', content: 'And now?' },
      ],
    });
    expect(last().body).not.toContain('theirs');
  });
});

describe('the answer', () => {
  it('is the text, why it stopped and what was billed, with the text as it arrives', async () => {
    fake.next(stream(sse('text.sse')));
    const heard: string[] = [];
    const response = await claude.generate(ask('Hello'), {
      onTextDelta: (text) => heard.push(text),
    });
    expect(response).toEqual({
      status: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'end',
      usage: { inputTokens: 25, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(heard).toEqual(['Hello', '!']);
  });

  it('carries the model’s thinking, text and tool calls in the order it wrote them', async () => {
    fake.next(stream(sse('tool-use.sse')));
    expect(await claude.generate(ask('Who asked about June?', { tools: [findContacts] }))).toEqual({
      status: 'ok',
      parts: [
        {
          type: 'reasoning',
          provider: 'anthropic',
          data: {
            type: 'thinking',
            thinking: '',
            signature: 'EqQBCgIYAhIMfixture+signature/0123456789==',
          },
        },
        { type: 'text', text: 'Let me look that up.' },
        {
          type: 'tool_call',
          id: 'toolu_01FixtureToolUse0000000',
          name: 'find_contacts',
          input: { query: 'wedding in June', limit: 5 },
        },
        // A tool with no arguments streams an empty input.
        { type: 'tool_call', id: 'toolu_01FixtureToolUse0000001', name: 'count_deals', input: {} },
      ],
      stop: 'tool_calls',
      usage: { inputTokens: 472, outputTokens: 89, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it('keeps a redacted thinking block whole', async () => {
    fake.next(stream(sse('redacted-thinking.sse')));
    const response = await claude.generate(ask('Hello'));
    expect(response).toMatchObject({
      status: 'ok',
      parts: [
        {
          type: 'reasoning',
          provider: 'anthropic',
          data: { type: 'redacted_thinking', data: 'EmwKAhgBEgyfixture/redacted+data0123456789==' },
        },
        { type: 'text', text: 'Done.' },
      ],
    });
  });

  it('is a refusal, with its category, when Claude declines', async () => {
    fake.next(stream(sse('refusal.sse')));
    expect(await claude.generate(ask('Something unsafe'))).toEqual({
      status: 'refused',
      category: 'cyber',
      usage: { inputTokens: 31, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    // A refusal the API gives no category for.
    fake.next(stream(sse('refusal.sse').replace('"category":"cyber"', '"category":null')));
    expect(await claude.generate(ask('Something unsafe'))).toMatchObject({
      status: 'refused',
      category: null,
    });
  });

  it('keeps the text and drops the tool calls of a turn cut off at the token limit', async () => {
    fake.next(stream(sse('max-tokens.sse')));
    expect(await claude.generate(ask('Find them', { tools: [findContacts] }))).toEqual({
      status: 'ok',
      parts: [{ type: 'text', text: 'Searching' }],
      stop: 'max_tokens',
      usage: { inputTokens: 50, outputTokens: 64, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    fake.next(stream(sse('text.sse').replace('"end_turn"', '"model_context_window_exceeded"')));
    expect(await claude.generate(ask('Hello'))).toMatchObject({ status: 'ok', stop: 'max_tokens' });
    fake.next(stream(sse('text.sse').replace('"end_turn"', '"stop_sequence"')));
    expect(await claude.generate(ask('Hello'))).toMatchObject({ status: 'ok', stop: 'end' });
  });

  it('reads cache writes and cache hits apart from fresh input', async () => {
    const withCache = sse('text.sse').replace(
      '"input_tokens":25,"cache_creation_input_tokens":0,"cache_read_input_tokens":0',
      '"input_tokens":25,"cache_creation_input_tokens":1800,"cache_read_input_tokens":4200',
    );
    fake.next(stream(withCache));
    expect(await claude.generate(ask('Hello'))).toMatchObject({
      usage: { inputTokens: 25, outputTokens: 15, cacheReadTokens: 4200, cacheWriteTokens: 1800 },
    });
    // The last message_delta may restate the input counts: they are cumulative, not extra.
    fake.next(
      stream(
        withCache.replace(
          '"usage":{"output_tokens":15}',
          '"usage":{"input_tokens":30,"cache_creation_input_tokens":null,"cache_read_input_tokens":4300,"output_tokens":15}',
        ),
      ),
    );
    expect(await claude.generate(ask('Hello'))).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 15, cacheReadTokens: 4300, cacheWriteTokens: 1800 },
    });
  });

  it('reads the writes to the hour’s cache apart, from the message’s own usage', async () => {
    const counts = '"input_tokens":25,"cache_creation_input_tokens":0,"cache_read_input_tokens":0';
    const broken = (fiveMinutes: number, hour: number) =>
      sse('text.sse').replace(
        counts,
        `"input_tokens":25,"cache_creation_input_tokens":${String(fiveMinutes + hour)},"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":${String(fiveMinutes)},"ephemeral_1h_input_tokens":${String(hour)}}`,
      );
    fake.next(stream(broken(0, 1800)));
    expect(await claude.generate(ask('Hello', { cacheTtl: '1h' }))).toMatchObject({
      usage: { cacheWriteTokens: 1800, cacheWrite1hTokens: 1800 },
    });
    // The API's own breakdown wins over what the request asked for.
    fake.next(stream(broken(300, 1500)));
    expect(await claude.generate(ask('Hello', { cacheTtl: '1h' }))).toMatchObject({
      usage: { cacheWriteTokens: 1800, cacheWrite1hTokens: 1500 },
    });
    // A five-minute write has no one-hour part, and says nothing of one.
    fake.next(stream(broken(1800, 0)));
    const fiveMinutes = await claude.generate(ask('Hello'));
    expect(fiveMinutes).toMatchObject({ usage: { cacheWriteTokens: 1800 } });
    expect(fiveMinutes).not.toHaveProperty(['usage', 'cacheWrite1hTokens']);
    // Without a breakdown, a request's one breakpoint says which cache every write went to.
    const unbroken = sse('text.sse').replace(
      counts,
      '"input_tokens":25,"cache_creation_input_tokens":1800,"cache_read_input_tokens":0',
    );
    fake.next(stream(unbroken));
    expect(await claude.generate(ask('Hello', { cacheTtl: '1h' }))).toMatchObject({
      usage: { cacheWriteTokens: 1800, cacheWrite1hTokens: 1800 },
    });
    fake.next(stream(unbroken));
    expect(await claude.generate(ask('Hello'))).not.toHaveProperty(['usage', 'cacheWrite1hTokens']);
  });

  it('skips events, blocks and deltas it does not know, as the versioning policy asks', async () => {
    const extended = sse('text.sse')
      .replace(
        'event: content_block_stop',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"citations_delta","citation":{}}}\n\nevent: content_block_stop',
      )
      .replace(
        'event: message_delta',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\nevent: brand_new_event\ndata: {"type":"brand_new_event","anything":true}\n\nevent: message_delta',
      );
    fake.next(stream(extended));
    expect(await claude.generate(ask('Hello'))).toMatchObject({
      status: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'end',
    });
  });

  it('says so when the API reports no usage at all', async () => {
    fake.next(
      stream(
        sse('text.sse')
          .replace(/,"usage":\{"input_tokens":25[^}]*\}/, '')
          .replace(',"usage":{"output_tokens":15}', ''),
      ),
    );
    expect(await claude.generate(ask('Hello'))).toMatchObject({ status: 'ok', usage: null });
  });
});

describe('failures', () => {
  it.each([
    [401, 'authentication_error', 'authentication'],
    [403, 'permission_error', 'authentication'],
    [402, 'billing_error', 'billing'],
    [400, 'invalid_request_error', 'invalid_request'],
    [404, 'not_found_error', 'not_found'],
    [409, 'conflict_error', 'invalid_request'],
    [413, 'request_too_large', 'invalid_request'],
    [500, 'api_error', 'unavailable'],
    [504, 'timeout_error', 'unavailable'],
    [529, 'overloaded_error', 'unavailable'],
  ] as const)('%i %s is %s', async (status, type, code) => {
    fake.next(anthropicError(status, type));
    expect(await claude.generate(ask('Hello'))).toEqual({ status: 'error', code, usage: null });
  });

  it('passes on how long a rate limit or an overloaded API asked to wait', async () => {
    fake.next(anthropicError(429, 'rate_limit_error', { 'retry-after': '12' }));
    expect(await claude.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'rate_limited',
      retryAfterMs: 12_000,
      usage: null,
    });
    fake.next(anthropicError(529, 'overloaded_error', { 'retry-after': '3' }));
    expect(await claude.generate(ask('Hello'))).toMatchObject({
      code: 'unavailable',
      retryAfterMs: 3000,
    });
    // A spend-cap 429 has no retry-after: nothing says when to come back.
    fake.next(anthropicError(429, 'rate_limit_error'));
    expect(await claude.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'rate_limited',
      usage: null,
    });
    fake.next(anthropicError(429, 'rate_limit_error', { 'retry-after': 'soon' }));
    expect(await claude.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'rate_limited',
      usage: null,
    });
  });

  it('reads an error body that is not the API’s, such as a proxy’s page, by its status alone', async () => {
    fake.next({
      status: 413,
      headers: { 'content-type': 'text/html' },
      pieces: ['<html>Too large</html>'],
    });
    expect(await claude.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'invalid_request',
      usage: null,
    });
    fake.next({ status: 302, headers: { location: 'http://127.0.0.1:1/' } });
    expect(await claude.generate(ask('Hello'))).toMatchObject({ code: 'invalid_response' });
  });

  it('reports an error that arrives after the stream began, with what was already billed', async () => {
    fake.next(stream(sse('overloaded.sse')));
    expect(await claude.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'unavailable',
      usage: { inputTokens: 25, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    fake.next(stream(sse('overloaded.sse').replace('overloaded_error', 'rate_limit_error')));
    expect(await claude.generate(ask('Hello'))).toMatchObject({ code: 'rate_limited' });
    fake.next(stream(sse('overloaded.sse').replace('overloaded_error', 'invalid_request_error')));
    expect(await claude.generate(ask('Hello'))).toMatchObject({ code: 'invalid_request' });
    fake.next(stream(sse('overloaded.sse').replace('overloaded_error', 'authentication_error')));
    expect(await claude.generate(ask('Hello'))).toMatchObject({ code: 'authentication' });
    fake.next(stream(sse('overloaded.sse').replace('overloaded_error', 'billing_error')));
    expect(await claude.generate(ask('Hello'))).toMatchObject({ code: 'billing' });
    fake.next(stream(sse('overloaded.sse').replace('overloaded_error', 'not_found_error')));
    expect(await claude.generate(ask('Hello'))).toMatchObject({ code: 'not_found' });
    fake.next(stream(sse('overloaded.sse').replace('"type": "overloaded_error", ', '')));
    expect(await claude.generate(ask('Hello'))).toMatchObject({ code: 'unavailable' });
  });

  it('reports a connection lost in the middle of an answer, however it was lost', async () => {
    fake.next(stream(sse('text.sse'), { events: 4, then: 'drop' }));
    expect(await claude.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'unavailable',
      usage: { inputTokens: 25, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    // The stream ends cleanly, but before the message did.
    fake.next(stream(sse('text.sse'), { events: 5 }));
    expect(await claude.generate(ask('Hello'))).toMatchObject({
      status: 'error',
      code: 'unavailable',
    });
    fake.next({ status: 200, then: 'drop' });
    expect(await claude.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'unavailable',
      usage: null,
    });
  });

  it('gives up at the deadline, before the answer and in the middle of it', async () => {
    fake.next({ status: 200, headers: { 'content-type': 'text/event-stream' }, then: 'hang' });
    expect(await claude.generate(ask('Hello'), { timeoutMs: 100 })).toEqual({
      status: 'error',
      code: 'timeout',
      usage: null,
    });
    fake.next(stream(sse('text.sse'), { events: 4, then: 'hang' }));
    expect(await claude.generate(ask('Hello'), { timeoutMs: 150 })).toEqual({
      status: 'error',
      code: 'timeout',
      usage: { inputTokens: 25, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it.each([
    ['data that is not JSON', sse('text.sse').replace('{"type": "ping"}', '{"type": "ping"')],
    ['an event that is not an object', sse('text.sse').replace('{"type": "ping"}', '[1,2]')],
    [
      'a delta for a block that never started',
      sse('text.sse').replace(
        '"type":"content_block_delta","index":0',
        '"type":"content_block_delta","index":7',
      ),
    ],
    ['a tool call without a name', sse('tool-use.sse').replace('"name":"find_contacts",', '')],
    [
      'tool input that is not JSON',
      sse('tool-use.sse').replace(' June\\", \\"limit\\": 5}', ' June'),
    ],
    [
      'tool input that is not an object',
      sse('tool-use.sse')
        .replace('{\\"query\\":', '[')
        .replace(' June\\", \\"limit\\": 5}', ' June\\"]'),
    ],
    ['a stop reason it does not know', sse('text.sse').replace('"end_turn"', '"brand_new_reason"')],
    ['no stop reason at all', sse('text.sse').replace('"stop_reason":"end_turn",', '')],
    ['a pause it never asked for', sse('text.sse').replace('"end_turn"', '"pause_turn"')],
    ['a tool stop with no tool call', sse('text.sse').replace('"end_turn"', '"tool_use"')],
    [
      'a block without an index',
      sse('text.sse').replace(
        '"type":"content_block_start","index":0,',
        '"type":"content_block_start",',
      ),
    ],
  ])('refuses %s rather than guess', async (_name, body) => {
    fake.next(stream(body));
    expect(await claude.generate(ask('Hello', { tools: [findContacts] }))).toMatchObject({
      status: 'error',
      code: 'invalid_response',
    });
  });

  it('refuses an address it may not call, before sending the key anywhere', async () => {
    const seen = fake.requests.length;
    const elsewhere = createAnthropicProvider({
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrl: fake.origin,
      // This transport does not list the stand-in as one of the install's servers.
      transport: createAiTransport(),
    });
    expect(await elsewhere.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'blocked_address',
      usage: null,
    });
    expect(await elsewhere.listModels()).toEqual({
      status: 'error',
      code: 'blocked_address',
      usage: null,
    });
    expect(fake.requests.length).toBe(seen);
  });

  it('refuses an answer larger than it will read', async () => {
    const small = createAnthropicProvider({
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrl: fake.origin,
      transport: createAiTransport({
        localServers: parseLocalServers(fake.hostPort),
        maxResponseBytes: 200,
      }),
    });
    fake.next(stream(sse('text.sse')));
    expect(await small.generate(ask('Hello'))).toMatchObject({
      status: 'error',
      code: 'invalid_response',
    });
    expect(await small.listModels()).toMatchObject({ status: 'error', code: 'invalid_response' });
  });

  it('answers a wrong key as the API does', async () => {
    const wrong = createAnthropicProvider({
      apiKey: 'sk-ant-wrong',
      baseUrl: fake.origin,
      transport: createAiTransport({ localServers: parseLocalServers(fake.hostPort) }),
    });
    expect(await wrong.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'authentication',
      usage: null,
    });
    expect(await wrong.listModels()).toEqual({
      status: 'error',
      code: 'authentication',
      usage: null,
    });
  });
});

describe('prompt caching', () => {
  it('writes the shared prefix once and reads it on the next call, measurably', async () => {
    const system = `You are the assistant of a small business. ${'Answer briefly and kindly. '.repeat(200)}`;
    const request = (text: string) => ask(text, { system, tools: [findContacts, countDeals] });
    const first = await claude.generate(request('What did Jordan ask?'));
    const second = await claude.generate(request('And what did Priya ask?'));
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('Expected two answers.');
    expect(first.usage?.cacheWriteTokens).toBeGreaterThan(1000);
    expect(first.usage?.cacheReadTokens).toBe(0);
    // The second business, or the second message, reads what the first wrote.
    expect(second.usage?.cacheReadTokens).toBe(first.usage?.cacheWriteTokens);
    expect(second.usage?.cacheWriteTokens).toBe(0);
    // Fresh input is counted apart from the cached prefix, so neither is billed twice.
    expect(second.usage?.inputTokens).toBeLessThan(100);
  });

  it('writes an hour’s entry when asked, and any later call of the prefix reads it', async () => {
    const system = `Kept for an hour. ${'Be exact about times. '.repeat(200)}`;
    const first = await claude.generate(ask('One', { system, cacheTtl: '1h' }));
    if (first.status !== 'ok') throw new Error('Expected an answer.');
    expect(first.usage?.cacheWriteTokens).toBeGreaterThan(1000);
    expect(first.usage?.cacheWrite1hTokens).toBe(first.usage?.cacheWriteTokens);
    const second = await claude.generate(ask('Two', { system }));
    expect(second).toMatchObject({
      usage: { cacheReadTokens: first.usage?.cacheWriteTokens, cacheWriteTokens: 0 },
    });
  });

  it('misses when the prefix changes by a single character', async () => {
    const system = `Prefix under test. ${'Stay on topic. '.repeat(200)}`;
    await claude.generate(ask('One', { system }));
    const changed = await claude.generate(ask('Two', { system: `${system}!` }));
    expect(changed).toMatchObject({ usage: { cacheReadTokens: 0 } });
  });
});

describe('the models a key can use', () => {
  it('lists them from GET /v1/models', async () => {
    expect(await claude.listModels()).toEqual({
      status: 'ok',
      models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
    });
    const request = last();
    expect(request.method).toBe('GET');
    expect(request.path).toBe('/v1/models?limit=1000');
    expect(request.headers).toMatchObject({
      'x-api-key': FAKE_ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    });
  });

  it('reports a list it cannot read, a failure and a silent server', async () => {
    fake.next({ status: 200, pieces: ['<html>'] });
    expect(await claude.listModels()).toMatchObject({ status: 'error', code: 'invalid_response' });
    fake.next({ status: 200, pieces: ['{"data":[{"id":"claude-opus-5-5"},{"name":"no id"}]}'] });
    expect(await claude.listModels()).toMatchObject({ status: 'error', code: 'invalid_response' });
    fake.next({ status: 200, pieces: ['{"models":[]}'] });
    expect(await claude.listModels()).toMatchObject({ status: 'error', code: 'invalid_response' });
    fake.next(anthropicError(529, 'overloaded_error', { 'retry-after': '2' }));
    expect(await claude.listModels()).toEqual({
      status: 'error',
      code: 'unavailable',
      retryAfterMs: 2000,
      usage: null,
    });
    fake.next({ status: 200, then: 'hang' });
    expect(await claude.listModels({ timeoutMs: 100 })).toMatchObject({ code: 'timeout' });
  });
});
