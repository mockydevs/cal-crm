import * as z from 'zod';
import { isTimeZone } from '@repo/kernel';
import { publicId } from './ids.js';
import { defineEndpoint } from './endpoints.js';

const minuteRange = z
  .strictObject({
    startMinute: z.int().min(0).max(1439),
    endMinute: z.int().min(1).max(1440),
  })
  .refine((value) => value.endMinute > value.startMinute, {
    path: ['endMinute'],
    error: 'End time must be after start time.',
  });
const date = z.iso.date().refine((value) => !value.startsWith('0000-'));
/**
 * A person's hours in this business. Their time away is not part of it: each blocked slot
 * is a thing of its own (calendar-blocked-slots.ts).
 */
export const calendarUserAvailabilityProfile = z
  .strictObject({
    timezone: z.string().refine(isTimeZone),
    inheritCalendarHours: z.boolean(),
    weeklyHours: z.array(minuteRange.safeExtend({ weekday: z.int().min(0).max(6) })).max(112),
    dateOverrides: z.array(z.strictObject({ date, ranges: z.array(minuteRange).max(16) })).max(730),
  })
  .superRefine((value, context) => {
    const overlap = (ranges: readonly { startMinute: number; endMinute: number }[]) => {
      const sorted = [...ranges].sort((a, b) => a.startMinute - b.startMinute);
      return sorted.some((range, index) => {
        const previous = sorted[index - 1];
        return previous !== undefined && range.startMinute < previous.endMinute;
      });
    };
    if ([...Map.groupBy(value.weeklyHours, (range) => range.weekday).values()].some(overlap))
      context.addIssue({
        code: 'custom',
        path: ['weeklyHours'],
        message: 'Opening hours must not overlap.',
      });
    if (value.dateOverrides.some((override) => overlap(override.ranges)))
      context.addIssue({
        code: 'custom',
        path: ['dateOverrides'],
        message: 'Override hours must not overlap.',
      });
    if (
      new Set(value.dateOverrides.map((override) => override.date)).size !==
      value.dateOverrides.length
    )
      context.addIssue({
        code: 'custom',
        path: ['dateOverrides'],
        message: 'Use one override group per date.',
      });
  })
  .meta({ id: 'CalendarUserAvailabilityProfile' });
export type CalendarUserAvailabilityProfile = z.output<typeof calendarUserAvailabilityProfile>;
const revision = z.string().regex(/^[0-9a-f]{64}$/);
export const calendarUserAvailability = z
  .strictObject({
    membershipId: publicId('membership'),
    profile: calendarUserAvailabilityProfile.nullable(),
    revision,
  })
  .meta({ id: 'CalendarUserAvailability' });
export type CalendarUserAvailability = z.output<typeof calendarUserAvailability>;
/** Null resets to calendar inheritance; an empty independent profile closes user hours. */
export const updateCalendarUserAvailabilityInput = z.strictObject({
  revision,
  profile: calendarUserAvailabilityProfile.nullable(),
});
const params = z.strictObject({ membershipId: publicId('membership') });
export const getCalendarUserAvailability = defineEndpoint({
  operationId: 'getCalendarUserAvailability',
  method: 'get',
  path: '/calendars/users/{membershipId}/availability',
  group: 'Calendars',
  summary: 'Read business team member availability',
  params,
  response: {
    status: 200,
    description: 'Member schedule or inherited calendar hours, with revision.',
    schema: calendarUserAvailability,
  },
});
export const updateCalendarUserAvailability = defineEndpoint({
  operationId: 'updateCalendarUserAvailability',
  method: 'put',
  path: '/calendars/users/{membershipId}/availability',
  group: 'Calendars',
  summary: 'Replace or reset business team member availability',
  params,
  body: updateCalendarUserAvailabilityInput,
  response: {
    status: 200,
    description: 'Atomically saved member schedule and revision.',
    schema: calendarUserAvailability,
  },
});
export const calendarUserAvailabilityEndpoints = [
  getCalendarUserAvailability,
  updateCalendarUserAvailability,
] as const;
