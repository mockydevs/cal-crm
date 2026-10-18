// What is on the calendar between two instants: the appointments and the blocked slots the
// Calendar view draws, narrowed by the Manage view's filters. A blocked slot is the same
// row bookings keep out of (calendar-blocked-slots.ts).
import { parsePublicId, type PublicIdKind } from '@repo/kernel';
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The longest window one read covers: two months of a month grid, with its edges. */
export const CALENDAR_EVENTS_MAX_DAYS = 62;
/** The most events one read answers. More than that, the answer says it was cut short. */
export const CALENDAR_EVENTS_LIMIT = 2000;
/** The most people, or calendars, a filter names. */
export const CALENDAR_EVENTS_FILTER_LIMIT = 100;

/** The ids a comma-separated filter names. */
export function calendarEventFilterIds(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(',');
}

function idList(kind: PublicIdKind, what: string): z.ZodString {
  return z
    .string()
    .max(4000)
    .refine(
      (value) => {
        const ids = value.split(',');
        return (
          ids.length <= CALENDAR_EVENTS_FILTER_LIMIT &&
          new Set(ids).size === ids.length &&
          ids.every((id) => parsePublicId(kind, id) !== undefined)
        );
      },
      {
        error: `Name up to ${String(CALENDAR_EVENTS_FILTER_LIMIT)} ${what}, each once, separated by commas.`,
      },
    );
}

const DAY = 86_400_000;

export const listCalendarEventsQuery = z
  .strictObject({
    from: timestamp.meta({ description: 'The start of the window.' }),
    to: timestamp.meta({
      description: `The end of the window, after its start and at most ${String(CALENDAR_EVENTS_MAX_DAYS)} days from it.`,
    }),
    type: z.enum(['all', 'appointments', 'blocked']).default('all').meta({
      description: 'appointments: bookings only. blocked: blocked slots only.',
    }),
    users: idList('membership', 'team members')
      .optional()
      .meta({
        description:
          'Only these team members: appointments assigned to them, and their blocked slots (a whole calendar blocked is not theirs). Membership ids, separated by commas.',
        examples: ['mem_01h455vb4pex5vsknk084sn02q'],
      }),
    calendars: idList('calendar', 'calendars')
      .optional()
      .meta({
        description:
          'Only these calendars: their appointments, their own blocked slots, and those of the people who take bookings on them that block every calendar. With users as well, both must hold. Calendar ids, separated by commas.',
        examples: ['cal_01h455vb4pex5vsknk084sn02q'],
      }),
  })
  .superRefine((query, context) => {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    if (!(to > from))
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'End the window after it starts.',
        params: { code: 'window_order' },
      });
    else if (to - from > CALENDAR_EVENTS_MAX_DAYS * DAY)
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: `Ask for at most ${String(CALENDAR_EVENTS_MAX_DAYS)} days at a time.`,
        params: { code: 'window_too_long' },
      });
  })
  .meta({ id: 'ListCalendarEventsQuery' });

/** The statuses an appointment has, as calendar.appointments keeps them. */
export const appointmentStatuses = [
  'booked',
  'confirmed',
  'cancelled',
  'no_show',
  'completed',
  'invalid',
] as const;

const person = z.looseObject({
  membershipId: publicId('membership').nullable().meta({
    description: 'Null when the person is no longer on the team.',
  }),
  you: z.boolean(),
  // Optional only so that an answer saved before it existed still reads.
  name: z.string().optional().meta({
    description:
      "The person's name, as the team list shows it, so the calendar can name them to someone who may not read the team. Empty when they are no longer on the team.",
  }),
});

export const calendarAppointmentEvent = z
  .looseObject({
    kind: z.literal('appointment'),
    id: publicId('appointment'),
    title: z.string(),
    startsAt: timestamp,
    endsAt: timestamp,
    status: z.enum(appointmentStatuses),
    calendar: z.looseObject({ id: publicId('calendar'), name: z.string() }),
    contact: z.looseObject({
      id: publicId('contact'),
      name: z.string().meta({
        description: 'The name, or else the primary address; empty when the contact has neither.',
      }),
      trashed: z.boolean(),
    }),
    assignee: person.nullable().meta({ description: 'Null when nobody is assigned.' }),
  })
  .meta({ id: 'CalendarAppointmentEvent' });

export const calendarBlockedEvent = z
  .looseObject({
    kind: z.literal('blocked'),
    id: publicId('blocked_slot'),
    startsAt: timestamp,
    endsAt: timestamp,
    user: person.nullable().meta({
      description:
        'Whose time is blocked: on the calendar below, or on every calendar they serve when there is none. Null when the whole calendar is blocked.',
    }),
    calendar: z
      .looseObject({ id: publicId('calendar'), name: z.string() })
      .nullable()
      .meta({ description: 'The one calendar blocked; null for a person on every calendar.' }),
    title: z.string().nullable().meta({
      description:
        'As whoever blocked the time wrote it. Private: null unless you may manage calendars.',
    }),
  })
  .meta({
    id: 'CalendarBlockedEvent',
    description:
      'A blocked slot (calendar-blocked-slots.ts): nothing new can be booked in it. Shown with microseconds, as it is stored.',
  });

export const calendarEvent = z.discriminatedUnion('kind', [
  calendarAppointmentEvent,
  calendarBlockedEvent,
]);
export type CalendarEvent = z.output<typeof calendarEvent>;

export const calendarEvents = z
  .looseObject({
    items: z.array(calendarEvent).meta({
      description:
        'Everything that overlaps the window, by start time. An appointment of any status is listed, a cancelled one too, with its status.',
    }),
    truncated: z.boolean().meta({
      description: `True when more than ${String(CALENDAR_EVENTS_LIMIT)} events overlap the window: the earliest are answered, and a shorter window or a filter reads the rest.`,
    }),
    canManage: z.boolean().meta({ description: 'Whether you may manage calendars.' }),
  })
  .meta({ id: 'CalendarEvents' });
export type CalendarEvents = z.output<typeof calendarEvents>;

export const listCalendarEvents = defineEndpoint({
  operationId: 'listCalendarEvents',
  method: 'get',
  path: '/calendars/events',
  group: 'Calendars',
  summary: 'Read the appointments and blocked slots between two instants',
  query: listCalendarEventsQuery,
  response: {
    status: 200,
    description:
      'What the calendar view shows for the window, with the Manage view filters applied.',
    schema: calendarEvents,
  },
});

export const calendarEventEndpoints = [listCalendarEvents] as const;
