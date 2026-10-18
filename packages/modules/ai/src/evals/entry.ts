// One line of the registry of Tested models (tested.gen.ts). This file imports nothing, so
// that Settings can ask "is this model Tested?" without pulling in the harness.

/** A model that passed a job's eval suite: what it passed, when, and the run that shows it. */
export interface TestedEntry {
  readonly job: string;
  readonly provider: string;
  readonly model: string;
  /** The version of the suite's prompt the model was run against, such as `replies/1`. */
  readonly suiteVersion: string;
  /** SHA-256 of the suite's cases as they were on that run. */
  readonly datasetHash: string;
  readonly passed: number;
  readonly total: number;
  /** `passed / total`. */
  readonly score: number;
  /** YYYY-MM-DD, the day the run finished. */
  readonly testedOn: string;
  /** The run report, from the repository's root. */
  readonly report: string;
}

/**
 * Whether a model's name is that of a local stand-in. A run against a stand-in exercises
 * the job's code and evaluates no model, so it can never make anything Tested: `record`
 * refuses its report, and the gate refuses an entry that names one.
 */
export function isStandIn(model: string): boolean {
  return model.toLowerCase().startsWith('stand-in');
}

/** Whether the entries name this job, provider and model together. */
export function listed(
  entries: readonly TestedEntry[],
  job: string,
  provider: string,
  model: string,
): boolean {
  return entries.some(
    (entry) => entry.job === job && entry.provider === provider && entry.model === model,
  );
}
