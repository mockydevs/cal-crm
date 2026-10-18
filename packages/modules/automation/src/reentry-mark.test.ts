// The mark a live run keeps of the events that came while it ran: one mark, the newest
// event, and how many came (reentry-mark.ts).
import { describe, expect, it } from 'vitest';

import { mergeMarks, reentryOf, startsAgain, type ReentryMark } from './reentry-mark.js';

const event = (n: number, recordedAt: string): Omit<ReentryMark, 'events'> => ({
  eventId: `0190a6f0-0000-7000-8000-00000000000${String(n)}`,
  eventType: 'field.value_set',
  recordedAt,
  correlationId: `0190a6f0-0000-7000-8000-0000000000a${String(n)}`,
  triggerId: 'changed',
  state: { triggerId: 'changed' },
});

describe('the mark a running run keeps', () => {
  it('starts at one event and keeps the newest of several, counting each', () => {
    const first = mergeMarks(undefined, event(1, '2026-10-14T10:00:00.000Z'));
    expect(first).toMatchObject({ eventId: event(1, '').eventId, events: 1 });
    const second = mergeMarks(first, event(2, '2026-10-14T10:00:00.100Z'));
    expect(second).toMatchObject({ eventId: event(2, '').eventId, events: 2 });
    // A match that runs late, for an older event, counts it and keeps the newer one.
    const late = mergeMarks(second, event(3, '2026-10-14T09:59:59.000Z'));
    expect(late).toMatchObject({ eventId: event(2, '').eventId, events: 3 });
  });

  it('is read from a run state, and starts nothing once what came of it is written', () => {
    const mark = mergeMarks(undefined, event(1, '2026-10-14T10:00:00.000Z'));
    expect(reentryOf({ sequence: 3, reentry: mark })).toEqual(mark);
    expect(startsAgain({ sequence: 3, reentry: mark })).toEqual(mark);
    expect(startsAgain({ reentry: { ...mark, outcome: 'started' } })).toBeUndefined();
    expect(startsAgain({ sequence: 3 })).toBeUndefined();
    expect(startsAgain(null)).toBeUndefined();
    expect(reentryOf({ reentry: { eventId: 'not an id' } })).toBeUndefined();
  });
});
