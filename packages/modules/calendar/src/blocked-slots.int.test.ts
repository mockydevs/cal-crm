// Blocked slots one at a time, on real Postgres as crm_app under row-level
// security, with tenancy's own team and business ports. A block keeps new bookings out of
// its time (the booking page's offer, and a booking sent anyway, also when the two arrive
// together); the appointments already in it stay.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type ApiRoute, type Invocation } from '@repo/commands';
import {
  blockedSlot,
  blockedSlotList,
  calendarConfiguration,
  type BlockedSlot,
} from '@repo/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { intakeContact } from '@repo/module-crm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@repo/testing';
import { bookingFixtureSuite, calendars, request } from '../test/booking-fixtures.js';
import { readTestNames } from '../test/people.js';
import { createBlockedSlotRoutes, type BlockedSlotOptions } from './blocked-slots.js';

const suite = bookingFixtureSuite();
const { fixture, handlers, manage } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});
type Fixture = Awaited<ReturnType<typeof fixture>>;

const options: BlockedSlotOptions = {
  business: calendars.business,
  members: calendars.members,
  people: { names: readTestNames },
};
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const calendarDay = Array.from({ length: 16 }, (_, index) => {
  const minute = 540 + index * 30;
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
});
const without = (...times: string[]) => calendarDay.filter((time) => !times.includes(time));

const manager = (f: Pick<Fixture, 'business'>, permissions: Invocation['permissions'] = 'all') => ({
  context: { ...f.business.context, correlationId: randomUUID() },
  permissions,
});
/** Runs a blocked slot route as someone of the fixture's business. */
async function run(
  invocation: Invocation,
  operationId: string,
  input: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown } = {},
  routes: readonly ApiRoute[] = createBlockedSlotRoutes(options),
): Promise<unknown> {
  const route = routes.find((candidate) => candidate.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  // Async, so a refusal of the input itself rejects like any other.
  return Promise.resolve().then(() =>
    route.run(
      {
        invocation,
        params: input.params ?? {},
        query: input.query ?? {},
        body: input.body,
      },
      { db: suite.db, authorize: allowEveryone },
    ),
  );
}
const create = async (f: Pick<Fixture, 'business'>, body: Record<string, unknown>) =>
  blockedSlot.parse(await run(manager(f), 'createBlockedSlot', { body }));

/** The UTC clock times of the slots the booking page offers on a date. */
async function offered(f: Fixture, date: string): Promise<string[]> {
  const { slots } = await handlers().slots(f.params, { date }, request());
  return slots.map((slot) => slot.startsAt.slice(11, 16));
}
const booking = (date: string, time: string) => ({
  bookingRequestId: randomUUID(),
  startsAt: `${date}T${time}:00Z`,
  contact: { email: `guest-${randomUUID()}@example.test` },
  notificationConsent: true as const,
  contactTimezone: 'UTC',
});
const appointments = (f: Pick<Fixture, 'business'>) =>
  database.withTenant(f.business.context, (sql) =>
    sql.query<{ time: string }>(
      "select to_char(starts_at at time zone 'UTC','HH24:MI') as time from calendar.appointments order by starts_at",
    ),
  );
const settled = <T>(attempt: Promise<T>) =>
  attempt.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
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

/** A second calendar of the fixture's business, with the same host. */
async function secondCalendar(f: Fixture): Promise<string> {
  const saved = calendarConfiguration.parse(
    await manage(f, 'createCalendar', {
      body: {
        name: 'Phone call',
        description: '',
        kind: 'personal',
        timezone: 'UTC',
        bookingSlug: 'phone-call',
        confirmationSenderId: null,
        isActive: true,
        minNoticeMinutes: 0,
        members: [{ membershipId: f.membershipId, weight: 1 }],
        weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          startTime: '09:00',
          endTime: '17:00',
        })),
        dateOverrides: [],
      },
    }),
  );
  return saved.calendar.id;
}

describe('a blocked slot of its own', () => {
  it('is created, read, changed and removed one at a time, with events and an audit trail that never hold its title', async () => {
    const f = await fixture();
    const date = tomorrow();
    const made = await create(f, {
      membershipId: f.membershipId,
      title: '  Dentist  ',
      // Any offset, to the microsecond: kept as the instant it names.
      startsAt: `${date}T13:00:00.000001+03:00`,
      endsAt: `${date}T11:00:00Z`,
    });
    expect(made).toEqual({
      id: expect.stringMatching(/^blk_/) as unknown,
      member: {
        membershipId: f.membershipId,
        you: false,
        name: expect.stringMatching(/^User /) as unknown,
      },
      calendar: null,
      title: 'Dentist',
      startsAt: `${date}T10:00:00.000001Z`,
      endsAt: `${date}T11:00:00.000000Z`,
      revision: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
    expect(
      blockedSlot.parse(
        await run(manager(f), 'getBlockedSlot', { params: { blockedSlotId: made.id } }),
      ),
    ).toEqual(made);

    const changed = blockedSlot.parse(
      await run(manager(f), 'updateBlockedSlot', {
        params: { blockedSlotId: made.id },
        body: {
          membershipId: f.membershipId,
          calendarId: f.saved.calendar.id,
          title: 'Dentist, moved',
          startsAt: `${date}T14:00:00Z`,
          endsAt: `${date}T15:00:00Z`,
          revision: made.revision,
        },
      }),
    );
    expect(changed).toMatchObject({
      id: made.id,
      calendar: { id: f.saved.calendar.id, name: 'Venue tour' },
      title: 'Dentist, moved',
      startsAt: `${date}T14:00:00.000000Z`,
    });
    expect(changed.revision).not.toBe(made.revision);
    // A change made from what someone else has since changed is refused, and changes nothing.
    await expect(
      run(manager(f), 'updateBlockedSlot', {
        params: { blockedSlotId: made.id },
        body: {
          membershipId: f.membershipId,
          startsAt: `${date}T09:00:00Z`,
          endsAt: `${date}T10:00:00Z`,
          revision: made.revision,
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(
      await run(manager(f), 'deleteBlockedSlot', { params: { blockedSlotId: made.id } }),
    ).toBeUndefined();
    await expect(
      run(manager(f), 'getBlockedSlot', { params: { blockedSlotId: made.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run(manager(f), 'deleteBlockedSlot', { params: { blockedSlotId: made.id } }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const id = parsePublicId('blocked_slot', made.id);
    const events = await database.withTenant(f.business.context, (sql) =>
      sql.query<{ type: string; subject_kind: string; subject_id: string; payload: unknown }>(
        "select type,subject_kind,subject_id,payload from events.events where type like 'calendar.blocked_slot.%' order by recorded_at",
      ),
    );
    expect(
      events.map(({ type, subject_kind, subject_id }) => [type, subject_kind, subject_id]),
    ).toEqual([
      ['calendar.blocked_slot.created', 'blocked_slot', id],
      ['calendar.blocked_slot.updated', 'blocked_slot', id],
      ['calendar.blocked_slot.deleted', 'blocked_slot', id],
    ]);
    const audits = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string; outcome: string; input: unknown }>(
        "select command,outcome,input from audit.commands where business_id=$1 and command like 'calendar.blocked_slot.%' order by recorded_at",
        [f.business.id],
      ),
    );
    expect(audits.map(({ command, outcome }) => [command, outcome])).toEqual([
      ['calendar.blocked_slot.create', 'ok'],
      ['calendar.blocked_slot.update', 'ok'],
      ['calendar.blocked_slot.update', 'failed'],
      ['calendar.blocked_slot.delete', 'ok'],
      ['calendar.blocked_slot.delete', 'failed'],
    ]);
    expect(audits[0]?.input).toMatchObject({ membershipId: f.membershipId, calendarId: null });
    expect(JSON.stringify([events, audits])).not.toContain('Dentist');
  });

  it('blocks a member, a whole calendar, or a member on one calendar, and refuses anything else', async () => {
    const f = await fixture();
    const date = tomorrow();
    const times = { startsAt: `${date}T10:00:00Z`, endsAt: `${date}T11:00:00Z` };
    const whole = await create(f, { calendarId: f.saved.calendar.id, ...times });
    expect(whole).toMatchObject({ member: null, calendar: { id: f.saved.calendar.id } });
    const refusal = (body: Record<string, unknown>) =>
      run(manager(f), 'createBlockedSlot', { body: { ...times, ...body } });
    await expect(refusal({})).rejects.toMatchObject({ issues: [{ path: '/membershipId' }] });
    await expect(
      refusal({ membershipId: f.membershipId, endsAt: times.startsAt }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Someone blocked on one calendar is someone who takes bookings on it.
    const other = await database.fixtures.user();
    const colleague = await database.withTenant(f.business.context, (sql) =>
      sql.one<{ id: string }>(
        'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values(app.agency_id(),app.business_id(),$1,$2) returning id',
        [other.id, f.roleId],
      ),
    );
    await expect(
      refusal({
        membershipId: toPublicId('membership', colleague.id),
        calendarId: f.saved.calendar.id,
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/calendarId', code: 'not_on_calendar' }] });
    // Nothing was stored by a refusal.
    const stored = await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from calendar.blocked_slots'),
    );
    expect(stored).toHaveLength(1);
  });

  it("lists a member's Time away from now on, theirs alone and on one calendar, by start", async () => {
    const f = await fixture();
    const date = tomorrow();
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into calendar.blocked_slots(business_id,user_id,starts_at,ends_at,title)
         values(app.business_id(),$1,now() - interval '2 days',now() - interval '1 day','Over')`,
        [f.user.id],
      ),
    );
    const leave = await create(f, {
      membershipId: f.membershipId,
      title: 'Leave',
      startsAt: `${later}T00:00:00Z`,
      endsAt: `${later}T23:00:00Z`,
    });
    const onCalendar = await create(f, {
      membershipId: f.membershipId,
      calendarId: f.saved.calendar.id,
      startsAt: `${date}T10:00:00Z`,
      endsAt: `${date}T11:00:00Z`,
    });
    // The whole calendar's block is nobody's Time away.
    await create(f, {
      calendarId: f.saved.calendar.id,
      startsAt: `${date}T12:00:00Z`,
      endsAt: `${date}T13:00:00Z`,
    });
    const list = blockedSlotList.parse(
      await run(manager(f), 'listBlockedSlots', { params: { membershipId: f.membershipId } }),
    );
    expect(list).toEqual({ items: [onCalendar, leave], truncated: false });
  });
});

describe('what a blocked slot keeps out', () => {
  it('takes its time out of the offer and refuses a booking into it, buffers included; a booking already there stays', async () => {
    const f = await fixture();
    const date = tomorrow();
    const api = handlers();
    await api.book(f.params, booking(date, '10:00'), request());
    await create(f, {
      membershipId: f.membershipId,
      startsAt: `${date}T10:15:00Z`,
      endsAt: `${date}T11:00:00Z`,
    });
    // Half-open: the 11:00 slot, which starts as the block ends, is free.
    expect(await offered(f, date)).toEqual(without('10:00', '10:30'));
    await expect(api.book(f.params, booking(date, '10:30'), request())).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await appointments(f)).toEqual([{ time: '10:00' }]);
    // A buffer may not reach into the block either: 11:00 is occupied from 10:45.
    await database.withTenant(f.business.context, (sql) =>
      sql.query('update calendar.calendars set buffer_before_minutes=15'),
    );
    expect(await offered(f, date)).toEqual(without('10:00', '10:30', '11:00'));
  });

  it('blocks a member on one calendar only, and a whole calendar for everyone on it', async () => {
    const f = await fixture();
    const date = tomorrow();
    const other = await secondCalendar(f);
    const slotsOf = async (calendarSlug: string) =>
      (await handlers().slots({ ...f.params, calendarSlug }, { date }, request())).slots.map(
        (slot) => slot.startsAt.slice(11, 16),
      );
    // On the other calendar: this one is untouched.
    await create(f, {
      membershipId: f.membershipId,
      calendarId: other,
      startsAt: `${date}T10:00:00Z`,
      endsAt: `${date}T11:00:00Z`,
    });
    expect(await slotsOf('venue-tour')).toEqual(calendarDay);
    expect(await slotsOf('phone-call')).toEqual(without('10:00', '10:30'));
    // The whole of this calendar: the other is untouched.
    await create(f, {
      calendarId: f.saved.calendar.id,
      startsAt: `${date}T14:00:00Z`,
      endsAt: `${date}T15:00:00Z`,
    });
    expect(await slotsOf('venue-tour')).toEqual(without('14:00', '14:30'));
    expect(await slotsOf('phone-call')).toEqual(without('10:00', '10:30'));
    await expect(
      handlers().book(f.params, booking(date, '14:30'), request()),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("blocks a person in this business only: their other business's calendar still offers the time", async () => {
    const f = await fixture();
    const date = tomorrow();
    const elsewhere = await fixture('Elsewhere', { user: f.user });
    await create(f, {
      membershipId: f.membershipId,
      startsAt: `${date}T10:00:00Z`,
      endsAt: `${date}T11:00:00Z`,
    });
    expect(await offered(f, date)).toEqual(without('10:00', '10:30'));
    expect(await offered(elsewhere, date)).toEqual(calendarDay);
  });

  it('makes a booking wait for a block in flight, then refuses its time', async () => {
    const f = await fixture();
    const date = tomorrow();
    const ready = Promise.withResolvers<undefined>();
    const proceed = Promise.withResolvers<undefined>();
    // The block stops after it has taken the business lock, before it writes anything.
    const paused = createBlockedSlotRoutes({
      ...options,
      members: {
        ...options.members,
        async resolve(trx, context, membershipId) {
          ready.resolve(undefined);
          await proceed.promise;
          return options.members.resolve(trx, context, membershipId);
        },
      },
    });
    const blocking = settled(
      run(
        manager(f),
        'createBlockedSlot',
        {
          body: {
            membershipId: f.membershipId,
            startsAt: `${date}T10:00:00Z`,
            endsAt: `${date}T11:00:00Z`,
          },
        },
        paused,
      ),
    );
    await ready.promise;
    const taken = settled(handlers().book(f.params, booking(date, '10:30'), request()));
    try {
      await untilWaiting('%tenancy%businesses%for no key update%');
      expect(await appointments(f)).toEqual([]);
    } finally {
      proceed.resolve(undefined);
    }
    const [blocked, refused] = await Promise.all([blocking, taken]);
    if (!blocked.ok) throw blocked.error;
    if (refused.ok) throw new Error('A booking was accepted inside a block made before it.');
    expect(refused.error).toBeInstanceOf(ConflictError);
    expect(await appointments(f)).toEqual([]);
  });

  it('makes a block wait for a booking in flight, which keeps its appointment', async () => {
    const f = await fixture();
    const date = tomorrow();
    const ready = Promise.withResolvers<undefined>();
    const proceed = Promise.withResolvers<undefined>();
    // The booking stops after it has checked the time, before it writes anything.
    const api = handlers(async (trx, input, command) => {
      ready.resolve(undefined);
      await proceed.promise;
      return intakeContact(trx, input, command);
    });
    const attempt = settled(api.book(f.params, booking(date, '10:00'), request()));
    await ready.promise;
    const blocking = settled(
      create(f, {
        membershipId: f.membershipId,
        startsAt: `${date}T10:00:00Z`,
        endsAt: `${date}T11:00:00Z`,
      }),
    );
    try {
      await untilWaiting('%tenancy%businesses%for no key update%');
    } finally {
      proceed.resolve(undefined);
    }
    const [booked, blocked] = await Promise.all([attempt, blocking]);
    if (!booked.ok) throw booked.error;
    if (!blocked.ok) throw blocked.error;
    // The block keeps new bookings out; the one made before it stays.
    expect(await appointments(f)).toEqual([{ time: '10:00' }]);
    expect(await offered(f, date)).toEqual(without('10:00', '10:30'));
  });
});

describe('who may block time', () => {
  it('needs the permission to manage calendars for every call, reading included', async () => {
    const f = await fixture();
    const date = tomorrow();
    const made: BlockedSlot = await create(f, {
      membershipId: f.membershipId,
      title: 'Private',
      startsAt: `${date}T10:00:00Z`,
      endsAt: `${date}T11:00:00Z`,
    });
    // Booking is daily work; blocking someone's time is configuring the team's availability.
    const member = manager(f, new Set(['appointments.manage']));
    for (const [operationId, input] of [
      ['listBlockedSlots', { params: { membershipId: f.membershipId } }],
      ['getBlockedSlot', { params: { blockedSlotId: made.id } }],
      [
        'createBlockedSlot',
        {
          body: {
            membershipId: f.membershipId,
            startsAt: `${date}T12:00:00Z`,
            endsAt: `${date}T13:00:00Z`,
          },
        },
      ],
      [
        'updateBlockedSlot',
        {
          params: { blockedSlotId: made.id },
          body: {
            membershipId: f.membershipId,
            startsAt: `${date}T12:00:00Z`,
            endsAt: `${date}T13:00:00Z`,
            revision: made.revision,
          },
        },
      ],
      ['deleteBlockedSlot', { params: { blockedSlotId: made.id } }],
    ] as const)
      await expect(run(member, operationId, input), operationId).rejects.toMatchObject({
        name: ForbiddenError.name,
        permission: 'calendars.manage',
      });
    expect(
      blockedSlot.parse(
        await run(manager(f), 'getBlockedSlot', { params: { blockedSlotId: made.id } }),
      ),
    ).toEqual(made);
  });

  it("never reaches another business's blocked slots, calendars or people", async () => {
    const f = await fixture();
    const date = tomorrow();
    const ours = await fixture('Ours');
    const theirs = await create(f, {
      membershipId: f.membershipId,
      title: 'Theirs alone',
      startsAt: `${date}T10:00:00Z`,
      endsAt: `${date}T11:00:00Z`,
    });
    const us = manager(ours);
    const times = { startsAt: `${date}T12:00:00Z`, endsAt: `${date}T13:00:00Z` };
    for (const [operationId, input] of [
      ['getBlockedSlot', { params: { blockedSlotId: theirs.id } }],
      ['deleteBlockedSlot', { params: { blockedSlotId: theirs.id } }],
      [
        'updateBlockedSlot',
        {
          params: { blockedSlotId: theirs.id },
          body: { membershipId: ours.membershipId, ...times, revision: theirs.revision },
        },
      ],
      ['listBlockedSlots', { params: { membershipId: f.membershipId } }],
    ] as const)
      await expect(run(us, operationId, input), operationId).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run(us, 'createBlockedSlot', { body: { membershipId: f.membershipId, ...times } }),
    ).rejects.toMatchObject({ issues: [{ path: '/membershipId', code: 'unavailable_member' }] });
    await expect(
      run(us, 'createBlockedSlot', { body: { calendarId: f.saved.calendar.id, ...times } }),
    ).rejects.toMatchObject({ issues: [{ path: '/calendarId', code: 'unknown_calendar' }] });
    // Theirs is as it was.
    expect(
      blockedSlot.parse(
        await run(manager(f), 'getBlockedSlot', { params: { blockedSlotId: theirs.id } }),
      ),
    ).toEqual(theirs);
  });
});
