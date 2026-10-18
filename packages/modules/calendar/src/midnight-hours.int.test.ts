// A calendar's hours can reach midnight: a range may end at 24:00 through the contract,
// the stored `time` columns (0007: PostgreSQL keeps 24:00:00 and orders it last), the
// revision, the effective-hours read, the booking page and a booking.
import { randomUUID } from 'node:crypto';
import { calendarConfiguration, calendarHours } from '@repo/contracts';
import { ConflictError, ValidationError } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';
import { bookingFixtureSuite, request } from '../test/booking-fixtures.js';

const suite = bookingFixtureSuite();
const { fixture, handlers, manage } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const booking = (startsAt: string) => ({
  bookingRequestId: randomUUID(),
  startsAt,
  contact: { email: `late-${randomUUID()}@example.test` },
  notificationConsent: true as const,
  contactTimezone: 'UTC',
});

it('stores hours that end at 24:00 and offers and books the last slot of the day', async () => {
  const f = await fixture();
  const tomorrow = day(1);
  const dayAfter = day(2);
  const weeklyHours = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    startTime: '22:00',
    endTime: '24:00',
  }));
  const dateOverrides = [
    {
      date: dayAfter,
      ranges: [
        { startTime: '00:00', endTime: '01:00' },
        { startTime: '23:00', endTime: '24:00' },
      ],
    },
  ];
  const saved = calendarConfiguration.parse(
    await manage(f, 'updateCalendarAvailability', {
      params: { id: f.saved.calendar.id },
      body: {
        members: [{ membershipId: f.membershipId, weight: 1 }],
        weeklyHours,
        dateOverrides,
        revision: f.saved.revision,
      },
    }),
  );
  expect(saved.weeklyHours).toEqual(weeklyHours);
  expect(saved.dateOverrides).toEqual(dateOverrides);
  // The database holds the end of the day itself, not a minute before it.
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query<{ ends: string }>(
        'select distinct end_time::text as ends from calendar.weekly_hours union select end_time::text from calendar.date_overrides order by 1',
      ),
    ),
  ).toEqual([{ ends: '01:00:00' }, { ends: '24:00:00' }]);
  // Reading again gives the same revision: 24:00 is part of what was saved.
  const read = calendarConfiguration.parse(
    await manage(f, 'getCalendar', { params: { id: f.saved.calendar.id } }),
  );
  expect(read.revision).toBe(saved.revision);
  expect(read.revision).not.toBe(f.saved.revision);

  const api = handlers();
  const offered = async (date: string) =>
    (await api.slots(f.params, { date }, request())).slots.map((slot) => slot.startsAt);
  expect(await offered(tomorrow)).toEqual(
    ['22:00', '22:30', '23:00', '23:30'].map((time) => `${tomorrow}T${time}:00Z`),
  );
  expect(await offered(dayAfter)).toEqual(
    ['00:00', '00:30', '23:00', '23:30'].map((time) => `${dayAfter}T${time}:00Z`),
  );
  const receipt = await api.book(f.params, booking(`${tomorrow}T23:30:00Z`), request());
  expect(receipt).toMatchObject({
    status: 'booked',
    startsAt: `${tomorrow}T23:30:00.000Z`,
    endsAt: `${dayAfter}T00:00:00.000Z`,
  });
  // Taken once: the same last slot is gone, and midnight itself belongs to the next day.
  await expect(
    api.book(f.params, booking(`${tomorrow}T23:30:00Z`), request()),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await offered(tomorrow)).toEqual(
    ['22:00', '22:30', '23:00'].map((time) => `${tomorrow}T${time}:00Z`),
  );
  await api.book(f.params, booking(`${dayAfter}T00:00:00Z`), request());
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query<{ starts: string; ends: string }>(
        `select to_char(starts_at at time zone 'UTC','YYYY-MM-DD HH24:MI') as starts,
           to_char(ends_at at time zone 'UTC','YYYY-MM-DD HH24:MI') as ends
         from calendar.appointments order by starts_at`,
      ),
    ),
  ).toEqual([
    { starts: `${tomorrow} 23:30`, ends: `${dayAfter} 00:00` },
    { starts: `${dayAfter} 00:00`, ends: `${dayAfter} 00:30` },
  ]);
});

it('reads a day that ends at 24:00 back from the effective-hours route, weekly or overridden', async () => {
  const f = await fixture();
  const date = day(3);
  const route = async (query: { date: string }) =>
    calendarHours.parse(
      await manage(f, 'getCalendarAvailability', { params: { id: f.saved.calendar.id }, query }),
    );
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const saved = calendarConfiguration.parse(
    await manage(f, 'updateCalendarAvailability', {
      params: { id: f.saved.calendar.id },
      body: {
        members: [{ membershipId: f.membershipId, weight: 1 }],
        weeklyHours: [{ weekday, startTime: '00:00', endTime: '24:00' }],
        dateOverrides: [],
        revision: f.saved.revision,
      },
    }),
  );
  expect(await route({ date })).toMatchObject({
    source: 'weekly',
    ranges: [{ startTime: '00:00', endTime: '24:00' }],
  });
  // The whole day: 48 half hours, the last one ending as the next date starts.
  const { slots } = await handlers().slots(f.params, { date }, request());
  expect(slots).toHaveLength(48);
  expect(slots.at(-1)).toEqual({
    startsAt: `${date}T23:30:00Z`,
    endsAt: `${day(4)}T00:00:00Z`,
  });
  await manage(f, 'updateCalendarAvailability', {
    params: { id: f.saved.calendar.id },
    body: {
      members: [{ membershipId: f.membershipId, weight: 1 }],
      weeklyHours: [{ weekday, startTime: '00:00', endTime: '24:00' }],
      dateOverrides: [{ date, ranges: [{ startTime: '20:00', endTime: '24:00' }] }],
      revision: saved.revision,
    },
  });
  expect(await route({ date })).toMatchObject({
    source: 'override',
    ranges: [{ startTime: '20:00', endTime: '24:00' }],
  });
});

it('still refuses hours that start at 24:00 or run past it, and leaves the saved hours alone', async () => {
  const f = await fixture();
  // The route parses its body before it returns a promise, so a refusal may be thrown.
  const save = (startTime: string, endTime: string) =>
    Promise.resolve().then(() =>
      manage(f, 'updateCalendarAvailability', {
        params: { id: f.saved.calendar.id },
        body: {
          members: [{ membershipId: f.membershipId, weight: 1 }],
          weeklyHours: [{ weekday: 1, startTime, endTime }],
          dateOverrides: [],
          revision: f.saved.revision,
        },
      }),
    );
  for (const [startTime, endTime] of [
    ['23:00', '24:01'],
    ['23:00', '24:30'],
    ['23:00', '25:00'],
    ['24:00', '24:00'],
  ] as const)
    await expect(save(startTime, endTime)).rejects.toBeInstanceOf(ValidationError);
  const read = calendarConfiguration.parse(
    await manage(f, 'getCalendar', { params: { id: f.saved.calendar.id } }),
  );
  expect(read.revision).toBe(f.saved.revision);
});
