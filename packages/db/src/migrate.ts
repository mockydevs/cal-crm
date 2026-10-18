import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, DatabaseError } from 'pg';

const defaultDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

// A real run holds this advisory lock (scoped to the database) for its whole session, so
// overlapping runs take turns: the second waits, then finds nothing left to apply.
const RUN_LOCK = 3_141_592_653;

// How long a run waits for one in progress, by default. crm_owner's lock_timeout (5s at
// install) bounds a migration's statements, so they don't queue behind live traffic; a whole
// run takes longer than that, so waiting for one has its own bound.
const RUN_LOCK_WAIT_MS = 10 * 60 * 1000;

// lock_timeout takes whole milliseconds up to this (pg_settings); 0 would turn it off.
const LONGEST_LOCK_TIMEOUT_MS = 2_147_483_647;

// Created in the same transaction as the first migration, which creates the util schema.
const CREATE_APPLIED_MIGRATIONS = `
  create table util.applied_migrations (
    name text primary key
      constraint applied_migrations_name_format check (name ~ '^[0-9]{4}_[a-z0-9_]+\\.sql$'),
    sha256 bytea not null
      constraint applied_migrations_sha256_length check (length(sha256) = 32),
    applied_at timestamptz not null default now()
  );
  comment on table util.applied_migrations is
    'Migrations applied by packages/db/src/migrate.ts, with the SHA-256 of each file.';
`;

export interface MigrateOptions {
  /** A connection string for crm_owner, the role that owns the schema. */
  connectionString: string;
  /** Where the migration files are. Defaults to this package's migrations. */
  directory?: string;
  /** Work out what would be applied, and change nothing. */
  dryRun?: boolean;
  /**
   * Apply only the migrations listed in migrations.lock, beside the migrations directory,
   * and skip the rest: drafts still being written, which a development database shouldn't
   * take on before they're final. A locked file that no longer matches its hash in the lock
   * stops the run. Off by default: a deploy applies every migration it ships.
   */
  lockedOnly?: boolean;
  /** Called as each migration is committed, so a long run can report progress. */
  onApplied?: (name: string) => void;
  /**
   * How long to wait for another run to finish, in milliseconds: 10 minutes by default. The
   * statements in a migration still wait for locks only as long as crm_owner's lock_timeout.
   */
  runLockWaitMs?: number;
}

export interface MigrateResult {
  /** The migrations this run applied, in order. Empty on a dry run. */
  applied: string[];
  /** The migrations still to apply: what a real run would apply, after a dry run. */
  pending: string[];
  /** The drafts left alone because they aren't in migrations.lock. Empty without lockedOnly. */
  skipped: string[];
}

/** Why the migrations couldn't be applied, in words an operator can act on. */
export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

interface MigrationFile {
  name: string;
  sql: string;
  sha256: Buffer;
}

interface AppliedMigration {
  name: string;
  sha256: Buffer;
}

function pendingMigrations(
  directory: string,
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationFile[] {
  const filesByName = new Map(files.map((file) => [file.name, file]));
  for (const record of applied) {
    const file = filesByName.get(record.name);
    if (file === undefined) {
      throw new MigrationError(
        `${record.name} was applied to this database, but isn't in ${directory}. ` +
          'The database is newer than this code: run the version that applied it, or a later one.',
      );
    }
    if (!file.sha256.equals(record.sha256)) {
      throw new MigrationError(
        `${record.name} was edited after it was applied to this database. ` +
          'Applied migrations never change: put the change in a new migration.',
      );
    }
  }
  const appliedNames = new Set(applied.map((record) => record.name));
  const pending = files.filter((file) => !appliedNames.has(file.name));
  const lastApplied = applied.at(-1)?.name;
  const first = pending[0];
  if (first !== undefined && lastApplied !== undefined && first.name < lastApplied) {
    throw new MigrationError(
      `${first.name} sorts before ${lastApplied}, which is already applied, so it would run ` +
        `out of order. Rename it to sort after ${lastApplied}.`,
    );
  }
  return pending;
}

/** Where a 1-based character position (as Postgres reports it) falls in the text. */
function lineAndColumn(text: string, position: number): string {
  let line = 1;
  let column = 1;
  let index = 1;
  // Postgres counts characters, not UTF-16 units; for...of walks code points.
  for (const character of text) {
    if (index === position) {
      break;
    }
    if (character === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    index += 1;
  }
  return `line ${String(line)}, column ${String(column)}`;
}

/** The error's message, with the detail, hint and context Postgres sends with it. */
function explain(error: unknown): string {
  if (!(error instanceof DatabaseError)) {
    return String(error);
  }
  return [
    error.message,
    error.detail,
    error.hint === undefined ? undefined : `Hint: ${error.hint}`,
    error.where === undefined ? undefined : `Context: ${error.where}`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

function fileFailure(file: MigrationFile, error: unknown): MigrationError {
  const position = error instanceof DatabaseError ? error.position : undefined;
  const at = position === undefined ? '' : ` at ${lineAndColumn(file.sql, Number(position))}`;
  return new MigrationError(`${file.name} failed${at}: ${explain(error)}`, { cause: error });
}

// Four digits set the order; the rest says what the migration does.
const MIGRATION_NAME = /^(?<number>[0-9]{4})_[a-z0-9_]+\.sql$/;

async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  // Any capitalization of .sql counts, so a misnamed migration is refused, not skipped.
  const names = (await readdir(directory))
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort();
  const namesByNumber = new Map<string, string>();
  for (const name of names) {
    const number = MIGRATION_NAME.exec(name)?.groups?.['number'];
    if (number === undefined) {
      throw new MigrationError(
        `${name} isn't named like a migration: four digits, an underscore, then lowercase ` +
          'letters, digits or underscores, ending in .sql (for example 0013_jobs.sql).',
      );
    }
    const other = namesByNumber.get(number);
    if (other !== undefined) {
      throw new MigrationError(
        `${other} and ${name} share the number ${number}. Give each migration its own number.`,
      );
    }
    namesByNumber.set(number, name);
  }
  return Promise.all(
    names.map(async (name) => {
      const contents = await readFile(join(directory, name));
      return {
        name,
        sql: contents.toString('utf8'),
        sha256: createHash('sha256').update(contents).digest(),
      };
    }),
  );
}

/**
 * The migrations in migrations.lock, beside the migrations directory, that this run may
 * apply: each must match the hash it was locked with. The lock holds one line per
 * migration, its SHA-256 then its file name, hashed with LF line endings as the repository
 * stores the file, whatever a Windows checkout has on disk.
 */
async function lockedNames(
  directory: string,
  files: readonly MigrationFile[],
): Promise<Set<string>> {
  const lockFile = join(dirname(resolve(directory)), 'migrations.lock');
  const contents = await readFile(lockFile, 'utf8').catch((error: unknown) => {
    throw new MigrationError(
      `Only locked migrations were asked for, but there's no lock file at ${lockFile}.`,
      { cause: error },
    );
  });
  const hashes = new Map(
    contents
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [hash, name] = line.trim().split(/\s+/);
        return [name, hash];
      }),
  );
  const locked = files.filter((file) => hashes.has(file.name));
  for (const file of locked) {
    const hash = createHash('sha256').update(file.sql.replaceAll('\r\n', '\n')).digest('hex');
    if (hash !== hashes.get(file.name)) {
      throw new MigrationError(
        `${file.name} changed after it was locked in migrations.lock. Locked migrations never ` +
          'change: put the change in a new migration.',
      );
    }
  }
  return new Set(locked.map((file) => file.name));
}

/** Takes the run lock, waiting up to waitMs for a run in progress to finish. */
async function takeRunLock(client: Client, waitMs: number): Promise<void> {
  // For this wait only: the session's lock_timeout is back once the transaction ends, and
  // the advisory lock, taken for the session, outlasts it.
  await client.query('begin');
  try {
    await client.query("select set_config('lock_timeout', $1, true)", [`${String(waitMs)}ms`]);
    await client.query('select pg_advisory_lock($1)', [RUN_LOCK]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    // lock_not_available: lock_timeout ran out.
    if (error instanceof DatabaseError && error.code === '55P03') {
      throw new MigrationError(
        `Another migration run has held the run lock for over ${String(waitMs / 1000)} seconds. ` +
          'Let it finish, or stop it, then run the migrations again.',
        { cause: error },
      );
    }
    throw error;
  }
}

// The migration that gives the app private.applied_migration_names.
const NAMES_READER = '0111_applied_migration_names.sql';

export interface MissingMigrationsOptions {
  /** A connection string for crm_app, the role the app runs as. */
  connectionString: string;
  /** Where this release's migration files are. Defaults to this package's migrations. */
  directory?: string;
}

/**
 * This release's migrations that the database hasn't applied yet, in order, asked as the
 * app's role: an app starts serving only once there are none. Without the reader function,
 * the database is from before it, and since migrations apply in order, the reader and every
 * migration after it are missing.
 */
export async function missingMigrations(options: MissingMigrationsOptions): Promise<string[]> {
  const files = await readMigrationFiles(options.directory ?? defaultDirectory);
  // A dropped network would otherwise hold the start forever: pg waits without a limit.
  const client = new Client({
    connectionString: options.connectionString,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const applied = await client
      .query<{ name: string }>('select name from private.applied_migration_names() as name')
      .then(({ rows }) => new Set(rows.map((row) => row.name)))
      .catch((error: unknown) => {
        // undefined_function, or invalid_schema_name before the first migration.
        if (error instanceof DatabaseError && (error.code === '42883' || error.code === '3F000')) {
          return undefined;
        }
        throw error;
      });
    return files
      .map((file) => file.name)
      .filter((name) => (applied === undefined ? name >= NAMES_READER : !applied.has(name)));
  } finally {
    await client.end();
  }
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const runLockWaitMs = options.runLockWaitMs ?? RUN_LOCK_WAIT_MS;
  if (
    !Number.isInteger(runLockWaitMs) ||
    runLockWaitMs < 1 ||
    runLockWaitMs > LONGEST_LOCK_TIMEOUT_MS
  ) {
    throw new MigrationError(
      `runLockWaitMs must be a whole number of milliseconds from 1 to ${String(LONGEST_LOCK_TIMEOUT_MS)}, ` +
        `not ${String(runLockWaitMs)}.`,
    );
  }
  const directory = options.directory ?? defaultDirectory;
  const files = await readMigrationFiles(directory);
  const locked = options.lockedOnly === true ? await lockedNames(directory, files) : undefined;
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    if (options.dryRun !== true) {
      await takeRunLock(client, runLockWaitMs);
    }
    const { rows } = await client.query<{ exists: boolean }>(
      `select to_regclass('util.applied_migrations') is not null as exists`,
    );
    let tableExists = rows[0]?.exists === true;
    const recorded = tableExists
      ? (
          await client.query<AppliedMigration>(
            'select name, sha256 from util.applied_migrations order by name collate "C"',
          )
        ).rows
      : [];
    // Every file counts towards the checks on what's applied, drafts included: a draft an
    // earlier run applied stays applied.
    const unapplied = pendingMigrations(directory, files, recorded);
    const pending = unapplied.filter((file) => locked?.has(file.name) ?? true);
    const skipped = unapplied.filter((file) => !pending.includes(file)).map((file) => file.name);
    if (options.dryRun === true) {
      return { applied: [], pending: pending.map((file) => file.name), skipped };
    }
    const applied: string[] = [];
    for (const file of pending) {
      await client.query('begin');
      try {
        await client.query(file.sql).catch((error: unknown) => {
          throw fileFailure(file, error);
        });
        if (!tableExists) {
          await client.query(CREATE_APPLIED_MIGRATIONS).catch((error: unknown) => {
            throw new MigrationError(
              `${file.name} ran, but couldn't be recorded: the first migration must create the ` +
                `util schema, which holds util.applied_migrations.\n${explain(error)}`,
              { cause: error },
            );
          });
        }
        await client.query('insert into util.applied_migrations (name, sha256) values ($1, $2)', [
          file.name,
          file.sha256,
        ]);
        // Deferred constraints are checked here, so a migration can still fail as it commits.
        await client.query('commit').catch((error: unknown) => {
          throw new MigrationError(`${file.name} failed as it committed: ${explain(error)}`, {
            cause: error,
          });
        });
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      tableExists = true;
      applied.push(file.name);
      options.onApplied?.(file.name);
    }
    return { applied, pending: [], skipped };
  } finally {
    await client.end();
  }
}
