import { describe, expect, it } from 'vitest';

import { says, scriptedSession } from './fixtures/scripted.js';
import { FIXTURE_CASES, fixtureSuite, type FixtureSuiteOptions } from './fixtures/suite.js';
import type { EvalSession, RecordedResult } from './recording.js';
import { EVAL_CONTEXT, runSuite, type CaseResult, type RunResult } from './runner.js';
import type { EvalSuite } from './types.js';

const suite = (options: FixtureSuiteOptions = {}): EvalSuite => ({
  ...fixtureSuite(options),
  cases: FIXTURE_CASES,
});

/** The stand-ins' answer, except where a case is given its own. */
const answers =
  (special: Readonly<Record<string, RecordedResult | Promise<RecordedResult>>> = {}) =>
  (_request: unknown, caseId: string): RecordedResult | Promise<RecordedResult> =>
    special[caseId] ?? says('Hello!');

function caseOf(result: RunResult, id: string): CaseResult {
  const found = result.cases.find((each) => each.id === id);
  if (found === undefined) throw new Error(`No case ${id}.`);
  return found;
}

describe('running a suite', () => {
  it('passes when every case passes, and keeps each output, check and call', async () => {
    const result = await runSuite(
      suite(),
      scriptedSession(answers({ 'uses-the-name': says('Hello Amina!') })),
    );
    expect(result).toMatchObject({ total: 4, passed: 4, score: 1, complete: true, pass: true });
    expect(result.cases.map((each) => each.id)).toEqual(FIXTURE_CASES.map((each) => each.id));
    const greets = caseOf(result, 'greets');
    expect(greets.pass).toBe(true);
    expect(greets.error).toBeUndefined();
    expect(greets.output).toEqual({ outcome: 'ok', text: 'Hello!', stop: 'end', toolCalls: [] });
    expect(greets.checks).toEqual([
      { type: 'contains', target: 'text', pass: true, reason: 'ok' },
      { type: 'length_at_most', target: 'text', pass: true, reason: 'ok' },
    ]);
    expect(greets.calls).toHaveLength(1);
    expect(greets.calls[0]?.request).toMatch(/^[0-9a-f]{64}$/);
    expect(greets.calls[0]?.result).toEqual(says('Hello!'));
  });

  it('passes exactly at its threshold', async () => {
    const result = await runSuite(suite({ threshold: 0.75 }), scriptedSession(answers()));
    expect(result).toMatchObject({ total: 4, passed: 3, score: 0.75, complete: true, pass: true });
    expect(caseOf(result, 'uses-the-name')).toMatchObject({
      pass: false,
      checks: [
        { type: 'contains', pass: false, reason: 'the text does not contain what was expected' },
      ],
    });
  });

  it('fails below its threshold', async () => {
    const result = await runSuite(suite({ threshold: 0.76 }), scriptedSession(answers()));
    expect(result).toMatchObject({ passed: 3, score: 0.75, complete: true, pass: false });
  });

  it('fails a case when one of its checks fails, though the others pass', async () => {
    const long = `Hello, ${'and welcome, '.repeat(5)}friend.`;
    const result = await runSuite(suite(), scriptedSession(answers({ greets: says(long) })));
    expect(caseOf(result, 'greets')).toMatchObject({
      pass: false,
      checks: [
        { type: 'contains', pass: true },
        { type: 'length_at_most', pass: false },
      ],
    });
    expect(result.passed).toBe(2);
  });

  it('is incomplete, and so cannot pass, when a case ends in a provider error', async () => {
    // Three of four pass, which is the threshold: only the failed call stands in the way.
    const result = await runSuite(
      suite({ threshold: 0.75 }),
      scriptedSession(answers({ 'uses-the-name': { outcome: 'failed', code: 'unavailable' } })),
    );
    expect(result).toMatchObject({ passed: 3, score: 0.75, complete: false, pass: false });
    expect(caseOf(result, 'uses-the-name')).toMatchObject({
      pass: false,
      error: { category: 'provider_error', code: 'unavailable' },
      checks: [],
      output: { outcome: 'failed' },
    });
  });

  it('is incomplete when a case was paused by the budget', async () => {
    const result = await runSuite(
      suite({ threshold: 0.5 }),
      scriptedSession(answers({ greets: { outcome: 'paused', reason: 'limit_reached' } })),
    );
    expect(result).toMatchObject({ passed: 2, complete: false, pass: false });
    expect(caseOf(result, 'greets').error).toEqual({ category: 'paused' });
  });

  it('counts a refusal as an answer: the run is complete and the case is scored', async () => {
    const result = await runSuite(
      suite(),
      scriptedSession(answers({ greets: { outcome: 'refused', category: null } })),
    );
    expect(result).toMatchObject({ passed: 2, complete: true, pass: false });
    expect(caseOf(result, 'greets')).toMatchObject({
      pass: false,
      output: { outcome: 'refused' },
      checks: [
        { type: 'contains', pass: false, reason: 'nothing is at this path' },
        { type: 'length_at_most', pass: false },
      ],
    });
    expect(caseOf(result, 'greets').error).toBeUndefined();
  });

  it('stops a case at its deadline, stops the model handle, and runs no case after it', async () => {
    let stopped = 0;
    const calls: string[] = [];
    const scripted = scriptedSession((_request, caseId) => {
      calls.push(caseId);
      return caseId === 'starts-politely'
        ? new Promise<RecordedResult>(() => undefined)
        : says('Hello!');
    });
    const session: EvalSession = {
      ...scripted,
      stop() {
        stopped += 1;
        scripted.stop();
      },
    };
    const result = await runSuite(suite({ threshold: 0.25 }), session, { caseTimeoutMs: 30 });
    expect(result).toMatchObject({ total: 4, passed: 1, complete: false, pass: false });
    expect(result.cases.map((each) => each.error?.category)).toEqual([
      undefined,
      'timeout',
      'not_run',
      'not_run',
    ]);
    expect(calls).toEqual(['greets', 'starts-politely']);
    expect(stopped).toBe(1);
    expect(caseOf(result, 'starts-politely')).toMatchObject({
      pass: false,
      output: null,
      checks: [],
    });
  });

  it('is incomplete when the suite itself fails, and says so to whoever listens', async () => {
    const told: [string, unknown][] = [];
    const broken: EvalSuite = {
      ...suite({ threshold: 0.5 }),
      async run(evalCase, tools) {
        if (evalCase.id === 'greets') throw new Error('The job broke.');
        if (evalCase.id === 'starts-politely') return JSON.parse('["not an object"]') as never;
        return fixtureSuite().run(evalCase, tools);
      },
    };
    const result = await runSuite(broken, scriptedSession(answers()), {
      onError: (caseId, error) => told.push([caseId, error]),
    });
    expect(result).toMatchObject({ passed: 1, complete: false, pass: false });
    expect(caseOf(result, 'greets')).toMatchObject({
      error: { category: 'run_error' },
      output: null,
    });
    expect(caseOf(result, 'starts-politely').error).toEqual({ category: 'run_error' });
    expect(told.map(([caseId]) => caseId)).toEqual(['greets', 'starts-politely']);
    expect(told[0]?.[1]).toBeInstanceOf(Error);
  });

  it('names the provider error, not the suite, when the suite fails because a call did', async () => {
    const throwing: EvalSuite = {
      ...suite(),
      async run(evalCase, tools) {
        const output = await fixtureSuite().run(evalCase, tools);
        if (output['outcome'] !== 'ok') throw new Error('No answer.');
        return output;
      },
    };
    const result = await runSuite(
      throwing,
      scriptedSession(answers({ greets: { outcome: 'failed', code: 'timeout' } })),
    );
    expect(caseOf(result, 'greets').error).toEqual({ category: 'provider_error', code: 'timeout' });
  });

  it('marks a case stale when the model handle says its recording no longer fits', async () => {
    const scripted = scriptedSession(answers());
    const session: EvalSession = {
      ...scripted,
      end: () => ({ ...scripted.end(), stale: true }),
    };
    const result = await runSuite(suite({ threshold: 0.25 }), session);
    expect(result).toMatchObject({ passed: 0, complete: false, pass: false });
    expect(result.cases.every((each) => each.error?.category === 'stale')).toBe(true);
  });

  it("gives the suite the context it was given, or the harness's own", async () => {
    const seen: unknown[] = [];
    const watching: EvalSuite = {
      ...suite(),
      run(evalCase, tools) {
        seen.push(tools.context);
        return fixtureSuite().run(evalCase, tools);
      },
    };
    const context = { ...EVAL_CONTEXT, correlationId: '11111111-1111-4111-8111-111111111111' };
    await runSuite(watching, scriptedSession(answers()), { context });
    await runSuite(watching, scriptedSession(answers()));
    expect(seen[0]).toBe(context);
    expect(seen[4]).toBe(EVAL_CONTEXT);
    expect(EVAL_CONTEXT.businessId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('times each case with the clock it was given, and adds up what the calls used', async () => {
    let clock = 1000;
    const session = scriptedSession(answers());
    const priced: EvalSession = {
      ...session,
      end() {
        const trace = session.end();
        return {
          ...trace,
          calls: trace.calls.map((call) => ({
            ...call,
            usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
            cost: '0.000050',
          })),
          costMicros: 75n,
        };
      },
    };
    const result = await runSuite(suite(), priced, { now: () => (clock += 7) });
    expect(result.cases.map((each) => each.latencyMs)).toEqual([7, 7, 7, 7]);
    expect(caseOf(result, 'greets')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      costUsd: '0.000075',
    });
  });
});
