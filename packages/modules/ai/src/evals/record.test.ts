import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { datasetHash, loadSuite } from './dataset.js';
import type { TestedEntry } from './entry.js';
import { says, scriptedReport, type ScriptedReportOptions } from './fixtures/scripted.js';
import {
  FIXTURE_CASES,
  FIXTURE_SYSTEM,
  fixtureDataset,
  fixtureSuite,
  type FixtureSuiteOptions,
} from './fixtures/suite.js';
import { makeWorkspace, type Workspace } from './fixtures/workspace.js';
import { REPO_ROOT } from './paths.js';
import { EvalDataError } from './read.js';
import { forget, record, RecordRefused } from './record.js';
import { entryOf, readRegistry, renderRegistry } from './registry.js';
import { reportPath, serializeReport, type RunReport } from './report.js';
import { EVAL_CONTEXT } from './runner.js';
import type { SuiteDefinition } from './types.js';

const SONNET_REPORT = 'evals/reports/replies/anthropic--claude-sonnet-5-5.json';
/** Every case passes: the stand-ins' greeting, with the name the last case asks for. */
const allPass = (): ReturnType<typeof says> => says('Hello Amina!');

const workspaces: Workspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.remove();
});
function workspace(options?: Parameters<typeof makeWorkspace>[0]): Workspace {
  const made = makeWorkspace(options);
  workspaces.push(made);
  return made;
}

/** A run of the fixture suite in the workspace, written where a live run would leave it. */
async function run(
  made: Workspace,
  options: ScriptedReportOptions & { readonly suite?: FixtureSuiteOptions } = {},
): Promise<{ report: RunReport; file: string }> {
  const report = await scriptedReport(
    loadSuite(fixtureSuite(options.suite), made.repoRoot),
    options,
  );
  return { report, file: made.write('.data/evals/run.json', serializeReport(report)) };
}

const recordIn = (
  made: Workspace,
  reportFile: string,
  suites: readonly SuiteDefinition[] = [fixtureSuite()],
): Promise<TestedEntry> =>
  record({ reportFile, repoRoot: made.repoRoot, registryPath: made.registryPath, suites });

async function refusal(work: Promise<unknown>): Promise<readonly string[]> {
  try {
    await work;
  } catch (error) {
    if (error instanceof RecordRefused) return error.problems;
    throw error;
  }
  throw new Error('Expected the report to be refused.');
}

function rewrite(file: string, change: (draft: Record<string, unknown>) => void): void {
  const draft = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(draft);
  writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`);
}
const casesOf = (draft: Record<string, unknown>): Record<string, unknown>[] =>
  draft['cases'] as Record<string, unknown>[];

describe('recording a report', () => {
  it('marks the model Tested: the report is kept and the registry names it', async () => {
    const made = workspace();
    const { report, file } = await run(made);
    const entry = await recordIn(made, file);
    expect(entry).toEqual({
      job: 'replies',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      suiteVersion: 'fixture/1',
      datasetHash: datasetHash(FIXTURE_CASES),
      passed: 3,
      total: 4,
      score: 0.75,
      testedOn: '2026-10-10',
      report: SONNET_REPORT,
    });
    expect(readFileSync(join(made.repoRoot, SONNET_REPORT), 'utf8')).toBe(serializeReport(report));
    const registry = readFileSync(made.registryPath, 'utf8');
    expect(readRegistry(registry, 'tested.gen.ts')).toEqual([entry]);
    expect(registry).toBe(renderRegistry([entry]));
  });

  it('replaces the entry of the same job, provider and model, and keeps the others in order', async () => {
    const made = workspace();
    const haiku = await run(made, { model: 'claude-haiku-4-5-20251001' });
    await recordIn(made, haiku.file);
    const first = await run(made);
    await recordIn(made, first.file);
    const later = await run(made, {
      answer: allPass,
      at: new Date('2026-11-02T10:00:00.000Z'),
    });
    const entry = await recordIn(made, later.file);
    expect(entry).toMatchObject({ passed: 4, score: 1, testedOn: '2026-11-02' });
    const entries = readRegistry(readFileSync(made.registryPath, 'utf8'), 'tested.gen.ts');
    expect(entries.map((each) => [each.model, each.passed])).toEqual([
      ['claude-haiku-4-5-20251001', 3],
      ['claude-sonnet-5-5', 4],
    ]);
    expect(readFileSync(join(made.repoRoot, SONNET_REPORT), 'utf8')).toBe(
      serializeReport(later.report),
    );
  });

  it('records a report that already lies where it is kept', async () => {
    const made = workspace();
    const { report } = await run(made);
    const file = made.write(SONNET_REPORT, serializeReport(report));
    expect((await recordIn(made, file)).report).toBe(SONNET_REPORT);
  });

  it.each<[string, ScriptedReportOptions & { suite?: FixtureSuiteOptions }, string]>([
    [
      'a failing report',
      { suite: { threshold: 0.9 } },
      'The run did not pass: 3 of 4 cases passed (0.75) and the threshold was 0.9.',
    ],
    [
      'an incomplete report',
      {
        answer: (_request, caseId) =>
          caseId === 'uses-the-name' ? { outcome: 'failed', code: 'unavailable' } : says('Hello!'),
      },
      'The run is incomplete: 1 case ended in an error (uses-the-name: provider_error).',
    ],
    ['a replayed report', { mode: 'replay' }, 'The report is of a replay, not of a live run.'],
  ])('refuses %s', async (_name, options, message) => {
    const made = workspace();
    const { file } = await run(made, options);
    const suites = [fixtureSuite(options.suite)];
    expect(await refusal(recordIn(made, file, suites))).toContain(message);
    expect(readFileSync(made.registryPath, 'utf8')).toBe(renderRegistry([]));
    expect(existsSync(join(made.repoRoot, SONNET_REPORT))).toBe(false);
  });

  it('refuses a run against a stand-in, however well it scored: no model was evaluated', async () => {
    const made = workspace();
    for (const model of ['stand-in', 'Stand-In', 'stand-in-replies']) {
      const { file } = await run(made, { answer: allPass, model });
      expect(await refusal(recordIn(made, file))).toEqual([
        `The report is of a run against a stand-in ("${model}"), which evaluates no model: it marks nothing Tested.`,
      ]);
    }
    expect(readRegistry(readFileSync(made.registryPath, 'utf8'), 'tested.gen.ts')).toEqual([]);
  });

  it('refuses a report whose score was edited by hand', async () => {
    const made = workspace();
    const { file } = await run(made, { suite: { threshold: 0.9 } });
    rewrite(file, (draft) => {
      draft['score'] = 1;
      draft['pass'] = true;
    });
    expect(await refusal(recordIn(made, file, [fixtureSuite({ threshold: 0.9 })]))).toContain(
      'The report does not add up: its score is not its passed cases over its total.',
    );
  });

  it.each<[string, (draft: Record<string, unknown>) => void, string]>([
    [
      'its count of passed cases',
      (draft) => (draft['passed'] = 4),
      'The report does not add up: it counts 4 passed cases and holds 3.',
    ],
    [
      'its total',
      (draft) => (draft['total'] = 3),
      'The report does not add up: it counts 3 cases and holds 4.',
    ],
    [
      'its verdict',
      (draft) => (draft['pass'] = false),
      'The report does not add up: its verdict is not what its score, threshold and errors give.',
    ],
    [
      'whether it is complete',
      (draft) => (draft['complete'] = false),
      'The report does not add up: it says it is incomplete and no case ended in an error.',
    ],
    [
      'the verdict of a case',
      (draft) => (casesOf(draft)[3] = { ...casesOf(draft)[3], pass: true }),
      'The report does not add up: case "uses-the-name" is marked passed against its own checks.',
    ],
  ])('refuses a report edited in %s', async (_name, change, message) => {
    const made = workspace();
    const { file } = await run(made);
    rewrite(file, change);
    expect(await refusal(recordIn(made, file))).toContain(message);
    expect(readFileSync(made.registryPath, 'utf8')).toBe(renderRegistry([]));
  });

  it('refuses a report edited all the way through, because the replay does not agree', async () => {
    const made = workspace();
    const { file } = await run(made, { suite: { threshold: 0.9 } });
    // A failing run dressed as a pass: every number and every check agrees with the others.
    rewrite(file, (draft) => {
      draft['passed'] = 4;
      draft['score'] = 1;
      draft['pass'] = true;
      const last = casesOf(draft)[3];
      if (last === undefined) throw new Error('The report has no fourth case.');
      last['pass'] = true;
      last['checks'] = [{ type: 'contains', target: 'text', pass: true, reason: 'ok' }];
    });
    expect(await refusal(recordIn(made, file, [fixtureSuite({ threshold: 0.9 })]))).toEqual([
      'Replayed through the suite as it is now, case "uses-the-name" fails where the report says it passed.',
      'Replayed through the suite as it is now, the run does not pass: 3 of 4 cases (0.75) against a threshold of 0.9.',
    ]);
  });

  it('refuses a report made against another dataset', async () => {
    const made = workspace();
    const { file } = await run(made);
    const [first, ...rest] = FIXTURE_CASES;
    if (first === undefined) throw new Error('The fixture has no case.');
    made.write(
      'evals/suites/replies/cases.json',
      fixtureDataset('replies', [{ ...first, input: { message: 'Hi there!' } }, ...rest]),
    );
    expect(await refusal(recordIn(made, file))).toContain(
      'The dataset has changed since the run: its hash is not the one in the report.',
    );
  });

  it('refuses a report made against another version of the suite', async () => {
    const made = workspace();
    const { file } = await run(made);
    const suites = [{ ...fixtureSuite(), version: 'fixture/2' }];
    expect(await refusal(recordIn(made, file, suites))).toContain(
      'The suite is at version fixture/2 and the report is of version fixture/1.',
    );
  });

  it("refuses a report whose recording no longer fits the suite's prompt", async () => {
    const made = workspace();
    const { file } = await run(made);
    const suites = [fixtureSuite({ system: `${FIXTURE_SYSTEM} ` })];
    expect(await refusal(recordIn(made, file, suites))).toContain(
      'Replayed through the suite as it is now, 4 cases are stale: the prompt or the code changed since the run (greets, starts-politely, keeps-details-out, uses-the-name).',
    );
  });

  it('refuses a report that passed a threshold since raised', async () => {
    const made = workspace();
    const { file } = await run(made);
    expect(await refusal(recordIn(made, file, [fixtureSuite({ threshold: 0.8 })]))).toContain(
      "The score 0.75 is below the suite's threshold of 0.8.",
    );
  });

  it('refuses a report for a job with no suite, and a file that is not a report', async () => {
    const made = workspace();
    const { file } = await run(made);
    expect(await refusal(recordIn(made, file, []))).toEqual([
      'No suite is registered for the job "replies".',
    ]);
    const broken = made.write('.data/evals/broken.json', '{');
    await expect(recordIn(made, broken)).rejects.toThrow(EvalDataError);
    await expect(recordIn(made, join(made.repoRoot, 'nowhere.json'))).rejects.toThrow(
      'the report is missing.',
    );
  });

  it('refuses to add to a registry that was edited by hand', async () => {
    const made = workspace();
    const { file } = await run(made);
    writeFileSync(made.registryPath, renderRegistry([]).replace('[]', '[ ]'));
    await expect(recordIn(made, file)).rejects.toThrow('was edited by hand');
    expect(existsSync(join(made.repoRoot, SONNET_REPORT))).toBe(false);
  });

  it('starts a registry where there is none yet', async () => {
    const made = workspace();
    const { file } = await run(made);
    const registryPath = join(made.repoRoot, 'registry/new/tested.gen.ts');
    const entry = await record({
      reportFile: file,
      repoRoot: made.repoRoot,
      registryPath,
      suites: [fixtureSuite()],
    });
    expect(readFileSync(registryPath, 'utf8')).toBe(renderRegistry([entry]));
  });
});

describe('the registry file', () => {
  const entry: TestedEntry = {
    job: 'replies',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    suiteVersion: 'replies/1',
    datasetHash: 'a'.repeat(64),
    passed: 2,
    total: 3,
    score: 2 / 3,
    testedOn: '2026-10-10',
    report: SONNET_REPORT,
  };
  const local: TestedEntry = {
    ...entry,
    job: 'automation_builder',
    provider: 'openai_compatible',
    model: 'Qwen/Qwen2.5-Coder-32B-Instruct:latest',
    passed: 3,
    score: 1,
    report: reportPath(
      'automation_builder',
      'openai_compatible',
      'Qwen/Qwen2.5-Coder-32B-Instruct:latest',
    ),
  };

  it('is a TypeScript file that says who writes it', () => {
    const text = renderRegistry([]);
    expect(text).toContain('Do not edit by hand');
    expect(text).toContain("import type { TestedEntry } from './entry.js';");
    expect(text.endsWith('export const TESTED: readonly TestedEntry[] = [];\n')).toBe(true);
  });

  it('is read back as it was written, in the order of job, provider and model', () => {
    const text = renderRegistry([entry, local]);
    expect(readRegistry(text, 'tested.gen.ts')).toEqual([local, entry]);
    expect(renderRegistry([local, entry])).toBe(text);
    expect(text).toContain("    model: 'claude-sonnet-5-5',\n");
    expect(text).toContain('    score: 0.6666666666666666,\n');
  });

  it('writes a value that does not fit its line on a line of its own, and reads it back', () => {
    // `    model: '…',` is exactly as wide as a line may be with a model id of 86 characters.
    const fits = { ...local, model: 'm'.repeat(86) };
    const tooWide = { ...local, model: 'n'.repeat(87) };
    const entries = [fits, tooWide].map((each) => ({
      ...each,
      report: reportPath(each.job, each.provider, each.model),
    }));
    const text = renderRegistry(entries);
    expect(text).toContain(`\n    model: '${'m'.repeat(86)}',\n`);
    expect(text).toContain(`\n    model:\n      '${'n'.repeat(87)}',\n`);
    expect(readRegistry(text, 'tested.gen.ts')).toEqual(entries);
  });

  it("passes the repository's own formatter, long lines and all", () => {
    const made = workspace();
    const wide = ['m'.repeat(86), 'n'.repeat(87)].map((model) => ({
      ...local,
      model,
      report: reportPath(local.job, local.provider, model),
    }));
    const file = made.write(
      'registry/formatted/tested.gen.ts',
      renderRegistry([entry, local, ...wide]),
    );
    const empty = made.write('registry/formatted/empty.gen.ts', renderRegistry([]));
    const prettier = join(REPO_ROOT, 'node_modules/prettier/bin/prettier.cjs');
    const output = execFileSync(
      process.execPath,
      [prettier, '--check', '--config', join(REPO_ROOT, '.prettierrc.json'), file, empty],
      { encoding: 'utf8' },
    );
    expect(output).toContain('All matched files use Prettier code style!');
  });

  it.each<[string, (text: string) => string]>([
    ['a changed header', (text) => text.replace('Do not edit', 'Feel free to edit')],
    ['a changed space', (text) => text.replace("    job: 'replies',", "    job:  'replies',")],
    [
      'an added field',
      (text) => text.replace("    job: 'replies',", "    job: 'replies',\n    note: 'x',"),
    ],
    ['a score that is not its counts', (text) => text.replace('0.6666666666666666', '0.9')],
    [
      'a report somewhere else',
      (text) => text.replace(SONNET_REPORT, 'evals/reports/replies/other.json'),
    ],
    ['a date that is not one', (text) => text.replace('2026-10-10', '10 October')],
    ['more passed than there are', (text) => text.replace('passed: 2,', 'passed: 4,')],
    [
      'an entry twice',
      (text) => text.replace('];\n', `${text.slice(text.indexOf('  {'), text.indexOf('];'))}];\n`),
    ],
    ['no list at all', () => 'export const TESTED = 1;\n'],
  ])('is refused with %s', (_name, change) => {
    const text = change(renderRegistry([entry]));
    expect(text).not.toBe(renderRegistry([entry]));
    expect(() => readRegistry(text, 'src/evals/tested.gen.ts')).toThrow(
      /^src\/evals\/tested\.gen\.ts: .*(edited by hand|twice)/,
    );
  });

  it('makes an entry from a report: its counts, its day and where it is kept', async () => {
    const made = workspace();
    const { report } = await run(made);
    expect(entryOf(report)).toMatchObject({
      passed: 3,
      total: 4,
      score: 0.75,
      testedOn: '2026-10-10',
      report: SONNET_REPORT,
    });
  });
});

describe('what else a report cannot be made to say', () => {
  it('refuses a report said to be complete though a case ended in an error', async () => {
    const made = workspace();
    const { file } = await run(made, {
      answer: (_request, caseId) =>
        caseId === 'uses-the-name'
          ? { outcome: 'paused', reason: 'limit_reached' }
          : says('Hello!'),
    });
    rewrite(file, (draft) => {
      draft['complete'] = true;
      draft['pass'] = true;
    });
    const problems = await refusal(recordIn(made, file));
    expect(problems).toContain(
      'The report does not add up: it says it is complete and 1 case ended in an error.',
    );
    expect(problems).toContain(
      'The run is incomplete: 1 case ended in an error (uses-the-name: paused).',
    );
  });

  it('refuses a report with a case marked failed against its own checks', async () => {
    const made = workspace();
    const { file } = await run(made);
    rewrite(file, (draft) => (casesOf(draft)[0] = { ...casesOf(draft)[0], pass: false }));
    expect(await refusal(recordIn(made, file))).toContain(
      'The report does not add up: case "greets" is marked failed though its checks passed.',
    );
  });

  it('refuses a report whose recording now passes a case it says failed', async () => {
    const made = workspace();
    const { file } = await run(made, { answer: allPass });
    // A passing run dressed down: the numbers agree with each other, and not with the replay.
    rewrite(file, (draft) => {
      draft['passed'] = 3;
      draft['score'] = 0.75;
      const last = casesOf(draft)[3];
      if (last === undefined) throw new Error('The report has no fourth case.');
      last['pass'] = false;
      last['checks'] = [{ type: 'contains', target: 'text', pass: false, reason: 'edited' }];
    });
    expect(await refusal(recordIn(made, file))).toEqual([
      'Replayed through the suite as it is now, case "uses-the-name" passes where the report says it failed.',
    ]);
  });

  it('runs the replay as whoever it is told to act for', async () => {
    const made = workspace();
    const { file } = await run(made);
    const seen: unknown[] = [];
    const watching: SuiteDefinition = {
      ...fixtureSuite(),
      run(evalCase, tools) {
        seen.push(tools.context);
        return fixtureSuite().run(evalCase, tools);
      },
    };
    const context = { ...EVAL_CONTEXT, correlationId: '22222222-2222-4222-8222-222222222222' };
    await record({
      reportFile: file,
      repoRoot: made.repoRoot,
      registryPath: made.registryPath,
      suites: [watching],
      context,
    });
    expect(seen).toEqual([context, context, context, context]);
  });
});

describe('forgetting a Tested model', () => {
  const sonnet = { job: 'replies', provider: 'anthropic', model: 'claude-sonnet-5-5' };

  it('takes its entry out of the registry and deletes its kept report, and no other', async () => {
    const made = workspace();
    await recordIn(made, (await run(made, { model: 'claude-haiku-4-5-20251001' })).file);
    await recordIn(made, (await run(made)).file);
    const where = { repoRoot: made.repoRoot, registryPath: made.registryPath };
    expect(forget({ ...sonnet, ...where })).toBe(true);
    const entries = readRegistry(readFileSync(made.registryPath, 'utf8'), 'tested.gen.ts');
    expect(entries.map((each) => each.model)).toEqual(['claude-haiku-4-5-20251001']);
    expect(existsSync(join(made.repoRoot, SONNET_REPORT))).toBe(false);
    expect(
      existsSync(
        join(made.repoRoot, reportPath('replies', 'anthropic', 'claude-haiku-4-5-20251001')),
      ),
    ).toBe(true);
    // Gone is gone: a second time there is nothing to forget.
    expect(forget({ ...sonnet, ...where })).toBe(false);
  });

  it('changes nothing when the registry does not list the model, or does not exist', async () => {
    const made = workspace();
    await recordIn(made, (await run(made)).file);
    const before = readFileSync(made.registryPath, 'utf8');
    const where = { repoRoot: made.repoRoot, registryPath: made.registryPath };
    expect(forget({ ...sonnet, model: 'claude-opus-5-5', ...where })).toBe(false);
    expect(forget({ ...sonnet, job: 'sorting', ...where })).toBe(false);
    expect(forget({ ...sonnet, provider: 'openai', ...where })).toBe(false);
    expect(readFileSync(made.registryPath, 'utf8')).toBe(before);
    expect(existsSync(join(made.repoRoot, SONNET_REPORT))).toBe(true);
    expect(
      forget({ ...sonnet, repoRoot: made.repoRoot, registryPath: join(made.repoRoot, 'none.ts') }),
    ).toBe(false);
  });

  it('refuses a registry that was edited by hand, and can never add to one', async () => {
    const made = workspace();
    await recordIn(made, (await run(made)).file);
    writeFileSync(made.registryPath, `${readFileSync(made.registryPath, 'utf8')}\n`);
    expect(() =>
      forget({ ...sonnet, repoRoot: made.repoRoot, registryPath: made.registryPath }),
    ).toThrow('was edited by hand');
    expect(existsSync(join(made.repoRoot, SONNET_REPORT))).toBe(true);
  });
});
