import { randomUUID } from 'node:crypto';
import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import { isTimeZone, NotFoundError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';
import { setBookingContactTimezone } from './booking-timezone.js';

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const initialize = defineCommand({
  name: 'test.contact.booking_timezone',
  permission: 'contacts.manage',
  input: z.strictObject({ contactId: z.uuid(), timezone: z.string().refine(isTimeZone) }),
  audit: () => ({ source: 'booking', changed: 'timezone' }),
  handle: setBookingContactTimezone,
});
async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  const invocation: Invocation = {
    context: { ...business.context, actorKind: 'contact', correlationId: randomUUID() },
    permissions: 'all',
  };
  return { business, contact, invocation };
}

it('sets an absent timezone once and records only the field name in its event and audit', async () => {
  const f = await fixture();
  expect(
    await runCommand(
      services,
      initialize,
      { contactId: f.contact.id, timezone: 'Africa/Nairobi' },
      f.invocation,
    ),
  ).toBe(true);
  expect(
    await runCommand(
      services,
      initialize,
      { contactId: f.contact.id, timezone: 'America/New_York' },
      f.invocation,
    ),
  ).toBe(false);
  const saved = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ timezone: string }>('select timezone from crm.contacts where id=$1', [f.contact.id]),
  );
  expect(saved.timezone).toBe('Africa/Nairobi');
  const events = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ payload: unknown }>(
      "select payload from events.events where type='contact.updated' and subject_id=$1",
      [f.contact.id],
    ),
  );
  expect(events).toEqual([{ payload: { changed: ['timeZone'] } }]);
  const audit = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ input: unknown }>(
      "select input from audit.commands where command='test.contact.booking_timezone'",
    ),
  );
  expect(audit).toEqual([
    { input: { source: 'booking', changed: 'timezone' } },
    { input: { source: 'booking', changed: 'timezone' } },
  ]);
});

it('refuses foreign, trashed and invalid inputs without publishing a contact change', async () => {
  const f = await fixture();
  const other = await fixture();
  await expect(
    runCommand(
      services,
      initialize,
      { contactId: other.contact.id, timezone: 'UTC' },
      f.invocation,
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at=now() where id=$1', [f.contact.id]),
  );
  await expect(
    runCommand(services, initialize, { contactId: f.contact.id, timezone: 'UTC' }, f.invocation),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    runCommand(
      services,
      initialize,
      { contactId: f.contact.id, timezone: 'Unknown/Zone' },
      f.invocation,
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  const changed = await database.withTenant(f.business.context, (sql) =>
    sql.query("select id from events.events where type='contact.updated'"),
  );
  expect(changed).toEqual([]);
});

it('stores the zone as PostgreSQL spells it, and leaves a zone this server lacks unset without failing the booking', async () => {
  const f = await fixture();
  const stored = () =>
    database.withTenant(f.business.context, (sql) =>
      sql.one<{ timezone: string | null }>('select timezone from crm.contacts where id=$1', [
        f.contact.id,
      ]),
    );
  const listed = new Set(
    (
      await database.as('crm_owner', (sql) =>
        sql.query<{ name: string }>('select name from pg_catalog.pg_timezone_names'),
      )
    ).map((row) => row.name),
  );
  // EAT passes the app's own check on most builds and is no zone PostgreSQL lists: the
  // booking goes on, and the contact stays without a time zone rather than with a dead one.
  expect(listed.has('EAT')).toBe(false);
  if (isTimeZone('EAT')) {
    expect(
      await runCommand(
        services,
        initialize,
        { contactId: f.contact.id, timezone: 'EAT' },
        f.invocation,
      ),
    ).toBe(false);
    expect(await stored()).toEqual({ timezone: null });
  }
  // A browser's spelling of India, in the wrong letter case: stored under a listed name of
  // the same zone, which is the given one wherever the server has it.
  expect(
    await runCommand(
      services,
      initialize,
      { contactId: f.contact.id, timezone: 'asia/calcutta' },
      f.invocation,
    ),
  ).toBe(true);
  const { timezone } = await stored();
  expect(timezone).toBe(listed.has('Asia/Calcutta') ? 'Asia/Calcutta' : 'Asia/Kolkata');
  const joined = await database.as('crm_owner', (sql) =>
    sql.query(
      `select 1 from crm.contacts c join pg_catalog.pg_timezone_names tz on tz.name = c.timezone
       where c.id = $1`,
      [f.contact.id],
    ),
  );
  expect(joined).toHaveLength(1);
});
