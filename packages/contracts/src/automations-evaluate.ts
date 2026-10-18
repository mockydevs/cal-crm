// Evaluates an automation condition against a record's current values (AUTOMATIONS.md
// section 3). Triggers' filters, if/else steps and stop conditions all use it. A value
// that is missing, or of another kind than the comparison needs, makes it false: a run
// takes the safe branch rather than failing.
import type { AutomationCondition } from './automations-values.js';
import { zonedDay } from './automations-zoned.js';

/** Field values by canonical path, such as contact.custom.services. */
export type ConditionValue = string | number | boolean | readonly (string | number)[] | null;
export type ConditionValues = Readonly<Record<string, ConditionValue | undefined>>;

const DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** The date a duration from now lands on, in calendar terms: P1M from 31 January is 3 March. */
export function addDuration(from: Date, duration: string, sign: 1 | -1 = 1): Date | undefined {
  const match = DURATION.exec(duration);
  if (match === null) return undefined;
  // An unmatched group is undefined at run time, whatever the type says.
  const [years, months, weeks, days, hours, minutes, seconds] = match
    .slice(1)
    .map((part: string | undefined) => sign * Number(part ?? 0));
  const date = new Date(from.getTime());
  date.setUTCFullYear(date.getUTCFullYear() + (years ?? 0), date.getUTCMonth() + (months ?? 0));
  date.setUTCDate(date.getUTCDate() + (weeks ?? 0) * 7 + (days ?? 0));
  date.setTime(
    date.getTime() + (((hours ?? 0) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)) * 1000,
  );
  return date;
}

/**
 * A date as the stretch of time it stands for, from its start up to, not including, its
 * end. A date and time is one millisecond. A date with no time of day (YYYY-MM-DD) is that
 * whole day in the time zone given, so "tomorrow" and "today" are the run's own; with no
 * zone it is the instant of midnight UTC, as it always was.
 */
interface Span {
  readonly start: number;
  readonly end: number;
}

const asSpan = (
  value: ConditionValue | undefined,
  timeZone: string | undefined,
): Span | undefined => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  if (timeZone !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = zonedDay(value, timeZone);
    if (day !== undefined) return { start: day.start.getTime(), end: day.end.getTime() };
  }
  const instant = new Date(value).getTime();
  return Number.isNaN(instant) ? undefined : { start: instant, end: instant + 1 };
};

// Array.isArray narrows a readonly array to any[]; this keeps its element type.
const isList = (value: ConditionValue | undefined): value is readonly (string | number)[] =>
  Array.isArray(value);

const same = (left: string | number | boolean, right: string | number | boolean) =>
  typeof left === 'string' && typeof right === 'string'
    ? left.trim().toLowerCase() === right.trim().toLowerCase()
    : left === right;

const isEmpty = (value: ConditionValue | undefined) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (isList(value) && value.length === 0);

function compare(
  actual: ConditionValue | undefined,
  operator: string,
  expected: string | number | boolean,
  now: Date,
  timeZone: string | undefined,
): boolean {
  switch (operator) {
    case 'equals':
      return isList(actual)
        ? actual.some((item) => same(item, expected))
        : actual !== undefined && actual !== null && same(actual, expected);
    case 'not_equals':
      return !compare(actual, 'equals', expected, now, timeZone);
    case 'includes':
      if (isList(actual)) return actual.some((item) => same(item, expected));
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    case 'excludes':
      return !compare(actual, 'includes', expected, now, timeZone);
    case 'starts_with':
      // Text only, whatever its capitals; a list or a number starts with nothing.
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.trim().toLowerCase().startsWith(expected.trim().toLowerCase())
      );
    case 'greater_than':
    case 'less_than': {
      if (typeof actual === 'number' && typeof expected === 'number')
        return operator === 'greater_than' ? actual > expected : actual < expected;
      return compare(
        actual,
        operator === 'greater_than' ? 'after' : 'before',
        expected,
        now,
        timeZone,
      );
    }
    case 'before':
    case 'after': {
      const left = asSpan(actual, timeZone);
      const right = typeof expected === 'string' ? asSpan(expected, timeZone) : undefined;
      if (left === undefined || right === undefined) return false;
      // Wholly before, or wholly after: a day is neither before nor after a time in it.
      return operator === 'before' ? left.end <= right.start : left.start >= right.end;
    }
    case 'within_last':
    case 'within_next': {
      const date = asSpan(actual, timeZone);
      const edge =
        typeof expected === 'string'
          ? addDuration(now, expected, operator === 'within_last' ? -1 : 1)
          : undefined;
      if (date === undefined || edge === undefined) return false;
      // Any part of the date within the stretch from now back to the edge, or on to it.
      const [from, to] =
        operator === 'within_last'
          ? [edge.getTime(), now.getTime()]
          : [now.getTime(), edge.getTime()];
      return date.start <= to && date.end > from;
    }
    default:
      return false;
  }
}

/**
 * Whether the condition holds for these values at this moment. With a time zone, a date with
 * no time of day is judged as that day in the zone: the run's, which is the business's or
 * the contact's as the automation's settings say.
 */
export function evaluateCondition(
  condition: AutomationCondition,
  values: ConditionValues,
  now: Date,
  timeZone?: string,
): boolean {
  if ('all' in condition)
    return condition.all.every((each) => evaluateCondition(each, values, now, timeZone));
  if ('any' in condition)
    return condition.any.some((each) => evaluateCondition(each, values, now, timeZone));
  if ('not' in condition) return !evaluateCondition(condition.not, values, now, timeZone);
  const actual = values[condition.field];
  if (condition.operator === 'is_set') return !isEmpty(actual);
  if (condition.operator === 'is_empty') return isEmpty(actual);
  return (
    'value' in condition && compare(actual, condition.operator, condition.value, now, timeZone)
  );
}
