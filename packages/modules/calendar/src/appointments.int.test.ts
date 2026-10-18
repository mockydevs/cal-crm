// The appointment list (filters, search, three orders, keyset pages, a total) and one
// appointment by id. Real Postgres as crm_app under row-level security, with tenancy's own
// team port, the CRM's own contact names and auth's own people names.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  appointmentDetail,
  appointmentList,
  type AppointmentDetail,
  type AppointmentList,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError, type TenantContext } from '@repo/kernel';
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

import { createAppointmentRoutes, type AppointmentOptions } from './index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let routes: readonly ApiRoute[];
let ports: AppointmentOptions;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  const members = { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships };
  ports = {
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
  };
  routes = createAppointmentRoutes(ports);
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

interface Person {
  readonly userId: string;
  readonly membershipId: string;
}
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

/** A business, with a way to add people to its team, calendars and appointments. */
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
  const contact = async (firstName: string) => {
    const made = await database.fixtures.contact(context, {
      firstName,
      email: `${randomUUID().slice(0, 8)}@example.test`,
    });
    return { id: made.id, publicId: toPublicId('contact', made.id) };
  };
  const book = async (
    on: { id: string },
    who: { id: string },
    startsAt: string,
    endsAt: string,
    values: {
      assignee?: Person;
      title?: string;
      status?: string;
      createdAt?: string;
      notes?: string;
      location?: string;
      createdBy?: Person;
    } = {},
  ) => {
    const cancelled = values.status === 'cancelled';
    const [made] = await query<{ id: string }>(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at,
          status, cancelled_at, source, created_at, notes, location, created_by_user_id)
       values (app.business_id(), $1, $2, $3, $4, $5, $6, $7, $8, 'user',
               coalesce($9::timestamptz, now()), $10, $11, $12) returning id`,
      [
        on.id,
        who.id,
        values.assignee?.userId ?? null,
        values.title ?? 'Site visit',
        startsAt,
        endsAt,
        values.status ?? 'booked',
        cancelled ? startsAt : null,
        values.createdAt ?? null,
        values.notes ?? '',
        values.location ?? null,
        values.createdBy?.userId ?? null,
      ],
    );
    return toPublicId('appointment', made?.id ?? '');
  };
  /** Someone on the team: with or without the right to book and change appointments. */
  const as = (who?: Person, manage = false): Invocation => ({
    context: {
      ...context,
      correlationId: randomUUID(),
      ...(who === undefined
        ? { actorKind: 'system' as const }
        : { actorKind: 'user' as const, userId: who.userId, actorId: who.userId }),
    },
    permissions: new Set(manage ? ['appointments.manage'] : []),
  });
  return { agency, business, context, person, leave, calendar, contact, book, as, query };
}

async function run(
  operationId: string,
  invocation: Invocation,
  input: { params?: Record<string, string>; query?: Record<string, string> },
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  // Async, so a refusal of the query itself rejects like any other.
  return await route.run(
    { invocation, params: input.params ?? {}, query: input.query ?? {}, body: undefined },
    services,
  );
}
const list = async (
  invocation: Invocation,
  query: Record<string, string> = {},
): Promise<AppointmentList> =>
  appointmentList.parse(await run('listAppointments', invocation, { query }));
const one = async (invocation: Invocation, id: string): Promise<AppointmentDetail> =>
  appointmentDetail.parse(await run('getAppointment', invocation, { params: { id } }));
const titles = (answer: AppointmentList) => answer.items.map((item) => item.title);
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues.map(({ path, code }) => ({ path, code }));
};

describe('the appointment list', () => {
  it('keeps to each view: upcoming is not cancelled and not yet over', async () => {
    const t = await team();
    const cal = await t.calendar('Visits');
    const who = await t.contact('Amina');
    await t.book(cal, who, at(-3), at(-2), { title: 'Over' });
    await t.book(cal, who, at(-1), at(1), { title: 'Under way' });
    await t.book(cal, who, at(2), at(3), { title: 'Ahead' });
    await t.book(cal, who, at(4), at(5), { title: 'Called off', status: 'cancelled' });
    await t.book(cal, who, at(6), at(7), { title: 'Did not come', status: 'no_show' });

    expect(titles(await list(t.as()))).toEqual(['Under way', 'Ahead', 'Did not come']);
    expect(titles(await list(t.as(), { view: 'cancelled' }))).toEqual(['Called off']);
    const all = await list(t.as(), { view: 'all' });
    expect(titles(all)).toEqual(['Over', 'Under way', 'Ahead', 'Called off', 'Did not come']);
    expect(all.total).toBe(5);
    expect((await list(t.as())).total).toBe(3);
    // A status narrows a view; it does not widen it.
    expect(titles(await list(t.as(), { view: 'cancelled', status: 'confirmed' }))).toEqual([]);
    expect(titles(await list(t.as(), { view: 'all', status: 'no_show' }))).toEqual([
      'Did not come',
    ]);
  });

  it('keeps one calendar, one owner, one contact and a window of start times, together', async () => {
    const t = await team();
    const [visits, calls] = [await t.calendar('Visits'), await t.calendar('Calls')];
    const [ada, ben] = [await t.person('Ada'), await t.person('Ben')];
    const [amina, brian] = [await t.contact('Amina'), await t.contact('Brian')];
    const from = at(10);
    const to = at(20);
    await t.book(visits, amina, from, at(11), { title: 'A', assignee: ada });
    await t.book(visits, brian, at(12), at(13), { title: 'B', assignee: ben });
    await t.book(calls, amina, at(14), at(15), { title: 'C', assignee: ada });
    await t.book(calls, brian, to, at(21), { title: 'D' });

    const all = { view: 'all' };
    expect(titles(await list(t.as(), { ...all, calendar: visits.publicId }))).toEqual(['A', 'B']);
    expect(titles(await list(t.as(), { ...all, user: ada.membershipId }))).toEqual(['A', 'C']);
    expect(titles(await list(t.as(), { ...all, contact: amina.publicId }))).toEqual(['A', 'C']);
    // From its start, up to its end.
    expect(titles(await list(t.as(), { ...all, from, to }))).toEqual(['A', 'B', 'C']);
    const narrowed = await list(t.as(), {
      ...all,
      calendar: calls.publicId,
      user: ada.membershipId,
      contact: amina.publicId,
      from,
      to,
    });
    expect(titles(narrowed)).toEqual(['C']);
    expect(narrowed.total).toBe(1);
  });

  it('finds any part of a title in either case, taking % and _ as written', async () => {
    const t = await team();
    const cal = await t.calendar('Visits');
    const who = await t.contact('Amina');
    await t.book(cal, who, at(1), at(2), { title: 'Roof Survey' });
    await t.book(cal, who, at(3), at(4), { title: '100% done_deal' });
    await t.book(cal, who, at(5), at(6), { title: '100 percent done deal' });

    expect(titles(await list(t.as(), { q: 'survey' }))).toEqual(['Roof Survey']);
    expect(titles(await list(t.as(), { q: '100%' }))).toEqual(['100% done_deal']);
    expect(titles(await list(t.as(), { q: 'done_deal' }))).toEqual(['100% done_deal']);
    expect((await list(t.as(), { q: '  ' })).total).toBe(3);
  });

  it('pages each order both ways to its end, with no row twice or missed, and one total', async () => {
    const t = await team();
    const cal = await t.calendar('Visits');
    const who = await t.contact('Amina');
    const same = at(30);
    // Two start together, two are named alike but for their capitals, and the order they
    // were added in is neither the order they start in nor the order of their titles.
    const made = [
      { title: 'delta', startsAt: at(40), createdAt: at(-50) },
      { title: 'Alpha', startsAt: same, createdAt: at(-10) },
      { title: 'charlie', startsAt: same, createdAt: at(-40) },
      { title: 'Bravo', startsAt: at(20), createdAt: at(-30) },
      { title: 'alpha', startsAt: at(50), createdAt: at(-20) },
    ];
    for (const each of made)
      await t.book(
        cal,
        who,
        each.startsAt,
        new Date(Date.parse(each.startsAt) + HOUR).toISOString(),
        each,
      );

    for (const sort of ['startsAt', 'createdAt', 'title'] as const)
      for (const direction of ['asc', 'desc'] as const) {
        const whole = await list(t.as(), { sort, direction, limit: '100' });
        expect(whole.items).toHaveLength(5);
        expect(whole.next).toBeNull();
        for (const limit of [1, 2, 3, 4, 5]) {
          const seen: string[] = [];
          let after: string | undefined;
          for (let pages = 0; pages < 10; pages += 1) {
            const page = await list(t.as(), {
              sort,
              direction,
              limit: String(limit),
              ...(after === undefined ? {} : { after }),
            });
            expect(page.total).toBe(5);
            seen.push(...page.items.map((item) => item.id));
            if (page.next === null) break;
            expect(page.next).toBe(page.items.at(-1)?.id);
            after = page.next;
          }
          expect(seen, `${sort} ${direction} by ${String(limit)}`).toEqual(
            whole.items.map((item) => item.id),
          );
        }
      }
    expect(titles(await list(t.as(), { sort: 'createdAt' }))).toEqual([
      'delta',
      'charlie',
      'Bravo',
      'alpha',
      'Alpha',
    ]);
    expect(titles(await list(t.as(), { sort: 'startsAt', direction: 'desc' })).slice(0, 2)).toEqual(
      ['alpha', 'delta'],
    );
    const byTitle = titles(await list(t.as(), { sort: 'title' }));
    expect(byTitle.map((title) => title.toLowerCase())).toEqual([
      'alpha',
      'alpha',
      'bravo',
      'charlie',
      'delta',
    ]);
  });

  it('refuses a calendar, a member and a cursor of another business, and never counts its appointments', async () => {
    const mine = await team();
    const theirs = await team(mine.agency);
    const [myCal, theirCal] = [await mine.calendar('Mine'), await theirs.calendar('Theirs')];
    const theirPerson = await theirs.person('Outsider');
    await mine.book(myCal, await mine.contact('Amina'), at(1), at(2), { title: 'Mine' });
    const foreign = await theirs.book(theirCal, await theirs.contact('Zed'), at(1), at(2), {
      title: 'Theirs',
      assignee: theirPerson,
    });

    const seen = await list(mine.as(), { view: 'all' });
    expect(titles(seen)).toEqual(['Mine']);
    expect(seen.total).toBe(1);
    expect(await refusal(list(mine.as(), { calendar: theirCal.publicId }))).toEqual([
      { path: '/calendar', code: 'unknown_calendar' },
    ]);
    expect(await refusal(list(mine.as(), { user: theirPerson.membershipId }))).toEqual([
      { path: '/user', code: 'unavailable_member' },
    ]);
    expect(await refusal(list(mine.as(), { after: foreign }))).toEqual([
      { path: '/after', code: 'unknown_appointment' },
    ]);
    await expect(one(mine.as(), foreign)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('names the owner, marks you, keeps someone who left without their name, and says whether you may manage', async () => {
    const t = await team();
    const cal = await t.calendar('Visits');
    const [ada, ben] = [await t.person('Ada Owner'), await t.person('Ben Gone')];
    const amina = await t.contact('Amina');
    await t.book(cal, amina, at(1), at(2), { title: 'A', assignee: ada });
    await t.book(cal, amina, at(3), at(4), { title: 'B', assignee: ben });
    await t.book(cal, amina, at(5), at(6), { title: 'C' });
    await t.leave(ben);
    await t.query('update crm.contacts set deleted_at = now() where id = $1', [amina.id]);

    const answer = await list(t.as(ada));
    expect(answer.canManage).toBe(false);
    expect((await list(t.as(ada, true))).canManage).toBe(true);
    expect(answer.items.map((item) => item.assignee)).toEqual([
      { membershipId: ada.membershipId, you: true, name: 'Ada Owner' },
      // Someone with no place on the team any more is not shown to it, by the database's
      // own rule on people (0002): the appointment keeps them, without a name.
      { membershipId: null, you: false, name: '' },
      null,
    ]);
    expect(answer.items[0]).toMatchObject({
      kind: 'appointment',
      status: 'booked',
      source: 'user',
      calendar: { id: cal.publicId, name: 'Visits' },
      contact: { id: amina.publicId, trashed: true },
    });
  });
});

describe('what the list depends on', () => {
  it('passes on a failure to read the team unchanged, and keeps who booked without a name once they left', async () => {
    const t = await team();
    const cal = await t.calendar('Visits');
    const [ada, ben] = [await t.person('Ada Owner'), await t.person('Ben Gone')];
    const id = await t.book(cal, await t.contact('Amina'), at(1), at(2), { createdBy: ben });
    await t.leave(ben);
    expect((await one(t.as(ada), id)).createdBy).toEqual({ name: '' });

    const down = new Error('The team cannot be read.');
    const failing = createAppointmentRoutes({
      ...ports,
      members: { ...ports.members, resolve: () => Promise.reject(down) },
    }).find((route) => route.endpoint.operationId === 'listAppointments');
    await expect(
      (async () =>
        failing?.run(
          { invocation: t.as(ada), params: {}, query: { user: ada.membershipId }, body: undefined },
          services,
        ))(),
    ).rejects.toBe(down);
  });
});

describe('one appointment', () => {
  it('carries its notes, place, zone, who booked it and a revision that follows its time', async () => {
    const t = await team();
    const cal = await t.calendar('Visits');
    const ada = await t.person('Ada Owner');
    const id = await t.book(cal, await t.contact('Amina'), at(1), at(2), {
      assignee: ada,
      notes: 'Bring the plans.',
      location: 'Site office',
      createdBy: ada,
    });
    const unsaid = await t.book(cal, await t.contact('Brian'), at(3), at(4));

    const detail = await one(t.as(ada, true), id);
    expect(detail).toMatchObject({
      id,
      notes: 'Bring the plans.',
      location: 'Site office',
      timezone: 'Africa/Nairobi',
      cancelledAt: null,
      cancelReason: null,
      createdBy: { name: 'Ada Owner' },
      canManage: true,
      history: [],
      assignee: { membershipId: ada.membershipId, you: true, name: 'Ada Owner' },
    });
    expect(detail.revision).toMatch(/^[0-9a-f]{64}$/);
    expect((await one(t.as(), unsaid)).createdBy).toBeNull();

    await t.query(
      `update calendar.appointments set starts_at = starts_at + interval '1 day',
         ends_at = ends_at + interval '1 day' where notes = $1`,
      ['Bring the plans.'],
    );
    expect((await one(t.as(), id)).revision).not.toBe(detail.revision);
  });

  it('answers the same not-found for an id that names nothing', async () => {
    const t = await team();
    await expect(
      one(t.as(), toPublicId('appointment', (await t.contact('Nobody')).id)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
