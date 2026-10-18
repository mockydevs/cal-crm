import { afterEach, describe, expect, it } from 'vitest';

import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from '../../test/fake-anthropic.js';
import type { FakeProvider } from '../../test/fake-provider.js';
import { parseLocalServers } from '../addresses.js';
import { dollarsToMicros } from '../pricing.js';
import { datasetHash } from './dataset.js';
import { createEvalGateway } from './eval-gateway.js';
import { says, scriptedReport } from './fixtures/scripted.js';
import { FIXTURE_CASES, fixtureSuite } from './fixtures/suite.js';
import { makeWorkspace } from './fixtures/workspace.js';
import { EvalDataError } from './read.js';
import {
  buildReport,
  parseReport,
  readReportFile,
  REPORT_FORMAT,
  reportPath,
  serializeReport,
  type RunReport,
} from './report.js';
import { runSuite } from './runner.js';
import type { EvalSuite } from './types.js';

const suite: EvalSuite = { ...fixtureSuite(), cases: FIXTURE_CASES };
const FILE = 'evals/reports/replies/anthropic--claude-sonnet-5-5.json';

const fakes: FakeProvider[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

/** The report as JSON a person could edit, and the text of it again. */
function edited(report: RunReport, change: (draft: Record<string, unknown>) => void): string {
  const draft = JSON.parse(serializeReport(report)) as Record<string, unknown>;
  change(draft);
  return JSON.stringify(draft);
}
function firstCase(draft: Record<string, unknown>): Record<string, unknown> {
  const [first] = draft['cases'] as Record<string, unknown>[];
  if (first === undefined) throw new Error('The report has no case.');
  return first;
}
function firstCall(draft: Record<string, unknown>): Record<string, unknown> {
  const [first] = firstCase(draft)['calls'] as Record<string, unknown>[];
  if (first === undefined) throw new Error('The case has no call.');
  return first;
}
function refusal(text: string): string {
  try {
    parseReport(text, FILE);
  } catch (error) {
    if (error instanceof EvalDataError) return error.message;
    throw error;
  }
  throw new Error('Expected the report to be refused.');
}

describe('a run report', () => {
  it('says what was run, against what, and how it went', async () => {
    const report = await scriptedReport(suite);
    expect(report).toMatchObject({
      format: REPORT_FORMAT,
      job: 'replies',
      suiteVersion: 'fixture/1',
      datasetHash: datasetHash(FIXTURE_CASES),
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      mode: 'live',
      startedAt: '2026-10-10T08:00:00.000Z',
      finishedAt: '2026-10-10T08:00:01.000Z',
      threshold: 0.75,
      total: 4,
      passed: 3,
      score: 0.75,
      pass: true,
      complete: true,
      budgetUsd: '1.000000',
      spendUsd: '0.000000',
      masked: false,
    });
    expect(report.cases).toHaveLength(4);
  });

  it('is written with its keys in one order, so writing it again changes no byte', async () => {
    const report = await scriptedReport(suite);
    const text = serializeReport(report);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'format',
      'job',
      'suiteVersion',
      'datasetHash',
      'provider',
      'model',
      'mode',
      'startedAt',
      'finishedAt',
      'threshold',
      'total',
      'passed',
      'score',
      'pass',
      'complete',
      'budgetUsd',
      'spendUsd',
      'masked',
      'cases',
    ]);
    const read = parseReport(text, FILE);
    expect(read).toEqual(report);
    expect(serializeReport(read)).toBe(text);

    // The same report with every object's keys the other way round.
    const reversed = JSON.parse(text, (_key, value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ) as unknown;
    expect(serializeReport(parseReport(JSON.stringify(reversed), FILE))).toBe(text);
  });

  it('keeps an error with the case it ended, and reads it back', async () => {
    const report = await scriptedReport(suite, {
      answer: (_request, caseId) =>
        caseId === 'greets' ? { outcome: 'failed', code: 'rate_limited' } : says('Hello!'),
    });
    expect(report).toMatchObject({ complete: false, pass: false });
    const read = parseReport(serializeReport(report), FILE);
    expect(read.cases[0]?.error).toEqual({ category: 'provider_error', code: 'rate_limited' });
    expect(read).toEqual(report);
  });

  it('holds no key and no address after a run against a provider', async () => {
    const fake = await startFakeAnthropic();
    fakes.push(fake);
    const session = createEvalGateway({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      budgetMicros: dollarsToMicros('1'),
      apiKey: FAKE_ANTHROPIC_KEY,
      baseUrls: { anthropic: fake.origin },
      localServers: parseLocalServers(fake.hostPort),
    });
    const result = await runSuite(suite, session);
    const text = serializeReport(
      buildReport({
        suite,
        result,
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        mode: 'live',
        startedAt: new Date(0),
        finishedAt: new Date(1),
        budgetMicros: dollarsToMicros('1'),
        spentMicros: session.spentMicros(),
        masked: false,
      }),
    );
    expect(fake.requests).toHaveLength(4);
    expect(text).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(text).not.toContain('sk-ant');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(fake.hostPort);
    const report = parseReport(text, FILE);
    expect(report).toMatchObject({ passed: 3, score: 0.75, pass: true, complete: true });
    expect(dollarsToMicros(report.spendUsd)).toBe(session.spentMicros());
    expect(report.cases[0]?.usage.outputTokens).toBeGreaterThan(0);
    expect(report.cases.map((each) => dollarsToMicros(each.costUsd)).reduce((a, b) => a + b)).toBe(
      session.spentMicros(),
    );
  });
});

describe('where a report is kept', () => {
  it('is named for its job, provider and model', () => {
    expect(reportPath('replies', 'anthropic', 'claude-sonnet-5-5')).toBe(FILE);
  });

  it('writes a model id safe for a file name, and never two ids as one name', () => {
    expect(reportPath('sorting', 'openai_compatible', 'qwen2.5:0.5b')).toBe(
      'evals/reports/sorting/openai_compatible--qwen2.5~3a0.5b.json',
    );
    const names = ['org/model', 'org_model', 'org:model', 'org@model', 'org+model', 'ORG/model'];
    const paths = names.map((model) => reportPath('sorting', 'openai_compatible', model));
    // Small letters only: a file system may not tell capitals from small letters.
    expect(new Set(paths).size).toBe(names.length);
    for (const path of paths) expect(path).toMatch(/^evals\/reports\/sorting\/[a-z0-9._~-]+$/);
    expect(reportPath('sorting', 'openai_compatible', 'Qwen/Q')).toBe(
      'evals/reports/sorting/openai_compatible--~51wen~2f~51.json',
    );
  });
});

describe('reading a report', () => {
  it('refuses a file that is not JSON, or not a report', () => {
    expect(refusal('{')).toBe(`${FILE}: the file is not JSON.`);
    expect(refusal('[]')).toBe(`${FILE}: a report must be an object.`);
  });

  it.each<[string, (draft: Record<string, unknown>) => void, string]>([
    ['another format', (draft) => (draft['format'] = 2), 'this harness reads format 1.'],
    [
      'a field it does not have',
      (draft) => (draft['note'] = 'x'),
      '"note" is not a field of a report.',
    ],
    ['no job', (draft) => delete draft['job'], '"job" must be'],
    [
      'a provider the harness cannot call',
      (draft) => (draft['provider'] = 'gemini'),
      '"provider" must be one of',
    ],
    ['a model id that is not one', (draft) => (draft['model'] = 'a b'), '"model" must be'],
    [
      'a mode it does not know',
      (draft) => (draft['mode'] = 'dry'),
      '"mode" must be "live" or "replay".',
    ],
    [
      'a hash that is not one',
      (draft) => (draft['datasetHash'] = 'abc'),
      '"datasetHash" must be a SHA-256',
    ],
    [
      'a time that is not one',
      (draft) => (draft['startedAt'] = 'yesterday'),
      '"startedAt" must be a time',
    ],
    [
      'a score above one',
      (draft) => (draft['score'] = 1.5),
      '"score" must be a number from 0 to 1.',
    ],
    [
      'a threshold of zero',
      (draft) => (draft['threshold'] = 0),
      '"threshold" must be above 0 and at most 1.',
    ],
    [
      'a count that is not whole',
      (draft) => (draft['passed'] = 2.5),
      '"passed" must be a whole number from 0.',
    ],
    [
      'a verdict that is not true or false',
      (draft) => (draft['pass'] = 'yes'),
      '"pass" must be true or false.',
    ],
    [
      'a budget that is not an amount',
      (draft) => (draft['budgetUsd'] = 1),
      '"budgetUsd" must be an amount',
    ],
    [
      'a spend that is not an amount',
      (draft) => (draft['spendUsd'] = '1.0000001'),
      '"spendUsd" must be an amount',
    ],
    ['no cases', (draft) => (draft['cases'] = []), '"cases" must be a list of at least one case.'],
    [
      'a case that is not an object',
      (draft) => (draft['cases'] = [1]),
      'case 1 (by position) must be an object.',
    ],
    [
      'a case with no id',
      (draft) => delete firstCase(draft)['id'],
      'case 1 (by position): "id" must be',
    ],
    [
      'a case twice',
      (draft) => (draft['cases'] = [firstCase(draft), firstCase(draft)]),
      'case "greets": the id is used twice.',
    ],
    [
      'a case with a field it does not have',
      (draft) => (firstCase(draft)['x'] = 1),
      'case "greets": "x" is not a field of a case.',
    ],
    [
      'an output that is not an object',
      (draft) => (firstCase(draft)['output'] = 'Hello'),
      'case "greets": "output" must be an object or null.',
    ],
    [
      'a latency that is not a count',
      (draft) => (firstCase(draft)['latencyMs'] = -1),
      'case "greets": "latencyMs" must be',
    ],
    [
      'a cost that is not an amount',
      (draft) => (firstCase(draft)['costUsd'] = 'free'),
      'case "greets": "costUsd" must be an amount',
    ],
    [
      'usage that is not counts',
      (draft) => (firstCase(draft)['usage'] = { inputTokens: -1 }),
      'case "greets": usage: "inputTokens" must be',
    ],
    [
      'checks that are not a list',
      (draft) => (firstCase(draft)['checks'] = {}),
      'case "greets": "checks" must be a list.',
    ],
    [
      'a check result that is not one',
      (draft) =>
        (firstCase(draft)['checks'] = [
          { type: 'contains', target: 'text', pass: 'yes', reason: 'ok' },
        ]),
      'case "greets": checks[0]: "pass" must be true or false.',
    ],
    [
      'an error it does not know',
      (draft) => (firstCase(draft)['error'] = { category: 'cosmic_rays' }),
      'case "greets": error: "category" must be one of',
    ],
    [
      'a provider error it does not know',
      (draft) => (firstCase(draft)['error'] = { category: 'provider_error', code: 'gremlins' }),
      'case "greets": error: "code" must be one of',
    ],
    [
      'calls that are not a list',
      (draft) => (firstCase(draft)['calls'] = 'none'),
      'case "greets": "calls" must be a list.',
    ],
    [
      'a call that is not an object',
      (draft) => (firstCase(draft)['calls'] = [1]),
      'case "greets": calls[0] must be an object.',
    ],
    [
      'a call with no hash',
      (draft) => (firstCall(draft)['request'] = 'abc'),
      'case "greets": calls[0]: "request" must be a SHA-256',
    ],
    [
      'a call with no count of attempts',
      (draft) => delete firstCall(draft)['attempts'],
      'calls[0]: "attempts" must be',
    ],
    [
      'a call cost that is not an amount',
      (draft) => (firstCall(draft)['cost'] = 5),
      'calls[0]: "cost" must be an amount',
    ],
    [
      'a call usage that is not counts',
      (draft) => (firstCall(draft)['usage'] = []),
      'calls[0]: "usage" must be an object or null.',
    ],
    [
      'a result that is not an object',
      (draft) => (firstCall(draft)['result'] = 'ok'),
      'calls[0]: "result" must be an object.',
    ],
    [
      'an outcome the eval gateway never gives',
      (draft) => (firstCall(draft)['result'] = { outcome: 'off' }),
      'calls[0]: result: "outcome" must be one of',
    ],
    [
      'an answer with no reason to stop',
      (draft) => (firstCall(draft)['result'] = { outcome: 'ok', parts: [] }),
      'calls[0]: result: "stop" must be one of',
    ],
    [
      'parts that are not a list',
      (draft) => (firstCall(draft)['result'] = { outcome: 'ok', parts: 'Hello', stop: 'end' }),
      'calls[0]: result: "parts" must be a list.',
    ],
    [
      'a part of no known kind',
      (draft) =>
        (firstCall(draft)['result'] = { outcome: 'ok', parts: [{ type: 'image' }], stop: 'end' }),
      'calls[0]: result: parts[0]: "type" must be one of',
    ],
    [
      'a text part with no text',
      (draft) =>
        (firstCall(draft)['result'] = { outcome: 'ok', parts: [{ type: 'text' }], stop: 'end' }),
      'calls[0]: result: parts[0]: "text" must be text.',
    ],
    [
      'a tool call with no input',
      (draft) =>
        (firstCall(draft)['result'] = {
          outcome: 'ok',
          parts: [{ type: 'tool_call', id: 'a', name: 'b' }],
          stop: 'tool_calls',
        }),
      'calls[0]: result: parts[0]: "input" must be an object.',
    ],
    [
      'thinking from a provider it does not know',
      (draft) =>
        (firstCall(draft)['result'] = {
          outcome: 'ok',
          parts: [{ type: 'reasoning', provider: 'acme', data: {} }],
          stop: 'end',
        }),
      'calls[0]: result: parts[0]: "provider" must be one of',
    ],
    [
      'a refusal with a category that is not text',
      (draft) => (firstCall(draft)['result'] = { outcome: 'refused', category: 7 }),
      'calls[0]: result: "category" must be text or null.',
    ],
    [
      'a failure of no known kind',
      (draft) => (firstCall(draft)['result'] = { outcome: 'failed', code: 'gremlins' }),
      'calls[0]: result: "code" must be one of',
    ],
    [
      'a pause for no known reason',
      (draft) => (firstCall(draft)['result'] = { outcome: 'paused', reason: 'tired' }),
      'calls[0]: result: "reason" must be one of',
    ],
    [
      'a result with a field it does not have',
      (draft) => (firstCall(draft)['result'] = { outcome: 'failed', code: 'timeout', apiKey: 'x' }),
      'calls[0]: result: "apiKey" is not a field of a recorded result.',
    ],
  ])('refuses %s', async (_name, change, message) => {
    const said = refusal(edited(await scriptedReport(suite), change));
    expect(said.startsWith(`${FILE}: `)).toBe(true);
    expect(said).toContain(message);
  });

  it('reads every kind of recorded answer', async () => {
    const report = await scriptedReport(suite);
    const results = [
      {
        outcome: 'ok',
        parts: [
          {
            type: 'reasoning',
            provider: 'anthropic',
            data: { type: 'thinking', thinking: '', signature: 's' },
          },
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_call', id: 'toolu_1', name: 'find_contacts', input: { limit: 5 } },
        ],
        stop: 'tool_calls',
      },
      { outcome: 'ok', parts: [], stop: 'max_tokens' },
      { outcome: 'refused', category: 'cyber' },
      { outcome: 'refused', category: null },
      { outcome: 'failed', code: 'unavailable' },
      { outcome: 'paused', reason: 'limit_reached' },
    ];
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    const text = edited(report, (draft) => {
      firstCase(draft)['calls'] = results.map((result) => ({
        request: 'a'.repeat(64),
        attempts: 1,
        usage,
        cost: '0.000001',
        result,
      }));
    });
    expect(parseReport(text, FILE).cases[0]?.calls.map((call) => call.result)).toEqual(results);
  });

  it('never repeats what a report holds in its message', async () => {
    const said = refusal(
      edited(
        await scriptedReport(suite),
        (draft) => (firstCase(draft)['output'] = 'private words'),
      ),
    );
    expect(said).not.toContain('private');
  });
});

describe('reading the rarer shapes of a report', () => {
  const answer = (part: unknown): unknown => ({ outcome: 'ok', parts: [part], stop: 'end' });

  it.each<[string, (draft: Record<string, unknown>) => void, string]>([
    [
      'a part that is not an object',
      (draft) => (firstCall(draft)['result'] = answer('Hello')),
      'calls[0]: result: parts[0] must be an object.',
    ],
    [
      'a tool call with no id',
      (draft) => (firstCall(draft)['result'] = answer({ type: 'tool_call', name: 'b', input: {} })),
      'calls[0]: result: parts[0]: "id" must be text.',
    ],
    [
      'a tool call with no name',
      (draft) => (firstCall(draft)['result'] = answer({ type: 'tool_call', id: 'a', input: {} })),
      'calls[0]: result: parts[0]: "name" must be text.',
    ],
    [
      'thinking that is not an object',
      (draft) =>
        (firstCall(draft)['result'] = answer({
          type: 'reasoning',
          provider: 'anthropic',
          data: '',
        })),
      'calls[0]: result: parts[0]: "data" must be an object.',
    ],
    [
      'a check result that is not an object',
      (draft) => (firstCase(draft)['checks'] = ['ok']),
      'case "greets": checks[0] must be an object.',
    ],
    [
      'an error that is not an object',
      (draft) => (firstCase(draft)['error'] = 'timeout'),
      'case "greets": "error" must be an object.',
    ],
  ])('refuses %s', async (_name, change, message) => {
    expect(refusal(edited(await scriptedReport(suite), change))).toContain(message);
  });

  it('keeps a pause with the case it ended, with no code', async () => {
    const report = await scriptedReport(suite, {
      answer: () => ({ outcome: 'paused', reason: 'limit_reached' }),
    });
    const read = parseReport(serializeReport(report), FILE);
    expect(read.cases.map((each) => each.error)).toEqual(
      FIXTURE_CASES.map(() => ({ category: 'paused' })),
    );
    expect(read).toMatchObject({ passed: 0, score: 0, complete: false, pass: false });
  });

  it('reads a report from its file, and says when there is none', async () => {
    const made = makeWorkspace();
    try {
      const report = await scriptedReport(suite);
      const path = made.write('report.json', serializeReport(report));
      expect(readReportFile(path, 'report.json')).toEqual(report);
      expect(() => readReportFile(`${path}.missing`, 'elsewhere.json')).toThrow(
        'elsewhere.json: the report is missing.',
      );
    } finally {
      made.remove();
    }
  });
});
