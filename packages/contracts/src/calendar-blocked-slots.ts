// Blocked slots: time nobody can book, each one added, changed and removed on its own, as
// GoHighLevel's "+ New → Blocked slot" does. A slot blocks a team member on every calendar
// of the business, a whole calendar, or a member on one calendar. Existing appointments
// stay where they are: a block only keeps new bookings out ("Existing appointments will not
// be deleted, blocked times only affect new booking availability", GoHighLevel's Manually
// Booking Calendar Appointments).
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The longest title, as calendar.blocked_slots keeps it. */
export const BLOCKED_SLOT_TITLE_MAX = 1000;
/** The most of one person's blocked slots one read answers. */
export const BLOCKED_SLOTS_LIMIT = 500;

/** Microseconds since the epoch, as PostgreSQL keeps an instant; undefined when unreadable. */
function instantMicroseconds(value: string): bigint | undefined {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  // Date.parse's specified interchange format uses three fractional digits.
  const normalized = value.replace(
    /\.(\d+)/,
    (_match: string, digits: string) => `.${digits.slice(0, 3).padEnd(3, '0')}`,
  );
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds)
    ? BigInt(milliseconds) * 1000n + BigInt(fraction.slice(3).padEnd(3, '0'))
    : undefined;
}
// An offset can carry a four-digit local year into UTC year 0 or 10000, which the API's
// own UTC timestamps cannot show again.
const FIRST_INSTANT = BigInt(Date.parse('0001-01-01T00:00:00.000Z')) * 1000n;
const LAST_INSTANT = BigInt(Date.parse('9999-12-31T23:59:59.999Z')) * 1000n + 999n;
const blockInstant = timestamp.refine((value) => {
  const instant = instantMicroseconds(value);
  return (
    (/\.(\d+)/.exec(value)?.[1]?.length ?? 0) <= 6 &&
    instant !== undefined &&
    instant >= FIRST_INSTANT &&
    instant <= LAST_INSTANT
  );
});

const revision = z.string().regex(/^[0-9a-f]{64}$/);

const blockedSlotFields = {
  membershipId: publicId('membership').nullable().default(null).meta({
    description:
      'The team member whose time is blocked. Null blocks the calendar for everyone on it.',
  }),
  calendarId: publicId('calendar').nullable().default(null).meta({
    description:
      "Only this calendar. Null blocks the member's time on every calendar of this business.",
  }),
  title: z
    .string()
    .trim()
    .max(BLOCKED_SLOT_TITLE_MAX, {
      error: `Use at most ${String(BLOCKED_SLOT_TITLE_MAX)} characters.`,
    })
    .default(''),
  startsAt: blockInstant,
  endsAt: blockInstant,
};

/** Someone or some calendar is blocked, and the time ends after it starts. */
function checkBlockedSlot(
  value: {
    readonly membershipId: string | null;
    readonly calendarId: string | null;
    readonly startsAt: string;
    readonly endsAt: string;
  },
  context: z.RefinementCtx,
): void {
  if (value.membershipId === null && value.calendarId === null)
    context.addIssue({
      code: 'custom',
      path: ['membershipId'],
      message: 'Choose a team member, a calendar, or both.',
      params: { code: 'whom' },
    });
  const start = instantMicroseconds(value.startsAt);
  const end = instantMicroseconds(value.endsAt);
  if (start !== undefined && end !== undefined && end <= start)
    context.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'End the blocked time after it starts.',
      params: { code: 'window_order' },
    });
}

export const blockedSlotInput = z
  .strictObject(blockedSlotFields)
  .superRefine(checkBlockedSlot)
  .meta({ id: 'BlockedSlotInput' });
export type BlockedSlotInput = z.input<typeof blockedSlotInput>;

export const updateBlockedSlotInput = z
  .strictObject({ ...blockedSlotFields, revision })
  .superRefine(checkBlockedSlot)
  .meta({ id: 'UpdateBlockedSlotInput' });

export const blockedSlot = z
  .looseObject({
    id: publicId('blocked_slot'),
    member: z
      .looseObject({
        membershipId: publicId('membership').nullable().meta({
          description: 'Null when the person is no longer on the team: then nothing is blocked.',
        }),
        you: z.boolean(),
        name: z.string(),
      })
      .nullable()
      .meta({ description: 'Null when the whole calendar is blocked.' }),
    calendar: z
      .looseObject({ id: publicId('calendar'), name: z.string() })
      .nullable()
      .meta({ description: 'Null when the member is blocked on every calendar.' }),
    title: z.string(),
    startsAt: timestamp.meta({ description: 'With microseconds, as stored.' }),
    endsAt: timestamp,
    revision: revision.meta({ description: 'Send it back to change this blocked slot.' }),
  })
  .meta({ id: 'BlockedSlot', description: 'Time nobody can book.' });
export type BlockedSlot = z.output<typeof blockedSlot>;

export const blockedSlotList = z
  .looseObject({
    items: z.array(blockedSlot).meta({ description: 'By start time.' }),
    truncated: z.boolean().meta({
      description: `True when more than ${String(BLOCKED_SLOTS_LIMIT)} are still to come: the earliest are answered.`,
    }),
  })
  .meta({ id: 'BlockedSlotList' });
export type BlockedSlotList = z.output<typeof blockedSlotList>;

const params = z.strictObject({ blockedSlotId: publicId('blocked_slot') });

export const listBlockedSlots = defineEndpoint({
  operationId: 'listBlockedSlots',
  method: 'get',
  path: '/calendars/users/{membershipId}/blocked-slots',
  group: 'Calendars',
  summary: "Read a team member's blocked slots that have not ended",
  params: z.strictObject({ membershipId: publicId('membership') }),
  response: {
    status: 200,
    description: "The member's blocked time from now on, theirs alone and on one calendar.",
    schema: blockedSlotList,
  },
});
export const getBlockedSlot = defineEndpoint({
  operationId: 'getBlockedSlot',
  method: 'get',
  path: '/calendars/blocked-slots/{blockedSlotId}',
  group: 'Calendars',
  summary: 'Read one blocked slot',
  params,
  response: { status: 200, description: 'The blocked slot.', schema: blockedSlot },
});
export const createBlockedSlot = defineEndpoint({
  operationId: 'createBlockedSlot',
  method: 'post',
  path: '/calendars/blocked-slots',
  group: 'Calendars',
  summary: 'Block time on the calendar',
  body: blockedSlotInput,
  response: { status: 201, description: 'The new blocked slot.', schema: blockedSlot },
});
export const updateBlockedSlot = defineEndpoint({
  operationId: 'updateBlockedSlot',
  method: 'put',
  path: '/calendars/blocked-slots/{blockedSlotId}',
  group: 'Calendars',
  summary: 'Change a blocked slot',
  params,
  body: updateBlockedSlotInput,
  response: { status: 200, description: 'The blocked slot as saved.', schema: blockedSlot },
});
export const deleteBlockedSlot = defineEndpoint({
  operationId: 'deleteBlockedSlot',
  method: 'delete',
  path: '/calendars/blocked-slots/{blockedSlotId}',
  group: 'Calendars',
  summary: 'Remove a blocked slot',
  params,
  response: { status: 204, description: 'The time can be booked again.' },
});

export const blockedSlotEndpoints = [
  listBlockedSlots,
  getBlockedSlot,
  createBlockedSlot,
  updateBlockedSlot,
  deleteBlockedSlot,
] as const;
