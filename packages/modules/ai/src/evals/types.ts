// What a job gives the harness: a suite, which is the job's own code and a threshold, and a
// dataset of cases, each with the checks its output must pass.
import type { TenantContext } from '@repo/kernel';

import type { AiGateway } from '../gateway.js';
import type { JsonObject } from '../provider.js';

/**
 * One thing a case's output must satisfy. Checks are plain data and always give the same
 * answer for the same output. `path` is a dot path into the output, such as `text`,
 * `fields.budget` or `toolCalls.0.name`.
 */
export type Check =
  /** The value at the path is exactly this one (objects compared whatever their key order). */
  | { readonly type: 'equals'; readonly path: string; readonly value: unknown }
  | {
      readonly type: 'contains';
      readonly path: string;
      readonly value: string;
      readonly caseInsensitive?: boolean;
    }
  | {
      readonly type: 'not_contains';
      readonly path: string;
      readonly value: string;
      readonly caseInsensitive?: boolean;
    }
  /** A regular expression; `flags` may be of i, m, s and u. */
  | {
      readonly type: 'matches';
      readonly path: string;
      readonly pattern: string;
      readonly flags?: string;
    }
  | { readonly type: 'one_of'; readonly path: string; readonly values: readonly unknown[] }
  /**
   * The output's `toolCalls` (a list of `{ name, input }`) holds a call of this tool, and,
   * when `input` is given, one whose input has at least these values.
   */
  | { readonly type: 'tool_called'; readonly name: string; readonly input?: JsonObject }
  /** The text or the list at the path is at most this long. */
  | { readonly type: 'length_at_most'; readonly path: string; readonly value: number };

/** One case of a dataset: what the suite is given, and what its output must satisfy. */
export interface EvalCase {
  /** Unique in its dataset: 1 to 64 of a-z, 0-9 and -. */
  readonly id: string;
  readonly input: JsonObject;
  /** At least one. A case passes when every check passes. */
  readonly expect: readonly Check[];
}

/** The model as a suite sees it: the gateway's one function, and nothing else of it. */
export type EvalGateway = Pick<AiGateway, 'generate'>;

export interface EvalTools {
  readonly gateway: EvalGateway;
  readonly context: TenantContext;
}

/** A job's suite as its code declares it; its cases are in evals/suites/<job>/cases.json. */
export interface SuiteDefinition {
  /** One of the gateway's jobs (AI_JOBS). */
  readonly job: string;
  /** The version of the job's prompt, such as `replies/1`. */
  readonly version: string;
  /** The share of cases that must pass: above 0, at most 1. */
  readonly threshold: number;
  /**
   * The job's own code: builds the prompt, calls the gateway (as often as the job does) and
   * gives back what the checks are scored against. It must give an output for any answer
   * of the model's; an error thrown here makes the run incomplete.
   */
  run(evalCase: EvalCase, tools: EvalTools): Promise<JsonObject>;
}

/** A suite with its dataset loaded. */
export interface EvalSuite extends SuiteDefinition {
  readonly cases: readonly EvalCase[];
}
