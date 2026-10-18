import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { readContactNames } from '../index.js';

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

it('returns contact names with address fallbacks and trash state only within the request’s business', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const other = await database.fixtures.business(agency.id);
  const named = await database.fixtures.contact(business.context, {
    firstName: 'Ada',
    lastName: 'Lovelace',
  });
  const email = await database.fixtures.contact(business.context, { email: 'desk@example.test' });
  const empty = await database.fixtures.contact(business.context);
  const phone = await database.fixtures.contact(business.context);
  const foreign = await database.fixtures.contact(other.context, { firstName: 'Private' });
  await database.withTenant(business.context, async (sql) => {
    await sql.query(
      'update crm.contacts set first_name = null, last_name = null where id = any($1::uuid[])',
      [[email.id, empty.id, phone.id]],
    );
    await sql.query('update crm.contacts set deleted_at = now() where id = $1', [named.id]);
    await sql.query(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
       values (app.business_id(), $1, 'phone', '+254712345678', '+254712345678', true)`,
      [phone.id],
    );
  });
  expect(await withTenant(db, business.context, (trx) => readContactNames(trx, []))).toEqual(
    new Map(),
  );
  const names = await withTenant(db, business.context, (trx) =>
    readContactNames(trx, [named.id, email.id, empty.id, phone.id, foreign.id, named.id]),
  );
  expect(names.size).toBe(4);
  expect(names.get(named.id)).toEqual({ name: 'Ada Lovelace', trashed: true });
  expect(names.get(email.id)).toEqual({ name: 'desk@example.test', trashed: false });
  expect(names.get(empty.id)).toEqual({ name: '', trashed: false });
  expect(names.get(phone.id)).toEqual({ name: '+254712345678', trashed: false });
  expect(names.has(foreign.id)).toBe(false);
});
