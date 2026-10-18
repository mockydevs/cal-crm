// The `record` command: the one way a model gets into the registry of Tested models. It
// takes a run report and adds its model only if the report is a live, complete, passing run
// of the suite as the suite is now, and playing its recording back gives the same verdicts.
// Anything else is refused, with the reasons, and nothing is written.
//
// `forget` is the way out of the registry. It can only remove.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { TenantContext } from '@repo/kernel';

import { loadSuite } from './dataset.js';
import type { TestedEntry } from './entry.js';
import { entryOf, readRegistry, renderRegistry, withEntry } from './registry.js';
import { readReportFile, serializeReport } from './report.js';
import type { SuiteDefinition } from './types.js';
import { verifyReport } from './verify.js';

/** The report does not show what a Tested model must have shown. */
export class RecordRefused extends Error {
  override readonly name = 'RecordRefused';

  constructor(readonly problems: readonly string[]) {
    super(`The report was not recorded: ${problems.join(' ')}`);
  }
}

export interface RecordOptions {
  /** The report to record, as an absolute path. */
  readonly reportFile: string;
  /** How the report is named in a refusal; its path from the root when left out. */
  readonly label?: string;
  /** The repository's root: datasets and kept reports are under its `evals` folder. */
  readonly repoRoot: string;
  /** The registry file to rewrite (tested.gen.ts). */
  readonly registryPath: string;
  readonly suites: readonly SuiteDefinition[];
  readonly context?: TenantContext;
}

/** Marks the report's model Tested for its job, or throws RecordRefused. */
export async function record(options: RecordOptions): Promise<TestedEntry> {
  const { reportFile, repoRoot, registryPath } = options;
  const label = options.label ?? relative(repoRoot, reportFile).replaceAll('\\', '/');
  const report = readReportFile(reportFile, label);
  const definition = options.suites.find((suite) => suite.job === report.job);
  if (definition === undefined)
    throw new RecordRefused([`No suite is registered for the job "${report.job}".`]);
  const problems = await verifyReport(report, loadSuite(definition, repoRoot), options.context);
  if (problems.length > 0) throw new RecordRefused(problems);

  // Read before anything is written: a registry that was edited by hand stops it here.
  const registryName = relative(repoRoot, registryPath).replaceAll('\\', '/');
  const entries = existsSync(registryPath)
    ? readRegistry(readFileSync(registryPath, 'utf8'), registryName)
    : [];
  const entry = entryOf(report);
  const kept = join(repoRoot, entry.report);
  mkdirSync(dirname(kept), { recursive: true });
  writeFileSync(kept, serializeReport(report));
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, renderRegistry(withEntry(entries, entry)));
  return entry;
}

export interface ForgetOptions {
  readonly job: string;
  readonly provider: string;
  readonly model: string;
  readonly repoRoot: string;
  readonly registryPath: string;
}

/**
 * Takes a model out of the registry, with its kept report: the way to say a model is no
 * longer Tested, as when a job's prompt changed and the model was not evaluated again. It
 * can only ever remove. False when the registry has no such entry, and then nothing changes.
 */
export function forget(options: ForgetOptions): boolean {
  const { repoRoot, registryPath } = options;
  if (!existsSync(registryPath)) return false;
  const registryName = relative(repoRoot, registryPath).replaceAll('\\', '/');
  const entries = readRegistry(readFileSync(registryPath, 'utf8'), registryName);
  const found = entries.find(
    (entry) =>
      entry.job === options.job &&
      entry.provider === options.provider &&
      entry.model === options.model,
  );
  if (found === undefined) return false;
  writeFileSync(registryPath, renderRegistry(entries.filter((entry) => entry !== found)));
  // The path is the registry's own, which readRegistry has checked is the one a report of
  // this job, provider and model is kept at.
  rmSync(join(repoRoot, found.report), { force: true });
  return true;
}
