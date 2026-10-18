import { bootstrapFile } from '@repo/db';
import { startPostgres, testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { install } from './install-cli.js';

// What the migrate container runs on every deploy: the migrations, then the agency and its
// built-in roles when the install has none.
let database: TestDatabase;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});

afterAll(async () => {
  await database.close();
});

function output() {
  const lines = { stdout: '', stderr: '' };
  return {
    lines,
    stdout: { write: (text: string) => (lines.stdout += text) },
    stderr: { write: (text: string) => (lines.stderr += text) },
  };
}

const agencies = () =>
  database.as('crm_owner', (sql) =>
    sql.query<{ name: string }>('select name from tenancy.agencies'),
  );

describe('install', () => {
  it('refuses to run without the owner’s connection string or the agency’s name', async () => {
    const noUrl = output();
    const noName = output();

    expect(await install({ AGENCY_NAME: 'Bluebird Digital' }, noUrl)).toBe(2);
    expect(await install({ DATABASE_OWNER_URL: database.url('crm_owner') }, noName)).toBe(2);

    expect(noUrl.lines.stderr).toContain('DATABASE_OWNER_URL');
    expect(noName.lines.stderr).toContain('AGENCY_NAME');
    expect(await agencies()).toEqual([]);
  });

  it('brings the database up to date, then creates the agency on first start only', async () => {
    const env = { DATABASE_OWNER_URL: database.url('crm_owner'), AGENCY_NAME: 'Bluebird Digital' };
    const first = output();
    const again = output();

    expect(await install(env, first)).toBe(0);
    expect(await install({ ...env, AGENCY_NAME: 'Changed My Mind' }, again)).toBe(0);

    expect(first.lines.stdout).toContain(
      'Created the agency Bluebird Digital, with its built-in roles.',
    );
    expect(again.lines.stdout).toContain('The agency is already here; nothing to create.');
    expect(await agencies()).toEqual([{ name: 'Bluebird Digital' }]);
  });

  it('reports a database it can’t reach, and exits with 1', async () => {
    const out = output();

    const code = await install(
      {
        DATABASE_OWNER_URL: 'postgres://crm_owner@127.0.0.1:1/crm',
        AGENCY_NAME: 'Bluebird Digital',
      },
      out,
    );

    expect(code).toBe(1);
    expect(out.lines.stderr).toMatch(/^Installing failed: /);
  });

  const bootstrapEnv = () => ({
    DATABASE_ADMIN_URL: database.url('postgres'),
    DATABASE_OWNER_URL: database.url('crm_owner'),
    DATABASE_APP_URL: database.url('crm_app'),
    DATABASE_AUTH_URL: database.url('crm_auth'),
    DATABASE_WORKER_URL: database.url('crm_worker'),
    AGENCY_NAME: 'Bluebird Digital',
  });

  it.each(['DATABASE_APP_URL', 'DATABASE_AUTH_URL', 'DATABASE_WORKER_URL'] as const)(
    'names a missing %s before attempting the external bootstrap',
    async (setting) => {
      const out = output();
      const before = await agencies();
      expect(await install({ ...bootstrapEnv(), [setting]: '' }, out)).toBe(2);
      expect(out.lines.stdout).toBe('');
      expect(out.lines.stderr).toContain(`the bootstrap also needs ${setting}:`);
      expect(await agencies()).toEqual(before);
    },
  );

  it('continues with migrations when the external roles and database already exist', async () => {
    // Bootstrap uses the fixed crm database, so this install gets a server of its own.
    const postgres = await startPostgres({ bootstrapFile });
    try {
      const env = {
        DATABASE_ADMIN_URL: postgres.url('postgres', 'postgres'),
        DATABASE_OWNER_URL: postgres.url('crm', 'crm_owner'),
        DATABASE_APP_URL: postgres.url('crm', 'crm_app'),
        DATABASE_AUTH_URL: postgres.url('crm', 'crm_auth'),
        DATABASE_WORKER_URL: postgres.url('crm', 'crm_worker'),
        AGENCY_NAME: 'External Bluebird Digital',
      };
      const first = output();
      expect(await install(env, first)).toBe(0);
      expect(first.lines.stderr).toBe('');
      expect(first.lines.stdout).toContain(
        'The roles and the database are already on the Postgres server; nothing to create.',
      );
      expect(first.lines.stdout).toContain(
        'Created the agency External Bluebird Digital, with its built-in roles.',
      );
      const again = output();
      expect(await install(env, again)).toBe(0);
      expect(again.lines.stderr).toBe('');
      expect(again.lines.stdout).toContain('The agency is already here; nothing to create.');
    } finally {
      await postgres.stop();
    }
  });

  it('reports an invalid bootstrap role and leaves the installed agency unchanged', async () => {
    const out = output();
    const env = bootstrapEnv();
    const before = await agencies();
    const owner = new URL(env.DATABASE_OWNER_URL);
    owner.pathname = '/crm';
    const app = new URL(env.DATABASE_APP_URL);
    app.username = 'another_role';
    expect(
      await install(
        { ...env, DATABASE_OWNER_URL: owner.toString(), DATABASE_APP_URL: app.toString() },
        out,
      ),
    ).toBe(1);
    expect(out.lines.stdout).toBe('');
    expect(out.lines.stderr).toBe(
      'Installing failed: The connection string for crm_app signs in as another role.\n',
    );
    expect(await agencies()).toEqual(before);
  });
});
