// Whether a run report is evidence that its model passes its job's suite as the suite is
// NOW. The `record` command asks before it marks a model Tested, and the gate asks again on
// every run, for every Tested model.
//
// A report is believed only as far as it can be checked: its numbers must add up, its
// suite version and dataset must be the current ones, and its recording, played back
// through the current suite code and the current scorers, must give the same verdicts and
// still pass the current threshold.
import type { TenantContext } from '@repo/kernel';

import { datasetHash } from './dataset.js';
import { isStandIn } from './entry.js';
import { plural } from './read.js';
import { createReplaySession } from './replay.js';
import type { RunReport } from './report.js';
import { runSuite, type RunResult } from './runner.js';
import type { EvalSuite } from './types.js';

const REPLAYED = 'Replayed through the suite as it is now, ';

/** What in a report contradicts the rest of it, as when a number was changed by hand. */
export function addUp(report: RunReport): string[] {
  const problems: string[] = [];
  const say = (problem: string): void => {
    problems.push(`The report does not add up: ${problem}`);
  };
  const { cases } = report;
  if (report.total !== cases.length)
    say(`it counts ${plural(report.total, 'case', 'cases')} and holds ${String(cases.length)}.`);
  const passed = cases.filter((each) => each.pass).length;
  if (report.passed !== passed)
    say(
      `it counts ${plural(report.passed, 'passed case', 'passed cases')} and holds ${String(passed)}.`,
    );
  if (report.score !== report.passed / report.total)
    say('its score is not its passed cases over its total.');
  const errors = cases.filter((each) => each.error !== undefined).length;
  if (report.complete && errors > 0)
    say(`it says it is complete and ${plural(errors, 'case', 'cases')} ended in an error.`);
  if (!report.complete && errors === 0)
    say('it says it is incomplete and no case ended in an error.');
  if (report.pass !== (report.complete && report.score >= report.threshold))
    say('its verdict is not what its score, threshold and errors give.');
  for (const each of cases) {
    const earned =
      each.error === undefined &&
      each.checks.length > 0 &&
      each.checks.every((check) => check.pass);
    if (each.pass && !earned) say(`case "${each.id}" is marked passed against its own checks.`);
    if (!each.pass && earned) say(`case "${each.id}" is marked failed though its checks passed.`);
  }
  return problems;
}

export interface Replayed {
  /** The replay's own result, when the recording could be played back at all. */
  readonly result?: RunResult;
  readonly problems: readonly string[];
}

/**
 * Plays a report's recording back through the suite as it is now. No model, no key, no
 * network. The problems say where the suite is no longer what the report was made against.
 */
export async function replayReport(
  report: RunReport,
  suite: EvalSuite,
  context?: TenantContext,
): Promise<Replayed> {
  const problems: string[] = [];
  if (suite.version !== report.suiteVersion)
    problems.push(
      `The suite is at version ${suite.version} and the report is of version ${report.suiteVersion}.`,
    );
  if (datasetHash(suite.cases) !== report.datasetHash)
    problems.push('The dataset has changed since the run: its hash is not the one in the report.');
  // Against another dataset or another version the recording has nothing to answer.
  if (problems.length > 0) return { problems };

  const result = await runSuite(
    suite,
    createReplaySession(report),
    context === undefined ? {} : { context },
  );
  const stale = result.cases.filter((each) => each.error?.category === 'stale');
  if (stale.length > 0)
    return {
      result,
      problems: [
        `${REPLAYED}${plural(stale.length, 'case is', 'cases are')} stale: the prompt or the code changed since the run (${stale.map((each) => each.id).join(', ')}).`,
      ],
    };
  const recorded = new Map(report.cases.map((each) => [each.id, each.pass]));
  for (const each of result.cases) {
    const before = recorded.get(each.id);
    if (before === true && !each.pass)
      problems.push(`${REPLAYED}case "${each.id}" fails where the report says it passed.`);
    if (before === false && each.pass)
      problems.push(`${REPLAYED}case "${each.id}" passes where the report says it failed.`);
  }
  return { result, problems };
}

/** Every reason the report does not show its model passing the suite as it is now. None: it does. */
export async function verifyReport(
  report: RunReport,
  suite: EvalSuite,
  context?: TenantContext,
): Promise<string[]> {
  const problems: string[] = [];
  if (isStandIn(report.model))
    problems.push(
      `The report is of a run against a stand-in ("${report.model}"), which evaluates no model: it marks nothing Tested.`,
    );
  if (report.mode !== 'live') problems.push('The report is of a replay, not of a live run.');
  problems.push(...addUp(report));
  const errors = report.cases.flatMap((each) =>
    each.error === undefined ? [] : [`${each.id}: ${each.error.category}`],
  );
  if (errors.length > 0)
    problems.push(
      `The run is incomplete: ${plural(errors.length, 'case', 'cases')} ended in an error (${errors.join(', ')}).`,
    );
  else if (!report.pass)
    problems.push(
      `The run did not pass: ${String(report.passed)} of ${String(report.total)} cases passed (${String(report.score)}) and the threshold was ${String(report.threshold)}.`,
    );
  if (report.score < suite.threshold)
    problems.push(
      `The score ${String(report.score)} is below the suite's threshold of ${String(suite.threshold)}.`,
    );

  const replayed = await replayReport(report, suite, context);
  problems.push(...replayed.problems);
  const { result } = replayed;
  // A stale recording says nothing about the model, so its score is not held against it.
  const stale = result?.cases.some((each) => each.error?.category === 'stale') ?? false;
  if (result !== undefined && !stale && !result.pass)
    problems.push(
      `${REPLAYED}the run does not pass: ${String(result.passed)} of ${String(result.total)} cases (${String(result.score)}) against a threshold of ${String(suite.threshold)}.`,
    );
  return problems;
}
