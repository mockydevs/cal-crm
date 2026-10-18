import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapFile, migrate, missingMigrations } from './index.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const READER = '0111_applied_migration_names.sql';

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

/** A copy of the real migrations, with the given ones left out or added. */
async function migrationsWith(
  change: (directory: string) => Promise<void> = () => Promise.resolve(),
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'crm-schema-status-'));
  temporaryDirectories.push(directory);
  await cp(migrationsDirectory, directory, { recursive: true });
  await change(directory);
  return directory;
}

describe('missingMigrations, as the app asks it at start', () => {
  it('finds nothing missing once every migration is applied', async () => {
    const database = await postgres.createDatabase();
    await migrate({ connectionString: postgres.url(database) });

    expect(
      await missingMigrations({ connectionString: postgres.url(database, 'crm_app') }),
    ).toEqual([]);
  });

  it("names a newer release's migrations that the database hasn't applied yet", async () => {
    const database = await postgres.createDatabase();
    await migrate({ connectionString: postgres.url(database) });
    const next = await migrationsWith((directory) =>
      writeFile(join(directory, '9998_next_release.sql'), 'select 1;'),
    );

    expect(
      await missingMigrations({
        connectionString: postgres.url(database, 'crm_app'),
        directory: next,
      }),
    ).toEqual(['9998_next_release.sql']);
  });

  it('counts the reader and everything after it as missing on a database from before it', async () => {
    const database = await postgres.createDatabase();
    const before = await migrationsWith(async (directory) => {
      await rm(join(directory, READER));
    });
    await migrate({ connectionString: postgres.url(database), directory: before });

    const missing = await missingMigrations({
      connectionString: postgres.url(database, 'crm_app'),
    });

    expect(missing[0]).toBe(READER);
    expect(missing.every((name) => name >= READER)).toBe(true);
  });

  it("gives the app the names alone: it still can't read the runner's table", async () => {
    const database = await postgres.createDatabase();
    await migrate({ connectionString: postgres.url(database) });
    const client = new pg.Client({ connectionString: postgres.url(database, 'crm_app') });
    await client.connect();
    try {
      await expect(client.query('select name from util.applied_migrations')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await client.end();
    }
  });
});
