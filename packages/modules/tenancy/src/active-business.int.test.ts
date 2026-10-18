import { randomUUID } from 'node:crypto';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { holdActiveBusiness } from './active-business.js';

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

/** Whether a session of this database waits for a lock in exactly this statement. */
const untilWaiting = (statement: string) =>
  expect
    .poll(
      () =>
        // Another role's wait events are hidden from crm_app, so the superuser watches.
        database.as('postgres', async (sql) => {
          const row = await sql.one<{ waiting: boolean }>(
            "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query=$1) as waiting",
            [statement],
          );
          return row.waiting;
        }),
      { timeout: 10_000, interval: 50 },
    )
    .toBe(true);

it('says whether the business of this agency is active, and never throws for one that is not', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const hold = (context = business.context) =>
    withTenant(db, context, (trx) => holdActiveBusiness(trx, context));
  expect(await hold()).toBe(true);
  const other = await database.fixtures.agency();
  expect(await hold({ ...business.context, agencyId: other.id })).toBe(false);
  expect(
    await hold({ agencyId: agency.id, actorKind: 'system', correlationId: randomUUID() }),
  ).toBe(false);
  for (const status of ['suspended', 'archived']) {
    await database.as('crm_owner', (sql) =>
      sql.query('update tenancy.businesses set status=$2 where id=$1', [business.id, status]),
    );
    expect(await hold()).toBe(false);
  }
});

it('lets holders run together and makes a suspension wait for every one of them', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const held = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()];
  const release = Promise.withResolvers<undefined>();
  // Two transactions hold the business at once: neither waits for the other.
  const holders = held.map((ready) =>
    withTenant(db, business.context, async (trx) => {
      ready.resolve(await holdActiveBusiness(trx, business.context));
      await release.promise;
    }),
  );
  expect(await Promise.all(held.map((ready) => ready.promise))).toEqual([true, true]);
  const suspend = "update tenancy.businesses set status='suspended' where id=$1";
  const suspended = database.as('crm_owner', (sql) => sql.query(suspend, [business.id]));
  try {
    await untilWaiting(suspend);
    // Still active for a third reader while the change waits.
    expect(
      await database.withTenant(business.context, (sql) =>
        sql.one<{ status: string }>('select status from tenancy.businesses'),
      ),
    ).toEqual({ status: 'active' });
  } finally {
    release.resolve(undefined);
  }
  await Promise.all([...holders, suspended]);
  expect(
    await withTenant(db, business.context, (trx) => holdActiveBusiness(trx, business.context)),
  ).toBe(false);
});
