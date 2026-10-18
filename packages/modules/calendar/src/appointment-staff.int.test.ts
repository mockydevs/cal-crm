// A signed-in person books, moves, cancels and marks an appointment, and writes its notes.
// Real Postgres as crm_app under row-level security, with every port as the server composes
// it: the booking page's own fixtures make the calendar, its host and its mailbox.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation } from '@repo/commands';
import { appointmentDetail, type AppointmentDetail } from '@repo/contracts';
import { withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { lockBookingContact, readContactNames } from '@repo/module-crm';
import {
  queueCalendarConfirmation,
  readCalendarConfirmationRecipient,
} from '@repo/module-messaging';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';

import { bookingFixtureSuite, calendars, request } from '../test/booking-fixtures.js';
import { explainDoubleBooking } from './appointment-staff.js';
import { readAppointment } from './appointments.js';
import { createAppointmentRoutes, type AppointmentOptions } from './index.js';

const suite = bookingFixtureSuite();
const { fixture, handlers, manage } = suite;
let database: TestDatabase;
let db: Database;
beforeAll(() => {
  database = suite.database;
  db = suite.db;
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Every port as the server composes it. */
const ports: AppointmentOptions = {
  calendars,
  members: calendars.members,
  contacts: { names: readContactNames, lock: lockBookingContact },
  people: {
    names: async (trx, ids) => {
      if (ids.length === 0) return new Map();
      const rows = await trx
        .selectFrom('auth.users')
        .select(['id', 'name'])
        .where('id', 'in', [...ids])
        .execute();
      return new Map(rows.map((row) => [row.id, row.name]));
    },
  },
  notifications: {
    queue: queueCalendarConfirmation,
    recipient: readCalendarConfirmationRecipient,
  },
};

/** The fixture's host, acting as themselves with every permission. */
const host = (f: Fixture): Invocation => ({
  context: {
    ...f.business.context,
    actorKind: 'user',
    userId: f.user.id,
    actorId: f.user.id,
    correlationId: randomUUID(),
  },
  permissions: 'all',
});

async function act(
  f: Fixture,
  operationId: string,
  input: { params?: Record<string, string>; body?: unknown },
  options: AppointmentOptions = ports,
  invocation: Invocation = host(f),
): Promise<AppointmentDetail> {
  const route = createAppointmentRoutes(options).find(
    (each) => each.endpoint.operationId === operationId,
  );
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return appointmentDetail.parse(
    await route.run(
      { invocation, params: input.params ?? {}, query: {}, body: input.body },
      { db, authorize: allowEveryone },
    ),
  );
}

const day = (ahead: number) => new Date(Date.now() + ahead * 86_400_000).toISOString().slice(0, 10);

async function contactOf(f: Fixture, firstName = 'Amina') {
  const made = await database.fixtures.contact(f.business.context, {
    firstName,
    email: `${randomUUID().slice(0, 8)}@example.test`,
  });
  return { uuid: made.id, id: toPublicId('contact', made.id) };
}

const book = (
  f: Fixture,
  contactId: string,
  startsAt: string,
  more: Record<string, unknown> = {},
) =>
  act(f, 'createAppointment', {
    body: {
      requestId: randomUUID(),
      calendarId: f.saved.calendar.id,
      contactId,
      startsAt,
      ...more,
    },
  });

const eventsOf = (f: Fixture, appointment: string) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ type: string; payload: Record<string, unknown>; actor_kind: string }>(
      `select type, payload, actor_kind from events.events
       where subject_kind = 'appointment' and subject_id = $1 order by recorded_at, id`,
      [parsePublicId('appointment', appointment) ?? null],
    ),
  );

const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues.map(({ path, code }) => ({ path, code }));
};

it('books a slot the calendar offers: its length, its host, confirmed, and who booked it', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const startsAt = `${day(1)}T10:00:00Z`;

  const booked = await book(f, contact.id, startsAt, {
    notes: 'Bring the plans.',
    location: 'Gate B',
  });

  expect(booked).toMatchObject({
    title: 'Venue tour',
    status: 'confirmed',
    startsAt: `${day(1)}T10:00:00.000Z`,
    endsAt: `${day(1)}T10:30:00.000Z`,
    source: 'user',
    notes: 'Bring the plans.',
    location: 'Gate B',
    calendar: { id: f.saved.calendar.id },
    contact: { id: contact.id },
    assignee: { membershipId: f.membershipId, you: true },
    canManage: true,
  });
  expect(booked.createdBy).not.toBeNull();
  expect(booked.history.map((entry) => entry.type)).toEqual(['booked']);
  const events = await eventsOf(f, booked.id);
  expect(events.map((event) => event.type)).toEqual(['appointment.booked']);
  expect(events[0]?.payload).toMatchObject({
    calendarId: parsePublicId('calendar', f.saved.calendar.id),
    contactId: contact.uuid,
    startsAt: `${day(1)}T10:00:00.000Z`,
    endsAt: `${day(1)}T10:30:00.000Z`,
    source: 'user',
  });
  expect(events[0]?.actor_kind).toBe('user');
  // Nobody agreed to be written to: a booking by the team sends the contact nothing.
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    ),
  ).toHaveLength(0);
});

it('refuses a time the calendar does not offer, and books it when availability is set aside', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const early = `${day(1)}T07:00:00Z`;
  const far = `${day(200)}T10:00:00Z`;

  await expect(book(f, contact.id, early)).rejects.toBeInstanceOf(ConflictError);
  await expect(book(f, contact.id, far)).rejects.toBeInstanceOf(ConflictError);

  const outside = await book(f, contact.id, early, {
    ignoreAvailability: true,
    endsAt: `${day(1)}T08:15:00Z`,
  });
  expect(outside).toMatchObject({
    startsAt: `${day(1)}T07:00:00.000Z`,
    endsAt: `${day(1)}T08:15:00.000Z`,
  });
  const beyond = await book(f, contact.id, far, {
    ignoreAvailability: true,
    endsAt: `${day(200)}T11:00:00Z`,
  });
  expect(beyond.status).toBe('confirmed');
  expect(
    await refusal(
      book(f, contact.id, `${day(2)}T07:00:00Z`, {
        ignoreAvailability: true,
        endsAt: `${day(40)}T07:00:00Z`,
      }),
    ),
  ).toEqual([{ path: '/endsAt', code: 'too_long' }]);
});

it('never books one person twice at the same time, whatever is set aside', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const other = await contactOf(f, 'Brian');
  const startsAt = `${day(1)}T10:00:00Z`;
  await book(f, contact.id, startsAt);

  await expect(book(f, other.id, startsAt)).rejects.toBeInstanceOf(ConflictError);
  await expect(
    book(f, other.id, `${day(1)}T10:15:00Z`, {
      ignoreAvailability: true,
      endsAt: `${day(1)}T10:45:00Z`,
    }),
  ).rejects.toBeInstanceOf(ConflictError);

  // Two people at two desks, one slot: exactly one of them gets it.
  const slot = `${day(1)}T14:00:00Z`;
  const both = await Promise.allSettled([book(f, contact.id, slot), book(f, other.id, slot)]);
  expect(both.filter((each) => each.status === 'fulfilled')).toHaveLength(1);
  const lost = both.find((each) => each.status === 'rejected');
  expect(lost?.status === 'rejected' ? lost.reason : undefined).toBeInstanceOf(ConflictError);
});

it('answers the first booking again for the same request, and refuses the request with other details', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const body = {
    requestId: randomUUID(),
    calendarId: f.saved.calendar.id,
    contactId: contact.id,
    startsAt: `${day(1)}T10:00:00Z`,
  };
  const first = await act(f, 'createAppointment', { body });
  const again = await act(f, 'createAppointment', { body });

  expect(again.id).toBe(first.id);
  expect(await eventsOf(f, first.id)).toHaveLength(1);
  await expect(
    act(f, 'createAppointment', { body: { ...body, startsAt: `${day(1)}T11:00:00Z` } }),
  ).rejects.toBeInstanceOf(ConflictError);
});

it('refuses a contact, a calendar and a person that are not for this business to book', async () => {
  const f = await fixture();
  const elsewhere = await fixture();
  const contact = await contactOf(f);
  const foreign = await contactOf(elsewhere);
  const startsAt = `${day(1)}T10:00:00Z`;

  expect(await refusal(book(f, foreign.id, startsAt))).toEqual([
    { path: '/contactId', code: 'unknown_contact' },
  ]);
  await expect(
    act(f, 'createAppointment', {
      body: {
        requestId: randomUUID(),
        calendarId: elsewhere.saved.calendar.id,
        contactId: contact.id,
        startsAt,
      },
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(
    await refusal(book(f, contact.id, startsAt, { assignee: elsewhere.membershipId })),
  ).toEqual([{ path: '/assignee', code: 'unavailable_member' }]);

  // Someone on the team who takes no bookings on this calendar.
  const colleague = await database.fixtures.user();
  const membership = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values(app.agency_id(),app.business_id(),$1,$2) returning id',
      [colleague.id, f.roleId],
    ),
  );
  expect(
    await refusal(
      book(f, contact.id, startsAt, { assignee: toPublicId('membership', membership.id) }),
    ),
  ).toEqual([{ path: '/assignee', code: 'not_calendar_member' }]);

  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [contact.uuid]),
  );
  expect(await refusal(book(f, contact.id, startsAt))).toEqual([
    { path: '/contactId', code: 'unknown_contact' },
  ]);
  const kept = await contactOf(f, 'Kept');
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.calendars set is_active = false'),
  );
  expect(await refusal(book(f, kept.id, startsAt))).toEqual([
    { path: '/calendarId', code: 'calendar_unavailable' },
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from calendar.appointments'),
    ),
  ).toHaveLength(0);
});

it('moves an appointment: its owner stays, its old time is free, and both events are told', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const booked = await book(f, contact.id, `${day(1)}T10:00:00Z`);

  const moved = await act(f, 'rescheduleAppointment', {
    params: { id: booked.id },
    body: { revision: booked.revision, startsAt: `${day(2)}T11:00:00Z` },
  });

  expect(moved).toMatchObject({
    id: booked.id,
    status: 'confirmed',
    startsAt: `${day(2)}T11:00:00.000Z`,
    endsAt: `${day(2)}T11:30:00.000Z`,
    assignee: { membershipId: f.membershipId },
  });
  expect(moved.revision).not.toBe(booked.revision);
  const events = await eventsOf(f, booked.id);
  expect(events.map((event) => event.type)).toEqual([
    'appointment.booked',
    'appointment.rescheduled',
    'appointment.status_changed',
  ]);
  expect(events[2]?.payload).toMatchObject({
    status: 'confirmed',
    previousStatus: 'confirmed',
    rescheduled: true,
  });
  expect(moved.history.map((entry) => entry.type)).toEqual([
    'booked',
    'rescheduled',
    'status_changed',
  ]);
  // The time it left can be booked again.
  await expect(
    book(f, (await contactOf(f, 'Brian')).id, `${day(1)}T10:00:00Z`),
  ).resolves.toMatchObject({ status: 'confirmed' });

  // What the screen held before the move is refused.
  await expect(
    act(f, 'rescheduleAppointment', {
      params: { id: booked.id },
      body: { revision: booked.revision, startsAt: `${day(3)}T11:00:00Z` },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  // A time outside the calendar's hours needs availability set aside.
  await expect(
    act(f, 'rescheduleAppointment', {
      params: { id: booked.id },
      body: { revision: moved.revision, startsAt: `${day(3)}T20:00:00Z` },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  const late = await act(f, 'rescheduleAppointment', {
    params: { id: booked.id },
    body: {
      revision: moved.revision,
      startsAt: `${day(3)}T20:00:00Z`,
      endsAt: `${day(3)}T21:00:00Z`,
      ignoreAvailability: true,
    },
  });
  expect(late.endsAt).toBe(`${day(3)}T21:00:00.000Z`);
});

it('cancels with a reason, frees the time, tells both events, and refuses to move what is cancelled', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const startsAt = `${day(1)}T10:00:00Z`;
  const booked = await book(f, contact.id, startsAt);

  const cancelled = await act(f, 'cancelAppointment', {
    params: { id: booked.id },
    body: { revision: booked.revision, reason: 'Asked to come another week.' },
  });

  expect(cancelled).toMatchObject({
    status: 'cancelled',
    cancelReason: 'Asked to come another week.',
  });
  expect(cancelled.cancelledAt).not.toBeNull();
  const events = await eventsOf(f, booked.id);
  expect(events.map((event) => event.type)).toEqual([
    'appointment.booked',
    'appointment.cancelled',
    'appointment.status_changed',
  ]);
  expect(events[2]?.payload).toMatchObject({ status: 'cancelled', previousStatus: 'confirmed' });
  await expect(
    act(f, 'cancelAppointment', { params: { id: booked.id }, body: { revision: booked.revision } }),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    act(f, 'rescheduleAppointment', {
      params: { id: booked.id },
      body: { revision: cancelled.revision, startsAt: `${day(2)}T10:00:00Z` },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(book(f, (await contactOf(f, 'Brian')).id, startsAt)).resolves.toMatchObject({
    status: 'confirmed',
  });
});

it('marks a status and tells it once; the same status tells nothing; a taken time cannot be taken back', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const startsAt = `${day(1)}T10:00:00Z`;
  const booked = await book(f, contact.id, startsAt, { status: 'booked' });
  expect(booked.status).toBe('booked');
  const mark = (revision: string, status: string) =>
    act(f, 'setAppointmentStatus', { params: { id: booked.id }, body: { revision, status } });

  const confirmed = await mark(booked.revision, 'confirmed');
  const same = await mark(confirmed.revision, 'confirmed');
  expect(same.revision).toBe(confirmed.revision);
  const invalid = await mark(confirmed.revision, 'invalid');
  expect(invalid.status).toBe('invalid');
  const types = (await eventsOf(f, booked.id)).map((event) => [
    event.type,
    event.payload['previousStatus'],
    event.payload['status'],
  ]);
  expect(types).toEqual([
    ['appointment.booked', undefined, undefined],
    ['appointment.status_changed', 'booked', 'confirmed'],
    ['appointment.status_changed', 'confirmed', 'invalid'],
  ]);
  // The trigger's filters read these two keys of the payload (automation triggers.ts).
  const last = (await eventsOf(f, booked.id)).at(-1);
  expect(Object.keys(last?.payload ?? {})).toEqual(
    expect.arrayContaining(['calendarId', 'status', 'contactId']),
  );

  // Someone else now has the time: the invalid appointment cannot come back onto it.
  await book(f, (await contactOf(f, 'Brian')).id, startsAt);
  await expect(mark(invalid.revision, 'confirmed')).rejects.toBeInstanceOf(ConflictError);
  const still = await act(f, 'getAppointment', { params: { id: booked.id } });
  expect(still).toMatchObject({ status: 'invalid', revision: invalid.revision });

  const off = await mark(invalid.revision, 'cancelled');
  expect(off.cancelledAt).not.toBeNull();
  const back = await mark(off.revision, 'no_show');
  expect(back).toMatchObject({ status: 'no_show', cancelledAt: null, cancelReason: null });
});

it('tells the booker of a cancellation by the team where they agreed to be told, and cancels all the same when it cannot', async () => {
  const f = await fixture();
  const date = day(1);
  const publicBooking = (email: string, time: string) =>
    handlers().book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${date}T${time}:00Z`,
        contact: { email },
        notificationConsent: true,
        contactTimezone: 'UTC',
      },
      request(),
    );
  await publicBooking('first@example.test', '10:00');
  await publicBooking('second@example.test', '11:00');
  const stored = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ id: string }>('select id from calendar.appointments order by starts_at'),
  );
  const [first, second] = stored.map((row) => toPublicId('appointment', row.id));
  const messages = () =>
    database.withTenant(f.business.context, (sql) =>
      sql.query<{ subject: string }>(
        'select subject from messaging.messages order by created_at, id',
      ),
    );
  expect(await messages()).toHaveLength(2);

  const opened = await act(f, 'getAppointment', { params: { id: first ?? '' } });
  expect(opened).toMatchObject({ source: 'booking_page', createdBy: null, status: 'booked' });
  await act(f, 'cancelAppointment', {
    params: { id: first ?? '' },
    body: { revision: opened.revision },
  });
  expect((await messages()).map((message) => message.subject)).toEqual([
    'Your appointment is booked',
    'Your appointment is booked',
    'Your appointment is cancelled',
  ]);

  await database.withTenant(f.business.context, (sql) =>
    sql.query("update messaging.channel_accounts set status='paused'"),
  );
  const other = await act(f, 'getAppointment', { params: { id: second ?? '' } });
  const cancelled = await act(f, 'cancelAppointment', {
    params: { id: second ?? '' },
    body: { revision: other.revision },
  });
  expect(cancelled.status).toBe('cancelled');
  expect(await messages()).toHaveLength(3);
});

it('chooses the host on a round-robin calendar, and asks who when availability is set aside', async () => {
  const f = await fixture();
  const colleague = await database.fixtures.user();
  const membership = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values(app.agency_id(),app.business_id(),$1,$2) returning id',
      [colleague.id, f.roleId],
    ),
  );
  const second = toPublicId('membership', membership.id);
  const shared = (await manage(f, 'createCalendar', {
    body: {
      name: 'Shared desk',
      kind: 'round_robin',
      timezone: 'UTC',
      bookingSlug: 'shared-desk',
      isActive: true,
      minNoticeMinutes: 0,
      members: [
        { membershipId: f.membershipId, weight: 1 },
        { membershipId: second, weight: 1 },
      ],
      weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        startTime: '09:00',
        endTime: '17:00',
      })),
      dateOverrides: [],
    },
  })) as { calendar: { id: string } };
  const startsAt = `${day(1)}T12:00:00Z`;
  const onShared = async (more: Record<string, unknown> = {}) =>
    act(f, 'createAppointment', {
      body: {
        requestId: randomUUID(),
        calendarId: shared.calendar.id,
        contactId: (await contactOf(f, 'Guest')).id,
        startsAt,
        ...more,
      },
    });

  const one = await onShared();
  const two = await onShared();
  // Two bookings of one slot go to the two hosts, whichever is chosen first.
  expect([one.assignee?.membershipId, two.assignee?.membershipId].sort()).toEqual(
    [f.membershipId, second].sort(),
  );
  await expect(onShared()).rejects.toBeInstanceOf(ConflictError);
  expect(
    await refusal(
      onShared({
        startsAt: `${day(1)}T20:00:00Z`,
        endsAt: `${day(1)}T21:00:00Z`,
        ignoreAvailability: true,
      }),
    ),
  ).toEqual([{ path: '/assignee', code: 'assignee_required' }]);
  const named = await onShared({
    startsAt: `${day(1)}T20:00:00Z`,
    endsAt: `${day(1)}T21:00:00Z`,
    ignoreAvailability: true,
    assignee: second,
  });
  expect(named.assignee?.membershipId).toBe(second);
});

it('books in no person’s name for a key, and tells the booker when the team moves their appointment', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const byKey = await act(
    f,
    'createAppointment',
    {
      body: {
        requestId: randomUUID(),
        calendarId: f.saved.calendar.id,
        contactId: contact.id,
        startsAt: `${day(1)}T09:00:00Z`,
      },
    },
    ports,
    {
      context: {
        ...f.business.context,
        actorKind: 'api_key',
        actorId: f.user.id,
        correlationId: randomUUID(),
      },
      permissions: new Set(['appointments.manage']),
    },
  );
  expect(byKey).toMatchObject({ source: 'api', createdBy: null, canManage: true });
  expect(byKey.assignee?.you).toBe(false);

  await handlers().book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${day(1)}T13:00:00Z`,
      contact: { email: 'moved@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const [stored] = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ id: string; management_expires_at: Date }>(
      `select id, management_expires_at from calendar.appointments where source = 'booking_page'`,
    ),
  );
  const id = toPublicId('appointment', stored?.id ?? '');
  const opened = await act(f, 'getAppointment', { params: { id } });
  expect(opened.history.map((entry) => [entry.type, entry.actor])).toEqual([
    ['booked', { kind: 'contact', name: null }],
  ]);
  const moved = await act(f, 'rescheduleAppointment', {
    params: { id },
    body: { revision: opened.revision, startsAt: `${day(3)}T13:00:00Z` },
  });
  expect(moved.startsAt).toBe(`${day(3)}T13:00:00.000Z`);
  const after = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ later: boolean; subjects: string[] }>(
      `select (select management_expires_at > $2 from calendar.appointments where id = $1) as later,
              array(select subject from messaging.messages order by created_at, id) as subjects`,
      [stored?.id, stored?.management_expires_at],
    ),
  );
  // The booker's link lasts thirty days past the appointment, wherever it moved.
  expect(after.later).toBe(true);
  expect(after.subjects).toEqual(['Your appointment is booked', 'Your appointment has moved']);
});

it('says not-found for an appointment that is not there, and refuses an id it never gave', async () => {
  const f = await fixture();
  const nothing = toPublicId('appointment', (await contactOf(f)).uuid);
  const revision = 'a'.repeat(64);
  for (const [operationId, body] of [
    ['rescheduleAppointment', { revision, startsAt: `${day(1)}T10:00:00Z` }],
    ['cancelAppointment', { revision }],
    ['setAppointmentStatus', { revision, status: 'confirmed' }],
    ['setAppointmentNotes', { revision, notes: 'Bring the plans.' }],
  ] as const)
    await expect(act(f, operationId, { params: { id: nothing }, body })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  await expect(
    withTenant(db, host(f).context, (trx) => readAppointment(trx, host(f), 'apt_nonsense', ports)),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('takes no booking on a calendar of a kind it cannot serve, and does not move one there', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const made = await database.withTenant(f.business.context, async (sql) => {
    const calendar = await sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug, is_active)
       values (app.business_id(), 'Panel', 'collective', 'UTC', 'panel', true) returning id`,
    );
    const appointment = await sql.one<{ id: string }>(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at, source)
       values (app.business_id(), $1, $2, $3, 'Panel', $4, $5, 'user') returning id`,
      [calendar.id, contact.uuid, f.user.id, `${day(5)}T10:00:00Z`, `${day(5)}T11:00:00Z`],
    );
    return { calendar: calendar.id, appointment: appointment.id };
  });

  expect(
    await refusal(
      act(f, 'createAppointment', {
        body: {
          requestId: randomUUID(),
          calendarId: toPublicId('calendar', made.calendar),
          contactId: contact.id,
          startsAt: `${day(1)}T10:00:00Z`,
        },
      }),
    ),
  ).toEqual([{ path: '/calendarId', code: 'calendar_unavailable' }]);
  const id = toPublicId('appointment', made.appointment);
  const opened = await act(f, 'getAppointment', { params: { id } });
  await expect(
    act(f, 'rescheduleAppointment', {
      params: { id },
      body: { revision: opened.revision, startsAt: `${day(6)}T10:00:00Z` },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  // Marking it is not placing it: its status can still be set.
  const marked = await act(f, 'setAppointmentStatus', {
    params: { id },
    body: { revision: opened.revision, status: 'completed' },
  });
  expect(marked.status).toBe('completed');
});

it('asks who an appointment is with once its host has left the team', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const booked = await book(f, contact.id, `${day(1)}T10:00:00Z`);
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where user_id = $1', [f.user.id]),
  );

  // Nobody takes bookings on the calendar now: no slot is offered, and no one can be named.
  await expect(book(f, contact.id, `${day(2)}T10:00:00Z`)).rejects.toBeInstanceOf(ConflictError);
  expect(
    await refusal(
      book(f, contact.id, `${day(2)}T10:00:00Z`, {
        ignoreAvailability: true,
        endsAt: `${day(2)}T11:00:00Z`,
      }),
    ),
  ).toEqual([{ path: '/assignee', code: 'assignee_required' }]);
  const opened = await act(f, 'getAppointment', { params: { id: booked.id } });
  expect(opened.assignee).toMatchObject({ membershipId: null, you: true });
  expect(
    await refusal(
      act(f, 'rescheduleAppointment', {
        params: { id: booked.id },
        body: { revision: opened.revision, startsAt: `${day(3)}T10:00:00Z` },
      }),
    ),
  ).toEqual([{ path: '/assignee', code: 'assignee_required' }]);
  // It can still be cancelled.
  const cancelled = await act(f, 'cancelAppointment', {
    params: { id: booked.id },
    body: { revision: opened.revision },
  });
  expect(cancelled.status).toBe('cancelled');
});

it('passes on a failure of what it depends on unchanged, and treats only its own refusals as refusals', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const down = new Error('The team cannot be read.');
  const failing = (membershipId: string): AppointmentOptions => ({
    ...ports,
    calendars: {
      ...calendars,
      members: {
        ...calendars.members,
        resolve: (trx, context, id) => {
          if (id === membershipId) throw down;
          return calendars.members.resolve(trx, context, id);
        },
      },
    },
  });
  const body = {
    requestId: randomUUID(),
    calendarId: f.saved.calendar.id,
    contactId: contact.id,
    startsAt: `${day(1)}T10:00:00Z`,
  };
  // The calendar's own host cannot be read.
  await expect(act(f, 'createAppointment', { body }, failing(f.membershipId))).rejects.toBe(down);
  // The person named cannot be read.
  const colleague = await database.fixtures.user();
  const membership = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values(app.agency_id(),app.business_id(),$1,$2) returning id',
      [colleague.id, f.roleId],
    ),
  );
  const named = toPublicId('membership', membership.id);
  await expect(
    act(f, 'createAppointment', { body: { ...body, assignee: named } }, failing(named)),
  ).rejects.toBe(down);
  expect(() => explainDoubleBooking(down)).toThrow(down);

  // A booker's confirmation: refused by the queue, the cancellation stands; a recipient
  // who is not to be written to, the same; a queue that breaks is not swallowed.
  const publicBooking = (time: string) =>
    handlers().book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${day(2)}T${time}:00Z`,
        contact: { email: `${randomUUID().slice(0, 8)}@example.test` },
        notificationConsent: true,
        contactTimezone: 'UTC',
      },
      request(),
    );
  for (const time of ['10:00', '11:00', '12:00']) await publicBooking(time);
  const stored = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ id: string }>(
      `select id from calendar.appointments where source = 'booking_page' order by starts_at`,
    ),
  );
  const [first, second, third] = stored.map((row) => toPublicId('appointment', row.id));
  const cancelWith = async (
    id: string | undefined,
    notifications: AppointmentOptions['notifications'],
  ) => {
    const opened = await act(f, 'getAppointment', { params: { id: id ?? '' } });
    return act(
      f,
      'cancelAppointment',
      { params: { id: id ?? '' }, body: { revision: opened.revision } },
      { ...ports, notifications },
    );
  };
  const messages = () =>
    database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    );
  expect(await messages()).toHaveLength(3);
  const refusedByQueue = await cancelWith(first, {
    ...ports.notifications,
    queue: () => Promise.resolve({ outcome: 'refused' }),
  });
  expect(refusedByQueue.status).toBe('cancelled');
  const nobodyToTell = await cancelWith(second, {
    ...ports.notifications,
    recipient: () => Promise.resolve(null),
  });
  expect(nobodyToTell.status).toBe('cancelled');
  expect(await messages()).toHaveLength(3);
  await expect(
    cancelWith(third, {
      ...ports.notifications,
      queue: () => Promise.reject(down),
    }),
  ).rejects.toBe(down);
  const untouched = await act(f, 'getAppointment', { params: { id: third ?? '' } });
  expect(untouched.status).toBe('booked');
});

it('writes the notes after booking, refuses a note over one saved meanwhile, and keeps the words out of the log', async () => {
  const f = await fixture();
  const contact = await contactOf(f);
  const booked = await book(f, contact.id, `${day(1)}T10:00:00Z`, { notes: 'Bring the plans.' });
  expect(booked.notes).toBe('Bring the plans.');
  const write = (revision: string, notes: string, id = booked.id) =>
    act(f, 'setAppointmentNotes', { params: { id }, body: { revision, notes } });

  const written = await write(booked.revision, '  Bring the floor plans.\n\nAsk about parking.  ');
  // Kept as written, and nothing else about the appointment changes but its revision.
  expect(written.notes).toBe('  Bring the floor plans.\n\nAsk about parking.  ');
  expect(written).toMatchObject({
    status: booked.status,
    startsAt: booked.startsAt,
    endsAt: booked.endsAt,
    title: booked.title,
    history: booked.history,
  });
  expect(written.revision).not.toBe(booked.revision);
  expect((await act(f, 'getAppointment', { params: { id: booked.id } })).notes).toBe(written.notes);

  // A note written over one saved since it was read is refused, and changes nothing.
  await expect(write(booked.revision, 'Mine instead.')).rejects.toBeInstanceOf(ConflictError);
  expect((await act(f, 'getAppointment', { params: { id: booked.id } })).notes).toBe(written.notes);
  // The same holds the other way: a move from before the note is a stale change.
  await expect(
    act(f, 'rescheduleAppointment', {
      params: { id: booked.id },
      body: { revision: booked.revision, startsAt: `${day(2)}T10:00:00Z` },
    }),
  ).rejects.toBeInstanceOf(ConflictError);

  // The same words again change nothing; empty clears them.
  const same = await write(written.revision, written.notes);
  expect(same.revision).toBe(written.revision);
  const cleared = await write(same.revision, '');
  expect(cleared.notes).toBe('');

  // A cancelled appointment's notes can still be written.
  const cancelled = await act(f, 'cancelAppointment', {
    params: { id: booked.id },
    body: { revision: cleared.revision },
  });
  expect((await write(cancelled.revision, 'Asked for a call in spring.')).notes).toBe(
    'Asked for a call in spring.',
  );

  // No trigger reads the notes, so nothing is emitted for them.
  expect((await eventsOf(f, booked.id)).map((event) => event.type)).toEqual([
    'appointment.booked',
    'appointment.cancelled',
    'appointment.status_changed',
  ]);
  // The audit log keeps each write and its outcome, never the words.
  const audited = await database.as('crm_owner', (sql) =>
    sql.query<{ outcome: string; error_code: string | null; input: Record<string, unknown> }>(
      'select outcome, error_code, input from audit.commands where business_id = $1 and command = $2 order by recorded_at',
      [f.business.id, 'calendar.appointment.set_notes'],
    ),
  );
  expect(audited.map(({ outcome, error_code }) => [outcome, error_code])).toEqual([
    ['ok', null],
    ['failed', 'conflict'],
    ['ok', null],
    ['ok', null],
    ['ok', null],
  ]);
  for (const { input } of audited) {
    expect(Object.keys(input).toSorted()).toEqual(['id', 'revision']);
    expect(JSON.stringify(input)).not.toMatch(/plans|Mine|spring/);
  }

  // Too long is refused as the contract says, and the notes stay as they were.
  expect(await refusal(write(cleared.revision, 'x'.repeat(5001)))).toEqual([
    { path: '/notes', code: 'too_big' },
  ]);
  expect((await act(f, 'getAppointment', { params: { id: booked.id } })).notes).toBe(
    'Asked for a call in spring.',
  );
});

it("leaves the booker's open page good when the team writes notes, and still refuses two notes crossing", async () => {
  const f = await fixture();
  const api = handlers();
  const booked = await api.book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${day(1)}T10:00:00Z`,
      contact: { email: 'notes-and-page@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const token = booked.managementUrl?.split('/').at(-1) ?? '';
  // The booker opens their page; two people of the team open the appointment.
  const page = await api.appointment(token, request());
  const [stored] = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ id: string }>(`select id from calendar.appointments`),
  );
  const id = toPublicId('appointment', stored?.id ?? '');
  const first = await act(f, 'getAppointment', { params: { id } });
  const second = await act(f, 'getAppointment', { params: { id } });
  const write = (revision: string, notes: string) =>
    act(f, 'setAppointmentNotes', { params: { id }, body: { revision, notes } });

  const written = await write(first.revision, 'Wants the terrace.');
  // The other's note, written on what they read before, is refused and changes nothing.
  await expect(write(second.revision, 'Wants the hall.')).rejects.toBeInstanceOf(ConflictError);
  expect((await act(f, 'getAppointment', { params: { id } })).notes).toBe('Wants the terrace.');

  // The booker never sees the notes: their page and its revision are as they were.
  expect(await api.appointment(token, request())).toEqual(page);
  const moved = await api.reschedule(
    token,
    { operationRequestId: randomUUID(), revision: page.revision, startsAt: `${day(1)}T11:00:00Z` },
    request(),
  );
  expect(moved.startsAt).toBe(`${day(1)}T11:00:00.000Z`);

  // The booker's move is a change the team must read: a note on the old revision is refused.
  await expect(write(written.revision, 'Wants the garden.')).rejects.toBeInstanceOf(ConflictError);
  const reread = await act(f, 'getAppointment', { params: { id } });
  expect(reread.notes).toBe('Wants the terrace.');
  await write(reread.revision, 'Wants the garden.');
  // And a cancellation from the page opened after the move, past another note, is accepted.
  const after = await api.appointment(token, request());
  await write((await act(f, 'getAppointment', { params: { id } })).revision, 'Called back.');
  await expect(
    api.cancel(token, { operationRequestId: randomUUID(), revision: after.revision }, request()),
  ).resolves.toMatchObject({ status: 'cancelled' });
});
