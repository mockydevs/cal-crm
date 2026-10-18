import { createHash, randomBytes } from 'node:crypto';

import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function key(scopes: readonly string[], groups: readonly string[] | null, readOnly = false) {
  const agency = await database.fixtures.agency();
  const secret = randomBytes(32);
  return database.as('crm_owner', (sql) =>
    sql.one<{ read_only: boolean; read_groups: string[] | null }>(
      `insert into tenancy.api_keys (agency_id,name,key_prefix,key_hash,scopes,read_groups,read_only)
     values ($1,'External agent',$2,$3,$4,$5,$6) returning read_only,read_groups`,
      [
        agency.id,
        `crm_live_${secret.toString('hex').slice(0, 12)}`,
        createHash('sha256').update(secret).digest(),
        scopes,
        groups,
        readOnly,
      ],
    ),
  );
}

it('supports explicitly restricted read-only keys with no write scopes', async () => {
  expect(await key([], ['Contacts'], true)).toEqual({ read_only: true, read_groups: ['Contacts'] });
});

it.each([null, []])(
  'does not turn missing or empty grants into unrestricted access (%s)',
  async (groups) => {
    await expect(key([], groups)).rejects.toMatchObject({ constraint: 'api_keys_scopes_present' });
  },
);

it('refuses null array entries and oversized read policies at the database boundary', async () => {
  const agency = await database.fixtures.agency();
  const secret = randomBytes(32);
  await expect(
    database.as('crm_owner', (sql) =>
      sql.query(
        `insert into tenancy.api_keys (agency_id,name,key_prefix,key_hash,scopes,read_groups)
     values ($1,'Invalid groups',$2,$3,array['tags.manage'],array[null]::text[])`,
        [
          agency.id,
          `crm_live_${secret.toString('hex').slice(0, 12)}`,
          createHash('sha256').update(secret).digest(),
        ],
      ),
    ),
  ).rejects.toMatchObject({ constraint: 'api_keys_read_groups_valid' });
  await expect(
    key(
      ['tags.manage'],
      Array.from({ length: 65 }, () => 'Contacts'),
    ),
  ).rejects.toMatchObject({ constraint: 'api_keys_read_groups_valid' });
});

it('preserves legacy unrestricted reads explicitly as null while keeping native write scopes', async () => {
  expect(await key(['tags.manage'], null)).toEqual({ read_only: false, read_groups: null });
});

it('refuses write grants on a read-only row, even when inserted by the database owner', async () => {
  await expect(key(['tags.manage'], ['Contacts'], true)).rejects.toMatchObject({
    constraint: 'api_keys_read_only_scopes',
  });
});
