// The numbers of the Dashboard's booking widgets, counted from real appointments with fixed
// dates and held against a recount by hand, as crm_app under row-level security, with
// tenancy's own team port and auth's own people names. The rules that turn the counts into
// the answer are appointment-report-rules.test.ts.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  APPOINTMENT_REPORT_UPCOMING_DAYS,
  appointmentReport,
  appointmentStatuses,
  OPPORTUNITY_REPORT_MAX_DAYS,
  type AppointmentReport,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId, ValidationError, type TenantContext } from '@repo/kernel';
import { findTimeZone, lockBookingContact, readContactNames } from '@repo/module-crm';
import {
  queueCalendarConfirmation,
  readCalendarConfirmationRecipient,
  readCalendarSenderChoices,
  readEligibleCalendarSenders,
  resolveCalendarSender,
} from '@repo/module-messaging';
import {
  lockActiveBusiness,
  readCalendarMemberMemberships,
  resolveCalendarMember,
} from '@repo/module-tenancy';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createAppointmentRoutes } from './index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let routes: readonly ApiRoute[];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  const members = { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships };
  routes = createAppointmentRoutes({
    calendars: {
      business: { lockActive: lockActiveBusiness },
      timeZones: { find: findTimeZone },
      members,
      senders: {
        resolve: resolveCalendarSender,
        choices: readCalendarSenderChoices,
        eligible: readEligibleCalendarSenders,
      },
    },
    members,
    contacts: { names: readContactNames, lock: lockBookingContact },
    notifications: {
      queue: queueCalendarConfirmation,
      recipient: readCalendarConfirmationRecipient,
    },
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
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

interface Person {
  readonly userId: string;
  readonly membershipId: string;
}
type Status = (typeof appointmentStatuses)[number];
const HOUR = 3_600_000;
const later = (start: string, hours = 1) =>
  new Date(Date.parse(start) + hours * HOUR).toISOString();
const fromNow = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

/** A business in Nairobi (three hours ahead of UTC, all year), with a contact to book. */
async function nairobi() {
  const agency = (await database.fixtures.agency()).id;
  const business = await database.fixtures.business(agency);
  await database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set timezone = 'Africa/Nairobi' where id = $1`, [
      business.id,
    ]),
  );
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name)
       values ($1, 'business', $2, 'Team') returning id`,
      [agency, `team_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  const memberships = new Map<string, string>();
  const person = async (name: string): Promise<Person> => {
    const user = await database.fixtures.user({ name });
    const membership = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
         values ($1, $2, $3, $4) returning id`,
        [agency, business.id, user.id, role.id],
      ),
    );
    memberships.set(user.id, membership.id);
    return { userId: user.id, membershipId: toPublicId('membership', membership.id) };
  };
  const leave = (who: Person) =>
    database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.memberships where id = $1', [memberships.get(who.userId)]),
    );
  const query = <Row extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(context, (sql) => sql.query<Row>(text, values));
  const calendar = async (name: string) => {
    const [made] = await query<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
       values (app.business_id(), $1, 'round_robin', 'Africa/Nairobi', $2) returning id`,
      [name, `cal-${randomUUID().slice(0, 8)}`],
    );
    if (made === undefined) throw new Error('No calendar.');
    return { id: made.id, publicId: toPublicId('calendar', made.id), name };
  };
  const contact = await database.fixtures.contact(context, {
    firstName: 'Amina',
    email: `${randomUUID().slice(0, 8)}@example.test`,
  });
  /** An hour's appointment, written with its dates as an import of history would write it. */
  const book = async (
    on: { id: string },
    startsAt: string,
    values: { assignee?: Person; status?: Status; createdAt?: string } = {},
  ) => {
    const status = values.status ?? 'booked';
    await query(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at,
          status, cancelled_at, source, created_at)
       values (app.business_id(), $1, $2, $3, 'Site visit', $4, $5, $6, $7, 'user',
               coalesce($8::timestamptz, now()))`,
      [
        on.id,
        contact.id,
        values.assignee?.userId ?? null,
        startsAt,
        later(startsAt),
        status,
        status === 'cancelled' ? startsAt : null,
        values.createdAt ?? null,
      ],
    );
  };
  /** Someone on the team with no permission at all, or the system. */
  const as = (who?: Person): Invocation => ({
    context: {
      ...context,
      correlationId: randomUUID(),
      ...(who === undefined
        ? { actorKind: 'system' as const }
        : { actorKind: 'user' as const, userId: who.userId, actorId: who.userId }),
    },
    permissions: new Set(),
  });
  return { business, person, leave, calendar, book, as };
}

async function report(
  invocation: Invocation,
  query: Record<string, string>,
): Promise<AppointmentReport> {
  const route = routes.find((each) => each.endpoint.operationId === 'getAppointmentReport');
  if (route === undefined) throw new Error('Missing getAppointmentReport');
  // Async, so a refusal of the query itself rejects like any other.
  return appointmentReport.parse(
    await route.run({ invocation, params: {}, query, body: undefined }, services),
  );
}

/** March 2026 as Nairobi has it: from its first midnight to the one that ends it. */
const MARCH = { from: '2026-02-28T21:00:00Z', to: '2026-03-31T21:00:00Z' };
const BOOKED_IN_FEBRUARY = '2026-02-01T08:00:00Z';
/** Every status in the contract's order, with the counts given and zero for the rest. */
const statuses = (counts: Partial<Record<Status, number>> = {}) =>
  appointmentStatuses.map((status) => ({ status, count: counts[status] ?? 0 }));

/** Seven appointments that start in March as Nairobi has it, and two that do not. */
async function march() {
  const t = await nairobi();
  const [visits, calls] = [await t.calendar('Visits'), await t.calendar('Calls')];
  const [ada, ben] = [await t.person('Ada Owner'), await t.person('Ben Staff')];
  const old = { createdAt: BOOKED_IN_FEBRUARY };
  await t.book(visits, '2026-03-05T08:00:00Z', {
    assignee: ada,
    createdAt: '2026-03-20T08:00:00Z',
  });
  await t.book(visits, '2026-03-05T10:00:00Z', { ...old, assignee: ada, status: 'confirmed' });
  // Half past midnight on the 6th in Nairobi.
  await t.book(visits, '2026-03-05T21:30:00Z', { ...old, assignee: ben, status: 'completed' });
  await t.book(calls, '2026-03-10T08:00:00Z', { ...old, assignee: ben, status: 'no_show' });
  await t.book(calls, '2026-03-10T10:00:00Z', { ...old, status: 'cancelled' });
  await t.book(calls, '2026-03-12T08:00:00Z', { ...old, status: 'invalid' });
  // The first instant of the range is in it.
  await t.book(visits, MARCH.from, { ...old, assignee: ada, status: 'completed' });
  // The hour before the range, and the instant that ends it.
  await t.book(visits, '2026-02-28T20:00:00Z', old);
  await t.book(visits, MARCH.to, old);
  return { ...t, visits, calls, ada, ben };
}

describe('the booking numbers of a business over a range', () => {
  it('equal a recount by hand of the appointments that start in the range, by day in the business time zone', async () => {
    const t = await march();
    const answer = await report(t.as(t.ada), MARCH);
    expect(answer).toMatchObject({
      ...MARCH,
      timeZone: 'Africa/Nairobi',
      dateProperty: 'starts',
      count: 7,
      statuses: statuses({
        booked: 1,
        confirmed: 1,
        cancelled: 1,
        no_show: 1,
        completed: 2,
        invalid: 1,
      }),
    });
    // Every day of March, in order, and nothing else.
    expect(answer.days).toHaveLength(31);
    expect(answer.days[0]?.date).toBe('2026-03-01');
    expect(answer.days.at(-1)?.date).toBe('2026-03-31');
    const busy: Record<string, Partial<Record<Status, number>>> = {
      '2026-03-01': { completed: 1 },
      '2026-03-05': { booked: 1, confirmed: 1 },
      '2026-03-06': { completed: 1 },
      '2026-03-10': { no_show: 1, cancelled: 1 },
      '2026-03-12': { invalid: 1 },
    };
    for (const day of answer.days) {
      const counts = busy[day.date] ?? {};
      expect(day, day.date).toEqual({
        date: day.date,
        count: Object.values(counts).reduce((total, each) => total + each, 0),
        statuses: statuses(counts),
      });
    }
    expect(answer.calendars).toEqual([
      {
        calendar: { id: t.visits.publicId, name: 'Visits' },
        count: 4,
        statuses: statuses({ booked: 1, confirmed: 1, completed: 2 }),
      },
      {
        calendar: { id: t.calls.publicId, name: 'Calls' },
        count: 3,
        statuses: statuses({ no_show: 1, cancelled: 1, invalid: 1 }),
      },
    ]);
    expect(answer.teamMembers).toEqual([
      {
        assignee: { membershipId: t.ada.membershipId, name: 'Ada Owner' },
        count: 3,
        statuses: statuses({ booked: 1, confirmed: 1, completed: 1 }),
      },
      {
        assignee: { membershipId: t.ben.membershipId, name: 'Ben Staff' },
        count: 2,
        statuses: statuses({ completed: 1, no_show: 1 }),
      },
      { assignee: null, count: 2, statuses: statuses({ cancelled: 1, invalid: 1 }) },
    ]);
  });

  it('counts by when an appointment was booked when asked to', async () => {
    const t = await march();
    const answer = await report(t.as(t.ada), { ...MARCH, dateProperty: 'created' });
    expect(answer.dateProperty).toBe('created');
    expect(answer.count).toBe(1);
    expect(answer.statuses).toEqual(statuses({ booked: 1 }));
    expect(answer.days.filter((day) => day.count > 0).map((day) => day.date)).toEqual([
      '2026-03-20',
    ]);
    expect(answer.calendars.map((each) => [each.calendar.name, each.count])).toEqual([
      ['Visits', 1],
    ]);
    // All nine were booked in February or March.
    const both = await report(t.as(t.ada), {
      from: '2026-01-31T21:00:00Z',
      to: MARCH.to,
      dateProperty: 'created',
    });
    expect(both.count).toBe(9);
  });

  it('keeps the appointments of someone who left the team, without a name or a membership', async () => {
    const t = await march();
    await t.leave(t.ben);
    const answer = await report(t.as(t.ada), MARCH);
    expect(answer.teamMembers.map((each) => [each.assignee, each.count])).toEqual([
      [{ membershipId: t.ada.membershipId, name: 'Ada Owner' }, 3],
      [{ membershipId: null, name: '' }, 2],
      [null, 2],
    ]);
  });

  it('answers zeros for every day of a business with no appointments, and part days at the ends of a range that is not cut at its midnights', async () => {
    const t = await nairobi();
    const answer = await report(t.as(), {
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-03T00:00:00Z',
    });
    // 03:00 on the 1st to 03:00 on the 3rd in Nairobi.
    expect(answer.days).toEqual(
      ['2026-03-01', '2026-03-02', '2026-03-03'].map((date) => ({
        date,
        count: 0,
        statuses: statuses(),
      })),
    );
    expect(answer).toMatchObject({ count: 0, calendars: [], teamMembers: [] });
    expect(answer.upcoming.count).toBe(0);
  });

  it('counts only the business of the request', async () => {
    const mine = await nairobi();
    const theirs = await march();
    await mine.book(await mine.calendar('Mine'), '2026-03-06T08:00:00Z');
    const answer = await report(mine.as(), MARCH);
    expect(answer.count).toBe(1);
    expect(answer.calendars.map((each) => each.calendar.name)).toEqual(['Mine']);
    expect(JSON.stringify(answer)).not.toContain(theirs.visits.publicId);
    expect(JSON.stringify(answer)).not.toContain(theirs.ada.membershipId);
  });
});

describe('what is coming up', () => {
  it('is the booked and confirmed appointments that start in the next seven days, whatever range is asked for', async () => {
    const t = await nairobi();
    const cal = await t.calendar('Visits');
    await t.book(cal, fromNow(24));
    await t.book(cal, fromNow(48), { status: 'confirmed' });
    // Not coming up: cancelled; marked already; started; and more than a week away.
    await t.book(cal, fromNow(72), { status: 'cancelled' });
    await t.book(cal, fromNow(96), { status: 'invalid' });
    await t.book(cal, fromNow(-2));
    await t.book(cal, fromNow(24 * APPOINTMENT_REPORT_UPCOMING_DAYS + 2));

    const before = Date.now();
    const { upcoming, count } = await report(t.as(), MARCH);
    expect(count).toBe(0);
    expect(upcoming.count).toBe(2);
    expect(Date.parse(upcoming.to) - Date.parse(upcoming.from)).toBe(
      APPOINTMENT_REPORT_UPCOMING_DAYS * 24 * HOUR,
    );
    // The database's clock, at the read: within a minute of this machine's.
    expect(Math.abs(Date.parse(upcoming.from) - before)).toBeLessThan(60_000);
  });
});

describe('asking for the booking numbers', () => {
  it('refuses a range that is missing, backwards or longer than the opportunity numbers allow', async () => {
    const t = await nairobi();
    for (const query of [
      {},
      { from: MARCH.from },
      { from: MARCH.to, to: MARCH.from },
      { from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00.001Z' },
      { ...MARCH, dateProperty: 'ends' },
      { ...MARCH, calendar: 'x' },
    ])
      await expect(report(t.as(), query), JSON.stringify(query)).rejects.toBeInstanceOf(
        ValidationError,
      );
    // The longest range allowed is answered, with a row for each of its days.
    const longest = await report(t.as(), {
      from: '2024-01-01T00:00:00Z',
      to: '2027-01-01T00:00:00Z',
    });
    expect(longest.days).toHaveLength(OPPORTUNITY_REPORT_MAX_DAYS + 1);
  });

  it('is read from the indexes on the business and each date', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where schemaname = 'calendar' and indexname = any($1::text[]) order by indexname`,
        [['appointments_window_idx', 'appointments_created_idx']],
      ),
    );
    expect(rows.map((row) => row.indexdef)).toEqual([
      expect.stringContaining('(business_id, created_at, id)'),
      expect.stringContaining('(business_id, starts_at)'),
    ]);
  });
});
