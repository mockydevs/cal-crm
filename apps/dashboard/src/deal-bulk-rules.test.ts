import type { BulkDealsResult } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { batchesOf, selectionAmong, tallyOf, toggled } from './deal-bulk-rules';

const result = (outcomes: readonly ('done' | 'unchanged' | 'skipped')[]): BulkDealsResult => ({
  action: 'trash',
  results: outcomes.map((outcome, index) => ({
    id: `deal_${String(index)}_${outcome}`,
    outcome,
    reason: outcome === 'skipped' ? { code: 'not_found', message: 'Not found.' } : null,
  })),
  done: outcomes.filter((each) => each === 'done').length,
  unchanged: outcomes.filter((each) => each === 'unchanged').length,
  skipped: outcomes.filter((each) => each === 'skipped').length,
  bulkActionId: null,
});

describe('a bulk action on opportunities', () => {
  it('sends a selection in groups of at most the limit, in order', () => {
    expect(batchesOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batchesOf([1, 2], 2)).toEqual([[1, 2]]);
    expect(batchesOf([], 2)).toEqual([]);
  });

  it('adds up what became of the opportunities of every request, and names the changed ones', () => {
    expect(tallyOf([result(['done', 'skipped']), result(['done', 'unchanged', 'done'])])).toEqual({
      done: 3,
      unchanged: 1,
      skipped: 1,
      changed: ['deal_0_done', 'deal_0_done', 'deal_2_done'],
    });
    expect(tallyOf([])).toEqual({ done: 0, unchanged: 0, skipped: 0, changed: [] });
  });

  it('keeps of a selection only what is shown and may be changed', () => {
    const shown = [
      { id: 'a', canManage: true },
      { id: 'b', canManage: false },
      { id: 'c', canManage: true },
    ];
    expect(selectionAmong(new Set(['a', 'b', 'gone']), shown)).toEqual(['a']);
  });

  it('puts one opportunity in a selection or takes it out, leaving the one it was given', () => {
    const selected = new Set(['a']);
    expect([...toggled(selected, 'b', true)]).toEqual(['a', 'b']);
    expect([...toggled(selected, 'a', false)]).toEqual([]);
    expect([...selected]).toEqual(['a']);
  });
});
