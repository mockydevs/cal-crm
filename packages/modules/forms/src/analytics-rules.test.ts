import { FORM_LIMITS, formAnalytics } from '@repo/contracts';
import { expect, it } from 'vitest';

import { analyticsRange, fillSeconds, formNumbers } from './analytics-rules.js';

const today = '2026-10-12';

it('counts the days that were named, the last being today and the first 29 days before it', () => {
  expect(analyticsRange({}, today)).toEqual({ ok: true, from: '2026-09-13', to: today });
  expect(analyticsRange({ to: '2026-03-01' }, today)).toEqual({
    ok: true,
    from: '2026-01-31',
    to: '2026-03-01',
  });
  expect(analyticsRange({ from: '2026-10-01' }, today)).toEqual({
    ok: true,
    from: '2026-10-01',
    to: today,
  });
  expect(analyticsRange({ from: today, to: today }, '2030-01-01')).toEqual({
    ok: true,
    from: today,
    to: today,
  });
});

it('refuses a range that starts after it ends, or is longer than is read at once', () => {
  const refusal = (query: { from?: string; to?: string }) => {
    const range = analyticsRange(query, today);
    return range.ok ? undefined : `${range.issue.path} ${range.issue.code}`;
  };
  // A first day after today, with the last left to be today.
  expect(refusal({ from: '2026-10-13' })).toBe('/from range_order');
  expect(refusal({ from: '2026-10-12', to: '2026-10-11' })).toBe('/from range_order');
  expect(refusal({ from: '2025-10-12' })).toBe(undefined);
  expect(refusal({ from: '2025-10-11' })).toBe('/from range_too_long');
  const range = analyticsRange({ from: '2025-10-12' }, today);
  // 366 days, both ends counted.
  expect(range).toEqual({ ok: true, from: '2025-10-12', to: today });
  expect(FORM_LIMITS.analyticsDays).toBe(366);
});

it('gives each day a row, in order, with zeros on a quiet day, and totals over all of them', () => {
  const numbers = formNumbers(
    { from: '2026-10-09', to: '2026-10-12', timeZone: 'Africa/Nairobi' },
    [
      { day: '2026-10-09', views: 10, timedSubmissions: 2, fillSeconds: 90 },
      { day: '2026-10-11', views: 4, timedSubmissions: 1, fillSeconds: 31 },
      // Outside the range: not counted, whatever was read.
      { day: '2026-10-13', views: 99, timedSubmissions: 9, fillSeconds: 900 },
    ],
    new Map([
      ['2026-10-09', 2],
      ['2026-10-10', 1],
      ['2026-10-11', 1],
    ]),
  );
  // The contract is strict: numbers that held anything else would not parse.
  expect(formAnalytics.parse(numbers)).toEqual(numbers);
  expect(numbers).toEqual({
    from: '2026-10-09',
    to: '2026-10-12',
    timeZone: 'Africa/Nairobi',
    totals: { views: 14, responses: 4, completionRate: 0.2857, averageSeconds: 40.3 },
    days: [
      { date: '2026-10-09', views: 10, responses: 2, completionRate: 0.2, averageSeconds: 45 },
      // Sent on a day the form was not shown: nothing to compare with, and not timed here.
      { date: '2026-10-10', views: 0, responses: 1, completionRate: null, averageSeconds: null },
      { date: '2026-10-11', views: 4, responses: 1, completionRate: 0.25, averageSeconds: 31 },
      { date: '2026-10-12', views: 0, responses: 0, completionRate: null, averageSeconds: null },
    ],
  });
});

it('never says more were sent than were shown, and says nothing where nothing was shown', () => {
  const one = (views: number, responses: number) =>
    formNumbers(
      { from: today, to: today, timeZone: 'UTC' },
      views === 0 ? [] : [{ day: today, views, timedSubmissions: 0, fillSeconds: 0 }],
      new Map([[today, responses]]),
    ).totals;
  expect(one(0, 0)).toEqual({
    views: 0,
    responses: 0,
    completionRate: null,
    averageSeconds: null,
  });
  expect(one(0, 3).completionRate).toBeNull();
  expect(one(2, 3).completionRate).toBe(1);
  expect(one(3, 1).completionRate).toBe(0.3333);
  expect(one(5, 0).completionRate).toBe(0);
  // Across the end of a year and a leap day, every day is there once.
  const long = formNumbers(
    { from: '2027-12-30', to: '2028-03-01', timeZone: 'UTC' },
    [],
    new Map(),
  );
  expect(long.days).toHaveLength(63);
  expect(long.days.map((day) => day.date).slice(0, 4)).toEqual([
    '2027-12-30',
    '2027-12-31',
    '2028-01-01',
    '2028-01-02',
  ]);
  expect(long.days.at(-2)?.date).toBe('2028-02-29');
});

it('times a submission from the moment its form was shown, in whole seconds within a day', () => {
  const shown = Date.parse('2026-10-12T10:00:00.000Z');
  expect(fillSeconds(shown, shown + 2000)).toBe(2);
  expect(fillSeconds(shown, shown + 41_499)).toBe(41);
  expect(fillSeconds(shown, shown + 41_500)).toBe(42);
  // Another instance's clock may run a little ahead of this one's: never negative.
  expect(fillSeconds(shown, shown - 20_000)).toBe(0);
  expect(fillSeconds(shown, shown + 48 * 3_600_000)).toBe(FORM_LIMITS.renderHours * 3600);
});
