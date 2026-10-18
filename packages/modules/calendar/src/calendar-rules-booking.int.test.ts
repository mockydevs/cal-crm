// A calendar's own settings at the public booking page: what an appointment is called and
// where it is, how often slots start, a day's limit, slots held back to look busy, and
// whether the person who booked may still move or cancel. Real Postgres, through the
// handlers the public routes call.
import { randomUUID } from 'node:crypto';
import { ConflictError } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';
import { bookingFixtureSuite, request } from '../test/booking-fixtures.js';

const suite = bookingFixtureSuite();
const { fixture, handlers } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const dayFrom = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Sets columns of the fixture's one calendar. */
const configure = (f: Fixture, assignments: string, values: readonly unknown[] = []) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query(`update calendar.calendars set ${assignments}`, values),
  );
const book = (f: Fixture, startsAt: string, contact: Record<string, string> = {}) =>
  handlers().book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt,
      contact: { email: `${randomUUID()}@example.test`, ...contact },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
const starts = async (f: Fixture, date: string) =>
  (await handlers().slots(f.params, { date }, request())).slots.map((slot) => slot.startsAt);
const tokenOf = (booked: { managementUrl?: string | undefined }) => {
  const token = booked.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('The booking did not return its capability.');
  return token;
};

it("names the appointment from the calendar's invite title and gives it the host's meeting place", async () => {
  const f = await fixture();
  const date = dayFrom(1);
  await configure(f, `invite_title = $1`, ['Tour with {{contact.name}} ({{contact.email}})']);
  await database.withTenant(f.business.context, (sql) =>
    sql.query(`update calendar.calendar_members set locations = $1::jsonb`, [
      JSON.stringify([
        { kind: 'address', value: '12 Harbor Road', label: 'The venue' },
        { kind: 'phone', value: '+13055550123', label: null },
      ]),
    ]),
  );
  await book(f, `${date}T10:00:00Z`, {
    firstName: 'Maya',
    lastName: 'Okafor',
    email: 'maya@example.test',
  });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select title, location from calendar.appointments'),
    ),
  ).toEqual([{ title: 'Tour with Maya Okafor (maya@example.test)', location: '12 Harbor Road' }]);
});

it('starts slots as often as the interval says, each the length of the meeting', async () => {
  const f = await fixture();
  const date = dayFrom(1);
  const everyDuration = await starts(f, date);
  expect(everyDuration).toHaveLength(16);
  await configure(f, 'slot_interval_minutes = 15');
  const everyQuarter = await starts(f, date);
  // Thirty-minute meetings from every quarter hour: one more start between each pair.
  expect(everyQuarter).toHaveLength(31);
  expect(everyQuarter.filter((start) => everyDuration.includes(start))).toEqual(everyDuration);
  const gaps = everyQuarter
    .slice(1)
    .map((start, index) => Date.parse(start) - Date.parse(everyQuarter[index] ?? start));
  expect(new Set(gaps)).toEqual(new Set([900_000]));
  const { slots } = await handlers().slots(f.params, { date }, request());
  expect(
    slots.every((slot) => Date.parse(slot.endsAt) - Date.parse(slot.startsAt) === 1_800_000),
  ).toBe(true);
});

it('takes no more on a date than the calendar allows, and frees the date when one is cancelled', async () => {
  const f = await fixture();
  const date = dayFrom(1);
  const next = dayFrom(2);
  await configure(f, 'max_per_day = 2');
  const first = await book(f, `${date}T10:00:00Z`);
  expect(await starts(f, date)).toHaveLength(15);
  await book(f, `${date}T13:00:00Z`);
  // The date is full: nothing is offered, and a time someone still has open is refused.
  expect(await starts(f, date)).toEqual([]);
  await expect(book(f, `${date}T15:00:00Z`)).rejects.toBeInstanceOf(ConflictError);
  expect(await starts(f, next)).toHaveLength(16);
  const token = tokenOf(first);
  const managed = await handlers().appointment(token, request());
  await handlers().cancel(
    token,
    { operationRequestId: randomUUID(), revision: managed.revision },
    request(),
  );
  expect(await starts(f, date)).toHaveLength(15);
});

it('holds back the same slots from the public every time, and books only a slot it showed', async () => {
  const f = await fixture();
  const date = dayFrom(1);
  const all = await starts(f, date);
  await configure(f, 'look_busy_percent = 100');
  expect(await starts(f, date)).toEqual([]);
  await configure(f, 'look_busy_percent = 50');
  const shown = await starts(f, date);
  expect(shown).toEqual(await starts(f, date));
  expect(shown.length).toBeLessThan(all.length);
  expect(shown.every((start) => all.includes(start))).toBe(true);
  const hidden = all.find((start) => !shown.includes(start));
  if (hidden === undefined) throw new Error('Half of sixteen slots held back leaves none hidden.');
  await expect(book(f, hidden)).rejects.toBeInstanceOf(ConflictError);
  const [open] = shown;
  if (open !== undefined) await book(f, open);
  await configure(f, 'look_busy_percent = 0');
  expect(await starts(f, date)).toHaveLength(open === undefined ? 16 : 15);
});

it('refuses a cancellation the calendar does not allow, or allows no longer', async () => {
  const f = await fixture();
  const date = dayFrom(3);
  const token = tokenOf(await book(f, `${date}T10:00:00Z`));
  const cancel = async () => {
    const managed = await handlers().appointment(token, request());
    return handlers().cancel(
      token,
      { operationRequestId: randomUUID(), revision: managed.revision },
      request(),
    );
  };
  await configure(f, 'allow_cancel = false');
  await expect(cancel()).rejects.toThrow(
    "This appointment can't be cancelled online. Contact the business instead.",
  );
  // Allowed again, but only until a week before: three days out is too late.
  await configure(f, 'allow_cancel = true, cancel_cutoff_minutes = 10080');
  await expect(cancel()).rejects.toThrow(/can no longer be cancelled online.*7 days before it/);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select status from calendar.appointments'),
    ),
  ).toEqual([{ status: 'booked' }]);
  // Until a day before: three days out is in time.
  await configure(f, 'cancel_cutoff_minutes = 1440');
  expect(await cancel()).toMatchObject({ status: 'cancelled' });
});

it('refuses a move the calendar does not allow, or allows no longer, and offers no times for it', async () => {
  const f = await fixture();
  const date = dayFrom(3);
  const token = tokenOf(await book(f, `${date}T10:00:00Z`));
  const move = async () => {
    const managed = await handlers().appointment(token, request());
    return handlers().reschedule(
      token,
      {
        operationRequestId: randomUUID(),
        revision: managed.revision,
        startsAt: `${date}T11:00:00Z`,
      },
      request(),
    );
  };
  await configure(f, 'allow_reschedule = false');
  await expect(move()).rejects.toThrow(
    "This appointment can't be rescheduled online. Contact the business instead.",
  );
  await expect(handlers().appointmentSlots(token, { date }, request())).rejects.toBeInstanceOf(
    ConflictError,
  );
  await configure(f, 'allow_reschedule = true, reschedule_cutoff_minutes = 10080');
  await expect(move()).rejects.toThrow(/can no longer be rescheduled online/);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query<{ starts_at: Date }>('select starts_at from calendar.appointments'),
    ),
  ).toEqual([{ starts_at: new Date(`${date}T10:00:00Z`) }]);
  await configure(f, 'reschedule_cutoff_minutes = 60');
  expect(await move()).toMatchObject({ status: 'booked', startsAt: `${date}T11:00:00.000Z` });
});
