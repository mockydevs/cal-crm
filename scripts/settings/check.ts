// pnpm run settings:check: fails when a setting names no test that proves its effect and is
// not listed as a gap, and prints how many settings change nothing yet (target 0).
import { existsSync, readFileSync } from 'node:fs';
import { auditSettings } from './audit.ts';
import { effects } from './effects.ts';

const read = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined;

const audit = auditSettings({
  schema: readFileSync('packages/db/src/database.gen.ts', 'utf8'),
  effects,
  read,
});

const lines = [
  `Settings with no proven effect: ${String(audit.gaps.length)} of ${String(audit.settings)} (target 0)`,
  ...audit.gaps.map(({ setting, reason }) => `  ${setting}: ${reason}`),
];
process.stdout.write(`${lines.join('\n')}\n`);
if (audit.problems.length > 0) {
  process.stderr.write(
    `\nscripts/settings/effects.ts is out of step with the schema or the tests:\n${audit.problems
      .map((problem) => `  ${problem}`)
      .join('\n')}\n`,
  );
  process.exit(1);
}
