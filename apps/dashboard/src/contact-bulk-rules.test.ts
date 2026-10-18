import { describe, expect, it } from 'vitest';
import {
  bulkActionLabel,
  bulkProgress,
  bulkStillGoing,
  itemOutcomeFilters,
} from './contact-bulk-rules';

describe('the label of a bulk action', () => {
  it('is the name it was given', () => {
    expect(
      bulkActionLabel(
        { name: 'Tag trade fair leads', createdAt: '2026-10-01T10:00:00.000Z' },
        'en',
      ),
    ).toBe('Tag trade fair leads');
  });

  it('is when it was started, for one with no name or a blank one', () => {
    const started = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date('2026-10-01T10:00:00.000Z'));
    expect(bulkActionLabel({ name: null, createdAt: '2026-10-01T10:00:00.000Z' }, 'en')).toBe(
      started,
    );
    expect(bulkActionLabel({ name: '   ', createdAt: '2026-10-01T10:00:00.000Z' }, 'en')).toBe(
      started,
    );
  });
});

describe('how far a bulk action has got', () => {
  it('counts every contact with an outcome, whatever the outcome', () => {
    expect(bulkProgress({ requested: 250, done: 90, unchanged: 7, skipped: 3 })).toEqual({
      settled: 100,
      requested: 250,
    });
  });

  it('never says more than the action covers', () => {
    expect(bulkProgress({ requested: 5, done: 5, unchanged: 1, skipped: 0 })).toEqual({
      settled: 5,
      requested: 5,
    });
  });
});

describe('whether a bulk action is still going', () => {
  it('is while it is queued or running, and not once it ended or was stopped', () => {
    expect(bulkStillGoing({ status: 'queued' })).toBe(true);
    expect(bulkStillGoing({ status: 'running' })).toBe(true);
    expect(bulkStillGoing({ status: 'completed' })).toBe(false);
    expect(bulkStillGoing({ status: 'cancelled' })).toBe(false);
  });
});

it('offers every outcome the server filters on, with all first and waiting last', () => {
  expect(itemOutcomeFilters).toEqual(['all', 'done', 'unchanged', 'skipped', 'pending']);
});
