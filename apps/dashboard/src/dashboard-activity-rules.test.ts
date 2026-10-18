import { expect, it } from 'vitest';
import { dayBars, reasonKey, topRows } from './dashboard-activity-rules';

it('draws the tallest day full, an empty day as a sliver, and nothing when every day is empty', () => {
  expect(dayBars([0, 5, 10, 1])).toEqual([1, 20, 40, 4]);
  // A day with one email among hundreds still shows.
  expect(dayBars([400, 1])).toEqual([40, 2]);
  expect(dayBars([0, 0, 0])).toEqual([]);
  expect(dayBars([])).toEqual([]);
});

it('keeps the first rows and adds the rest up under one name', () => {
  const rows = [
    { name: 'A', count: 5 },
    { name: 'B', count: 4 },
    { name: 'C', count: 3 },
    { name: 'D', count: 2 },
  ];
  expect(topRows(rows, 4, 'Other')).toEqual(rows);
  expect(topRows(rows, 3, 'Other')).toEqual([
    { name: 'A', count: 5 },
    { name: 'B', count: 4 },
    { name: 'Other', count: 5 },
  ]);
  expect(topRows([], 3, 'Other')).toEqual([]);
});

it('makes a reason without words of its own readable', () => {
  expect(reasonKey('delivery_rejected')).toBe('delivery rejected');
  expect(reasonKey('smtp.timeout')).toBe('smtp timeout');
});
