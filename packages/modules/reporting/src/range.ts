// A report's range as calendar days, with no clock and no time zone. A preset is worked out
// from today in the business's time zone, which the database says; the days are then turned
// into instants there, also by the database, so daylight-saving changes are PostgreSQL's to
// get right. Everything here is day arithmetic on the calendar.
import type {
  ReportCompareMode,
  ReportGrain,
  ReportPreset,
  ReportRangeInput,
} from '@repo/contracts';

/** A range of calendar days, both included, as YYYY-MM-DD. */
export interface DayRange {
  readonly from: string;
  readonly to: string;
}

const MS = 86_400_000;

const parse = (day: string): Date => new Date(`${day}T00:00:00Z`);
const format = (date: Date): string => date.toISOString().slice(0, 10);

/** The day so many days after (or, negative, before) a day. */
export const addDays = (day: string, days: number): string =>
  format(new Date(parse(day).getTime() + days * MS));

/** How many days a range holds. */
export const daysIn = (range: DayRange): number =>
  Math.round((parse(range.to).getTime() - parse(range.from).getTime()) / MS) + 1;

/** The Monday of a day's week. */
function monday(day: string): string {
  // getUTCDay: 0 is Sunday.
  return addDays(day, -((parse(day).getUTCDay() + 6) % 7));
}

/** The first day of the month so many months from a day's month. */
function monthStart(day: string, months: number): string {
  const date = parse(day);
  return format(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)));
}

/** The same day a year earlier; 29 February becomes the 28th. */
function yearBefore(day: string): string {
  const date = parse(day);
  const year = date.getUTCFullYear() - 1;
  const moved = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
  // A day the earlier year lacks rolls into March: take the last day of February instead.
  return moved.getUTCMonth() === date.getUTCMonth()
    ? format(moved)
    : format(new Date(Date.UTC(year, date.getUTCMonth() + 1, 0)));
}

const presets: Readonly<Record<ReportPreset, (today: string) => DayRange>> = {
  today: (today) => ({ from: today, to: today }),
  yesterday: (today) => ({ from: addDays(today, -1), to: addDays(today, -1) }),
  // "Last N days" ends today and holds N days.
  last_7_days: (today) => ({ from: addDays(today, -6), to: today }),
  last_30_days: (today) => ({ from: addDays(today, -29), to: today }),
  last_90_days: (today) => ({ from: addDays(today, -89), to: today }),
  this_week: (today) => ({ from: monday(today), to: addDays(monday(today), 6) }),
  last_week: (today) => ({ from: addDays(monday(today), -7), to: addDays(monday(today), -1) }),
  this_month: (today) => ({ from: monthStart(today, 0), to: addDays(monthStart(today, 1), -1) }),
  last_month: (today) => ({ from: monthStart(today, -1), to: addDays(monthStart(today, 0), -1) }),
  this_quarter: (today) => {
    const first = monthStart(today, -(parse(today).getUTCMonth() % 3));
    return { from: first, to: addDays(monthStart(first, 3), -1) };
  },
  last_quarter: (today) => {
    const first = monthStart(today, -(parse(today).getUTCMonth() % 3) - 3);
    return { from: first, to: addDays(monthStart(first, 3), -1) };
  },
  this_year: (today) => ({ from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` }),
  last_year: (today) => {
    const year = String(Number(today.slice(0, 4)) - 1).padStart(4, '0');
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  },
  // The eleven whole months before this one, and this month to today.
  last_12_months: (today) => ({ from: monthStart(today, -11), to: today }),
};

/** The days a range names, given what day it is in the business's time zone. */
export function resolveDays(range: ReportRangeInput, today: string): DayRange {
  return 'preset' in range ? presets[range.preset](today) : { from: range.from, to: range.to };
}

/**
 * The range a comparison counts: the same number of days ending the day before the range
 * starts, or the same days a year earlier.
 */
export function compareDays(range: DayRange, mode: ReportCompareMode): DayRange {
  if (mode === 'previous_year') return { from: yearBefore(range.from), to: yearBefore(range.to) };
  return { from: addDays(range.from, -daysIn(range)), to: addDays(range.from, -1) };
}

/**
 * The buckets of a range, each by its first day, in order: every day, the Monday of every
 * week, or the first of every month the range touches. The first and the last bucket hold
 * only the days of them that are in the range.
 */
export function bucketsOf(range: DayRange, grain: ReportGrain): string[] {
  const start = (day: string): string =>
    grain === 'day' ? day : grain === 'week' ? monday(day) : monthStart(day, 0);
  const next = (bucket: string): string =>
    grain === 'day'
      ? addDays(bucket, 1)
      : grain === 'week'
        ? addDays(bucket, 7)
        : monthStart(bucket, 1);
  const buckets: string[] = [];
  for (let bucket = start(range.from); bucket <= range.to; bucket = next(bucket))
    buckets.push(bucket);
  return buckets;
}
