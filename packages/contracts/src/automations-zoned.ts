// Wall clocks in a time zone, for automations: the instant a local date and time is, and
// the local date an instant falls on. Shared by the engine's waits and by conditions, which
// judge a date with no time of day as a day in the run's zone.

const DAY = 86_400_000;

/**
 * A wall clock reading as milliseconds, as if it were UTC. Date.UTC would read the years
 * 0 to 99 as 1900 to 1999, so the year is set on its own.
 */
export function zoneWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, 0);
  return wall.getTime();
}

// Making a formatter is far dearer than using one, and a recurring task's dates ask for the
// same few zones again and again: each is made once. There are some 600 zones; a map of
// more than that holds names that are not zones, and starts again.
const clocks = new Map<string, Intl.DateTimeFormat | null>();
const MAX_CLOCKS = 1000;

/** Intl's wall clock for a time zone, or nothing when the zone is not one Intl knows. */
export function zoneClock(timeZone: string): Intl.DateTimeFormat | undefined {
  const kept = clocks.get(timeZone);
  if (kept !== undefined) return kept ?? undefined;
  if (clocks.size >= MAX_CLOCKS) clocks.clear();
  const clock = makeClock(timeZone);
  clocks.set(timeZone, clock ?? null);
  return clock;
}

function makeClock(timeZone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return undefined;
  }
}

/** The offset of a time zone from UTC at an instant, in milliseconds. */
export function zoneOffset(clock: Intl.DateTimeFormat, instant: number): number {
  const parts = clock.formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  // Intl counts the years before year 1 backwards: year 0 is 1 BC.
  const beforeYearOne = parts.some((each) => each.type === 'era' && each.value === 'BC');
  const wall = zoneWallClock(
    beforeYearOne ? 1 - part('year') : part('year'),
    part('month'),
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a local date (YYYY-MM-DD) and time (HH:MM) is in a time zone, such as
 * 2026-10-18 09:00 in Nairobi; nothing when the date, the time or the zone does not exist.
 * Where the clocks change it follows Temporal's "compatible" rule: a time the clocks skip
 * moves forward by the length of the gap (02:30 becomes 03:30), and a time that comes twice
 * is the first of the two.
 */
export function zonedTime(date: string, time: string, timeZone: string): Date | undefined {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const wall = zoneWallClock(year, month, day, hour, minute, 0);
  const clock = zoneClock(timeZone);
  // 30 February would roll over into March, so the clock must read back as it was written.
  if (
    clock === undefined ||
    Number.isNaN(wall) ||
    new Date(wall).toISOString().slice(0, 16) !== `${date}T${time}`
  )
    return undefined;
  // The offsets a day either side are those before and after any change near this time.
  const candidates = [wall - zoneOffset(clock, wall - DAY), wall - zoneOffset(clock, wall + DAY)];
  const real = candidates.filter((each) => each + zoneOffset(clock, each) === wall);
  // Neither is real in a gap, where the offset before the change gives the later instant.
  return new Date(real.length > 0 ? Math.min(...real) : Math.max(...candidates));
}

/**
 * The local date (YYYY-MM-DD), time of day (HH:MM) and seconds of an instant in a time zone;
 * nothing when the zone is not one or the instant is not.
 */
export function zonedParts(
  instant: Date,
  timeZone: string,
): { readonly date: string; readonly time: string; readonly seconds: number } | undefined {
  const clock = zoneClock(timeZone);
  if (clock === undefined || Number.isNaN(instant.getTime())) return undefined;
  const wall = new Date(instant.getTime() + zoneOffset(clock, instant.getTime()));
  const written = wall.toISOString();
  // A year beyond four digits is written with a sign, and is not a date a field holds.
  if (!/^\d{4}-/.test(written)) return undefined;
  return {
    date: written.slice(0, 10),
    time: written.slice(11, 16),
    seconds: wall.getUTCSeconds() + wall.getUTCMilliseconds() / 1000,
  };
}

/**
 * The day a date with no time of day (YYYY-MM-DD) is in a time zone: from its first moment
 * to the first moment of the next day. Nothing when the date or the zone is not one.
 */
export function zonedDay(
  date: string,
  timeZone: string,
): { readonly start: Date; readonly end: Date } | undefined {
  const start = zonedTime(date, '00:00', timeZone);
  if (start === undefined) return undefined;
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = zonedTime(next.toISOString().slice(0, 10), '00:00', timeZone);
  return end === undefined ? undefined : { start, end };
}
