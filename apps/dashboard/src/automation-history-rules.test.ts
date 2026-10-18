import { describe, expect, it } from 'vitest';
import { momentsOf, stepStatuses } from './automation-history-rules';

describe('the range two days stand for', () => {
  it('runs from the start of the first day to the end of the last, here', () => {
    const { from, to } = momentsOf('2026-10-06', '2026-10-08');
    expect(from).toBe(new Date(2026, 9, 6).toISOString());
    expect(to).toBe(new Date(2026, 9, 9).toISOString());
  });

  it('includes a single day whole, and crosses the end of a month', () => {
    const { from, to } = momentsOf('2026-10-31', '2026-10-31');
    expect(from).toBe(new Date(2026, 9, 31).toISOString());
    expect(to).toBe(new Date(2026, 10, 1).toISOString());
  });

  it('leaves a side open when its box is empty or holds no day', () => {
    expect(momentsOf('', '')).toEqual({});
    expect(momentsOf('2026-10-06', '')).toEqual({ from: new Date(2026, 9, 6).toISOString() });
    expect(momentsOf('soon', '2026-10-08')).toEqual({ to: new Date(2026, 9, 9).toISOString() });
  });

  it('lists the statuses a step can have', () => {
    expect(stepStatuses).toEqual(['succeeded', 'waiting', 'running', 'failed', 'skipped']);
  });
});
