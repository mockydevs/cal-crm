// What a person's role allows where a job runs, read again when it runs, against a migrated
// Postgres under row-level security.
import { randomUUID } from 'node:crypto';

import { permissionsOf } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { readPersonGrants } from './index.js';

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

interface RoleOf {
  readonly scope: 'agency' | 'business';
  readonly key: string;
  readonly builtIn?: boolean;
  readonly permissions?: readonly string[];
}

async function member(agencyId: string, businessId: string | null, role: RoleOf): Promise<string> {
  const user = await database.fixtures.user();
  await database.as('crm_owner', (sql) =>
    sql.query(
      `with role as (
         insert into tenancy.roles (agency_id, scope, key, name, is_builtin, permissions)
         values ($1, $2, $3, $3, $4, $5)
         on conflict (agency_id, scope, key) do update set name = excluded.name returning id)
       insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
       select $1, $6, $7, id from role`,
      [
        agencyId,
        role.scope,
        role.key,
        role.builtIn ?? true,
        role.permissions ?? [],
        businessId,
        user.id,
      ],
    ),
  );
  return user.id;
}

async function world() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  // The worker's own context: a job reads on nobody's behalf.
  const context: TenantContext = {
    ...business.context,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  const grants = (userId: string) =>
    withTenant(db, context, (trx) => readPersonGrants(trx, context, userId));
  return { agency, business, context, grants };
}

const sorted = (granted: ReadonlySet<string> | undefined): string[] | undefined =>
  granted === undefined ? undefined : [...granted].sort();

it('gives a business member their role’s permissions, a viewer only the assistant, and a custom role its own keys', async () => {
  const { agency, business, grants } = await world();
  const owner = await member(agency.id, business.id, { scope: 'business', key: 'owner' });
  const viewer = await member(agency.id, business.id, { scope: 'business', key: 'viewer' });
  const tagger = await member(agency.id, business.id, {
    scope: 'business',
    key: 'tagger',
    builtIn: false,
    permissions: ['tags.manage', 'businesses.create', 'not.a.permission'],
  });

  expect((await grants(owner))?.has('forms.manage')).toBe(true);
  expect(sorted(await grants(owner))).toEqual(
    sorted(
      permissionsOf(
        { scope: 'business', key: 'owner', isBuiltin: true, permissions: [] },
        'business',
      ),
    ),
  );
  expect(sorted(await grants(viewer))).toEqual(['assistant.use']);
  // A custom role's keys the catalog has, that apply in a business.
  expect(sorted(await grants(tagger))).toEqual(['tags.manage']);
});

it('gives agency staff their agency role in every business, even one that is not active', async () => {
  const { agency, business, grants } = await world();
  const staff = await member(agency.id, null, { scope: 'agency', key: 'member' });
  expect((await grants(staff))?.has('contacts.manage')).toBe(true);
  expect((await grants(staff))?.has('forms.manage')).toBe(false);

  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [business.id]),
  );
  expect((await grants(staff))?.has('contacts.manage')).toBe(true);
});

it('allows nothing to someone who left, was disabled, works elsewhere, or whose business is closed', async () => {
  const { agency, business, grants } = await world();
  const elsewhere = await database.fixtures.business(agency.id);
  const sibling = await member(agency.id, elsewhere.id, { scope: 'business', key: 'owner' });
  const stranger = (await database.fixtures.user()).id;
  expect(await grants(sibling)).toBeUndefined();
  expect(await grants(stranger)).toBeUndefined();
  expect(await grants(randomUUID())).toBeUndefined();

  const leaver = await member(agency.id, business.id, { scope: 'business', key: 'admin' });
  expect((await grants(leaver))?.has('forms.manage')).toBe(true);
  await database.as('crm_owner', (sql) =>
    sql.query(`delete from tenancy.memberships where user_id = $1`, [leaver]),
  );
  expect(await grants(leaver)).toBeUndefined();

  const disabled = await member(agency.id, business.id, { scope: 'business', key: 'admin' });
  await database.as('crm_owner', (sql) =>
    sql.query(`update auth.users set disabled_at = now() where id = $1`, [disabled]),
  );
  expect(await grants(disabled)).toBeUndefined();

  const active = await member(agency.id, business.id, { scope: 'business', key: 'admin' });
  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [business.id]),
  );
  expect(await grants(active)).toBeUndefined();
});

it('reads a role change the moment it is made', async () => {
  const { agency, business, grants } = await world();
  const person = await member(agency.id, business.id, { scope: 'business', key: 'admin' });
  expect((await grants(person))?.has('forms.manage')).toBe(true);
  await database.as('crm_owner', (sql) =>
    sql.query(
      `with role as (
         insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
         values ($1, 'business', 'viewer', 'Viewer', true)
         on conflict (agency_id, scope, key) do update set name = excluded.name returning id)
       update tenancy.memberships m set role_id = role.id from role where m.user_id = $2`,
      [agency.id, person],
    ),
  );
  expect(sorted(await grants(person))).toEqual(['assistant.use']);
});
