// The gate: is every model the product calls Tested still shown to pass its job's suite? It
// needs no key and no network and costs nothing, so it runs in the module's ordinary unit
// tests on every change, and before a release.
//
//   gate            every dataset loads; every registry entry has its run report; the
//                   report is a live, complete, passing run of the current suite version
//                   and dataset; its recording, played back through the current suite and
//                   scorers, still passes the current threshold with no stale case.
//   gate --release  also: for every job that has a suite, the job's default model is Tested.
//
// A job with no suite yet is named and is not a failure: each job adds its suite with its
// own task.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { TenantContext } from '@repo/kernel';

import { loadSuite } from './dataset.js';
import { isStandIn, type TestedEntry } from './entry.js';
import { EvalDataError, plural } from './read.js';
import { readReportFile, reportPath, type RunReport } from './report.js';
import type { EvalSuite, SuiteDefinition } from './types.js';
import { verifyReport } from './verify.js';

export interface GateOptions {
  /** The repository's root: datasets and reports are under its `evals` folder. */
  readonly repoRoot: string;
  readonly suites: readonly SuiteDefinition[];
  /** The registry of Tested models. */
  readonly entries: readonly TestedEntry[];
  /** The gateway's jobs (AI_JOBS), to name those with no suite yet. */
  readonly jobs: readonly string[];
  /** The model each job uses until Settings chooses another (DEFAULT_JOB_MODELS). */
  readonly defaultModels: Readonly<
    Record<string, { readonly provider: string; readonly model: string }>
  >;
  readonly release?: boolean;
  readonly context?: TenantContext;
}

export interface GateResult {
  readonly ok: boolean;
  /** What was found, for a person to read. */
  readonly lines: readonly string[];
  /** Why the gate fails. Empty when it passes. */
  readonly problems: readonly string[];
}

const nameOf = (entry: Pick<TestedEntry, 'job' | 'provider' | 'model'>): string =>
  `${entry.job} ${entry.provider}/${entry.model}`;

/** The folders, or the files, directly under a folder; none when it is not there. */
function namesIn(folder: string, kind: 'folders' | 'files'): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((each) => (kind === 'folders' ? each.isDirectory() : each.isFile()))
    .map((each) => each.name)
    .sort();
}

const COMPARED = [
  'job',
  'provider',
  'model',
  'suiteVersion',
  'datasetHash',
  'passed',
  'total',
  'score',
  'testedOn',
] as const;

export async function runGate(options: GateOptions): Promise<GateResult> {
  const { repoRoot, entries } = options;
  const problems: string[] = [];
  const lines: string[] = [];

  // Every suite, and its dataset.
  const definitions = new Map<string, SuiteDefinition>();
  for (const definition of options.suites) {
    if (definitions.has(definition.job))
      problems.push(`The job "${definition.job}" has two suites.`);
    else definitions.set(definition.job, definition);
  }
  const suites = new Map<string, EvalSuite>();
  for (const [job, definition] of definitions) {
    try {
      suites.set(job, loadSuite(definition, repoRoot));
    } catch (error) {
      if (!(error instanceof EvalDataError)) throw error;
      problems.push(error.message);
    }
  }
  for (const folder of namesIn(join(repoRoot, 'evals/suites'), 'folders'))
    if (!definitions.has(folder))
      problems.push(`evals/suites/${folder} has a dataset and no suite in src/evals/suites.ts.`);

  // Every entry of the registry, against its report and the suite as it is now.
  const holding = new Map<string, TestedEntry>();
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const entry of entries) {
    const name = nameOf(entry);
    if (seen.has(name)) {
      if (!twice.has(name)) problems.push(`${name} is listed twice.`);
      twice.add(name);
      continue;
    }
    seen.add(name);
    const found = await entryProblems(entry, definitions, suites, options);
    problems.push(...found.map((problem) => `${name}: ${problem}`));
    if (found.length === 0 && suites.has(entry.job)) holding.set(name, entry);
  }
  const named = new Set(entries.map((entry) => entry.report));
  for (const job of namesIn(join(repoRoot, 'evals/reports'), 'folders'))
    for (const file of namesIn(join(repoRoot, 'evals/reports', job), 'files')) {
      const path = `evals/reports/${job}/${file}`;
      if (file.endsWith('.json') && !named.has(path))
        problems.push(`${path} is a report no entry of the registry names.`);
    }

  lines.push(
    `Evals gate: ${plural(definitions.size, 'suite', 'suites')}, ${plural(seen.size, 'Tested model', 'Tested models')}.`,
  );
  for (const suite of suites.values()) {
    const about = `${suite.job} (${suite.version}, ${plural(suite.cases.length, 'case', 'cases')}, threshold ${String(suite.threshold)})`;
    if (!entries.some((entry) => entry.job === suite.job))
      lines.push(`${about}: no model is Tested yet.`);
    for (const entry of holding.values())
      if (entry.job === suite.job)
        lines.push(
          `${about}: ${entry.provider}/${entry.model} passed ${String(entry.passed)} of ${String(entry.total)} on ${entry.testedOn} and still does from its recording.`,
        );
  }
  const without = options.jobs.filter((job) => !definitions.has(job));
  if (without.length > 0)
    lines.push(
      `Jobs with no suite yet: ${without.join(', ')}. That is not a failure: each job adds its suite with its own task.`,
    );

  if (options.release === true) {
    const tested: string[] = [];
    const before = problems.length;
    for (const job of definitions.keys()) {
      const chosen = Object.hasOwn(options.defaultModels, job)
        ? options.defaultModels[job]
        : undefined;
      if (chosen === undefined)
        problems.push(`Release: the job "${job}" has a suite and no default model.`);
      else if (!holding.has(nameOf({ job, ...chosen })))
        problems.push(
          `Release: the default model for ${job}, ${chosen.provider}/${chosen.model}, is not Tested.`,
        );
      else tested.push(`${job}: ${chosen.provider}/${chosen.model}`);
    }
    if (definitions.size === 0)
      lines.push('Release: no job has a suite yet, so no default model is checked.');
    else if (problems.length === before)
      lines.push(
        `Release: the default model of every job with a suite is Tested (${tested.join('; ')}).`,
      );
  }
  return { ok: problems.length === 0, lines, problems };
}

/** Why an entry does not hold. None: its model is still shown to pass. */
async function entryProblems(
  entry: TestedEntry,
  definitions: ReadonlyMap<string, SuiteDefinition>,
  suites: ReadonlyMap<string, EvalSuite>,
  options: GateOptions,
): Promise<string[]> {
  if (isStandIn(entry.model))
    return ['a stand-in is not a model: nothing it answers makes it Tested.'];
  const expected = reportPath(entry.job, entry.provider, entry.model);
  if (entry.report !== expected) return [`the entry must name its report as ${expected}.`];
  if (!definitions.has(entry.job)) return [`No suite is registered for the job "${entry.job}".`];
  const suite = suites.get(entry.job);
  // The suite did not load, which is already a problem of its own.
  if (suite === undefined) return [];
  let report: RunReport;
  try {
    report = readReportFile(join(options.repoRoot, expected), expected);
  } catch (error) {
    if (!(error instanceof EvalDataError)) throw error;
    return [error.message];
  }
  const said = { ...report, testedOn: report.finishedAt.slice(0, 10) };
  const different = COMPARED.filter((field) => entry[field] !== said[field]);
  const problems =
    different.length === 0
      ? []
      : [`the entry does not say what its report says (${different.join(', ')}).`];
  return [...problems, ...(await verifyReport(report, suite, options.context))];
}
