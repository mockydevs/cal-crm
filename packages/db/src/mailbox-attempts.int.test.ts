import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

it('isolates pending mailbox attempts and prevents references to another business’s secret', async () => {
  const agency = await database.fixtures.agency();
  const first = await database.fixtures.business(agency.id);
  const second = await database.fixtures.business(agency.id);
  const [stored] = await database.withTenant(first.context, (sql) =>
    sql.query<{ id: string }>(
      `
    insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
    values ($1, $2, 'mailbox.credentials', 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))
    returning id`,
      [agency.id, first.id],
    ),
  );
  if (stored === undefined) throw new Error('Missing test secret.');
  // These bytes exercise foreign keys only; cryptographic behavior has real vault tests.
  const [attempt] = await database.withTenant(first.context, (sql) =>
    sql.query<{ id: string; status: string }>(
      `
    insert into messaging.mailbox_connection_attempts (business_id, email_address, secret_id)
    values ($1, 'person@example.test', $2) returning id, status`,
      [first.id, stored.id],
    ),
  );
  expect(attempt?.status).toBe('pending');
  expect(
    await database.withTenant(second.context, (sql) =>
      sql.query('select id from messaging.mailbox_connection_attempts'),
    ),
  ).toEqual([]);
  await expect(
    database.withTenant(second.context, (sql) =>
      sql.query(
        `
    insert into messaging.mailbox_connection_attempts (business_id, email_address, secret_id)
    values ($1, 'other@example.test', $2)`,
        [second.id, stored.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

it('permits one pending attempt per business/address and requires secret cleanup on completion', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const [stored] = await database.withTenant(business.context, (sql) =>
    sql.query<{ id: string }>(
      `
    insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
    values ($1, $2, 'mailbox.credentials', 1, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))
    returning id`,
      [agency.id, business.id],
    ),
  );
  if (stored === undefined) throw new Error('Missing test secret.');
  const [attempt] = await database.withTenant(business.context, (sql) =>
    sql.query<{ id: string }>(
      `
    insert into messaging.mailbox_connection_attempts (business_id, email_address, secret_id)
    values ($1, 'person@example.test', $2) returning id`,
      [business.id, stored.id],
    ),
  );
  if (attempt === undefined) throw new Error('Missing test attempt.');
  await expect(
    database.withTenant(business.context, (sql) =>
      sql.query(
        `
    insert into messaging.mailbox_connection_attempts (business_id, email_address, secret_id)
    values ($1, 'PERSON@example.test', $2)`,
        [business.id, stored.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23505' });
  await expect(
    database.withTenant(business.context, (sql) =>
      sql.query(
        `
    update messaging.mailbox_connection_attempts set status = 'failed', failure_code = 'expired', finished_at = now()
    where id = $1`,
        [attempt.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `
    update messaging.mailbox_connection_attempts set status = 'failed', failure_code = 'expired', finished_at = now(), secret_id = null
    where id = $1`,
      [attempt.id],
    ),
  );
  expect(
    await database.withTenant(business.context, (sql) =>
      sql.query('select status, secret_id from messaging.mailbox_connection_attempts'),
    ),
  ).toEqual([{ status: 'failed', secret_id: null }]);
});
