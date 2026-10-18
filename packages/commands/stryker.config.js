import { readFileSync } from 'node:fs';

// The guards of the command layer, mutated against the integration tests that prove them:
// the permission check, and the check that holds an assistant to its autonomy rule. The
// rules with no database in them have a run of their own (stryker.rules.config.json).
//
// Locate each guard by name so unrelated command-pipeline edits cannot shift the mutation
// ranges away from it. Fail rather than silently checking the wrong lines.
const source = readFileSync(new URL('./src/run-command.ts', import.meta.url), 'utf8');
/** @param {number} offset */
const lineAt = (offset) => source.slice(0, offset).split('\n').length;

/**
 * The lines of an exported function, and the line that calls it.
 * @param {string} name
 */
function guard(name) {
  const start = source.indexOf(`export async function ${name}`);
  const end = source.indexOf('\n}', start);
  const call = source.indexOf(`await ${name}(`);
  if (start < 0 || end < start || call < 0) {
    throw new Error(`Cannot locate ${name} and its call for mutation testing.`);
  }
  return [
    `src/run-command.ts:${lineAt(start)}-${lineAt(end + 1)}`,
    `src/run-command.ts:${lineAt(call)}-${lineAt(call)}`,
  ];
}

export default {
  testRunner: 'command',
  commandRunner: {
    command:
      'pnpm exec vitest run --config vitest.integration.config.js src/run-command.int.test.ts src/autonomy.int.test.ts --reporter=dot',
  },
  coverageAnalysis: 'off',
  mutate: [...guard('requirePermission'), ...guard('requireAutonomy')],
  ignorePatterns: ['**', '!src/**/*.ts', '!test/**/*.ts', '!*.json', '!*.js'],
  concurrency: 4,
  timeoutMS: 60000,
  reporters: ['clear-text', 'json'],
  thresholds: { high: 100, low: 100, break: 100 },
};
