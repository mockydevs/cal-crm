// The booking rules of the "New calendar" editor, in the slot generator: how often a slot
// starts, a day's limit, the window counted in open days, and slots held back so a calendar
// looks busy.
import { expect, it } from 'vitest';

import { generateCalendarSlots, slotBucket, type CalendarSlotRules } from './slots.js';

const NOW = '2026-10-19T00:00:00Z';
const host = new Map([['host', []]]);
// Monday to Friday, 09:00 to 12:00, UTC.
const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startTime: '09:00',
  endTime: '12:00',
}));
const rules = (changed: Partial<CalendarSlotRules> = {}): CalendarSlotRules => ({
  timezone: 'UTC',
  slotMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 60,
  weeklyHours: weekdays,
  dateOverrides: [],
  members: [{ id: 'host', weight: 1 }],
  ...changed,
});
const starts = (config: CalendarSlotRules, date: string) =>
  generateCalendarSlots(config, date, NOW, host).map((slot) => slot.startsAt.slice(11, 16));

it('starts a slot every duration unless an interval says how often', () => {
  // Monday 19 October 2026.
  expect(starts(rules(), '2026-10-19')).toEqual(['09:00', '10:00', '11:00']);
  expect(starts(rules({ slotIntervalMinutes: null }), '2026-10-19')).toEqual([
    '09:00',
    '10:00',
    '11:00',
  ]);
  // An hour's meeting offered every half hour: the last that still ends by noon is 11:00.
  expect(starts(rules({ slotIntervalMinutes: 30 }), '2026-10-19')).toEqual([
    '09:00',
    '09:30',
    '10:00',
    '10:30',
    '11:00',
  ]);
  // A half-hour meeting offered on the hour only.
  expect(starts(rules({ slotMinutes: 30, slotIntervalMinutes: 60 }), '2026-10-19')).toEqual([
    '09:00',
    '10:00',
    '11:00',
  ]);
});

it('offers nothing on a date that has taken all it may', () => {
  expect(starts(rules({ dayLimit: { max: 2, booked: 1 } }), '2026-10-19')).toHaveLength(3);
  expect(starts(rules({ dayLimit: { max: 2, booked: 2 } }), '2026-10-19')).toEqual([]);
  expect(starts(rules({ dayLimit: { max: 2, booked: 5 } }), '2026-10-19')).toEqual([]);
});

it('counts the booking window in days, or in days the calendar is open', () => {
  // From Monday the 19th, five days ahead is Saturday the 24th: Monday the 26th is outside.
  const fiveDays = rules({ maxDaysAhead: 5 });
  expect(starts(fiveDays, '2026-10-23')).toHaveLength(3);
  expect(starts(fiveDays, '2026-10-26')).toEqual([]);
  // Counting open days only, the weekend uses none: the fifth open day after today is
  // Monday the 26th, and Tuesday the 27th is the sixth.
  const fiveOpenDays = rules({ maxDaysAhead: 5, countAvailableDaysOnly: true });
  expect(starts(fiveOpenDays, '2026-10-26')).toHaveLength(3);
  expect(starts(fiveOpenDays, '2026-10-27')).toEqual([]);
  // A day closed by an override is not counted either.
  const closedFriday = rules({
    maxDaysAhead: 5,
    countAvailableDaysOnly: true,
    dateOverrides: [{ date: '2026-10-23', ranges: [] }],
  });
  expect(starts(closedFriday, '2026-10-27')).toHaveLength(3);
  expect(starts(closedFriday, '2026-10-28')).toEqual([]);
  expect(starts(fiveOpenDays, '2026-10-18')).toEqual([]);
});

it('holds back the same share of slots every time it is asked', () => {
  const quarterHours = rules({
    slotMinutes: 15,
    weeklyHours: [{ weekday: 1, startTime: '00:00', endTime: '24:00' }],
  });
  const all = starts(quarterHours, '2026-10-19');
  expect(all).toHaveLength(96);
  const busy = (percent: number, seed = 'cal-1') =>
    starts({ ...quarterHours, lookBusy: { percent, seed } }, '2026-10-19');
  expect(busy(0)).toEqual(all);
  expect(busy(100)).toEqual([]);
  const half = busy(50);
  expect(half).toEqual(busy(50));
  // Roughly half of 96, and exactly the slots whose number falls at or above the share.
  expect(half.length).toBeGreaterThan(30);
  expect(half.length).toBeLessThan(66);
  expect(half).toEqual(all.filter((time) => slotBucket('cal-1', `2026-10-19T${time}:00Z`) >= 50));
  // A slot held back at a lower share stays held back at a higher one.
  expect(busy(25).filter((time) => !half.includes(time)).length).toBeGreaterThan(0);
  expect(half.every((time) => busy(25).includes(time))).toBe(true);
  // Another calendar holds back other slots.
  expect(busy(50, 'cal-2')).not.toEqual(half);
});

it('gives a slot a number from 0 to 99 that depends on the calendar and the moment', () => {
  const numbers = Array.from({ length: 200 }, (_, index) =>
    slotBucket('cal-1', `2026-10-19T${String(index).padStart(4, '0')}`),
  );
  expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...numbers)).toBeLessThanOrEqual(99);
  expect(new Set(numbers).size).toBeGreaterThan(50);
  expect(slotBucket('cal-1', 'a')).toBe(slotBucket('cal-1', 'a'));
});
