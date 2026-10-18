import { describe, expect, it } from 'vitest';

import { scoreMismatch, type ScoreFilter } from './score-trigger.js';

const at = (operator: ScoreFilter['operator'], score: number, actual: unknown) =>
  scoreMismatch({ operator, score }, { score: actual }) === undefined;

describe('the Contact Engagement Score trigger', () => {
  it('compares the score a change left, as each comparison says', () => {
    expect(at('equals', 10, 10)).toBe(true);
    expect(at('equals', 10, 11)).toBe(false);
    expect(at('not_equals', 10, 11)).toBe(true);
    expect(at('not_equals', 10, 10)).toBe(false);
    expect(at('gt', 195, 196)).toBe(true);
    expect(at('gt', 195, 195)).toBe(false);
    expect(at('gte', 195, 195)).toBe(true);
    expect(at('lt', 0, -1)).toBe(true);
    expect(at('lt', 0, 0)).toBe(false);
    expect(at('lte', 0, 0)).toBe(true);
    expect(at('lte', 0, 1)).toBe(false);
  });

  it('says what it wanted and what the change left', () => {
    expect(scoreMismatch({ operator: 'gt', score: 195 }, { score: 12 })).toEqual({
      filter: 'score',
      expected: 'gt 195',
      actual: 12,
    });
    expect(scoreMismatch({ operator: 'gt', score: 195 }, {})).toEqual({
      filter: 'score',
      expected: 'gt 195',
      actual: null,
    });
  });
});
