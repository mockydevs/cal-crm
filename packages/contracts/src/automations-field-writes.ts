// What a contact.update step writes to a field (AUTOMATIONS.md section 3): a fixed value,
// text with merge fields, or a value worked out as the step runs. On its own, so that what
// only the document's schema needs is not carried by every page that calls the API.
import * as z from 'zod';

import { fieldPath } from './automations-values.js';

/** How many days a date may be moved by a date_add: ten years either way. */
export const MAX_DATE_ADD_DAYS = 3660;

/** The operators of a math value. */
export const mathOperators = ['+', '-', '*', '/'] as const;

const mathOperand = z.union([z.number(), fieldPath]).meta({
  description:
    'A number, or a number field by its path, such as contact.custom.budget, read when the step runs.',
});

/**
 * A value worked out when the step runs, in place of a fixed one. A small, closed set:
 * there is no expression language, so each can be checked before anything runs.
 */
export const automationComputedValue = z
  .discriminatedUnion('op', [
    z.strictObject({ op: z.literal('now') }).meta({
      description:
        "The moment the step runs. A date field takes today's date in the automation's time zone (settings.timezone); a date and time field takes the instant. Only for date and date-and-time fields.",
    }),
    z
      .strictObject({
        op: z.literal('date_add'),
        field: fieldPath.optional().meta({
          description:
            'The date field to count from, such as contact.custom.event_date. Not together with value.',
        }),
        value: z
          .union([z.literal('now'), z.iso.date(), z.iso.datetime({ offset: true })])
          .optional()
          .meta({
            description:
              'A fixed date to count from (2026-12-01, or a date and time with its offset), or "now". Not together with field. With neither, it counts from now.',
          }),
        days: z.int().min(-MAX_DATE_ADD_DAYS).max(MAX_DATE_ADD_DAYS).meta({
          description: 'How many days to add; a negative number goes back.',
        }),
      })
      .meta({
        description:
          'A date moved by a number of days: from a date field, from a fixed date, or from now. { "op": "date_add", "days": 365 } is a year from today. Only for date and date-and-time fields. A field with no date in it fails the step.',
      }),
    z
      .strictObject({
        op: z.literal('math'),
        left: mathOperand,
        operator: z.enum(mathOperators),
        right: mathOperand,
      })
      .meta({
        description:
          'Arithmetic on two numbers: left operator right, such as { "op": "math", "left": "contact.custom.visits", "operator": "+", "right": 1 }. Only for number fields. A field that holds no number, and a division by zero, fail the step.',
      }),
  ])
  .meta({ id: 'AutomationComputedValue' });

export type AutomationComputedValue = z.output<typeof automationComputedValue>;

const writtenValue = z.union([
  z.string().max(1000).meta({
    description:
      'Text, which may hold merge fields. One merge field alone, such as "{{contact.custom.utm_source}}", copies that field into this one, keeping its type; when the field copied from is empty, this one is left as it is. Text with merge fields mixed in is filled in as a message is, and must fit the field: a number field needs it to come out as a number, a date field as a date, a choice field as one of its choices.',
  }),
  z.number(),
  z.boolean(),
  z.null().meta({ description: 'Empties the field.' }),
  automationComputedValue,
]);

/**
 * What a contact.update step writes to one field: a fixed value, text with merge fields,
 * a computed value, or any of them under `set` beside `onlyIfEmpty`.
 */
export const automationFieldWrite = z
  .union([
    writtenValue,
    z.strictObject({
      set: writtenValue,
      onlyIfEmpty: z.boolean().optional().meta({
        description:
          'true: write only when the field has nothing in it; a field that has a value is left alone, and the step says so. Left out or false: the value is replaced.',
      }),
    }),
  ])
  .meta({ id: 'AutomationFieldWrite' });

export type AutomationFieldWrite = z.output<typeof automationFieldWrite>;
