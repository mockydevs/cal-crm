// The OpenAI-compatible adapter, over a real socket to a local stand-in that replays
// fixtures written from OpenAI's OpenAPI specification (src/fixtures/openai). No test calls
// OpenAI. What a model server of one's own may leave out is taken away from a fixture here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FAKE_OPENAI_KEY, openAiError, startFakeOpenAi } from '../test/fake-openai.js';
import { fixture, json, stream, type FakeProvider } from '../test/fake-provider.js';
import { parseLocalServers } from './addresses.js';
import { createOpenAiProvider, OPENAI_BASE_URL } from './openai.js';
import type { AiMessage, AiProvider, ProviderRequest, ToolDefinition } from './provider.js';
import { createAiTransport } from './transport.js';

let fake: FakeProvider;
let keyless: FakeProvider;
let server: AiProvider;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  keyless = await startFakeOpenAi(null);
  server = createOpenAiProvider({
    apiKey: FAKE_OPENAI_KEY,
    baseUrl: `${fake.origin}/v1`,
    transport: createAiTransport({ localServers: parseLocalServers(fake.hostPort) }),
  });
});
afterAll(async () => {
  await fake.stop();
  await keyless.stop();
});

const findContacts: ToolDefinition = {
  name: 'find_contacts',
  description: 'Finds contacts by what they said.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
  },
};
const countDeals: ToolDefinition = {
  name: 'count_deals',
  description: 'Counts open deals.',
  inputSchema: { type: 'object', properties: {} },
};
const ask = (text: string, more: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'llama3.2',
  system: 'You help a small business answer its customers.',
  messages: [{ role: 'user', text }],
  maxOutputTokens: 512,
  ...more,
});
const last = (from: FakeProvider = fake) => {
  const request = from.requests.at(-1);
  if (request === undefined) throw new Error('The stand-in saw no request.');
  return request;
};
const file = (name: string) => fixture('openai', name);
const parsed = (name: string): Record<string, unknown> =>
  JSON.parse(file(name)) as Record<string, unknown>;
/** A fixture answer with one thing changed, as text. */
const changed = (name: string, from: string, to: string): unknown => {
  const text = JSON.stringify(parsed(name));
  if (!text.includes(from)) throw new Error(`The fixture ${name} has no ${from}.`);
  return JSON.parse(text.replace(from, to));
};

describe('the request', () => {
  it('is the Chat Completions request the specification describes, and nothing more', async () => {
    const response = await server.generate(ask('Hello', { tools: [findContacts, countDeals] }));
    expect(response.status).toBe('ok');
    const request = last();
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers).toMatchObject({
      authorization: `Bearer ${FAKE_OPENAI_KEY}`,
      'content-type': 'application/json',
    });
    expect(request.body).not.toContain(FAKE_OPENAI_KEY);
    expect(request.json).toEqual({
      model: 'llama3.2',
      // What Ollama, llama.cpp, vLLM and LM Studio document.
      max_tokens: 512,
      messages: [
        { role: 'system', content: 'You help a small business answer its customers.' },
        { role: 'user', content: 'Hello' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'count_deals',
            description: 'Counts open deals.',
            parameters: { properties: {}, type: 'object' },
          },
        },
        {
          type: 'function',
          function: {
            name: 'find_contacts',
            description: 'Finds contacts by what they said.',
            parameters: {
              properties: { limit: { type: 'integer' }, query: { type: 'string' } },
              required: ['query'],
              type: 'object',
            },
          },
        },
      ],
    });
  });

  it('names the token limit as OpenAI itself now does, when told to', async () => {
    const hosted = createOpenAiProvider({
      apiKey: FAKE_OPENAI_KEY,
      baseUrl: `${fake.origin}/v1/`,
      transport: createAiTransport({ localServers: parseLocalServers(fake.hostPort) }),
      tokenLimitField: 'max_completion_tokens',
    });
    await hosted.generate(ask('Hello', { system: '' }));
    expect(last().json).toEqual({
      model: 'llama3.2',
      max_completion_tokens: 512,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(last().path).toBe('/v1/chat/completions');
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
  });

  it('sends no Authorization header to a server that asks for no key', async () => {
    const local = createOpenAiProvider({
      baseUrl: `${keyless.origin}/v1`,
      transport: createAiTransport({ localServers: parseLocalServers(keyless.hostPort) }),
    });
    expect(await local.generate(ask('Hello'))).toMatchObject({ status: 'ok' });
    expect(last(keyless).headers.authorization).toBeUndefined();
    expect(await local.listModels()).toEqual({
      status: 'ok',
      models: ['fixture-model', 'fixture-small'],
    });
    expect(last(keyless).headers.authorization).toBeUndefined();
  });

  it('asks for a stream, and for its usage, only when someone is listening', async () => {
    await server.generate(ask('Hello'));
    expect(last().json).not.toHaveProperty('stream');
    expect(last().json).not.toHaveProperty('stream_options');
    await server.generate(ask('Hello'), { onTextDelta: () => undefined });
    expect(last().json).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('sends a tool turn back as the specification wants it', async () => {
    fake.next(json(200, parsed('chat-completion-tool-calls.json')));
    const turn = await server.generate(ask('Who asked about June?', { tools: [findContacts] }));
    if (turn.status !== 'ok') throw new Error('Expected a turn.');
    const messages: AiMessage[] = [
      { role: 'user', text: 'Who asked about June?' },
      {
        role: 'assistant',
        parts: [
          // Another provider's thinking stays with that provider.
          {
            type: 'reasoning',
            provider: 'anthropic',
            data: { type: 'thinking', signature: 'theirs' },
          },
          { type: 'text', text: 'One moment.' },
          ...turn.parts,
        ],
      },
      {
        role: 'tool',
        results: [
          { toolCallId: 'call_fixture0001', text: '[{"name":"Jordan Lee"}]' },
          { toolCallId: 'call_fixture0002', text: 'No such tool.', isError: true },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'Jordan Lee did.' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '' }] },
      { role: 'user', text: 'Thanks' },
    ];
    await server.generate(ask('', { messages, system: '' }));
    expect(last().json).toMatchObject({
      messages: [
        { role: 'user', content: 'Who asked about June?' },
        {
          role: 'assistant',
          content: 'One moment.',
          tool_calls: [
            {
              id: 'call_fixture0001',
              type: 'function',
              function: {
                name: 'find_contacts',
                arguments: '{"query":"wedding in June","limit":5}',
              },
            },
            {
              id: 'call_fixture0002',
              type: 'function',
              function: { name: 'count_deals', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_fixture0001', content: '[{"name":"Jordan Lee"}]' },
        { role: 'tool', tool_call_id: 'call_fixture0002', content: 'No such tool.' },
        { role: 'assistant', content: 'Jordan Lee did.' },
        { role: 'user', content: 'Thanks' },
      ],
    });
    expect(last().body).not.toContain('theirs');
  });

  it('writes null content for a turn that only called tools', async () => {
    await server.generate(
      ask('', {
        messages: [
          { role: 'user', text: 'Count' },
          {
            role: 'assistant',
            parts: [{ type: 'tool_call', id: 'call_1', name: 'count_deals', input: {} }],
          },
          { role: 'tool', results: [{ toolCallId: 'call_1', text: '4' }] },
        ],
      }),
    );
    expect(last().json).toMatchObject({
      messages: [
        { role: 'system' },
        { role: 'user', content: 'Count' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
        { role: 'tool', tool_call_id: 'call_1', content: '4' },
      ],
    });
  });
});

describe('the answer', () => {
  it('is the text, why it stopped and what was billed', async () => {
    expect(await server.generate(ask('Hello'))).toEqual({
      status: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'end',
      usage: { inputTokens: 19, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it('carries tool calls with their arguments read, and cached input apart from fresh', async () => {
    fake.next(json(200, parsed('chat-completion-tool-calls.json')));
    expect(await server.generate(ask('Who asked about June?', { tools: [findContacts] }))).toEqual({
      status: 'ok',
      parts: [
        {
          type: 'tool_call',
          id: 'call_fixture0001',
          name: 'find_contacts',
          input: { query: 'wedding in June', limit: 5 },
        },
        { type: 'tool_call', id: 'call_fixture0002', name: 'count_deals', input: {} },
      ],
      stop: 'tool_calls',
      // 82 prompt tokens, of which 64 were read from the cache.
      usage: { inputTokens: 18, outputTokens: 17, cacheReadTokens: 64, cacheWriteTokens: 0 },
    });
  });

  it('is a refusal when the model declines or the answer was filtered', async () => {
    fake.next(json(200, parsed('chat-completion-refusal.json')));
    expect(await server.generate(ask('Something unsafe'))).toEqual({
      status: 'refused',
      category: null,
      usage: { inputTokens: 21, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    fake.next(
      json(
        200,
        changed(
          'chat-completion.json',
          '"finish_reason":"stop"',
          '"finish_reason":"content_filter"',
        ),
      ),
    );
    expect(await server.generate(ask('Something unsafe'))).toMatchObject({
      status: 'refused',
      category: null,
    });
  });

  it('keeps the text and drops the tool calls of a turn cut off at the token limit', async () => {
    fake.next(
      json(
        200,
        changed('chat-completion.json', '"finish_reason":"stop"', '"finish_reason":"length"'),
      ),
    );
    expect(await server.generate(ask('Hello'))).toMatchObject({
      status: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'max_tokens',
    });
    fake.next(
      json(
        200,
        changed(
          'chat-completion-tool-calls.json',
          '"finish_reason":"tool_calls"',
          '"finish_reason":"length"',
        ),
      ),
    );
    expect(await server.generate(ask('Find them', { tools: [findContacts] }))).toMatchObject({
      status: 'ok',
      parts: [],
      stop: 'max_tokens',
    });
  });

  describe('from a model server that leaves things out', () => {
    it('reports unknown usage as unknown, never as zero', async () => {
      const { usage: _usage, ...withoutUsage } = parsed('chat-completion.json');
      fake.next(json(200, withoutUsage));
      expect(await server.generate(ask('Hello'))).toEqual({
        status: 'ok',
        parts: [{ type: 'text', text: 'Hello!' }],
        stop: 'end',
        usage: null,
      });
      // Half a usage object is no usage either.
      fake.next(json(200, { ...withoutUsage, usage: { completion_tokens: 10 } }));
      expect(await server.generate(ask('Hello'))).toMatchObject({ status: 'ok', usage: null });
    });

    it('reads usage that has no breakdown of cached tokens', async () => {
      fake.next(
        json(
          200,
          changed('chat-completion.json', ',"prompt_tokens_details":{"cached_tokens":0}', ''),
        ),
      );
      expect(await server.generate(ask('Hello'))).toMatchObject({
        usage: { inputTokens: 19, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
    });

    it('names a tool call that came without an id, and reads empty arguments as none', async () => {
      const answer = JSON.parse(
        JSON.stringify(parsed('chat-completion-tool-calls.json'))
          .replace('"id":"call_fixture0001",', '')
          .replace('"arguments":"{}"', '"arguments":""'),
      ) as unknown;
      fake.next(json(200, answer));
      expect(await server.generate(ask('Find them', { tools: [findContacts] }))).toMatchObject({
        status: 'ok',
        parts: [
          { type: 'tool_call', id: 'call_0', name: 'find_contacts' },
          { type: 'tool_call', id: 'call_fixture0002', name: 'count_deals', input: {} },
        ],
        stop: 'tool_calls',
      });
    });

    it('takes tool calls as the reason to stop when the server names none, or says "stop"', async () => {
      fake.next(
        json(
          200,
          changed(
            'chat-completion-tool-calls.json',
            '"finish_reason":"tool_calls"',
            '"finish_reason":"stop"',
          ),
        ),
      );
      expect(await server.generate(ask('Find them', { tools: [findContacts] }))).toMatchObject({
        status: 'ok',
        stop: 'tool_calls',
      });
      fake.next(
        json(
          200,
          changed('chat-completion.json', '"finish_reason":"stop"', '"finish_reason":null'),
        ),
      );
      expect(await server.generate(ask('Hello'))).toMatchObject({ status: 'ok', stop: 'end' });
    });

    it('answers a model with no tool support in plain text, which is still an answer', async () => {
      // Tools were offered; the server ignored them and wrote text.
      expect(await server.generate(ask('Find them', { tools: [findContacts] }))).toMatchObject({
        status: 'ok',
        parts: [{ type: 'text', text: 'Hello!' }],
        stop: 'end',
      });
    });
  });
});

describe('a streamed answer', () => {
  const listen = () => {
    const heard: string[] = [];
    return { heard, onTextDelta: (text: string) => heard.push(text) };
  };

  it('is put back together, with its text as it arrives and its usage from the last chunk', async () => {
    const { heard, onTextDelta } = listen();
    expect(await server.generate(ask('Hello'), { onTextDelta })).toEqual({
      status: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'end',
      usage: { inputTokens: 19, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(heard).toEqual(['Hello', '!']);
  });

  it('joins tool calls that arrive in pieces, by their index', async () => {
    fake.next(stream(file('stream-tool-calls.sse')));
    expect(
      await server.generate(ask('Who asked about June?', { tools: [findContacts] }), listen()),
    ).toEqual({
      status: 'ok',
      parts: [
        {
          type: 'tool_call',
          id: 'call_fixture0001',
          name: 'find_contacts',
          input: { query: 'wedding in June', limit: 5 },
        },
        { type: 'tool_call', id: 'call_fixture0002', name: 'count_deals', input: {} },
      ],
      stop: 'tool_calls',
      usage: { inputTokens: 18, outputTokens: 17, cacheReadTokens: 64, cacheWriteTokens: 0 },
    });
  });

  it('has unknown usage when the server sends no usage chunk', async () => {
    const withoutUsage = file('stream-text.sse')
      .split('\n\n')
      .filter((event) => !event.includes('"choices":[]'))
      .join('\n\n');
    fake.next(stream(withoutUsage));
    expect(await server.generate(ask('Hello'), listen())).toMatchObject({
      status: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      usage: null,
    });
  });

  it('is whole once the model said why it stopped, even if the server never says [DONE]', async () => {
    fake.next(stream(file('stream-text.sse').replace('data: [DONE]\n\n', '')));
    expect(await server.generate(ask('Hello'), listen())).toMatchObject({
      status: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      stop: 'end',
      usage: { inputTokens: 19 },
    });
  });

  it('is a refusal when the refusal arrives in pieces', async () => {
    fake.next(
      stream(
        file('stream-text.sse')
          .replace('"delta":{"content":"Hello"}', '"delta":{"refusal":"I can\'t "}')
          .replace('"delta":{"content":"!"}', '"delta":{"refusal":"help."}'),
      ),
    );
    expect(await server.generate(ask('Something unsafe'), listen())).toMatchObject({
      status: 'refused',
      category: null,
    });
  });

  it('reports a connection lost before the model finished, and a stall', async () => {
    fake.next(stream(file('stream-text.sse'), { events: 2, then: 'drop' }));
    expect(await server.generate(ask('Hello'), listen())).toEqual({
      status: 'error',
      code: 'unavailable',
      usage: null,
    });
    fake.next(stream(file('stream-text.sse'), { events: 2 }));
    expect(await server.generate(ask('Hello'), listen())).toMatchObject({ code: 'unavailable' });
    fake.next(stream(file('stream-text.sse'), { events: 2, then: 'hang' }));
    expect(await server.generate(ask('Hello'), { ...listen(), timeoutMs: 150 })).toMatchObject({
      code: 'timeout',
    });
  });

  it('reports an error that arrives inside the stream', async () => {
    const withError = (error: string) =>
      stream(
        file('stream-text.sse').split('\n\n').slice(0, 2).join('\n\n') +
          `\n\ndata: {"error":${error}}\n\n`,
      );
    fake.next(
      withError('{"message":"A fixture error.","type":"server_error","param":null,"code":null}'),
    );
    expect(await server.generate(ask('Hello'), listen())).toMatchObject({ code: 'unavailable' });
    fake.next(
      withError(
        '{"message":"A fixture error.","type":"rate_limit_error","param":null,"code":"slow_down"}',
      ),
    );
    expect(await server.generate(ask('Hello'), listen())).toMatchObject({ code: 'rate_limited' });
    fake.next(
      withError(
        '{"message":"A fixture error.","type":"insufficient_quota","param":null,"code":null}',
      ),
    );
    expect(await server.generate(ask('Hello'), listen())).toMatchObject({ code: 'billing' });
    fake.next(
      withError(
        '{"message":"A fixture error.","type":"invalid_request_error","param":null,"code":null}',
      ),
    );
    expect(await server.generate(ask('Hello'), listen())).toMatchObject({
      code: 'invalid_request',
    });
    fake.next(
      withError(
        '{"message":"A fixture error.","type":"authentication_error","param":null,"code":null}',
      ),
    );
    expect(await server.generate(ask('Hello'), listen())).toMatchObject({ code: 'authentication' });
  });

  it.each([
    [
      'a chunk that is not JSON',
      file('stream-text.sse').replace('"delta":{"content":"!"}', '"delta":{"content":"!"'),
    ],
    ['a chunk that is not an object', file('stream-text.sse').replace('data: [DONE]', 'data: [1]')],
    [
      'a tool call piece without an index',
      file('stream-tool-calls.sse').replace(
        '{"index":0,"function":{"arguments":"{\\"query\\":"}}',
        '{"function":{"arguments":"{"}}',
      ),
    ],
    [
      'tool arguments that never become JSON',
      file('stream-tool-calls.sse').replace('\\"limit\\":5}', '\\"limit\\":'),
    ],
    [
      'a tool call that was never named',
      file('stream-tool-calls.sse').replace(
        '"function":{"name":"count_deals","arguments":""}',
        '"function":{"arguments":""}',
      ),
    ],
  ])('refuses %s rather than guess', async (_name, body) => {
    fake.next(stream(body));
    expect(await server.generate(ask('Hello', { tools: [findContacts] }), listen())).toMatchObject({
      status: 'error',
      code: 'invalid_response',
    });
  });
});

describe('failures', () => {
  it.each([
    [401, 'invalid_request_error', null, 'authentication'],
    [403, 'invalid_request_error', null, 'authentication'],
    [402, 'insufficient_quota', null, 'billing'],
    [400, 'invalid_request_error', null, 'invalid_request'],
    [404, 'invalid_request_error', 'model_not_found', 'not_found'],
    [422, 'invalid_request_error', null, 'invalid_request'],
    [429, 'rate_limit_error', 'slow_down', 'rate_limited'],
    [429, 'insufficient_quota', 'credit_balance_exhausted', 'billing'],
    [429, 'insufficient_quota', null, 'billing'],
    [429, 'rate_limit_error', 'organization_spend_limit_exceeded', 'billing'],
    [429, 'rate_limit_error', 'project_spend_limit_exceeded', 'billing'],
    [429, 'rate_limit_error', 'organization_usage_limit_exceeded', 'billing'],
    [500, 'server_error', null, 'unavailable'],
    [503, 'service_unavailable_error', 'server_is_overloaded', 'unavailable'],
  ] as const)('%i %s %s is %s', async (status, type, code, expected) => {
    fake.next(openAiError(status, type, code));
    expect(await server.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: expected,
      usage: null,
    });
  });

  it('passes on how long a rate limit or an overloaded server asked to wait', async () => {
    fake.next(openAiError(429, 'rate_limit_error', 'slow_down', { 'retry-after': '56' }));
    expect(await server.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'rate_limited',
      retryAfterMs: 56_000,
      usage: null,
    });
    fake.next(
      openAiError(503, 'service_unavailable_error', 'server_is_overloaded', { 'retry-after': '2' }),
    );
    expect(await server.generate(ask('Hello'))).toMatchObject({
      code: 'unavailable',
      retryAfterMs: 2000,
    });
  });

  it('reads an error by its status when the body is not the specification’s', async () => {
    // llama.cpp answers 503 with a number for a code while a model loads.
    fake.next(
      json(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }),
    );
    expect(await server.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'unavailable',
      usage: null,
    });
    fake.next({
      status: 429,
      headers: { 'content-type': 'text/html' },
      pieces: ['<html>Slow down</html>'],
    });
    expect(await server.generate(ask('Hello'))).toMatchObject({ code: 'rate_limited' });
    fake.next({ status: 301, headers: { location: 'http://127.0.0.1:1/' } });
    expect(await server.generate(ask('Hello'))).toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    ['an answer that is not JSON', '<html>'],
    ['an answer with no choices', '{"choices":[]}'],
    ['a choice with no message', '{"choices":[{"index":0,"finish_reason":"stop"}]}'],
    [
      'a reason to stop it does not know',
      JSON.stringify(parsed('chat-completion.json')).replace(
        '"finish_reason":"stop"',
        '"finish_reason":"function_call"',
      ),
    ],
    [
      'a tool stop with no tool call',
      JSON.stringify(parsed('chat-completion.json')).replace(
        '"finish_reason":"stop"',
        '"finish_reason":"tool_calls"',
      ),
    ],
    [
      'tool arguments that are not JSON',
      JSON.stringify(parsed('chat-completion-tool-calls.json')).replace(
        '"arguments":"{}"',
        '"arguments":"{"',
      ),
    ],
    [
      'tool arguments that are not an object',
      JSON.stringify(parsed('chat-completion-tool-calls.json')).replace(
        '"arguments":"{}"',
        '"arguments":"[]"',
      ),
    ],
    [
      'a tool call with no name',
      JSON.stringify(parsed('chat-completion-tool-calls.json')).replace(
        '"name":"count_deals",',
        '',
      ),
    ],
    [
      'a tool call that is not an object',
      JSON.stringify(parsed('chat-completion-tool-calls.json')).replace(
        '"tool_calls":[',
        '"tool_calls":[7,',
      ),
    ],
  ])('refuses %s rather than guess', async (_name, body) => {
    fake.next({ status: 200, headers: { 'content-type': 'application/json' }, pieces: [body] });
    expect(await server.generate(ask('Hello', { tools: [findContacts] }))).toMatchObject({
      status: 'error',
      code: 'invalid_response',
    });
  });

  it('reports a server that is slow, gone, or cut off', async () => {
    fake.next({ status: 200, then: 'hang' });
    expect(await server.generate(ask('Hello'), { timeoutMs: 100 })).toEqual({
      status: 'error',
      code: 'timeout',
      usage: null,
    });
    fake.next({ status: 200, pieces: ['{"choices":'], then: 'drop' });
    expect(await server.generate(ask('Hello'))).toMatchObject({ code: 'unavailable' });
    const stopped = await startFakeOpenAi();
    const gone = createOpenAiProvider({
      apiKey: FAKE_OPENAI_KEY,
      baseUrl: `${stopped.origin}/v1`,
      transport: createAiTransport({ localServers: parseLocalServers(stopped.hostPort) }),
    });
    await stopped.stop();
    expect(await gone.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'unavailable',
      usage: null,
    });
    expect(await gone.listModels()).toMatchObject({ code: 'unavailable' });
  });

  it('refuses a server the install has not listed, before sending the key anywhere', async () => {
    const seen = fake.requests.length;
    const unlisted = createOpenAiProvider({
      apiKey: FAKE_OPENAI_KEY,
      baseUrl: `${fake.origin}/v1`,
      transport: createAiTransport(),
    });
    expect(await unlisted.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'blocked_address',
      usage: null,
    });
    expect(await unlisted.listModels()).toMatchObject({ code: 'blocked_address' });
    expect(fake.requests.length).toBe(seen);
  });
});

describe('the models a server has', () => {
  it('lists them from GET {base}/models', async () => {
    expect(await server.listModels()).toEqual({
      status: 'ok',
      models: ['fixture-model', 'fixture-small'],
    });
    expect(last().method).toBe('GET');
    expect(last().path).toBe('/v1/models');
    expect(last().headers).toMatchObject({ authorization: `Bearer ${FAKE_OPENAI_KEY}` });
  });

  it('reports a wrong key, a list it cannot read and a silent server', async () => {
    const wrong = createOpenAiProvider({
      apiKey: 'sk-wrong',
      baseUrl: `${fake.origin}/v1`,
      transport: createAiTransport({ localServers: parseLocalServers(fake.hostPort) }),
    });
    expect(await wrong.listModels()).toEqual({
      status: 'error',
      code: 'authentication',
      usage: null,
    });
    expect(await wrong.generate(ask('Hello'))).toMatchObject({ code: 'authentication' });
    fake.next({ status: 200, pieces: ['{"data":[{"object":"model"}]}'] });
    expect(await server.listModels()).toMatchObject({ code: 'invalid_response' });
    fake.next({ status: 200, pieces: ['[]'] });
    expect(await server.listModels()).toMatchObject({ code: 'invalid_response' });
    fake.next({ status: 200, then: 'hang' });
    expect(await server.listModels({ timeoutMs: 100 })).toMatchObject({ code: 'timeout' });
  });
});
