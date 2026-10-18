import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { lockActiveBusiness } from './calendar-business.js';

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

it('locks only the active business in this agency and refuses foreign or inactive scope', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await withTenant(db, business.context, (trx) => lockActiveBusiness(trx, business.context));
  const other = await database.fixtures.agency();
  const foreign = { ...business.context, agencyId: other.id };
  await expect(
    withTenant(db, foreign, (trx) => lockActiveBusiness(trx, foreign)),
  ).rejects.toBeInstanceOf(NotFoundError);
  await database.withTenant(business.context, (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=$1", [business.id]),
  );
  await expect(
    withTenant(db, business.context, (trx) => lockActiveBusiness(trx, business.context)),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('serializes booking with business suspension until the booking transaction ends', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const acquired = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const holding = withTenant(db, business.context, async (trx) => {
    await lockActiveBusiness(trx, business.context);
    acquired.resolve(undefined);
    await release.promise;
  });
  await acquired.promise;
  const change = "update tenancy.businesses set status='suspended' where id=$1";
  const changed = database.withTenant(business.context, (sql) => sql.query(change, [business.id]));
  try {
    await expect
      .poll(
        async () =>
          database.as(
            'crm_app',
            async (sql) =>
              (
                await sql.one<{ waiting: boolean }>(
                  "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query=$1) as waiting",
                  [change],
                )
              ).waiting,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    release.resolve(undefined);
    await Promise.all([holding, changed]);
  }
  await expect(
    withTenant(db, business.context, (trx) => lockActiveBusiness(trx, business.context)),
  ).rejects.toBeInstanceOf(NotFoundError);
});
