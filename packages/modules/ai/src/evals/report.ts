// The run report: what was run, against which model, how each
// case went, and the recording a replay answers from. A recorded report lives at
// evals/reports/<job>/<provider>--<model>.json and is the evidence behind a registry entry.
//
// It is written with its keys in one order, so writing the same report again changes no
// byte. It holds no key and no address: the eval gateway never hands either to the runner.
import { existsSync, readFileSync } from 'node:fs';

import { isRecord, sortKeys, type JsonRecord } from '../json.js';
import { microsToDollars } from '../pricing.js';
import {
  AI_PROVIDERS,
  PROVIDER_ERROR_CODES,
  type AssistantPart,
  type TokenUsage,
} from '../provider.js';
import type { CheckResult } from './checks.js';
import { datasetHash } from './dataset.js';
import { EVAL_PROVIDERS, type EvalProvider } from './eval-gateway.js';
import {
  AMOUNT,
  booleanOfKey,
  CASE_ID,
  countOfKey,
  EvalDataError,
  JOB_NAME,
  jsonOf,
  listOfKey,
  MODEL_ID,
  oneOfKey,
  onlyKeys,
  recordOf,
  refuse,
  SHA_256,
  shareOfKey,
  SUITE_VERSION,
  textOfKey,
} from './read.js';
import type { RecordedCall, RecordedResult } from './recording.js';
import { ERROR_CATEGORIES, type CaseError, type CaseResult, type RunResult } from './runner.js';
import type { Check, EvalSuite } from './types.js';

/** The version of this file's format. A report of another version is refused. */
export const REPORT_FORMAT = 1;

export interface RunReport {
  readonly format: typeof REPORT_FORMAT;
  readonly job: string;
  readonly suiteVersion: string;
  /** SHA-256 of the cases the run was made against. */
  readonly datasetHash: string;
  readonly provider: EvalProvider;
  readonly model: string;
  /** `live`: a model answered. `replay`: a recording did, which marks nothing Tested. */
  readonly mode: 'live' | 'replay';
  readonly startedAt: string;
  readonly finishedAt: string;
  /** The suite's threshold on that run. */
  readonly threshold: number;
  readonly total: number;
  readonly passed: number;
  readonly score: number;
  readonly pass: boolean;
  readonly complete: boolean;
  /** US dollars to the millionth. */
  readonly budgetUsd: string;
  /** What was counted against the budget: known costs, and the worst case of unknown ones. */
  readonly spendUsd: string;
  readonly masked: boolean;
  readonly cases: readonly CaseResult[];
}

export interface ReportParts {
  readonly suite: EvalSuite;
  readonly result: RunResult;
  readonly provider: EvalProvider;
  readonly model: string;
  readonly mode: RunReport['mode'];
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly budgetMicros: bigint;
  readonly spentMicros: bigint;
  readonly masked: boolean;
}

export function buildReport(parts: ReportParts): RunReport {
  const { suite, result } = parts;
  return {
    format: REPORT_FORMAT,
    job: suite.job,
    suiteVersion: suite.version,
    datasetHash: datasetHash(suite.cases),
    provider: parts.provider,
    model: parts.model,
    mode: parts.mode,
    startedAt: parts.startedAt.toISOString(),
    finishedAt: parts.finishedAt.toISOString(),
    threshold: suite.threshold,
    total: result.total,
    passed: result.passed,
    score: result.score,
    pass: result.pass,
    complete: result.complete,
    budgetUsd: microsToDollars(parts.budgetMicros),
    spendUsd: microsToDollars(parts.spentMicros),
    masked: parts.masked,
    cases: result.cases,
  };
}

/**
 * A model id as part of a file name: a-z, 0-9, `.`, `_` and `-` as they are, every other
 * character as `~` and its code in hex. Capitals are written that way too, because a file
 * system may not tell them from small letters; so two ids never share a file.
 */
function fileSafe(model: string): string {
  return model.replace(
    /[^a-z0-9._-]/g,
    (character) => `~${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/** Where a recorded report is kept, from the repository's root. */
export function reportPath(job: string, provider: string, model: string): string {
  return `evals/reports/${job}/${provider}--${fileSafe(model)}.json`;
}

function callOut(call: RecordedCall): JsonRecord {
  return {
    request: call.request,
    attempts: call.attempts,
    usage: call.usage,
    cost: call.cost,
    result: sortKeys(call.result),
  };
}

function caseOut(each: CaseResult): JsonRecord {
  return {
    id: each.id,
    pass: each.pass,
    ...(each.error === undefined ? {} : { error: each.error }),
    checks: each.checks.map(({ type, target, pass, reason }) => ({ type, target, pass, reason })),
    output: sortKeys(each.output),
    calls: each.calls.map(callOut),
    usage: usageOut(each.usage),
    costUsd: each.costUsd,
    latencyMs: each.latencyMs,
  };
}

function usageOut(usage: TokenUsage): TokenUsage {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** The report as the text of its file: two-space JSON, one key order, a final newline. */
export function serializeReport(report: RunReport): string {
  const ordered = {
    format: report.format,
    job: report.job,
    suiteVersion: report.suiteVersion,
    datasetHash: report.datasetHash,
    provider: report.provider,
    model: report.model,
    mode: report.mode,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    threshold: report.threshold,
    total: report.total,
    passed: report.passed,
    score: report.score,
    pass: report.pass,
    complete: report.complete,
    budgetUsd: report.budgetUsd,
    spendUsd: report.spendUsd,
    masked: report.masked,
    cases: report.cases.map(caseOut),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

const CHECK_TYPES: readonly Check['type'][] = [
  'equals',
  'contains',
  'not_contains',
  'matches',
  'one_of',
  'tool_called',
  'length_at_most',
];
const AMOUNT_MUST = 'an amount of US dollars with six decimal places';
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHORT_TEXT = /^[^\n]{0,200}$/;

function usageIn(value: unknown, at: string): TokenUsage {
  const usage = recordOf(value, at, '"usage"');
  const inside = `${at}usage: `;
  onlyKeys(
    usage,
    ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
    inside,
    'usage',
  );
  return {
    inputTokens: countOfKey(usage, 'inputTokens', inside),
    outputTokens: countOfKey(usage, 'outputTokens', inside),
    cacheReadTokens: countOfKey(usage, 'cacheReadTokens', inside),
    cacheWriteTokens: countOfKey(usage, 'cacheWriteTokens', inside),
  };
}

function partIn(value: unknown, at: string): AssistantPart {
  const part = isRecord(value) ? value : refuse(at.slice(0, -2), ' must be an object.');
  const type = oneOfKey(part, 'type', at, ['text', 'tool_call', 'reasoning'] as const);
  if (type === 'text') {
    onlyKeys(part, ['type', 'text'], at, 'a text part');
    const { text } = part;
    return typeof text === 'string' ? { type, text } : refuse(at, '"text" must be text.');
  }
  if (type === 'tool_call') {
    onlyKeys(part, ['type', 'id', 'name', 'input'], at, 'a tool call');
    const { id, name, input } = part;
    if (typeof id !== 'string') return refuse(at, '"id" must be text.');
    if (typeof name !== 'string') return refuse(at, '"name" must be text.');
    return isRecord(input) ? { type, id, name, input } : refuse(at, '"input" must be an object.');
  }
  onlyKeys(part, ['type', 'provider', 'data'], at, 'a reasoning part');
  const provider = oneOfKey(part, 'provider', at, AI_PROVIDERS);
  const { data } = part;
  return isRecord(data) ? { type, provider, data } : refuse(at, '"data" must be an object.');
}

function resultIn(value: unknown, at: string): RecordedResult {
  const result = recordOf(value, at, '"result"');
  const inside = `${at}result: `;
  const outcome = oneOfKey(result, 'outcome', inside, [
    'ok',
    'refused',
    'failed',
    'paused',
  ] as const);
  const only = (...keys: string[]): void => {
    onlyKeys(result, ['outcome', ...keys], inside, 'a recorded result');
  };
  switch (outcome) {
    case 'ok': {
      only('parts', 'stop');
      const parts = listOfKey(result, 'parts', inside).map((part, index) =>
        partIn(part, `${inside}parts[${String(index)}]: `),
      );
      const stop = oneOfKey(result, 'stop', inside, ['end', 'max_tokens', 'tool_calls'] as const);
      return { outcome, parts, stop };
    }
    case 'refused': {
      only('category');
      const { category } = result;
      return category === null || typeof category === 'string'
        ? { outcome, category }
        : refuse(inside, '"category" must be text or null.');
    }
    case 'failed':
      only('code');
      return { outcome, code: oneOfKey(result, 'code', inside, PROVIDER_ERROR_CODES) };
    case 'paused':
      only('reason');
      return {
        outcome,
        reason: oneOfKey(result, 'reason', inside, ['limit_reached', 'price_unknown'] as const),
      };
  }
}

function callIn(value: unknown, at: string): RecordedCall {
  if (!isRecord(value)) return refuse(at.slice(0, -2), ' must be an object.');
  onlyKeys(value, ['request', 'attempts', 'usage', 'cost', 'result'], at, 'a recorded call');
  const { usage, cost } = value;
  if (usage !== null && !isRecord(usage)) refuse(at, '"usage" must be an object or null.');
  if (cost !== null && !(typeof cost === 'string' && AMOUNT.test(cost)))
    refuse(at, `"cost" must be ${AMOUNT_MUST}, or null.`);
  return {
    request: textOfKey(value, 'request', at, SHA_256, 'a SHA-256 in hex'),
    attempts: countOfKey(value, 'attempts', at),
    usage: usage === null ? null : usageIn(usage, at),
    cost,
    result: resultIn(value['result'], at),
  };
}

function checkResultIn(value: unknown, at: string): CheckResult {
  const result = isRecord(value) ? value : refuse(at.slice(0, -2), ' must be an object.');
  onlyKeys(result, ['type', 'target', 'pass', 'reason'], at, 'a check result');
  return {
    type: oneOfKey(result, 'type', at, CHECK_TYPES),
    target: textOfKey(result, 'target', at, SHORT_TEXT, 'a short text'),
    pass: booleanOfKey(result, 'pass', at),
    reason: textOfKey(result, 'reason', at, SHORT_TEXT, 'a short text'),
  };
}

function errorIn(value: unknown, at: string): CaseError {
  const error = recordOf(value, at, '"error"');
  const inside = `${at}error: `;
  onlyKeys(error, ['category', 'code'], inside, 'an error');
  const category = oneOfKey(error, 'category', inside, ERROR_CATEGORIES);
  return error['code'] === undefined
    ? { category }
    : { category, code: oneOfKey(error, 'code', inside, PROVIDER_ERROR_CODES) };
}

function caseIn(value: unknown, position: number, file: string, seen: Set<string>): CaseResult {
  const byPosition = `${file}: case ${String(position)} (by position)`;
  if (!isRecord(value)) return refuse(byPosition, ' must be an object.');
  const id = textOfKey(value, 'id', `${byPosition}: `, CASE_ID, 'the id of a case');
  const at = `${file}: case "${id}": `;
  if (seen.has(id)) refuse(at, 'the id is used twice.');
  seen.add(id);
  onlyKeys(
    value,
    ['id', 'pass', 'error', 'checks', 'output', 'calls', 'usage', 'costUsd', 'latencyMs'],
    at,
    'a case',
  );
  const { output, error } = value;
  if (output !== null && !isRecord(output)) refuse(at, '"output" must be an object or null.');
  return {
    id,
    pass: booleanOfKey(value, 'pass', at),
    ...(error === undefined ? {} : { error: errorIn(error, at) }),
    checks: listOfKey(value, 'checks', at).map((each, index) =>
      checkResultIn(each, `${at}checks[${String(index)}]: `),
    ),
    output,
    calls: listOfKey(value, 'calls', at).map((each, index) =>
      callIn(each, `${at}calls[${String(index)}]: `),
    ),
    usage: usageIn(value['usage'], at),
    costUsd: textOfKey(value, 'costUsd', at, AMOUNT, AMOUNT_MUST),
    latencyMs: countOfKey(value, 'latencyMs', at),
  };
}

/** A report from the text of its file, checked field by field. `file` names it in a refusal. */
export function parseReport(text: string, file: string): RunReport {
  const at = `${file}: `;
  const value = jsonOf(text, at);
  if (!isRecord(value)) return refuse(at, 'a report must be an object.');
  if (value['format'] !== REPORT_FORMAT)
    refuse(
      at,
      `"format" is not one this harness reads: this harness reads format ${String(REPORT_FORMAT)}.`,
    );
  onlyKeys(
    value,
    [
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
    ],
    at,
    'a report',
  );
  const { mode } = value;
  if (mode !== 'live' && mode !== 'replay') refuse(at, '"mode" must be "live" or "replay".');
  const cases = listOfKey(value, 'cases', at);
  if (cases.length === 0) refuse(at, '"cases" must be a list of at least one case.');
  const seen = new Set<string>();
  return {
    format: REPORT_FORMAT,
    job: textOfKey(value, 'job', at, JOB_NAME, 'the name of a job'),
    suiteVersion: textOfKey(value, 'suiteVersion', at, SUITE_VERSION, 'the version of a suite'),
    datasetHash: textOfKey(value, 'datasetHash', at, SHA_256, 'a SHA-256 in hex'),
    provider: oneOfKey(value, 'provider', at, EVAL_PROVIDERS),
    model: textOfKey(value, 'model', at, MODEL_ID, "a model's id"),
    mode,
    startedAt: textOfKey(value, 'startedAt', at, TIME, 'a time such as 2026-10-10T08:00:00.000Z'),
    finishedAt: textOfKey(value, 'finishedAt', at, TIME, 'a time such as 2026-10-10T08:00:00.000Z'),
    threshold: shareOfKey(value, 'threshold', at, true),
    total: countOfKey(value, 'total', at),
    passed: countOfKey(value, 'passed', at),
    score: shareOfKey(value, 'score', at, false),
    pass: booleanOfKey(value, 'pass', at),
    complete: booleanOfKey(value, 'complete', at),
    budgetUsd: textOfKey(value, 'budgetUsd', at, AMOUNT, AMOUNT_MUST),
    spendUsd: textOfKey(value, 'spendUsd', at, AMOUNT, AMOUNT_MUST),
    masked: booleanOfKey(value, 'masked', at),
    cases: cases.map((each, index) => caseIn(each, index + 1, file, seen)),
  };
}

/** The report in a file. `label` is how the file is named in a refusal. */
export function readReportFile(path: string, label: string): RunReport {
  if (!existsSync(path)) throw new EvalDataError(`${label}: the report is missing.`);
  return parseReport(readFileSync(path, 'utf8'), label);
}
