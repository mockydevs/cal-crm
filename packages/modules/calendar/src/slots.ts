import type { Calendar, CalendarConfiguration } from '@repo/contracts';
import { Temporal } from '@js-temporal/polyfill';
import { fitsUserAvailability, type UserAvailabilityProfile } from './user-availability.js';

export interface SlotMember {
  readonly id: string;
  readonly weight: number;
}
export interface BusyPeriod {
  readonly startsAt: string;
  readonly endsAt: string;
}
export type BusyByMember = ReadonlyMap<string, readonly BusyPeriod[]>;
export type CalendarSlotRules = Pick<
  Calendar,
  | 'timezone'
  | 'slotMinutes'
  | 'bufferBeforeMinutes'
  | 'bufferAfterMinutes'
  | 'minNoticeMinutes'
  | 'maxDaysAhead'
> &
  Pick<CalendarConfiguration, 'weeklyHours' | 'dateOverrides'> & {
    readonly members: readonly SlotMember[];
    /** How often a slot starts. Without one, every slotMinutes, one after another. */
    readonly slotIntervalMinutes?: number | null;
    /** The booking window counts only days with opening hours. */
    readonly countAvailableDaysOnly?: boolean;
    /** The most appointments a local date takes, with how many it already has. */
    readonly dayLimit?: { readonly max: number; readonly booked: number };
    /**
     * Holds back this share of the open slots so the calendar looks busier than it is. The
     * same slots are held back every time for one seed, so a slot shown is a slot that books.
     */
    readonly lookBusy?: { readonly percent: number; readonly seed: string };
    /**
     * The most appointments one start time takes on this calendar (maxPerSlot), with how
     * many each start already has, by its instant as Temporal writes it. Each still needs
     * a host of its own who is free.
     */
    readonly slotLimit?: { readonly max: number; readonly taken: ReadonlyMap<string, number> };
  };
export interface CalendarSlot {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly availableMemberIds: readonly string[];
}
export interface WeightedCandidate extends SlotMember {
  readonly assignedCount: bigint;
}
/** Positive contract-validated weights and nonnegative assignment counts; stable ties. */
export function chooseWeightedMember(candidates: readonly WeightedCandidate[]): string | undefined {
  let chosen: WeightedCandidate | undefined;
  for (const candidate of candidates) {
    if (chosen === undefined) {
      chosen = candidate;
      continue;
    }
    const candidateRatio = candidate.assignedCount * BigInt(chosen.weight);
    const chosenRatio = chosen.assignedCount * BigInt(candidate.weight);
    if (
      candidateRatio < chosenRatio ||
      (candidateRatio === chosenRatio && candidate.id < chosen.id)
    )
      chosen = candidate;
  }
  return chosen?.id;
}

interface Opening {
  readonly startTime: string;
  readonly endTime: string;
}
function openings(config: CalendarSlotRules, date: Temporal.PlainDate): Opening[] {
  const override = config.dateOverrides.find((item) => item.date === date.toString());
  const ranges =
    override?.ranges ?? config.weeklyHours.filter((item) => item.weekday === date.dayOfWeek % 7);
  const merged: Opening[] = [];
  for (const range of [...ranges].sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    const last = merged.at(-1);
    if (last !== undefined && range.startTime <= last.endTime)
      merged[merged.length - 1] = {
        startTime: last.startTime,
        endTime: range.endTime > last.endTime ? range.endTime : last.endTime,
      };
    else merged.push({ startTime: range.startTime, endTime: range.endTime });
  }
  return merged;
}
/** When a range closes: 24:00 is the first moment of the next local date. */
function closing(date: Temporal.PlainDate, endTime: string): Temporal.PlainDateTime {
  return endTime === '24:00'
    ? date.add({ days: 1 }).toPlainDateTime('00:00')
    : date.toPlainDateTime(endTime);
}
/**
 * What one day's slots ask of the time zone over and over, worked out once. Finding a
 * zone's next offset change is by far the slowest question (it is searched for), and a
 * day's slots all get the same answer.
 */
interface ZoneFacts {
  /** The first offset change after this instant, if the zone has another. */
  nextTransition: (zoned: Temporal.ZonedDateTime) => Temporal.Instant | undefined;
  /** The first instant of the local date after this one. */
  nextMidnight: (date: Temporal.PlainDate) => Temporal.Instant;
  /** The date's merged opening hours. */
  openings: (date: Temporal.PlainDate) => readonly Opening[];
}
function zoneFacts(config: CalendarSlotRules): ZoneFacts {
  // The answer found at `from` holds for every instant from there until the change itself.
  let known: { from: Temporal.Instant; next: Temporal.Instant | undefined } | undefined;
  const midnights = new Map<string, Temporal.Instant>();
  const hours = new Map<string, readonly Opening[]>();
  return {
    nextTransition(zoned) {
      const at = zoned.toInstant();
      if (
        known === undefined ||
        Temporal.Instant.compare(at, known.from) < 0 ||
        (known.next !== undefined && Temporal.Instant.compare(at, known.next) >= 0)
      )
        known = { from: at, next: zoned.getTimeZoneTransition('next')?.toInstant() };
      return known.next;
    },
    nextMidnight(date) {
      const key = date.toString();
      let midnight = midnights.get(key);
      if (midnight === undefined) {
        midnight = date.add({ days: 1 }).toZonedDateTime(config.timezone).toInstant();
        midnights.set(key, midnight);
      }
      return midnight;
    },
    openings(date) {
      const key = date.toString();
      let ranges = hours.get(key);
      if (ranges === undefined) {
        ranges = openings(config, date);
        hours.set(key, ranges);
      }
      return ranges;
    },
  };
}
/**
 * Whether every instant from start to end is inside opening hours. The time is cut where
 * the offset changes and where a local date ends, and each piece must lie in one opening
 * of its own date. So it may run past midnight only when one date's hours end at 24:00
 * and the next date's start at 00:00.
 */
function fitsOpening(
  start: Temporal.Instant,
  end: Temporal.Instant,
  config: CalendarSlotRules,
  facts: ZoneFacts,
): boolean {
  let cursor = start;
  while (Temporal.Instant.compare(cursor, end) < 0) {
    // Endpoints alone miss closed wall-time interiors when an offset changes mid-slot.
    const zoned = cursor.toZonedDateTimeISO(config.timezone);
    const date = zoned.toPlainDate();
    let boundary = end;
    for (const cut of [facts.nextTransition(zoned), facts.nextMidnight(date)])
      if (cut !== undefined && Temporal.Instant.compare(cut, boundary) < 0) boundary = cut;
    const localStart = zoned.toPlainDateTime();
    const localLast = boundary
      .subtract({ nanoseconds: 1 })
      .toZonedDateTimeISO(config.timezone)
      .toPlainDateTime();
    if (
      !facts
        .openings(date)
        .some(
          (range) =>
            Temporal.PlainDateTime.compare(localStart, date.toPlainDateTime(range.startTime)) >=
              0 && Temporal.PlainDateTime.compare(localLast, closing(date, range.endTime)) < 0,
        )
    )
      return false;
    cursor = boundary;
  }
  return true;
}
/** A stable number from 0 to 99 for a slot of a calendar (FNV-1a). */
export function slotBucket(seed: string, startsAt: string): number {
  let hash = 0x811c9dc5;
  for (const character of `${seed}:${startsAt}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

// How far ahead a window that counts only open days is searched: four years of days.
const WINDOW_SEARCH_DAYS = 1461;

/** Whether the date is inside the booking window, counted in days or in open days. */
function insideWindow(
  config: CalendarSlotRules,
  facts: ZoneFacts,
  today: Temporal.PlainDate,
  date: Temporal.PlainDate,
): boolean {
  if (Temporal.PlainDate.compare(date, today) < 0) return false;
  if (config.countAvailableDaysOnly !== true)
    return Temporal.PlainDate.compare(date, today.add({ days: config.maxDaysAhead })) <= 0;
  if (Temporal.PlainDate.compare(date, today.add({ days: WINDOW_SEARCH_DAYS })) > 0) return false;
  // Today is day 0, as it is when every day counts; each later open day uses one of the days.
  let open = 0;
  for (
    let day = today.add({ days: 1 });
    Temporal.PlainDate.compare(day, date) <= 0;
    day = day.add({ days: 1 })
  )
    if (facts.openings(day).length > 0) open += 1;
  return open <= config.maxDaysAhead;
}

const minuteOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
function wallTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/**
 * Validated persisted rules; busy periods already include their own buffer snapshots. The
 * meeting itself must fit the calendar's hours and a member's own schedule, which can only
 * take slots away; its buffers may run outside both (as Calendly does). The buffers still
 * keep their gap from busy time, blocked time included. A member without a schedule follows
 * the calendar.
 */
export function generateCalendarSlots(
  config: CalendarSlotRules,
  localDate: string,
  nowISO: string,
  busy: BusyByMember,
  schedules: ReadonlyMap<string, UserAvailabilityProfile> = new Map(),
): CalendarSlot[] {
  const date = Temporal.PlainDate.from(localDate);
  const now = Temporal.Instant.from(nowISO);
  const today = now.toZonedDateTimeISO(config.timezone).toPlainDate();
  const facts = zoneFacts(config);
  if (!insideWindow(config, facts, today, date)) return [];
  // A date that has taken all it may takes no more, whoever is free.
  if (config.dayLimit !== undefined && config.dayLimit.booked >= config.dayLimit.max) return [];
  const notice = now.add({ minutes: config.minNoticeMinutes });
  const step = config.slotIntervalMinutes ?? config.slotMinutes;
  const lookBusy = config.lookBusy;
  const ranges = facts.openings(date);
  const memberIds = [...new Set(config.members.map((member) => member.id))].sort();
  const occupiedByMember = new Map(
    memberIds.map((id) => [
      id,
      (busy.get(id) ?? []).map((period) => ({
        start: Temporal.Instant.from(period.startsAt).epochNanoseconds,
        end: Temporal.Instant.from(period.endsAt).epochNanoseconds,
      })),
    ]),
  );
  const slots = new Map<string, CalendarSlot>();
  for (const range of ranges)
    for (let minute = minuteOf(range.startTime); minute < minuteOf(range.endTime); minute += step) {
      const wall = date.toPlainDateTime(wallTime(minute));
      for (const disambiguation of ['earlier', 'later'] as const) {
        const zoned = wall.toZonedDateTime(config.timezone, { disambiguation });
        if (!zoned.toPlainDateTime().equals(wall)) continue;
        const start = zoned.toInstant();
        const key = start.toString();
        if (slots.has(key) || Temporal.Instant.compare(start, notice) < 0) continue;
        if (
          config.slotLimit !== undefined &&
          (config.slotLimit.taken.get(key) ?? 0) >= config.slotLimit.max
        )
          continue;
        const end = start.add({ minutes: config.slotMinutes });
        // The meeting must fit the hours; its buffers may reach into closed time.
        if (!fitsOpening(start, end, config, facts)) continue;
        const occupiedStart = start.subtract({ minutes: config.bufferBeforeMinutes });
        const occupiedEnd = end.add({ minutes: config.bufferAfterMinutes });
        const meeting = { startsAt: key, endsAt: end.toString() };
        const occupied = { startsAt: occupiedStart.toString(), endsAt: occupiedEnd.toString() };
        const availableMemberIds = memberIds.filter(
          (id) =>
            !(occupiedByMember.get(id) ?? []).some(
              (period) =>
                occupiedStart.epochNanoseconds < period.end &&
                period.start < occupiedEnd.epochNanoseconds,
            ) && fitsUserAvailability(meeting, schedules.get(id), occupied),
        );
        if (availableMemberIds.length === 0) continue;
        if (lookBusy !== undefined && slotBucket(lookBusy.seed, key) < lookBusy.percent) continue;
        slots.set(key, { startsAt: key, endsAt: end.toString(), availableMemberIds });
      }
    }
  return [...slots.values()].sort((a, b) => Temporal.Instant.compare(a.startsAt, b.startsAt));
}
