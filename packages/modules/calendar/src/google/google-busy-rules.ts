// What a member's Google busy time means for slots, as pure functions over intervals in
// milliseconds since the epoch.

export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** How long a reading of Google counts as known: three missed 5-minute refreshes. */
export const GOOGLE_FRESH_MS = 15 * 60_000;
/** One freeBusy request asks for at most this long: Google documents no longest range. */
export const GOOGLE_FREEBUSY_SPAN_MS = 30 * 86_400_000;
/** A refresh looks this far ahead at least, and at most. */
export const GOOGLE_HORIZON_MIN_DAYS = 14;
export const GOOGLE_HORIZON_MAX_DAYS = 120;
/** A refresh starts this long before now, for a meeting already going on. */
export const GOOGLE_LOOKBACK_MS = 3_600_000;

/** Sorted, with touching and overlapping intervals joined. Empty ones are dropped. */
export function merged(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out.at(-1);
    if (last !== undefined && interval.start <= last.end)
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) };
    else out.push({ ...interval });
  }
  return out;
}

/** What of `from` is left once every one of `remove` is taken out. */
export function subtracted(from: readonly Interval[], remove: readonly Interval[]): Interval[] {
  const holes = merged(remove);
  const out: Interval[] = [];
  for (const interval of merged(from)) {
    let cursor = interval.start;
    for (const hole of holes) {
      if (hole.end <= cursor || hole.start >= interval.end) continue;
      if (hole.start > cursor) out.push({ start: cursor, end: hole.start });
      cursor = Math.max(cursor, hole.end);
      if (cursor >= interval.end) break;
    }
    if (cursor < interval.end) out.push({ start: cursor, end: interval.end });
  }
  return out;
}

/** The parts of the range no interval covers. */
export function uncovered(range: Interval, covered: readonly Interval[]): Interval[] {
  return subtracted([range], covered);
}

/**
 * What counts as busy for one member in a range:
 * - Google's busy time, less the CRM's own copies of its appointments (`own`), which are
 *   busy in the CRM anyway and must never block their own move;
 * - and every part of the range no recent reading covers (`known`): unknown is not free.
 */
export function googleBusyIn(
  range: Interval,
  busy: readonly Interval[],
  own: readonly Interval[],
  known: readonly Interval[],
): Interval[] {
  return merged([...subtracted(busy, own), ...uncovered(range, known)]).flatMap((interval) => {
    const start = Math.max(interval.start, range.start);
    const end = Math.min(interval.end, range.end);
    return end > start ? [{ start, end }] : [];
  });
}

/** The pieces a refresh asks Google for, each at most one request long. */
export function freeBusySpans(range: Interval, span = GOOGLE_FREEBUSY_SPAN_MS): Interval[] {
  const spans: Interval[] = [];
  for (let start = range.start; start < range.end; start += span)
    spans.push({ start, end: Math.min(range.end, start + span) });
  return spans;
}

/**
 * How far ahead a refresh reads: to the end of the furthest booking window among the
 * member's calendars, a day more for time zones, within the minimum and maximum.
 */
export function horizonDays(maxDaysAhead: readonly number[]): number {
  const furthest = Math.max(0, ...maxDaysAhead) + 1;
  return Math.min(GOOGLE_HORIZON_MAX_DAYS, Math.max(GOOGLE_HORIZON_MIN_DAYS, furthest));
}

/** The next refresh: five minutes on, ±25% at random (Google's quota guide). */
export function nextRefreshDelayMs(random: number): number {
  return Math.round(5 * 60_000 * (0.75 + 0.5 * Math.min(Math.max(random, 0), 1)));
}

/**
 * A Google event id for an appointment: `crm`, the UUID's 32 hex digits and a generation.
 * Hex digits and these letters are all base32hex (a-v, 0-9), as Google requires.
 */
export function googleEventId(appointmentId: string, generation: number): string {
  return `crm${appointmentId.replaceAll('-', '').toLowerCase()}g${String(generation)}`;
}

/**
 * Access tokens in this process's memory only, until a minute before Google says they
 * expire. Keyed by the sealed secret, so a reconnection never uses an old account's token.
 */
export interface TokenCache {
  get(secretId: string): string | undefined;
  set(secretId: string, token: string, expiresInSeconds: number): void;
  forget(secretId: string): void;
}

export function tokenCache(now: () => number = Date.now): TokenCache {
  const tokens = new Map<string, { readonly token: string; readonly until: number }>();
  return {
    get(secretId: string): string | undefined {
      const held = tokens.get(secretId);
      if (held === undefined || held.until <= now()) return undefined;
      return held.token;
    },
    set(secretId: string, token: string, expiresInSeconds: number): void {
      if (tokens.size > 10_000) tokens.clear();
      tokens.set(secretId, { token, until: now() + (expiresInSeconds - 60) * 1000 });
    },
    forget(secretId: string): void {
      tokens.delete(secretId);
    },
  };
}

/** Whether a member's first meeting place asks for a Google Meet. */
export function meetsOnGoogle(locations: unknown): boolean {
  if (!Array.isArray(locations)) return false;
  const first: unknown = locations[0];
  return (
    typeof first === 'object' && first !== null && 'kind' in first && first.kind === 'google_meet'
  );
}

/**
 * Whether an appointment asks Google for a Meet: its member meets on Google first, and the
 * appointment was given that place, or already holds the link of the Meet written for it.
 * One booked while the member's Google was not connected was given their next place
 * (meetingPlaceOf), and keeps it when they connect again; so does one whose place the team
 * wrote themselves.
 */
export function appointmentMeetsOnGoogle(
  locations: unknown,
  location: string | null,
  writtenMeetUrl: string | null,
): boolean {
  if (!meetsOnGoogle(locations) || location === null) return false;
  const [first] = locations as readonly { readonly value?: unknown }[];
  return location === first?.value || location === writtenMeetUrl;
}

/** What a Google event says of the appointment: the calendar, and whom it is with. */
export function eventDescription(
  calendarName: string,
  contact: { readonly first_name: string | null; readonly last_name: string | null } | undefined,
  identities: readonly { readonly kind: string; readonly value: string }[],
): string {
  const name = [contact?.first_name, contact?.last_name]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ');
  const email = identities.find((identity) => identity.kind === 'email')?.value;
  const phone = identities.find((identity) => identity.kind === 'phone')?.value;
  return [
    `Booked in the CRM on the calendar ${calendarName}.`,
    name === '' ? undefined : `Contact: ${name}`,
    email === undefined ? undefined : `Email: ${email}`,
    phone === undefined ? undefined : `Phone: ${phone}`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}
