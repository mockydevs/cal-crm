// pnpm dev: starts Postgres and Mailpit (compose.dev.yml), sets the database up, then runs
// the server and the dashboard. The server restarts whenever its code, or a package it
// uses, changes (turbo watch); the dashboard reloads itself (Vite).
//
// Setting up is safe to repeat: the bootstrap runs only on a new database, the migration
// runner skips what's applied, and the seed leaves existing rows alone. It applies only
// the migrations in packages/db/migrations.lock: a draft still being written isn't applied
// (the runner names each one it skips), so a draft that is later renumbered or changed
// never leaves this database ahead of the code. With --setup-only
// (pnpm dev:setup) it stops there, before running anything.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { builtInRoleSeedSql, DEVELOPMENT_AGENCY_ID } from './dev/builtin-roles.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const say = (message) => process.stdout.write(`\n▶ ${message}\n`);

if (!existsSync(at('.env'))) {
  copyFileSync(at('.env.example'), at('.env'));
  say('Created .env from .env.example');
} else {
  // A setting added to .env.example since .env was made, such as a new role's connection:
  // copy its line over, so an older .env keeps working. Settings already there stay as set.
  const example = readFileSync(at('.env.example'), 'utf8');
  const current = parseEnv(readFileSync(at('.env'), 'utf8'));
  const added = Object.keys(parseEnv(example)).filter((name) => !(name in current));
  if (added.length > 0) {
    const lines = example.split(/\r?\n/).filter((line) => added.includes(line.split('=')[0]));
    appendFileSync(at('.env'), `\n# Added from .env.example by pnpm dev\n${lines.join('\n')}\n`);
    say(`Added ${added.join(', ')} to .env from .env.example`);
  }
}
const env = { ...process.env, ...parseEnv(readFileSync(at('.env'), 'utf8')) };

/** Runs a command and stops everything if it fails. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`\n✖ ${command} ${args.join(' ')} exited with ${String(result.status)}\n`);
    process.exit(result.status ?? 1);
  }
  return result;
}

const compose = ['compose', '--file', 'compose.dev.yml'];
const psql = (user, database, file, variables = {}) =>
  run(
    'docker',
    [
      ...compose,
      'exec',
      '--no-TTY',
      'db',
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]),
      '-U',
      user,
      '-d',
      database,
    ],
    // The SQL goes in on stdin, so nothing is mounted into the container.
    {
      input: Buffer.isBuffer(file) ? file : readFileSync(file),
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );

say('Starting Postgres and Mailpit');
run('docker', [...compose, 'up', '--detach', '--wait']);

const roles = spawnSync(
  'docker',
  [
    ...compose,
    'exec',
    '--no-TTY',
    'db',
    'psql',
    '-X',
    '-tA',
    '-U',
    'postgres',
    '-c',
    "select count(*) from pg_roles where rolname = 'crm_owner'",
  ],
  { cwd: root, env, encoding: 'utf8' },
);
if (roles.stdout.trim() === '0') {
  say('Creating the roles and the crm database (packages/db/bootstrap)');
  const password = env.POSTGRES_PASSWORD ?? 'dev-only';
  psql('postgres', 'postgres', at('packages/db/bootstrap/0001_roles_and_database.sql'), {
    owner_password: password,
    app_password: password,
    auth_password: password,
    worker_password: password,
  });
}

const turbo = createRequire(import.meta.url).resolve('turbo/bin/turbo');

say('Applying the locked migrations (drafts not yet in packages/db/migrations.lock are skipped)');
run(process.execPath, [turbo, 'run', 'build', '--filter=@repo/db', '--output-logs=errors-only']);
run(process.execPath, [at('packages/db/dist/bin.js'), '--locked-only']);

say('Seeding the development agency, business and owner (scripts/dev/seed.sql)');
psql('crm_owner', 'crm', at('scripts/dev/seed.sql'));
psql('crm_owner', 'crm', Buffer.from(builtInRoleSeedSql(DEVELOPMENT_AGENCY_ID)));

if (process.argv.includes('--setup-only')) {
  say('The database is ready. `pnpm dev` runs the app.');
  process.exit(0);
}

say('Running the server (http://localhost:3000) and the dashboard (http://localhost:5173)');
process.stdout.write('  Mailpit, for outgoing email: http://localhost:8025\n\n');
const watch = spawn(
  process.execPath,
  [turbo, 'watch', 'dev', '--filter=@repo/server', '--filter=@repo/dashboard'],
  { cwd: root, env, stdio: 'inherit' },
);
watch.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => watch.kill(signal));
