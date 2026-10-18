import { randomUUID } from 'node:crypto';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import {
  queueCalendarConfirmation,
  readCalendarConfirmationRecipient,
  type CalendarConfirmationInput,
} from './calendar-confirmations.js';

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

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context, {
    email: 'attendee@example.test',
  });
  const context = { ...business.context, correlationId: randomUUID() };
  const input: CalendarConfirmationInput = await database.withTenant(context, async (sql) => {
    await sql.query(
      'insert into messaging.settings(business_id,quiet_hours_enabled) values(app.business_id(),false)',
    );
    await sql.query(
      "insert into messaging.consents(business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values(app.business_id(),$1,'email','transactional','granted','booking','contact')",
      [contact.id],
    );
    const identity = await sql.one<{ id: string }>(
      "select id from crm.contact_identities where contact_id=$1 and kind='email'",
      [contact.id],
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts(business_id,channel,name) values(app.business_id(),'email','Booking sender') returning id",
    );
    return {
      identityId: identity.id,
      accountId: account.id,
      idempotencyKey: randomUUID(),
      subject: 'Appointment recorded',
      text: 'Your appointment has been recorded.',
    };
  });
  const queue = (confirmation: CalendarConfirmationInput = input) =>
    withTenant(db, context, (trx) => queueCalendarConfirmation(trx, context, confirmation));
  return { context, contact, input, queue };
}

it('reports an accepted transactional confirmation without exposing account or recipient details', async () => {
  const f = await fixture();
  expect(await f.queue()).toEqual({ outcome: 'queued', deferred: false });
  expect(await f.queue()).toEqual({ outcome: 'queued', deferred: false });
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(1);
  expect(
    await database.withTenant(f.context, (sql) =>
      sql.query(
        'select m.channel,m.status,m.priority,d.purpose,d.lane from messaging.messages m join messaging.outbound_dispatch d on d.business_id=m.business_id and d.id=m.id',
      ),
    ),
  ).toEqual([
    {
      channel: 'email',
      status: 'queued',
      priority: 0,
      purpose: 'transactional',
      lane: 'transactional',
    },
  ]);
});

it('reports canonical policy refusal instead of claiming a confirmation was queued', async () => {
  const f = await fixture();
  await database.withTenant(f.context, (sql) =>
    sql.query('update crm.contacts set do_not_contact=true where id=$1', [f.contact.id]),
  );
  expect(await f.queue()).toEqual({ outcome: 'refused' });
  expect(await f.queue()).toEqual({ outcome: 'refused' });
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(0);
});

it('reports accepted deferred delivery while preserving the canonical quiet-hours policy', async () => {
  const f = await fixture();
  await database.withTenant(f.context, async (sql) => {
    await sql.query("update crm.contacts set timezone='UTC' where id=$1", [f.contact.id]);
    await sql.query(
      "update messaging.settings set quiet_hours_enabled=true,quiet_hours_start='00:00',quiet_hours_end='00:00'",
    );
  });
  expect(await f.queue()).toEqual({ outcome: 'queued', deferred: true });
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(0);
});

it('resolves only the original email recipient association and returns no replacement identity', async () => {
  const f = await fixture();
  const other = await fixture();
  const appointmentId = await database.withTenant(f.context, async (sql) => {
    const calendar = await sql.one<{ id: string }>(
      "insert into calendar.calendars(business_id,name,kind,timezone,booking_slug) values(app.business_id(),'Consultation','personal','UTC','consultation') returning id",
    );
    const appointment = await sql.one<{ id: string }>(
      "insert into calendar.appointments(business_id,calendar_id,contact_id,title,starts_at,ends_at,source) values(app.business_id(),$1,$2,'Consultation','2030-01-01T10:00:00Z','2030-01-01T10:30:00Z','booking_page') returning id",
      [calendar.id, f.contact.id],
    );
    return appointment.id;
  });
  await f.queue({ ...f.input, idempotencyKey: `calendar:book:${appointmentId}` });
  const input = { appointmentId, contactId: f.contact.id };
  const read = () =>
    withTenant(db, f.context, (trx) => readCalendarConfirmationRecipient(trx, f.context, input));
  expect(await read()).toBe(f.input.identityId);
  expect(
    await withTenant(db, other.context, (trx) =>
      readCalendarConfirmationRecipient(trx, other.context, input),
    ),
  ).toBeNull();
  const secondContact = await database.fixtures.contact(f.context, {
    email: 'different@example.test',
  });
  const secondIdentity = await database.withTenant(f.context, (sql) =>
    sql.one<{ id: string }>('select id from crm.contact_identities where contact_id=$1', [
      secondContact.id,
    ]),
  );
  await database.withTenant(f.context, (sql) =>
    sql.query('update messaging.outbound_dispatch set identity_id=$1', [secondIdentity.id]),
  );
  expect(await read()).toBeNull();
  await database.withTenant(f.context, (sql) =>
    sql.query('update messaging.outbound_dispatch set identity_id=$1', [f.input.identityId]),
  );
  expect(await read()).toBe(f.input.identityId);
  await database.withTenant(f.context, (sql) =>
    sql.query('delete from crm.contact_identities where id=$1', [f.input.identityId]),
  );
  expect(await read()).toBeNull();
});
