// Written by the evals `record` command: pnpm --filter @repo/module-ai evals -- record <report>
// Do not edit by hand. An entry exists because a live run passed its job's threshold, the
// gate checks each one against its run report, and a file that is not exactly what the
// command wrote is refused (evals/README.md).
import type { TestedEntry } from './entry.js';

/** The models that passed a job's eval suite, by job, then provider, then model. */
export const TESTED: readonly TestedEntry[] = [];
