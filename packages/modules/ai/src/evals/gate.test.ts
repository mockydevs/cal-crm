import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AI_JOBS, DEFAULT_JOB_MODELS } from '../gateway.js';
import { loadSuite } from './dataset.js';
import type { TestedEntry } from './entry.js';
import { scriptedReport, type ScriptedReportOptions } from './fixtures/scripted.js';
import {
  FIXTURE_CASES,
  FIXTURE_SYSTEM,
  fixtureDataset,
  fixtureSuite,
  type FixtureSuiteOptions,
} from './fixtures/suite.js';
import { makeWorkspace, type Workspace } from './fixtures/workspace.js';
import { runGate, type GateOptions, type GateResult } from './gate.js';
import { REGISTRY_PATH, REPO_ROOT } from './paths.js';
import { record } from './record.js';
import { readRegistry, renderRegistry } from './registry.js';
import { serializeReport } from './report.js';
import { SUITES } from './suites.js';
import { TESTED } from './tested.gen.js';

const SONNET_REPORT = 'evals/reports/replies/anthropic--claude-sonnet-5-5.json';

const workspaces: Workspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.remove();
});
function workspace(options?: Parameters<typeof makeWorkspace>[0]): Workspace {
  const made = makeWorkspace(options);
  workspaces.push(made);
  return made;
}

/** A workspace in which a run of the fixture suite was recorded. */
async function recorded(
  options: ScriptedReportOptions & { readonly suite?: FixtureSuiteOptions } = {},
): Promise<{ made: Workspace; entries: readonly TestedEntry[] }> {
  const made = workspace(options.suite?.job === undefined ? {} : { job: options.suite.job });
  const suite = fixtureSuite(options.suite);
  const report = await scriptedReport(loadSuite(suite, made.repoRoot), options);
  const reportFile = made.write('.data/evals/run.json', serializeReport(report));
  await record({
    reportFile,
    repoRoot: made.repoRoot,
    registryPath: made.registryPath,
    suites: [suite],
  });
  return { made, entries: readRegistry(readFileSync(made.registryPath, 'utf8'), 'tested.gen.ts') };
}

const gate = (
  made: Workspace,
  entries: readonly TestedEntry[],
  options: Partial<GateOptions> = {},
): Promise<GateResult> =>
  runGate({
    repoRoot: made.repoRoot,
    suites: [fixtureSuite()],
    entries,
    jobs: AI_JOBS,
    defaultModels: DEFAULT_JOB_MODELS,
    ...options,
  });

function rewrite(file: string, change: (draft: Record<string, unknown>) => void): void {
  const draft = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(draft);
  writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`);
}

describe('the gate', () => {
  it('passes with no suite and no Tested model, and says so plainly', async () => {
    const made = workspace({ dataset: null });
    const result = await gate(made, [], { suites: [] });
    expect(result).toEqual({
      ok: true,
      problems: [],
      lines: [
        'Evals gate: 0 suites, 0 Tested models.',
        'Jobs with no suite yet: automation_builder, replies, briefings, sorting. That is not a failure: each job adds its suite with its own task.',
      ],
    });
  });

  it('passes when every Tested model still passes its suite from its recording', async () => {
    const { made, entries } = await recorded();
    const result = await gate(made, entries);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      'Evals gate: 1 suite, 1 Tested model.',
      'replies (fixture/1, 4 cases, threshold 0.75): anthropic/claude-sonnet-5-5 passed 3 of 4 on 2026-10-10 and still does from its recording.',
      'Jobs with no suite yet: automation_builder, briefings, sorting. That is not a failure: each job adds its suite with its own task.',
    ]);
  });

  it('passes a suite that no model was tested against yet', async () => {
    const made = workspace();
    const result = await gate(made, []);
    expect(result.ok).toBe(true);
    expect(result.lines).toContain(
      'replies (fixture/1, 4 cases, threshold 0.75): no model is Tested yet.',
    );
  });

  it('fails when an entry has no run report', async () => {
    const { made, entries } = await recorded();
    rmSync(join(made.repoRoot, SONNET_REPORT));
    const result = await gate(made, entries);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      `replies anthropic/claude-sonnet-5-5: ${SONNET_REPORT}: the report is missing.`,
    ]);
  });

  it('fails when the dataset was edited after the model was tested', async () => {
    const { made, entries } = await recorded();
    const [first, ...rest] = FIXTURE_CASES;
    if (first === undefined) throw new Error('The fixture has no case.');
    made.write(
      'evals/suites/replies/cases.json',
      fixtureDataset('replies', [{ ...first, input: { message: 'Hello there' } }, ...rest]),
    );
    const result = await gate(made, entries);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'replies anthropic/claude-sonnet-5-5: The dataset has changed since the run: its hash is not the one in the report.',
    );
  });

  it('fails when the score in the report was lowered or raised by hand', async () => {
    const { made, entries } = await recorded();
    rewrite(join(made.repoRoot, SONNET_REPORT), (draft) => (draft['score'] = 0.5));
    const result = await gate(made, entries);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'replies anthropic/claude-sonnet-5-5: The report does not add up: its score is not its passed cases over its total.',
    );
    expect(result.problems).toContain(
      'replies anthropic/claude-sonnet-5-5: the entry does not say what its report says (score).',
    );
  });

  it('fails when an entry says more than its report', async () => {
    const { made, entries } = await recorded();
    const [entry] = entries;
    if (entry === undefined) throw new Error('Nothing was recorded.');
    const result = await gate(made, [{ ...entry, passed: 4, score: 1 }]);
    expect(result.problems).toEqual([
      'replies anthropic/claude-sonnet-5-5: the entry does not say what its report says (passed, score).',
    ]);
    const moved = await gate(made, [{ ...entry, report: 'evals/reports/replies/other.json' }]);
    expect(moved.problems).toEqual([
      `replies anthropic/claude-sonnet-5-5: the entry must name its report as ${SONNET_REPORT}.`,
      `${SONNET_REPORT} is a report no entry of the registry names.`,
    ]);
  });

  it("fails when the suite's prompt changed, since the recording is then stale", async () => {
    const { made, entries } = await recorded();
    const result = await gate(made, entries, {
      suites: [fixtureSuite({ system: `${FIXTURE_SYSTEM}!` })],
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      'replies anthropic/claude-sonnet-5-5: Replayed through the suite as it is now, 4 cases are stale: the prompt or the code changed since the run (greets, starts-politely, keeps-details-out, uses-the-name).',
    ]);
  });

  it('fails when the threshold was raised above what the model scored', async () => {
    const { made, entries } = await recorded();
    const result = await gate(made, entries, { suites: [fixtureSuite({ threshold: 0.9 })] });
    expect(result.problems).toContain(
      "replies anthropic/claude-sonnet-5-5: The score 0.75 is below the suite's threshold of 0.9.",
    );
  });

  it('fails when the suite moved to another version', async () => {
    const { made, entries } = await recorded();
    const result = await gate(made, entries, {
      suites: [{ ...fixtureSuite(), version: 'fixture/2' }],
    });
    expect(result.problems).toContain(
      'replies anthropic/claude-sonnet-5-5: The suite is at version fixture/2 and the report is of version fixture/1.',
    );
  });

  it('fails on an entry that names a stand-in: nothing a stand-in answers makes it Tested', async () => {
    const { made, entries } = await recorded();
    const [entry] = entries;
    if (entry === undefined) throw new Error('No entry was recorded.');
    for (const model of ['stand-in', 'Stand-In-replies', 'stand-in/anything']) {
      const result = await gate(made, [{ ...entry, model }]);
      expect(result.ok).toBe(false);
      expect(result.problems).toContain(
        `replies anthropic/${model}: a stand-in is not a model: nothing it answers makes it Tested.`,
      );
    }
  });

  it('fails on an entry listed twice, and on one whose job has no suite', async () => {
    const { made, entries } = await recorded();
    const twice = await gate(made, [...entries, ...entries]);
    expect(twice.problems).toEqual(['replies anthropic/claude-sonnet-5-5 is listed twice.']);
    const orphan = await gate(made, entries, { suites: [] });
    expect(orphan.problems).toContain(
      'replies anthropic/claude-sonnet-5-5: No suite is registered for the job "replies".',
    );
  });

  it('fails on a dataset that does not load, naming the file', async () => {
    const made = workspace({ dataset: fixtureDataset('sorting') });
    const result = await gate(made, []);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      'evals/suites/replies/cases.json: "job" must be "replies", the name of its folder.',
    ]);
  });

  it('fails on a suite that is not one, or is there twice', async () => {
    const made = workspace();
    const bad = await gate(made, [], { suites: [fixtureSuite({ threshold: 2 })] });
    expect(bad.problems).toEqual([
      'The suite "replies": the threshold must be above 0 and at most 1.',
    ]);
    const twice = await gate(made, [], { suites: [fixtureSuite(), fixtureSuite()] });
    expect(twice.problems).toEqual(['The job "replies" has two suites.']);
  });

  it('fails on a dataset with no suite, and on a report with no entry', async () => {
    const { made, entries } = await recorded();
    made.write('evals/suites/briefings/cases.json', fixtureDataset('briefings'));
    made.write('evals/reports/replies/anthropic--claude-opus-5-5.json', '{}');
    // Not a report: a file that only keeps the folder in git.
    made.write('evals/reports/replies/.gitkeep', '');
    const result = await gate(made, entries);
    expect(result.problems).toEqual([
      'evals/suites/briefings has a dataset and no suite in src/evals/suites.ts.',
      'evals/reports/replies/anthropic--claude-opus-5-5.json is a report no entry of the registry names.',
    ]);
  });

  it('does not take an entry for a report that is of another model', async () => {
    const { made, entries } = await recorded();
    rewrite(join(made.repoRoot, SONNET_REPORT), (draft) => (draft['model'] = 'claude-opus-5-5'));
    const result = await gate(made, entries);
    expect(result.problems).toContain(
      'replies anthropic/claude-sonnet-5-5: the entry does not say what its report says (model).',
    );
  });
});

describe('the gate before a release', () => {
  it('passes with no suite, naming the jobs that have none', async () => {
    const made = workspace({ dataset: null });
    const result = await gate(made, [], { suites: [], release: true });
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      'Evals gate: 0 suites, 0 Tested models.',
      'Jobs with no suite yet: automation_builder, replies, briefings, sorting. That is not a failure: each job adds its suite with its own task.',
      'Release: no job has a suite yet, so no default model is checked.',
    ]);
  });

  it('passes when the default model of every job with a suite is Tested', async () => {
    const { made, entries } = await recorded();
    const result = await gate(made, entries, { release: true });
    expect(result.problems).toEqual([]);
    expect(result.lines).toContain(
      'Release: the default model of every job with a suite is Tested (replies: anthropic/claude-sonnet-5-5).',
    );
  });

  it("fails when a job's default model is not Tested, though another model is", async () => {
    const { made, entries } = await recorded({ model: 'claude-haiku-4-5-20251001' });
    expect((await gate(made, entries)).ok).toBe(true);
    const result = await gate(made, entries, { release: true });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      'Release: the default model for replies, anthropic/claude-sonnet-5-5, is not Tested.',
    ]);
  });

  it('fails when the default model is listed and its entry does not hold', async () => {
    const { made, entries } = await recorded();
    rmSync(join(made.repoRoot, SONNET_REPORT));
    const result = await gate(made, entries, { release: true });
    expect(result.problems).toEqual([
      `replies anthropic/claude-sonnet-5-5: ${SONNET_REPORT}: the report is missing.`,
      'Release: the default model for replies, anthropic/claude-sonnet-5-5, is not Tested.',
    ]);
  });

  it('fails for a suite whose job has no default model', async () => {
    const { made, entries } = await recorded({ suite: { job: 'summaries' } });
    const result = await gate(made, entries, {
      suites: [fixtureSuite({ job: 'summaries' })],
      release: true,
    });
    expect(result.problems).toEqual([
      'Release: the job "summaries" has a suite and no default model.',
    ]);
  });
});

describe('this repository', () => {
  const ownGate = (release: boolean): Promise<GateResult> =>
    runGate({
      repoRoot: REPO_ROOT,
      suites: SUITES,
      entries: TESTED,
      jobs: AI_JOBS,
      defaultModels: DEFAULT_JOB_MODELS,
      release,
    });

  it('passes its own gate: every suite loads and every Tested model still passes', async () => {
    const result = await ownGate(false);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toBe(
      `Evals gate: ${String(SUITES.length)} ${SUITES.length === 1 ? 'suite' : 'suites'}, ${String(TESTED.length)} Tested ${TESTED.length === 1 ? 'model' : 'models'}.`,
    );
  });

  it('is held back from a release by exactly the default models nobody has evaluated yet', async () => {
    // In the strength a release asks for, the gate fails for each job that has a suite and
    // whose default model has not passed it in a live run, and for nothing else. A job
    // gains a suite with its task; its default model is Tested only by a run made with a
    // real key and recorded (evals/README.md). So this list is what stands between the
    // repository and a release, and it shrinks only when a report is recorded.
    const untested = SUITES.map((suite) => ({
      job: suite.job,
      ...DEFAULT_JOB_MODELS[suite.job as keyof typeof DEFAULT_JOB_MODELS],
    })).filter(
      ({ job, provider, model }) =>
        !TESTED.some(
          (entry) => entry.job === job && entry.provider === provider && entry.model === model,
        ),
    );
    const result = await ownGate(true);
    expect(result.problems).toEqual(
      untested.map(
        ({ job, provider, model }) =>
          `Release: the default model for ${job}, ${provider}/${model}, is not Tested.`,
      ),
    );
    expect(result.ok).toBe(untested.length === 0);
    // Today: replies and sorting (which extraction runs as) each have a suite, and no live
    // run has been made of any model.
    expect(untested).toEqual([
      { job: 'replies', provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { job: 'sorting', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('ships the registry exactly as the record command wrote it', () => {
    const text = readFileSync(REGISTRY_PATH, 'utf8');
    expect(readRegistry(text, 'tested.gen.ts')).toEqual(TESTED);
    expect(text).toBe(renderRegistry(TESTED));
  });

  it('registers every suite under a job the gateway knows', () => {
    const jobs: readonly string[] = AI_JOBS;
    expect(SUITES.filter((suite) => !jobs.includes(suite.job))).toEqual([]);
  });
});

describe('a Tested model whose suite no longer loads', () => {
  it('is one problem, the dataset, and not a second one about the model', async () => {
    const { made, entries } = await recorded();
    made.write('evals/suites/replies/cases.json', '{ "job": ');
    const result = await gate(made, entries, { release: true });
    expect(result.problems).toEqual([
      'evals/suites/replies/cases.json: the file is not JSON.',
      'Release: the default model for replies, anthropic/claude-sonnet-5-5, is not Tested.',
    ]);
    expect(result.lines).toEqual([
      'Evals gate: 1 suite, 1 Tested model.',
      'Jobs with no suite yet: automation_builder, briefings, sorting. That is not a failure: each job adds its suite with its own task.',
    ]);
  });
});
