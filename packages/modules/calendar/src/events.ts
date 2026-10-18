// What is on the calendar between two instants: the appointments and the blocked slots the
// Calendar view draws, with the Manage view's filters as parameters.
//
// A blocked slot is the row slots and bookings keep out of (calendar.blocked_slots, 0105):
// nothing here stores a block a second way. Its title is private, and is answered only to
// someone who may manage calendars, as the blocked slot's own read is.
//
// Both reads start from an index at the window (0057). An appointment is at most 31 days
// long (appointments_duration_bounded), so the ones that overlap a window start within 31
// days before it; a blocked slot has no longest length and is found by its end.
import { requireBusiness, type ApiRoute, type Invocation, type Route } from '@repo/commands';
import {
  appointmentStatuses,
  CALENDAR_EVENTS_LIMIT,
  calendarEventFilterIds,
  listCalendarEvents,
  parseInput,
  type CalendarEvent,
  type CalendarEvents,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import type { CalendarOptions } from './calendars.js';

/** What the calendar's events need from the modules that own the team and the contacts. */
export interface CalendarEventOptions {
  readonly members: CalendarOptions['members'];
  readonly contacts: {
    /** Each contact's shown name, by id; one the business lacks is absent. */
    readonly names: (
      trx: DatabaseTransaction,
      ids: readonly string[],
    ) => Promise<ReadonlyMap<string, { readonly name: string; readonly trashed: boolean }>>;
  };
  readonly people: {
    /** Each person's shown name, by user id. */
    readonly names: (
      trx: DatabaseTransaction,
      userIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
}

/** The longest an appointment can be, as appointments_duration_bounded keeps it. */
const LONGEST_APPOINTMENT = sql`interval '31 days'`;

/** PostgreSQL keeps microseconds; a JavaScript Date would drop them from an absence. */
const instantText = (column: string) =>
  sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type Query = z.output<typeof listCalendarEvents.query>;

/** The people a `users` filter names, as tenancy knows them now. */
async function usersOf(
  options: CalendarEventOptions,
  trx: DatabaseTransaction,
  context: TenantContext,
  filter: string | undefined,
): Promise<string[] | undefined> {
  if (filter === undefined) return undefined;
  const users: string[] = [];
  // In one order, so two readers never hold the same memberships crosswise.
  for (const membershipId of calendarEventFilterIds(filter).sort()) {
    try {
      users.push(await options.members.resolve(trx, context, membershipId));
    } catch (error) {
      // Someone who is not on this team: another business's member is no different.
      if (!(error instanceof ValidationError)) throw error;
      throw new ValidationError([
        {
          path: '/users',
          code: 'unavailable_member',
          message: 'Choose people on this business team.',
        },
      ]);
    }
  }
  return users;
}

/** The calendars a `calendars` filter names, checked under row-level security. */
async function calendarsOf(
  trx: DatabaseTransaction,
  businessId: string,
  filter: string | undefined,
): Promise<string[] | undefined> {
  if (filter === undefined) return undefined;
  const wanted = calendarEventFilterIds(filter).map((id) => parsePublicId('calendar', id) ?? '');
  const found = await trx
    .selectFrom('calendar.calendars')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', 'in', wanted)
    .execute();
  if (found.length !== wanted.length)
    throw new ValidationError([
      {
        path: '/calendars',
        code: 'unknown_calendar',
        message: 'Choose calendars of this business.',
      },
    ]);
  return wanted;
}

export async function readCalendarEvents(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: Query,
  options: CalendarEventOptions,
): Promise<CalendarEvents> {
  const businessId = requireBusiness(invocation.context);
  const users = await usersOf(options, trx, invocation.context, query.users);
  const calendars = await calendarsOf(trx, businessId, query.calendars);
  // The window's ends go to PostgreSQL as written: a JavaScript Date would cut them to the
  // millisecond, and an absence is kept to the microsecond.
  const from = sql<Date>`${query.from}::timestamptz`;
  const to = sql<Date>`${query.to}::timestamptz`;
  const canManage =
    invocation.permissions === 'all' || invocation.permissions.has('calendars.manage');
  // One more than is answered, of each kind, so the answer knows whether it was cut short.
  const bound = CALENDAR_EVENTS_LIMIT + 1;

  let appointments = trx
    .selectFrom('calendar.appointments as a')
    .innerJoin('calendar.calendars as c', (join) =>
      join.onRef('c.business_id', '=', 'a.business_id').onRef('c.id', '=', 'a.calendar_id'),
    )
    .select([
      'a.id',
      'a.title',
      'a.starts_at',
      'a.ends_at',
      'a.status',
      'a.calendar_id',
      'c.name as calendar_name',
      'a.contact_id',
      'a.assigned_user_id',
    ])
    .where('a.business_id', '=', businessId)
    .where('a.starts_at', '<', to)
    .where('a.starts_at', '>=', sql<Date>`${from} - ${LONGEST_APPOINTMENT}`)
    .where('a.ends_at', '>', from);
  if (users !== undefined) appointments = appointments.where('a.assigned_user_id', 'in', users);
  if (calendars !== undefined) appointments = appointments.where('a.calendar_id', 'in', calendars);
  const booked =
    query.type === 'blocked'
      ? []
      : await appointments.orderBy('a.starts_at').orderBy('a.id').limit(bound).execute();

  let blocks = trx
    .selectFrom('calendar.blocked_slots as x')
    .leftJoin('calendar.calendars as c', (join) =>
      join.onRef('c.business_id', '=', 'x.business_id').onRef('c.id', '=', 'x.calendar_id'),
    )
    .select([
      'x.id',
      'x.user_id',
      'x.calendar_id',
      'c.name as calendar_name',
      'x.starts_at',
      'x.title',
    ])
    .select(instantText('x.starts_at').as('starts'))
    .select(instantText('x.ends_at').as('ends'))
    .where('x.business_id', '=', businessId)
    .where('x.ends_at', '>', from)
    .where('x.starts_at', '<', to);
  if (users !== undefined) blocks = blocks.where('x.user_id', 'in', users);
  if (calendars !== undefined)
    // Those calendars' own blocks, and the people who take bookings on them, where a
    // person's block covers every calendar.
    blocks = blocks.where((eb) =>
      eb.or([
        eb('x.calendar_id', 'in', calendars),
        eb.and([
          eb('x.calendar_id', 'is', null),
          eb.exists(
            eb
              .selectFrom('calendar.calendar_members as m')
              .select('m.user_id')
              .whereRef('m.business_id', '=', 'x.business_id')
              .whereRef('m.user_id', '=', 'x.user_id')
              .where('m.calendar_id', 'in', calendars),
          ),
        ]),
      ]),
    );
  const blocked =
    query.type === 'appointments'
      ? []
      : await blocks.orderBy('x.starts_at').orderBy('x.id').limit(bound).execute();

  const people = [
    ...new Set([
      ...booked.flatMap((row) => (row.assigned_user_id === null ? [] : [row.assigned_user_id])),
      ...blocked.flatMap((row) => (row.user_id === null ? [] : [row.user_id])),
    ]),
  ];
  const memberships = await options.members.memberships(trx, invocation.context, people);
  // Named here for everyone who reads the calendar, as the appointment list names them: a
  // name only, never how to reach the person.
  const names = await options.people.names(trx, [...memberships.keys()]);
  const contacts = await options.contacts.names(
    trx,
    booked.map((row) => row.contact_id),
  );
  const person = (userId: string) => ({
    membershipId: memberships.get(userId) ?? null,
    you: invocation.context.actorKind === 'user' && invocation.context.userId === userId,
    name: memberships.has(userId) ? (names.get(userId) ?? '') : '',
  });

  const events: { readonly at: number; readonly order: string; readonly event: CalendarEvent }[] = [
    ...booked.map((row) => ({
      at: row.starts_at.getTime(),
      order: `0${row.id}`,
      event: {
        kind: 'appointment' as const,
        id: toPublicId('appointment', row.id),
        title: row.title,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        // The table's own constraint allows nothing else (appointments_status_valid).
        status: z.enum(appointmentStatuses).parse(row.status),
        calendar: { id: toPublicId('calendar', row.calendar_id), name: row.calendar_name },
        contact: {
          id: toPublicId('contact', row.contact_id),
          name: contacts.get(row.contact_id)?.name ?? '',
          trashed: contacts.get(row.contact_id)?.trashed ?? false,
        },
        assignee: row.assigned_user_id === null ? null : person(row.assigned_user_id),
      },
    })),
    // A block outlives its person's place on the team, and gives them none: someone who
    // has left blocks nothing, and is not shown. A whole calendar's block names nobody.
    ...blocked
      .filter((row) => row.user_id === null || memberships.has(row.user_id))
      .map((row) => ({
        at: row.starts_at.getTime(),
        order: `1${row.starts}${row.id}`,
        event: {
          kind: 'blocked' as const,
          id: toPublicId('blocked_slot', row.id),
          startsAt: row.starts,
          endsAt: row.ends,
          user: row.user_id === null ? null : person(row.user_id),
          calendar:
            row.calendar_id === null
              ? null
              : {
                  id: toPublicId('calendar', row.calendar_id),
                  // The foreign key keeps the calendar while its block exists.
                  name: row.calendar_name ?? '',
                },
          title: canManage ? row.title : null,
        },
      })),
  ].sort((left, right) => left.at - right.at || left.order.localeCompare(right.order));

  return {
    items: events.slice(0, CALENDAR_EVENTS_LIMIT).map(({ event }) => event),
    truncated:
      booked.length > CALENDAR_EVENTS_LIMIT ||
      blocked.length > CALENDAR_EVENTS_LIMIT ||
      events.length > CALENDAR_EVENTS_LIMIT,
    canManage,
  };
}

/** The calendar's events as an API route, for the server to compose with its ports. */
export function createCalendarEventRoutes(options: CalendarEventOptions): readonly ApiRoute[] {
  return [
    {
      endpoint: listCalendarEvents,
      run: ({ invocation, query }, { db }) => {
        requireBusiness(invocation.context);
        const parsed = parseInput(listCalendarEvents.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readCalendarEvents(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof listCalendarEvents>,
  ];
}
