import { reportPresets, type ReportPreset } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { addDays, bucketsOf, compareDays, daysIn, resolveDays } from './range.js';

describe('a preset, from today in the business’s time zone', () => {
  // Monday 12 October 2026.
  const today = '2026-10-12';
  it.each<[ReportPreset, string, string]>([
    ['today', '2026-10-12', '2026-10-12'],
    ['yesterday', '2026-10-11', '2026-10-11'],
    ['last_7_days', '2026-10-06', '2026-10-12'],
    ['last_30_days', '2026-09-13', '2026-10-12'],
    ['last_90_days', '2026-07-15', '2026-10-12'],
    ['this_week', '2026-10-12', '2026-10-18'],
    ['last_week', '2026-10-05', '2026-10-11'],
    ['this_month', '2026-10-01', '2026-10-31'],
    ['last_month', '2026-09-01', '2026-09-30'],
    ['this_quarter', '2026-10-01', '2026-12-31'],
    ['last_quarter', '2026-07-01', '2026-09-30'],
    ['this_year', '2026-01-01', '2026-12-31'],
    ['last_year', '2025-01-01', '2025-12-31'],
    ['last_12_months', '2025-11-01', '2026-10-12'],
  ])('%s', (preset, from, to) => {
    expect(resolveDays({ preset }, today)).toEqual({ from, to });
  });

  it('is covered for every preset the contract lists', () => {
    for (const preset of reportPresets) {
      const range = resolveDays({ preset }, today);
      expect(daysIn(range), preset).toBeGreaterThanOrEqual(1);
    }
  });

  it('starts a week on Monday whatever day it is, a Sunday included', () => {
    expect(resolveDays({ preset: 'this_week' }, '2026-10-18')).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    expect(resolveDays({ preset: 'last_week' }, '2026-10-14')).toEqual({
      from: '2026-10-05',
      to: '2026-10-11',
    });
  });

  it('crosses a year for months, quarters and leap days', () => {
    expect(resolveDays({ preset: 'last_month' }, '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(resolveDays({ preset: 'last_quarter' }, '2026-02-10')).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
    expect(resolveDays({ preset: 'this_month' }, '2028-02-10')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(resolveDays({ preset: 'this_quarter' }, '2026-05-31')).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
  });
});

it('takes two days as they are', () => {
  expect(resolveDays({ from: '2026-03-01', to: '2026-03-07' }, '2026-10-12')).toEqual({
    from: '2026-03-01',
    to: '2026-03-07',
  });
  expect(daysIn({ from: '2026-03-01', to: '2026-03-07' })).toBe(7);
  expect(daysIn({ from: '2026-03-01', to: '2026-03-01' })).toBe(1);
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
});

describe('a comparison', () => {
  it('is the same number of days ending the day before', () => {
    expect(compareDays({ from: '2026-09-01', to: '2026-09-30' }, 'previous_period')).toEqual({
      from: '2026-08-02',
      to: '2026-08-31',
    });
    expect(compareDays({ from: '2026-10-12', to: '2026-10-12' }, 'previous_period')).toEqual({
      from: '2026-10-11',
      to: '2026-10-11',
    });
  });

  it('is the same days a year earlier, and the 28th for a leap day', () => {
    expect(compareDays({ from: '2026-09-01', to: '2026-09-30' }, 'previous_year')).toEqual({
      from: '2025-09-01',
      to: '2025-09-30',
    });
    expect(compareDays({ from: '2028-02-01', to: '2028-02-29' }, 'previous_year')).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
    });
  });
});

describe('buckets', () => {
  it('are every day', () => {
    expect(bucketsOf({ from: '2026-02-27', to: '2026-03-02' }, 'day')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });

  it('are weeks by their Monday, the first and last in part', () => {
    // Wednesday 2 September to Tuesday 15 September.
    expect(bucketsOf({ from: '2026-09-02', to: '2026-09-15' }, 'week')).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
    ]);
  });

  it('are months by their first day', () => {
    expect(bucketsOf({ from: '2025-11-15', to: '2026-02-01' }, 'month')).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ]);
  });
});
