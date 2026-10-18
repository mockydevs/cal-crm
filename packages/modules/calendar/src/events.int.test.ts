// What is on the calendar between two instants: appointments and blocked slots, narrowed by
// the Manage view's filters. Real Postgres as crm_app under row-level security, with
// tenancy's own team port and the CRM's own contact names.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  CALENDAR_EVENTS_LIMIT,
  CALENDAR_EVENTS_MAX_DAYS,
  calendarEvents,
  type CalendarEvents,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId, ValidationError, type TenantContext } from '@repo/kernel';
import { readContactNames } from '@repo/module-crm';
import { readCalendarMemberMemberships, resolveCalendarMember } from '@repo/module-tenancy';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { readTestNames } from '../test/people.js';
import { createCalendarEventRoutes } from './events.js';

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
  routes = createCalendarEventRoutes({
    members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
    contacts: { names: readContactNames },
    people: { names: readTestNames },
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
/** A business, with a way to add people to its team, calendars, bookings and absences. */
async function team(agencyId?: string) {
  const agency = agencyId ?? (await database.fixtures.agency()).id;
  const business = await database.fixtures.business(agency);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name)
       values ($1, 'business', $2, 'Team') returning id`,
      [agency, `team_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  const person = async (name: string): Promise<Person> => {
    const user = await database.fixtures.user({ name });
    const membership = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
         values ($1, $2, $3, $4) returning id`,
        [agency, business.id, user.id, role.id],
      ),
    );
    return { userId: user.id, membershipId: toPublicId('membership', membership.id) };
  };
  const query = <Row extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(context, (sql) => sql.query<Row>(text, values));
  const calendar = async (name: string, members: readonly Person[] = []) => {
    const [made] = await query<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
       values (app.business_id(), $1, 'round_robin', 'Africa/Nairobi', $2) returning id`,
      [name, `cal-${randomUUID().slice(0, 8)}`],
    );
    if (made === undefined) throw new Error('No calendar.');
    for (const member of members)
      await query(
        `insert into calendar.calendar_members (business_id, calendar_id, user_id)
         values (app.business_id(), $1, $2)`,
        [made.id, member.userId],
      );
    return { id: made.id, publicId: toPublicId('calendar', made.id), name };
  };
  const contact = (firstName: string) =>
    database.fixtures.contact(context, {
      firstName,
      email: `${randomUUID().slice(0, 8)}@example.test`,
    });
  const book = async (
    on: { id: string },
    who: { id: string },
    startsAt: string,
    endsAt: string,
    values: { assignee?: Person; title?: string; status?: string } = {},
  ) => {
    const cancelled = values.status === 'cancelled';
    const [made] = await query<{ id: string }>(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at,
          status, cancelled_at, source)
       values (app.business_id(), $1, $2, $3, $4, $5, $6, $7, $8, 'user') returning id`,
      [
        on.id,
        who.id,
        values.assignee?.userId ?? null,
        values.title ?? 'Site visit',
        startsAt,
        endsAt,
        values.status ?? 'booked',
        cancelled ? startsAt : null,
      ],
    );
    return toPublicId('appointment', made?.id ?? '');
  };
  /** A blocked slot: of a person on every calendar, or limited to one calendar. */
  const away = async (
    who: Person | null,
    startsAt: string,
    endsAt: string,
    title = '',
    on?: { id: string },
  ) => {
    const [made] = await query<{ id: string }>(
      `insert into calendar.blocked_slots (business_id, user_id, calendar_id, starts_at, ends_at, title)
       values (app.business_id(), $1, $2, $3, $4, $5) returning id`,
      [who?.userId ?? null, on?.id ?? null, startsAt, endsAt, title],
    );
    return toPublicId('blocked_slot', made?.id ?? '');
  };
  /** Someone on the team reading the calendar: with or without the right to manage it. */
  const as = (who?: Person, manage = false): Invocation => ({
    context: {
      ...context,
      correlationId: randomUUID(),
      ...(who === undefined
        ? { actorKind: 'system' as const }
        : { actorKind: 'user' as const, userId: who.userId, actorId: who.userId }),
    },
    permissions: new Set(manage ? ['calendars.manage'] : []),
  });
  return { agency, business, context, person, calendar, contact, book, away, as, query };
}

async function read(
  invocation: Invocation,
  query: Record<string, string>,
): Promise<CalendarEvents> {
  const route = routes.find((each) => each.endpoint.operationId === 'listCalendarEvents');
  if (route === undefined) throw new Error('Missing listCalendarEvents');
  // Async, so a refusal of the query itself rejects like any other.
  const answer: unknown = await Promise.resolve().then(() =>
    route.run({ invocation, params: {}, query, body: undefined }, services),
  );
  return calendarEvents.parse(answer);
}
/** A week of November 2026, in UTC. */
const WEEK = { from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z' };
const titles = (answer: CalendarEvents) =>
  answer.items.map((item) =>
    item.kind === 'appointment' ? item.title : `blocked ${item.startsAt}`,
  );

describe('the calendar between two instants', () => {
  it('lists the appointments and blocked slots that overlap the window, by start time', async () => {
    const t = await team();
    const dana = await t.person('Dana Brooks');
    const jordan = await t.person('Jordan Lee');
    const visits = await t.calendar('Site visits', [dana, jordan]);
    const maya = await t.contact('Maya');

    const before = await t.book(visits, maya, '2026-11-01T22:00:00Z', '2026-11-01T23:00:00Z');
    // Overlaps the start: it began before the window and ends inside it.
    const across = await t.book(visits, maya, '2026-11-01T23:30:00Z', '2026-11-02T00:30:00Z', {
      assignee: dana,
      title: 'Across the start',
    });
    const inside = await t.book(visits, maya, '2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z', {
      assignee: jordan,
      title: 'Inside',
    });
    // Ends exactly where the window starts, and starts exactly where it ends: neither overlaps.
    await t.book(visits, maya, '2026-11-01T23:00:00Z', '2026-11-02T00:00:00Z', {
      title: 'Touches the start',
    });
    await t.book(visits, maya, '2026-11-09T00:00:00Z', '2026-11-09T01:00:00Z', {
      title: 'Touches the end',
    });
    const cancelled = await t.book(visits, maya, '2026-11-05T09:00:00Z', '2026-11-05T10:00:00Z', {
      title: 'Cancelled',
      status: 'cancelled',
    });
    // Leave that began long before the window and runs into it, to the microsecond.
    const leave = await t.away(
      dana,
      '2026-08-01T06:00:00.000001Z',
      '2026-11-03T15:00:00.000002Z',
      'Family leave',
    );
    const dentist = await t.away(
      jordan,
      '2026-11-06T06:00:00Z',
      '2026-11-06T09:00:00Z',
      'Dentist',
      visits,
    );
    await t.away(jordan, '2026-10-01T06:00:00Z', '2026-10-02T06:00:00Z', 'Long over');
    // The whole calendar, for everyone on it.
    const closed = await t.away(
      null,
      '2026-11-07T00:00:00Z',
      '2026-11-08T00:00:00Z',
      'Stocktake',
      visits,
    );

    const answer = await read(t.as(dana, true), WEEK);
    expect(answer.truncated).toBe(false);
    expect(answer.canManage).toBe(true);
    expect(answer.items).toEqual([
      {
        kind: 'blocked',
        id: leave,
        startsAt: '2026-08-01T06:00:00.000001Z',
        endsAt: '2026-11-03T15:00:00.000002Z',
        user: { membershipId: dana.membershipId, you: true, name: 'Dana Brooks' },
        calendar: null,
        title: 'Family leave',
      },
      {
        kind: 'appointment',
        id: across,
        title: 'Across the start',
        startsAt: '2026-11-01T23:30:00.000Z',
        endsAt: '2026-11-02T00:30:00.000Z',
        status: 'booked',
        calendar: { id: visits.publicId, name: 'Site visits' },
        contact: { id: toPublicId('contact', maya.id), name: 'Maya', trashed: false },
        assignee: { membershipId: dana.membershipId, you: true, name: 'Dana Brooks' },
      },
      expect.objectContaining({
        id: inside,
        assignee: { membershipId: jordan.membershipId, you: false, name: 'Jordan Lee' },
      }),
      expect.objectContaining({ id: cancelled, status: 'cancelled', assignee: null }),
      {
        kind: 'blocked',
        id: dentist,
        startsAt: '2026-11-06T06:00:00.000000Z',
        endsAt: '2026-11-06T09:00:00.000000Z',
        user: { membershipId: jordan.membershipId, you: false, name: 'Jordan Lee' },
        calendar: { id: visits.publicId, name: 'Site visits' },
        title: 'Dentist',
      },
      {
        kind: 'blocked',
        id: closed,
        startsAt: '2026-11-07T00:00:00.000000Z',
        endsAt: '2026-11-08T00:00:00.000000Z',
        user: null,
        calendar: { id: visits.publicId, name: 'Site visits' },
        title: 'Stocktake',
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(before);
  });

  it('keeps one kind when asked, and the people and calendars the Manage view names', async () => {
    const t = await team();
    const dana = await t.person('Dana Brooks');
    const jordan = await t.person('Jordan Lee');
    const amara = await t.person('Amara Okafor');
    const visits = await t.calendar('Site visits', [dana, jordan]);
    const calls = await t.calendar('Calls', [amara]);
    const maya = await t.contact('Maya');
    const at = (day: number) =>
      [`2026-11-0${String(day)}T09:00:00Z`, `2026-11-0${String(day)}T10:00:00Z`] as const;
    await t.book(visits, maya, ...at(2), { assignee: dana, title: 'Visit, Dana' });
    await t.book(visits, maya, ...at(3), { assignee: jordan, title: 'Visit, Jordan' });
    await t.book(calls, maya, ...at(4), { assignee: amara, title: 'Call, Amara' });
    await t.book(calls, maya, ...at(5), { title: 'Call, nobody yet' });
    await t.away(dana, '2026-11-06T06:00:00Z', '2026-11-06T09:00:00Z');
    await t.away(amara, '2026-11-07T06:00:00Z', '2026-11-07T09:00:00Z');
    // Dana on Site visits only, and the whole Calls calendar.
    await t.away(dana, '2026-11-08T06:00:00Z', '2026-11-08T09:00:00Z', '', visits);
    await t.away(null, '2026-11-08T12:00:00Z', '2026-11-08T13:00:00Z', '', calls);
    const me = t.as(dana);
    const shown = async (filters: Record<string, string>) =>
      titles(await read(me, { ...WEEK, ...filters }));
    const danaAway = 'blocked 2026-11-06T06:00:00.000000Z';
    const amaraAway = 'blocked 2026-11-07T06:00:00.000000Z';
    const danaOnVisits = 'blocked 2026-11-08T06:00:00.000000Z';
    const callsClosed = 'blocked 2026-11-08T12:00:00.000000Z';

    expect(await shown({})).toEqual([
      'Visit, Dana',
      'Visit, Jordan',
      'Call, Amara',
      'Call, nobody yet',
      danaAway,
      amaraAway,
      danaOnVisits,
      callsClosed,
    ]);
    expect(await shown({ type: 'all' })).toHaveLength(8);
    expect(await shown({ type: 'appointments' })).toEqual([
      'Visit, Dana',
      'Visit, Jordan',
      'Call, Amara',
      'Call, nobody yet',
    ]);
    expect(await shown({ type: 'blocked' })).toEqual([
      danaAway,
      amaraAway,
      danaOnVisits,
      callsClosed,
    ]);

    // People: what is assigned to them, and their own blocked slots (on one calendar too).
    expect(await shown({ users: dana.membershipId })).toEqual([
      'Visit, Dana',
      danaAway,
      danaOnVisits,
    ]);
    expect(await shown({ users: `${amara.membershipId},${dana.membershipId}` })).toEqual([
      'Visit, Dana',
      'Call, Amara',
      danaAway,
      amaraAway,
      danaOnVisits,
    ]);
    expect(await shown({ users: jordan.membershipId, type: 'blocked' })).toEqual([]);

    // Calendars: their appointments, their own blocks, and the blocks of the people who
    // serve them that cover every calendar.
    expect(await shown({ calendars: calls.publicId })).toEqual([
      'Call, Amara',
      'Call, nobody yet',
      amaraAway,
      callsClosed,
    ]);
    expect(await shown({ calendars: visits.publicId })).toEqual([
      'Visit, Dana',
      'Visit, Jordan',
      danaAway,
      danaOnVisits,
    ]);
    expect(await shown({ calendars: `${visits.publicId},${calls.publicId}` })).toHaveLength(8);
    // Both: both must hold.
    expect(await shown({ calendars: visits.publicId, users: dana.membershipId })).toEqual([
      'Visit, Dana',
      danaAway,
      danaOnVisits,
    ]);
    expect(await shown({ calendars: calls.publicId, users: dana.membershipId })).toEqual([]);
  });

  it('shows the title of blocked time only to someone who may manage calendars', async () => {
    const t = await team();
    const dana = await t.person('Dana Brooks');
    await t.away(dana, '2026-11-06T06:00:00Z', '2026-11-06T09:00:00Z', 'Medical appointment');
    const forManager = await read(t.as(undefined, true), WEEK);
    expect(forManager.items).toMatchObject([{ kind: 'blocked', title: 'Medical appointment' }]);
    // Not even to the person themself without that right: the blocked slot's own read asks it.
    const forMember = await read(t.as(dana), WEEK);
    expect(forMember).toMatchObject({
      canManage: false,
      items: [{ kind: 'blocked', title: null, user: { you: true, name: 'Dana Brooks' } }],
    });
    expect(JSON.stringify(forMember)).not.toContain('Medical');
  });

  it('leaves out the blocked time of someone who has left the team, and names no membership for their bookings', async () => {
    const t = await team();
    const dana = await t.person('Dana Brooks');
    const visits = await t.calendar('Site visits', [dana]);
    const maya = await t.contact('Maya');
    const visit = await t.book(visits, maya, '2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z', {
      assignee: dana,
    });
    await t.away(dana, '2026-11-06T06:00:00Z', '2026-11-06T09:00:00Z');
    expect(titles(await read(t.as(), WEEK))).toHaveLength(2);

    await database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.memberships where user_id = $1', [dana.userId]),
    );
    const answer = await read(t.as(), WEEK);
    expect(answer.items).toMatchObject([
      { kind: 'appointment', id: visit, assignee: { membershipId: null, you: false, name: '' } },
    ]);
    expect(JSON.stringify(answer)).not.toContain('Dana');
  });

  it('shows a contact without a name by its address, and says when it is in the trash', async () => {
    const t = await team();
    const visits = await t.calendar('Site visits');
    const unnamed = await database.fixtures.contact(t.context, { email: 'someone@example.test' });
    // Known by an address alone, as someone who only ever wrote in is.
    await t.query('update crm.contacts set first_name = null, last_name = null where id = $1', [
      unnamed.id,
    ]);
    await t.book(visits, unnamed, '2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z');
    const named = async () => {
      const [item] = (await read(t.as(), WEEK)).items;
      return item?.kind === 'appointment' ? item.contact : undefined;
    };
    expect(await named()).toMatchObject({ name: 'someone@example.test', trashed: false });
    await t.query('update crm.contacts set deleted_at = now() where id = $1', [unnamed.id]);
    expect(await named()).toMatchObject({ name: 'someone@example.test', trashed: true });
  });
});

describe('what a read may ask for', () => {
  it(`takes a window of at most ${String(CALENDAR_EVENTS_MAX_DAYS)} days, the right way round`, async () => {
    const t = await team();
    const me = t.as();
    const window = (from: string, to: string) => read(me, { from, to });
    expect((await window('2026-11-01T00:00:00Z', '2027-01-02T00:00:00Z')).items).toEqual([]);
    for (const [from, to] of [
      ['2026-11-01T00:00:00Z', '2027-01-02T00:00:00.001Z'],
      ['2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z'],
      ['2026-11-09T00:00:00Z', '2026-11-02T00:00:00Z'],
      ['2026-11-02', '2026-11-09'],
    ] as const)
      await expect(window(from, to), `${from} to ${to}`).rejects.toBeInstanceOf(ValidationError);
    await expect(read(me, { from: WEEK.from })).rejects.toBeInstanceOf(ValidationError);
    await expect(read(me, { ...WEEK, type: 'rentals' })).rejects.toBeInstanceOf(ValidationError);
    await expect(read(me, { ...WEEK, groups: 'grp_1' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a filter that names a calendar or a person twice, or something that is neither', async () => {
    const t = await team();
    const dana = await t.person('Dana Brooks');
    const visits = await t.calendar('Site visits', [dana]);
    for (const filters of [
      { users: `${dana.membershipId},${dana.membershipId}` },
      { users: visits.publicId },
      { users: '' },
      { calendars: `${visits.publicId},${visits.publicId}` },
      { calendars: dana.membershipId },
      { calendars: `${visits.publicId},` },
    ])
      await expect(
        read(t.as(), { ...WEEK, ...filters }),
        JSON.stringify(filters),
      ).rejects.toBeInstanceOf(ValidationError);
  });

  it('answers nothing of another business: not its events, its calendars or its people', async () => {
    const mine = await team();
    const theirs = await team(mine.agency);
    const dana = await theirs.person('Dana Brooks');
    const visits = await theirs.calendar('Their visits', [dana]);
    const maya = await theirs.contact('Maya');
    await theirs.book(visits, maya, '2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z', {
      assignee: dana,
      title: 'Theirs alone',
    });
    await theirs.away(dana, '2026-11-06T06:00:00Z', '2026-11-06T09:00:00Z', 'Theirs alone');
    expect(titles(await read(theirs.as(undefined, true), WEEK))).toHaveLength(2);

    expect(await read(mine.as(undefined, true), WEEK)).toEqual({
      items: [],
      truncated: false,
      canManage: true,
    });
    // Naming their calendar or their person is naming nothing of this business.
    const byCalendar = read(mine.as(), { ...WEEK, calendars: visits.publicId });
    await expect(byCalendar).rejects.toMatchObject({
      issues: [{ path: '/calendars', code: 'unknown_calendar' }],
    });
    const byUser = read(mine.as(), { ...WEEK, users: dana.membershipId });
    await expect(byUser).rejects.toMatchObject({
      issues: [{ path: '/users', code: 'unavailable_member' }],
    });
  });

  // 2,005 appointments are written in one statement; the read itself is one index range.
  it(`answers the earliest ${String(CALENDAR_EVENTS_LIMIT)} and says so when more overlap the window`, async () => {
    const t = await team();
    const visits = await t.calendar('Site visits');
    const maya = await t.contact('Maya');
    await t.query(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, title, starts_at, ends_at, source)
       select app.business_id(), $1, $2, 'Visit ' || n,
              '2026-11-02T00:00:00Z'::timestamptz + n * interval '1 minute',
              '2026-11-02T00:00:00Z'::timestamptz + (n + 1) * interval '1 minute', 'import'
       from generate_series(1, $3::int) as n`,
      [visits.id, maya.id, CALENDAR_EVENTS_LIMIT + 5],
    );
    const answer = await read(t.as(), WEEK);
    expect(answer.truncated).toBe(true);
    expect(answer.items).toHaveLength(CALENDAR_EVENTS_LIMIT);
    expect(titles(answer).at(0)).toBe('Visit 1');
    expect(titles(answer).at(-1)).toBe(`Visit ${String(CALENDAR_EVENTS_LIMIT)}`);
    // A shorter window reads the rest whole.
    const rest = await read(t.as(), {
      // Visit 2,001 starts 2,001 minutes into the week.
      from: '2026-11-03T09:21:00Z',
      to: WEEK.to,
    });
    expect(rest.truncated).toBe(false);
    expect(titles(rest)).toEqual(
      Array.from(
        { length: 5 },
        (_unused, index) => `Visit ${String(CALENDAR_EVENTS_LIMIT + 1 + index)}`,
      ),
    );
  }, 120_000);

  it('reads the window from the indexes that start at it', async () => {
    const indexes = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; definition: string }>(
        `select indexrelid::regclass::text as name, pg_get_indexdef(indexrelid) as definition
         from pg_index where indexrelid = any($1::regclass[]) order by 1`,
        [['calendar.appointments_window_idx', 'calendar.blocked_slots_window_idx']],
      ),
    );
    expect(indexes.map((index) => index.definition.replace(/^.* USING /, ''))).toEqual([
      'btree (business_id, starts_at)',
      'btree (business_id, ends_at)',
    ]);
  });
});
