// Reading what the harness did not just write itself: a dataset a person edited, a report
// from an earlier run, the registry file. Everything is checked by hand, as src/json.ts
// does for a provider's answers, and a refusal names the file and the field and never
// repeats a value: a dataset holds customers' words, and a report a model's.
import { isRecord, type JsonRecord } from '../json.js';

/** A file the harness reads is not what it must be. The message is for a person. */
export class EvalDataError extends Error {
  override readonly name = 'EvalDataError';
}

/** `at` is the file and the place in it, ending in ": ". */
export function refuse(at: string, problem: string): never {
  throw new EvalDataError(`${at}${problem}`);
}

export const JOB_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const SUITE_VERSION = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
/** What a model id may be made of: enough for every provider's, and safe to write in a file. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
export const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SHA_256 = /^[0-9a-f]{64}$/;
/** US dollars to the millionth, as pricing.ts writes them. */
export const AMOUNT = /^\d{1,12}\.\d{6}$/;

export function recordOf(value: unknown, at: string, what: string): JsonRecord {
  return isRecord(value) ? value : refuse(at, `${what} must be an object.`);
}

/** Refuses a key the thing does not have: a misspelt field would otherwise be ignored. */
export function onlyKeys(
  record: JsonRecord,
  allowed: readonly string[],
  at: string,
  what: string,
): void {
  for (const key of Object.keys(record))
    if (!allowed.includes(key)) refuse(at, `${JSON.stringify(key)} is not a field of ${what}.`);
}

export function textOfKey(
  record: JsonRecord,
  key: string,
  at: string,
  pattern: RegExp,
  must: string,
): string {
  const value = record[key];
  return typeof value === 'string' && pattern.test(value)
    ? value
    : refuse(at, `"${key}" must be ${must}.`);
}

export function oneOfKey<T extends string>(
  record: JsonRecord,
  key: string,
  at: string,
  allowed: readonly T[],
): T {
  const value = record[key];
  const found = allowed.find((each) => each === value);
  return found ?? refuse(at, `"${key}" must be one of ${allowed.join(', ')}.`);
}

export function countOfKey(record: JsonRecord, key: string, at: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : refuse(at, `"${key}" must be a whole number from 0.`);
}

export function booleanOfKey(record: JsonRecord, key: string, at: string): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : refuse(at, `"${key}" must be true or false.`);
}

export function listOfKey(record: JsonRecord, key: string, at: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value)
    ? (value as readonly unknown[])
    : refuse(at, `"${key}" must be a list.`);
}

/** A share of cases: `aboveZero` for a threshold, which nothing can pass at 0. */
export function shareOfKey(
  record: JsonRecord,
  key: string,
  at: string,
  aboveZero: boolean,
): number {
  const value = record[key];
  const ok = typeof value === 'number' && value <= 1 && (aboveZero ? value > 0 : value >= 0);
  return ok
    ? value
    : refuse(
        at,
        aboveZero
          ? `"${key}" must be above 0 and at most 1.`
          : `"${key}" must be a number from 0 to 1.`,
      );
}

/** The text as JSON, or a refusal that says the file is not JSON. */
export function jsonOf(text: string, at: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return refuse(at, 'the file is not JSON.');
  }
}

export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}
