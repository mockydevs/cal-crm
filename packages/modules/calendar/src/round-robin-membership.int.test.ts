// A round-robin calendar carries on with whoever is still on the team (migration 0048). A
// member who leaves the business or is disabled is neither offered nor assigned; the
// calendar stops taking bookings only when nobody is left.
import { randomUUID } from 'node:crypto';
import { calendarConfiguration, calendarList } from '@repo/contracts';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { intakeContact } from '@repo/module-crm';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';
import { bookingFixtureSuite, request } from '../test/booking-fixtures.js';

const suite = bookingFixtureSuite();
const { fixture, handlers, manage } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const booking = (date: string, time: string) => ({
  bookingRequestId: randomUUID(),
  startsAt: `${date}T${time}:00Z`,
  contact: { email: `guest-${randomUUID()}@example.test` },
  notificationConsent: true as const,
  contactTimezone: 'UTC',
});
const settled = <T>(attempt: Promise<T>) =>
  attempt.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
/** Whether a session of this database waits for a lock in a statement like the one given. */
const untilWaiting = (statement: string) =>
  expect
    .poll(
      () =>
        // Another role's wait events are hidden from crm_app, so the superuser watches.
        database.as('postgres', async (sql) => {
          const row = await sql.one<{ waiting: boolean }>(
            "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike $1) as waiting",
            [statement],
          );
          return row.waiting;
        }),
      { timeout: 10_000, interval: 50 },
    )
    .toBe(true);

/** The fixture's calendar as a round robin of its host and one more member of the team. */
async function team() {
  const f = await fixture();
  const second = await database.fixtures.user();
  const secondMembershipId = await database.withTenant(f.business.context, async (sql) => {
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
  const hosts = () =>
    database.withTenant(f.business.context, (sql) =>
      sql.query<{ time: string; host: string; status: string }>(
        "select to_char(starts_at at time zone 'UTC','HH24:MI') as time,assigned_user_id as host,status from calendar.appointments order by starts_at",
      ),
    );
  const read = async () =>
    calendarConfiguration.parse(
      await manage(f, 'getCalendar', { params: { id: f.saved.calendar.id } }),
    );
  return { ...f, second, secondMembershipId, hosts, read };
}
const remove = (membershipId: string) =>
  database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where id=$1', [
      parsePublicId('membership', membershipId),
    ]),
  );

it('offers and assigns only the members still on the team, and stops when nobody is left', async () => {
  const f = await team();
  const api = handlers();
  const date = tomorrow();
  await remove(f.membershipId);

  // The page, its slots and a booking all still answer, with the member who stayed.
  expect((await api.calendar(f.params, request())).name).toBe('Venue tour');
  expect((await api.slots(f.params, { date }, request())).slots).toHaveLength(16);
  await api.book(f.params, booking(date, '10:00'), request());
  expect(await f.hosts()).toEqual([{ time: '10:00', host: f.second.id, status: 'booked' }]);
  // The one host is now busy at 10:00. Were the member who left still counted, the slot
  // would be offered and a second booking handed to them.
  expect(
    (await api.slots(f.params, { date }, request())).slots.map((slot) =>
      slot.startsAt.slice(11, 16),
    ),
  ).not.toContain('10:00');
  await expect(api.book(f.params, booking(date, '10:00'), request())).rejects.toBeInstanceOf(
    ConflictError,
  );

  // The team sees the truth: still bookable, with one member who is no longer on it.
  const current = await f.read();
  expect(current.calendar).toMatchObject({ kind: 'round_robin', isActive: true, bookable: true });
  expect(current.members.map((member) => member.membershipId).sort()).toEqual(
    [null, f.secondMembershipId].sort(),
  );
  const listed = calendarList.parse(await manage(f, 'listCalendars', {}));
  expect(listed.items.map((item) => item.bookable)).toEqual([true]);

  // Settings can still be saved while the calendar stays active.
  const renamed = calendarConfiguration.parse(
    await manage(f, 'updateCalendar', {
      params: { id: current.calendar.id },
      body: {
        name: 'Team tour',
        description: current.calendar.description,
        kind: 'round_robin',
        timezone: 'UTC',
        bookingSlug: 'venue-tour',
        confirmationSenderId: current.calendar.confirmationSenderId,
        minNoticeMinutes: 0,
        isActive: true,
        revision: current.revision,
      },
    }),
  );
  expect(renamed.calendar).toMatchObject({ name: 'Team tour', isActive: true, bookable: true });

  // The last member is disabled: nobody can take a booking, and nothing says who was there.
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=now() where id=$1', [f.second.id]),
  );
  await expect(api.calendar(f.params, request())).rejects.toBeInstanceOf(NotFoundError);
  await expect(api.slots(f.params, { date }, request())).rejects.toBeInstanceOf(NotFoundError);
  await expect(api.book(f.params, booking(date, '11:00'), request())).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect((await f.read()).calendar.bookable).toBe(false);
  expect(await f.hosts()).toHaveLength(1);
});

it('keeps the appointment of a host who left cancellable, and offers no time with someone else', async () => {
  const f = await team();
  const api = handlers();
  const date = tomorrow();
  const receipt = await api.book(f.params, booking(date, '10:00'), request());
  const token = receipt.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('The booking returned no management link.');
  const [booked] = await f.hosts();
  if (booked === undefined) throw new Error('The booking has no host.');
  await remove(booked.host === f.user.id ? f.membershipId : f.secondMembershipId);

  // A reschedule keeps its host. With the host gone there is no time to move to.
  expect(await api.appointmentSlots(token, { date }, request())).toEqual({ slots: [] });
  const page = await api.appointment(token, request());
  await expect(
    api.reschedule(
      token,
      { operationRequestId: randomUUID(), revision: page.revision, startsAt: `${date}T15:00:00Z` },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await f.hosts()).toEqual([{ time: '10:00', host: booked.host, status: 'booked' }]);
  const cancelled = await api.cancel(
    token,
    { operationRequestId: randomUUID(), revision: page.revision },
    request(),
  );
  expect(cancelled.status).toBe('cancelled');
});

it('makes a booking wait for one removal in flight and then books the member who stayed', async () => {
  const f = await team();
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
  // Until the removal commits both members read as present; the booking waits on the
  // membership it must hold, sees it gone, and carries on with the other.
  const attempt = settled(handlers().book(f.params, booking(date, '10:00'), request()));
  try {
    await untilWaiting('%tenancy%memberships%for share%');
    expect(await f.hosts()).toEqual([]);
  } finally {
    proceed.resolve(undefined);
  }
  const [removed, result] = await Promise.all([removing, attempt]);
  if (!removed.ok) throw removed.error;
  if (!result.ok) throw result.error;
  expect(await f.hosts()).toEqual([{ time: '10:00', host: f.second.id, status: 'booked' }]);
});

it('makes a removal wait for a booking in flight, and the next booking goes to the member who stayed', async () => {
  const f = await team();
  const date = tomorrow();
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  // The booking stops after it has held its hosts, before it writes anything.
  const api = handlers(async (trx, input, command) => {
    ready.resolve(undefined);
    await proceed.promise;
    return intakeContact(trx, input, command);
  });
  const attempt = settled(api.book(f.params, booking(date, '10:00'), request()));
  await ready.promise;
  const removing = settled(remove(f.membershipId));
  try {
    await untilWaiting('%delete from tenancy.memberships%');
  } finally {
    proceed.resolve(undefined);
  }
  const [result, removed] = await Promise.all([attempt, removing]);
  if (!result.ok) throw result.error;
  if (!removed.ok) throw removed.error;
  const [first] = await f.hosts();
  expect(first).toMatchObject({ time: '10:00', status: 'booked' });
  // Whoever took the first one, every later booking goes to the member still on the team.
  await handlers().book(f.params, booking(date, '11:00'), request());
  await handlers().book(f.params, booking(date, '12:00'), request());
  expect((await f.hosts()).slice(1)).toEqual([
    { time: '11:00', host: f.second.id, status: 'booked' },
    { time: '12:00', host: f.second.id, status: 'booked' },
  ]);
});
