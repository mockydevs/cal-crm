// Lints the whole repository: each workspace in an ESLint process of its own, through
// Turborepo, then the files outside every workspace.
//
// The type-aware rules keep a typed program in memory for everything a run touches. The whole
// tree in one process outgrew the 4096 MiB that CI allows, then three passes did, then the
// modules alone, then the apps together (2026-10-13). One workspace at a time stays far below
// it, and a new module, package or app is linted once its package.json has a lint script.
//
// Turborepo keeps a workspace's result until something it lints changes: the workspace's own
// files, the root ESLint and TypeScript settings, the lockfile, or the build of a workspace it
// depends on (its dependsOn ^build), so a type changed in a dependency lints it again.
// ESLint's own --cache would not: it keys each file on its own content, and typed rules read
// other files' types.
import { spawnSync } from 'node:child_process';

const run = (command, args) =>
  spawnSync(command, args, { stdio: 'inherit', shell: true }).status === 0;

const failed = [];
if (!run('pnpm', ['exec', 'turbo', 'run', 'lint', '--concurrency=1', '--continue'])) {
  failed.push('the workspaces (see above)');
}
// Everything else: the files at the root and in folders that are not workspaces.
const rest = [
  'exec',
  'eslint',
  '.',
  ...['packages', 'apps', 'e2e'].flatMap((folder) => ['--ignore-pattern', `"${folder}/**"`]),
  '--max-warnings=0',
];
if (!run('pnpm', rest)) failed.push('the rest of the repository');

if (failed.length > 0) {
  process.stderr.write(`eslint failed in: ${failed.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('Linted every workspace and the rest.\n');
