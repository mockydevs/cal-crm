import { BOOTSTRAPPED_DATABASE, testDatabase, type TestDatabase } from '@repo/testing';
import { randomUUID } from 'node:crypto';
import { migrate } from '@repo/db';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

it('backfills actual pre-migration confirmed appointments without changing adjacent reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crm-calendar-legacy-'));
  const target = resolve(directory);
  if (
    !target.startsWith(`${resolve(tmpdir())}${sep}`) ||
    !basename(target).startsWith('crm-calendar-legacy-')
  )
    throw new Error(
      'Legacy migration fixture directory must remain inside the temporary workspace.',
    );
  // The install database has roles/extensions and no product migrations; template0
  // lacks btree_gist/pg_trgm required by the real pre-0040 schema.
  const legacy = await testDatabase({
    ...inject('databaseServer'),
    template: BOOTSTRAPPED_DATABASE,
  });
  try {
    const source = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
    for (const name of await readdir(source)) {
      if (/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(name) && name < '0040_')
        await copyFile(join(source, name), join(directory, name));
    }
    await migrate({ connectionString: legacy.url('crm_owner'), directory });
    const agency = await legacy.fixtures.agency();
    const business = await legacy.fixtures.business(agency.id);
    const contact = await legacy.fixtures.contact(business.context);
    const user = await legacy.fixtures.user();
    const calendar = await legacy.withTenant(business.context, (sql) =>
      sql.one<{ id: string }>(
        "insert into calendar.calendars(business_id,name,kind,timezone,booking_slug) values(app.business_id(),'Legacy','personal','UTC','legacy') returning id",
      ),
    );
    await legacy.withTenant(business.context, (sql) =>
      sql.query(
        `insert into calendar.appointments(business_id,calendar_id,contact_id,assigned_user_id,title,starts_at,ends_at,status,source)
      values(app.business_id(),$1,$2,$3,'Legacy first','2026-10-10T10:00:00Z','2026-10-10T10:30:00Z','confirmed','user'),
      (app.business_id(),$1,$2,$3,'Legacy second','2026-10-10T10:30:00Z','2026-10-10T11:00:00Z','confirmed','user')`,
        [calendar.id, contact.id, user.id],
      ),
    );
    await copyFile(
      join(source, '0040_calendar_booking.sql'),
      join(directory, '0040_calendar_booking.sql'),
    );
    expect(
      (await migrate({ connectionString: legacy.url('crm_owner'), directory })).applied,
    ).toEqual(['0040_calendar_booking.sql']);
    expect(
      await legacy.withTenant(business.context, (sql) =>
        sql.query(`select title,
      buffer_before_minutes=0 and buffer_after_minutes=0 as zero_buffers,
      occupied_starts_at=starts_at and occupied_ends_at=ends_at as preserved,
      management_digest is null and booking_request_id is null as no_capability,
      confirmation_account_id is null as no_sender
      from calendar.appointments order by starts_at`),
      ),
    ).toEqual([
      {
        title: 'Legacy first',
        zero_buffers: true,
        preserved: true,
        no_capability: true,
        no_sender: true,
      },
      {
        title: 'Legacy second',
        zero_buffers: true,
        preserved: true,
        no_capability: true,
        no_sender: true,
      },
    ]);
  } finally {
    await legacy.close();
    await rm(target, { recursive: true, force: true });
  }
});

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  const user = await database.fixtures.user();
  const calendar = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id,name,kind,timezone,booking_slug)
       values (app.business_id(),'Consultation','personal','America/New_York','consultation') returning id`,
    ),
  );
  return { business, contact, user, calendar };
}

it('qualifies calendar and appointment sender snapshots and nulls only account IDs on sender deletion', async () => {
  const f = await fixture();
  const other = await database.fixtures.business(f.business.agencyId);
  const accountIn = (context: typeof f.business.context) =>
    database.withTenant(context, (sql) =>
      sql.one<{ id: string }>(
        "insert into messaging.channel_accounts(business_id,channel,name) values(app.business_id(),'email','Confirmation') returning id",
      ),
    );
  const ours = await accountIn(f.business.context);
  const theirs = await accountIn(other.context);
  const setSender = (id: string) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query('update calendar.calendars set confirmation_account_id=$1 where id=$2', [
        id,
        f.calendar.id,
      ]),
    );
  await expect(setSender(theirs.id)).rejects.toMatchObject({ code: '23503' });
  await setSender(ours.id);
  const insert = (id: string) =>
    database.withTenant(f.business.context, (sql) =>
      sql.one<{ id: string }>(
        `insert into calendar.appointments(business_id,calendar_id,contact_id,title,starts_at,ends_at,source,confirmation_account_id)
    values(app.business_id(),$1,$2,'Consultation','2026-10-10T10:00:00Z','2026-10-10T10:30:00Z','booking_page',$3) returning id`,
        [f.calendar.id, f.contact.id, id],
      ),
    );
  await expect(insert(theirs.id)).rejects.toMatchObject({ code: '23503' });
  const appointment = await insert(ours.id);
  const operationId = randomUUID();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into calendar.appointment_operations(business_id,appointment_id,operation_request_id,operation,request_digest,receipt,confirmation_status)
    values(app.business_id(),$1,$2,'reschedule',$3,'{"status":"booked","startsAt":"2026-10-10T10:00:00Z","endsAt":"2026-10-10T10:30:00Z"}','unavailable')`,
      [appointment.id, operationId, 'b'.repeat(64)],
    ),
  );
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query('delete from calendar.calendars where id=$1', [f.calendar.id]),
    ),
  ).rejects.toMatchObject({ code: '23503' });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        'select operation_request_id from calendar.appointment_operations where appointment_id=$1',
        [appointment.id],
      ),
    ),
  ).toEqual([{ operation_request_id: operationId }]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('delete from messaging.channel_accounts where id=$1', [ours.id]),
  );
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.one<{ business_id: string; confirmation_account_id: string | null }>(
        'select business_id,confirmation_account_id from calendar.calendars where id=$1',
        [f.calendar.id],
      ),
    ),
  ).toEqual({ business_id: f.business.id, confirmation_account_id: null });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.one<{ business_id: string; confirmation_account_id: string | null }>(
        'select business_id,confirmation_account_id from calendar.appointments where id=$1',
        [appointment.id],
      ),
    ),
  ).toEqual({ business_id: f.business.id, confirmation_account_id: null });
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.businesses where id=$1', [f.business.id]),
  );
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query('select id from calendar.appointments where business_id=$1', [f.business.id]),
    ),
  ).toEqual([]);
});

it('derives occupied instants on every write instead of trusting supplied buffer boundaries', async () => {
  const { business, contact, user, calendar } = await fixture();
  const appointment = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string; correct_start: boolean; correct_end: boolean }>(
      `insert into calendar.appointments
        (business_id,calendar_id,contact_id,assigned_user_id,title,starts_at,ends_at,source,
         buffer_before_minutes,buffer_after_minutes,occupied_starts_at,occupied_ends_at)
       values (app.business_id(),$1,$2,$3,'Consultation','2026-11-01T05:30:00Z','2026-11-01T06:00:00Z',
         'booking_page',15,20,'2030-01-01T00:00:00Z','2030-01-01T00:00:01Z')
       returning id, occupied_starts_at='2026-11-01T05:15:00Z'::timestamptz as correct_start,
         occupied_ends_at='2026-11-01T06:20:00Z'::timestamptz as correct_end`,
      [calendar.id, contact.id, user.id],
    ),
  );
  expect(appointment).toMatchObject({ correct_start: true, correct_end: true });
  const corrected = await database.withTenant(business.context, (sql) =>
    sql.one<{ correct_start: boolean; correct_end: boolean }>(
      `update calendar.appointments set occupied_starts_at='2030-01-01T00:00:00Z',
         occupied_ends_at='2030-01-01T00:00:01Z' where id=$1
       returning occupied_starts_at='2026-11-01T05:15:00Z'::timestamptz as correct_start,
         occupied_ends_at='2026-11-01T06:20:00Z'::timestamptz as correct_end`,
      [appointment.id],
    ),
  );
  expect(corrected).toEqual({ correct_start: true, correct_end: true });
});

it('excludes overlapping buffers across calendars while allowing exact occupied adjacency', async () => {
  const { business, contact, user, calendar } = await fixture();
  const other = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id,name,kind,timezone,booking_slug)
     values (app.business_id(),'Other','personal','UTC','other') returning id`,
    ),
  );
  const insert = (calendarId: string, startsAt: string, endsAt: string, after: number) =>
    database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into calendar.appointments
      (business_id,calendar_id,contact_id,assigned_user_id,title,starts_at,ends_at,source,buffer_after_minutes)
     values (app.business_id(),$1,$2,$3,'Consultation',$4,$5,'api',$6)`,
        [calendarId, contact.id, user.id, startsAt, endsAt, after],
      ),
    );
  await insert(calendar.id, '2026-11-02T10:00:00Z', '2026-11-02T10:30:00Z', 15);
  await expect(
    insert(other.id, '2026-11-02T10:40:00Z', '2026-11-02T11:00:00Z', 0),
  ).rejects.toMatchObject({ code: '23P01', constraint: 'appointments_no_double_booking' });
  await insert(other.id, '2026-11-02T10:45:00Z', '2026-11-02T11:00:00Z', 0);
});

it('stores digest-only capabilities and pairs bounded request metadata with unique receipts', async () => {
  const { business, contact, user, calendar } = await fixture();
  const requestId = randomUUID();
  const digest = 'a'.repeat(64);
  const requestDigest = 'b'.repeat(64);
  const insert = (
    startsAt: string,
    managementDigest: string | null,
    expiry: string | null,
    bookingRequestId: string | null,
    bookingRequestDigest: string | null,
  ) =>
    database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into calendar.appointments
        (business_id,calendar_id,contact_id,assigned_user_id,title,starts_at,ends_at,source,
         management_digest,management_expires_at,booking_request_id,booking_request_digest)
       values (app.business_id(),$1,$2,$3,'Consultation',$4::timestamptz,$4::timestamptz+interval '30 minutes',
         'booking_page',$5,$6,$7,$8)`,
        [
          calendar.id,
          contact.id,
          user.id,
          startsAt,
          managementDigest,
          expiry,
          bookingRequestId,
          bookingRequestDigest,
        ],
      ),
    );
  await insert('2026-11-02T10:00:00Z', digest, '2026-12-02T10:30:00Z', requestId, requestDigest);
  for (const values of [
    [null, '2026-12-02T10:30:00Z', null, null],
    [digest, null, null, null],
    ['not-a-digest', '2026-12-02T10:30:00Z', null, null],
    [null, null, requestId, null],
    [null, null, null, requestDigest],
    [null, null, requestId, 'not-a-digest'],
  ] as const) {
    await expect(
      insert('2026-11-03T10:00:00Z', values[0], values[1], values[2], values[3]),
    ).rejects.toMatchObject({
      code: '23514',
    });
  }
  await expect(
    insert('2026-11-03T10:00:00Z', digest, '2026-12-02T10:30:00Z', null, null),
  ).rejects.toMatchObject({ code: '23505', constraint: 'appointments_management_digest_unique' });
  await expect(
    insert(
      '2026-11-03T10:00:00Z',
      'c'.repeat(64),
      '2026-12-02T10:30:00Z',
      requestId,
      requestDigest,
    ),
  ).rejects.toMatchObject({ code: '23505', constraint: 'appointments_booking_request_unique' });
});

it('keeps operation receipts strict, immutable and isolated in their appointment business', async () => {
  const { business, contact, user, calendar } = await fixture();
  const appointment = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.appointments (business_id,calendar_id,contact_id,assigned_user_id,title,starts_at,ends_at,source)
     values (app.business_id(),$1,$2,$3,'Consultation','2026-11-02T10:00:00Z','2026-11-02T10:30:00Z','user') returning id`,
      [calendar.id, contact.id, user.id],
    ),
  );
  const operationId = randomUUID();
  const receipt = {
    status: 'booked',
    startsAt: '2026-11-02T10:00:00Z',
    endsAt: '2026-11-02T10:30:00Z',
  };
  const insert = (
    value: object,
    requestId = randomUUID(),
    confirmationStatus: string | null = 'unavailable',
  ) =>
    database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into calendar.appointment_operations
      (business_id,appointment_id,operation_request_id,operation,request_digest,receipt,confirmation_status)
     values (app.business_id(),$1,$2,'reschedule',$3,$4::jsonb,$5)`,
        [appointment.id, requestId, 'a'.repeat(64), JSON.stringify(value), confirmationStatus],
      ),
    );
  await insert(receipt, operationId);
  await expect(insert(receipt, randomUUID(), null)).rejects.toMatchObject({ code: '23502' });
  await expect(insert(receipt, randomUUID(), 'sent')).rejects.toMatchObject({ code: '23514' });
  expect(
    await database.withTenant(business.context, (sql) =>
      sql.one<{ confirmation_status: string; receipt: object }>(
        'select confirmation_status,receipt from calendar.appointment_operations where operation_request_id=$1',
        [operationId],
      ),
    ),
  ).toEqual({ confirmation_status: 'unavailable', receipt });
  for (const invalid of [
    { ...receipt, status: 'unknown' },
    { ...receipt, status: null },
    { ...receipt, startsAt: 7 },
    { status: 'booked', startsAt: receipt.startsAt },
    { ...receipt, startsAt: '2026-02-30T10:00:00Z' },
    { ...receipt, startsAt: '0000-01-01T00:00:00Z' },
    { ...receipt, endsAt: receipt.startsAt },
    { ...receipt, endsAt: '2026-11-02T09:00:00Z' },
    { ...receipt, token: 'A'.repeat(43) },
    { ...receipt, managementUrl: 'https://private.test' },
    { ...receipt, contactId: contact.id },
    { ...receipt, startsAt: 'a'.repeat(2000) },
    [],
  ])
    await expect(insert(invalid)).rejects.toMatchObject({ code: '23514' });
  await expect(insert(receipt, operationId)).rejects.toMatchObject({ code: '23505' });
  await expect(
    database.withTenant(business.context, (sql) =>
      sql.query(
        "update calendar.appointment_operations set operation='cancel' where operation_request_id=$1",
        [operationId],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.withTenant(business.context, (sql) =>
      sql.query('delete from calendar.appointment_operations where operation_request_id=$1', [
        operationId,
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  const other = await database.fixtures.business(business.agencyId);
  expect(
    await database.withTenant(other.context, (sql) =>
      sql.query('select receipt from calendar.appointment_operations'),
    ),
  ).toEqual([]);
});
