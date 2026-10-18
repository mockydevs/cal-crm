import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { calendarUserAvailability, type CalendarUserAvailabilityProfile } from '@repo/contracts';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { findTimeZone, intakeContact } from '@repo/module-crm';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';
import { bookingFixtureSuite, calendars, request } from '../test/booking-fixtures.js';

const suite = bookingFixtureSuite();
const { fixture, handlers, manage, managedFixture } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});
type Fixture = Awaited<ReturnType<typeof fixture>>;

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const everyDay = (startMinute: number, endMinute: number) =>
  Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute, endMinute }));
const schedule = (
  change: Partial<CalendarUserAvailabilityProfile> = {},
): CalendarUserAvailabilityProfile => ({
  timezone: 'UTC',
  inheritCalendarHours: true,
  weeklyHours: [],
  dateOverrides: [],
  ...change,
});

/** Saves a member's schedule through the manager routes, from the revision stored now. */
async function setSchedule(
  f: Pick<Fixture, 'business'>,
  membershipId: string,
  profile: CalendarUserAvailabilityProfile | null,
  options = calendars,
) {
  const current = calendarUserAvailability.parse(
    await manage(f, 'getCalendarUserAvailability', { params: { membershipId } }),
  );
  return calendarUserAvailability.parse(
    await manage(
      f,
      'updateCalendarUserAvailability',
      { params: { membershipId }, body: { revision: current.revision, profile } },
      options,
    ),
  );
}
/** Blocks a member's time on every calendar, through the manager route. */
const block = (
  f: Pick<Fixture, 'business'>,
  membershipId: string,
  startsAt: string,
  endsAt: string,
  title = '',
) => manage(f, 'createBlockedSlot', { body: { membershipId, startsAt, endsAt, title } });
/** The UTC clock times of the slots the booking page offers on a date. */
async function offered(f: Fixture, date: string): Promise<string[]> {
  const { slots } = await handlers().slots(f.params, { date }, request());
  return slots.map((slot) => slot.startsAt.slice(11, 16));
}
const booking = (date: string, time: string, email = `guest-${randomUUID()}@example.test`) => ({
  bookingRequestId: randomUUID(),
  startsAt: `${date}T${time}:00Z`,
  contact: { email },
  notificationConsent: true as const,
  contactTimezone: 'UTC',
});
const written = (f: Pick<Fixture, 'business'>) =>
  database.withTenant(f.business.context, async (sql) => ({
    appointments: (await sql.query('select id from calendar.appointments')).length,
    contacts: (await sql.query('select id from crm.contacts')).length,
    messages: (await sql.query('select id from messaging.messages')).length,
  }));
const nothingWritten = { appointments: 0, contacts: 0, messages: 0 };
const settled = <T>(attempt: Promise<T>) =>
  attempt.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
/** Whether a session of this database waits for a lock in a statement like the one given. */
const waitingOn = (statement: string) =>
  // Another role's wait events are hidden from crm_app, so the superuser watches.
  database.as('postgres', async (sql) => {
    const row = await sql.one<{ waiting: boolean }>(
      "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike $1) as waiting",
      [statement],
    );
    return row.waiting;
  });
const untilWaiting = (statement: string) =>
  expect.poll(() => waitingOn(statement), { timeout: 10_000, interval: 50 }).toBe(true);
const halfHours = (from: string, count: number) =>
  Array.from({ length: count }, (_, index) => {
    const minute = Number(from.slice(0, 2)) * 60 + Number(from.slice(3)) + index * 30;
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  });
const calendarDay = halfHours('09:00', 16);

it("offers and books only inside the host's own hours, read in the host's time zone", async () => {
  const f = await fixture();
  const date = tomorrow();
  expect(await offered(f, date)).toEqual(calendarDay);
  // 12:00 to 15:00 in Nairobi is 09:00 to 12:00 UTC.
  const nairobi = schedule({
    timezone: 'Africa/Nairobi',
    inheritCalendarHours: false,
    weeklyHours: everyDay(720, 900),
  });
  await setSchedule(f, f.membershipId, nairobi);
  expect(await offered(f, date)).toEqual(halfHours('09:00', 6));
  await expect(handlers().book(f.params, booking(date, '12:00'), request())).rejects.toBeInstanceOf(
    ConflictError,
  );
  expect(await written(f)).toEqual(nothingWritten);
  // The same stored rows no longer restrict once the host follows the calendar's hours.
  await setSchedule(f, f.membershipId, { ...nairobi, inheritCalendarHours: true });
  expect(await offered(f, date)).toEqual(calendarDay);
  // An independent schedule with no hours closes the host; a reset reopens the calendar's.
  await setSchedule(f, f.membershipId, schedule({ inheritCalendarHours: false }));
  expect(await offered(f, date)).toEqual([]);
  await expect(handlers().book(f.params, booking(date, '10:00'), request())).rejects.toBeInstanceOf(
    ConflictError,
  );
  expect(await written(f)).toEqual(nothingWritten);
  await setSchedule(f, f.membershipId, null);
  expect(await offered(f, date)).toEqual(calendarDay);
  // Hours wider than the calendar's offer nothing more than the calendar does.
  await setSchedule(
    f,
    f.membershipId,
    schedule({ inheritCalendarHours: false, weeklyHours: everyDay(0, 1440) }),
  );
  expect(await offered(f, date)).toEqual(calendarDay);
  const receipt = await handlers().book(f.params, booking(date, '16:30'), request());
  expect(receipt.startsAt).toBe(`${date}T16:30:00.000Z`);
});

it("replaces the host's weekly hours on a date with an override, closed or open, in either mode", async () => {
  const f = await fixture();
  const date = tomorrow();
  const other = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await setSchedule(f, f.membershipId, schedule({ dateOverrides: [{ date, ranges: [] }] }));
  expect(await offered(f, date)).toEqual([]);
  expect(await offered(f, other)).toEqual(calendarDay);
  const open = [
    { startMinute: 600, endMinute: 660 },
    { startMinute: 840, endMinute: 870 },
  ];
  await setSchedule(f, f.membershipId, schedule({ dateOverrides: [{ date, ranges: open }] }));
  expect(await offered(f, date)).toEqual(['10:00', '10:30', '14:00']);
  // An independent schedule closed all week still opens on the date it names.
  await setSchedule(
    f,
    f.membershipId,
    schedule({ inheritCalendarHours: false, dateOverrides: [{ date, ranges: open }] }),
  );
  expect(await offered(f, date)).toEqual(['10:00', '10:30', '14:00']);
  expect(await offered(f, other)).toEqual([]);
  // An override cannot open the host outside the calendar's own hours.
  await setSchedule(
    f,
    f.membershipId,
    schedule({ dateOverrides: [{ date, ranges: [{ startMinute: 0, endMinute: 1440 }] }] }),
  );
  expect(await offered(f, date)).toEqual(calendarDay);
});

it('takes blocked time out of the offer and the booking, buffers included, and never shows its title', async () => {
  const f = await fixture();
  const date = tomorrow();
  const reason = 'Private medical appointment';
  // Someone who follows the calendar's hours, with no schedule stored, can be away too.
  await block(f, f.membershipId, `${date}T10:15:00Z`, `${date}T11:00:00Z`, reason);
  const api = handlers();
  // Half-open: the slot that starts as the blocked time ends is free.
  expect(await offered(f, date)).toEqual(
    calendarDay.filter((time) => time !== '10:00' && time !== '10:30'),
  );
  for (const time of ['10:00', '10:30'])
    await expect(api.book(f.params, booking(date, time), request())).rejects.toBeInstanceOf(
      ConflictError,
    );
  expect(await written(f)).toEqual(nothingWritten);
  const receipt = await api.book(f.params, booking(date, '11:00'), request());
  const token = receipt.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('New booking did not return its capability.');
  const shown = [
    await api.calendar(f.params, request()),
    await api.slots(f.params, { date }, request()),
    receipt,
    await api.appointment(token, request()),
    await api.appointmentSlots(token, { date }, request()),
  ];
  expect(JSON.stringify(shown)).not.toContain(reason);
  expect(JSON.stringify(shown)).not.toContain('medical');
  // A buffer is time the host is occupied, so it may not reach into the blocked time either.
  const g = await fixture();
  await database.withTenant(g.business.context, (sql) =>
    sql.query('update calendar.calendars set buffer_before_minutes=30,buffer_after_minutes=15'),
  );
  await block(g, g.membershipId, `${date}T12:00:00Z`, `${date}T13:00:00Z`, reason);
  // Occupied from 30 minutes before to 15 after: 11:30 and 13:00 touch the block too. The
  // first and last slots stay: buffers may run outside the hours.
  expect(await offered(g, date)).toEqual(
    calendarDay.filter((time) => !['11:30', '12:00', '12:30', '13:00'].includes(time)),
  );
  await expect(handlers().book(g.params, booking(date, '13:00'), request())).rejects.toBeInstanceOf(
    ConflictError,
  );
  expect(await written(g)).toEqual(nothingWritten);
  // The 16:30 slot is booked, its buffer reaching past closing time.
  expect((await handlers().book(g.params, booking(date, '16:30'), request())).status).toBe(
    'booked',
  );
});

it('assigns a round-robin booking only to a member who is available, and offers no slot when none is', async () => {
  const f = await fixture();
  const date = tomorrow();
  const second = await database.fixtures.user();
  const added = await database.withTenant(f.business.context, async (sql) => {
    const membership = await sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values(app.agency_id(),app.business_id(),$1,$2) returning id',
      [second.id, f.roleId],
    );
    await sql.query(
      'insert into calendar.calendar_members(business_id,calendar_id,user_id) select business_id,id,$1 from calendar.calendars',
      [second.id],
    );
    await sql.query("update calendar.calendars set kind='round_robin'");
    return toPublicId('membership', membership.id);
  });
  const membershipOf = new Map([
    [f.user.id, f.membershipId],
    [second.id, added],
  ]);
  const hosts = () =>
    database.withTenant(f.business.context, (sql) =>
      sql.query<{ time: string; host: string }>(
        "select to_char(starts_at at time zone 'UTC','HH24:MI') as time,assigned_user_id as host from calendar.appointments order by starts_at",
      ),
    );
  const api = handlers();
  await api.book(f.params, booking(date, '09:00'), request());
  const first = (await hosts())[0]?.host;
  if (first === undefined) throw new Error('The first booking has no host.');
  const due = first === f.user.id ? second.id : f.user.id;
  // The member with fewer bookings is due next, but is away at 10:00.
  await block(f, membershipOf.get(due) ?? '', `${date}T10:00:00Z`, `${date}T11:00:00Z`);
  // Every slot still has someone: the other member is free wherever one is busy or away.
  expect(await offered(f, date)).toEqual(calendarDay);
  await api.book(f.params, booking(date, '10:00'), request());
  await api.book(f.params, booking(date, '11:00'), request());
  expect(await hosts()).toEqual([
    { time: '09:00', host: first },
    { time: '10:00', host: first },
    { time: '11:00', host: due },
  ]);
  // With both away from 14:00 to 15:00, nobody can take those slots.
  await setSchedule(
    f,
    membershipOf.get(first) ?? '',
    schedule({
      inheritCalendarHours: false,
      weeklyHours: [...everyDay(0, 840), ...everyDay(900, 1440)],
    }),
  );
  await block(f, membershipOf.get(due) ?? '', `${date}T13:30:00Z`, `${date}T15:00:00Z`);
  expect(await offered(f, date)).toEqual(
    // 10:00 too: the first member is booked then, and the second's earlier block still stands.
    calendarDay.filter((time) => !['10:00', '14:00', '14:30'].includes(time)),
  );
  await expect(api.book(f.params, booking(date, '14:00'), request())).rejects.toBeInstanceOf(
    ConflictError,
  );
  // 13:30 is inside the second member's blocked time, so the first takes it despite having more.
  await api.book(f.params, booking(date, '13:30'), request());
  expect((await hosts()).at(-1)).toEqual({ time: '13:30', host: first });
});

it("offers and accepts a reschedule only inside the retained host's schedule, and leaves an earlier booking alone", async () => {
  const f = await managedFixture();
  const reason = 'School run';
  await setSchedule(f, f.membershipId, schedule());
  // The existing 10:00 appointment was booked before this block was known, and stays.
  await block(f, f.membershipId, `${f.date}T09:45:00Z`, `${f.date}T10:10:00Z`, reason);
  await block(f, f.membershipId, `${f.date}T13:00:00Z`, `${f.date}T14:00:00Z`, reason);
  const page = await f.api.appointment(f.token, request());
  expect(page).toMatchObject({ status: 'booked', startsAt: `${f.date}T10:00:00.000Z` });
  const slots = await f.api.appointmentSlots(f.token, { date: f.date }, request());
  expect(slots.slots.map((slot) => slot.startsAt.slice(11, 16))).toEqual(
    calendarDay.filter((time) => !['09:30', '10:00', '13:00', '13:30'].includes(time)),
  );
  expect(JSON.stringify([page, slots])).not.toContain(reason);
  await expect(
    f.api.reschedule(
      f.token,
      {
        operationRequestId: randomUUID(),
        revision: page.revision,
        startsAt: `${f.date}T13:30:00Z`,
      },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect((await f.api.appointment(f.token, request())).startsAt).toBe(`${f.date}T10:00:00.000Z`);
  const moved = await f.api.reschedule(
    f.token,
    { operationRequestId: randomUUID(), revision: page.revision, startsAt: `${f.date}T14:00:00Z` },
    request(),
  );
  expect(moved).toMatchObject({ status: 'booked', startsAt: `${f.date}T14:00:00.000Z` });
});

it("keeps one business's schedule for a person out of another business's calendar", async () => {
  const f = await fixture();
  const date = tomorrow();
  const elsewhere = await database.fixtures.business(f.business.context.agencyId);
  const membership = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values($1,$2,$3,$4) returning id',
      [f.business.context.agencyId, elsewhere.id, f.user.id, f.roleId],
    ),
  );
  await setSchedule(
    { business: elsewhere },
    toPublicId('membership', membership.id),
    schedule({ inheritCalendarHours: false }),
  );
  expect(await offered(f, date)).toEqual(calendarDay);
  await setSchedule(f, f.membershipId, schedule({ inheritCalendarHours: false }));
  expect(await offered(f, date)).toEqual([]);
});

it("keeps a whole 23 or 25 hour day of the host's own zone open across the clock change, and its repeated or missing hour exact", async () => {
  const f = await fixture();
  // The calendar, in UTC, opens every minute it can hold: its hours end at 23:59.
  await database.withTenant(f.business.context, async (sql) => {
    await sql.query("update calendar.weekly_hours set start_time='00:00',end_time='23:59'");
    await sql.query('update calendar.calendars set max_days_ahead=730');
  });
  const zone = 'America/New_York';
  const soonest = Temporal.Now.instant().add({ hours: 72 });
  const change = soonest.toZonedDateTimeISO(zone).getTimeZoneTransition('next');
  if (change === null) throw new Error('New York has no further clock change.');
  const local = change.subtract({ nanoseconds: 1 }).toPlainDate();
  const dayStart = local.toZonedDateTime(zone).toInstant();
  const dayEnd = local.add({ days: 1 }).toZonedDateTime(zone).toInstant();
  const hours = dayEnd.since(dayStart).total('hours');
  expect([23, 25]).toContain(hours);
  const utcDates = [local.toString(), local.add({ days: 1 }).toString()];
  const openInstants = async () => {
    const found: string[] = [];
    for (const date of utcDates)
      for (const slot of (await handlers().slots(f.params, { date }, request())).slots)
        found.push(slot.startsAt);
    return found;
  };
  const instants = (from: Temporal.Instant, to: Temporal.Instant) => {
    const all: string[] = [];
    for (
      let at = from;
      Temporal.Instant.compare(at.add({ minutes: 30 }), to) <= 0;
      at = at.add({ minutes: 30 })
    )
      // The calendar's own day ends at 23:59 UTC, so it never offers the 23:30 slot.
      if (!at.toString().includes('T23:30:00Z')) all.push(at.toString());
    return all;
  };
  // Open only on that one local date: every half hour of its 23 or 25 hours, and no other.
  await setSchedule(
    f,
    f.membershipId,
    schedule({
      timezone: zone,
      inheritCalendarHours: false,
      dateOverrides: [{ date: local.toString(), ranges: [{ startMinute: 0, endMinute: 1440 }] }],
    }),
  );
  const wholeDay = await openInstants();
  expect(wholeDay).toEqual(instants(dayStart, dayEnd));
  expect(wholeDay).toHaveLength(hours * 2 - 1);
  // 01:00 to 03:00 on the clock: three hours of time when an hour repeats, one when one is skipped.
  await setSchedule(
    f,
    f.membershipId,
    schedule({
      timezone: zone,
      inheritCalendarHours: false,
      dateOverrides: [{ date: local.toString(), ranges: [{ startMinute: 60, endMinute: 180 }] }],
    }),
  );
  const oneOClock = dayStart.add({ hours: 1 });
  expect(await openInstants()).toEqual(
    instants(oneOClock, oneOClock.add({ hours: hours === 25 ? 3 : 1 })),
  );
});

it('refuses the booking page and every booking once the host is disabled or leaves the team', async () => {
  const f = await managedFixture();
  const refusedEverywhere = async () => {
    await expect(f.api.calendar(f.params, request())).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.api.slots(f.params, { date: f.date }, request())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(f.api.book(f.params, booking(f.date, '15:00'), request())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      f.api.appointmentSlots(f.token, { date: f.date }, request()),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      f.api.reschedule(
        f.token,
        {
          operationRequestId: randomUUID(),
          revision: f.appointment.revision,
          startsAt: `${f.date}T15:00:00Z`,
        },
        request(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await written(f)).toEqual({ appointments: 1, contacts: 1, messages: 1 });
    expect((await f.api.appointment(f.token, request())).startsAt).toBe(`${f.date}T10:00:00.000Z`);
  };
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=now() where id=$1', [f.user.id]),
  );
  await refusedEverywhere();
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=null where id=$1', [f.user.id]),
  );
  expect((await f.api.slots(f.params, { date: f.date }, request())).slots).toHaveLength(15);
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where id=$1', [
      parsePublicId('membership', f.membershipId),
    ]),
  );
  await refusedEverywhere();
});

it('makes a booking wait for a schedule change in flight and then refuses the time it took away', async () => {
  const f = await fixture();
  const date = tomorrow();
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  // The save stops after its revision check, holding the business lock every booking takes.
  const saving = settled(
    setSchedule(
      f,
      f.membershipId,
      schedule({
        inheritCalendarHours: false,
        // Free all day but 10:00 to 11:00.
        weeklyHours: [...everyDay(0, 600), ...everyDay(660, 1440)],
      }),
      {
        ...calendars,
        timeZones: {
          async find(trx, value) {
            ready.resolve(undefined);
            await proceed.promise;
            return findTimeZone(trx, value);
          },
        },
      },
    ),
  );
  await ready.promise;
  const taken = settled(handlers().book(f.params, booking(date, '10:30'), request()));
  const free = settled(handlers().book(f.params, booking(date, '11:00'), request()));
  try {
    await untilWaiting('%tenancy%businesses%for no key update%');
    expect(await written(f)).toEqual(nothingWritten);
  } finally {
    proceed.resolve(undefined);
  }
  const [saved, refused, booked] = await Promise.all([saving, taken, free]);
  if (!saved.ok) throw saved.error;
  if (!booked.ok) throw booked.error;
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error('A booking was accepted in hours taken away before it.');
  expect(refused.error).toBeInstanceOf(ConflictError);
  expect(await written(f)).toEqual({ appointments: 1, contacts: 1, messages: 1 });
});

it('makes a booking wait for a removal from the team in flight and then finds no calendar to book', async () => {
  const f = await fixture();
  const date = tomorrow();
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const removing = settled(
    database.as('crm_owner', async (sql) => {
      await sql.query('delete from tenancy.memberships where id=$1', [
        parsePublicId('membership', f.membershipId),
      ]);
      ready.resolve(undefined);
      await proceed.promise;
    }),
  );
  await ready.promise;
  // Until the removal commits the calendar still reads as bookable; the booking then
  // waits on the membership it must hold, and sees it gone.
  const attempt = settled(handlers().book(f.params, booking(date, '10:00'), request()));
  try {
    await untilWaiting('%tenancy%memberships%for share%');
  } finally {
    proceed.resolve(undefined);
  }
  const [removed, result] = await Promise.all([removing, attempt]);
  if (!removed.ok) throw removed.error;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Someone removed from the team was booked.');
  expect(result.error).toBeInstanceOf(NotFoundError);
  expect(await written(f)).toEqual(nothingWritten);
});

it('makes a removal from the team wait for a booking in flight, which keeps its host', async () => {
  const f = await fixture();
  const date = tomorrow();
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  // The booking stops after it has checked its host, before it writes anything.
  const api = handlers(async (trx, input, command) => {
    ready.resolve(undefined);
    await proceed.promise;
    return intakeContact(trx, input, command);
  });
  const attempt = settled(api.book(f.params, booking(date, '10:00'), request()));
  await ready.promise;
  const removing = settled(
    database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.memberships where id=$1', [
        parsePublicId('membership', f.membershipId),
      ]),
    ),
  );
  try {
    await untilWaiting('%delete from tenancy.memberships%');
  } finally {
    proceed.resolve(undefined);
  }
  const [result, removed] = await Promise.all([attempt, removing]);
  if (!result.ok) throw result.error;
  if (!removed.ok) throw removed.error;
  expect(result.value.startsAt).toBe(`${date}T10:00:00.000Z`);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select assigned_user_id,status from calendar.appointments'),
    ),
  ).toEqual([{ assigned_user_id: f.user.id, status: 'booked' }]);
  // The removal committed after it: nothing more can be booked with them.
  await expect(handlers().book(f.params, booking(date, '11:00'), request())).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

it('makes a booking wait for a suspension in flight and then finds no calendar to book', async () => {
  const f = await fixture();
  const date = tomorrow();
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const suspending = settled(
    database.as('crm_owner', async (sql) => {
      await sql.query("update tenancy.businesses set status='suspended' where id=$1", [
        f.business.id,
      ]);
      ready.resolve(undefined);
      await proceed.promise;
    }),
  );
  await ready.promise;
  const attempt = settled(handlers().book(f.params, booking(date, '10:00'), request()));
  try {
    await untilWaiting('%tenancy%businesses%for no key update%');
  } finally {
    proceed.resolve(undefined);
  }
  const [suspended, result] = await Promise.all([suspending, attempt]);
  if (!suspended.ok) throw suspended.error;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('A suspended business took a booking.');
  expect(result.error).toBeInstanceOf(NotFoundError);
  expect(await written(f)).toEqual(nothingWritten);
});

it('passes on a failure of the team port as it is, on every path that holds the members', async () => {
  const f = await managedFixture();
  const failure = new Error('The team could not be read.');
  const api = handlers(intakeContact, {
    ...calendars,
    members: { ...calendars.members, resolve: () => Promise.reject(failure) },
  });
  const caught = (attempt: Promise<unknown>) =>
    attempt.then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(await caught(api.book(f.params, booking(f.date, '15:00'), request()))).toBe(failure);
  expect(await caught(api.appointmentSlots(f.token, { date: f.date }, request()))).toBe(failure);
  expect(
    await caught(
      api.reschedule(
        f.token,
        {
          operationRequestId: randomUUID(),
          revision: f.appointment.revision,
          startsAt: `${f.date}T15:00:00Z`,
        },
        request(),
      ),
    ),
  ).toBe(failure);
  expect(await written(f)).toEqual({ appointments: 1, contacts: 1, messages: 1 });
});
