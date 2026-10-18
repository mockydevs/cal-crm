// Appointments as the team reads them: the Appointment list view's page of rows with how
// many match, and one appointment with what its panel shows.
//
// Paging is by keyset, as the task list's is: the cursor is the last appointment of the
// page before, and its place in the order is read in SQL from that appointment, so nothing
// about the order is in the cursor and no precision is lost. An appointment that was moved,
// renamed or cancelled since is still a place to read on from.
//
// An appointment's history is its own events in the event log, which every command that
// changes one writes in the same transaction.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  APPOINTMENT_HISTORY_LIMIT,
  appointmentHistoryTypes,
  appointmentSources,
  appointmentStatuses,
  type AppointmentDetail,
  type AppointmentList,
  type AppointmentRow,
  type listAppointments,
} from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import {
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type PublicIdKind,
  type TenantContext,
} from '@repo/kernel';
import { sql, type RawBuilder, type Selectable, type SqlBool } from 'kysely';
import * as z from 'zod';

import { teamRevisionOf } from './appointment-management.js';
import type { CalendarOptions } from './calendars.js';
import type { CalendarEventOptions } from './events.js';

/** What reading appointments needs from the modules that own the team and the contacts. */
export interface AppointmentReadOptions {
  readonly members: CalendarOptions['members'];
  readonly contacts: { readonly names: CalendarEventOptions['contacts']['names'] };
  readonly people: {
    /** Each person's shown name, by user id. */
    readonly names: (
      trx: DatabaseTransaction,
      userIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
}

type Query = z.output<typeof listAppointments.query>;
type Stored = Selectable<DB['calendar.appointments']>;
type Listed = Stored & { readonly calendar_name: string };

/** Whether the reader may book and change appointments. */
export function mayManageAppointments(invocation: Invocation): boolean {
  return invocation.permissions === 'all' || invocation.permissions.has('appointments.manage');
}

/**
 * The stored id a public id names. The contracts let only well-formed ids of the right kind
 * this far, so a refusal here is of a caller that skipped them.
 */
export function storedId(kind: PublicIdKind, id: string): string {
  const stored = parsePublicId(kind, id);
  if (stored === undefined)
    throw new ValidationError([
      { path: '', code: 'invalid_id', message: 'Use an id this API gave you.' },
    ]);
  return stored;
}

/** The entries of an object that have a value. */
const present = <Shape extends object>(shape: Shape): Partial<Shape> =>
  Object.fromEntries(
    Object.entries(shape).filter(([, value]) => value !== undefined),
  ) as Partial<Shape>;

/** A pattern for any part of a text, taking % and _ as written. */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, String.raw`\$&`)}%`;

/** What each order compares, on the list's rows (a) and on the row a page starts after (k). */
const orderOf: Record<Query['sort'], (alias: 'a' | 'k') => RawBuilder<unknown>> = {
  startsAt: (alias) => sql.ref(`${alias}.starts_at`),
  createdAt: (alias) => sql.ref(`${alias}.created_at`),
  // Without regard to case, as a reader expects a list of titles to run.
  title: (alias) => sql`lower(${sql.ref(`${alias}.title`)})`,
};

async function conditionsOf(
  trx: DatabaseTransaction,
  context: TenantContext,
  businessId: string,
  query: Query,
  options: AppointmentReadOptions,
): Promise<RawBuilder<SqlBool>[]> {
  const kept: RawBuilder<SqlBool>[] = [];
  if (query.view === 'upcoming') kept.push(sql`(a.status <> 'cancelled' and a.ends_at > now())`);
  if (query.view === 'cancelled') kept.push(sql`a.status = 'cancelled'`);
  if (query.status !== undefined) kept.push(sql`a.status = ${query.status}`);
  if (query.calendar !== undefined) {
    const calendarId = storedId('calendar', query.calendar);
    const found = await trx
      .selectFrom('calendar.calendars')
      .select('id')
      .where('business_id', '=', businessId)
      .where('id', '=', calendarId)
      .executeTakeFirst();
    if (found === undefined)
      throw new ValidationError([
        {
          path: '/calendar',
          code: 'unknown_calendar',
          message: 'Choose a calendar of this business.',
        },
      ]);
    kept.push(sql`a.calendar_id = ${calendarId}`);
  }
  if (query.user !== undefined) {
    let userId: string;
    try {
      userId = await options.members.resolve(trx, context, query.user);
    } catch (error) {
      // Someone who is not on this team: another business's member is no different.
      if (!(error instanceof ValidationError)) throw error;
      throw new ValidationError([
        {
          path: '/user',
          code: 'unavailable_member',
          message: 'Choose someone on this business team.',
        },
      ]);
    }
    kept.push(sql`a.assigned_user_id = ${userId}`);
  }
  if (query.contact !== undefined)
    kept.push(sql`a.contact_id = ${storedId('contact', query.contact)}`);
  // Compared in PostgreSQL: a Date would drop anything finer than a millisecond.
  if (query.from !== undefined) kept.push(sql`a.starts_at >= ${query.from}::timestamptz`);
  if (query.to !== undefined) kept.push(sql`a.starts_at < ${query.to}::timestamptz`);
  if (query.q !== undefined && query.q !== '') kept.push(sql`a.title ilike ${containing(query.q)}`);
  return kept;
}

interface Lookups {
  readonly memberships: ReadonlyMap<string, string>;
  readonly names: ReadonlyMap<string, string>;
  readonly contacts: ReadonlyMap<string, { readonly name: string; readonly trashed: boolean }>;
}

async function lookupsFor(
  trx: DatabaseTransaction,
  context: TenantContext,
  rows: readonly Stored[],
  options: AppointmentReadOptions,
  alsoPeople: readonly string[] = [],
): Promise<Lookups> {
  const assigned = [
    ...new Set(
      rows.flatMap((row) => (row.assigned_user_id === null ? [] : [row.assigned_user_id])),
    ),
  ];
  return {
    memberships: await options.members.memberships(trx, context, assigned),
    names: await options.people.names(trx, [...new Set([...assigned, ...alsoPeople])]),
    contacts: await options.contacts.names(
      trx,
      rows.map((row) => row.contact_id),
    ),
  };
}

function rowOf(row: Listed, context: TenantContext, lookups: Lookups): AppointmentRow {
  const contact = lookups.contacts.get(row.contact_id) ?? { name: '', trashed: false };
  return {
    kind: 'appointment',
    id: toPublicId('appointment', row.id),
    title: row.title,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    // The table's own constraints allow nothing else (appointments_status_valid,
    // appointments_source_valid).
    status: z.enum(appointmentStatuses).parse(row.status),
    calendar: { id: toPublicId('calendar', row.calendar_id), name: row.calendar_name },
    contact: {
      id: toPublicId('contact', row.contact_id),
      name: contact.name,
      trashed: contact.trashed,
    },
    assignee:
      row.assigned_user_id === null
        ? null
        : {
            membershipId: lookups.memberships.get(row.assigned_user_id) ?? null,
            you: context.actorKind === 'user' && context.userId === row.assigned_user_id,
            name: lookups.names.get(row.assigned_user_id) ?? '',
          },
    createdAt: row.created_at.toISOString(),
    source: z.enum(appointmentSources).parse(row.source),
  };
}

const listed = (trx: DatabaseTransaction, businessId: string) =>
  trx
    .selectFrom('calendar.appointments as a')
    .innerJoin('calendar.calendars as c', (join) =>
      join.onRef('c.business_id', '=', 'a.business_id').onRef('c.id', '=', 'a.calendar_id'),
    )
    .where('a.business_id', '=', businessId);

export async function readAppointments(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: Query,
  options: AppointmentReadOptions,
): Promise<AppointmentList> {
  const businessId = requireBusiness(invocation.context);
  const kept = await conditionsOf(trx, invocation.context, businessId, query, options);

  let counted = listed(trx, businessId).select(sql<number>`count(*)::int`.as('total'));
  for (const condition of kept) counted = counted.where(condition);
  const { total } = await counted.executeTakeFirstOrThrow();

  let page = listed(trx, businessId).selectAll('a').select('c.name as calendar_name');
  for (const condition of kept) page = page.where(condition);
  if (query.after !== undefined) {
    const afterId = storedId('appointment', query.after);
    const start = await trx
      .selectFrom('calendar.appointments')
      .select('id')
      .where('business_id', '=', businessId)
      .where('id', '=', afterId)
      .executeTakeFirst();
    if (start === undefined)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_appointment',
          message: 'Start after an appointment of this business.',
        },
      ]);
    const place = sql`(select ${orderOf[query.sort]('k')}, k.id from calendar.appointments k
      where k.business_id = ${businessId} and k.id = ${afterId})`;
    page = page.where(
      query.direction === 'asc'
        ? sql<SqlBool>`(${orderOf[query.sort]('a')}, a.id) > ${place}`
        : sql<SqlBool>`(${orderOf[query.sort]('a')}, a.id) < ${place}`,
    );
  }
  const rows = await page
    .orderBy(orderOf[query.sort]('a'), query.direction)
    .orderBy('a.id', query.direction)
    .limit(query.limit + 1)
    .execute();
  const shown = rows.slice(0, query.limit);
  const lookups = await lookupsFor(trx, invocation.context, shown, options);
  const last = shown.at(-1);
  return {
    items: shown.map((row) => rowOf(row, invocation.context, lookups)),
    next:
      rows.length > query.limit && last !== undefined ? toPublicId('appointment', last.id) : null,
    total,
    canManage: mayManageAppointments(invocation),
  };
}

const historyType = z.enum(appointmentHistoryTypes);
const historyPayload = z.looseObject({
  status: z.enum(appointmentStatuses).optional().catch(undefined),
  previousStatus: z.enum(appointmentStatuses).optional().catch(undefined),
  startsAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
  endsAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

async function historyOf(
  trx: DatabaseTransaction,
  businessId: string,
  appointmentId: string,
): Promise<
  {
    readonly type: z.output<typeof historyType>;
    readonly at: Date;
    readonly actorKind: string;
    readonly actorId: string | null;
    readonly payload: z.output<typeof historyPayload>;
  }[]
> {
  const events = await trx
    .selectFrom('events.events')
    .select(['type', 'occurred_at', 'actor_kind', 'actor_id', 'payload'])
    .where('business_id', '=', businessId)
    .where('subject_kind', '=', 'appointment')
    .where('subject_id', '=', appointmentId)
    .where(
      'type',
      'in',
      appointmentHistoryTypes.map((type) => `appointment.${type}`),
    )
    .orderBy('recorded_at', 'desc')
    .orderBy('id', 'desc')
    .limit(APPOINTMENT_HISTORY_LIMIT)
    .execute();
  return events.reverse().map((event) => ({
    type: historyType.parse(event.type.slice('appointment.'.length)),
    at: event.occurred_at,
    actorKind: event.actor_kind,
    actorId: event.actor_id,
    payload: historyPayload.parse(event.payload),
  }));
}

/** One appointment of the business, or the same not-found whether it is another's or nobody's. */
export async function readAppointment(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: AppointmentReadOptions,
): Promise<AppointmentDetail> {
  const businessId = requireBusiness(invocation.context);
  const row = await listed(trx, businessId)
    .selectAll('a')
    .select(['c.name as calendar_name', 'c.timezone as calendar_timezone'])
    .where('a.id', '=', storedId('appointment', id))
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Appointment', id);
  const history = await historyOf(trx, businessId, row.id);
  const lookups = await lookupsFor(trx, invocation.context, [row], options, [
    ...(row.created_by_user_id === null ? [] : [row.created_by_user_id]),
    ...history.flatMap((entry) =>
      entry.actorKind === 'user' && entry.actorId !== null ? [entry.actorId] : [],
    ),
  ]);
  return {
    ...rowOf(row, invocation.context, lookups),
    notes: row.notes,
    location: row.location,
    timezone: row.calendar_timezone,
    updatedAt: row.updated_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    createdBy:
      row.created_by_user_id === null
        ? null
        : { name: lookups.names.get(row.created_by_user_id) ?? '' },
    revision: teamRevisionOf(row),
    canManage: mayManageAppointments(invocation),
    history: history.map((entry) => ({
      type: entry.type,
      at: entry.at.toISOString(),
      actor: {
        kind: entry.actorKind,
        // Only people were looked up: a booker, a key or the system has no name here.
        name: lookups.names.get(entry.actorId ?? '') ?? null,
      },
      ...present({
        status: entry.payload.status,
        previousStatus: entry.payload.previousStatus,
        startsAt: entry.payload.startsAt,
        endsAt: entry.payload.endsAt,
      }),
    })),
  };
}
