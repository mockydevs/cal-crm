// The OpenAI-compatible adapter against a real, local Ollama with a small model. It is not
// part of the ordinary test runs, which never need a model server: run it with `pnpm
// --filter @repo/module-ai test:ollama` and
//
//   OLLAMA_BASE_URL   such as http://127.0.0.1:11434/v1
//   OLLAMA_MODEL      a model the server has pulled, such as qwen2.5:0.5b
//
// Without both it fails rather than passing by doing nothing. A small model's words are
// its own, so the tests check the shape of what comes back, not what it says.
import { beforeAll, describe, expect, it } from 'vitest';

import { parseLocalServers } from './addresses.js';
import { createOpenAiProvider } from './openai.js';
import { textOf, toolCallsOf, type AiProvider, type ProviderRequest } from './provider.js';
import { createAiTransport } from './transport.js';

let ollama: AiProvider;
let unlisted: AiProvider;
let model: string;

beforeAll(() => {
  const baseUrl = process.env['OLLAMA_BASE_URL'];
  const chosen = process.env['OLLAMA_MODEL'];
  if (baseUrl === undefined || chosen === undefined)
    throw new Error('Set OLLAMA_BASE_URL and OLLAMA_MODEL to run the live Ollama check.');
  model = chosen;
  const { host } = new URL(baseUrl);
  // As an install would list it in AI_LOCAL_SERVERS.
  const transport = createAiTransport({ localServers: parseLocalServers(host) });
  ollama = createOpenAiProvider({ baseUrl, transport });
  unlisted = createOpenAiProvider({ baseUrl, transport: createAiTransport() });
});

const ask = (text: string, more: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model,
  system: 'You are a brief assistant. Answer in one short sentence.',
  messages: [{ role: 'user', text }],
  maxOutputTokens: 64,
  ...more,
});

describe('a local Ollama', () => {
  it('lists the model that was pulled', async () => {
    const listed = await ollama.listModels({ timeoutMs: 30_000 });
    expect(listed.status).toBe('ok');
    expect(listed.status === 'ok' ? listed.models : []).toContain(model);
  });

  it('answers in text and says what it used', async () => {
    const response = await ollama.generate(ask('Say hello.'), { timeoutMs: 240_000 });
    expect(response.status).toBe('ok');
    if (response.status !== 'ok') return;
    expect(textOf(response.parts).trim()).not.toBe('');
    expect(['end', 'max_tokens']).toContain(response.stop);
    expect(response.usage).not.toBeNull();
    expect(response.usage?.inputTokens).toBeGreaterThan(0);
    expect(response.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('streams its answer, with the usage chunk it was asked for', async () => {
    const heard: string[] = [];
    const response = await ollama.generate(ask('Count from one to five.'), {
      timeoutMs: 240_000,
      onTextDelta: (text) => heard.push(text),
    });
    expect(response.status).toBe('ok');
    if (response.status !== 'ok') return;
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.join('')).toBe(textOf(response.parts));
    expect(response.usage).not.toBeNull();
    expect(response.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('takes tool definitions, and any tool call it makes has arguments that are an object', async () => {
    const response = await ollama.generate(
      ask('What is the weather in Paris? Use the get_weather tool.', {
        system: 'You answer questions about weather by calling the get_weather tool.',
        maxOutputTokens: 128,
        tools: [
          {
            name: 'get_weather',
            description: 'Gets the current weather for a city.',
            inputSchema: {
              type: 'object',
              properties: { city: { type: 'string', description: 'The city name' } },
              required: ['city'],
            },
          },
        ],
      }),
      { timeoutMs: 240_000 },
    );
    expect(response.status).toBe('ok');
    if (response.status !== 'ok') return;
    const calls = toolCallsOf(response.parts);
    expect(calls.filter((made) => made.name !== 'get_weather' || made.id === '')).toEqual([]);
    // It stopped for its tool calls exactly when it made some.
    expect(response.stop === 'tool_calls').toBe(calls.length > 0);
  });

  it('takes a whole tool turn back and answers from the result', async () => {
    const response = await ollama.generate(
      ask('', {
        messages: [
          { role: 'user', text: 'What is the weather in Paris?' },
          {
            role: 'assistant',
            parts: [
              { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
            ],
          },
          { role: 'tool', results: [{ toolCallId: 'call_1', text: '18 degrees and sunny' }] },
        ],
      }),
      { timeoutMs: 240_000 },
    );
    expect(response.status).toBe('ok');
    if (response.status === 'ok') expect(textOf(response.parts).trim()).not.toBe('');
  });

  it('reports a model the server does not have as not found', async () => {
    const response = await ollama.generate(ask('Hello', { model: 'no-such-model:latest' }), {
      timeoutMs: 60_000,
    });
    expect(response).toMatchObject({ status: 'error', code: 'not_found' });
  });

  it('is not called at all until the install lists it', async () => {
    expect(await unlisted.generate(ask('Hello'))).toEqual({
      status: 'error',
      code: 'blocked_address',
      usage: null,
    });
  });
});
