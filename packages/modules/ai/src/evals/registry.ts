// The registry of Tested models as a file (tested.gen.ts): how the `record` command writes
// it, and how it is read back. It is written in one exact form, already as Prettier would
// leave it, and read back only in that form: a registry someone edited by hand is refused,
// since an entry is meant to exist only because a report passed.
import { type TestedEntry } from './entry.js';
import { EVAL_PROVIDERS } from './eval-gateway.js';
import { EvalDataError, JOB_NAME, MODEL_ID, SHA_256, SUITE_VERSION } from './read.js';
import { reportPath, type RunReport } from './report.js';

const HEADER = `// Written by the evals \`record\` command: pnpm --filter @repo/module-ai evals -- record <report>
// Do not edit by hand. An entry exists because a live run passed its job's threshold, the
// gate checks each one against its run report, and a file that is not exactly what the
// command wrote is refused (evals/README.md).
import type { TestedEntry } from './entry.js';

/** The models that passed a job's eval suite, by job, then provider, then model. */
export const TESTED: readonly TestedEntry[] = [`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The registry entry a report stands for. Only a report that passed should become one. */
export function entryOf(report: RunReport): TestedEntry {
  return {
    job: report.job,
    provider: report.provider,
    model: report.model,
    suiteVersion: report.suiteVersion,
    datasetHash: report.datasetHash,
    passed: report.passed,
    total: report.total,
    score: report.score,
    testedOn: report.finishedAt.slice(0, 10),
    report: reportPath(report.job, report.provider, report.model),
  };
}

const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function sorted(entries: readonly TestedEntry[]): TestedEntry[] {
  return [...entries].sort(
    (left, right) =>
      order(left.job, right.job) ||
      order(left.provider, right.provider) ||
      order(left.model, right.model),
  );
}

const PRINT_WIDTH = 100;

/**
 * One property whose value is text, as Prettier leaves it: on one line when that fits in
 * the repository's print width, and otherwise with the value on a line of its own.
 */
function textLine(key: string, value: string): string {
  const line = `    ${key}: '${value}',`;
  return line.length <= PRINT_WIDTH ? line : `    ${key}:\n      '${value}',`;
}

function entryText(entry: TestedEntry): string {
  return [
    '  {',
    textLine('job', entry.job),
    textLine('provider', entry.provider),
    textLine('model', entry.model),
    textLine('suiteVersion', entry.suiteVersion),
    textLine('datasetHash', entry.datasetHash),
    `    passed: ${String(entry.passed)},`,
    `    total: ${String(entry.total)},`,
    `    score: ${String(entry.score)},`,
    textLine('testedOn', entry.testedOn),
    textLine('report', entry.report),
    '  },',
    '',
  ].join('\n');
}

/** The text of tested.gen.ts for these entries. The same entries always give the same bytes. */
export function renderRegistry(entries: readonly TestedEntry[]): string {
  if (entries.length === 0) return `${HEADER}];\n`;
  return `${HEADER}\n${sorted(entries).map(entryText).join('')}];\n`;
}

const ENTRY = new RegExp(
  [
    '  \\{',
    "    job: '([^'\\n]*)',",
    "    provider: '([^'\\n]*)',",
    "    model: '([^'\\n]*)',",
    "    suiteVersion: '([^'\\n]*)',",
    "    datasetHash: '([^'\\n]*)',",
    '    passed: (\\d{1,9}),',
    '    total: (\\d{1,9}),',
    '    score: (\\d(?:\\.\\d{1,20})?),',
    "    testedOn: '([^'\\n]*)',",
    "    report: '([^'\\n]*)',",
    '  \\},',
    '',
  ].join('\\n'),
  'g',
);

/** Whether an entry is one the record command could have written. */
function wellFormed(entry: TestedEntry): boolean {
  const providers: readonly string[] = EVAL_PROVIDERS;
  return (
    JOB_NAME.test(entry.job) &&
    providers.includes(entry.provider) &&
    MODEL_ID.test(entry.model) &&
    SUITE_VERSION.test(entry.suiteVersion) &&
    SHA_256.test(entry.datasetHash) &&
    entry.total >= 1 &&
    entry.passed <= entry.total &&
    entry.score === entry.passed / entry.total &&
    DAY.test(entry.testedOn) &&
    entry.report === reportPath(entry.job, entry.provider, entry.model)
  );
}

/**
 * The entries of a registry file. `file` names it in a refusal. Anything but the exact
 * text the record command writes for those entries is refused.
 */
export function readRegistry(text: string, file: string): TestedEntry[] {
  // A value on a line of its own (textLine) is read as if it were on its key's line.
  const joined = text.replaceAll(/:\n {6}'/g, ": '");
  const entries = [...joined.matchAll(ENTRY)].map((found): TestedEntry => {
    // The pattern's groups, in the order of the entry's fields.
    const field = (group: number): string => String(found[group]);
    return {
      job: field(1),
      provider: field(2),
      model: field(3),
      suiteVersion: field(4),
      datasetHash: field(5),
      passed: Number(field(6)),
      total: Number(field(7)),
      score: Number(field(8)),
      testedOn: field(9),
      report: field(10),
    };
  });
  const seen = new Set<string>();
  for (const { job, provider, model } of entries) {
    const name = `${job} ${provider}/${model}`;
    if (seen.has(name)) throw new EvalDataError(`${file}: ${name} is listed twice.`);
    seen.add(name);
  }
  if (!entries.every(wellFormed) || renderRegistry(entries) !== text)
    throw new EvalDataError(
      `${file}: the registry is not what the record command wrote: it was edited by hand. Restore it, and change it only with the record command.`,
    );
  return entries;
}

/** The entries with this one added, in place of an older one for the same job, provider and model. */
export function withEntry(entries: readonly TestedEntry[], entry: TestedEntry): TestedEntry[] {
  return sorted([
    ...entries.filter(
      (each) =>
        each.job !== entry.job || each.provider !== entry.provider || each.model !== entry.model,
    ),
    entry,
  ]);
}
