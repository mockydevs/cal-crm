// Appointments as the team works with them: the Appointment list view's rows, one
// appointment with everything its panel shows, and the five things a signed-in person does
// to one: book, move, cancel, mark and write its notes.
//
// The booking page's own contract is booking.ts: a booker acts by a link, with no account.
// What the Calendar view draws between two instants is calendar-events.ts.
import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';
import { appointmentStatuses, calendarAppointmentEvent } from './calendar-events.js';

/** The longest note and the longest place an appointment keeps. */
export const APPOINTMENT_NOTES_MAX = 5000;
export const APPOINTMENT_LOCATION_MAX = 500;
export const APPOINTMENT_CANCEL_REASON_MAX = 500;
/** The most history entries one appointment answers: its newest. */
export const APPOINTMENT_HISTORY_LIMIT = 100;

export const listAppointmentsQuery = z
  .strictObject({
    view: z.enum(['upcoming', 'cancelled', 'all']).default('upcoming').meta({
      description:
        'upcoming: not cancelled and not yet over. cancelled: cancelled appointments. all: every appointment.',
    }),
    sort: z.enum(['startsAt', 'title', 'createdAt']).default('startsAt'),
    direction: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    calendar: publicId('calendar').optional(),
    user: publicId('membership').optional().meta({
      description: 'Appointments assigned to this team member.',
    }),
    contact: publicId('contact').optional().meta({
      description: "One contact's appointments.",
    }),
    after: publicId('appointment').optional().meta({
      description:
        "Start after this appointment: the previous page's next, with the same sort and direction.",
    }),
    q: z.string().trim().max(200).optional().meta({
      description: 'Any part of the title, in either case.',
    }),
    status: z.enum(appointmentStatuses).optional(),
    from: timestamp.optional().meta({ description: 'Starting at or after this instant.' }),
    to: timestamp.optional().meta({ description: 'Starting before this instant.' }),
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.to) > Date.parse(query.from),
    {
      path: ['to'],
      error: 'End the window after it starts.',
    },
  );

/** How an appointment came to be, as calendar.appointments keeps it. */
export const appointmentSources = [
  'booking_page',
  'user',
  'ai_agent',
  'automation',
  'api',
  'import',
] as const;

export const appointmentRow = calendarAppointmentEvent
  .extend({
    assignee: z
      .looseObject({
        membershipId: publicId('membership').nullable().meta({
          description: 'Null when the person is no longer on the team.',
        }),
        you: z.boolean(),
        name: z.string().meta({
          description:
            "The appointment owner's name. Empty when the person has left the team and no longer shows to this business.",
        }),
      })
      .nullable()
      .meta({ description: 'Null when nobody is assigned.' }),
    createdAt: timestamp,
    source: z.enum(appointmentSources),
  })
  .meta({ id: 'AppointmentRow' });
export type AppointmentRow = z.output<typeof appointmentRow>;

export const appointmentList = z
  .looseObject({
    items: z.array(appointmentRow),
    next: publicId('appointment').nullable(),
    total: z.int().min(0).meta({
      description: 'How many appointments match the filters, on whichever page.',
    }),
    canManage: z.boolean().meta({ description: 'Whether you may book and change appointments.' }),
  })
  .meta({ id: 'AppointmentList' });
export type AppointmentList = z.output<typeof appointmentList>;

export const listAppointments = defineEndpoint({
  operationId: 'listAppointments',
  method: 'get',
  path: '/appointments',
  group: 'Calendars',
  summary: 'List appointments with filters and paging',
  query: listAppointmentsQuery,
  response: { status: 200, description: 'A page of appointments.', schema: appointmentList },
});

const revision = z.string().regex(/^[0-9a-f]{64}$/);

/** What happened to an appointment, as its history tells it. */
export const appointmentHistoryTypes = [
  'booked',
  'rescheduled',
  'cancelled',
  'status_changed',
] as const;

export const appointmentHistoryEntry = z
  .looseObject({
    type: z.enum(appointmentHistoryTypes),
    at: timestamp,
    actor: z.looseObject({
      kind: z.string().meta({
        description: 'user for someone of the team, contact for the booker, or another actor kind.',
      }),
      name: z.string().nullable().meta({ description: 'Null when the actor has no name.' }),
    }),
    status: z.enum(appointmentStatuses).optional(),
    previousStatus: z.enum(appointmentStatuses).optional(),
    startsAt: timestamp.optional(),
    endsAt: timestamp.optional(),
  })
  .meta({ id: 'AppointmentHistoryEntry' });

export const appointmentDetail = appointmentRow
  .extend({
    notes: z.string(),
    location: z.string().nullable(),
    timezone: z.string().meta({ description: "The calendar's time zone." }),
    updatedAt: timestamp,
    cancelledAt: timestamp.nullable(),
    cancelReason: z.string().nullable(),
    createdBy: z.looseObject({ name: z.string() }).nullable().meta({
      description:
        'Who of the team booked it. Null when the booking page did, or nobody is recorded.',
    }),
    revision: revision.meta({
      description: 'Send it back with a change: one made since refuses the change.',
    }),
    canManage: z.boolean(),
    history: z.array(appointmentHistoryEntry).meta({
      description: `What happened to it, oldest first: at most its newest ${String(APPOINTMENT_HISTORY_LIMIT)} entries.`,
    }),
  })
  .meta({ id: 'AppointmentDetail' });
export type AppointmentDetail = z.output<typeof appointmentDetail>;

const appointmentParams = z.strictObject({ id: publicId('appointment') });

export const getAppointment = defineEndpoint({
  operationId: 'getAppointment',
  method: 'get',
  path: '/appointments/{id}',
  group: 'Calendars',
  summary: 'Read one appointment',
  params: appointmentParams,
  response: { status: 200, description: 'The appointment.', schema: appointmentDetail },
});

const ignoreAvailability = z.boolean().default(false).meta({
  description:
    "True books a time the calendar does not offer: outside its hours, notice and range, and in the person's blocked time. Nobody is ever booked twice at the same time.",
});

export const createAppointmentInput = z
  .strictObject({
    requestId: z.uuid().meta({
      description: 'Yours, once per booking: sending it again answers the first booking.',
    }),
    calendarId: publicId('calendar'),
    contactId: publicId('contact'),
    startsAt: timestamp,
    endsAt: timestamp.optional().meta({
      description: "Only with ignoreAvailability. Otherwise the calendar's slot length decides.",
    }),
    assignee: publicId('membership').optional().meta({
      description:
        'Who it is with: someone who takes bookings on the calendar. Left out, the calendar chooses.',
    }),
    title: z.string().trim().min(1).max(200).optional().meta({
      description: "Left out: the calendar's name.",
    }),
    status: z.enum(['booked', 'confirmed']).default('confirmed'),
    location: z.string().trim().min(1).max(APPOINTMENT_LOCATION_MAX).optional(),
    notes: z.string().max(APPOINTMENT_NOTES_MAX).default(''),
    ignoreAvailability,
  })
  .superRefine((input, context) => {
    if (input.endsAt === undefined) {
      if (input.ignoreAvailability)
        context.addIssue({
          code: 'custom',
          path: ['endsAt'],
          message: 'Say when it ends.',
          params: { code: 'end_required' },
        });
      return;
    }
    if (!input.ignoreAvailability)
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: "The calendar's slot length decides when it ends.",
        params: { code: 'end_not_allowed' },
      });
    else if (!(Date.parse(input.endsAt) > Date.parse(input.startsAt)))
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'End the appointment after it starts.',
        params: { code: 'window_order' },
      });
  })
  .meta({ id: 'CreateAppointmentInput' });
export type CreateAppointmentInput = z.output<typeof createAppointmentInput>;

export const createAppointment = defineEndpoint({
  operationId: 'createAppointment',
  method: 'post',
  path: '/appointments',
  group: 'Calendars',
  summary: 'Book an appointment for a contact',
  body: createAppointmentInput,
  response: { status: 201, description: 'The appointment booked.', schema: appointmentDetail },
});

export const rescheduleAppointmentInput = z
  .strictObject({
    revision,
    startsAt: timestamp,
    endsAt: timestamp.optional(),
    assignee: publicId('membership').optional().meta({
      description: 'Left out: whoever it is with stays.',
    }),
    ignoreAvailability,
  })
  .superRefine((input, context) => {
    if (input.endsAt === undefined) {
      if (input.ignoreAvailability)
        context.addIssue({
          code: 'custom',
          path: ['endsAt'],
          message: 'Say when it ends.',
          params: { code: 'end_required' },
        });
      return;
    }
    if (!input.ignoreAvailability)
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: "The calendar's slot length decides when it ends.",
        params: { code: 'end_not_allowed' },
      });
    else if (!(Date.parse(input.endsAt) > Date.parse(input.startsAt)))
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'End the appointment after it starts.',
        params: { code: 'window_order' },
      });
  })
  .meta({ id: 'RescheduleAppointmentInput' });

export const rescheduleAppointment = defineEndpoint({
  operationId: 'rescheduleAppointment',
  method: 'post',
  path: '/appointments/{id}/reschedule',
  group: 'Calendars',
  summary: 'Move an appointment to another time',
  params: appointmentParams,
  body: rescheduleAppointmentInput,
  response: { status: 200, description: 'The appointment moved.', schema: appointmentDetail },
});

export const cancelAppointmentInput = z
  .strictObject({
    revision,
    reason: z.string().trim().min(1).max(APPOINTMENT_CANCEL_REASON_MAX).optional(),
  })
  .meta({ id: 'CancelAppointmentInput' });

export const cancelAppointment = defineEndpoint({
  operationId: 'cancelAppointment',
  method: 'post',
  path: '/appointments/{id}/cancel',
  group: 'Calendars',
  summary: 'Cancel an appointment',
  params: appointmentParams,
  body: cancelAppointmentInput,
  response: { status: 200, description: 'The appointment cancelled.', schema: appointmentDetail },
});

export const setAppointmentStatusInput = z
  .strictObject({ revision, status: z.enum(appointmentStatuses) })
  .meta({ id: 'SetAppointmentStatusInput' });

export const setAppointmentStatus = defineEndpoint({
  operationId: 'setAppointmentStatus',
  method: 'put',
  path: '/appointments/{id}/status',
  group: 'Calendars',
  summary: "Set an appointment's status",
  params: appointmentParams,
  body: setAppointmentStatusInput,
  response: {
    status: 200,
    description: 'The appointment with its status.',
    schema: appointmentDetail,
  },
});

export const setAppointmentNotesInput = z
  .strictObject({
    revision,
    notes: z.string().max(APPOINTMENT_NOTES_MAX).meta({
      description: 'The whole of the notes, replacing what they were. Empty clears them.',
    }),
  })
  .meta({ id: 'SetAppointmentNotesInput' });

export const setAppointmentNotes = defineEndpoint({
  operationId: 'setAppointmentNotes',
  method: 'put',
  path: '/appointments/{id}/notes',
  group: 'Calendars',
  summary: "Change an appointment's notes",
  params: appointmentParams,
  body: setAppointmentNotesInput,
  response: {
    status: 200,
    description: 'The appointment with its notes.',
    schema: appointmentDetail,
  },
});

export const appointmentEndpoints = [
  listAppointments,
  createAppointment,
  getAppointment,
  rescheduleAppointment,
  cancelAppointment,
  setAppointmentStatus,
  setAppointmentNotes,
] as const;
