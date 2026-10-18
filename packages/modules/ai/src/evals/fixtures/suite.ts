// The harness's own suite: a toy job that greets a person, used by the harness's tests and
// by the stand-in run. It is not a job of the product, it evaluates
// no model, and it is not listed in ../suites.ts.
import { toolCallsOf } from '../../provider.js';
import type { EvalCase, SuiteDefinition } from '../types.js';

export const FIXTURE_JOB = 'replies';
export const FIXTURE_VERSION = 'fixture/1';
export const FIXTURE_SYSTEM = 'Greet the person in one short line.';
export const FIXTURE_MAX_OUTPUT_TOKENS = 64;

/** Four cases. The stand-ins always answer "Hello!", which passes three of them. */
export const FIXTURE_CASES: readonly EvalCase[] = [
  {
    id: 'greets',
    input: { message: 'Hi there' },
    expect: [
      { type: 'contains', path: 'text', value: 'hello', caseInsensitive: true },
      { type: 'length_at_most', path: 'text', value: 40 },
    ],
  },
  {
    id: 'starts-politely',
    input: { message: 'Good morning' },
    expect: [
      { type: 'matches', path: 'text', pattern: '^Hello' },
      { type: 'equals', path: 'outcome', value: 'ok' },
    ],
  },
  {
    id: 'keeps-details-out',
    input: { message: 'Write to me at amina@example.com' },
    expect: [
      { type: 'not_contains', path: 'text', value: '@' },
      { type: 'one_of', path: 'stop', values: ['end', 'tool_calls'] },
    ],
  },
  {
    id: 'uses-the-name',
    input: { message: 'I am Amina' },
    expect: [{ type: 'contains', path: 'text', value: 'Amina' }],
  },
];

export interface FixtureSuiteOptions {
  readonly job?: string;
  readonly threshold?: number;
  /** The suite's prompt. Changing it is how a test stands for "the job's prompt changed". */
  readonly system?: string;
}

export function fixtureSuite(options: FixtureSuiteOptions = {}): SuiteDefinition {
  const system = options.system ?? FIXTURE_SYSTEM;
  return {
    job: options.job ?? FIXTURE_JOB,
    version: FIXTURE_VERSION,
    threshold: options.threshold ?? 0.75,
    async run(evalCase, { gateway, context }) {
      const message = evalCase.input['message'];
      const result = await gateway.generate(context, {
        job: 'replies',
        promptVersion: FIXTURE_VERSION,
        system,
        messages: [{ role: 'user', text: typeof message === 'string' ? message : '' }],
        maxOutputTokens: FIXTURE_MAX_OUTPUT_TOKENS,
      });
      if (result.outcome !== 'ok') return { outcome: result.outcome };
      return {
        outcome: 'ok',
        text: result.text,
        stop: result.stop,
        toolCalls: toolCallsOf(result.parts).map(({ name, input }) => ({ name, input })),
      };
    },
  };
}

/** The fixture's dataset as its file would hold it. */
export function fixtureDataset(
  job: string = FIXTURE_JOB,
  cases: readonly EvalCase[] = FIXTURE_CASES,
): string {
  return `${JSON.stringify({ job, cases }, null, 2)}\n`;
}
