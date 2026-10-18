// Dates in a time zone, for date triggers and waits until a date field: an offset moves the
// date on the calendar and the time of day on the zone's clock, never the UTC instant by
// whole days.
import { addDuration, zonedTime } from '@repo/contracts';

/** A date's timing: an offset from it, and its time of day on the zone's wall clock. */
export interface DateRule {
  /** An ISO 8601 duration, such as P3D; nothing fires on the date itself. */
  readonly offset?: string | undefined;
  readonly direction: 'before' | 'after';
  /** HH:MM, on the wall clock of the time zone. */
  readonly time: string;
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET = /^(P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?)(?:T((?:\d+H)?(?:\d+M)?(?:\d+S)?))?$/;

// The part of an offset that moves the date and the part that moves the clock.
function offsetParts(
  offset: string | undefined,
): { readonly calendar?: string; readonly clock?: string } | undefined {
  if (offset === undefined) return {};
  const match = OFFSET.exec(offset);
  if (match === null) return undefined;
  const [, calendar = 'P', clock] = match;
  return {
    ...(calendar === 'P' ? {} : { calendar }),
    ...(clock === undefined || clock === '' ? {} : { clock: `PT${clock}` }),
  };
}

/** The calendar date (YYYY-MM-DD) of an instant read as UTC, if it is one a field holds. */
export const dateOf = (instant: Date): string | undefined => {
  if (Number.isNaN(instant.getTime())) return undefined;
  const date = instant.toISOString().slice(0, 10);
  return LOCAL_DATE.test(date) ? date : undefined;
};

// A date moved by whole days, weeks, months and years; nothing when either is not a date.
function movedDate(date: string, calendar: string, sign: 1 | -1): string | undefined {
  if (!LOCAL_DATE.test(date)) return undefined;
  const midnight = new Date(`${date}T00:00:00Z`);
  // 30 February reads as 2 March, so the date must read back as it was written.
  if (dateOf(midnight) !== date) return undefined;
  const moved = addDuration(midnight, calendar, sign);
  return moved === undefined ? undefined : dateOf(moved);
}

/**
 * The instant a date's timing lands on, in a time zone: the date moved by the offset's
 * years, months, weeks and days on the calendar, at the time of day on the zone's wall
 * clock, then moved by its hours, minutes and seconds. So "1 day before at 09:00" is 09:00
 * the day before across a clock change. A date trigger fires then, and a wait until a date
 * field ends then. The instant the trigger fires for a date (YYYY-MM-DD) in a time zone; nothing when the
 * date, the offset or the zone is not one, or the instant is beyond what can be kept.
 */
export function firingInstant(date: string, rule: DateRule, timeZone: string): Date | undefined {
  const parts = offsetParts(rule.offset);
  if (parts === undefined) return undefined;
  const sign = rule.direction === 'before' ? -1 : 1;
  const day = parts.calendar === undefined ? date : movedDate(date, parts.calendar, sign);
  if (day === undefined) return undefined;
  const base = zonedTime(day, rule.time, timeZone);
  if (base === undefined) return undefined;
  const instant = parts.clock === undefined ? base : addDuration(base, parts.clock, sign);
  return instant === undefined || Number.isNaN(instant.getTime()) ? undefined : instant;
}
