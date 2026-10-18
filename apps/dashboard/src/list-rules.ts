// What the contacts list and the opportunities list work out before they draw: which
// columns show and in what order, how many filters narrow the list, and where its paging is.
import type { ContactViewState } from '@repo/contracts';

/** The name column first, as it always shows, then the others in their order. */
export function nameFirst<Key extends string>(columns: readonly Key[]): (Key | 'name')[] {
  return ['name', ...columns.filter((key) => key !== 'name')];
}

/** Moves a column one place up (-1) or down (1), never past the name column or an end. */
export function moveColumn<Key extends string>(
  columns: readonly Key[],
  key: Key,
  offset: -1 | 1,
): Key[] {
  const next = [...columns];
  const index = next.indexOf(key);
  const neighbor = next[index + offset];
  if (index < 0 || key === 'name' || neighbor === undefined || neighbor === 'name') return next;
  next[index] = neighbor;
  next[index + offset] = key;
  return next;
}

export function sameColumns(one: readonly string[], other: readonly string[]): boolean {
  return one.length === other.length && one.every((key, index) => key === other[index]);
}

/** How many filters narrow the list: the period and the field condition, not the order. */
export function filterCount(state: ContactViewState): number {
  return (state.added === undefined ? 0 : 1) + (state.fieldId === undefined ? 0 : 1);
}

export interface Paging {
  /** The page that shows, counted from 1. */
  readonly number: number;
  /** How many pages there are, once the server has no more to give. */
  readonly total: number | undefined;
  readonly previous: boolean;
  readonly next: boolean;
}

/**
 * Where a list read page after page is: `index` is the page asked for, `loaded` how many
 * pages have arrived, and `more` whether the server has another after them. With the
 * `count` of everything the list holds, the number of pages is known before the last one
 * has loaded; the pages that have loaded are believed over a count they contradict.
 */
export function pageOf({
  index,
  loaded,
  more,
  count,
  pageSize,
}: {
  readonly index: number;
  readonly loaded: number;
  readonly more: boolean;
  readonly count?: number;
  readonly pageSize?: number;
}): Paging {
  const shown = Math.max(0, Math.min(index, loaded - 1));
  const counted =
    count === undefined || pageSize === undefined ? undefined : Math.ceil(count / pageSize);
  return {
    number: shown + 1,
    total: more
      ? counted !== undefined && counted > loaded
        ? counted
        : undefined
      : Math.max(1, loaded),
    previous: shown > 0,
    next: shown < loaded - 1 || more,
  };
}

/**
 * The table columns an address names, the name first, or undefined when it names none or
 * something that isn't one: each column a known one, and each once.
 */
export function tableColumnsOf<Key extends string>(
  value: unknown,
  known: readonly Key[],
): (Key | 'name')[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const columns = value.filter((each): each is Key => known.some((key) => key === each));
  if (columns.length !== value.length || new Set(columns).size !== columns.length) return undefined;
  return nameFirst(columns);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a moment was, in the largest unit that has passed whole, as
 * Intl.RelativeTimeFormat takes it: a negative number of that unit. A moment less than a
 * minute ago, or one the clocks put ahead, is now.
 */
export function timeSince(
  moment: Date,
  now: Date,
): {
  readonly value: number;
  readonly unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
} {
  const passed = Math.max(0, now.getTime() - moment.getTime());
  const ago = (whole: number): number => (whole === 0 ? 0 : -whole);
  if (passed < HOUR) return { value: ago(Math.floor(passed / MINUTE)), unit: 'minute' };
  if (passed < DAY) return { value: ago(Math.floor(passed / HOUR)), unit: 'hour' };
  const days = Math.floor(passed / DAY);
  if (days < 7) return { value: ago(days), unit: 'day' };
  if (days < 30) return { value: ago(Math.floor(days / 7)), unit: 'week' };
  if (days < 365) return { value: ago(Math.floor(days / 30)), unit: 'month' };
  return { value: ago(Math.floor(days / 365)), unit: 'year' };
}
