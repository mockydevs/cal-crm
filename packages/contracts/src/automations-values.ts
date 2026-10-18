// Values the automation document is built from (AUTOMATIONS.md sections 2 and 3): keys,
// durations, references, field paths, merge text and conditions.
import * as z from 'zod';

/** A step or trigger id the author chooses, such as send_guide. */
export const automationKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, {
    error: 'Use lowercase letters, digits and underscores, starting with a letter.',
  })
  .meta({ description: 'A stable id the author chooses, such as send_guide.' });

/** ISO 8601 duration: P2D is 2 days, PT4H is 4 hours. */
export const isoDuration = z
  .string()
  .regex(/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/, {
    error: 'Use an ISO 8601 duration, such as P2D for 2 days or PT4H for 4 hours.',
  })
  .meta({ description: 'An ISO 8601 duration, such as P2D (2 days) or PT4H (4 hours).' });

export const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use a 24-hour time, such as 09:30.' })
  .meta({ description: 'A 24-hour time of day, such as 09:30.' });

const windowDay = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

/**
 * When a run may go on from a wait: the weekdays and the hours, read in the automation's
 * time zone. An end before the start is a window that runs past midnight.
 */
export const resumeWindow = z
  .strictObject({ days: z.array(windowDay).min(1).max(7), start: timeOfDay, end: timeOfDay })
  .meta({
    description:
      "When the run may go on from this wait: weekdays and hours in the automation's time zone. Outside them it goes on when the window next opens.",
  });

/** A form, template, pipeline or other item, given by id or by its exact name. */
export const automationReference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .meta({ description: 'An id, or the exact name; the server resolves names to ids.' });

/** A field by its path, such as contact.services or deal.value. */
export const fieldPath = z
  .string()
  .regex(/^[a-z][a-z_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/, {
    error: 'Name a field by its path, such as contact.firstName.',
  })
  .meta({ description: 'A field by its path, such as contact.services or deal.value.' });

/** Text that may hold merge fields such as {{contact.firstName}}. */
export const mergeText = (max: number): z.ZodString =>
  z
    .string()
    .min(1)
    .max(max)
    .meta({ description: 'Text with optional merge fields, such as {{contact.firstName}}.' });

const scalar = z.union([z.string().max(1000), z.number(), z.boolean()]);

export const conditionOperators = [
  'equals',
  'not_equals',
  'includes',
  'excludes',
  'starts_with',
  'greater_than',
  'less_than',
  'is_set',
  'is_empty',
  'before',
  'after',
  'within_last',
  'within_next',
] as const;

const comparison = z.strictObject({
  field: fieldPath,
  operator: z.enum([
    'equals',
    'not_equals',
    'includes',
    'excludes',
    'starts_with',
    'greater_than',
    'less_than',
    'before',
    'after',
  ]),
  value: scalar,
});
const presence = z.strictObject({
  field: fieldPath,
  operator: z.enum(['is_set', 'is_empty']),
});
const timeWindow = z.strictObject({
  field: fieldPath,
  operator: z.enum(['within_last', 'within_next']),
  value: isoDuration,
});

export type AutomationCondition =
  | z.infer<typeof comparison>
  | z.infer<typeof presence>
  | z.infer<typeof timeWindow>
  | { all: AutomationCondition[] }
  | { any: AutomationCondition[] }
  | { not: AutomationCondition };

/** A structured check, never code, so it can be validated before anything runs. */
export const automationCondition: z.ZodType<AutomationCondition> = z
  .union([
    comparison,
    presence,
    timeWindow,
    z.strictObject({
      all: z
        .array(z.lazy(() => automationCondition))
        .min(1)
        .max(20),
    }),
    z.strictObject({
      any: z
        .array(z.lazy(() => automationCondition))
        .min(1)
        .max(20),
    }),
    z.strictObject({ not: z.lazy(() => automationCondition) }),
  ])
  .meta({ id: 'AutomationCondition' });
