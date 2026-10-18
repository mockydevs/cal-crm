// The conditions of the contact list's Filters panel. A condition is a field, an operator
// and a value; conditions are held in groups, and a list names whether all or any of a
// group's conditions, and all or any of its groups, must hold. The list and its count take
// the whole filter as JSON text in `filter`; a saved view keeps it as it is.
import { parsePublicId, ValidationError, type Issue } from '@repo/kernel';
import * as z from 'zod';

import { parseInput } from './validation.js';

/** At most this many groups in a filter. */
export const MAX_CONTACT_FILTER_GROUPS = 10;
/** At most this many conditions in a filter, over all its groups. */
export const MAX_CONTACT_FILTER_CONDITIONS = 20;
/** At most this many values in "is any of" and its like. */
export const MAX_CONTACT_FILTER_VALUES = 50;
export { contactFilterParameter, MAX_CONTACT_FILTER_LENGTH } from './contact-filter-parameter.js';

export const contactFilterOperators = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'any_of',
  'all_of',
  'none_of',
  'is_empty',
  'is_not_empty',
  'before',
  'after',
  'between',
  'in_last',
  'not_in_last',
  'in_next',
  'gt',
  'gte',
  'lt',
  'lte',
  'enabled',
  'disabled',
] as const;
export type ContactFilterOperator = (typeof contactFilterOperators)[number];

/** What an operator needs beside the field: nothing, one value, several, two ends or days. */
export type ContactFilterOperand = 'none' | 'value' | 'values' | 'range' | 'days';

export const contactFilterOperands: Readonly<Record<ContactFilterOperator, ContactFilterOperand>> =
  {
    is: 'value',
    is_not: 'value',
    contains: 'value',
    not_contains: 'value',
    any_of: 'values',
    all_of: 'values',
    none_of: 'values',
    is_empty: 'none',
    is_not_empty: 'none',
    before: 'value',
    after: 'value',
    between: 'range',
    in_last: 'days',
    not_in_last: 'days',
    in_next: 'days',
    gt: 'value',
    gte: 'value',
    lt: 'value',
    lte: 'value',
    enabled: 'value',
    disabled: 'value',
  };

const presence = ['is_empty', 'is_not_empty'] as const;
const textOperators = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'any_of',
  'none_of',
  ...presence,
] as const;
const momentOperators = ['before', 'after', 'between', 'in_last', 'not_in_last'] as const;
const dateOperators = [...momentOperators, 'in_next', 'is', 'is_not', ...presence] as const;
const numberOperators = ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', ...presence] as const;
const choiceOperators = ['any_of', 'none_of', ...presence] as const;

/**
 * The kinds of field a condition can name, each with the operators it takes. `moment` is a
 * point in time (when a contact was added); `date` is a calendar day (a date of birth).
 */
export const contactFilterKinds = {
  text: textOperators,
  moment: momentOperators,
  date: dateOperators,
  number: numberOperators,
  choice: choiceOperators,
  boolean: ['is', ...presence],
  tags: ['any_of', 'all_of', 'none_of', ...presence],
  people: choiceOperators,
  dnd: ['enabled', 'disabled'],
} as const satisfies Readonly<Record<string, readonly ContactFilterOperator[]>>;
export type ContactFilterKind = keyof typeof contactFilterKinds;

/** The built-in fields a condition can name, and the kind each is. */
export const contactFilterFields = {
  firstName: 'text',
  lastName: 'text',
  name: 'text',
  email: 'text',
  phone: 'text',
  company: 'text',
  timezone: 'text',
  source: 'text',
  created: 'moment',
  updated: 'moment',
  dateOfBirth: 'date',
  tags: 'tags',
  owner: 'people',
  type: 'choice',
  createdSource: 'choice',
  dnd: 'dnd',
  // What email verification found of the primary email address: one of
  // contactEmailVerifications. Empty is a contact without an email address.
  emailVerification: 'choice',
} as const satisfies Readonly<Record<string, ContactFilterKind>>;
export type ContactFilterField = keyof typeof contactFilterFields;

/** What do not disturb can be asked about: every channel at once, or one. */
export const contactFilterDndChannels = [
  'all',
  'email',
  'sms',
  'call',
  'whatsapp',
  'webchat',
] as const;

const isBuiltIn = (field: string): field is ContactFilterField =>
  Object.hasOwn(contactFilterFields, field);

/** Whether a condition names a custom field: the field's public id. */
export const isContactFilterCustomField = (field: string): boolean =>
  parsePublicId('field', field) !== undefined;

const text = z.string().max(1000, { error: 'Use at most 1000 characters.' });

export const contactFilterCondition = z
  .strictObject({
    field: z
      .string()
      .max(60)
      .meta({
        description: `One of ${Object.keys(contactFilterFields).join(', ')}, or the id of a custom field of contacts.`,
        examples: ['tags'],
      }),
    operator: z.enum(contactFilterOperators),
    value: text.optional().meta({
      description:
        'For an operator that compares with one value. A moment is a timestamp, a date is YYYY-MM-DD, a number is in digits, yes or no is true or false, and do not disturb names all or a channel.',
    }),
    values: z
      .array(text)
      .min(1, { error: 'Give at least one value.' })
      .max(MAX_CONTACT_FILTER_VALUES, {
        error: `Give at most ${String(MAX_CONTACT_FILTER_VALUES)} values.`,
      })
      .optional()
      .meta({
        description:
          'For any_of, all_of and none_of. Tags are named by id, an owner by membership id or "me", a choice by its key.',
      }),
    from: text.optional().meta({ description: 'For between: the first value, included.' }),
    to: text.optional().meta({
      description: 'For between: the end. A moment ends before it; a date or number includes it.',
    }),
    days: z
      .int()
      .min(1, { error: 'Use 1 day or more.' })
      .max(3650, { error: 'Use at most 3650 days.' })
      .optional()
      .meta({ description: 'For in_last, not_in_last and in_next: the number of days.' }),
  })
  .superRefine((condition, context) => {
    const problem = (path: string, code: string, message: string) => {
      context.addIssue({ code: 'custom', path: [path], message, params: { code } });
    };
    const { field } = condition;
    if (!isBuiltIn(field) && !isContactFilterCustomField(field)) {
      problem('field', 'unknown_field', 'Choose a field contacts can be filtered by.');
      return;
    }
    if (isBuiltIn(field)) {
      const allowed: readonly string[] = contactFilterKinds[contactFilterFields[field]];
      if (!allowed.includes(condition.operator)) {
        problem('operator', 'invalid_operator', 'This field cannot be compared this way.');
        return;
      }
    }
    const operand = contactFilterOperands[condition.operator];
    const given = {
      value: condition.value !== undefined,
      values: condition.values !== undefined,
      range: condition.from !== undefined || condition.to !== undefined,
      days: condition.days !== undefined,
    };
    if (operand === 'value' && !given.value) problem('value', 'required', 'Give a value.');
    if (operand === 'values' && !given.values) problem('values', 'required', 'Give the values.');
    if (operand === 'days' && !given.days) problem('days', 'required', 'Give a number of days.');
    if (operand === 'range' && (condition.from === undefined || condition.to === undefined))
      problem(
        condition.from === undefined ? 'from' : 'to',
        'required',
        'Give both ends of the range.',
      );
    for (const [name, path] of [
      ['value', 'value'],
      ['values', 'values'],
      ['range', 'from'],
      ['days', 'days'],
    ] as const)
      if (given[name] && operand !== name)
        problem(path, 'not_taken', 'This operator does not take it.');
    if (
      condition.field === 'dnd' &&
      condition.value !== undefined &&
      !(contactFilterDndChannels as readonly string[]).includes(condition.value)
    )
      problem('value', 'invalid_channel', 'Name all, or one channel.');
  })
  .meta({ id: 'ContactFilterCondition' });
export type ContactFilterCondition = z.output<typeof contactFilterCondition>;

const match = z.enum(['all', 'any']).meta({
  description: 'Whether every one must hold (all, AND) or at least one (any, OR).',
});

export const contactFilterGroup = z
  .strictObject({
    match,
    conditions: z
      .array(contactFilterCondition)
      .min(1, { error: 'Add a condition to the group.' })
      .max(MAX_CONTACT_FILTER_CONDITIONS),
  })
  .meta({ id: 'ContactFilterGroup' });

export const contactFilter = z
  .strictObject({
    match,
    groups: z
      .array(contactFilterGroup)
      .min(1, { error: 'Add a group of conditions.' })
      .max(MAX_CONTACT_FILTER_GROUPS, {
        error: `Use at most ${String(MAX_CONTACT_FILTER_GROUPS)} groups.`,
      }),
  })
  .superRefine((filter, context) => {
    const conditions = filter.groups.reduce((sum, group) => sum + group.conditions.length, 0);
    if (conditions > MAX_CONTACT_FILTER_CONDITIONS)
      context.addIssue({
        code: 'custom',
        path: ['groups'],
        message: `Use at most ${String(MAX_CONTACT_FILTER_CONDITIONS)} conditions.`,
        params: { code: 'too_many_conditions' },
      });
  })
  .meta({
    id: 'ContactFilter',
    description:
      'Groups of conditions on contacts. `match` says whether all or any must hold, for the groups and inside each group.',
  });
export type ContactFilter = z.output<typeof contactFilter>;

/**
 * The filter a `filter` parameter holds. Text that is not JSON, or JSON that is not a
 * filter, is a ValidationError whose issues point into `filter`.
 */
export function parseContactFilter(parameter: string | undefined): ContactFilter | undefined {
  if (parameter === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(parameter);
  } catch {
    throw new ValidationError([
      { path: '/filter', code: 'invalid_json', message: 'Send the filter as JSON text.' },
    ]);
  }
  try {
    return parseInput(contactFilter, json);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const [first, ...rest] = error.issues.map((issue): Issue => ({
      ...issue,
      path: `/filter${issue.path}`,
    }));
    if (first === undefined) throw error;
    throw new ValidationError([first, ...rest]);
  }
}
