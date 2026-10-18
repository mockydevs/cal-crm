import {
  dealListQuery,
  dealSortDirection,
  dealSorts,
  dealTableColumns,
  dealViewColumns,
  dealViewState,
  sortDirections,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  dealColumnsOfView,
  dealOrderKeys,
  dealOrderOf,
  dealOrderState,
  defaultDealColumns,
  firstDealColumns,
} from './deal-list-rules';

describe('the columns of the opportunity table', () => {
  it('start as a list the contract takes', () => {
    expect(dealTableColumns.safeParse(defaultDealColumns).success).toBe(true);
  });

  it('show a view saved before it could choose as the table showed it then', () => {
    expect(dealColumnsOfView({ columns: ['amount', 'name'] })).toEqual([
      'name',
      'value',
      'contact',
      'owner',
      'tags',
    ]);
    expect(dealColumnsOfView({ columns: ['name'], tableColumns: null })).toEqual([
      'name',
      'contact',
      'owner',
      'tags',
    ]);
    expect(
      dealColumnsOfView({
        columns: ['name', 'stage'],
        tableColumns: ['name', 'source', 'created'],
      }),
    ).toEqual(['name', 'source', 'created']);
  });

  it('keep, for the five-column list a view is still saved with, the ones the table shows', () => {
    const first = firstDealColumns(['name', 'owner', 'status', 'value', 'created', 'stage']);
    expect(first).toEqual(['name', 'outcome', 'amount', 'stage']);
    expect(dealViewColumns.safeParse(first).success).toBe(true);
    expect(firstDealColumns(['name', 'pipeline', 'expectedClose'])).toEqual([
      'name',
      'expectedClose',
    ]);
  });
});

describe('the built-in orders of the opportunity list', () => {
  it('are each of the server orders, both ways', () => {
    expect(dealOrderKeys).toHaveLength(dealSorts.length * sortDirections.length);
    const kept = dealOrderKeys.map((key) => JSON.stringify(dealOrderState(key)));
    expect(new Set(kept).size).toBe(dealOrderKeys.length);
  });

  it('keep nothing in the address for newest first, and a direction only when unusual', () => {
    expect(dealOrderState('created')).toEqual({});
    expect(dealOrderState('created:asc')).toEqual({ sort: 'created', direction: 'asc' });
    expect(dealOrderState('name')).toEqual({ sort: 'name' });
    expect(dealOrderState('name:desc')).toEqual({ sort: 'name', direction: 'desc' });
    expect(dealOrderState('value')).toEqual({ sort: 'value' });
    expect(dealOrderState('value:asc')).toEqual({ sort: 'value', direction: 'asc' });
  });

  it('read back what they keep, as the list query and a saved view take it', () => {
    for (const key of dealOrderKeys) {
      const state = dealOrderState(key);
      expect(dealOrderOf(state)).toBe(key);
      expect(dealListQuery.safeParse(state).success).toBe(true);
      expect(dealViewState.safeParse(state).success).toBe(true);
    }
  });

  it('name a direction the server would take anyway as the order itself', () => {
    for (const sort of dealSorts)
      expect(dealOrderOf({ sort, direction: dealSortDirection(sort) })).toBe(sort);
    expect(dealOrderOf({})).toBe('created');
    expect(dealOrderOf({ sort: 'updated', direction: 'asc' })).toBe('updated:asc');
  });
});
