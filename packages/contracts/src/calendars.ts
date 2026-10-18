import * as z from 'zod';
import { isTimeZone } from '@repo/kernel';
import { publicId } from './ids.js';
import { botProtection } from './bot-protection.js';
import { SLUG } from './businesses.js';
import { defineEndpoint } from './endpoints.js';
import { timestamp } from './timestamps.js';

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const localDate = z.iso
  .date()
  .refine((value) => !value.startsWith('0000-'), { error: 'Choose a date in year 1 or later.' });
/**
 * When a range of hours ends. 24:00 is the end of the day, the same instant as 00:00 on
 * the next date, so hours can reach midnight; nothing starts then and nothing is later.
 * PostgreSQL's `time` stores 24:00 and compares it after every other time of the day.
 */
const closingTime = z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/);
const range = z
  .strictObject({ startTime: time, endTime: closingTime })
  .refine((value) => value.endTime > value.startTime, {
    path: ['endTime'],
    error: 'End time must be after start time.',
  });

/** Every type a calendar can be saved as. */
export const CALENDAR_KINDS = [
  'personal',
  'round_robin',
  'collective',
  'class',
  'service',
  'event',
] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
/**
 * The types that can take bookings today. The others are saved and edited as drafts until
 * their own booking is built: choosing a type never promises what it cannot do.
 */
export const BOOKABLE_CALENDAR_KINDS: readonly CalendarKind[] = ['personal', 'round_robin'];

export const CALENDAR_LIMITS = {
  /** Places one member of a calendar can meet at. */
  memberLocations: 5,
  /** Durations a calendar offers beside its own. */
  extraDurations: 5,
  /** Characters in the consent wording. */
  consentText: 1000,
  /** Characters in the widget's button. */
  buttonText: 40,
  /** Calendar groups one business may have. */
  groups: 100,
  /** Bytes of a calendar's logo or cover image. */
  imageBytes: 2_500_000,
} as const;

/**
 * Where a member meets. Most kinds are words the business writes: an address, a phone
 * number or anything else. `google_meet` asks the member's Google Calendar for a Meet when
 * the appointment is written there; its link then becomes the appointment's place.
 */
export const calendarMemberLocation = z
  .strictObject({
    kind: z.enum(['custom', 'phone', 'address', 'google_meet']),
    value: z.string().trim().min(1, { error: 'Write the meeting location.' }).max(500),
    label: z.string().trim().min(1).max(80).nullable().default(null),
  })
  .meta({ id: 'CalendarMemberLocation' });

export const calendarAvailabilityInput = z
  .strictObject({
    members: z
      .array(
        z.strictObject({
          membershipId: publicId('membership'),
          weight: z.int().min(1).max(100),
          locations: z
            .array(calendarMemberLocation)
            .max(CALENDAR_LIMITS.memberLocations)
            .default([])
            .meta({ description: 'The first is the one an appointment of theirs is given.' }),
        }),
      )
      .max(100),
    weeklyHours: z.array(range.safeExtend({ weekday: z.int().min(0).max(6) })).max(112),
    dateOverrides: z
      .array(z.strictObject({ date: localDate, ranges: z.array(range).max(16) }))
      .max(730),
  })
  .superRefine((value, context) => {
    const overlap = (ranges: readonly { startTime: string; endTime: string }[]) => {
      const sorted = [...ranges].sort((left, right) =>
        left.startTime.localeCompare(right.startTime),
      );
      return sorted.some((item, index) => {
        const previous = sorted[index - 1];
        return previous !== undefined && item.startTime < previous.endTime;
      });
    };
    if ([...Map.groupBy(value.weeklyHours, (item) => item.weekday).values()].some(overlap)) {
      context.addIssue({
        code: 'custom',
        path: ['weeklyHours'],
        message: 'Opening hours must not overlap.',
      });
    }
    if (value.dateOverrides.some((item) => overlap(item.ranges))) {
      context.addIssue({
        code: 'custom',
        path: ['dateOverrides'],
        message: 'Override hours must not overlap.',
      });
    }
    if (new Set(value.dateOverrides.map((item) => item.date)).size !== value.dateOverrides.length) {
      context.addIssue({
        code: 'custom',
        path: ['dateOverrides'],
        message: 'Use one override per date.',
      });
    }
    if (new Set(value.members.map((item) => item.membershipId)).size !== value.members.length) {
      context.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'Each member may appear only once.',
      });
    }
  });

const hexColor = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/, { error: 'Use a colour such as #178af6.' });

const settingsShape = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  kind: z.enum(CALENDAR_KINDS),
  timezone: z.string().refine(isTimeZone, { error: 'Choose an IANA time zone.' }),
  slotMinutes: z.int().min(5).max(480).default(30),
  bufferBeforeMinutes: z.int().min(0).max(240).default(0),
  bufferAfterMinutes: z.int().min(0).max(240).default(0),
  minNoticeMinutes: z.int().min(0).max(2_147_483_647).default(60),
  maxDaysAhead: z.int().min(1).max(730).default(60),
  bookingSlug: z.string().regex(SLUG),
  confirmationSenderId: publicId('mailbox').nullable().default(null),
  isActive: z.boolean().default(false),
  // Basic details.
  groupId: publicId('calendar_group').nullable().default(null),
  logoFileId: publicId('file').nullable().default(null),
  inviteTitle: z
    .string()
    .trim()
    .min(1, { error: 'Give appointments a title.' })
    .max(200)
    .default('{{contact.name}}')
    .meta({
      description: 'What an appointment booked here is called; merge fields are filled in.',
    }),
  // Booking rules.
  slotIntervalMinutes: z.int().min(5).max(480).nullable().default(null).meta({
    description: 'How often a slot starts. Null: every slotMinutes, one after another.',
  }),
  extraDurationMinutes: z
    .array(z.int().min(5).max(480))
    .max(CALENDAR_LIMITS.extraDurations)
    .refine((values) => new Set(values).size === values.length, {
      error: 'Name each duration once.',
    })
    .default([]),
  maxPerDay: z.int().min(1).max(1000).nullable().default(null),
  // The most bookings one start time takes, each with its own free host; null: one per host.
  maxPerSlot: z.int().min(1).max(1000).nullable().default(null),
  countAvailableDaysOnly: z.boolean().default(false),
  lookBusyPercent: z.int().min(0).max(100).default(0),
  // Confirmation: the box's wording (empty: the standard one); off, no box and no email.
  consentEnabled: z.boolean().default(true),
  consentText: z.string().max(CALENDAR_LIMITS.consentText).default(''),
  // Bot protection of the booking page: off, or a proof of work.
  botProtection: botProtection.default('off'),
  // Notifications and policies.
  assignContactToMember: z.boolean().default(true),
  skipAssignIfOwned: z.boolean().default(false),
  allowReschedule: z.boolean().default(true),
  rescheduleCutoffMinutes: z.int().min(0).max(525_600).nullable().default(null),
  allowCancel: z.boolean().default(true),
  cancelCutoffMinutes: z.int().min(0).max(525_600).nullable().default(null),
  // Widget appearance.
  coverFileId: publicId('file').nullable().default(null),
  widgetStyle: z.enum(['neo', 'classic']).default('neo'),
  primaryColor: hexColor.default('#178af6'),
  backgroundColor: hexColor.default('#ffffff'),
  buttonText: z.string().trim().max(CALENDAR_LIMITS.buttonText).default(''),
};
// A draft can be any type; only a type whose booking is built can be switched on.
const activeNeedsBookableKind = (value: { isActive: boolean; kind: CalendarKind }) =>
  !value.isActive || BOOKABLE_CALENDAR_KINDS.includes(value.kind);
const activeKindIssue = {
  path: ['isActive'],
  error: "This type of calendar can't take bookings yet. Save it as a draft.",
};
export const createCalendarInput = calendarAvailabilityInput
  .safeExtend(settingsShape)
  .refine(activeNeedsBookableKind, activeKindIssue)
  .refine(
    (value) =>
      !value.isActive ||
      (value.kind === 'personal' ? value.members.length === 1 : value.members.length > 0),
    {
      path: ['members'],
      error: 'Choose exactly one member for a personal calendar, or at least one for round robin.',
    },
  );

const revision = z.string().regex(/^[0-9a-f]{64}$/);
export const updateCalendarInput = z
  .strictObject({ ...settingsShape, revision })
  .refine(activeNeedsBookableKind, activeKindIssue);
export const updateCalendarAvailabilityInput = calendarAvailabilityInput.safeExtend({ revision });
export const calendar = z
  .looseObject({
    ...settingsShape,
    id: publicId('calendar'),
    // Every answer of this server carries it; the default only lets an answer saved before
    // groups existed still read.
    groupName: z
      .string()
      .nullable()
      .default(null)
      .meta({ description: 'The name of its group, if it is in one.' }),
    supported: z
      .boolean()
      .meta({ description: 'Whether a calendar of this type can take bookings at all.' }),
    bookable: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Calendar' });
export type Calendar = z.output<typeof calendar>;
export const calendarConfiguration = z
  .looseObject({
    calendar,
    members: z.array(
      z.looseObject({
        membershipId: publicId('membership').nullable(),
        weight: z.number(),
        locations: z.array(calendarMemberLocation).default([]),
      }),
    ),
    weeklyHours: calendarAvailabilityInput.shape.weeklyHours,
    dateOverrides: calendarAvailabilityInput.shape.dateOverrides,
    revision,
    canManage: z.boolean(),
  })
  .meta({ id: 'CalendarConfiguration' });
export type CalendarConfiguration = z.output<typeof calendarConfiguration>;
export const calendarList = z.looseObject({
  items: z.array(calendar),
  nextCursor: publicId('calendar').nullable(),
  // Optional only so that an answer saved before the list was counted still reads.
  total: z
    .int()
    .optional()
    .meta({ description: 'How many calendars match the filters, on every page.' }),
  canManage: z.boolean(),
});
export type CalendarList = z.output<typeof calendarList>;
const params = z.strictObject({ id: publicId('calendar') });
export const calendarSenderChoices = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: publicId('mailbox'),
        name: z.string().max(120),
        email: z.email().max(320),
      }),
    )
    .max(50),
  nextCursor: publicId('mailbox').nullable(),
});
export type CalendarSenderChoices = z.output<typeof calendarSenderChoices>;
export const listCalendarSenders = defineEndpoint({
  operationId: 'listCalendarSenders',
  method: 'get',
  path: '/calendars/senders',
  group: 'Calendars',
  summary: 'List eligible calendar confirmation senders',
  query: z.strictObject({
    after: publicId('mailbox').optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }),
  response: {
    status: 200,
    description: 'Active email senders configured for conversations, without credentials.',
    schema: calendarSenderChoices,
  },
});
export const listCalendarsQuery = z
  .strictObject({
    after: publicId('calendar').optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
    q: z
      .string()
      .trim()
      .max(200)
      .optional()
      .meta({ description: 'Finds calendars by any part of their name or of their group’s name.' }),
    status: z.enum(['active', 'inactive']).optional(),
    kind: z.enum(CALENDAR_KINDS).optional(),
    group: z
      .union([publicId('calendar_group'), z.literal('none')])
      .optional()
      .meta({ description: 'Only the calendars of this group, or "none" for those in no group.' }),
    member: publicId('membership')
      .optional()
      .meta({ description: 'Only the calendars this person is on.' }),
  })
  .meta({ id: 'ListCalendarsQuery' });
export type ListCalendarsQuery = z.output<typeof listCalendarsQuery>;
export const listCalendars = defineEndpoint({
  operationId: 'listCalendars',
  method: 'get',
  path: '/calendars',
  group: 'Calendars',
  summary: 'List calendars',
  query: listCalendarsQuery,
  response: { status: 200, description: 'Calendars in creation order.', schema: calendarList },
});
export const createCalendar = defineEndpoint({
  operationId: 'createCalendar',
  method: 'post',
  path: '/calendars',
  group: 'Calendars',
  summary: 'Create a calendar with availability',
  body: createCalendarInput,
  response: {
    status: 201,
    description: 'Saved calendar and availability.',
    schema: calendarConfiguration,
  },
});
export const getCalendar = defineEndpoint({
  operationId: 'getCalendar',
  method: 'get',
  path: '/calendars/{id}',
  group: 'Calendars',
  summary: 'Read calendar configuration',
  params,
  response: {
    status: 200,
    description: 'Calendar and its current revision.',
    schema: calendarConfiguration,
  },
});
export const updateCalendar = defineEndpoint({
  operationId: 'updateCalendar',
  method: 'put',
  path: '/calendars/{id}',
  group: 'Calendars',
  summary: 'Save calendar settings',
  params,
  body: updateCalendarInput,
  response: {
    status: 200,
    description: 'Calendar with settings saved atomically.',
    schema: calendarConfiguration,
  },
});
export const updateCalendarAvailability = defineEndpoint({
  operationId: 'updateCalendarAvailability',
  method: 'put',
  path: '/calendars/{id}/availability',
  group: 'Calendars',
  summary: 'Save members and opening hours',
  params,
  body: updateCalendarAvailabilityInput,
  response: {
    status: 200,
    description: 'Calendar with availability saved atomically.',
    schema: calendarConfiguration,
  },
});
export const calendarHours = z.looseObject({
  date: localDate,
  timezone: z.string(),
  source: z.enum(['weekly', 'override']),
  ranges: z.array(range),
});
export const getCalendarAvailability = defineEndpoint({
  operationId: 'getCalendarAvailability',
  method: 'get',
  path: '/calendars/{id}/availability',
  group: 'Calendars',
  summary: 'Read effective hours on a local date',
  params,
  query: z.strictObject({ date: localDate }),
  response: {
    status: 200,
    description: 'Date overrides take precedence over weekly hours.',
    schema: calendarHours,
  },
});
export const deleteCalendar = defineEndpoint({
  operationId: 'deleteCalendar',
  method: 'delete',
  path: '/calendars/{id}',
  group: 'Calendars',
  summary: 'Delete a calendar that has no appointments',
  params,
  response: {
    status: 204,
    description:
      'The calendar, its team and its hours are gone. A calendar with appointments is not deleted: make it inactive instead.',
  },
});

const groupName = z
  .string()
  .trim()
  .min(1, { error: 'Give the group a name.' })
  .max(120, { error: 'Use at most 120 characters.' });
export const calendarGroup = z
  .looseObject({
    id: publicId('calendar_group'),
    name: z.string(),
    calendarCount: z.int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'CalendarGroup' });
export type CalendarGroup = z.output<typeof calendarGroup>;
export const calendarGroupList = z
  .looseObject({
    items: z.array(calendarGroup),
    ungroupedCount: z.int().meta({ description: 'Calendars in no group.' }),
    calendarCount: z.int().meta({ description: 'Every calendar of the business.' }),
    canManage: z.boolean(),
  })
  .meta({ id: 'CalendarGroupList' });
export type CalendarGroupList = z.output<typeof calendarGroupList>;
export const calendarGroupInput = z
  .strictObject({ name: groupName })
  .meta({ id: 'CalendarGroupInput' });
const groupParams = z.strictObject({ groupId: publicId('calendar_group') });
export const listCalendarGroups = defineEndpoint({
  operationId: 'listCalendarGroups',
  method: 'get',
  path: '/calendar-groups',
  group: 'Calendars',
  summary: 'List calendar groups by name, with the number of calendars in each',
  response: { status: 200, description: 'The groups.', schema: calendarGroupList },
});
export const createCalendarGroup = defineEndpoint({
  operationId: 'createCalendarGroup',
  method: 'post',
  path: '/calendar-groups',
  group: 'Calendars',
  summary: 'Create a calendar group',
  body: calendarGroupInput,
  response: { status: 201, description: 'The new group.', schema: calendarGroup },
});
export const renameCalendarGroup = defineEndpoint({
  operationId: 'renameCalendarGroup',
  method: 'put',
  path: '/calendar-groups/{groupId}',
  group: 'Calendars',
  summary: 'Rename a calendar group',
  params: groupParams,
  body: calendarGroupInput,
  response: { status: 200, description: 'The renamed group.', schema: calendarGroup },
});
export const deleteCalendarGroup = defineEndpoint({
  operationId: 'deleteCalendarGroup',
  method: 'delete',
  path: '/calendar-groups/{groupId}',
  group: 'Calendars',
  summary: 'Delete a calendar group, leaving its calendars in no group',
  params: groupParams,
  response: { status: 204, description: 'The group is gone. Its calendars remain.' },
});
export const calendarEndpoints = [
  listCalendarSenders,
  listCalendars,
  createCalendar,
  getCalendar,
  updateCalendar,
  updateCalendarAvailability,
  getCalendarAvailability,
  deleteCalendar,
  listCalendarGroups,
  createCalendarGroup,
  renameCalendarGroup,
  deleteCalendarGroup,
] as const;
