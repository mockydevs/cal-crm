import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from './cli.js';
import { bootstrapFile } from './index.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const lockFile = fileURLToPath(new URL('../migrations.lock', import.meta.url));
// The built program, as the migrate container runs it. `pnpm test:integration` builds first.
const program = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const run = promisify(execFile);
const GRAPHILE_NOT_CHECKED = "Graphile Worker's migrations aren't checked in a dry run.\n";

let postgres: Postgres;
let migrations: string[];
// The migrations in migrations.lock, and the drafts: files that aren't in it yet.
let locked: string[];
let drafts: string[];

beforeAll(async () => {
  postgres = await startPostgres({ bootstrapFile });
  migrations = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  const lockedNames = new Set(
    (await readFile(lockFile, 'utf8')).split('\n').map((line) => line.split(/\s+/)[1]),
  );
  locked = migrations.filter((name) => lockedNames.has(name));
  drafts = migrations.filter((name) => !lockedNames.has(name));
});

afterAll(async () => {
  await postgres.stop();
});

/** Collects what the CLI writes. */
function terminal() {
  const written = { stdout: '', stderr: '' };
  return {
    written,
    stdout: { write: (text: string) => (written.stdout += text) },
    stderr: { write: (text: string) => (written.stderr += text) },
  };
}

describe('migrate CLI', () => {
  it('applies the migrations to the database in DATABASE_OWNER_URL, a line for each', async () => {
    const database = await postgres.createDatabase();
    const output = terminal();

    const code = await main([], { DATABASE_OWNER_URL: postgres.url(database) }, output);

    expect(code).toBe(0);
    expect(output.written.stdout).toBe(
      migrations.map((name) => `Applied ${name}\n`).join('') + 'The database is up to date.\n',
    );
    expect(output.written.stderr).toBe('');
  });

  it('lists what it would apply with --dry-run, and changes nothing', async () => {
    const database = await postgres.createDatabase();
    const env = { DATABASE_OWNER_URL: postgres.url(database) };
    const dryRun = terminal();

    const code = await main(['--dry-run'], env, dryRun);

    expect(code).toBe(0);
    expect(dryRun.written.stdout).toBe(
      migrations.map((name) => `Would apply ${name}\n`).join('') + GRAPHILE_NOT_CHECKED,
    );
    const realRun = terminal();
    await main([], env, realRun);
    expect(realRun.written.stdout).toContain(`Applied ${migrations[0] ?? ''}\n`);
  });

  it('applies only the locked migrations with --locked-only, and names each draft it skipped', async () => {
    const database = await postgres.createDatabase();
    const env = { DATABASE_OWNER_URL: postgres.url(database) };
    const dryRun = terminal();
    const output = terminal();

    const dryRunCode = await main(['--dry-run', '--locked-only'], env, dryRun);
    const code = await main(['--locked-only'], env, output);

    const skippedLines = drafts.map((name) => `Skipped ${name}: a draft, not in migrations.lock\n`);
    expect(dryRunCode).toBe(0);
    expect(dryRun.written.stdout).toBe(
      locked.map((name) => `Would apply ${name}\n`).join('') +
        skippedLines.join('') +
        GRAPHILE_NOT_CHECKED,
    );
    expect(code).toBe(0);
    expect(output.written.stdout).toBe(
      locked.map((name) => `Applied ${name}\n`).join('') +
        skippedLines.join('') +
        'The database is up to date.\n',
    );
    expect(output.written.stderr).toBe('');
  });

  it('says so when there is nothing to apply', async () => {
    const database = await postgres.createDatabase();
    const env = { DATABASE_OWNER_URL: postgres.url(database) };
    await main([], env, terminal());

    const realRun = terminal();
    expect(await main([], env, realRun)).toBe(0);
    expect(realRun.written.stdout).toBe('The database is up to date.\n');
    const dryRun = terminal();
    expect(await main(['--dry-run'], env, dryRun)).toBe(0);
    expect(dryRun.written.stdout).toBe('No migrations to apply.\n' + GRAPHILE_NOT_CHECKED);
  });

  it("installs Graphile Worker's job queue too", async () => {
    const database = await postgres.createDatabase();

    await main([], { DATABASE_OWNER_URL: postgres.url(database) }, terminal());

    const client = new pg.Client({ connectionString: postgres.url(database) });
    await client.connect();
    try {
      const { rows } = await client.query<{ installed: boolean }>(
        "select to_regclass('graphile_worker.jobs') is not null as installed",
      );
      expect(rows).toEqual([{ installed: true }]);
    } finally {
      await client.end();
    }
  });

  it("prints Graphile Worker's warnings on stderr", async () => {
    const database = await postgres.createDatabase();
    const env = { DATABASE_OWNER_URL: postgres.url(database) };
    await main([], env, terminal());
    // As if a later release had migrated the queue and this one were rolled back to.
    const client = new pg.Client({ connectionString: postgres.url(database) });
    await client.connect();
    try {
      await client.query('insert into graphile_worker.migrations (id) values (999)');
    } finally {
      await client.end();
    }
    const output = terminal();

    const code = await main([], env, output);

    expect(code).toBe(0);
    expect(output.written.stderr).toMatch(
      /^Warning: Database is using Graphile Worker schema revision 999\b.*\n$/,
    );
  });

  it('exits with 1 and the reason when it fails', async () => {
    const database = await postgres.createDatabase();
    const url = new URL(postgres.url(database));
    url.password = 'not-the-password';
    const output = terminal();

    const code = await main([], { DATABASE_OWNER_URL: url.toString() }, output);

    expect(code).toBe(1);
    expect(output.written.stderr).toBe(
      'Error: password authentication failed for user "crm_owner"\n',
    );
    expect(output.written.stderr).not.toContain('not-the-password');
  });

  it('exits with 2 when DATABASE_OWNER_URL is missing', async () => {
    const output = terminal();

    const code = await main([], {}, output);

    expect(code).toBe(2);
    expect(output.written.stderr).toMatch(/^Error: DATABASE_OWNER_URL isn't set\./);
  });

  it('exits with 2 and shows the usage for an option it does not know', async () => {
    const output = terminal();

    const code = await main(['--force'], {}, output);

    expect(code).toBe(2);
    expect(output.written.stderr).toMatch(/^Error: Unknown option '--force'/);
    expect(output.written.stderr).toContain('Usage: migrate [--dry-run]');
  });

  it('shows the usage with --help', async () => {
    const output = terminal();

    const code = await main(['--help'], {}, output);

    expect(code).toBe(0);
    expect(output.written.stdout).toMatch(/^Usage: migrate \[--dry-run\] \[--locked-only\]\n/);
    expect(output.written.stdout).toContain('--locked-only');
    expect(output.written.stdout).toContain('DATABASE_OWNER_URL');
  });

  it('runs as a program, exiting with 0 when done and 1 when it fails', async () => {
    const database = await postgres.createDatabase();
    const env = { ...process.env, DATABASE_OWNER_URL: postgres.url(database) };

    const done = await run(process.execPath, [program], { env });
    expect(done.stdout).toMatch(/The database is up to date\.\n$/);

    const wrongPassword = new URL(postgres.url(database));
    wrongPassword.password = 'not-the-password';
    await expect(
      run(process.execPath, [program], {
        env: { ...env, DATABASE_OWNER_URL: wrongPassword.toString() },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });
});
