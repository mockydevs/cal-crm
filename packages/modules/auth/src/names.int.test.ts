import { randomUUID } from 'node:crypto';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { readUserNames } from './index.js';

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

/** Makes the user a member: of the business when one is given, else agency staff. */
async function member(userId: string, agencyId: string, businessId?: string): Promise<void> {
  const scope = businessId === undefined ? 'agency' : 'business';
  await database.as('crm_owner', async (sql) => {
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name) values ($1, $2, 'member', 'Member')
       on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
      [agencyId, scope],
    );
    await sql.query(
      'insert into tenancy.memberships (user_id, agency_id, business_id, role_id) values ($1, $2, $3, $4)',
      [userId, agencyId, businessId ?? null, role.id],
    );
  });
}

/** Someone reading in a business of a new agency, and that business's id. */
async function reader(): Promise<{ context: TenantContext; agencyId: string; businessId: string }> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  await member(user.id, agency.id, business.id);
  return {
    agencyId: agency.id,
    businessId: business.id,
    context: {
      ...business.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
  };
}

const namesFor = (context: TenantContext, ids: readonly string[]) =>
  withTenant(db, context, (trx) => readUserNames(trx, ids));

describe('readUserNames', () => {
  it("names each person: their name, or their email address when they've given none", async () => {
    const { context, agencyId, businessId } = await reader();
    const colleague = await database.fixtures.user({ name: '  Ann Achebe ' });
    const staff = await database.fixtures.user({ name: ' ' });
    await member(colleague.id, agencyId, businessId);
    await member(staff.id, agencyId);

    const names = await namesFor(context, [colleague.id, staff.id]);

    expect(names).toEqual(
      new Map([
        [colleague.id, 'Ann Achebe'],
        [staff.id, staff.email],
      ]),
    );
  });

  it("leaves out anyone the reader can't see", async () => {
    const { context, agencyId } = await reader();
    const elsewhere = await database.fixtures.user({ name: 'Bea Banda' });
    const otherBusiness = await database.fixtures.business(agencyId);
    await member(elsewhere.id, agencyId, otherBusiness.id);

    const names = await namesFor(context, [elsewhere.id, randomUUID()]);

    expect(names).toEqual(new Map());
  });

  it('asks for nothing when there is no one to name', async () => {
    const { context } = await reader();

    expect(await namesFor(context, [])).toEqual(new Map());
  });
});
