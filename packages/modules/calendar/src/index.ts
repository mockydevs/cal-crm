import { requireBusiness, requirePermission, runCommand, type ApiRoute } from '@repo/commands';
export { createCalendarProposables } from './proposals.js';
export { calendarContactMerge } from './contact-merge.js';
export { readCalendar } from './calendars.js';
import {
  createCalendar,
  deleteCalendar,
  getCalendar,
  getCalendarAvailability,
  updateCalendar,
  updateCalendarInput,
  updateCalendarAvailability,
  updateCalendarAvailabilityInput,
  parseInput,
  listCalendars,
  listCalendarSenders,
  cancelAppointment,
  cancelAppointmentInput,
  createAppointment,
  createAppointmentInput,
  getAppointment,
  getAppointmentReport,
  listAppointments,
  rescheduleAppointment,
  rescheduleAppointmentInput,
  setAppointmentNotes,
  setAppointmentNotesInput,
  setAppointmentStatus,
  setAppointmentStatusInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  createCalendarCommand,
  deleteCalendarCommand,
  updateCalendarCommand,
  updateCalendarAvailabilityCommand,
  readCalendar,
  readCalendars,
  type CalendarOptions,
} from './calendars.js';

import { calendarGroupRoutes } from './calendar-groups.js';
import { userAvailabilityRoutes } from './user-availability-management.js';
import { readAppointmentReport } from './appointment-report.js';
import { readAppointment, readAppointments } from './appointments.js';
import {
  cancelAppointmentCommand,
  createAppointmentCommand,
  freshenBeforeTeamBooking,
  rescheduleAppointmentCommand,
  setAppointmentNotesCommand,
  setAppointmentStatusCommand,
  type AppointmentOptions,
} from './appointment-staff.js';

export type { CalendarOptions } from './calendars.js';
export type { AppointmentOptions } from './appointment-staff.js';
export { createCalendarEventRoutes, type CalendarEventOptions } from './events.js';
export { createBlockedSlotRoutes, type BlockedSlotOptions } from './blocked-slots.js';
export { BookingTooSoonError, createPublicBookingHandlers } from './booking.js';
export { appointmentManageUrl, type AppointmentLinkInstall } from './appointment-links.js';
export * from './google/index.js';
export type {
  PublicBookingHandlers,
  PublicBookingOptions,
  PublicBookingRequestContext,
} from './public-routes.js';
export function createCalendarRoutes(options: CalendarOptions): readonly ApiRoute[] {
  const create = createCalendarCommand(options);
  const update = updateCalendarCommand(options);
  const availability = updateCalendarAvailabilityCommand(options);
  const remove = deleteCalendarCommand(options);
  return [
    ...userAvailabilityRoutes(options),
    ...calendarGroupRoutes,
    {
      endpoint: deleteCalendar,
      command: remove,
      run: ({ invocation, params }, services) =>
        runCommand(services, remove, parseInput(deleteCalendar.params, params), invocation),
    },
    {
      endpoint: listCalendarSenders,
      async run({ invocation, query }, services) {
        await requirePermission(
          services,
          { name: 'calendar.senders.list', permission: 'calendars.manage' },
          invocation,
        );
        requireBusiness(invocation.context);
        const input = parseInput(listCalendarSenders.query, query);
        return withTenant(services.db, invocation.context, (trx) =>
          options.senders.choices(trx, invocation.context, input),
        );
      },
    },
    {
      endpoint: listCalendars,
      run: ({ invocation, query }, { db }) => {
        const input = parseInput(listCalendars.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readCalendars(trx, invocation, input, options),
        );
      },
    },
    {
      endpoint: updateCalendarAvailability,
      command: availability,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          availability,
          {
            ...parseInput(updateCalendarAvailabilityInput, body),
            ...parseInput(updateCalendarAvailability.params, params),
          },
          invocation,
        ),
    },
    {
      endpoint: updateCalendar,
      command: update,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          update,
          {
            ...parseInput(updateCalendar.params, params),
            settings: parseInput(updateCalendarInput, body),
          },
          invocation,
        ),
    },
    {
      endpoint: createCalendar,
      command: create,
      run: ({ invocation, body }, services) => runCommand(services, create, body, invocation),
    },
    {
      endpoint: getCalendar,
      run: ({ invocation, params }, { db }) => {
        requireBusiness(invocation.context);
        const { id } = parseInput(getCalendar.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readCalendar(trx, invocation, id, options),
        );
      },
    },
    {
      endpoint: getCalendarAvailability,
      run: ({ invocation, params, query }, { db }) => {
        requireBusiness(invocation.context);
        const { id } = parseInput(getCalendarAvailability.params, params);
        const { date } = parseInput(getCalendarAvailability.query, query);
        return withTenant(db, invocation.context, async (trx) => {
          const current = await readCalendar(trx, invocation, id, options);
          const override = current.dateOverrides.find((item) => item.date === date);
          const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
          return {
            date,
            timezone: current.calendar.timezone,
            source: override === undefined ? 'weekly' : 'override',
            ranges:
              override?.ranges ??
              current.weeklyHours
                .filter((item) => item.weekday === weekday)
                .map(({ startTime, endTime }) => ({ startTime, endTime })),
          };
        });
      },
    },
  ];
}

/**
 * Appointments as the team works with them: the list, one appointment, and booking, moving,
 * cancelling, marking and writing the notes of one. Any member of the business reads;
 * changing needs `appointments.manage`.
 */
export function createAppointmentRoutes(options: AppointmentOptions): readonly ApiRoute[] {
  const book = createAppointmentCommand(options);
  const reschedule = rescheduleAppointmentCommand(options);
  const cancel = cancelAppointmentCommand(options);
  const mark = setAppointmentStatusCommand(options);
  const write = setAppointmentNotesCommand(options);
  return [
    {
      endpoint: listAppointments,
      run: ({ invocation, query }, { db }) => {
        requireBusiness(invocation.context);
        const parsed = parseInput(listAppointments.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readAppointments(trx, invocation, parsed, options),
        );
      },
    },
    {
      endpoint: createAppointment,
      command: book,
      run: async ({ invocation, body }, services) => {
        // A fresh look at Google first, as the booking page has.
        const asked = createAppointmentInput.safeParse(body);
        if (asked.success)
          await freshenBeforeTeamBooking(options, services.db, invocation, asked.data);
        return runCommand(services, book, body, invocation);
      },
    },
    {
      endpoint: getAppointment,
      run: ({ invocation, params }, { db }) => {
        requireBusiness(invocation.context);
        const { id } = parseInput(getAppointment.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readAppointment(trx, invocation, id, options),
        );
      },
    },
    {
      endpoint: rescheduleAppointment,
      command: reschedule,
      run: async ({ invocation, params, body }, services) => {
        const input = {
          ...parseInput(rescheduleAppointmentInput, body),
          ...parseInput(rescheduleAppointment.params, params),
        };
        await freshenBeforeTeamBooking(options, services.db, invocation, {
          appointmentId: input.id,
          startsAt: input.startsAt,
          ignoreAvailability: input.ignoreAvailability,
        });
        return runCommand(services, reschedule, input, invocation);
      },
    },
    {
      endpoint: cancelAppointment,
      command: cancel,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          cancel,
          {
            ...parseInput(cancelAppointmentInput, body),
            ...parseInput(cancelAppointment.params, params),
          },
          invocation,
        ),
    },
    {
      endpoint: setAppointmentStatus,
      command: mark,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          mark,
          {
            ...parseInput(setAppointmentStatusInput, body),
            ...parseInput(setAppointmentStatus.params, params),
          },
          invocation,
        ),
    },
    {
      endpoint: setAppointmentNotes,
      command: write,
      run: ({ invocation, params, body }, services) =>
        runCommand(
          services,
          write,
          {
            ...parseInput(setAppointmentNotesInput, body),
            ...parseInput(setAppointmentNotes.params, params),
          },
          invocation,
        ),
    },
    // The numbers behind the Dashboard's booking widgets.
    {
      endpoint: getAppointmentReport,
      run: ({ invocation, query }, { db }) => {
        requireBusiness(invocation.context);
        const parsed = parseInput(getAppointmentReport.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readAppointmentReport(trx, invocation, parsed, options),
        );
      },
    },
  ];
}
