import { randomUUID } from 'node:crypto';
import { allowEveryone } from '@repo/commands';
import { BOOKING_NOTIFICATION_WORDING } from '@repo/contracts';
import type { Database } from '@repo/db';
import { ConflictError, NotFoundError } from '@repo/kernel';
import { intakeContact } from '@repo/module-crm';
import { createDispatchOutboundTask } from '@repo/module-messaging';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';
import { bookingFixtureSuite, request } from '../test/booking-fixtures.js';

const suite = bookingFixtureSuite();
const { fixture, handlers } = suite;
let database: TestDatabase;
let db: Database;
beforeAll(() => {
  database = suite.database;
  db = suite.db;
});
it('reads only public calendar details and fixed transactional wording within the complete slug scope', async () => {
  const f = await fixture();
  await database.fixtures.contact(f.business.context, { email: 'private@example.test' });
  expect(await handlers().calendar(f.params, request())).toEqual({
    name: 'Venue tour',
    description: 'Visit the waterfront venue.',
    timezone: 'UTC',
    slotMinutes: 30,
    durations: [30],
    notificationWording: BOOKING_NOTIFICATION_WORDING,
    renderToken: expect.stringMatching(/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/) as string,
    appearance: {
      style: 'neo',
      primaryColor: '#178af6',
      backgroundColor: '#ffffff',
      buttonText: '',
      logoUrl: null,
      coverUrl: null,
    },
  });
  await expect(
    handlers().calendar({ ...f.params, agencySlug: 'missing' }, request()),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    handlers().calendar({ ...f.params, businessSlug: 'missing' }, request()),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('offers only free instants and honors host buffer occupancy across other calendars', async () => {
  const f = await fixture();
  const contact = await database.fixtures.contact(f.business.context);
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const appointment = await database.withTenant(f.business.context, async (sql) => {
    const otherCalendar = await sql.one<{ id: string }>(
      "insert into calendar.calendars(business_id,name,kind,timezone,booking_slug) values(app.business_id(),'Staff meeting','personal','UTC','staff-meeting') returning id",
    );
    return sql.one<{ id: string }>(
      `insert into calendar.appointments(business_id,calendar_id,contact_id,assigned_user_id,title,starts_at,ends_at,buffer_before_minutes,buffer_after_minutes,source)
      values(app.business_id(),$1,$2,$3,'Staff meeting',$4,$5,30,30,'user') returning id`,
      [otherCalendar.id, contact.id, f.user.id, `${date}T13:00:00Z`, `${date}T13:30:00Z`],
    );
  });
  const offered = await handlers().slots(f.params, { date }, request());
  expect(offered.slots).toHaveLength(13);
  expect(offered.slots[0]).toEqual({
    startsAt: `${date}T09:00:00Z`,
    endsAt: `${date}T09:30:00Z`,
  });
  for (const slot of offered.slots) {
    expect(Object.keys(slot).sort()).toEqual(['endsAt', 'startsAt']);
    expect(slot.startsAt).not.toBe(`${date}T12:30:00Z`);
    expect(slot.startsAt).not.toBe(`${date}T13:00:00Z`);
    expect(slot.startsAt).not.toBe(`${date}T13:30:00Z`);
  }
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      "update calendar.appointments set status='cancelled',cancelled_at=now() where id=$1",
      [appointment.id],
    ),
  );
  expect((await handlers().slots(f.params, { date }, request())).slots).toHaveLength(16);
});

it('books a contact and confirmation atomically and replays safely after actual dispatch', async () => {
  const f = await fixture();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const input = {
    bookingRequestId: randomUUID(),
    startsAt: `${date}T10:00:00Z`,
    contact: { firstName: 'Maya', email: 'Maya@Example.test' },
    notificationConsent: true as const,
    contactTimezone: 'UTC',
  };
  const receipt = await handlers().book(f.params, input, request());
  expect(receipt).toMatchObject({
    status: 'booked',
    startsAt: `${date}T10:00:00.000Z`,
    endsAt: `${date}T10:30:00.000Z`,
  });
  expect(receipt.managementUrl).toMatch(
    /^https:\/\/crm\.example\.test\/appointments\/manage\/[A-Za-z0-9_-]{43}$/,
  );
  expect(Object.keys(receipt).sort()).toEqual([
    'emailed',
    'endsAt',
    'managementUrl',
    'startsAt',
    'status',
  ]);
  const rows = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ contact_id: string; management_digest: string }>(
      'select contact_id,management_digest from calendar.appointments',
    ),
  );
  expect(rows).toHaveLength(1);
  const appointment = rows[0];
  if (appointment === undefined) throw new Error('Booking appointment was not persisted.');
  expect(appointment.management_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        'select c.timezone,i.value_normalized from crm.contacts c join crm.contact_identities i on i.business_id=c.business_id and i.contact_id=c.id',
      ),
    ),
  ).toEqual([{ timezone: 'UTC', value_normalized: 'maya@example.test' }]);
  const jobs = await database.runJobs(['messaging.dispatch']);
  expect(jobs).toHaveLength(1);
  const task = createDispatchOutboundTask({
    deliver(message) {
      expect(message.text).toContain(receipt.managementUrl);
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'fixture-accepted' });
    },
  });
  const message = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>('select id from messaging.messages'),
  );
  await task.run(
    { messageId: message.id },
    {
      invocation: {
        context: { ...f.business.context, correlationId: randomUUID() },
        permissions: 'all',
      },
      services: { db, authorize: allowEveryone },
    },
  );
  expect(await handlers().book(f.params, input, request())).toEqual({
    status: 'booked',
    startsAt: `${date}T10:00:00.000Z`,
    endsAt: `${date}T10:30:00.000Z`,
  });
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(0);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select status from messaging.messages'),
    ),
  ).toEqual([{ status: 'sent' }]);
});

it('rolls back contact changes, transactional proof, appointment and queue when confirmation is refused', async () => {
  const f = await fixture();
  const contact = await database.fixtures.contact(f.business.context, {
    email: 'blocked@example.test',
  });
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      "update crm.contacts set do_not_contact=true,first_name='Original',timezone=null where id=$1",
      [contact.id],
    ),
  );
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await expect(
    handlers().book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${date}T10:00:00Z`,
        contact: { firstName: 'Changed', email: 'blocked@example.test' },
        notificationConsent: true,
        contactTimezone: 'UTC',
      },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    await database.withTenant(f.business.context, async (sql) => ({
      contacts: await sql.query('select first_name,timezone,do_not_contact from crm.contacts'),
      appointments: await sql.query('select id from calendar.appointments'),
      consents: await sql.query('select id from messaging.consents'),
      messages: await sql.query('select id from messaging.messages'),
      events: await sql.query(
        "select type from events.events where subject_kind in ('contact','appointment')",
      ),
    })),
  ).toEqual({
    contacts: [{ first_name: 'Original', timezone: null, do_not_contact: true }],
    appointments: [],
    consents: [],
    messages: [],
    events: [],
  });
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(0);
});

it('serializes competing bookings and changed request replays without creating losing contacts', async () => {
  const f = await fixture();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const inputs = ['first@example.test', 'second@example.test'].map((email) => ({
    bookingRequestId: randomUUID(),
    startsAt: `${date}T10:00:00Z`,
    contact: { email },
    notificationConsent: true as const,
    contactTimezone: 'UTC',
  }));
  const results = await Promise.allSettled(
    inputs.map((input) => handlers().book(f.params, input, request())),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  for (const result of results)
    if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictError);
  const winningIndex = results.findIndex((result) => result.status === 'fulfilled');
  const winningInput = inputs[winningIndex];
  if (winningInput === undefined) throw new Error('No booking won the race.');
  await expect(
    handlers().book(f.params, { ...winningInput, startsAt: `${date}T11:00:00Z` }, request()),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    await database.withTenant(f.business.context, async (sql) => ({
      contacts: await sql.query('select id from crm.contacts'),
      appointments: await sql.query('select id from calendar.appointments'),
      consents: await sql.query('select id from messaging.consents'),
      messages: await sql.query('select id from messaging.messages'),
    })),
  ).toMatchObject({
    contacts: [expect.anything()],
    appointments: [expect.anything()],
    consents: [expect.anything()],
    messages: [expect.anything()],
  });
});

it('reports a competing ordinary reservation as taken and rolls back the losing booking transaction', async () => {
  const f = await fixture();
  const ordinaryContact = await database.fixtures.contact(f.business.context, {
    email: 'ordinary@example.test',
  });
  const otherCalendar = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into calendar.calendars(business_id,name,kind,timezone,booking_slug) values(app.business_id(),'Other calendar','personal','UTC','other-calendar') returning id",
    ),
  );
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const booking = handlers(async (trx, input, command) => {
    const contact = await intakeContact(trx, input, command);
    entered.resolve(undefined);
    await release.promise;
    return contact;
  })
    .book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${date}T10:00:00Z`,
        contact: { email: 'losing@example.test' },
        notificationConsent: true,
        contactTimezone: 'UTC',
      },
      request(),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  try {
    expect(await Promise.race([entered.promise, booking])).toBeUndefined();
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into calendar.appointments(business_id,calendar_id,contact_id,assigned_user_id,title,starts_at,ends_at,source)
      values(app.business_id(),$1,$2,$3,'Ordinary reservation',$4,$5,'user')`,
        [otherCalendar.id, ordinaryContact.id, f.user.id, `${date}T10:00:00Z`, `${date}T10:30:00Z`],
      ),
    );
  } finally {
    release.resolve(undefined);
  }
  expect(await booking).toBeInstanceOf(ConflictError);
  expect(
    await database.withTenant(f.business.context, async (sql) => ({
      emails: await sql.query('select value_normalized from crm.contact_identities'),
      appointments: await sql.query('select title from calendar.appointments'),
      consents: await sql.query('select id from messaging.consents'),
      messages: await sql.query('select id from messaging.messages'),
    })),
  ).toEqual({
    emails: [{ value_normalized: 'ordinary@example.test' }],
    appointments: [{ title: 'Ordinary reservation' }],
    consents: [],
    messages: [],
  });
});

it('books an accepted multiline calendar display name with a safe fixed confirmation subject', async () => {
  const f = await fixture('Venue\r\ntour');
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const booked = await handlers().book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'attendee@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  expect(booked.status).toBe('booked');
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select subject from messaging.messages'),
    ),
  ).toEqual([{ subject: 'Your appointment is booked' }]);
});

it.each(['calendar', 'slots', 'book'] as const)(
  'refuses %s when its slug resolves to a replacement calendar after the business lock wait',
  async (operation) => {
    const f = await fixture();
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const ready = Promise.withResolvers<undefined>();
    const proceed = Promise.withResolvers<undefined>();
    const changing = database
      .withTenant(f.business.context, async (sql) => {
        await sql.query(
          'select id from tenancy.businesses where id=app.business_id() for no key update',
        );
        ready.resolve(undefined);
        await proceed.promise;
        const original = await sql.one<{ id: string }>('select id from calendar.calendars');
        await sql.query("update calendar.calendars set booking_slug='retired-tour' where id=$1", [
          original.id,
        ]);
        const replacement = await sql.one<{ id: string }>(
          "insert into calendar.calendars(business_id,name,kind,timezone,booking_slug,confirmation_account_id,is_active) select business_id,'Replacement tour',kind,timezone,'venue-tour',confirmation_account_id,is_active from calendar.calendars where id=$1 returning id",
          [original.id],
        );
        await sql.query(
          'insert into calendar.calendar_members(business_id,calendar_id,user_id,weight) select business_id,$1,user_id,weight from calendar.calendar_members where calendar_id=$2',
          [replacement.id, original.id],
        );
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await ready.promise;
    const api = handlers();
    const result = (
      operation === 'calendar'
        ? api.calendar(f.params, request())
        : operation === 'slots'
          ? api.slots(f.params, { date }, request())
          : api.book(
              f.params,
              {
                bookingRequestId: randomUUID(),
                startsAt: `${date}T10:00:00Z`,
                contact: { email: 'replacement-race@example.test' },
                notificationConsent: true,
                contactTimezone: 'UTC',
              },
              request(),
            )
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await expect
        .poll(
          async () =>
            database.as(
              'crm_app',
              async (sql) =>
                (
                  await sql.one<{ waiting: boolean }>(
                    "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%tenancy%businesses%for no key update%') as waiting",
                  )
                ).waiting,
            ),
          { timeout: 5000 },
        )
        .toBe(true);
    } finally {
      proceed.resolve(undefined);
    }
    const [changed, response] = await Promise.all([changing, result]);
    if (!changed.ok) throw changed.error;
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('Request crossed into the replacement calendar.');
    expect(response.error).toBeInstanceOf(NotFoundError);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select id from calendar.appointments'),
      ),
    ).toEqual([]);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select id from crm.contacts'),
      ),
    ).toEqual([]);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select id from messaging.messages'),
      ),
    ).toEqual([]);
  },
);

it('links repeat adjacent bookings to one contact and preserves its established timezone with fresh transactional proof', async () => {
  const f = await fixture();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const api = handlers();
  for (const [time, timezone] of [
    ['10:00', 'Africa/Nairobi'],
    ['10:30', 'UTC'],
  ] as const) {
    const receipt = await api.book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${date}T${time}:00Z`,
        contact: { email: 'repeat-attendee@example.test' },
        notificationConsent: true,
        contactTimezone: timezone,
      },
      request(),
    );
    expect(receipt.status).toBe('booked');
  }
  const persisted = await database.withTenant(f.business.context, async (sql) => ({
    contacts: await sql.query('select timezone from crm.contacts'),
    appointments: await sql.query<{ contact_id: string; assigned_user_id: string }>(
      'select contact_id,assigned_user_id from calendar.appointments',
    ),
    consents: await sql.query('select id from messaging.consents'),
    messages: await sql.query('select id from messaging.messages'),
    events: await sql.query("select id from events.events where type='appointment.booked'"),
  }));
  expect(persisted.contacts).toEqual([{ timezone: 'Africa/Nairobi' }]);
  expect(persisted.appointments).toHaveLength(2);
  expect(new Set(persisted.appointments.map((row) => row.contact_id)).size).toBe(1);
  expect(persisted.appointments.map((row) => row.assigned_user_id)).toEqual([f.user.id, f.user.id]);
  expect(persisted.consents).toHaveLength(2);
  expect(persisted.messages).toHaveLength(2);
  expect(persisted.events).toHaveLength(2);
});

it('never lets a booking replace the name or numbers of a contact it finds, and tells the team', async () => {
  const f = await fixture();
  const owner = await database.fixtures.contact(f.business.context, {
    firstName: 'Victoria',
    lastName: 'Owner',
    email: 'victoria@example.test',
  });
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const receipt = await handlers((trx, input, command) =>
    intakeContact(trx, input, command, 'booking'),
  ).book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: {
        firstName: 'Hacked',
        lastName: 'Name',
        email: 'VICTORIA@example.test',
        phone: '+1 212 555 0666',
      },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  expect(receipt.status).toBe('booked');
  const saved = await database.withTenant(f.business.context, async (sql) => ({
    contacts: await sql.query('select id, first_name, last_name from crm.contacts'),
    phones: await sql.query("select 1 from crm.contact_identities where kind = 'phone'"),
    appointments: await sql.query('select contact_id from calendar.appointments'),
    notes: await sql.query<{ body_text: string }>('select body_text from crm.notes'),
  }));
  expect(saved.contacts).toEqual([{ id: owner.id, first_name: 'Victoria', last_name: 'Owner' }]);
  expect(saved.phones).toEqual([]);
  expect(saved.appointments).toEqual([{ contact_id: owner.id }]);
  expect(saved.notes).toHaveLength(1);
  expect(saved.notes[0]?.body_text).toMatch(/^A booking sent details that were not applied/);
  expect(saved.notes[0]?.body_text).toContain('First name given: "Hacked"');
  expect(saved.notes[0]?.body_text).toContain('The phone number +12125550666 was given.');
});
