import { randomBytes } from 'node:crypto';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

it('resolves only active business Twilio callback capabilities, exposing identifiers only', async () => {
  const agency = await database.fixtures.agency();
  const tenant = await database.fixtures.business(agency.id);
  const digest = randomBytes(32).toString('hex');
  const connection = await database.as('crm_owner', async (sql) => {
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets(agency_id,business_id,purpose,key_version,enc,ciphertext)
       values($1,$2,'sms.twilio.credentials',1,decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex')) returning id`,
      [agency.id, tenant.id],
    );
    return sql.one<{ id: string }>(
      `insert into messaging.provider_connections(agency_id,business_id,provider,label,account_ref,secret_id,webhook_digest)
       values($1,$2,'twilio','Synthetic','AC' || repeat('1',32),$3,$4) returning id`,
      [agency.id, tenant.id, secret.id, digest],
    );
  });
  const lookup = (value: string | null) =>
    database.as('crm_app', (sql) =>
      sql.query('select * from private.resolve_voice_callback($1)', [value]),
    );
  expect(await lookup(digest)).toEqual([
    { agency_id: agency.id, business_id: tenant.id, connection_id: connection.id },
  ]);
  expect(await lookup(null)).toEqual([]);
  expect(await lookup('malformed')).toEqual([]);
  expect(await lookup(randomBytes(32).toString('hex'))).toEqual([]);
  await database.as('crm_owner', (sql) =>
    sql.query("update messaging.provider_connections set status='disconnected' where id=$1", [
      connection.id,
    ]),
  );
  expect(await lookup(digest)).toEqual([]);
  await database.as('crm_owner', (sql) =>
    sql.query("update messaging.provider_connections set status='connected' where id=$1", [
      connection.id,
    ]),
  );
  await database.as('crm_owner', (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=$1", [tenant.id]),
  );
  expect(await lookup(digest)).toEqual([]);
});
