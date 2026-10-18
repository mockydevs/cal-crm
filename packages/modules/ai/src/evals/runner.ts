// The runner: each case of a suite through the suite's own code and a model handle, one
// after another, then scored.
//
//   score    = cases that passed / all cases
//   complete = no case ended in an error (a failed call, a pause, a deadline, a broken suite)
//   pass     = complete and score >= the suite's threshold
//
// An incomplete run never passes: a score over the cases that happened to get an answer
// says nothing about the ones that did not.
import type { TenantContext } from '@repo/kernel';

import { isRecord } from '../json.js';
import { microsToDollars } from '../pricing.js';
import type { JsonObject, ProviderErrorCode, TokenUsage } from '../provider.js';
import { scoreChecks, type CheckResult } from './checks.js';
import type { CaseTrace, EvalSession, RecordedCall } from './recording.js';
import type { EvalCase, EvalSuite } from './types.js';

/** Why a case has no verdict of its own. */
export const ERROR_CATEGORIES = [
  /** A call failed at the provider; `code` says how. */
  'provider_error',
  /** The budget cap stopped a call. */
  'paused',
  /** The case outlasted its deadline. */
  'timeout',
  /** The suite's code failed, or gave back something that is not an object. */
  'run_error',
  /** An earlier case ran out of time, after which nothing more is run. */
  'not_run',
  /** A replay only: the recording does not fit the suite as it is now. */
  'stale',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface CaseError {
  readonly category: ErrorCategory;
  readonly code?: ProviderErrorCode;
}

export interface CaseResult {
  readonly id: string;
  readonly pass: boolean;
  readonly error?: CaseError;
  /** Empty when the case ended in an error. */
  readonly checks: readonly CheckResult[];
  /** What the suite gave back, or null when it gave nothing. */
  readonly output: JsonObject | null;
  readonly calls: readonly RecordedCall[];
  /** What the calls' last attempts reported, added up. */
  readonly usage: TokenUsage;
  /** What the case was counted as against the budget, in US dollars to the millionth. */
  readonly costUsd: string;
  readonly latencyMs: number;
}

export interface RunResult {
  readonly total: number;
  readonly passed: number;
  readonly score: number;
  readonly complete: boolean;
  readonly pass: boolean;
  readonly cases: readonly CaseResult[];
}

/**
 * Whom a suite acts for when the harness runs it: nobody. The ids are fixed and belong to
 * no agency, and the eval gateway reads no database with them.
 */
export const EVAL_CONTEXT: TenantContext = {
  agencyId: '00000000-0000-4000-8000-00000000e7a1',
  businessId: '00000000-0000-4000-8000-00000000e7a2',
  actorKind: 'system',
  correlationId: '00000000-0000-4000-8000-00000000e7a3',
};

export interface RunOptions {
  readonly context?: TenantContext;
  /** The most one case may take, in milliseconds. Ten minutes when left out. */
  readonly caseTimeoutMs?: number;
  /** Milliseconds, for timing a case. */
  readonly now?: () => number;
  /** Told when a suite's code fails, since the report keeps the category only. */
  readonly onError?: (caseId: string, error: unknown) => void;
}

const DEFAULT_CASE_TIMEOUT_MS = 600_000;
const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

type Ended =
  | { readonly how: 'output'; readonly output: unknown }
  | { readonly how: 'threw'; readonly error: unknown }
  | { readonly how: 'timeout' };

/** The suite's code for one case, or the deadline, whichever comes first. */
async function runCase(
  suite: EvalSuite,
  evalCase: EvalCase,
  session: EvalSession,
  context: TenantContext,
  timeoutMs: number,
): Promise<Ended> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Ended>((resolve) => {
    timer = setTimeout(() => {
      resolve({ how: 'timeout' });
    }, timeoutMs);
  });
  const work = (async (): Promise<Ended> => {
    try {
      return { how: 'output', output: await suite.run(evalCase, { gateway: session, context }) };
    } catch (error) {
      return { how: 'threw', error };
    }
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The error a case ended in, if any: the first cause, not what followed from it. */
function errorOf(ended: Ended, trace: CaseTrace): CaseError | undefined {
  if (trace.stale) return { category: 'stale' };
  if (ended.how === 'timeout') return { category: 'timeout' };
  for (const { result } of trace.calls) {
    if (result.outcome === 'failed') return { category: 'provider_error', code: result.code };
    if (result.outcome === 'paused') return { category: 'paused' };
  }
  if (ended.how === 'threw' || !isRecord(ended.output)) return { category: 'run_error' };
  return undefined;
}

function usageOf(calls: readonly RecordedCall[]): TokenUsage {
  return calls.reduce<TokenUsage>(
    (sum, { usage }) =>
      usage === null
        ? sum
        : {
            inputTokens: sum.inputTokens + usage.inputTokens,
            outputTokens: sum.outputTokens + usage.outputTokens,
            cacheReadTokens: sum.cacheReadTokens + usage.cacheReadTokens,
            cacheWriteTokens: sum.cacheWriteTokens + usage.cacheWriteTokens,
          },
    NO_USAGE,
  );
}

export async function runSuite(
  suite: EvalSuite,
  session: EvalSession,
  options: RunOptions = {},
): Promise<RunResult> {
  const context = options.context ?? EVAL_CONTEXT;
  const now = options.now ?? Date.now;
  const timeoutMs = options.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const cases: CaseResult[] = [];
  let stopped = false;

  for (const evalCase of suite.cases) {
    if (stopped) {
      cases.push({
        id: evalCase.id,
        pass: false,
        error: { category: 'not_run' },
        checks: [],
        output: null,
        calls: [],
        usage: NO_USAGE,
        costUsd: microsToDollars(0n),
        latencyMs: 0,
      });
      continue;
    }
    session.begin(evalCase.id);
    const startedAt = now();
    const ended = await runCase(suite, evalCase, session, context, timeoutMs);
    const latencyMs = Math.max(0, now() - startedAt);
    if (ended.how === 'timeout') {
      // The suite's code may still be running: it must reach no model from here on, and
      // no later case may be mistaken for the one it belongs to.
      session.stop();
      stopped = true;
    }
    const trace = session.end();
    const error = errorOf(ended, trace);
    const output = ended.how === 'output' && isRecord(ended.output) ? ended.output : null;
    if (error?.category === 'run_error')
      options.onError?.(
        evalCase.id,
        ended.how === 'threw' ? ended.error : new TypeError('The suite gave back no object.'),
      );
    const checks =
      error === undefined && output !== null ? scoreChecks(output, evalCase.expect) : [];
    cases.push({
      id: evalCase.id,
      pass: error === undefined && checks.every((check) => check.pass),
      ...(error === undefined ? {} : { error }),
      checks,
      output,
      calls: trace.calls,
      usage: usageOf(trace.calls),
      costUsd: microsToDollars(trace.costMicros),
      latencyMs,
    });
  }

  const passed = cases.filter((each) => each.pass).length;
  const score = passed / cases.length;
  const complete = cases.every((each) => each.error === undefined);
  return {
    total: cases.length,
    passed,
    score,
    complete,
    pass: complete && score >= suite.threshold,
    cases,
  };
}
