// How Reporting writes what the server counted: whole numbers, money for each currency
// (never one currency added to another), the days, weeks and months of a range as the
// server resolved them in the business's time zone, and how a number stands against the
// period before. Exact amounts are written by the moneyText the Dashboard's widgets use.
import type { ReportCell, ReportGrain, ReportResolvedRange } from '@repo/contracts';
import { moneyText } from '../chart-numbers';

export { moneyText };

/** What stands where there is no value. */
export const NOTHING = '—';

export function countText(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** A number as an axis marks it: short, such as 1.5K. */
export function axisText(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export interface Amount {
  /** Null for a count. */
  readonly currency: string | null;
  /** Only for the length of a bar or the height of a point: what is written is `text`. */
  readonly value: number;
  readonly text: string;
}

/**
 * A cell as amounts: one for a count, one for each currency of money in the order of their
 * codes, none where there is no value.
 */
export function amountsOf(cell: ReportCell | undefined, locale: string): Amount[] {
  if (cell === null || cell === undefined) return [];
  if (typeof cell === 'number')
    return [{ currency: null, value: cell, text: countText(cell, locale) }];
  return cell
    .toSorted((one, other) => one.currency.localeCompare(other.currency))
    .map((money) => ({
      currency: money.currency,
      value: Number(money.amount),
      text: moneyText(money),
    }));
}

/** A cell as lines of text: one for each currency. A dash where there is nothing. */
export function cellLines(cell: ReportCell | undefined, locale: string): string[] {
  const amounts = amountsOf(cell, locale);
  return amounts.length === 0 ? [NOTHING] : amounts.map((amount) => amount.text);
}

/** A cell as one number to sort by: a count, or the largest amount of its currencies. */
export function cellOrder(cell: ReportCell | undefined): number {
  if (cell === null || cell === undefined) return -1;
  if (typeof cell === 'number') return cell;
  return Math.max(-1, ...cell.map((money) => Number(money.amount)));
}

/** A calendar day (YYYY-MM-DD) as a date at noon UTC, so no time zone moves it. */
export function dateOfDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year ?? Number.NaN, (month ?? Number.NaN) - 1, date ?? Number.NaN, 12));
}

/**
 * A bucket of time by its first day: "5 Oct" for a day or a week (the screen says which),
 * "Oct 2026" for a month. `long` is what is read out and what a table shows.
 */
export function bucketText(
  day: string,
  grain: ReportGrain,
  locale: string,
  form: 'short' | 'long' = 'short',
): string {
  const date = dateOfDay(day);
  if (Number.isNaN(date.getTime())) return day;
  const options: Intl.DateTimeFormatOptions =
    grain === 'month'
      ? { month: form === 'short' ? 'short' : 'long', year: 'numeric' }
      : form === 'short'
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
}

/** The first and last day of a range, as the server resolved it. One day reads as one. */
export function rangeText(range: Pick<ReportResolvedRange, 'from' | 'to'>, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const from = format.format(dateOfDay(range.from));
  return range.from === range.to ? from : `${from} – ${format.format(dateOfDay(range.to))}`;
}

/** A day of the week by its number, 1 for Monday. */
export function weekdayText(
  weekday: number,
  locale: string,
  form: 'short' | 'long' = 'long',
): string {
  // The first of January 2024 was a Monday.
  const date = new Date(Date.UTC(2024, 0, weekday, 12));
  return new Intl.DateTimeFormat(locale, { weekday: form, timeZone: 'UTC' }).format(date);
}

/** A moment in the business's time zone. In the reader's own if the zone is not known here. */
export function momentText(moment: string, timeZone: string, locale: string): string {
  const date = new Date(moment);
  if (Number.isNaN(date.getTime())) return moment;
  const options = { dateStyle: 'medium', timeStyle: 'short' } as const;
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
}

export interface Change {
  readonly direction: 'up' | 'down' | 'same';
  /** The change as a share of the earlier number, from 0. None when that was nothing. */
  readonly percent: number | null;
  /** How much more (or, below zero, less) than before. */
  readonly difference: number;
}

/** How a number stands against the one before it. */
export function changeOf(current: number, previous: number): Change {
  const difference = current - previous;
  return {
    direction: difference > 0 ? 'up' : difference < 0 ? 'down' : 'same',
    percent: previous === 0 ? null : Math.abs(difference) / Math.abs(previous),
    difference,
  };
}

export interface Compared extends Amount {
  /** What the same measure was in the comparison period. None where it has no value there. */
  readonly before: Amount | undefined;
  readonly change: Change | undefined;
}

/**
 * A cell against the same cell of the comparison period, currency by currency: an amount
 * is compared only with the same currency's, and one that is new has nothing before it.
 * A currency that only the earlier period had is listed too, as nothing now.
 */
export function comparedOf(
  cell: ReportCell | undefined,
  before: ReportCell | undefined,
  locale: string,
): Compared[] {
  const now = amountsOf(cell, locale);
  const earlier = amountsOf(before, locale);
  const compared: Compared[] = now.map((amount) => {
    const match = earlier.find((each) => each.currency === amount.currency);
    return {
      ...amount,
      before: match,
      change: match === undefined ? undefined : changeOf(amount.value, match.value),
    };
  });
  for (const gone of earlier) {
    if (gone.currency === null || now.some((amount) => amount.currency === gone.currency)) continue;
    compared.push({
      currency: gone.currency,
      value: 0,
      text: moneyText({ currency: gone.currency, amount: '0' }),
      before: gone,
      change: changeOf(0, gone.value),
    });
  }
  return compared;
}

/** A change's size as text: "25%", or the difference itself when there is no share. */
export function changeSize(change: Change, locale: string): string {
  if (change.percent === null) return countText(Math.abs(change.difference), locale);
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
    change.percent,
  );
}

/** A change's sign, for eyes: what the words beside it say for ears. */
export function changeSign(change: Change): '+' | '−' | '' {
  return change.direction === 'up' ? '+' : change.direction === 'down' ? '−' : '';
}
