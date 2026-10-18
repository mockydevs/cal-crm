import { afterEach, describe, expect, it } from 'vitest';

import { checkDefinition, datasetHash, loadSuite, parseCases, suiteCasesPath } from './dataset.js';
import { FIXTURE_CASES, fixtureDataset, fixtureSuite } from './fixtures/suite.js';
import { makeWorkspace, type Workspace } from './fixtures/workspace.js';
import { EvalDataError } from './read.js';

const FILE = 'evals/suites/replies/cases.json';
const check = { type: 'contains', path: 'text', value: 'hello' };
const good = { id: 'greets', input: { message: 'Hi' }, expect: [check] };
const dataset = (...cases: unknown[]): unknown => ({ job: 'replies', cases });
const withCheck = (changed: unknown): unknown => dataset({ ...good, expect: [changed] });

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof EvalDataError) return error.message;
    throw error;
  }
  throw new Error('Expected the data to be refused.');
}
const problem = (value: unknown): string => refusal(() => parseCases(value, FILE, 'replies'));

const workspaces: Workspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.remove();
});
function workspace(options?: Parameters<typeof makeWorkspace>[0]): Workspace {
  const made = makeWorkspace(options);
  workspaces.push(made);
  return made;
}

describe('a dataset', () => {
  it('is the cases of its file, as written', () => {
    const parsed: unknown = JSON.parse(fixtureDataset());
    expect(parseCases(parsed, FILE, 'replies')).toEqual(FIXTURE_CASES);
  });

  it.each<[string, unknown, string]>([
    ['a list instead of an object', [good], 'the file must be an object with "job" and "cases".'],
    [
      'another job',
      { job: 'sorting', cases: [good] },
      '"job" must be "replies", the name of its folder.',
    ],
    ['no cases', dataset(), '"cases" must be a list of at least one case.'],
    ['cases that are not a list', { job: 'replies', cases: {} }, '"cases" must be a list'],
    [
      'a field it does not have',
      { job: 'replies', cases: [good], threshold: 0.1 },
      '"threshold" is not a field of a dataset.',
    ],
    ['a case that is not an object', dataset(good, 'x'), 'case 2 (by position) must be an object.'],
    [
      'a case with no id',
      dataset({ input: {}, expect: [check] }),
      'case 1 (by position): "id" must be 1 to 64 of a-z, 0-9 and -, starting with a letter or a digit.',
    ],
    ['an id in capitals', dataset({ ...good, id: 'Greets' }), 'case 1 (by position): "id" must be'],
    [
      'an id of 65 characters',
      dataset({ ...good, id: 'a'.repeat(65) }),
      'case 1 (by position): "id" must be',
    ],
    ['an id used twice', dataset(good, good), 'case "greets": the id is used twice.'],
    [
      'an input that is not an object',
      dataset({ ...good, input: 'Hi' }),
      'case "greets": "input" must be an object.',
    ],
    [
      'no checks',
      dataset({ ...good, expect: [] }),
      'case "greets": "expect" must be a list of at least one check.',
    ],
    [
      'a misspelt field',
      dataset({ ...good, expected: [] }),
      'case "greets": "expected" is not a field of a case.',
    ],
    [
      'a check that is not an object',
      withCheck('contains'),
      'case "greets": expect[0] must be an object.',
    ],
    [
      'an unknown check',
      withCheck({ type: 'similar_to', path: 'text' }),
      'case "greets": expect[0].type is not a check the harness knows.',
    ],
    [
      'a check with no path',
      withCheck({ type: 'contains', value: 'x' }),
      'expect[0].path must be a dot path such as "text" or "fields.budget".',
    ],
    [
      'a path with an empty part',
      withCheck({ ...check, path: 'fields..budget' }),
      'expect[0].path must be a dot path',
    ],
    [
      'a path of 201 characters',
      withCheck({ ...check, path: 'a'.repeat(201) }),
      'expect[0].path must be a dot path',
    ],
    [
      'a value that is not text',
      withCheck({ ...check, value: 7 }),
      'expect[0].value must be text of at least one character.',
    ],
    [
      'an empty value',
      withCheck({ ...check, value: '' }),
      'expect[0].value must be text of at least one character.',
    ],
    [
      'a flag that is not true or false',
      withCheck({ ...check, caseInsensitive: 'yes' }),
      'expect[0].caseInsensitive must be true or false.',
    ],
    [
      'a misspelt field of a check',
      withCheck({ ...check, caseInsensetive: true }),
      'expect[0].caseInsensetive is not a field of a "contains" check.',
    ],
    [
      'equals with no value',
      withCheck({ type: 'equals', path: 'text' }),
      'expect[0].value is missing.',
    ],
    [
      'a pattern of 201 characters',
      withCheck({ type: 'matches', path: 'text', pattern: 'a'.repeat(201) }),
      'expect[0].pattern must be text of 1 to 200 characters.',
    ],
    [
      'a pattern that is not one',
      withCheck({ type: 'matches', path: 'text', pattern: '(' }),
      'expect[0].pattern is not a valid pattern.',
    ],
    [
      'a pattern that can take forever',
      withCheck({ type: 'matches', path: 'text', pattern: '^(a+)+$' }),
      'expect[0].pattern repeats a group that itself repeats, which can take forever to match.',
    ],
    [
      'a flag the harness does not allow',
      withCheck({ type: 'matches', path: 'text', pattern: 'a', flags: 'g' }),
      'expect[0].flags may only be of i, m, s and u, each once.',
    ],
    [
      'a flag twice',
      withCheck({ type: 'matches', path: 'text', pattern: 'a', flags: 'ii' }),
      'expect[0].flags may only be of i, m, s and u, each once.',
    ],
    [
      'one_of with nothing to choose from',
      withCheck({ type: 'one_of', path: 'text', values: [] }),
      'expect[0].values must be a list of at least one value.',
    ],
    [
      'a tool with no name',
      withCheck({ type: 'tool_called' }),
      "expect[0].name must be a tool's name.",
    ],
    [
      'a tool input that is not an object',
      withCheck({ type: 'tool_called', name: 'find_contacts', input: [] }),
      'expect[0].input must be an object.',
    ],
    [
      'a length that is not a whole number',
      withCheck({ type: 'length_at_most', path: 'text', value: 1.5 }),
      'expect[0].value must be a whole number from 0.',
    ],
    [
      'a negative length',
      withCheck({ type: 'length_at_most', path: 'text', value: -1 }),
      'expect[0].value must be a whole number from 0.',
    ],
  ])('refuses %s, naming the file, the case and the field', (_name, value, message) => {
    const said = problem(value);
    expect(said.startsWith(`${FILE}: `)).toBe(true);
    expect(said).toContain(message);
  });

  it('takes every kind of check with its optional fields', () => {
    const cases = [
      {
        id: 'all',
        input: {},
        expect: [
          { type: 'equals', path: 'fields.budget', value: null },
          { type: 'contains', path: 'text', value: 'a', caseInsensitive: false },
          { type: 'not_contains', path: 'text', value: 'b' },
          { type: 'matches', path: 'text', pattern: '^a(?:b|c)+$', flags: 'im' },
          { type: 'one_of', path: 'label', values: ['lead', 1, null] },
          { type: 'tool_called', name: 'find_contacts', input: { limit: 5 } },
          { type: 'tool_called', name: 'count_deals' },
          { type: 'length_at_most', path: 'toolCalls', value: 0 },
        ],
      },
    ];
    expect(parseCases({ job: 'replies', cases }, FILE, 'replies')).toEqual(cases);
  });

  it('never repeats what a case holds in its message', () => {
    const said = problem(
      dataset({ id: 'private', input: 'a customer wrote from 0712 345 678', expect: [check] }),
    );
    expect(said).toBe(`${FILE}: case "private": "input" must be an object.`);
    expect(problem(withCheck({ ...check, value: { secret: 'sk-not-a-key' } }))).not.toContain(
      'sk-',
    );
  });
});

describe('the hash of a dataset', () => {
  it('is the same whatever order the keys were written in', () => {
    const reordered = FIXTURE_CASES.map(({ id, input, expect: checks }) => ({
      expect: checks,
      input,
      id,
    }));
    expect(datasetHash(reordered)).toBe(datasetHash(FIXTURE_CASES));
    expect(datasetHash(FIXTURE_CASES)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with one character of one case, and with the order of the cases', () => {
    const [first, ...rest] = FIXTURE_CASES;
    if (first === undefined) throw new Error('The fixture has no case.');
    const edited = [{ ...first, input: { message: 'Hi there.' } }, ...rest];
    expect(datasetHash(edited)).not.toBe(datasetHash(FIXTURE_CASES));
    expect(datasetHash([...rest, first])).not.toBe(datasetHash(FIXTURE_CASES));
  });
});

describe('a suite', () => {
  it('is its definition with the cases of evals/suites/<job>/cases.json', () => {
    const { repoRoot } = workspace();
    const suite = loadSuite(fixtureSuite(), repoRoot);
    expect(suite.cases).toEqual(FIXTURE_CASES);
    expect(suite.job).toBe('replies');
    expect(suite.threshold).toBe(0.75);
    expect(suiteCasesPath('replies')).toBe(FILE);
  });

  it('says which file is missing, and which is not JSON', () => {
    const empty = workspace({ dataset: null });
    expect(refusal(() => loadSuite(fixtureSuite(), empty.repoRoot))).toBe(
      `${FILE}: the dataset is missing.`,
    );
    const broken = workspace({ dataset: '{ "job": ' });
    expect(refusal(() => loadSuite(fixtureSuite(), broken.repoRoot))).toBe(
      `${FILE}: the file is not JSON.`,
    );
  });

  it.each([
    ['a job that is not a name', { job: '../replies' }, 'a job is named in a-z, 0-9 and _'],
    ['a threshold of zero', { threshold: 0 }, 'the threshold must be above 0 and at most 1.'],
    ['a threshold above one', { threshold: 1.01 }, 'the threshold must be above 0 and at most 1.'],
    [
      'a threshold that is not a number',
      { threshold: Number.NaN },
      'the threshold must be above 0',
    ],
  ])('refuses %s', (_name, options, message) => {
    expect(
      refusal(() => {
        checkDefinition(fixtureSuite(options));
      }),
    ).toContain(message);
  });

  it('refuses a version that could not be written in the registry, and takes a threshold of 1', () => {
    const suite = { ...fixtureSuite(), version: "replies/1'" };
    expect(
      refusal(() => {
        checkDefinition(suite);
      }),
    ).toContain('the version must be');
    expect(() => {
      checkDefinition(fixtureSuite({ threshold: 1 }));
    }).not.toThrow();
  });
});
