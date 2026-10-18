// The numbers of the Dashboard's booking widgets over a range of dates. One pass over the
// business's appointments dated in the range, read from an index on the business and that
// date (appointments_window_idx for when they start, 0057; appointments_created_idx for
// when they were booked, 0066), counted by PostgreSQL three ways at once: by day in the
// business's time zone, by calendar and by assignee, each by status. Only the counts leave
// the database: the numbers are put together from them in appointment-report-rules.ts.
// Nothing is stored.
//
// How often an appointment was moved is not answered: the appointment keeps no mark of it.
// A booker's own move is in calendar.appointment_operations and every move is an
// appointment.rescheduled event, but the team's moves are in no table of this module.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  APPOINTMENT_REPORT_UPCOMING_DAYS,
  appointmentStatuses,
  type AppointmentReport,
  type appointmentReportQuery,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { appointmentNumbers, type AppointmentCount } from './appointment-report-rules.js';
import type { AppointmentReadOptions } from './appointments.js';

const status = z.enum(appointmentStatuses);
const by = z.enum(['day', 'calendar', 'assignee']);

export async function readAppointmentReport(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof appointmentReportQuery>,
  options: Pick<AppointmentReadOptions, 'members' | 'people'>,
): Promise<AppointmentReport> {
  const businessId = requireBusiness(invocation.context);
  // The range's ends go to PostgreSQL as written: a JavaScript Date would cut them to the
  // millisecond. The last day is the one the range's last microsecond falls on.
  const from = sql`${query.from}::timestamptz`;
  const to = sql`${query.to}::timestamptz`;
  const {
    rows: [range],
  } = await sql<{ time_zone: string; days: string[] }>`
    select b.timezone as time_zone,
      array(
        select to_char(day, 'YYYY-MM-DD')
        from generate_series(
          (${from} at time zone b.timezone)::date::timestamp,
          ((${to} - interval '1 microsecond') at time zone b.timezone)::date::timestamp,
          interval '1 day'
        ) as day
        order by day
      ) as days
    from tenancy.businesses b
    where b.id = ${businessId}
  `.execute(trx);
  if (range === undefined) throw new Error('The business of this request is not there.');

  const dated = query.dateProperty === 'created' ? sql`a.created_at` : sql`a.starts_at`;
  const { rows } = await sql<{
    counted_by: string;
    key: string;
    status: string;
    count: number;
  }>`
    select case when grouping(counted.day) = 0 then 'day'
                when grouping(counted.calendar_id) = 0 then 'calendar'
                else 'assignee' end as counted_by,
           case when grouping(counted.day) = 0 then to_char(counted.day, 'YYYY-MM-DD')
                when grouping(counted.calendar_id) = 0 then counted.calendar_id::text
                else coalesce(counted.assigned_user_id::text, '') end as key,
           counted.status, count(*)::integer as count
    from (
      select (${dated} at time zone b.timezone)::date as day, a.calendar_id,
             a.assigned_user_id, a.status
      from calendar.appointments a
      join tenancy.businesses b on b.id = a.business_id
      where a.business_id = ${businessId} and ${dated} >= ${from} and ${dated} < ${to}
    ) counted
    group by grouping sets (
      (counted.day, counted.status),
      (counted.calendar_id, counted.status),
      (counted.assigned_user_id, counted.status)
    )
  `.execute(trx);
  const counts: AppointmentCount[] = rows.map((row) => ({
    // The statement above names nothing else, and the table's own constraint allows no
    // other status (appointments_status_valid).
    by: by.parse(row.counted_by),
    key: row.key,
    status: status.parse(row.status),
    count: row.count,
  }));

  const keysOf = (kind: AppointmentCount['by']) => [
    ...new Set(counts.flatMap((each) => (each.by === kind && each.key !== '' ? [each.key] : []))),
  ];
  const calendarIds = keysOf('calendar');
  const calendars =
    calendarIds.length === 0
      ? []
      : await trx
          .selectFrom('calendar.calendars')
          .select(['id', 'name'])
          .where('business_id', '=', businessId)
          .where('id', 'in', calendarIds)
          .execute();
  const userIds = keysOf('assignee');
  const memberships = await options.members.memberships(trx, invocation.context, userIds);
  const names = await options.people.names(trx, userIds);

  // What is coming up, by the database's clock: the appointments that still hold time.
  const {
    rows: [upcoming],
  } = await sql<{ from: Date; to: Date; count: number }>`
    select w.starts as "from", w.ends as "to",
      (select count(*)::integer from calendar.appointments a
       where a.business_id = ${businessId} and a.status in ('booked', 'confirmed')
         and a.starts_at >= w.starts and a.starts_at < w.ends) as count
    from (select now() as starts,
                 now() + make_interval(days => ${APPOINTMENT_REPORT_UPCOMING_DAYS}::integer) as ends) w
  `.execute(trx);
  if (upcoming === undefined) throw new Error('A select without a table gave no row.');

  return {
    from: query.from,
    to: query.to,
    timeZone: range.time_zone,
    dateProperty: query.dateProperty,
    ...appointmentNumbers(range.days, counts, {
      calendars: new Map(
        calendars.map((each) => [
          each.id,
          { id: toPublicId('calendar', each.id), name: each.name },
        ]),
      ),
      people: new Map(
        userIds.map((userId) => [
          userId,
          { membershipId: memberships.get(userId) ?? null, name: names.get(userId) ?? '' },
        ]),
      ),
    }),
    upcoming: {
      from: upcoming.from.toISOString(),
      to: upcoming.to.toISOString(),
      count: upcoming.count,
    },
  };
}
