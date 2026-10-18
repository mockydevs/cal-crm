// A throwaway copy of the folders the harness reads and writes (evals/suites,
// evals/reports and the registry file), so that no test touches the repository's own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { suiteCasesPath } from '../dataset.js';
import { renderRegistry } from '../registry.js';
import { FIXTURE_JOB, fixtureDataset } from './suite.js';

export interface Workspace {
  readonly repoRoot: string;
  readonly registryPath: string;
  /** Writes a file under the workspace, creating its folders. */
  write(path: string, text: string): string;
  remove(): void;
}

/** `dataset: null` leaves the suite's folder out. */
export function makeWorkspace(
  options: { readonly job?: string; readonly dataset?: string | null } = {},
): Workspace {
  const repoRoot = mkdtempSync(join(tmpdir(), 'crm-evals-'));
  const write = (path: string, text: string): string => {
    const file = join(repoRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const job = options.job ?? FIXTURE_JOB;
  const dataset = options.dataset === undefined ? fixtureDataset(job) : options.dataset;
  if (dataset !== null) write(suiteCasesPath(job), dataset);
  const registryPath = write('registry/tested.gen.ts', renderRegistry([]));
  return {
    repoRoot,
    registryPath,
    write,
    remove: () => {
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}
