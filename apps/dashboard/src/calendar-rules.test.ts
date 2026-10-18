import { describe, expect, it } from 'vitest';
import {
  dayAt,
  dayKey,
  daysOf,
  instantAt,
  onDay,
  placedOn,
  sameDay,
  stepped,
  todayIn,
  wallClock,
  windowOf,
} from './calendar-rules';

// The calendar is drawn in the business's zone, so the tests name theirs and read the same
// whatever zone the suite runs in. October 2026 in New York is UTC-4.
const NEW_YORK = 'America/New_York';
const day = (date: number, month = 10, year = 2026): Date =>
  new Date(Date.UTC(year, month - 1, date));
/** An instant by New York's clock in October 2026. */
const at = (date: number, hour = 0, minute = 0, second = 0): Date =>
  new Date(Date.UTC(2026, 9, date, hour + 4, minute, second));
const event = (
  name: string,
  from: Date,
  to: Date,
): { name: string; startsAt: string; endsAt: string } => ({
  name,
  startsAt: from.toISOString(),
  endsAt: to.toISOString(),
});

describe('days', () => {
  it('names a day by its date, and knows which day it is in a zone', () => {
    expect(dayKey(day(11))).toBe('2026-10-11');
    expect(dayKey(day(5, 1))).toBe('2026-01-05');
    expect(sameDay(day(11), dayAt(day(10), 1))).toBe(true);
    // Half past midnight in UTC is still the evening before in New York, and the next
    // morning in Nairobi.
    const instant = new Date('2026-10-12T00:30:00Z');
    expect(dayKey(todayIn(NEW_YORK, instant))).toBe('2026-10-11');
    expect(dayKey(todayIn('Africa/Nairobi', instant))).toBe('2026-10-12');
    expect(wallClock(instant.getTime(), NEW_YORK)).toMatchObject({ minutes: 20 * 60 + 30 });
  });

  it('turns a clock time of a day in a zone into its instant, across the clock changes', () => {
    expect(new Date(instantAt(day(11), 9 * 60, NEW_YORK)).toISOString()).toBe(
      '2026-10-11T13:00:00.000Z',
    );
    expect(new Date(instantAt(day(11), 9 * 60, 'Africa/Nairobi')).toISOString()).toBe(
      '2026-10-11T06:00:00.000Z',
    );
    // 1 November 2026: New York goes back an hour at 02:00, so 01:30 happens twice; the
    // first is meant.
    expect(new Date(instantAt(day(1, 11), 90, NEW_YORK)).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    // 8 March 2026: it goes forward at 02:00, so 02:30 never shows; it is read as 03:30.
    expect(new Date(instantAt(day(8, 3), 150, NEW_YORK)).toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('moves by whole days across a month end', () => {
    expect(dayKey(dayAt(day(31), 1))).toBe('2026-11-01');
    expect(dayKey(dayAt(day(1), -1))).toBe('2026-09-30');
  });

  it('shows one day, the week from Sunday, or six weeks around a month', () => {
    // 11 October 2026 is a Sunday; the 14th a Wednesday.
    expect(daysOf('day', day(14)).map(dayKey)).toEqual(['2026-10-14']);
    expect(daysOf('week', day(14)).map(dayKey)).toEqual([
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
    ]);
    expect(daysOf('week', day(11)).map(dayKey)[0]).toBe('2026-10-11');
    const month = daysOf('month', day(14)).map(dayKey);
    expect(month).toHaveLength(42);
    // 1 October 2026 is a Thursday: the grid starts on the Sunday before it.
    expect(month[0]).toBe('2026-09-27');
    expect(month.at(-1)).toBe('2026-11-07');
  });

  it("reads from the zone's first midnight to its midnight after the last day", () => {
    const { from, to } = windowOf(daysOf('week', day(14)), NEW_YORK);
    expect(from.toISOString()).toBe('2026-10-11T04:00:00.000Z');
    expect(to.toISOString()).toBe('2026-10-18T04:00:00.000Z');
    // The month window crosses New York's change back to UTC-5.
    const month = windowOf(daysOf('month', day(14)), NEW_YORK);
    expect(month.to.toISOString()).toBe('2026-11-08T05:00:00.000Z');
    expect((month.to.getTime() - month.from.getTime()) / 86_400_000).toBeLessThanOrEqual(62);
  });

  it('steps a day, a week or a month, landing on the first of the month', () => {
    expect(dayKey(stepped('day', day(31), 1))).toBe('2026-11-01');
    expect(dayKey(stepped('week', day(14), -1))).toBe('2026-10-07');
    expect(dayKey(stepped('month', day(31), 1))).toBe('2026-11-01');
    expect(dayKey(stepped('month', day(31), -1))).toBe('2026-09-01');
    expect(dayKey(stepped('month', day(15, 1), -1))).toBe('2025-12-01');
  });
});

describe('events in a day', () => {
  it("knows which of the zone's days an event touches", () => {
    const overnight = event('Overnight', at(11, 22), at(12, 2));
    expect(onDay(overnight, day(11), NEW_YORK)).toBe(true);
    expect(onDay(overnight, day(12), NEW_YORK)).toBe(true);
    expect(onDay(overnight, day(13), NEW_YORK)).toBe(false);
    // Ending at midnight is not the next day.
    expect(onDay(event('Late', at(11, 23), at(12)), day(12), NEW_YORK)).toBe(false);
    // The same evening in Nairobi is the next morning there.
    expect(onDay(event('Late', at(11, 23), at(12)), day(12), 'Africa/Nairobi')).toBe(true);
  });

  it("places an event by the zone's clock and gives a short one room to be read", () => {
    const [long, short] = placedOn(
      day(11),
      [event('Tour', at(11, 9), at(11, 10, 30)), event('Call', at(11, 13), at(11, 13, 5))],
      NEW_YORK,
    );
    expect(long).toMatchObject({ top: 540, height: 90, column: 0, columns: 1 });
    expect(short).toMatchObject({ top: 780, height: 30, column: 0, columns: 1 });
    // Nine in New York is four in the afternoon in Nairobi.
    expect(
      placedOn(day(11), [event('Tour', at(11, 9), at(11, 10))], 'Africa/Nairobi')[0],
    ).toMatchObject({ top: 960, height: 60 });
  });

  it('cuts an event to the day it is drawn in', () => {
    const overnight = event('Overnight', at(11, 22), at(12, 2));
    expect(placedOn(day(11), [overnight], NEW_YORK)[0]).toMatchObject({ top: 1320, height: 120 });
    expect(placedOn(day(12), [overnight], NEW_YORK)[0]).toMatchObject({ top: 0, height: 120 });
    expect(placedOn(day(13), [overnight], NEW_YORK)).toEqual([]);
    // One that starts in the last minutes of a day still fits inside it.
    expect(placedOn(day(11), [event('Late', at(11, 23, 50), at(12))], NEW_YORK)[0]).toMatchObject({
      top: 1410,
      height: 30,
    });
    // An end inside a minute takes the whole minute.
    expect(
      placedOn(day(11), [event('Odd', at(11, 9), at(11, 10, 0, 30))], NEW_YORK)[0],
    ).toMatchObject({ top: 540, height: 61 });
  });

  it('puts overlapping events side by side and reuses a lane once it is free', () => {
    const placed = placedOn(
      day(11),
      [
        event('A', at(11, 9), at(11, 11)),
        event('B', at(11, 9, 30), at(11, 10)),
        event('C', at(11, 10), at(11, 11)),
        event('D', at(11, 14), at(11, 15)),
      ],
      NEW_YORK,
    );
    const lane = (name: string): [number, number] => {
      const found = placed.find((each) => each.event.name === name);
      return [found?.column ?? -1, found?.columns ?? -1];
    };
    expect(lane('A')).toEqual([0, 2]);
    expect(lane('B')).toEqual([1, 2]);
    expect(lane('C')).toEqual([1, 2]);
    expect(lane('D')).toEqual([0, 1]);
  });
});
