import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapFile, migrate, migrateDatabase } from './index.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const testsDirectory = fileURLToPath(new URL('../tests/', import.meta.url));

let postgres: Postgres;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  postgres = await startPostgres({ bootstrapFile });
});

afterAll(async () => {
  await postgres.stop();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'crm-migrations-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A copy of the real migrations that a test may change. */
async function copyOfMigrations(): Promise<string> {
  const directory = await temporaryDirectory();
  await cp(migrationsDirectory, directory, { recursive: true });
  return directory;
}

/** A directory holding just these migration files. */
async function migrationsWith(files: Record<string, string>): Promise<string> {
  const directory = await temporaryDirectory();
  await Promise.all(
    Object.entries(files).map(([name, sql]) => writeFile(join(directory, name), sql)),
  );
  return directory;
}

/**
 * A directory holding a migrations folder with these files, and beside it a migrations.lock
 * listing the locked ones, each with its SHA-256 (or the given one), as the lock script writes it.
 */
async function lockedMigrationsWith(
  files: Record<string, string>,
  locked: readonly string[],
  lockedHashes: Readonly<Record<string, string>> = {},
): Promise<string> {
  const parent = await temporaryDirectory();
  const directory = join(parent, 'migrations');
  await mkdir(directory);
  await Promise.all(
    Object.entries(files).map(([name, sql]) => writeFile(join(directory, name), sql)),
  );
  const lines = locked.map((name) => {
    const hash =
      lockedHashes[name] ??
      createHash('sha256')
        .update(files[name] ?? '')
        .digest('hex');
    return `${hash}  ${name}\n`;
  });
  await writeFile(join(parent, 'migrations.lock'), lines.join(''));
  return directory;
}

async function tableExists(database: string, table: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: postgres.url(database) });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      'select to_regclass($1) is not null as exists',
      [table],
    );
    return rows[0]?.exists === true;
  } finally {
    await client.end();
  }
}

/** crm_owner's lock_timeout in this database only, so a test can wait past it quickly. */
async function shortLockTimeout(database: string): Promise<void> {
  const client = new pg.Client({ connectionString: postgres.url(database) });
  await client.connect();
  try {
    await client.query(
      `alter role crm_owner in database ${client.escapeIdentifier(database)} set lock_timeout = '200ms'`,
    );
  } finally {
    await client.end();
  }
}

/** Another migration run, holding the run lock (migrate.ts's RUN_LOCK) until it finishes. */
async function runInProgress(database: string): Promise<{ finish: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: postgres.url(database) });
  await client.connect();
  await client.query('select pg_advisory_lock(3141592653)');
  return {
    finish: async () => {
      await client.query('select pg_advisory_unlock(3141592653)');
      await client.end();
    },
  };
}

/**
 * Settles once a session in the database waits for an advisory lock, as a run waiting for
 * the run lock does, or once the run has settled without waiting.
 */
async function waitingForRunLock(database: string, run: Promise<unknown>): Promise<void> {
  const progress = { settled: false };
  void run.then(() => {
    progress.settled = true;
  });
  const client = new pg.Client({ connectionString: postgres.url(database) });
  await client.connect();
  try {
    for (;;) {
      const { rows } = await client.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`,
      );
      if ((rows[0]?.waiting ?? 0) > 0 || progress.settled) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await client.end();
  }
}

describe('migrate', () => {
  it('gives a fresh database every migration, and the schema suites pass on the result', async () => {
    const database = await postgres.createDatabase();

    const result = await migrate({ connectionString: postgres.url(database) });

    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql'));
    expect(result.applied).toEqual(files.sort());
    // 03_integrity.sql writes events, and an event queues a job (0036). The queue is
    // Graphile Worker's, which only migrateDatabase installs, so that suite runs below.
    for (const suite of ['01_catalog.sql', '02_tenant_isolation.sql']) {
      const { exitCode, output } = await postgres.psql(database, join(testsDirectory, suite));
      expect(exitCode, output).toBe(0);
    }
  });

  it('does nothing when run again', async () => {
    const database = await postgres.createDatabase();
    await migrate({ connectionString: postgres.url(database) });

    const result = await migrate({ connectionString: postgres.url(database) });

    expect(result.applied).toEqual([]);
  });

  it('refuses a migration that was edited after it was applied, and names the file', async () => {
    const database = await postgres.createDatabase();
    const directory = await copyOfMigrations();
    await migrate({ connectionString: postgres.url(database), directory });

    await appendFile(join(directory, '0005_crm.sql'), '\n-- an edit after the fact\n');

    await expect(migrate({ connectionString: postgres.url(database), directory })).rejects.toThrow(
      /0005_crm\.sql/,
    );
  });

  it('rolls back a migration that fails, names the file and line, and applies it once fixed', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({
      '0001_util.sql': 'create schema util;\n',
      '0002_things.sql':
        'create table util.things (id integer primary key);\nselect util.missing(1);\n',
    });

    const reported: string[] = [];
    const run = migrate({
      connectionString: postgres.url(database),
      directory,
      onApplied: (name) => reported.push(name),
    });

    await expect(run).rejects.toThrow(
      '0002_things.sql failed at line 2, column 8: function util.missing(integer) does not exist\n' +
        'Hint: No function matches the given name and argument types. You might need to add ' +
        'explicit type casts.',
    );
    expect(reported).toEqual(['0001_util.sql']);
    expect(await tableExists(database, 'util.things')).toBe(false);

    await writeFile(
      join(directory, '0002_things.sql'),
      'create table util.things (id integer primary key);\n',
    );
    const retry = await migrate({ connectionString: postgres.url(database), directory });

    expect(retry.applied).toEqual(['0002_things.sql']);
    expect(await tableExists(database, 'util.things')).toBe(true);
  });

  it('lists what it would apply on a dry run, and changes nothing', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({
      '0001_util.sql': 'create schema util;\n',
      '0002_things.sql': 'create table util.things (id integer primary key);\n',
    });

    const dryRun = await migrate({
      connectionString: postgres.url(database),
      directory,
      dryRun: true,
    });

    expect(dryRun).toEqual({
      applied: [],
      pending: ['0001_util.sql', '0002_things.sql'],
      skipped: [],
    });
    const realRun = await migrate({ connectionString: postgres.url(database), directory });
    expect(realRun).toEqual({
      applied: ['0001_util.sql', '0002_things.sql'],
      pending: [],
      skipped: [],
    });
  });

  it('refuses a database with an applied migration that the directory lacks', async () => {
    const database = await postgres.createDatabase();
    const newer = await migrationsWith({
      '0001_util.sql': 'create schema util;\n',
      '0002_things.sql': 'create table util.things (id integer primary key);\n',
    });
    await migrate({ connectionString: postgres.url(database), directory: newer });
    const older = await migrationsWith({ '0001_util.sql': 'create schema util;\n' });

    await expect(
      migrate({ connectionString: postgres.url(database), directory: older }),
    ).rejects.toThrow(/0002_things\.sql was applied to this database, but isn't in /);
  });

  it('refuses a new migration that sorts before one already applied', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({
      '0001_util.sql': 'create schema util;\n',
      '0003_later.sql': 'create table util.later (id integer primary key);\n',
    });
    await migrate({ connectionString: postgres.url(database), directory });

    await writeFile(
      join(directory, '0002_earlier.sql'),
      'create table util.earlier (id integer primary key);\n',
    );

    await expect(migrate({ connectionString: postgres.url(database), directory })).rejects.toThrow(
      '0002_earlier.sql sorts before 0003_later.sql, which is already applied',
    );
    expect(await tableExists(database, 'util.earlier')).toBe(false);
  });

  it('runs one at a time: of two runs started together, one applies everything', async () => {
    const database = await postgres.createDatabase();

    const runs = await Promise.all([
      migrate({ connectionString: postgres.url(database) }),
      migrate({ connectionString: postgres.url(database) }),
    ]);

    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql'));
    expect(runs.map((run) => run.applied.length).sort()).toEqual([0, files.length]);
  });

  // crm_owner's lock_timeout (5s at install) keeps a migration's statements from queueing
  // behind live traffic. A run waiting for another run isn't that, and a full run outlasts
  // it on a slow machine (CI 37833565342). These tests shorten it to 200ms in their database.
  it("waits for a run in progress past crm_owner's lock_timeout, then applies", async () => {
    const database = await postgres.createDatabase();
    await shortLockTimeout(database);
    const directory = await migrationsWith({ '0001_util.sql': 'create schema util;\n' });
    const other = await runInProgress(database);

    const settled = Promise.allSettled([
      migrate({ connectionString: postgres.url(database), directory }),
    ]);
    try {
      // Only once it's waiting for the lock: from then, 700ms is well past the 200ms
      // lock_timeout, however slowly it got there.
      await waitingForRunLock(database, settled);
      await new Promise((resolve) => setTimeout(resolve, 700));
    } finally {
      await other.finish();
    }

    const [result] = await settled;
    expect(result).toMatchObject({ status: 'fulfilled', value: { applied: ['0001_util.sql'] } });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'refuses %s as the wait for a run in progress, before connecting',
    async (runLockWaitMs) => {
      // 0 would turn lock_timeout off, and wait for ever; Postgres takes whole milliseconds up
      // to 2147483647 (pg_settings for lock_timeout).
      await expect(
        migrate({ connectionString: 'postgres://nobody@127.0.0.1:1/none', runLockWaitMs }),
      ).rejects.toThrow(
        /^runLockWaitMs must be a whole number of milliseconds from 1 to 2147483647, not /,
      );
    },
  );

  it('takes the longest wait lock_timeout allows', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({ '0001_util.sql': 'create schema util;\n' });
    const result = await migrate({
      connectionString: postgres.url(database),
      directory,
      runLockWaitMs: 2_147_483_647,
    });
    expect(result.applied).toEqual(['0001_util.sql']);
  });

  it('gives up waiting for a run in progress after its own wait, saying why', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({ '0001_util.sql': 'create schema util;\n' });
    const other = await runInProgress(database);

    try {
      await expect(
        migrate({ connectionString: postgres.url(database), directory, runLockWaitMs: 300 }),
      ).rejects.toThrow(
        /^Another migration run has held the run lock for over 0\.3 seconds\. Let it finish/,
      );
    } finally {
      await other.finish();
    }
    expect(await tableExists(database, 'util.applied_migrations')).toBe(false);
  });

  it("still stops a migration that waits on live traffic after crm_owner's lock_timeout", async () => {
    const database = await postgres.createDatabase();
    await shortLockTimeout(database);
    const directory = await migrationsWith({
      '0001_util.sql': 'create schema util;\ncreate table util.things (id integer primary key);\n',
    });
    await migrate({ connectionString: postgres.url(database), directory });
    await writeFile(
      join(directory, '0002_more.sql'),
      'alter table util.things add column note text;\n',
    );
    const traffic = new pg.Client({ connectionString: postgres.url(database) });
    await traffic.connect();
    await traffic.query('begin');
    await traffic.query('lock table util.things in access share mode');

    try {
      await expect(
        migrate({ connectionString: postgres.url(database), directory }),
      ).rejects.toThrow(/^0002_more\.sql failed: canceling statement due to lock timeout/);
    } finally {
      await traffic.query('rollback');
      await traffic.end();
    }
  });

  it.each([
    ['a name without a four-digit number', '12_things.sql', /12_things\.sql isn't named/],
    ['a name with capitals', '0002_Things.sql', /0002_Things\.sql isn't named/],
    ['an extension in capitals', '0002_things.SQL', /0002_things\.SQL isn't named/],
    ['a number another migration uses', '0001_things.sql', /0001_things\.sql and 0001_util\.sql/],
  ])('refuses %s before applying anything', async (_case, name, message) => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({
      '0001_util.sql': 'create schema util;\n',
      [name]: 'create table util.things (id integer primary key);\n',
    });

    await expect(migrate({ connectionString: postgres.url(database), directory })).rejects.toThrow(
      message,
    );
    const dryRun = migrate({ connectionString: postgres.url(database), directory, dryRun: true });
    await expect(dryRun).rejects.toThrow(message);
    expect(await tableExists(database, 'util.applied_migrations')).toBe(false);
  });

  it('names the file, with the details, when a migration fails as it commits', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({
      '0001_util.sql': [
        'create schema util;',
        'create table util.parents (id integer primary key);',
        'create table util.children (',
        '  parent_id integer references util.parents deferrable initially deferred',
        ');',
        'insert into util.children values (1);',
        '',
      ].join('\n'),
    });

    await expect(migrate({ connectionString: postgres.url(database), directory })).rejects.toThrow(
      '0001_util.sql failed as it committed: insert or update on table "children" violates ' +
        'foreign key constraint "children_parent_id_fkey"\n' +
        'Key (parent_id)=(1) is not present in table "parents".',
    );
    expect(await tableExists(database, 'util.parents')).toBe(false);
  });

  it('says where a failure inside a DO block happened', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({
      '0001_util.sql': [
        'create schema util;',
        'do $$',
        'begin',
        "  raise exception 'the check failed';",
        'end',
        '$$;',
        '',
      ].join('\n'),
    });

    await expect(migrate({ connectionString: postgres.url(database), directory })).rejects.toThrow(
      '0001_util.sql failed: the check failed\n' +
        'Context: PL/pgSQL function inline_code_block line 3 at RAISE',
    );
  });

  it('explains that the first migration must create the util schema', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({ '0001_first.sql': 'select 1;\n' });

    await expect(migrate({ connectionString: postgres.url(database), directory })).rejects.toThrow(
      "0001_first.sql ran, but couldn't be recorded: the first migration must create the util " +
        'schema, which holds util.applied_migrations.',
    );
  });

  it('ignores files that are not SQL', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({
      '0001_util.sql': 'create schema util;\n',
      'README.md': '# Notes about these migrations\n',
    });

    const result = await migrate({ connectionString: postgres.url(database), directory });

    expect(result.applied).toEqual(['0001_util.sql']);
  });
});

describe('migrate with lockedOnly', () => {
  const draftLayout = {
    '0001_util.sql': 'create schema util;\n',
    '0002_things.sql': 'create table util.things (id integer primary key);\n',
    '0003_draft.sql': 'create table util.draft (id integer primary key);\n',
  };

  it('applies only the migrations in migrations.lock, and reports the drafts it skipped', async () => {
    const database = await postgres.createDatabase();
    const directory = await lockedMigrationsWith(draftLayout, ['0001_util.sql', '0002_things.sql']);

    const dryRun = await migrate({
      connectionString: postgres.url(database),
      directory,
      dryRun: true,
      lockedOnly: true,
    });
    const realRun = await migrate({
      connectionString: postgres.url(database),
      directory,
      lockedOnly: true,
    });

    expect(dryRun).toEqual({
      applied: [],
      pending: ['0001_util.sql', '0002_things.sql'],
      skipped: ['0003_draft.sql'],
    });
    expect(realRun).toEqual({
      applied: ['0001_util.sql', '0002_things.sql'],
      pending: [],
      skipped: ['0003_draft.sql'],
    });
    expect(await tableExists(database, 'util.things')).toBe(true);
    expect(await tableExists(database, 'util.draft')).toBe(false);
  });

  it('keeps skipping a draft on later runs, and applies it once it is locked', async () => {
    const database = await postgres.createDatabase();
    const draft = await lockedMigrationsWith(draftLayout, ['0001_util.sql', '0002_things.sql']);
    await migrate({ connectionString: postgres.url(database), directory: draft, lockedOnly: true });

    const again = await migrate({
      connectionString: postgres.url(database),
      directory: draft,
      lockedOnly: true,
    });
    const locked = await lockedMigrationsWith(draftLayout, Object.keys(draftLayout));
    const afterLocking = await migrate({
      connectionString: postgres.url(database),
      directory: locked,
      lockedOnly: true,
    });

    expect(again).toEqual({ applied: [], pending: [], skipped: ['0003_draft.sql'] });
    expect(afterLocking).toEqual({ applied: ['0003_draft.sql'], pending: [], skipped: [] });
    expect(await tableExists(database, 'util.draft')).toBe(true);
  });

  it('refuses a locked migration whose file differs from the lock, and applies nothing', async () => {
    const database = await postgres.createDatabase();
    const directory = await lockedMigrationsWith(
      draftLayout,
      ['0001_util.sql', '0002_things.sql'],
      { '0002_things.sql': '0'.repeat(64) },
    );

    await expect(
      migrate({ connectionString: postgres.url(database), directory, lockedOnly: true }),
    ).rejects.toThrow(
      '0002_things.sql changed after it was locked in migrations.lock. Locked migrations ' +
        'never change: put the change in a new migration.',
    );
    expect(await tableExists(database, 'util.applied_migrations')).toBe(false);
  });

  it('hashes a migration with Windows line endings as the lock does, with LF endings', async () => {
    const database = await postgres.createDatabase();
    const directory = await lockedMigrationsWith(
      { '0001_util.sql': 'create schema util;\r\n' },
      ['0001_util.sql'],
      {
        '0001_util.sql': createHash('sha256').update('create schema util;\n').digest('hex'),
      },
    );

    const result = await migrate({
      connectionString: postgres.url(database),
      directory,
      lockedOnly: true,
    });

    expect(result.applied).toEqual(['0001_util.sql']);
  });

  it('says where it looked when there is no migrations.lock', async () => {
    const database = await postgres.createDatabase();
    const directory = await migrationsWith({ '0001_util.sql': 'create schema util;\n' });

    await expect(
      migrate({ connectionString: postgres.url(database), directory, lockedOnly: true }),
    ).rejects.toThrow(
      /^Only locked migrations were asked for, but there's no lock file at .*migrations\.lock/,
    );
    expect(await tableExists(database, 'util.applied_migrations')).toBe(false);
  });

  it('applies drafts as before without the option, whatever the lock says', async () => {
    const database = await postgres.createDatabase();
    const directory = await lockedMigrationsWith(
      draftLayout,
      ['0001_util.sql', '0002_things.sql'],
      { '0002_things.sql': '0'.repeat(64) },
    );

    const result = await migrate({ connectionString: postgres.url(database), directory });

    expect(result).toEqual({
      applied: ['0001_util.sql', '0002_things.sql', '0003_draft.sql'],
      pending: [],
      skipped: [],
    });
  });

  it('leaves a draft that an earlier run applied as it is', async () => {
    const database = await postgres.createDatabase();
    const directory = await lockedMigrationsWith(draftLayout, ['0001_util.sql', '0002_things.sql']);
    await migrate({ connectionString: postgres.url(database), directory });

    const result = await migrate({
      connectionString: postgres.url(database),
      directory,
      lockedOnly: true,
    });

    expect(result).toEqual({ applied: [], pending: [], skipped: [] });
  });
});

describe('migrateDatabase', () => {
  const suites = ['01_catalog.sql', '02_tenant_isolation.sql', '03_integrity.sql'];

  it("applies the SQL migrations, then Graphile Worker's, and the SQL suites pass on the result", async () => {
    const database = await postgres.createDatabase();

    const result = await migrateDatabase({ connectionString: postgres.url(database) });

    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql'));
    expect(result).toEqual({ applied: files.sort(), pending: [], skipped: [], warnings: [] });
    expect(await tableExists(database, 'graphile_worker.jobs')).toBe(true);
    for (const suite of suites) {
      const { exitCode, output } = await postgres.psql(database, join(testsDirectory, suite));
      expect(exitCode, output).toBe(0);
    }
  });

  it('does nothing when run again', async () => {
    const database = await postgres.createDatabase();
    await migrateDatabase({ connectionString: postgres.url(database) });

    const result = await migrateDatabase({ connectionString: postgres.url(database) });

    expect(result).toEqual({ applied: [], pending: [], skipped: [], warnings: [] });
  });

  it('changes nothing on a dry run, the queue included', async () => {
    const database = await postgres.createDatabase();

    const result = await migrateDatabase({
      connectionString: postgres.url(database),
      dryRun: true,
    });

    expect(result.applied).toEqual([]);
    expect(result.pending).toContain('0013_jobs.sql');
    expect(await tableExists(database, 'graphile_worker.jobs')).toBe(false);
  });

  it("passes on Graphile Worker's warnings, such as a queue newer than it knows", async () => {
    const database = await postgres.createDatabase();
    await migrateDatabase({ connectionString: postgres.url(database) });
    // As if a later release had migrated the queue and this one were rolled back to.
    const client = new pg.Client({ connectionString: postgres.url(database) });
    await client.connect();
    try {
      await client.query('insert into graphile_worker.migrations (id) values (999)');
    } finally {
      await client.end();
    }

    const result = await migrateDatabase({ connectionString: postgres.url(database) });

    expect(result.warnings).toEqual([
      expect.stringContaining('Database is using Graphile Worker schema revision 999'),
    ]);
  });
});
