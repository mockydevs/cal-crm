import { randomUUID } from 'node:crypto';
import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { BOOKING_NOTIFICATION_WORDING } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { NotFoundError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';
import { recordBookingNotificationConsent } from './booking-consent.js';

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

const record = defineCommand({
  name: 'test.booking.notification_consent',
  permission: 'contacts.manage',
  input: z.strictObject({
    contactId: z.uuid(),
    appointmentId: z.uuid(),
    notificationConsent: z.literal(true),
    ipAddress: z.string(),
    wording: z.string(),
  }),
  audit: () => ({ channel: 'email', purpose: 'transactional', source: 'booking' }),
  handle: recordBookingNotificationConsent,
});
async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  const calendar = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into calendar.calendars(business_id,name,kind,timezone,booking_slug) values(app.business_id(),'Consultation','personal','UTC','consultation') returning id",
    ),
  );
  const appointment = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into calendar.appointments(business_id,calendar_id,contact_id,title,starts_at,ends_at,source) values(app.business_id(),$1,$2,'Consultation','2026-10-10T10:00:00Z','2026-10-10T10:30:00Z','booking_page') returning id",
      [calendar.id, contact.id],
    ),
  );
  const invocation: Invocation = {
    context: { ...business.context, actorKind: 'contact', correlationId: randomUUID() },
    permissions: 'all',
  };
  const input = {
    contactId: contact.id,
    appointmentId: appointment.id,
    notificationConsent: true as const,
    ipAddress: '203.0.113.10',
    wording: BOOKING_NOTIFICATION_WORDING,
  };
  return { business, contact, invocation, input };
}

it('appends scoped transactional proof without changing marketing withdrawal, DNC or suppressions', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, async (sql) => {
    await sql.query(
      "insert into messaging.consents(business_id,contact_id,channel,purpose,status,source,proof,recorded_by_kind) values(app.business_id(),$1,'email','marketing','withdrawn','user','{\"original\":true}','contact')",
      [f.contact.id],
    );
    await sql.query('update crm.contacts set do_not_contact=true where id=$1', [f.contact.id]);
    await sql.query(
      "insert into messaging.suppressions(business_id,channel,address_normalized,reason) values(app.business_id(),'email','blocked@example.test','manual')",
    );
  });
  const before = Date.now();
  await runCommand(services, record, f.input, f.invocation);
  await runCommand(services, record, { ...f.input, ipAddress: '2001:db8::10' }, f.invocation);
  const after = Date.now();
  const rows = await database.withTenant(f.business.context, (sql) =>
    sql.query<{
      channel: string;
      purpose: string;
      source: string;
      status: string;
      proof: { appointmentId: string; wording: string; ipAddress: string; recordedAt: string };
    }>(
      "select channel,purpose,source,status,proof from messaging.consents where purpose='transactional' order by id",
    ),
  );
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row).toMatchObject({
      channel: 'email',
      purpose: 'transactional',
      status: 'granted',
      source: 'booking',
      proof: { appointmentId: f.input.appointmentId, wording: BOOKING_NOTIFICATION_WORDING },
    });
    expect(Object.keys(row.proof).sort()).toEqual([
      'appointmentId',
      'ipAddress',
      'recordedAt',
      'wording',
    ]);
    expect(Date.parse(row.proof.recordedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row.proof.recordedAt)).toBeLessThanOrEqual(after);
  }
  expect(rows.map((row) => row.proof.ipAddress)).toEqual(['203.0.113.10', '2001:db8::10']);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select status,proof from messaging.consents where purpose='marketing'"),
    ),
  ).toEqual([{ status: 'withdrawn', proof: { original: true } }]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.one<{ do_not_contact: boolean }>('select do_not_contact from crm.contacts where id=$1', [
        f.contact.id,
      ]),
    ),
  ).toEqual({ do_not_contact: true });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select reason from messaging.suppressions'),
    ),
  ).toEqual([{ reason: 'manual' }]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select payload from events.events where type='consent.granted'"),
    ),
  ).toEqual([
    { payload: { channel: 'email', purpose: 'transactional', source: 'booking' } },
    { payload: { channel: 'email', purpose: 'transactional', source: 'booking' } },
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        "select input from audit.commands where command='test.booking.notification_consent'",
      ),
    ),
  ).toEqual([
    { input: { channel: 'email', purpose: 'transactional', source: 'booking' } },
    { input: { channel: 'email', purpose: 'transactional', source: 'booking' } },
  ]);
});

it('refuses foreign/deleted contacts, empty or overlong wording, or invalid IP input', async () => {
  const f = await fixture();
  const other = await fixture();
  await expect(
    runCommand(services, record, { ...f.input, contactId: other.contact.id }, f.invocation),
  ).rejects.toBeInstanceOf(NotFoundError);
  for (const wording of ['  ', 'x'.repeat(1001)])
    await expect(
      runCommand(services, record, { ...f.input, wording }, f.invocation),
    ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    runCommand(services, record, { ...f.input, notificationConsent: false }, f.invocation),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    runCommand(services, record, { ...f.input, ipAddress: 'X-Forwarded-For:spoof' }, f.invocation),
  ).rejects.toBeInstanceOf(ValidationError);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at=now() where id=$1', [f.contact.id]),
  );
  await expect(runCommand(services, record, f.input, f.invocation)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.consents'),
    ),
  ).toEqual([]);
});

it('rolls back the consent proof and timeline event when the enclosing booking command fails', async () => {
  const f = await fixture();
  const failing = defineCommand({
    ...record,
    name: 'test.booking.failed_notification_consent',
    async handle(trx, input, command) {
      await recordBookingNotificationConsent(trx, input, command);
      throw new Error('Booking reservation refused');
    },
  });
  await expect(runCommand(services, failing, f.input, f.invocation)).rejects.toThrow(
    'Booking reservation refused',
  );
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.consents'),
    ),
  ).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select id from events.events where type='consent.granted'"),
    ),
  ).toEqual([]);
});

it('keeps the calendar’s own wording of the box as the proof', async () => {
  const f = await fixture();
  const wording = 'Email me about this visit, and text me reminders.';
  await runCommand(services, record, { ...f.input, wording }, f.invocation);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query<{ wording: string }>("select proof->>'wording' as wording from messaging.consents"),
    ),
  ).toEqual([{ wording }]);
});
