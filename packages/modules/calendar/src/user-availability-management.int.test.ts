import { randomUUID } from 'node:crypto';
import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  calendarUserAvailability,
  type CalendarUserAvailability,
  type CalendarUserAvailabilityProfile,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { findTimeZone } from '@repo/module-crm';
import {
  lockActiveBusiness,
  resolveCalendarMember,
  readCalendarMemberMemberships,
} from '@repo/module-tenancy';
import {
  resolveCalendarSender,
  readCalendarSenderChoices,
  readEligibleCalendarSenders,
} from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createCalendarRoutes } from './index.js';
import { readUserAvailabilityProfiles } from './user-availability-management.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let routes: readonly ApiRoute[];
const options = {
  business: { lockActive: lockActiveBusiness },
  timeZones: { find: findTimeZone },
  members: { resolve: resolveCalendarMember, memberships: readCalendarMemberMemberships },
  senders: {
    resolve: resolveCalendarSender,
    choices: readCalendarSenderChoices,
    eligible: readEligibleCalendarSenders,
  },
};
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  routes = createCalendarRoutes(options);
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

type Agency = Awaited<ReturnType<TestDatabase['fixtures']['agency']>>;
async function member(inAgency?: Agency) {
  const agency = inAgency ?? (await database.fixtures.agency());
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const membership = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string; role_id: string }>(
      `with role as (insert into tenancy.roles(agency_id,scope,key,name)
     values($1,'business',$4,'Schedule manager') returning id)
     insert into tenancy.memberships(agency_id,business_id,user_id,role_id)
     select $1,$2,$3,id from role returning id,role_id`,
      [agency.id, business.id, user.id, `schedule_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  const invocation: Invocation = {
    context: {
      ...business.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: new Set(['calendars.manage']),
  };
  return {
    agency,
    business,
    user,
    roleId: membership.role_id,
    membershipId: toPublicId('membership', membership.id),
    invocation,
  };
}
type Member = Awaited<ReturnType<typeof member>>;

async function call(
  operationId: string,
  invocation: Invocation,
  membershipId: string,
  body?: unknown,
  from: readonly ApiRoute[] = routes,
): Promise<CalendarUserAvailability> {
  const route = from.find((item) => item.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} endpoint.`);
  return calendarUserAvailability.parse(
    await route.run({ invocation, params: { membershipId }, body, query: {} }, services),
  );
}
const read = (ours: Member) =>
  call('getCalendarUserAvailability', ours.invocation, ours.membershipId);
const save = (
  ours: Member,
  revision: string,
  profile: unknown,
  from: readonly ApiRoute[] = routes,
) =>
  call(
    'updateCalendarUserAvailability',
    ours.invocation,
    ours.membershipId,
    { revision, profile },
    from,
  );
const caught = (attempt: Promise<unknown>) =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );
const settled = <T>(attempt: Promise<T>) =>
  attempt.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** What the four tables hold for the person, as PostgreSQL stores it. */
function stored(ours: Member) {
  return database.withTenant(ours.business.context, async (sql) => ({
    schedules: await sql.query<{ timezone: string; inherit_calendar_hours: boolean }>(
      'select timezone,inherit_calendar_hours from calendar.user_schedules where user_id=$1',
      [ours.user.id],
    ),
    weekly: await sql.query(
      'select weekday,start_minute,end_minute from calendar.user_weekly_hours where user_id=$1 order by weekday,start_minute',
      [ours.user.id],
    ),
    overrides: await sql.query(
      'select on_date::text as date,start_minute,end_minute from calendar.user_date_overrides where user_id=$1 order by on_date,start_minute',
      [ours.user.id],
    ),
  }));
}
const nothing = { schedules: [], weekly: [], overrides: [] };
/** The person's blocked slots: a schedule's saves and resets leave them as they are. */
const blocked = (ours: Member) =>
  database.withTenant(ours.business.context, (sql) =>
    sql.query<{ title: string }>('select title from calendar.blocked_slots where user_id=$1', [
      ours.user.id,
    ]),
  );
const events = (ours: Member) =>
  database.withTenant(ours.business.context, (sql) =>
    sql.query<{ subject_kind: string; subject_id: string; payload: unknown; actor_id: string }>(
      "select subject_kind,subject_id,payload,actor_id from events.events where type='calendar.user_availability.updated' order by recorded_at",
    ),
  );
const audits = (ours: Member, command = 'calendar.user_availability.update') =>
  database.as('crm_owner', (sql) =>
    sql.query<{ outcome: string; error_code: string | null; input: unknown }>(
      'select outcome,error_code,input from audit.commands where business_id=$1 and command=$2 order by recorded_at',
      [ours.business.id, command],
    ),
  );
const outcomes = async (ours: Member) =>
  (await audits(ours)).map(({ outcome, error_code }) => [outcome, error_code]);

const working: CalendarUserAvailabilityProfile = {
  timezone: 'Africa/Nairobi',
  inheritCalendarHours: false,
  weeklyHours: [
    { weekday: 1, startMinute: 540, endMinute: 720 },
    { weekday: 1, startMinute: 780, endMinute: 1020 },
    { weekday: 6, startMinute: 0, endMinute: 1440 },
  ],
  dateOverrides: [
    { date: '2026-12-25', ranges: [] },
    {
      date: '2026-12-31',
      ranges: [
        { startMinute: 480, endMinute: 600 },
        { startMinute: 600, endMinute: 720 },
      ],
    },
  ],
};

it('reads unset availability as inherited calendar hours for a live business member', async () => {
  const ours = await member();
  const result = await call('getCalendarUserAvailability', ours.invocation, ours.membershipId);
  expect(result.membershipId).toBe(ours.membershipId);
  expect(result.profile).toBeNull();
  expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await call('getCalendarUserAvailability', ours.invocation, ours.membershipId)).toEqual(
    result,
  );
  expect(await stored(ours)).toEqual(nothing);
});

it('saves weekly hours, date overrides and the time zone in one step, with its event and audit entry', async () => {
  const ours = await member();
  const unset = await read(ours);
  const unordered = {
    ...working,
    weeklyHours: working.weeklyHours.toReversed(),
    dateOverrides: working.dateOverrides.toReversed(),
  };
  const saved = await save(ours, unset.revision, unordered);
  expect(saved.membershipId).toBe(ours.membershipId);
  expect(saved.profile).toEqual(working);
  expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.revision).not.toBe(unset.revision);
  expect(await read(ours)).toEqual(saved);
  expect(await stored(ours)).toEqual({
    schedules: [{ timezone: 'Africa/Nairobi', inherit_calendar_hours: false }],
    weekly: [
      { weekday: 1, start_minute: 540, end_minute: 720 },
      { weekday: 1, start_minute: 780, end_minute: 1020 },
      { weekday: 6, start_minute: 0, end_minute: 1440 },
    ],
    overrides: [
      { date: '2026-12-25', start_minute: null, end_minute: null },
      { date: '2026-12-31', start_minute: 480, end_minute: 600 },
      { date: '2026-12-31', start_minute: 600, end_minute: 720 },
    ],
  });
  expect(await events(ours)).toEqual([
    {
      subject_kind: 'user',
      subject_id: ours.user.id,
      payload: { reset: false },
      actor_id: ours.user.id,
    },
  ]);
  const recorded = await audits(ours);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ outcome: 'ok', error_code: null });
  expect(recorded[0]?.input).toEqual({
    membershipId: ours.membershipId,
    revision: unset.revision,
    profile: unordered,
  });
});

it('leaves blocked time alone: a save and a reset keep the person’s blocked slots', async () => {
  const ours = await member();
  await database.withTenant(ours.business.context, (sql) =>
    sql.query(
      `insert into calendar.blocked_slots (business_id, user_id, starts_at, ends_at, title)
       values (app.business_id(), $1, '2026-11-02T06:00:00Z', '2026-11-06T15:00:00Z', 'Family leave')`,
      [ours.user.id],
    ),
  );
  const unset = await read(ours);
  const saved = await save(ours, unset.revision, working);
  expect(JSON.stringify(saved)).not.toContain('Family leave');
  expect(await blocked(ours)).toEqual([{ title: 'Family leave' }]);
  await save(ours, saved.revision, null);
  expect(await stored(ours)).toEqual(nothing);
  expect(await blocked(ours)).toEqual([{ title: 'Family leave' }]);
});

it('tells a reset to calendar hours from an independent schedule with no hours, and keeps the creation time across saves', async () => {
  const ours = await member();
  const unset = await read(ours);
  const empty = {
    timezone: 'UTC',
    inheritCalendarHours: false,
    weeklyHours: [],
    dateOverrides: [],
  };
  const closed = await save(ours, unset.revision, empty);
  expect(closed.profile).toEqual(empty);
  expect(closed.revision).not.toBe(unset.revision);
  expect((await stored(ours)).schedules).toEqual([
    { timezone: 'UTC', inherit_calendar_hours: false },
  ]);
  const times = () =>
    database.withTenant(ours.business.context, (sql) =>
      sql.one<{ created: string; changed: boolean }>(
        'select created_at::text as created, updated_at > created_at as changed from calendar.user_schedules',
      ),
    );
  const first = await times();
  expect(first.changed).toBe(false);
  const inheriting = await save(ours, closed.revision, { ...working, inheritCalendarHours: true });
  expect(inheriting.profile).toEqual({ ...working, inheritCalendarHours: true });
  expect(await times()).toEqual({ created: first.created, changed: true });
  // A stored inheriting schedule keeps its weekly rows for a later change of mind.
  expect((await stored(ours)).weekly).toHaveLength(3);
  const reset = await save(ours, inheriting.revision, null);
  expect(reset).toEqual(unset);
  expect(await stored(ours)).toEqual(nothing);
  expect((await events(ours)).map((event) => event.payload)).toEqual([
    { reset: false },
    { reset: false },
    { reset: true },
  ]);
  // Resetting someone who has nothing stored is a save like any other, and changes nothing.
  expect(await save(ours, reset.revision, null)).toEqual(unset);
});

it('refuses a save based on a schedule someone else has since changed, and changes nothing', async () => {
  const ours = await member();
  const unset = await read(ours);
  const saved = await save(ours, unset.revision, working);
  const before = await stored(ours);
  for (const profile of [null, { ...working, timezone: 'UTC' }]) {
    await expect(save(ours, unset.revision, profile)).rejects.toBeInstanceOf(ConflictError);
    await expect(save(ours, 'f'.repeat(64), profile)).rejects.toBeInstanceOf(ConflictError);
  }
  expect(await stored(ours)).toEqual(before);
  expect(await read(ours)).toEqual(saved);
  expect(await events(ours)).toHaveLength(1);
  expect(await outcomes(ours)).toEqual([
    ['ok', null],
    ['failed', 'conflict'],
    ['failed', 'conflict'],
    ['failed', 'conflict'],
    ['failed', 'conflict'],
  ]);
  // The same content always has the same revision, so an unchanged schedule can be saved.
  expect((await save(ours, saved.revision, working)).revision).toBe(saved.revision);
});

describe('what a schedule may hold', () => {
  const invalid: readonly (readonly [string, Record<string, unknown>])[] = [
    [
      'overlapping weekly hours',
      {
        weeklyHours: [
          { weekday: 2, startMinute: 540, endMinute: 600 },
          { weekday: 2, startMinute: 599, endMinute: 660 },
        ],
      },
    ],
    [
      'weekly hours that end when they start',
      { weeklyHours: [{ weekday: 2, startMinute: 600, endMinute: 600 }] },
    ],
    [
      'a weekday that does not exist',
      { weeklyHours: [{ weekday: 7, startMinute: 0, endMinute: 60 }] },
    ],
    ['hours past midnight', { weeklyHours: [{ weekday: 2, startMinute: 0, endMinute: 1441 }] }],
    ['a fractional minute', { weeklyHours: [{ weekday: 2, startMinute: 0.5, endMinute: 60 }] }],
    [
      'overlapping hours within one date override',
      {
        dateOverrides: [
          {
            date: '2026-12-31',
            ranges: [
              { startMinute: 0, endMinute: 720 },
              { startMinute: 719, endMinute: 1440 },
            ],
          },
        ],
      },
    ],
    [
      'two override groups for one date',
      {
        dateOverrides: [
          { date: '2026-12-31', ranges: [] },
          { date: '2026-12-31', ranges: [{ startMinute: 0, endMinute: 60 }] },
        ],
      },
    ],
    ['a date that does not exist', { dateOverrides: [{ date: '2026-02-30', ranges: [] }] }],
    ['a date in year zero', { dateOverrides: [{ date: '0000-01-01', ranges: [] }] }],
    ['a fixed UTC offset for a time zone', { timezone: '+03:00' }],
    ['a time zone that is not one', { timezone: 'Africa/Atlantis' }],
    ['a field the contract does not have', { notes: 'private' }],
  ];
  it.each(invalid)('refuses %s and stores nothing', async (_name, change) => {
    const ours = await member();
    const unset = await read(ours);
    await expect(save(ours, unset.revision, { ...working, ...change })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await stored(ours)).toEqual(nothing);
    expect(await events(ours)).toEqual([]);
    // The body is checked where it arrives, so its issues point into what was sent.
    expect(await audits(ours)).toEqual([]);
  });

  it('refuses a save without a revision or without saying whether to reset', async () => {
    const ours = await member();
    const unset = await read(ours);
    for (const body of [
      { profile: working },
      { revision: unset.revision },
      { revision: 'abc', profile: null },
    ])
      await expect(
        call('updateCalendarUserAvailability', ours.invocation, ours.membershipId, body),
      ).rejects.toBeInstanceOf(ValidationError);
    expect(await read(ours)).toEqual(unset);
  });

  it('takes adjacent hours and a whole day', async () => {
    const ours = await member();
    const profile = {
      timezone: 'UTC',
      inheritCalendarHours: false,
      weeklyHours: [
        { weekday: 0, startMinute: 0, endMinute: 1440 },
        { weekday: 3, startMinute: 0, endMinute: 720 },
        { weekday: 3, startMinute: 720, endMinute: 1440 },
      ],
      dateOverrides: [{ date: '0001-01-01', ranges: [{ startMinute: 1439, endMinute: 1440 }] }],
    };
    const saved = await save(ours, (await read(ours)).revision, profile);
    expect(saved.profile).toEqual(profile);
    expect(await read(ours)).toEqual(saved);
  });
});

it('stores the time zone as this server spells it and refuses one the server does not have', async () => {
  const ours = await member();
  const unset = await read(ours);
  const saved = await save(ours, unset.revision, { ...working, timezone: 'africa/nairobi' });
  expect(saved.profile?.timezone).toBe('Africa/Nairobi');
  expect((await stored(ours)).schedules).toEqual([
    { timezone: 'Africa/Nairobi', inherit_calendar_hours: false },
  ]);
  // The runtime knows the name; this server's PostgreSQL, as the port reports it, does not.
  const withoutZone = createCalendarRoutes({
    ...options,
    timeZones: { find: () => Promise.resolve(undefined) },
  });
  const refused = await caught(
    save(ours, saved.revision, { ...working, timezone: 'Europe/Paris' }, withoutZone),
  );
  expect(refused).toBeInstanceOf(ValidationError);
  expect(refused).toMatchObject({
    issues: [{ path: '/profile/timezone', code: 'time_zone_unknown' }],
  });
  expect(await read(ours)).toEqual(saved);
  expect((await stored(ours)).weekly).toHaveLength(3);
});

it('saves the largest override list the contract takes, in batches, and reads it back whole', async () => {
  const ours = await member();
  const first = Date.UTC(2027, 0, 1);
  const day = (index: number) => new Date(first + index * 86_400_000).toISOString().slice(0, 10);
  const dateOverrides = Array.from({ length: 730 }, (_, index) => ({
    date: day(index),
    ranges:
      index % 2 === 0
        ? []
        : [
            { startMinute: 480, endMinute: 720 },
            { startMinute: 780, endMinute: 1020 },
          ],
  }));
  const saved = await save(ours, (await read(ours)).revision, {
    ...working,
    dateOverrides,
  });
  expect(saved.profile?.dateOverrides).toEqual(dateOverrides);
  const rows = await stored(ours);
  expect(rows.overrides).toHaveLength(365 + 365 * 2);
  expect(await read(ours)).toEqual(saved);
});

it('needs the calendar permission to read or change a schedule, and a business to do it in', async () => {
  const ours = await member();
  const unset = await read(ours);
  const reader: Invocation = { ...ours.invocation, permissions: new Set(['contacts.manage']) };
  for (const attempt of [
    () => call('getCalendarUserAvailability', reader, ours.membershipId),
    () =>
      call('updateCalendarUserAvailability', reader, ours.membershipId, {
        revision: unset.revision,
        profile: working,
      }),
  ])
    await expect(attempt()).rejects.toMatchObject({
      name: 'ForbiddenError',
      permission: 'calendars.manage',
    });
  // A stored schedule gives its own subject no right to read it either.
  const saved = await save(ours, unset.revision, working);
  await expect(
    call('getCalendarUserAvailability', reader, ours.membershipId),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await audits(ours, 'calendar.user_availability.read')).toEqual([
    { outcome: 'denied', error_code: 'forbidden', input: {} },
    { outcome: 'denied', error_code: 'forbidden', input: {} },
  ]);
  expect(await outcomes(ours)).toEqual([
    ['denied', 'forbidden'],
    ['ok', null],
  ]);
  const everything: Invocation = { ...ours.invocation, permissions: 'all' };
  expect(await call('getCalendarUserAvailability', everything, ours.membershipId)).toEqual(saved);
  const atAgency: Invocation = {
    context: {
      agencyId: ours.agency.id,
      actorKind: 'user',
      actorId: ours.user.id,
      userId: ours.user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  for (const attempt of [
    () => call('getCalendarUserAvailability', atAgency, ours.membershipId),
    () =>
      call('updateCalendarUserAvailability', atAgency, ours.membershipId, {
        revision: saved.revision,
        profile: null,
      }),
  ])
    await expect(attempt()).rejects.toMatchObject({
      name: 'ValidationError',
      issues: [{ code: 'business_required' }],
    });
  expect(await read(ours)).toEqual(saved);
});

it("keeps another business's team out of reach, in the same agency and in another", async () => {
  const ours = await member();
  const saved = await save(ours, (await read(ours)).revision, working);
  const sameAgency = await member(ours.agency);
  const otherAgency = await member();
  for (const other of [sameAgency, otherAgency]) {
    const unset = await read(other);
    for (const attempt of [
      () => call('getCalendarUserAvailability', other.invocation, ours.membershipId),
      () =>
        call('updateCalendarUserAvailability', other.invocation, ours.membershipId, {
          revision: saved.revision,
          profile: null,
        }),
      () =>
        call('updateCalendarUserAvailability', other.invocation, ours.membershipId, {
          revision: unset.revision,
          profile: working,
        }),
    ]) {
      const error = await caught(attempt());
      expect(error).toBeInstanceOf(NotFoundError);
      expect(JSON.stringify(error)).not.toContain('Family leave');
    }
    expect(await stored(other)).toEqual(nothing);
    expect(await read(other)).toEqual(unset);
  }
  expect(await read(ours)).toEqual(saved);
  // A person on two teams has one schedule in each business, and neither shows the other.
  const second = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values($1,$2,$3,$4) returning id',
      [ours.agency.id, sameAgency.business.id, ours.user.id, sameAgency.roleId],
    ),
  );
  const there = await call(
    'getCalendarUserAvailability',
    sameAgency.invocation,
    toPublicId('membership', second.id),
  );
  expect(there.profile).toBeNull();
  await call(
    'updateCalendarUserAvailability',
    sameAgency.invocation,
    toPublicId('membership', second.id),
    { revision: there.revision, profile: { ...working, timezone: 'UTC' } },
  );
  expect(await read(ours)).toEqual(saved);
  expect(await events(ours)).toHaveLength(1);
});

it('finds nobody for an unknown membership and refuses an id that is not one', async () => {
  const ours = await member();
  const unset = await read(ours);
  const { id } = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>('select uuidv7() as id'),
  );
  const unknown = toPublicId('membership', id);
  await expect(
    call('getCalendarUserAvailability', ours.invocation, unknown),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('updateCalendarUserAvailability', ours.invocation, unknown, {
      revision: unset.revision,
      profile: working,
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  for (const membershipId of [ours.user.id, toPublicId('calendar', id), ''])
    await expect(
      call('getCalendarUserAvailability', ours.invocation, membershipId),
    ).rejects.toBeInstanceOf(ValidationError);
});

it('stops serving a schedule once its person is disabled or leaves the team, keeps it stored, and shows it again when they rejoin', async () => {
  const ours = await member();
  const manager = await database.fixtures.user();
  const invocation: Invocation = {
    ...ours.invocation,
    context: { ...ours.invocation.context, userId: manager.id, actorId: manager.id },
  };
  const saved = await save(ours, (await read(ours)).revision, working);
  const before = await stored(ours);
  const refusals = [
    () => call('getCalendarUserAvailability', invocation, ours.membershipId),
    () =>
      call('updateCalendarUserAvailability', invocation, ours.membershipId, {
        revision: saved.revision,
        profile: null,
      }),
  ];
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=now() where id=$1', [ours.user.id]),
  );
  for (const attempt of refusals) await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=null where id=$1', [ours.user.id]),
  );
  expect(await call('getCalendarUserAvailability', invocation, ours.membershipId)).toEqual(saved);
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where id=$1', [
      parsePublicId('membership', ours.membershipId),
    ]),
  );
  for (const attempt of refusals) await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
  expect(await stored(ours)).toEqual(before);
  const rejoined = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values($1,$2,$3,$4) returning id',
      [ours.agency.id, ours.business.id, ours.user.id, ours.roleId],
    ),
  );
  const membershipId = toPublicId('membership', rejoined.id);
  expect(membershipId).not.toBe(ours.membershipId);
  expect(await call('getCalendarUserAvailability', invocation, membershipId)).toEqual({
    ...saved,
    membershipId,
  });
  // The old membership names nobody now.
  for (const attempt of refusals) await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
});

it('refuses a change in a suspended business before writing anything', async () => {
  const ours = await member();
  const unset = await read(ours);
  await database.as('crm_owner', (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=$1", [ours.business.id]),
  );
  await expect(save(ours, unset.revision, working)).rejects.toBeInstanceOf(NotFoundError);
  expect(await stored(ours)).toEqual(nothing);
  expect(await events(ours)).toEqual([]);
});

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

it('lets exactly one of two overlapping saves of the same revision through', async () => {
  const ours = await member();
  const unset = await read(ours);
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  // The first save stops after its revision check, holding the lock every writer takes.
  const gated = createCalendarRoutes({
    ...options,
    timeZones: {
      async find(trx, value) {
        ready.resolve(undefined);
        await proceed.promise;
        return findTimeZone(trx, value);
      },
    },
  });
  const first = settled(save(ours, unset.revision, working, gated));
  await ready.promise;
  const second = settled(save(ours, unset.revision, { ...working, timezone: 'UTC' }));
  try {
    await expect
      .poll(() => waitingOn('%tenancy%businesses%for no key update%'), {
        timeout: 10_000,
        interval: 50,
      })
      .toBe(true);
    // Nothing of the first save is visible while it is open.
    expect(await stored(ours)).toEqual(nothing);
  } finally {
    proceed.resolve(undefined);
  }
  const [won, lost] = await Promise.all([first, second]);
  if (!won.ok) throw won.error;
  expect(won.value.profile).toEqual(working);
  expect(lost.ok).toBe(false);
  if (lost.ok) throw new Error('Both saves of one revision were accepted.');
  expect(lost.error).toBeInstanceOf(ConflictError);
  expect(await read(ours)).toEqual(won.value);
  expect(await events(ours)).toHaveLength(1);
  expect((await outcomes(ours)).toSorted()).toEqual([
    ['failed', 'conflict'],
    ['ok', null],
  ]);
});

it('makes a save wait for a removal in flight and then finds nobody, leaving the schedule as it was', async () => {
  const ours = await member();
  const manager = await database.fixtures.user();
  const invocation: Invocation = {
    ...ours.invocation,
    context: { ...ours.invocation.context, userId: manager.id, actorId: manager.id },
  };
  const saved = await save(ours, (await read(ours)).revision, working);
  const before = await stored(ours);
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const removing = settled(
    database.as('crm_owner', async (sql) => {
      await sql.query('delete from tenancy.memberships where id=$1', [
        parsePublicId('membership', ours.membershipId),
      ]);
      ready.resolve(undefined);
      await proceed.promise;
    }),
  );
  await ready.promise;
  const saving = settled(
    call('updateCalendarUserAvailability', invocation, ours.membershipId, {
      revision: saved.revision,
      profile: null,
    }),
  );
  try {
    await expect
      .poll(() => waitingOn('%tenancy%memberships%for share%'), { timeout: 10_000, interval: 50 })
      .toBe(true);
  } finally {
    proceed.resolve(undefined);
  }
  const [removed, result] = await Promise.all([removing, saving]);
  if (!removed.ok) throw removed.error;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('A schedule was changed for someone no longer on the team.');
  expect(result.error).toBeInstanceOf(NotFoundError);
  expect(await stored(ours)).toEqual(before);
  expect(await events(ours)).toHaveLength(1);
});

it('reads for booking only the schedules and the overrides near the days asked for', async () => {
  const ours = await member();
  const other = await member(ours.agency);
  await save(ours, (await read(ours)).revision, {
    ...working,
    dateOverrides: [
      { date: '2026-11-29', ranges: [] },
      { date: '2026-11-30', ranges: [{ startMinute: 0, endMinute: 60 }] },
      { date: '2026-12-04', ranges: [] },
      { date: '2026-12-05', ranges: [] },
    ],
  });
  const window = { from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-03T00:00:00Z') };
  const profiles = (users: readonly string[], context = ours.business.context) =>
    withTenant(db, { ...context, correlationId: randomUUID() }, (trx) =>
      readUserAvailabilityProfiles(trx, ours.business.id, users, window),
    );
  const found = await profiles([ours.user.id, ours.user.id, other.user.id]);
  expect([...found.keys()]).toEqual([ours.user.id]);
  expect(found.get(ours.user.id)).toEqual({
    timezone: 'Africa/Nairobi',
    inheritCalendarHours: false,
    weeklyHours: working.weeklyHours,
    // A local date is within a day of the UTC date of the same instant, in any zone.
    dateOverrides: [
      { date: '2026-11-30', ranges: [{ startMinute: 0, endMinute: 60 }] },
      { date: '2026-12-04', ranges: [] },
    ],
  });
  expect(await profiles([])).toEqual(new Map());
  expect(await profiles([other.user.id])).toEqual(new Map());
  // Row security answers for the business the transaction works in, whatever id is passed.
  expect(await profiles([ours.user.id], other.business.context)).toEqual(new Map());
});

it('passes on a failure of the team port as it is, without calling it a missing member', async () => {
  const ours = await member();
  const unset = await read(ours);
  const failure = new Error('The team could not be read.');
  const failing = createCalendarRoutes({
    ...options,
    members: { ...options.members, resolve: () => Promise.reject(failure) },
  });
  expect(
    await caught(
      call('getCalendarUserAvailability', ours.invocation, ours.membershipId, undefined, failing),
    ),
  ).toBe(failure);
  expect(await caught(save(ours, unset.revision, working, failing))).toBe(failure);
  expect(await stored(ours)).toEqual(nothing);
  expect(await outcomes(ours)).toEqual([['failed', 'internal']]);
});
