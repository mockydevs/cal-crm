// The numbers behind the Dashboard's booking widgets: appointments by status, by calendar
// and by team member over a range of dates, with one row for each day, and how many are
// coming up. They are counted from the appointments themselves in the request. How often an
// appointment was moved is not kept on it, and is not here.
import * as z from 'zod';

import { appointmentStatuses } from './calendar-events.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { checkReportRange, reportDay, reportRange, reportRangeAnswer } from './report-range.js';
import { timestamp } from './timestamps.js';

/** How far ahead "upcoming" looks, from the moment of the read. */
export const APPOINTMENT_REPORT_UPCOMING_DAYS = 7;

/** Which of an appointment's dates must fall in the range: when it starts, or when it was booked. */
export const appointmentReportDates = ['starts', 'created'] as const;
export type AppointmentReportDate = (typeof appointmentReportDates)[number];

export const appointmentReportQuery = z
  .strictObject({
    ...reportRange,
    dateProperty: z.enum(appointmentReportDates).default('starts').meta({
      description:
        'starts counts an appointment on the day it takes place; created on the day it was booked.',
    }),
  })
  .superRefine(checkReportRange)
  .meta({ id: 'AppointmentReportQuery' });

const count = z.int().min(0);
const statuses = z.array(z.looseObject({ status: z.enum(appointmentStatuses), count })).meta({
  description:
    'How many have each status, as they are now. Always booked, confirmed, cancelled, no_show, completed and invalid, in that order. completed is an appointment the contact showed up for.',
});
const tally = {
  count: count.meta({ description: 'Every appointment counted here, whatever its status.' }),
  statuses,
};

export const appointmentReport = z
  .looseObject({
    ...reportRangeAnswer,
    dateProperty: z.enum(appointmentReportDates),
    ...tally,
    days: z.array(z.looseObject({ date: reportDay, ...tally })).meta({
      description:
        "One row for each calendar day of the range in the business's time zone, in order, with zeros on a day without appointments. The first and the last are part days when the range does not start and end at midnight there.",
    }),
    calendars: z
      .array(
        z.looseObject({
          calendar: z.looseObject({ id: publicId('calendar'), name: z.string() }),
          ...tally,
        }),
      )
      .meta({
        description:
          'The calendars with an appointment in the range: the busiest first, then by name.',
      }),
    teamMembers: z
      .array(
        z.looseObject({
          assignee: z
            .looseObject({
              membershipId: publicId('membership').nullable().meta({
                description: 'Null when the person is no longer on the team.',
              }),
              name: z.string(),
            })
            .nullable()
            .meta({ description: 'Null for the appointments nobody is assigned to.' }),
          ...tally,
        }),
      )
      .meta({
        description:
          'The people with an appointment in the range: the busiest first, then by name. Unassigned appointments are one row of their own.',
      }),
    upcoming: z
      .looseObject({
        from: timestamp,
        to: timestamp,
        count,
      })
      .meta({
        description: `Booked and confirmed appointments that start in the next ${String(APPOINTMENT_REPORT_UPCOMING_DAYS)} days from the moment of the read, whatever the range asked for.`,
      }),
  })
  .meta({ id: 'AppointmentReport' });
export type AppointmentReport = z.output<typeof appointmentReport>;

export const getAppointmentReport = defineEndpoint({
  operationId: 'getAppointmentReport',
  method: 'get',
  path: '/reports/appointments',
  summary: "Read the numbers of the dashboard's booking widgets for a range of dates",
  group: 'Reports',
  query: appointmentReportQuery,
  response: {
    status: 200,
    description:
      'Counted from the appointments whose date falls in the range, as they are now: one moved or cancelled since is counted where and as it is today. An appointment is in the range by when it starts, unless dateProperty asks for when it was booked.',
    schema: appointmentReport,
  },
});

export const appointmentReportEndpoints = [getAppointmentReport] as const;
