import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { lockBookingContact } from './booking-contact.js';

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

it('locks only the derived current-business contact and returns no private data for missing or deleted contacts', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const otherBusiness = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  const foreign = await database.fixtures.contact(otherBusiness.context);
  const lock = (contactId: string) =>
    withTenant(db, business.context, (trx) =>
      lockBookingContact(trx, business.context, { contactId }),
    );
  expect(await lock(contact.id)).toBe(true);
  expect(await lock(foreign.id)).toBe(false);
  await database.withTenant(business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at=now() where id=$1', [contact.id]),
  );
  expect(await lock(contact.id)).toBe(false);
});
