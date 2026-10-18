// What the Calendars pages work out before they draw: which days a view shows, the window
// that is read for them, and where an event sits in its day. The calendar is drawn in the
// business's time zone, as GoHighLevel draws a sub-account's, whatever the browser's zone
// is. No contract schema is read here.
//
// A day is a calendar date with no zone: a Date at midnight UTC, read with the getUTC
// methods. An instant becomes a date and a clock time in a zone through Intl, and a date and
// a clock time in a zone become an instant by the zone's offset there, read the same way.

export type CalendarViewMode = 'day' | 'week' | 'month';
export const calendarViewModes: readonly CalendarViewMode[] = ['day', 'week', 'month'];

export const DAY_MINUTES = 1440;
/** The shortest an event is drawn, so its title can be read and pressed. */
export const SHORTEST_DRAWN_MINUTES = 30;
const MINUTE_MS = 60_000;

/** The zone this browser is in, for when the business's own is not known. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** A zone's date and clock at an instant, to the second. */
function fieldsIn(instant: number, zone: string) {
  let format = zoneFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormats.set(zone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts['year'] ?? 1970,
    month: parts['month'] ?? 1,
    day: parts['day'] ?? 1,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
}

/** How far the zone's clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  const fields = fieldsIn(instant, zone);
  const wall = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  return wall - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The instant a clock in the zone shows `minutes` past midnight of a day. A time the clock
 * skips (the hour lost in spring) is read with the offset from before the change, so it
 * lands after it; a time it shows twice is the first.
 */
export function instantAt(day: Date, minutes: number, zone: string): number {
  const wall = day.getTime() + minutes * MINUTE_MS;
  const first = wall - offsetAt(wall, zone);
  const second = wall - offsetAt(first, zone);
  const shown = [first, second].filter((instant) => instant + offsetAt(instant, zone) === wall);
  return shown.length > 0 ? Math.min(...shown) : Math.max(first, second);
}

/** The day and minute of the day a zone's clock shows at an instant. */
export function wallClock(
  instant: number,
  zone: string,
): { readonly day: Date; readonly minutes: number; readonly second: number } {
  const fields = fieldsIn(instant, zone);
  return {
    day: new Date(Date.UTC(fields.year, fields.month - 1, fields.day)),
    minutes: fields.hour * 60 + fields.minute,
    second: fields.second,
  };
}

/** The day it is in a zone. */
export function todayIn(zone: string, now: Date = new Date()): Date {
  return wallClock(now.getTime(), zone).day;
}

/** A day, `days` after (or before) the day `date` is. */
export function dayAt(date: Date, days = 0): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

/** A day as 2026-10-11, for keys and `dateTime` attributes. */
export function dayKey(date: Date): string {
  const part = (value: number, length = 2): string => String(value).padStart(length, '0');
  return `${part(date.getUTCFullYear(), 4)}-${part(date.getUTCMonth() + 1)}-${part(date.getUTCDate())}`;
}

export function sameDay(one: Date, other: Date): boolean {
  return dayKey(one) === dayKey(other);
}

/**
 * The days a view shows around `anchor`: the day itself, its week from Sunday, or the six
 * weeks from the Sunday on or before the first of its month.
 */
export function daysOf(view: CalendarViewMode, anchor: Date): Date[] {
  if (view === 'day') return [dayAt(anchor)];
  if (view === 'week') {
    const sunday = dayAt(anchor, -anchor.getUTCDay());
    return Array.from({ length: 7 }, (_, index) => dayAt(sunday, index));
  }
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const start = dayAt(first, -first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => dayAt(start, index));
}

export interface Window {
  readonly from: Date;
  /** The first instant after the window. */
  readonly to: Date;
}

/** From the first midnight of the days shown to the midnight after the last, in the zone. */
export function windowOf(days: readonly Date[], zone: string): Window {
  const first = days[0] ?? todayIn(zone);
  const last = days.at(-1) ?? first;
  return {
    from: new Date(instantAt(first, 0, zone)),
    to: new Date(instantAt(dayAt(last, 1), 0, zone)),
  };
}

/** The anchor of the view before or after this one. */
export function stepped(view: CalendarViewMode, anchor: Date, direction: -1 | 1): Date {
  if (view === 'day') return dayAt(anchor, direction);
  if (view === 'week') return dayAt(anchor, 7 * direction);
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + direction, 1));
}

export interface Timed {
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Whether an event has any of its time in a day of the zone. */
export function onDay(event: Timed, day: Date, zone: string): boolean {
  return (
    Date.parse(event.startsAt) < instantAt(dayAt(day, 1), 0, zone) &&
    Date.parse(event.endsAt) > instantAt(day, 0, zone)
  );
}

export interface Placed<Event> {
  readonly event: Event;
  /** Minutes from midnight, by the clock on the wall. */
  readonly top: number;
  readonly height: number;
  /** Which of the `columns` side-by-side lanes it is in, from 0. */
  readonly column: number;
  readonly columns: number;
}

function wallMinutes(instant: number, day: Date, zone: string, edge: 'start' | 'end'): number {
  if (instant <= instantAt(day, 0, zone)) return 0;
  if (instant >= instantAt(dayAt(day, 1), 0, zone)) return DAY_MINUTES;
  const at = wallClock(instant, zone);
  // An end exactly on a minute stays there; one inside a minute takes the whole minute.
  return edge === 'end' && (at.second > 0 || instant % 1000 !== 0) ? at.minutes + 1 : at.minutes;
}

/**
 * Where each event of a day is drawn: cut to the day, at least SHORTEST_DRAWN_MINUTES tall,
 * and side by side with the events it overlaps.
 */
export function placedOn<Event extends Timed>(
  day: Date,
  events: readonly Event[],
  zone: string,
): Placed<Event>[] {
  const spans = events
    .filter((event) => onDay(event, day, zone))
    .map((event) => {
      const start = wallMinutes(Date.parse(event.startsAt), day, zone, 'start');
      const end = wallMinutes(Date.parse(event.endsAt), day, zone, 'end');
      const top = Math.min(start, DAY_MINUTES - SHORTEST_DRAWN_MINUTES);
      return { event, top, bottom: Math.max(end, top + SHORTEST_DRAWN_MINUTES) };
    })
    .toSorted((one, other) => one.top - other.top || other.bottom - one.bottom);

  const placed: Placed<Event>[] = [];
  let cluster: { span: (typeof spans)[number]; column: number }[] = [];
  let clusterEnd = 0;
  const flush = (): void => {
    const columns = Math.max(0, ...cluster.map((each) => each.column + 1));
    for (const { span, column } of cluster)
      placed.push({
        event: span.event,
        top: span.top,
        height: span.bottom - span.top,
        column,
        columns,
      });
    cluster = [];
  };
  for (const span of spans) {
    if (cluster.length > 0 && span.top >= clusterEnd) flush();
    const taken = new Set(
      cluster.filter((each) => each.span.bottom > span.top).map((each) => each.column),
    );
    let column = 0;
    while (taken.has(column)) column += 1;
    cluster.push({ span, column });
    clusterEnd = cluster.length === 1 ? span.bottom : Math.max(clusterEnd, span.bottom);
  }
  flush();
  return placed;
}

/** The lists of the Appointment list view: the `view` `listAppointments` takes. */
export type AppointmentTab = 'upcoming' | 'cancelled' | 'all';

/** What the Manage view panel narrows the calendar to: `listCalendarEvents` takes exactly these. */
export interface CalendarFilters {
  readonly type: 'all' | 'appointments' | 'blocked';
  /** Membership ids; none means everyone. */
  readonly users: readonly string[];
  /** Calendar ids; none means every calendar. */
  readonly calendars: readonly string[];
}

export const noFilters: CalendarFilters = { type: 'all', users: [], calendars: [] };

/** How many things the view is narrowed by, for the button that opens the panel. */
export function filterCount(filters: CalendarFilters): number {
  return (filters.type === 'all' ? 0 : 1) + filters.users.length + filters.calendars.length;
}

/** A list with an id ticked or unticked. */
export function toggled(ids: readonly string[], id: string, on: boolean): string[] {
  const without = ids.filter((each) => each !== id);
  return on ? [...without, id] : without;
}
