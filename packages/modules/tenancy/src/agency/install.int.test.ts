import { connectDatabase, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { builtInRoles, ensureAgency } from '../index.js';

// A file of its own, so its database starts with no agency, as a new install does.
let database: TestDatabase;
let owner: Database;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  owner = connectDatabase({
    connectionString: database.url('crm_owner'),
    onConnectionError: () => undefined,
  });
});

afterAll(async () => {
  await owner.destroy();
  await database.close();
});

const agencies = () =>
  database.as('crm_owner', (sql) =>
    sql.query<{ name: string; slug: string }>('select name, slug from tenancy.agencies'),
  );

const roles = () =>
  database.as('crm_owner', (sql) =>
    sql.query<{ scope: string; key: string; name: string; is_builtin: boolean }>(
      'select scope, key, name, is_builtin from tenancy.roles order by scope, key',
    ),
  );

describe('ensureAgency, on first start', () => {
  it('creates the agency and its built-in roles once, and nothing when run again', async () => {
    const first = await ensureAgency(owner, { name: '  Bluebird Digital, Ltd. ' });

    expect(first.created).toBe(true);
    expect(await agencies()).toEqual([
      { name: 'Bluebird Digital, Ltd.', slug: 'bluebird-digital-ltd' },
    ]);
    expect(await roles()).toEqual(
      builtInRoles
        .map((role) => ({ scope: role.scope, key: role.key, name: role.name, is_builtin: true }))
        .sort((a, b) => `${a.scope}.${a.key}`.localeCompare(`${b.scope}.${b.key}`)),
    );
    expect(builtInRoles.map((role) => `${role.scope}.${role.key}`)).toEqual([
      'agency.owner',
      'agency.admin',
      'agency.member',
      'business.owner',
      'business.admin',
      'business.member',
      'business.viewer',
    ]);

    const again = await ensureAgency(owner, { name: 'Another Name' });

    expect(again).toEqual({ created: false, agencyId: first.agencyId });
    expect(await agencies()).toEqual([
      { name: 'Bluebird Digital, Ltd.', slug: 'bluebird-digital-ltd' },
    ]);
    expect(await roles()).toHaveLength(builtInRoles.length);
  });

  it('adds built-in roles a later version brings, and leaves the ones the agency has alone', async () => {
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.roles set name = 'Viewer, renamed' where key = 'viewer';
         delete from tenancy.roles where key = 'member' and scope = 'agency'`,
      ),
    );

    expect((await ensureAgency(owner, { name: 'Ignored' })).created).toBe(false);

    const keys = (await roles()).map((role) => `${role.scope}.${role.key}:${role.name}`);
    expect(keys).toContain('agency.member:Member');
    expect(keys).toContain('business.viewer:Viewer, renamed');
  });

  it('makes a slug from any name', async () => {
    const { slugFor } = await import('./install.js');
    expect(slugFor('Café Ünïcode & Co!')).toBe('cafe-unicode-co');
    expect(slugFor('---')).toBe('agency');
    expect(slugFor('a'.repeat(80))).toHaveLength(63);
  });
});

describe('ensureAgency, run twice at once', () => {
  it('creates one agency when two deploys overlap', async () => {
    // A database of its own, with no agency yet, as a new install's.
    const fresh = await testDatabase(inject('databaseServer'));
    const pools = [1, 2].map(() =>
      connectDatabase({
        connectionString: fresh.url('crm_owner'),
        onConnectionError: () => undefined,
      }),
    );
    try {
      const runs = await Promise.all(
        pools.map((pool) => ensureAgency(pool, { name: 'Bluebird Digital' })),
      );

      expect(runs.map((run) => run.created).sort()).toEqual([false, true]);
      expect(new Set(runs.map((run) => run.agencyId)).size).toBe(1);
      const count = await fresh.as('crm_owner', (sql) =>
        sql.one<{ agencies: number }>('select count(*)::int as agencies from tenancy.agencies'),
      );
      expect(count.agencies).toBe(1);
    } finally {
      await Promise.all(pools.map((pool) => pool.destroy()));
      await fresh.close();
    }
  });
});
