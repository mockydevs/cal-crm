import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { resolveCalendarMember, readCalendarMemberMemberships } from './index.js';

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

it('makes only this business team bookable, excluding agency-only and sibling memberships', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const sibling = await database.fixtures.business(agency.id);
  const ours = await database.fixtures.user();
  const agencyOnly = await database.fixtures.user();
  const elsewhere = await database.fixtures.user();
  const rows = await database.as('crm_owner', async (sql) => {
    const businessRole = await sql.one<{ id: string }>(
      "insert into tenancy.roles (agency_id,scope,key,name) values ($1,'business','member','Member') returning id",
      [agency.id],
    );
    const agencyRole = await sql.one<{ id: string }>(
      "insert into tenancy.roles (agency_id,scope,key,name) values ($1,'agency','member','Member') returning id",
      [agency.id],
    );
    return sql.query<{ id: string; user_id: string }>(
      'insert into tenancy.memberships (agency_id,business_id,user_id,role_id) values ($1,$2,$4,$7),($1,null,$5,$8),($1,$3,$6,$7) returning id,user_id',
      [
        agency.id,
        business.id,
        sibling.id,
        ours.id,
        agencyOnly.id,
        elsewhere.id,
        businessRole.id,
        agencyRole.id,
      ],
    );
  });
  const membership = (userId: string) => {
    const row = rows.find((item) => item.user_id === userId);
    if (row === undefined) throw new Error('Missing member fixture.');
    return toPublicId('membership', row.id);
  };
  const resolve = (id: string) =>
    withTenant(db, business.context, (trx) => resolveCalendarMember(trx, business.context, id));
  expect(await resolve(membership(ours.id))).toBe(ours.id);
  await expect(resolve(membership(agencyOnly.id))).rejects.toBeInstanceOf(ValidationError);
  await expect(resolve(membership(elsewhere.id))).rejects.toBeInstanceOf(ValidationError);
  const visible = await withTenant(db, business.context, (trx) =>
    readCalendarMemberMemberships(trx, business.context, [ours.id, agencyOnly.id, elsewhere.id]),
  );
  expect([...visible]).toEqual([[ours.id, membership(ours.id)]]);
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=now() where id=$1', [ours.id]),
  );
  await expect(resolve(membership(ours.id))).rejects.toBeInstanceOf(ValidationError);
  expect(
    await withTenant(db, business.context, (trx) =>
      readCalendarMemberMemberships(trx, business.context, [ours.id]),
    ),
  ).toEqual(new Map());
});
