// Scoring: each check of a case against the suite's output. The same output always gives
// the same result, with no model in the loop. A reason says what kind of thing went wrong
// and never repeats the output or the value expected.
import { isRecord, sortKeys } from '../json.js';
import type { JsonObject } from '../provider.js';
import type { Check } from './types.js';

/** A pattern is not run over a text longer than this: see dataset.ts on patterns. */
export const MAX_SUBJECT_LENGTH = 20_000;

export interface CheckResult {
  readonly type: Check['type'];
  /** What the check looked at: its path, or its tool's name. */
  readonly target: string;
  readonly pass: boolean;
  /** `ok`, or a few words on why not. */
  readonly reason: string;
}

const MISSING = Symbol('missing');

/** The value at a dot path. A whole number as a part of the path is a place in a list. */
function valueAt(output: JsonObject, path: string): unknown {
  let current: unknown = output;
  for (const part of path.split('.')) {
    if (Array.isArray(current)) {
      const items: readonly unknown[] = current;
      const index = /^(?:0|[1-9]\d*)$/.test(part) ? Number(part) : -1;
      if (index < 0 || index >= items.length) return MISSING;
      current = items[index];
    } else if (isRecord(current) && Object.hasOwn(current, part)) current = current[part];
    else return MISSING;
  }
  return current;
}

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));

/** Whether `actual` has at least what `expected` has: objects part by part, the rest whole. */
function holds(actual: unknown, expected: unknown): boolean {
  if (!isRecord(expected)) return same(actual, expected);
  if (!isRecord(actual)) return false;
  return Object.keys(expected).every(
    (key) => Object.hasOwn(actual, key) && holds(actual[key], expected[key]),
  );
}

const fold = (text: string, caseInsensitive: boolean | undefined): string =>
  caseInsensitive === true ? text.toLowerCase() : text;

function toolCalled(output: JsonObject, name: string, input: JsonObject | undefined): string {
  const calls: readonly unknown[] = Array.isArray(output['toolCalls']) ? output['toolCalls'] : [];
  const named = calls.filter((call) => isRecord(call) && call['name'] === name);
  if (named.length === 0) return 'the tool was not called';
  if (input === undefined) return 'ok';
  return named.some((call) => isRecord(call) && holds(call['input'] ?? {}, input))
    ? 'ok'
    : 'the tool was called, but not with the input expected';
}

/** `ok`, or why the check does not pass. */
function reasonOf(output: JsonObject, check: Check): string {
  if (check.type === 'tool_called') return toolCalled(output, check.name, check.input);
  const value = valueAt(output, check.path);
  if (value === MISSING) return 'nothing is at this path';
  switch (check.type) {
    case 'equals':
      return same(value, check.value) ? 'ok' : 'the value is not the one expected';
    case 'one_of':
      return check.values.some((each) => same(value, each))
        ? 'ok'
        : 'the value is none of those expected';
    case 'length_at_most':
      if (typeof value !== 'string' && !Array.isArray(value))
        return 'the value is neither text nor a list';
      return value.length <= check.value ? 'ok' : 'it is longer than allowed';
    case 'contains':
    case 'not_contains': {
      if (typeof value !== 'string') return 'the value is not text';
      const found = fold(value, check.caseInsensitive).includes(
        fold(check.value, check.caseInsensitive),
      );
      if (check.type === 'contains')
        return found ? 'ok' : 'the text does not contain what was expected';
      return found ? 'the text contains what it must not' : 'ok';
    }
    case 'matches':
      if (typeof value !== 'string') return 'the value is not text';
      if (value.length > MAX_SUBJECT_LENGTH)
        return 'the text is too long to match against a pattern';
      return new RegExp(check.pattern, check.flags).test(value)
        ? 'ok'
        : 'the text does not match the pattern';
  }
}

/** One result for each check, in order. A case passes when every one of them passes. */
export function scoreChecks(output: JsonObject, checks: readonly Check[]): CheckResult[] {
  return checks.map((check) => {
    const reason = reasonOf(output, check);
    return {
      type: check.type,
      target: check.type === 'tool_called' ? check.name : check.path,
      pass: reason === 'ok',
      reason,
    };
  });
}
