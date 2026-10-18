// The dataset format: evals/suites/<job>/cases.json, plain JSON so that Prettier formats it
// and a diff of it reads well.
//
//   { "job": "replies", "cases": [ { "id": "…", "input": { … }, "expect": [ { check }, … ] } ] }
//
// Loading checks every field. A dataset decides whether a model is called Tested, so a
// misspelt field or a check that can never fail must stop the load, not weaken the suite.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRecord, sortKeys, type JsonRecord } from '../json.js';
import {
  CASE_ID,
  EvalDataError,
  JOB_NAME,
  jsonOf,
  onlyKeys,
  refuse,
  SUITE_VERSION,
} from './read.js';
import type { Check, EvalCase, EvalSuite, SuiteDefinition } from './types.js';

export const MAX_PATTERN_LENGTH = 200;
const MAX_PATH_LENGTH = 200;
const PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
// What both providers accept as a tool's name (gateway.ts).
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const FLAGS = /^[imsu]{0,4}$/;
// A group that ends in a repeat and holds a repeat, such as (a+)+ or (\w*,)*: the shape
// that can take a time exponential in the text. Stricter than it need be, on purpose.
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

/** Where a job's dataset is, from the repository's root. */
export function suiteCasesPath(job: string): string {
  return `evals/suites/${job}/cases.json`;
}

const CHECK_FIELDS: Readonly<Record<Check['type'], readonly string[]>> = {
  equals: ['type', 'path', 'value'],
  contains: ['type', 'path', 'value', 'caseInsensitive'],
  not_contains: ['type', 'path', 'value', 'caseInsensitive'],
  matches: ['type', 'path', 'pattern', 'flags'],
  one_of: ['type', 'path', 'values'],
  tool_called: ['type', 'name', 'input'],
  length_at_most: ['type', 'path', 'value'],
};
const isCheckType = (value: unknown): value is Check['type'] =>
  typeof value === 'string' && Object.hasOwn(CHECK_FIELDS, value);

function pathOf(check: JsonRecord, at: string): string {
  const path = check['path'];
  return typeof path === 'string' && path.length <= MAX_PATH_LENGTH && PATH.test(path)
    ? path
    : refuse(at, 'path must be a dot path such as "text" or "fields.budget".');
}

function textCheck(type: 'contains' | 'not_contains', check: JsonRecord, at: string): Check {
  const { value, caseInsensitive } = check;
  if (typeof value !== 'string' || value === '')
    refuse(at, 'value must be text of at least one character.');
  if (caseInsensitive !== undefined && typeof caseInsensitive !== 'boolean')
    refuse(at, 'caseInsensitive must be true or false.');
  return {
    type,
    path: pathOf(check, at),
    value,
    ...(caseInsensitive === undefined ? {} : { caseInsensitive }),
  };
}

function patternCheck(check: JsonRecord, at: string): Check {
  const { pattern, flags } = check;
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > MAX_PATTERN_LENGTH)
    refuse(at, `pattern must be text of 1 to ${String(MAX_PATTERN_LENGTH)} characters.`);
  if (
    flags !== undefined &&
    (typeof flags !== 'string' || !FLAGS.test(flags) || new Set(flags).size !== flags.length)
  )
    refuse(at, 'flags may only be of i, m, s and u, each once.');
  try {
    new RegExp(pattern, flags);
  } catch {
    refuse(at, 'pattern is not a valid pattern.');
  }
  if (NESTED_REPEAT.test(pattern))
    refuse(at, 'pattern repeats a group that itself repeats, which can take forever to match.');
  return {
    type: 'matches',
    path: pathOf(check, at),
    pattern,
    ...(flags === undefined ? {} : { flags }),
  };
}

function checkOf(value: unknown, at: string): Check {
  if (!isRecord(value)) return refuse(at.slice(0, -1), ' must be an object.');
  const { type } = value;
  if (!isCheckType(type)) return refuse(at, 'type is not a check the harness knows.');
  for (const key of Object.keys(value))
    if (!CHECK_FIELDS[type].includes(key))
      refuse(at, `${key.slice(0, 40)} is not a field of a "${type}" check.`);
  switch (type) {
    case 'equals':
      if (!Object.hasOwn(value, 'value')) refuse(at, 'value is missing.');
      return { type, path: pathOf(value, at), value: value['value'] };
    case 'contains':
    case 'not_contains':
      return textCheck(type, value, at);
    case 'matches':
      return patternCheck(value, at);
    case 'one_of': {
      const { values } = value;
      if (!Array.isArray(values) || values.length === 0)
        refuse(at, 'values must be a list of at least one value.');
      return { type, path: pathOf(value, at), values: values as readonly unknown[] };
    }
    case 'tool_called': {
      const { name, input } = value;
      if (typeof name !== 'string' || !TOOL_NAME.test(name))
        refuse(at, "name must be a tool's name.");
      if (input !== undefined && !isRecord(input)) refuse(at, 'input must be an object.');
      return { type, name, ...(input === undefined ? {} : { input }) };
    }
    case 'length_at_most': {
      const length = value['value'];
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
        refuse(at, 'value must be a whole number from 0.');
      return { type, path: pathOf(value, at), value: length };
    }
  }
}

function caseOf(value: unknown, position: number, file: string, seen: Set<string>): EvalCase {
  const byPosition = `${file}: case ${String(position)} (by position)`;
  if (!isRecord(value)) return refuse(byPosition, ' must be an object.');
  const { id, input, expect } = value;
  if (typeof id !== 'string' || !CASE_ID.test(id))
    return refuse(
      byPosition,
      ': "id" must be 1 to 64 of a-z, 0-9 and -, starting with a letter or a digit.',
    );
  const at = `${file}: case "${id}": `;
  if (seen.has(id)) refuse(at, 'the id is used twice.');
  seen.add(id);
  onlyKeys(value, ['id', 'input', 'expect'], at, 'a case');
  if (!isRecord(input)) return refuse(at, '"input" must be an object.');
  if (!Array.isArray(expect) || expect.length === 0)
    return refuse(at, '"expect" must be a list of at least one check.');
  return {
    id,
    input,
    expect: expect.map((check, index) => checkOf(check, `${at}expect[${String(index)}].`)),
  };
}

/**
 * The cases of a dataset file, checked. `file` is how the file is named in a refusal, and
 * `job` the folder it is in.
 */
export function parseCases(value: unknown, file: string, job: string): readonly EvalCase[] {
  const at = `${file}: `;
  if (!isRecord(value)) return refuse(at, 'the file must be an object with "job" and "cases".');
  onlyKeys(value, ['job', 'cases'], at, 'a dataset');
  if (value['job'] !== job) refuse(at, `"job" must be "${job}", the name of its folder.`);
  const { cases } = value;
  if (!Array.isArray(cases) || cases.length === 0)
    return refuse(at, '"cases" must be a list of at least one case.');
  const seen = new Set<string>();
  return cases.map((each, index) => caseOf(each, index + 1, file, seen));
}

/** SHA-256 of the cases, written with every object's keys in order. */
export function datasetHash(cases: readonly EvalCase[]): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(cases)))
    .digest('hex');
}

/** Refuses a suite whose own declaration could not be scored or recorded. */
export function checkDefinition(definition: SuiteDefinition): void {
  const at = `The suite ${JSON.stringify(definition.job)}: `;
  if (!JOB_NAME.test(definition.job))
    refuse(at, 'a job is named in a-z, 0-9 and _, starting with a letter.');
  if (!SUITE_VERSION.test(definition.version))
    refuse(at, 'the version must be 1 to 100 of a-z, 0-9 and . _ / -, such as "replies/1".');
  // Written so that a threshold that is not a number at all is refused too.
  if (!(definition.threshold > 0 && definition.threshold <= 1))
    refuse(at, 'the threshold must be above 0 and at most 1.');
}

/** The suite with the cases of evals/suites/<job>/cases.json under `repoRoot`. */
export function loadSuite(definition: SuiteDefinition, repoRoot: string): EvalSuite {
  checkDefinition(definition);
  const file = suiteCasesPath(definition.job);
  const path = join(repoRoot, file);
  if (!existsSync(path)) throw new EvalDataError(`${file}: the dataset is missing.`);
  const cases = parseCases(jsonOf(readFileSync(path, 'utf8'), `${file}: `), file, definition.job);
  return { ...definition, cases };
}
