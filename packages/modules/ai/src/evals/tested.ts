// Which models have passed a job's eval suite. The answer comes from the registry the evals
// `record` command writes, and from nowhere else: a model is listed only after a live run
// passed the job's threshold, and the gate keeps every entry honest against its run report
// (evals/README.md).
import { listed } from './entry.js';
import { TESTED } from './tested.gen.js';

/** Whether the model passed the project's eval suite for the job, at its current version. */
export function isTested(job: string, provider: string, model: string): boolean {
  return listed(TESTED, job, provider, model);
}
