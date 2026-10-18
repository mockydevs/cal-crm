import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});
it('isolates address checks by business and keeps the charged ledger append-only', async () => {
  const agency = await database.fixtures.agency();
  const one = await database.fixtures.business(agency.id);
  const other = await database.fixtures.business(agency.id);
  await database.withTenant(one.context, async (sql) => {
    await sql.query(
      "insert into messaging.email_verifications (business_id,address_normalized) values (app.business_id(),'a@example.com')",
    );
    await sql.query(
      "insert into messaging.email_verification_checks (business_id,id,address_normalized,charged,outcome,actor_kind) values (app.business_id(),uuidv7(),'a@example.com',false,'valid','system')",
    );
  });
  expect(
    await database.withTenant(other.context, (sql) =>
      sql.query('select id from messaging.email_verifications'),
    ),
  ).toEqual([]);
  for (const text of [
    'update messaging.email_verification_checks set charged=true',
    'delete from messaging.email_verification_checks',
    'delete from messaging.email_verifications',
  ]) {
    await expect(database.withTenant(one.context, (sql) => sql.query(text))).rejects.toMatchObject({
      code: '42501',
    });
  }
  for (const text of [
    "update messaging.email_verifications set reasons=array['made_up']",
    'update messaging.email_verifications set reasons=array[null]',
    'update messaging.email_verifications set provider_result=\'{"name":"private"}\'',
  ]) {
    await expect(database.withTenant(one.context, (sql) => sql.query(text))).rejects.toMatchObject({
      code: '23514',
    });
  }
});
