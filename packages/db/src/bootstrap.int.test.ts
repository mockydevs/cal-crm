import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bootstrapDatabase, bootstrapFile, type BootstrapOptions } from './index.js';

const roles = ['crm_owner', 'crm_app', 'crm_auth', 'crm_worker'] as const;
let postgres: Postgres | undefined;

function server(): Postgres {
  if (postgres === undefined) throw new Error('The bootstrap test server has not started.');
  return postgres;
}

async function query<T extends pg.QueryResultRow>(statement: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: server().url('postgres', 'postgres') });
  await client.connect();
  try {
    return (await client.query<T>(statement)).rows;
  } finally {
    await client.end();
  }
}

function options(): BootstrapOptions {
  const url = (role: (typeof roles)[number]) => {
    const connection = new URL(server().url('crm', role));
    connection.password = encodeURIComponent(`test-only-${role}-'\\@:%/#`);
    return connection.toString();
  };
  return {
    adminUrl: server().url('postgres', 'postgres'),
    urls: {
      crm_owner: url('crm_owner'),
      crm_app: url('crm_app'),
      crm_auth: url('crm_auth'),
      crm_worker: url('crm_worker'),
    },
  };
}

beforeAll(async () => {
  // This server belongs to this file alone; the migrated global template is untouched.
  postgres = await startPostgres({ bootstrapFile });
});

afterAll(async () => {
  await postgres?.stop();
});

beforeEach(async () => {
  await query('drop database if exists crm');
  for (const role of roles) await query(`drop role if exists ${pg.escapeIdentifier(role)}`);
});

describe('install bootstrap', () => {
  it('creates the database, isolated login roles and extensions with URL-encoded passwords', async () => {
    const install = options();
    expect(await bootstrapDatabase(install)).toEqual({ created: true, warnings: [] });

    expect(
      await query<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean }>(
        "select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname like 'crm_%' order by rolname",
      ),
    ).toEqual([
      { rolname: 'crm_app', rolcanlogin: true, rolbypassrls: false },
      { rolname: 'crm_auth', rolcanlogin: true, rolbypassrls: true },
      { rolname: 'crm_owner', rolcanlogin: true, rolbypassrls: true },
      { rolname: 'crm_worker', rolcanlogin: true, rolbypassrls: true },
    ]);

    for (const role of roles) {
      const client = new pg.Client({ connectionString: install.urls[role] });
      await client.connect();
      try {
        expect((await client.query<{ current_user: string }>('select current_user')).rows).toEqual([
          { current_user: role },
        ]);
        expect(
          (
            await client.query<{ allowed: boolean }>(
              "select has_schema_privilege(current_user, 'public', 'CREATE') as allowed",
            )
          ).rows,
        ).toEqual([{ allowed: role === 'crm_owner' }]);
        expect(
          (
            await client.query<{ extname: string }>(
              "select extname from pg_extension where extname in ('btree_gist', 'pg_trgm') order by extname",
            )
          ).rows,
        ).toEqual([{ extname: 'btree_gist' }, { extname: 'pg_trgm' }]);
      } finally {
        await client.end();
      }
    }
  });

  it('leaves existing credentials and database contents unchanged on a repeat install', async () => {
    const install = options();
    await bootstrapDatabase(install);
    const owner = new pg.Client({ connectionString: install.urls.crm_owner });
    await owner.connect();
    try {
      await owner.query('create schema install_probe');
      await owner.query('create table install_probe.records (name text)');
      await owner.query("insert into install_probe.records values ('kept')");
    } finally {
      await owner.end();
    }

    const changedUrls = { ...install.urls };
    for (const role of roles) {
      const changed = new URL(changedUrls[role]);
      changed.password = 'test-only-a-different-password';
      changedUrls[role] = changed.toString();
    }
    expect(await bootstrapDatabase({ ...install, urls: changedUrls })).toEqual({
      created: false,
      warnings: [],
    });

    const reconnect = new pg.Client({ connectionString: install.urls.crm_owner });
    await reconnect.connect();
    try {
      expect(
        (await reconnect.query<{ name: string }>('select name from install_probe.records')).rows,
      ).toEqual([{ name: 'kept' }]);
    } finally {
      await reconnect.end();
    }
  });

  it.each(['one role', 'database', 'all roles'] as const)(
    'refuses a partial install containing %s without completing or removing it',
    async (existing) => {
      if (existing === 'database') await query('create database crm');
      else {
        const present = existing === 'one role' ? ['crm_app'] : roles;
        for (const role of present) await query(`create role ${pg.escapeIdentifier(role)}`);
      }
      const before = await query<{ rolname: string }>(
        "select rolname from pg_roles where rolname like 'crm_%' order by rolname",
      );
      const databases = await query<{ datname: string }>(
        "select datname from pg_database where datname = 'crm'",
      );
      await expect(bootstrapDatabase(options())).rejects.toThrow(
        'Finish or undo that bootstrap by hand before installing.',
      );
      expect(
        await query<{ rolname: string }>(
          "select rolname from pg_roles where rolname like 'crm_%' order by rolname",
        ),
      ).toEqual(before);
      expect(
        await query<{ datname: string }>("select datname from pg_database where datname = 'crm'"),
      ).toEqual(databases);
    },
  );

  it.each([
    ['username', 'another_role', 'signs in as another role'],
    ['password', '', 'has no password'],
    ['pathname', '/another_database', 'must name the crm database'],
  ] as const)(
    'refuses an invalid role URL %s before creating anything',
    async (field, value, error) => {
      const install = options();
      const invalid = new URL(install.urls.crm_worker);
      invalid[field] = value;
      await expect(
        bootstrapDatabase({
          ...install,
          urls: { ...install.urls, crm_worker: invalid.toString() },
        }),
      ).rejects.toThrow(`The connection string for crm_worker ${error}.`);
      expect(
        await query<{ rolname: string }>("select rolname from pg_roles where rolname like 'crm_%'"),
      ).toEqual([]);
      expect(
        await query<{ datname: string }>("select datname from pg_database where datname = 'crm'"),
      ).toEqual([]);
    },
  );
});
