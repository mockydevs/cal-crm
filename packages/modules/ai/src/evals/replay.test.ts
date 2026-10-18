import { describe, expect, it } from 'vitest';

import type { GatewayRequest } from '../gateway.js';
import { says, scriptedReport } from './fixtures/scripted.js';
import { FIXTURE_CASES, FIXTURE_SYSTEM, fixtureSuite } from './fixtures/suite.js';
import { requestHash, StaleRecordingError, toGatewayResult } from './recording.js';
import { createReplaySession } from './replay.js';
import { parseReport, serializeReport, type RunReport } from './report.js';
import { EVAL_CONTEXT, runSuite, type RunResult } from './runner.js';
import type { EvalSuite } from './types.js';

const suite: EvalSuite = { ...fixtureSuite(), cases: FIXTURE_CASES };
const replay = (report: RunReport, replayed: EvalSuite = suite): Promise<RunResult> =>
  runSuite(replayed, createReplaySession(report));

const request: GatewayRequest = {
  job: 'replies',
  promptVersion: 'fixture/1',
  system: 'Greet the person.',
  messages: [{ role: 'user', text: 'Hi' }],
  maxOutputTokens: 64,
};

describe('the hash of a request', () => {
  it('is the same whatever order its keys are in, with no tools or an empty list of them', () => {
    const reordered: GatewayRequest = {
      maxOutputTokens: 64,
      messages: [{ text: 'Hi', role: 'user' }],
      tools: [],
      system: 'Greet the person.',
      promptVersion: 'fixture/1',
      job: 'replies',
    };
    expect(requestHash(reordered)).toBe(requestHash(request));
    expect(requestHash(request)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, Partial<GatewayRequest>]>([
    ['the job', { job: 'sorting' }],
    ['the prompt version', { promptVersion: 'fixture/2' }],
    ['one character of the prompt', { system: 'Greet the person!' }],
    ['a message', { messages: [{ role: 'user', text: 'Hi.' }] }],
    ['a tool', { tools: [{ name: 'find', description: '', inputSchema: { type: 'object' } }] }],
    ['the token limit', { maxOutputTokens: 65 }],
  ])('changes with %s', (_name, change) => {
    expect(requestHash({ ...request, ...change })).not.toBe(requestHash(request));
  });
});

describe("a recorded call as the gateway's result", () => {
  const where = {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    requestId: 'eval-a-1',
  } as const;
  const usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it('is the answer with its text, its usage and its cost in millionths', () => {
    expect(
      toGatewayResult(
        { request: 'x', attempts: 1, usage, cost: '0.000123', result: says('Hello!') },
        where,
      ),
    ).toEqual({
      outcome: 'ok',
      parts: [{ type: 'text', text: 'Hello!' }],
      text: 'Hello!',
      stop: 'end',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      usedBackup: false,
      usage,
      costMicros: 123n,
      requestId: 'eval-a-1',
    });
  });

  it('is a refusal, a failure or a pause as it was recorded', () => {
    const call = { request: 'x', attempts: 1, usage: null, cost: null };
    expect(
      toGatewayResult({ ...call, result: { outcome: 'refused', category: 'cyber' } }, where),
    ).toEqual({
      outcome: 'refused',
      category: 'cyber',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      requestId: 'eval-a-1',
    });
    expect(
      toGatewayResult({ ...call, result: { outcome: 'failed', code: 'timeout' } }, where),
    ).toEqual({ outcome: 'failed', code: 'timeout', requestId: 'eval-a-1' });
    expect(
      toGatewayResult({ ...call, result: { outcome: 'paused', reason: 'limit_reached' } }, where),
    ).toEqual({ outcome: 'paused', reason: 'limit_reached' });
    expect(toGatewayResult({ ...call, result: says('Hi') }, where)).toMatchObject({
      usage: null,
      costMicros: null,
    });
  });
});

describe('replaying a report', () => {
  it('reproduces each case from its recording: the same outputs, checks and verdicts', async () => {
    const report = await scriptedReport(suite);
    // From the file, as the gate reads it.
    const read = parseReport(serializeReport(report), 'report.json');
    const result = await replay(read);
    expect(result).toMatchObject({ total: 4, passed: 3, score: 0.75, complete: true, pass: true });
    const comparable = (cases: RunReport['cases']): unknown =>
      cases.map(({ latencyMs: _latency, ...rest }) => rest);
    expect(comparable(result.cases)).toEqual(comparable(report.cases));
  });

  it('gives the suite the recorded answer as the gateway gave it', async () => {
    const report = await scriptedReport(suite, { answer: () => says('Hello Amina!') });
    const session = createReplaySession(report);
    session.begin('uses-the-name');
    const result = await fixtureSuite().run(
      { id: 'uses-the-name', input: { message: 'I am Amina' }, expect: [] },
      { gateway: session, context: EVAL_CONTEXT },
    );
    expect(result).toMatchObject({ outcome: 'ok', text: 'Hello Amina!' });
    expect(session.end()).toMatchObject({ stale: false, costMicros: 0n });
  });

  it('is stale when the prompt changed by one character since the model was evaluated', async () => {
    const report = await scriptedReport(suite);
    const changed: EvalSuite = {
      ...fixtureSuite({ system: `${FIXTURE_SYSTEM}.` }),
      cases: FIXTURE_CASES,
    };
    const result = await replay(report, changed);
    expect(result).toMatchObject({ passed: 0, complete: false, pass: false });
    expect(result.cases.map((each) => each.error)).toEqual(
      FIXTURE_CASES.map(() => ({ category: 'stale' })),
    );
  });

  it('is stale when the suite now makes a call the recording does not have', async () => {
    const report = await scriptedReport(suite);
    const twice: EvalSuite = {
      ...suite,
      async run(evalCase, tools) {
        await fixtureSuite().run(evalCase, tools);
        return fixtureSuite().run(evalCase, tools);
      },
    };
    const result = await replay(report, twice);
    expect(result.cases.every((each) => each.error?.category === 'stale')).toBe(true);
  });

  it('is stale when the suite no longer makes a call that was recorded', async () => {
    const report = await scriptedReport(suite);
    const silent: EvalSuite = {
      ...suite,
      run: () => Promise.resolve({ outcome: 'ok', text: 'Hello Amina!', stop: 'end' }),
    };
    const result = await replay(report, silent);
    expect(result).toMatchObject({ passed: 0, pass: false });
    expect(result.cases.every((each) => each.error?.category === 'stale')).toBe(true);
  });

  it('is stale even when the suite swallows the refusal to answer', async () => {
    const report = await scriptedReport(suite);
    const swallowing: EvalSuite = {
      ...fixtureSuite({ system: 'Another prompt.' }),
      cases: FIXTURE_CASES,
      async run(evalCase, tools) {
        try {
          return await fixtureSuite({ system: 'Another prompt.' }).run(evalCase, tools);
        } catch {
          return { outcome: 'ok', text: 'Hello Amina!', stop: 'end' };
        }
      },
    };
    const result = await replay(report, swallowing);
    expect(result.cases.every((each) => each.error?.category === 'stale')).toBe(true);
  });

  it('is stale for a case the recording has never seen', async () => {
    const report = await scriptedReport(suite);
    const [first] = FIXTURE_CASES;
    if (first === undefined) throw new Error('The fixture has no case.');
    const grown: EvalSuite = { ...suite, cases: [...FIXTURE_CASES, { ...first, id: 'new-case' }] };
    const result = await replay(report, grown);
    expect(result.cases.map((each) => each.error?.category)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'stale',
    ]);
  });

  it('refuses a call it has no recording for with an error that says why', async () => {
    const report = await scriptedReport(suite);
    const session = createReplaySession(report);
    session.begin('greets');
    await expect(session.generate(EVAL_CONTEXT, request)).rejects.toThrow(StaleRecordingError);
    expect(session.end().stale).toBe(true);
    await expect(createReplaySession(report).generate(EVAL_CONTEXT, request)).rejects.toThrow(
      'The replay gateway was called outside a case.',
    );
    // Stopping changes nothing: a replay holds nothing open.
    session.stop();
  });
});
