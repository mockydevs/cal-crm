import { expect, it } from 'vitest';
import { fitsUserAvailability, type UserAvailabilityProfile } from './user-availability.js';

const occupied = (startsAt: string, endsAt: string) => ({ startsAt, endsAt });
const profile = (changes: Partial<UserAvailabilityProfile> = {}): UserAvailabilityProfile => ({
  timezone: 'UTC',
  inheritCalendarHours: false,
  weeklyHours: [{ weekday: 4, startMinute: 540, endMinute: 600 }],
  dateOverrides: [],
  ...changes,
});

it('requires the full calendar-qualified occupied interval to fit weekly user hours', () => {
  expect(fitsUserAvailability(occupied('2026-10-01T09:00Z', '2026-10-01T10:00Z'), profile())).toBe(
    true,
  );
  expect(fitsUserAvailability(occupied('2026-10-01T08:59Z', '2026-10-01T09:30Z'), profile())).toBe(
    false,
  );
  expect(fitsUserAvailability(occupied('2026-10-01T09:30Z', '2026-10-01T10:01Z'), profile())).toBe(
    false,
  );
  expect(fitsUserAvailability(occupied('2026-10-02T09:00Z', '2026-10-02T09:30Z'), profile())).toBe(
    false,
  );
});

it('bounds the meeting by the hours, not its buffers', () => {
  const meeting = occupied('2026-10-01T09:00Z', '2026-10-01T10:00Z');
  const buffered = occupied('2026-10-01T08:45Z', '2026-10-01T10:15Z');
  // The buffers run outside 09:00 to 10:00 and the meeting still fits. Blocked time is busy
  // time, which slots.test.ts checks the buffers against.
  expect(fitsUserAvailability(meeting, profile(), buffered)).toBe(true);
  // Occupied time that does not contain the meeting is malformed and refused.
  expect(
    fitsUserAvailability(meeting, profile(), occupied('2026-10-01T09:15Z', '2026-10-01T10:15Z')),
  ).toBe(false);
  expect(
    fitsUserAvailability(meeting, profile(), occupied('2026-10-01T08:45Z', '2026-10-01T09:45Z')),
  ).toBe(false);
});

it('inherits when unset or explicitly enabled, while an independent empty profile closes', () => {
  const slot = occupied('2026-10-01T09:00Z', '2026-10-01T10:00Z');
  expect(fitsUserAvailability(slot, undefined)).toBe(true);
  expect(fitsUserAvailability(slot, profile({ weeklyHours: [] }))).toBe(false);
  expect(fitsUserAvailability(slot, profile({ inheritCalendarHours: true, weeklyHours: [] }))).toBe(
    true,
  );
});

it('uses date overrides instead of weekly hours, including on inherited calendars', () => {
  const slot = occupied('2026-10-01T09:00Z', '2026-10-01T10:00Z');
  expect(
    fitsUserAvailability(
      slot,
      profile({
        weeklyHours: [],
        dateOverrides: [{ date: '2026-10-01', ranges: [{ startMinute: 540, endMinute: 600 }] }],
      }),
    ),
  ).toBe(true);
  for (const inheritCalendarHours of [false, true])
    expect(
      fitsUserAvailability(
        slot,
        profile({ inheritCalendarHours, dateOverrides: [{ date: '2026-10-01', ranges: [] }] }),
      ),
    ).toBe(false);
});

it('checks each user date across midnight and treats minute1440 as next-day midnight', () => {
  const slot = occupied('2026-10-01T03:45Z', '2026-10-01T04:15Z');
  const rules = profile({
    timezone: 'America/New_York',
    weeklyHours: [],
    dateOverrides: [
      { date: '2026-09-30', ranges: [{ startMinute: 1410, endMinute: 1440 }] },
      { date: '2026-10-01', ranges: [{ startMinute: 0, endMinute: 30 }] },
    ],
  });
  expect(fitsUserAvailability(slot, rules)).toBe(true);
  expect(
    fitsUserAvailability(slot, {
      ...rules,
      dateOverrides: [
        { date: '2026-09-30', ranges: [{ startMinute: 1410, endMinute: 1440 }] },
        { date: '2026-10-01', ranges: [] },
      ],
    }),
  ).toBe(false);
  expect(fitsUserAvailability(occupied('2026-10-01T03:29Z', '2026-10-01T04:15Z'), rules)).toBe(
    false,
  );
});

it.each([
  {
    timezone: 'America/New_York',
    date: '2026-11-01',
    startsAt: '2026-11-01T05:10Z',
    endsAt: '2026-11-01T06:20Z',
    ranges: [{ startMinute: 60, endMinute: 90 }],
    fits: false,
  },
  {
    timezone: 'America/New_York',
    date: '2026-03-08',
    startsAt: '2026-03-08T06:45Z',
    endsAt: '2026-03-08T07:15Z',
    ranges: [
      { startMinute: 90, endMinute: 120 },
      { startMinute: 180, endMinute: 210 },
    ],
    fits: true,
  },
  {
    timezone: 'Australia/Lord_Howe',
    date: '2026-04-05',
    startsAt: '2026-04-04T14:45Z',
    endsAt: '2026-04-04T15:15Z',
    ranges: [{ startMinute: 100, endMinute: 110 }],
    fits: false,
  },
])(
  'checks continuous occupied interiors across $timezone transition on $date',
  ({ timezone, date, startsAt, endsAt, ranges, fits }) => {
    expect(
      fitsUserAvailability(
        occupied(startsAt, endsAt),
        profile({ timezone, dateOverrides: [{ date, ranges }] }),
      ),
    ).toBe(fits);
  },
);

it.each([
  occupied('not-an-instant', '2026-10-01T10:00Z'),
  occupied('2026-10-01T09:00Z', 'not-an-instant'),
  occupied('2026-10-01T09:00Z', '2026-10-01T09:00Z'),
  occupied('2026-10-01T10:00Z', '2026-10-01T09:00Z'),
])('fails closed for invalid occupancy %j even without a user profile', (slot) => {
  expect(fitsUserAvailability(slot, undefined)).toBe(false);
  expect(fitsUserAvailability(slot, profile())).toBe(false);
});

it.each([
  profile({ timezone: 'Not/A_Zone' }),
  profile({ timezone: '+03:00', inheritCalendarHours: true }),
])('fails closed for an invalid timezone %j', (rules) => {
  expect(fitsUserAvailability(occupied('2026-10-01T09:00Z', '2026-10-01T10:00Z'), rules)).toBe(
    false,
  );
});

it('joins adjacent user hours without mutating their configured order', () => {
  const ranges = [
    { weekday: 4, startMinute: 570, endMinute: 600 },
    { weekday: 4, startMinute: 540, endMinute: 570 },
  ];
  const rules = profile({ weeklyHours: ranges });
  expect(fitsUserAvailability(occupied('2026-10-01T09:00Z', '2026-10-01T10:00Z'), rules)).toBe(
    true,
  );
  expect(ranges.map((range) => range.startMinute)).toEqual([570, 540]);
});

it.each([
  { weekday: 4, startMinute: -1, endMinute: 600 },
  { weekday: 4, startMinute: 540, endMinute: 1441 },
  { weekday: 4, startMinute: 540.5, endMinute: 600 },
  { weekday: 7, startMinute: 540, endMinute: 600 },
])('refuses malformed user minute ranges even in inheritance mode %j', (range) => {
  expect(
    fitsUserAvailability(
      occupied('2026-10-01T09:00Z', '2026-10-01T10:00Z'),
      profile({
        inheritCalendarHours: true,
        weeklyHours: [range],
      }),
    ),
  ).toBe(false);
});

it('refuses invalid date or minute values in override input', () => {
  const slot = occupied('2026-10-01T09:00Z', '2026-10-01T10:00Z');
  expect(
    fitsUserAvailability(slot, profile({ dateOverrides: [{ date: 'not-a-date', ranges: [] }] })),
  ).toBe(false);
  expect(
    fitsUserAvailability(
      slot,
      profile({
        dateOverrides: [{ date: '2026-10-01', ranges: [{ startMinute: 540, endMinute: 1441 }] }],
      }),
    ),
  ).toBe(false);
});

it.each([
  ['2026-03-08', '2026-03-08T05:00Z', '2026-03-09T04:00Z'],
  ['2026-11-01', '2026-11-01T04:00Z', '2026-11-02T05:00Z'],
])('accepts the whole physical DST day %s for a full-day user opening', (date, start, end) => {
  const rules = profile({
    timezone: 'America/New_York',
    weeklyHours: [],
    dateOverrides: [{ date, ranges: [{ startMinute: 0, endMinute: 1440 }] }],
  });
  expect(fitsUserAvailability(occupied(start, end), rules)).toBe(true);
  expect(
    fitsUserAvailability(occupied(start, end), {
      ...rules,
      dateOverrides: [{ date, ranges: [{ startMinute: 1, endMinute: 1440 }] }],
    }),
  ).toBe(false);
});
