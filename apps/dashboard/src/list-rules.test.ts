import { describe, expect, it } from 'vitest';
import {
  filterCount,
  moveColumn,
  nameFirst,
  pageOf,
  sameColumns,
  tableColumnsOf,
  timeSince,
} from './list-rules';

describe('nameFirst', () => {
  it('puts the name column first and keeps the others in their order', () => {
    expect(nameFirst(['phone', 'name', 'email'])).toEqual(['name', 'phone', 'email']);
    expect(nameFirst(['name', 'email'])).toEqual(['name', 'email']);
  });

  it('adds the name column when a list of columns has lost it', () => {
    expect(nameFirst(['email'])).toEqual(['name', 'email']);
  });
});

describe('moveColumn', () => {
  it('moves a column one place up or down', () => {
    expect(moveColumn(['name', 'email', 'phone'], 'phone', -1)).toEqual(['name', 'phone', 'email']);
    expect(moveColumn(['name', 'email', 'phone'], 'email', 1)).toEqual(['name', 'phone', 'email']);
  });

  it('keeps the name column first and stops at either end', () => {
    expect(moveColumn(['name', 'email', 'phone'], 'email', -1)).toEqual(['name', 'email', 'phone']);
    expect(moveColumn(['name', 'email', 'phone'], 'name', 1)).toEqual(['name', 'email', 'phone']);
    expect(moveColumn(['name', 'email', 'phone'], 'phone', 1)).toEqual(['name', 'email', 'phone']);
  });
});

describe('sameColumns', () => {
  it('compares the columns in order', () => {
    expect(sameColumns(['name', 'email'], ['name', 'email'])).toBe(true);
    expect(sameColumns(['name', 'email'], ['name', 'phone'])).toBe(false);
    expect(sameColumns(['name', 'email'], ['name'])).toBe(false);
  });
});

describe('filterCount', () => {
  it('counts each filter that narrows the list', () => {
    expect(filterCount({})).toBe(0);
    expect(filterCount({ added: 'week' })).toBe(1);
    expect(filterCount({ added: 'week', fieldId: 'fld_1', fieldOperator: 'is_set' })).toBe(2);
  });

  it('does not count the order', () => {
    expect(filterCount({ sortField: 'fld_1', fieldOrder: 'asc' })).toBe(0);
  });
});

describe('pageOf', () => {
  it('says which page shows and how many there are once the last one has loaded', () => {
    expect(pageOf({ index: 0, loaded: 1, more: false })).toEqual({
      number: 1,
      total: 1,
      previous: false,
      next: false,
    });
    expect(pageOf({ index: 1, loaded: 3, more: false })).toEqual({
      number: 2,
      total: 3,
      previous: true,
      next: true,
    });
  });

  it('leaves the number of pages unknown while the server has more', () => {
    expect(pageOf({ index: 1, loaded: 2, more: true })).toEqual({
      number: 2,
      total: undefined,
      previous: true,
      next: true,
    });
  });

  it('shows the last loaded page when the list got shorter', () => {
    expect(pageOf({ index: 4, loaded: 2, more: false }).number).toBe(2);
    expect(pageOf({ index: 3, loaded: 0, more: false }).number).toBe(1);
  });
});

describe('pageOf with the count the server gives', () => {
  it('says how many pages there are before the last one has loaded', () => {
    expect(pageOf({ index: 0, loaded: 1, more: true, count: 120, pageSize: 50 })).toEqual({
      number: 1,
      total: 3,
      previous: false,
      next: true,
    });
    expect(pageOf({ index: 0, loaded: 1, more: true, count: 100, pageSize: 50 }).total).toBe(2);
  });

  it('never says fewer pages than have loaded, when contacts were added meanwhile', () => {
    expect(pageOf({ index: 2, loaded: 3, more: true, count: 100, pageSize: 50 }).total).toBe(
      undefined,
    );
    expect(pageOf({ index: 2, loaded: 3, more: false, count: 100, pageSize: 50 }).total).toBe(3);
  });

  it('shows one page for an empty list', () => {
    expect(pageOf({ index: 0, loaded: 1, more: false, count: 0, pageSize: 50 }).total).toBe(1);
  });
});

describe('tableColumnsOf', () => {
  const known = ['name', 'phone', 'email', 'company'] as const;

  it('keeps the columns an address names, the name first', () => {
    expect(tableColumnsOf(['name', 'email', 'company'], known)).toEqual([
      'name',
      'email',
      'company',
    ]);
    expect(tableColumnsOf(['phone', 'name'], known)).toEqual(['name', 'phone']);
    expect(tableColumnsOf(['email'], known)).toEqual(['name', 'email']);
  });

  it('answers nothing for what is not a list of columns, each once', () => {
    expect(tableColumnsOf(undefined, known)).toBeUndefined();
    expect(tableColumnsOf('name', known)).toBeUndefined();
    expect(tableColumnsOf(['name', 'salary'], known)).toBeUndefined();
    expect(tableColumnsOf(['name', 'email', 'email'], known)).toBeUndefined();
    expect(tableColumnsOf(['name', 7], known)).toBeUndefined();
  });
});

describe('timeSince', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const since = (iso: string) => timeSince(new Date(iso), now);

  it('counts in the largest unit that has passed whole', () => {
    expect(since('2026-10-10T11:59:40.000Z')).toEqual({ value: 0, unit: 'minute' });
    expect(since('2026-10-10T11:15:00.000Z')).toEqual({ value: -45, unit: 'minute' });
    expect(since('2026-10-10T07:00:00.000Z')).toEqual({ value: -5, unit: 'hour' });
    expect(since('2026-10-07T12:00:00.000Z')).toEqual({ value: -3, unit: 'day' });
    expect(since('2026-09-19T12:00:00.000Z')).toEqual({ value: -3, unit: 'week' });
    expect(since('2026-07-10T12:00:00.000Z')).toEqual({ value: -3, unit: 'month' });
    expect(since('2024-10-10T12:00:00.000Z')).toEqual({ value: -2, unit: 'year' });
  });

  it('treats a moment the clocks put just ahead as now', () => {
    expect(since('2026-10-10T12:00:30.000Z')).toEqual({ value: 0, unit: 'minute' });
  });
});
