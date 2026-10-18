import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import * as publicContracts from './index.js';
import {
  aiConnection,
  aiConnectionSaved,
  aiConnectionTest,
  aiModelPrice,
  aiSettings,
  aiSettingsEndpoints,
  aiTestOutcomes,
  aiUsage,
  connectAiProviderInput,
  setAiModelPriceInput,
  updateAiConnectionInput,
  updateAiSettingsInput,
} from './ai.js';
import { parseInput } from './validation.js';

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';
const connectionId = toPublicId('ai_connection', UUID);
const testId = toPublicId('ai_connection_test', UUID);
const callId = toPublicId('ai_request', UUID);
const at = '2026-10-10T09:00:00.000Z';
// Made up for this file: no provider issued it.
const KEY = 'sk-ant-fixture-0000000000000000a1f3';

it('exports every AI settings endpoint through the canonical contract package', () => {
  expect(aiSettingsEndpoints.map((endpoint) => endpoint.operationId)).toEqual([
    'listAiConnections',
    'connectAiProvider',
    'updateAiConnection',
    'startAiConnectionTest',
    'getAiConnectionTest',
    'removeAiConnection',
    'getAiSettings',
    'updateAiSettings',
    'getAiUsage',
    'listAiModelPrices',
    'setAiModelPrice',
    'removeAiModelPrice',
  ]);
  for (const endpoint of aiSettingsEndpoints) {
    expect(publicContracts).toHaveProperty(endpoint.operationId, endpoint);
    expect(publicContracts.endpoints).toContain(endpoint);
    expect(endpoint.group).toBe('AI');
    expect(endpoint.path.startsWith('/ai/')).toBe(true);
  }
});

describe('connecting a provider', () => {
  it('takes a key for Claude, a key and a model for OpenAI, and an address and a model for a server of one’s own', () => {
    expect(connectAiProviderInput.parse({ provider: 'anthropic', apiKey: KEY })).toEqual({
      provider: 'anthropic',
      apiKey: KEY,
    });
    expect(
      connectAiProviderInput.parse({ provider: 'openai', apiKey: KEY, model: ' gpt-fixture ' }),
    ).toEqual({ provider: 'openai', apiKey: KEY, model: 'gpt-fixture' });
    expect(
      connectAiProviderInput.parse({
        provider: 'openai_compatible',
        baseUrl: ' http://ollama:11434/v1 ',
        model: 'qwen2.5:0.5b',
      }),
    ).toEqual({
      provider: 'openai_compatible',
      baseUrl: 'http://ollama:11434/v1',
      model: 'qwen2.5:0.5b',
    });
  });

  it.each([
    ['a provider there is no adapter for', { provider: 'gemini', apiKey: KEY }],
    ['Claude with no key', { provider: 'anthropic' }],
    [
      'Claude with an address',
      { provider: 'anthropic', apiKey: KEY, baseUrl: 'https://x.example' },
    ],
    ['Claude with a model', { provider: 'anthropic', apiKey: KEY, model: 'claude-opus-5-5' }],
    ['OpenAI with no model', { provider: 'openai', apiKey: KEY }],
    [
      'OpenAI with an address',
      { provider: 'openai', apiKey: KEY, model: 'm', baseUrl: 'https://x.example' },
    ],
    ['a server with no address', { provider: 'openai_compatible', model: 'm' }],
    [
      'a server with no model',
      { provider: 'openai_compatible', baseUrl: 'http://ollama:11434/v1' },
    ],
    [
      'a server with an empty key',
      { provider: 'openai_compatible', baseUrl: 'http://o:1/v1', model: 'm', apiKey: '' },
    ],
    ['a field nobody asked for', { provider: 'anthropic', apiKey: KEY, label: 'Mine' }],
  ])('refuses %s', (_name, input) => {
    expect(connectAiProviderInput.safeParse(input).success).toBe(false);
  });

  it.each([
    ['a space inside', 'sk-ant fixture'],
    ['a line break at its end', `${KEY}\n`],
    ['a carriage return and line break', `${KEY}\r\nx-injected: 1`],
    ['a tab', `${KEY}\t`],
    ['a letter outside ASCII', 'sk-ant-fixturé'],
    ['more than 500 characters', 'k'.repeat(501)],
  ])('refuses a key with %s, which no HTTP header could carry', (_name, apiKey) => {
    const result = connectAiProviderInput.safeParse({ provider: 'anthropic', apiKey });
    expect(result.success).toBe(false);
  });

  it('says what is wrong with a key in words, and never repeats the key', () => {
    const typed = `${KEY} `;
    let message = '';
    try {
      parseInput(connectAiProviderInput, { provider: 'anthropic', apiKey: typed });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('A key has no spaces or line breaks. Paste it again, on its own.');
    expect(message).not.toContain(KEY);
  });

  it.each([
    ['a space', 'claude sonnet'],
    ['a line break', 'claude\nsonnet'],
    ['nothing', '   '],
    ['more than 200 characters', 'm'.repeat(201)],
  ])('refuses a model name with %s', (_name, model) => {
    expect(
      connectAiProviderInput.safeParse({ provider: 'openai', apiKey: KEY, model }).success,
    ).toBe(false);
  });

  it('marks the key write-only in the API reference', () => {
    const schema = z.toJSONSchema(connectAiProviderInput, { io: 'input' });
    expect(JSON.stringify(schema)).toContain('"writeOnly":true');
  });
});

describe('changing a connection', () => {
  it('takes a new key, a new address, a new model, or the removal of a key', () => {
    expect(updateAiConnectionInput.parse({ apiKey: KEY })).toEqual({ apiKey: KEY });
    expect(updateAiConnectionInput.parse({ apiKey: null })).toEqual({ apiKey: null });
    expect(updateAiConnectionInput.parse({ baseUrl: 'https://models.example/v1' })).toEqual({
      baseUrl: 'https://models.example/v1',
    });
    expect(updateAiConnectionInput.parse({ model: 'llama3.2' })).toEqual({ model: 'llama3.2' });
  });

  it('refuses a change of nothing, and a field it does not know', () => {
    expect(updateAiConnectionInput.safeParse({}).success).toBe(false);
    expect(updateAiConnectionInput.safeParse({ provider: 'openai' }).success).toBe(false);
    expect(updateAiConnectionInput.safeParse({ apiKey: 'with space' }).success).toBe(false);
  });
});

describe('what the API says of a connection', () => {
  const connection = {
    id: connectionId,
    provider: 'anthropic',
    owner: 'business',
    canManage: true,
    hasKey: true,
    keyLast4: 'a1f3',
    baseUrl: null,
    model: null,
    status: 'working',
    lastTest: { outcome: 'ok', at, latencyMs: 812 },
    addedBy: 'Dana Brooks',
    createdAt: at,
  };

  it('has no field a key could be in: an answer that carried one would not parse', () => {
    expect(aiConnection.parse(connection)).toEqual(connection);
    for (const name of ['apiKey', 'key', 'secret', 'secretId'])
      expect(aiConnection.safeParse({ ...connection, [name]: KEY }).success).toBe(false);
    expect(Object.keys(aiConnection.shape)).toEqual([
      'id',
      'provider',
      'owner',
      'canManage',
      'hasKey',
      'keyLast4',
      'baseUrl',
      'model',
      'status',
      'lastTest',
      'addedBy',
      'createdAt',
    ]);
  });

  it('describes a test that is waiting, one that called a model, and one that only checked the key', () => {
    const pending = {
      id: testId,
      connectionId,
      kind: 'model_call',
      status: 'pending',
      outcome: null,
      latencyMs: null,
      call: null,
      createdAt: at,
      finishedAt: null,
    };
    expect(aiConnectionTest.parse(pending)).toEqual(pending);
    const called = {
      ...pending,
      status: 'finished',
      outcome: 'ok',
      latencyMs: 812,
      call: { id: callId, costEstimate: '0.000100' },
      finishedAt: at,
    };
    expect(aiConnectionTest.parse(called)).toEqual(called);
    // A call to a model nobody has priced: the cost is unknown, which is not nothing.
    expect(
      aiConnectionTest.parse({ ...called, call: { id: callId, costEstimate: null } }).call,
    ).toEqual({ id: callId, costEstimate: null });
    expect(aiConnectionTest.parse({ ...called, kind: 'key_check', call: null }).kind).toBe(
      'key_check',
    );
    expect(aiConnectionSaved.parse({ connection, test: pending }).test.status).toBe('pending');
  });

  it('knows every way a test can end, each once', () => {
    expect(new Set(aiTestOutcomes).size).toBe(aiTestOutcomes.length);
    for (const outcome of aiTestOutcomes)
      expect(
        aiConnectionTest.safeParse({
          id: testId,
          connectionId,
          kind: 'model_call',
          status: 'finished',
          outcome,
          latencyMs: null,
          call: null,
          createdAt: at,
          finishedAt: at,
        }).success,
      ).toBe(true);
  });
});

describe('a business’s AI settings', () => {
  const input = {
    enabled: true,
    keySource: 'own',
    monthlyLimit: '50',
    atLimit: 'pause',
    maskContactDetails: true,
    requestLogDays: 30,
    backup: { provider: 'openai_compatible', model: 'llama3.2' },
    jobs: {
      automation_builder: null,
      replies: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      briefings: null,
      sorting: null,
    },
    revision: 'a'.repeat(64),
  };

  it('are saved whole, with the revision they were read at', () => {
    expect(updateAiSettingsInput.parse(input)).toEqual(input);
    expect(updateAiSettingsInput.parse({ ...input, monthlyLimit: null, backup: null })).toEqual({
      ...input,
      monthlyLimit: null,
      backup: null,
    });
  });

  it.each([
    ['no revision', { revision: undefined }],
    ['a limit below nothing', { monthlyLimit: '-1' }],
    ['a limit in words', { monthlyLimit: 'fifty' }],
    ['a limit as a number, which could lose cents', { monthlyLimit: 50 }],
    ['a limit finer than a hundredth of a cent', { monthlyLimit: '1.00001' }],
    ['a limit in scientific notation', { monthlyLimit: '1e9' }],
    ['a log kept for more than a year', { requestLogDays: 366 }],
    ['a log kept for part of a day', { requestLogDays: 1.5 }],
    ['a log kept for less than no days', { requestLogDays: -1 }],
    ['something else at the limit', { atLimit: 'stop' }],
    ['somebody else’s keys', { keySource: 'theirs' }],
    [
      'a backup on a provider there is no adapter for',
      { backup: { provider: 'gemini', model: 'm' } },
    ],
    ['a job missing', { jobs: { automation_builder: null, replies: null, briefings: null } }],
    ['a job nobody knows', { jobs: { ...input.jobs, search: null } }],
    [
      'a job’s model with no name',
      { jobs: { ...input.jobs, replies: { provider: 'openai', model: '' } } },
    ],
  ])('refuse %s', (_name, change) => {
    expect(updateAiSettingsInput.safeParse({ ...input, ...change }).success).toBe(false);
  });

  it('come back with each job’s model, what can be chosen, and no key', () => {
    const settings = {
      enabled: true,
      keySource: 'agency',
      monthlyLimit: '50.0000',
      atLimit: 'pause',
      maskContactDetails: false,
      requestLogDays: 30,
      backup: { provider: 'openai_compatible', model: 'llama3.2', readiness: 'price_needed' },
      jobs: [
        {
          job: 'replies',
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          isDefault: true,
          tested: false,
          readiness: 'ready',
        },
      ],
      models: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', priced: true }],
      limitReachedAt: null,
      revision: 'b'.repeat(64),
    };
    expect(aiSettings.parse(settings)).toEqual(settings);
    expect(aiSettings.safeParse({ ...settings, apiKey: KEY }).success).toBe(false);
  });
});

describe('spend and prices', () => {
  it('reports a month’s spend with the calls whose cost nobody knows counted apart', () => {
    const usage = {
      month: '2026-10',
      spent: '18.400000',
      calls: 412,
      unknownCostCalls: 3,
      limit: '50.0000',
      byJob: [{ job: 'replies', spent: '7.800000', calls: 300, unknownCostCalls: 0 }],
      recent: [
        {
          id: callId,
          startedAt: at,
          job: 'connection_test',
          provider: 'openai_compatible',
          model: 'llama3.2',
          keySource: 'own',
          status: 'ok',
          errorCode: null,
          costEstimate: null,
          latencyMs: 640,
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
    };
    expect(aiUsage.parse(usage)).toEqual(usage);
    // Nothing of what was said in a call has a place here.
    const [first] = usage.recent;
    expect(
      aiUsage.safeParse({ ...usage, recent: [{ ...first, log: { request: 'Hello' } }] }).success,
    ).toBe(false);
  });

  it('takes a price as exact text, zero included, and says where it came from', () => {
    const price = {
      provider: 'openai_compatible',
      model: 'llama3.2',
      inputPerMtok: '0',
      outputPerMtok: '0',
      source: 'Runs on our own server',
    };
    expect(setAiModelPriceInput.parse(price)).toEqual(price);
    expect(
      setAiModelPriceInput.parse({
        ...price,
        inputPerMtok: '2.50',
        cacheReadPerMtok: '0.25',
        cacheWritePerMtok: '3.125',
        cacheWrite1hPerMtok: '5',
      }),
    ).toMatchObject({
      cacheReadPerMtok: '0.25',
      cacheWritePerMtok: '3.125',
      cacheWrite1hPerMtok: '5',
    });
    expect(setAiModelPriceInput.safeParse({ ...price, cacheWrite1hPerMtok: '-2' }).success).toBe(
      false,
    );
    for (const change of [
      { inputPerMtok: '-1' },
      { inputPerMtok: 2.5 },
      { outputPerMtok: '1.0000001' },
      { outputPerMtok: 'free' },
      { source: '  ' },
      { source: 'two\nlines' },
      { provider: 'gemini' },
      { model: 'has space' },
    ])
      expect(setAiModelPriceInput.safeParse({ ...price, ...change }).success).toBe(false);
  });

  it('lists a price with no id when it is one shipped with the product', () => {
    const shipped = {
      shipped: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputPerMtok: '2.000000',
      outputPerMtok: '10.000000',
      cacheReadPerMtok: '0.100000',
      cacheWritePerMtok: '2.500000',
      cacheWrite1hPerMtok: '4.000000',
      source: 'https://platform.claude.com/docs/en/about-claude/pricing',
      checkedOn: '2026-10-14',
    };
    expect(aiModelPrice.parse(shipped)).toEqual(shipped);
    expect(aiModelPrice.parse({ ...shipped, shipped: false }).shipped).toBe(false);
    // A model with no price for the hour's cache says so, rather than leaving it out.
    expect(aiModelPrice.parse({ ...shipped, cacheWrite1hPerMtok: null })).toMatchObject({
      cacheWrite1hPerMtok: null,
    });
    const { cacheWrite1hPerMtok: _hour, ...withoutHour } = shipped;
    expect(aiModelPrice.safeParse(withoutHour).success).toBe(false);
    // A price is named by what it prices; it has no id of its own.
    expect(aiModelPrice.safeParse({ ...shipped, id: 'x' }).success).toBe(false);
  });
});
