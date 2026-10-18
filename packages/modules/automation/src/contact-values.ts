// What a contact.update step writes: each field's value worked out from the step's settings
// and the contact's values as the step runs. A fixed value is written as it always was.
// Text with merge fields is filled in as a message is, and one merge field alone copies
// that field. A computed value (now, a date moved by days, arithmetic) is worked out here.
// Whatever comes of it is fitted to the field it is written to, and refused in plain words
// when it does not fit.
//
// No database here: a real run and a test run plan the same writes from the same values,
// and every value is planned before any is written, so a step writes all of them or none.
import {
  mergeTokens,
  renderMessageTemplate,
  zonedTime,
  type AutomationComputedValue,
  type AutomationFieldWrite,
  type ConditionValue,
  type ConditionValues,
} from '@repo/contracts';
import { ValidationError } from '@repo/kernel';

/** A value as the CRM's commands take one: numbers as decimal text, choices by key. */
export type PlannedValue = string | number | boolean | readonly string[] | null;

/** The field a value is written to: its kind, and its choices when it has them. */
export interface TargetField {
  readonly type: string;
  readonly options: readonly { readonly key: string; readonly label: string }[];
}

export interface PlannedWrites {
  /** Each field to write, by path, in the order the step lists them. */
  readonly writes: Readonly<Record<string, PlannedValue>>;
  /** What was left alone and why, for the step's explanation. */
  readonly notes: readonly string[];
}

export interface PlanContext {
  readonly now: Date;
  /** The zone the automation's settings name: today's date and midnight are read in it. */
  readonly timeZone: string;
  /** The field at a path, or nothing when the business has no such field. */
  readonly target: (path: string) => TargetField | undefined;
}

const refuse = (path: string, code: string, message: string): ValidationError =>
  new ValidationError([{ path: `/config/fields/${path}`, code, message }]);

const isEmpty = (value: ConditionValue | undefined): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

const shown = (value: PlannedValue | ConditionValue): string =>
  Array.isArray(value) ? value.join(', ') : String(value);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** The calendar date an instant falls on in a time zone, as YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const part = (type: string) => parts.find((each) => each.type === type)?.value ?? '';
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    return DATE.test(date) ? date : undefined;
  } catch {
    return undefined;
  }
}

/** A date with a number of days added, on the calendar: 2026-01-31 and 1 is 2026-02-01. */
function addDays(date: string, days: number): string | undefined {
  const moved = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(moved.getTime())) return undefined;
  moved.setUTCDate(moved.getUTCDate() + days);
  return Number.isNaN(moved.getTime()) ? undefined : moved.toISOString().slice(0, 10);
}

// A number as the CRM keeps one: without the tail that binary arithmetic leaves behind.
const tidy = (value: number): number => Number(value.toFixed(6));

/** A value read as a date: the day alone, or an instant. Nothing when it is neither. */
function dateOf(
  value: ConditionValue | undefined,
): { readonly day: string } | { readonly instant: Date } | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (DATE.test(text)) return addDays(text, 0) === text ? { day: text } : undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return undefined;
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? undefined : { instant };
}

function computed(
  path: string,
  value: AutomationComputedValue,
  target: TargetField,
  values: ConditionValues,
  context: PlanContext,
): PlannedValue {
  if (value.op === 'math') {
    const operand = (given: number | string, side: string): number => {
      if (typeof given === 'number') return given;
      const held = values[given];
      if (isEmpty(held))
        throw refuse(
          path,
          'missing_values',
          `${given} has nothing in it, so there is no number on the ${side}.`,
        );
      const number =
        typeof held === 'number'
          ? held
          : typeof held === 'string' && DECIMAL.test(held.trim())
            ? Number(held.trim())
            : Number.NaN;
      if (!Number.isFinite(number))
        throw refuse(
          path,
          'invalid_operand',
          `${given} holds "${shown(held ?? null)}", which is not a number.`,
        );
      return number;
    };
    const left = operand(value.left, 'left');
    const right = operand(value.right, 'right');
    if (value.operator === '/' && right === 0)
      throw refuse(
        path,
        'division_by_zero',
        `${typeof value.right === 'string' ? value.right : 'The right-hand number'} is 0, and nothing can be divided by zero.`,
      );
    const result =
      value.operator === '+'
        ? left + right
        : value.operator === '-'
          ? left - right
          : value.operator === '*'
            ? left * right
            : left / right;
    if (!Number.isFinite(result))
      throw refuse(path, 'invalid_value', 'The arithmetic gives a number too large to keep.');
    return fitted(path, tidy(result), target, context);
  }
  const today = localDate(context.now, context.timeZone);
  if (today === undefined)
    throw refuse(path, 'invalid_time_zone', `${context.timeZone} is not a time zone.`);
  // "Now" for a date field is today on the zone's calendar; for anything else, the instant.
  const now = target.type === 'date' ? { day: today } : { instant: context.now };
  if (value.op === 'now') return fitted(path, dateText(now), target, context);
  let base: { readonly day: string } | { readonly instant: Date } | undefined;
  if (value.field !== undefined) {
    const held = values[value.field];
    if (isEmpty(held))
      throw refuse(
        path,
        'missing_values',
        `${value.field} has no date in it, so there is nothing to count from.`,
      );
    base = dateOf(held);
    if (base === undefined)
      throw refuse(
        path,
        'invalid_operand',
        `${value.field} holds "${shown(held ?? null)}", which is not a date.`,
      );
  } else if (value.value === undefined || value.value === 'now') base = now;
  else base = dateOf(value.value);
  if (base === undefined)
    throw refuse(path, 'invalid_operand', `${String(value.value)} is not a date.`);
  if ('day' in base) {
    const moved = addDays(base.day, value.days);
    if (moved === undefined) throw refuse(path, 'date_out_of_range', 'The date is out of range.');
    return fitted(path, moved, target, context);
  }
  const moved = new Date(base.instant.getTime());
  moved.setUTCDate(moved.getUTCDate() + value.days);
  if (Number.isNaN(moved.getTime()))
    throw refuse(path, 'date_out_of_range', 'The date is out of range.');
  return fitted(path, moved.toISOString(), target, context);
}

const dateText = (date: { readonly day: string } | { readonly instant: Date }): string =>
  'day' in date ? date.day : date.instant.toISOString();

const TRUE = new Set(['true', 'yes', '1']);
const FALSE = new Set(['false', 'no', '0']);

/**
 * A value worked out as the step runs, as the field it is written to takes it: text as it
 * is, a number as decimal text, a date as the day, a choice by its key. Refused, in words
 * that name the field and what came out, when it is not something the field can hold.
 */
function fitted(
  path: string,
  raw: ConditionValue,
  target: TargetField,
  context: PlanContext,
): PlannedValue {
  const text = shown(raw).trim();
  const misfit = (kind: string) =>
    refuse(path, 'invalid_value', `${path} takes ${kind}, and the value came out as "${text}".`);
  switch (target.type) {
    case 'number':
    case 'money':
      if (typeof raw === 'number' && Number.isFinite(raw)) return String(tidy(raw));
      if (typeof raw === 'string' && DECIMAL.test(text)) return text;
      throw misfit('a number');
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (TRUE.has(text.toLowerCase())) return true;
      if (FALSE.has(text.toLowerCase())) return false;
      throw misfit('yes or no (true or false)');
    case 'date': {
      const date = dateOf(text);
      if (date === undefined) throw misfit('a date, such as 2026-12-01');
      if ('day' in date) return date.day;
      const day = localDate(date.instant, context.timeZone);
      if (day === undefined)
        throw refuse(path, 'invalid_time_zone', `${context.timeZone} is not a time zone.`);
      return day;
    }
    case 'datetime': {
      const date = dateOf(text);
      if (date === undefined) throw misfit('a date and time, such as 2026-12-01T09:00:00Z');
      if ('instant' in date) return date.instant.toISOString();
      // A day alone is its first moment in the automation's zone.
      const start = zonedTime(date.day, '00:00', context.timeZone);
      if (start === undefined)
        throw refuse(path, 'invalid_time_zone', `${context.timeZone} is not a time zone.`);
      return start.toISOString();
    }
    case 'single_choice': {
      const given = Array.isArray(raw) ? raw.map(String) : [text];
      const [only] = given;
      const option = given.length === 1 && only !== undefined ? optionOf(target, only) : undefined;
      if (option === undefined) throw misfit(`one of its choices (${choices(target)})`);
      return option;
    }
    case 'multi_choice': {
      const given = Array.isArray(raw)
        ? raw.map(String)
        : text.split(',').map((each) => each.trim());
      const keys = given.map((each) => optionOf(target, each));
      if (keys.length === 0 || keys.some((key) => key === undefined))
        throw misfit(`its choices (${choices(target)})`);
      return [...new Set(keys.filter((key): key is string => key !== undefined))];
    }
    default:
      // Text of every kind, an email address, a phone number, a link: as it came out. The
      // CRM's own check of the field is behind this one.
      return Array.isArray(raw) ? raw.join(', ') : typeof raw === 'string' ? raw : text;
  }
}

const optionOf = (target: TargetField, given: string): string | undefined =>
  target.options.find(
    (option) =>
      option.key === given || option.label.trim().toLowerCase() === given.trim().toLowerCase(),
  )?.key;

const choices = (target: TargetField): string =>
  target.options.map((option) => option.label).join(', ');

/** The one field a text copies, when it is one merge field and nothing else. */
function copied(text: string): string | undefined {
  const match = /^\s*\{\{\s*([a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\}\}\s*$/.exec(text);
  return match?.[1];
}

/**
 * The value of every field a contact.update step names, ready to write, and what it leaves
 * alone. Throws the refusal of the first value that cannot be worked out or does not fit
 * its field, before anything is written.
 */
export function planFieldWrites(
  fields: Readonly<Record<string, AutomationFieldWrite>>,
  values: ConditionValues,
  context: PlanContext,
): PlannedWrites {
  const writes: Record<string, PlannedValue> = {};
  const notes: string[] = [];
  for (const [path, entry] of Object.entries(fields)) {
    const wrapped = typeof entry === 'object' && entry !== null && 'set' in entry;
    const written = wrapped ? entry.set : entry;
    if (wrapped && entry.onlyIfEmpty === true && !isEmpty(values[path])) {
      notes.push(`${path} already has a value, so it was left as it was.`);
      continue;
    }
    // A fixed value is written as it always was: the CRM's command checks it.
    if (written === null || typeof written === 'number' || typeof written === 'boolean') {
      writes[path] = written;
      continue;
    }
    if (typeof written === 'string' && mergeTokens({ subject: '', body: written }).length === 0) {
      writes[path] = written;
      continue;
    }
    const target = context.target(path);
    if (target === undefined) throw refuse(path, 'unknown_field', `${path} is not a field.`);
    if (typeof written === 'object') {
      writes[path] = computed(path, written, target, values, context);
      continue;
    }
    const source = copied(written);
    if (source !== undefined) {
      // One field copied into another keeps its kind; nothing to copy changes nothing.
      const held = values[source];
      if (isEmpty(held) || held === undefined) {
        notes.push(`${source} has nothing in it, so ${path} was left as it was.`);
        continue;
      }
      writes[path] = fitted(path, held, target, context);
      continue;
    }
    const rendered = renderMessageTemplate({ subject: '', body: written }, values);
    if (!rendered.ok)
      throw refuse(path, 'missing_values', `There is no value for ${rendered.fields.join(', ')}.`);
    writes[path] = fitted(path, rendered.body, target, context);
  }
  return { writes, notes };
}

/** The kinds of the contact's own fields a step can write. */
export const BUILT_IN_TARGETS: Readonly<Record<string, TargetField>> = {
  'contact.firstName': { type: 'text', options: [] },
  'contact.lastName': { type: 'text', options: [] },
  'contact.email': { type: 'email', options: [] },
  'contact.phone': { type: 'phone', options: [] },
};

/** What the step says it did: the fields written, and what it left alone. */
export function writesExplanation(planned: PlannedWrites, done: string, nothing: string): string {
  const said = Object.keys(planned.writes).length === 0 ? nothing : done;
  return planned.notes.length === 0 ? said : `${said} ${planned.notes.join(' ')}`;
}
