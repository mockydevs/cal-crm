import { describe, expect, it } from 'vitest';

import { addDuration, evaluateCondition } from './automations-evaluate.js';

const now = new Date('2026-10-11T12:00:00Z');

describe('automation date comparison boundaries', () => {
  it.each([
    ['within_last', '2026-10-10T12:00:00Z', true],
    ['within_last', '2026-10-10T11:59:59.999Z', false],
    ['within_last', '2026-10-11T12:00:00Z', true],
    ['within_last', '2026-10-11T12:00:00.001Z', false],
    ['within_next', '2026-10-11T12:00:00Z', true],
    ['within_next', '2026-10-11T11:59:59.999Z', false],
    ['within_next', '2026-10-12T12:00:00Z', true],
    ['within_next', '2026-10-12T12:00:00.001Z', false],
  ] as const)('%s at %s yields %s', (operator, actual, expected) => {
    expect(
      evaluateCondition(
        { field: 'contact.createdAt', operator, value: 'P1D' },
        { 'contact.createdAt': actual },
        now,
      ),
    ).toBe(expected);
  });

  it.each(['within_last', 'within_next'] as const)(
    '%s refuses malformed duration text',
    (operator) => {
      expect(
        evaluateCondition(
          { field: 'contact.createdAt', operator, value: '1 day' },
          { 'contact.createdAt': '2026-10-11T12:00:00Z' },
          now,
        ),
      ).toBe(false);
    },
  );

  it.each(['greater_than', 'less_than', 'before', 'after'] as const)(
    '%s refuses an invalid calendar date',
    (operator) => {
      expect(
        evaluateCondition(
          { field: 'contact.createdAt', operator, value: '2026-10-11' },
          { 'contact.createdAt': '2026-99-99' },
          now,
        ),
      ).toBe(false);
    },
  );

  it('rejects a malformed duration and leaves the input date untouched', () => {
    expect(addDuration(now, '1 day')).toBeUndefined();
    expect(now.toISOString()).toBe('2026-10-11T12:00:00.000Z');
  });

  it('uses calendar rollover for month durations without mutating the source', () => {
    const january = new Date('2026-01-31T12:00:00Z');
    expect(addDuration(january, 'P1M')?.toISOString()).toBe('2026-03-03T12:00:00.000Z');
    expect(january.toISOString()).toBe('2026-01-31T12:00:00.000Z');
  });
});
