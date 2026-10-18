import { Temporal } from '@js-temporal/polyfill';
import { isTimeZone } from '@repo/kernel';

export interface UserMinuteRange {
  readonly startMinute: number;
  readonly endMinute: number;
}
export interface UserAvailabilityProfile {
  readonly timezone: string;
  readonly inheritCalendarHours: boolean;
  readonly weeklyHours: readonly (UserMinuteRange & { readonly weekday: number })[];
  readonly dateOverrides: readonly {
    readonly date: string;
    readonly ranges: readonly UserMinuteRange[];
  }[];
}

function contiguousRanges(ranges: readonly UserMinuteRange[]): UserMinuteRange[] {
  const merged: UserMinuteRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startMinute - b.startMinute)) {
    const last = merged.at(-1);
    if (last !== undefined && range.startMinute <= last.endMinute)
      merged[merged.length - 1] = {
        startMinute: last.startMinute,
        endMinute: Math.max(last.endMinute, range.endMinute),
      };
    else merged.push(range);
  }
  return merged;
}

function validRange(range: UserMinuteRange): boolean {
  return (
    Number.isInteger(range.startMinute) &&
    Number.isInteger(range.endMinute) &&
    range.startMinute >= 0 &&
    range.endMinute <= 1440 &&
    range.endMinute > range.startMinute
  );
}

interface Interval {
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * Filters already calendar-qualified slots; it never generates additional ones. The meeting
 * must lie in the member's hours; the occupied time (the meeting with its buffers, the
 * meeting alone when not given) must be ordered around it. Blocked time is busy time,
 * checked with the member's bookings.
 */
export function fitsUserAvailability(
  meeting: Interval,
  profile: UserAvailabilityProfile | undefined,
  occupied: Interval = meeting,
): boolean {
  try {
    const occupiedStart = Temporal.Instant.from(occupied.startsAt);
    const occupiedEnd = Temporal.Instant.from(occupied.endsAt);
    let cursor = Temporal.Instant.from(meeting.startsAt);
    const end = Temporal.Instant.from(meeting.endsAt);
    if (
      Temporal.Instant.compare(cursor, end) >= 0 ||
      Temporal.Instant.compare(occupiedStart, cursor) > 0 ||
      Temporal.Instant.compare(occupiedEnd, end) < 0
    )
      return false;
    if (profile === undefined) return true;
    if (!isTimeZone(profile.timezone)) return false;
    if (
      !profile.weeklyHours.every(
        (range) =>
          Number.isInteger(range.weekday) &&
          range.weekday >= 0 &&
          range.weekday <= 6 &&
          validRange(range),
      )
    )
      return false;
    for (const override of profile.dateOverrides) {
      const date = Temporal.PlainDate.from(override.date);
      if (date.year < 1 || date.toString() !== override.date || !override.ranges.every(validRange))
        return false;
    }
    while (Temporal.Instant.compare(cursor, end) < 0) {
      const start = cursor.toZonedDateTimeISO(profile.timezone);
      const day = start.toPlainDate();
      const midnight = day.add({ days: 1 }).toZonedDateTime(profile.timezone).toInstant();
      let boundary = Temporal.Instant.compare(midnight, end) < 0 ? midnight : end;
      const transition = start.getTimeZoneTransition('next')?.toInstant();
      if (transition !== undefined && Temporal.Instant.compare(transition, boundary) < 0)
        boundary = transition;
      const override = profile.dateOverrides.find((item) => item.date === day.toString());
      if (override !== undefined || !profile.inheritCalendarHours) {
        const ranges = contiguousRanges(
          override?.ranges ??
            profile.weeklyHours.filter((item) => item.weekday === day.dayOfWeek % 7),
        );
        const localLast = boundary
          .subtract({ nanoseconds: 1 })
          .toZonedDateTimeISO(profile.timezone)
          .toPlainDateTime();
        if (
          !ranges.some(
            (range) =>
              Temporal.PlainDateTime.compare(
                start.toPlainDateTime(),
                day.toPlainDateTime().add({ minutes: range.startMinute }),
              ) >= 0 &&
              Temporal.PlainDateTime.compare(
                localLast,
                day.toPlainDateTime().add({ minutes: range.endMinute }),
              ) < 0,
          )
        )
          return false;
      }
      cursor = boundary;
    }
    return true;
  } catch {
    return false;
  }
}
