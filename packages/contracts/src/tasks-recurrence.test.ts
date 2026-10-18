import { describe, expect, it } from 'vitest';
import {
  lastOccurrenceBy,
  occurrenceDue,
  occurrenceWithinEnd,
  recurrencePeriod,
  taskRecurrenceInput,
  type TaskSchedule,
} from './tasks-recurrence.js';

const schedule = (overrides: Partial<TaskSchedule>): TaskSchedule => ({
  frequency: 'daily',
  every: 1,
  anchorDueAt: new Date('2026-03-07T14:00:00Z'),
  anchorOccurrence: 0,
  timeZone: 'America/New_York',
  ...overrides,
});

describe('occurrenceDue', () => {
  it('keeps a daily task at its wall-clock time across the spring and autumn clock changes', () => {
    // 09:00 in New York on 7 March 2026 (EST, UTC-5); clocks go forward on 8 March.
    const daily = schedule({});
    expect(occurrenceDue(daily, 0)?.toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(occurrenceDue(daily, 1)?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(occurrenceDue(daily, 2)?.toISOString()).toBe('2026-03-09T13:00:00.000Z');
    // Clocks go back on 1 November 2026: 09:00 EDT on 31 October, 09:00 EST on 1 November.
    const autumn = schedule({ anchorDueAt: new Date('2026-10-31T13:00:00Z') });
    expect(occurrenceDue(autumn, 1)?.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('moves an hourly task by the hour on the clock of the world, not the wall', () => {
    // 01:30 EST, 8 March: the next hour is 03:30 EDT, one real hour later.
    const hourly = schedule({ frequency: 'hourly', anchorDueAt: new Date('2026-03-08T06:30:00Z') });
    expect(occurrenceDue(hourly, 1)?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(occurrenceDue({ ...hourly, every: 6 }, 2)?.toISOString()).toBe(
      '2026-03-08T18:30:00.000Z',
    );
  });

  it('repeats weekly on the same weekday, and every n weeks', () => {
    const weekly = schedule({ frequency: 'weekly', every: 2 });
    expect(occurrenceDue(weekly, 1)?.toISOString()).toBe('2026-03-21T13:00:00.000Z');
    expect(occurrenceDue(weekly, 3)?.toISOString()).toBe('2026-04-18T13:00:00.000Z');
  });

  it('keeps a monthly task on its day, or the last day of a shorter month, without drifting', () => {
    const monthly = schedule({
      frequency: 'monthly',
      anchorDueAt: new Date('2026-01-31T14:00:00Z'),
    });
    expect(occurrenceDue(monthly, 1)?.toISOString()).toBe('2026-02-28T14:00:00.000Z');
    expect(occurrenceDue(monthly, 2)?.toISOString()).toBe('2026-03-31T13:00:00.000Z');
    expect(occurrenceDue(monthly, 3)?.toISOString()).toBe('2026-04-30T13:00:00.000Z');
    expect(occurrenceDue({ ...monthly, every: 13 }, 1)?.toISOString()).toBe(
      '2027-02-28T14:00:00.000Z',
    );
  });

  it('keeps a yearly task of 29 February on the 28th in other years', () => {
    const leap = schedule({
      frequency: 'yearly',
      anchorDueAt: new Date('2028-02-29T14:00:00Z'),
    });
    expect(occurrenceDue(leap, 1)?.toISOString()).toBe('2029-02-28T14:00:00.000Z');
    expect(occurrenceDue(leap, 4)?.toISOString()).toBe('2032-02-29T14:00:00.000Z');
  });

  it('counts from the anchor occurrence, so an edited series runs on from the task it was edited at', () => {
    const edited = schedule({ anchorOccurrence: 5 });
    expect(occurrenceDue(edited, 5)?.toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(occurrenceDue(edited, 6)?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('moves a wall-clock time the clocks skip forward by the gap, and keeps seconds', () => {
    // 02:30 on 7 March is real; on 8 March it does not exist in New York and becomes 03:30.
    const early = schedule({ anchorDueAt: new Date('2026-03-07T07:30:15Z') });
    expect(occurrenceDue(early, 1)?.toISOString()).toBe('2026-03-08T07:30:15.000Z');
    expect(occurrenceDue(early, 2)?.toISOString()).toBe('2026-03-09T06:30:15.000Z');
  });

  it('gives nothing for a time zone that is not one', () => {
    expect(occurrenceDue(schedule({ timeZone: 'Mars/Olympus' }), 1)).toBeUndefined();
  });
});

describe('occurrenceWithinEnd', () => {
  const due = new Date('2026-03-10T03:30:00Z');
  it('compares the due date in the series time zone with the last day', () => {
    // 23:30 on 9 March in New York.
    expect(
      occurrenceWithinEnd(due, 'America/New_York', { endsOn: '2026-03-09', occurrence: 1 }),
    ).toBe(true);
    expect(occurrenceWithinEnd(due, 'UTC', { endsOn: '2026-03-09', occurrence: 1 })).toBe(false);
  });
  it('counts every scheduled occurrence against the most, skipped ones too, and never ends otherwise', () => {
    // Occurrences are counted from 0: the third of three is occurrence 2.
    expect(occurrenceWithinEnd(due, 'UTC', { maxOccurrences: 3, occurrence: 2 })).toBe(true);
    expect(occurrenceWithinEnd(due, 'UTC', { maxOccurrences: 3, occurrence: 3 })).toBe(false);
    expect(occurrenceWithinEnd(due, 'UTC', { occurrence: 5000 })).toBe(true);
  });
});

describe('taskRecurrenceInput', () => {
  it('reads GoHighLevel’s choices with their defaults', () => {
    expect(taskRecurrenceInput.parse({ frequency: 'weekly' })).toEqual({
      frequency: 'weekly',
      every: 1,
      ends: { type: 'never' },
      createIfOverdue: false,
    });
    expect(
      taskRecurrenceInput.parse({
        frequency: 'monthly',
        every: 2,
        ends: { type: 'after', occurrences: 12 },
        createIfOverdue: true,
      }).ends,
    ).toEqual({ type: 'after', occurrences: 12 });
    expect(
      taskRecurrenceInput.parse({ frequency: 'daily', ends: { type: 'on', date: '2026-12-31' } })
        .ends,
    ).toEqual({ type: 'on', date: '2026-12-31' });
  });

  it('refuses what cannot be scheduled', () => {
    for (const bad of [
      { frequency: 'fortnightly' },
      { frequency: 'daily', every: 0 },
      { frequency: 'daily', every: 1000 },
      { frequency: 'daily', ends: { type: 'after', occurrences: 0 } },
      { frequency: 'daily', ends: { type: 'after', occurrences: 1001 } },
      { frequency: 'daily', ends: { type: 'on', date: '2026-02-30' } },
      { frequency: 'daily', ends: { type: 'on' } },
      { frequency: 'daily', dayOfWeek: 'MO' },
    ])
      expect(taskRecurrenceInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('lastOccurrenceBy', () => {
  const by = (schedule: TaskSchedule, instant: string) =>
    lastOccurrenceBy(schedule, new Date(instant));

  it('finds the newest occurrence due by an instant in a step, however far it is', () => {
    const daily = schedule({ anchorDueAt: new Date('0001-01-01T09:00:00Z'), timeZone: 'UTC' });
    // 739,000-odd days on: found without walking them, and exactly.
    const found = by(daily, '2026-10-17T12:00:00Z');
    expect(occurrenceDue(daily, found)?.toISOString()).toBe('2026-10-17T09:00:00.000Z');
    expect(occurrenceDue(daily, found + 1)?.toISOString()).toBe('2026-10-18T09:00:00.000Z');
    expect(by(daily, '2026-10-17T08:59:59Z')).toBe(found - 1);
  });

  it('lands on the right one across clock changes, months of uneven length and leap years', () => {
    const ny = schedule({ frequency: 'daily', anchorDueAt: new Date('2026-03-07T14:00:00Z') });
    expect(by(ny, '2026-11-02T14:00:00Z')).toBe(240);
    expect(by(ny, '2026-11-02T13:59:59Z')).toBe(239);
    const monthly = schedule({
      frequency: 'monthly',
      anchorDueAt: new Date('2026-01-31T14:00:00Z'),
    });
    expect(by(monthly, '2026-02-28T14:00:00Z')).toBe(1);
    expect(by(monthly, '2026-02-28T13:59:59Z')).toBe(0);
    expect(by(monthly, '2036-01-31T14:00:00Z')).toBe(120);
    const leap = schedule({ frequency: 'yearly', anchorDueAt: new Date('2028-02-29T14:00:00Z') });
    expect(by(leap, '2032-02-29T14:00:00Z')).toBe(4);
    expect(by(leap, '2032-02-29T13:00:00Z')).toBe(3);
    const hourly = schedule({
      frequency: 'hourly',
      every: 6,
      anchorDueAt: new Date('2026-03-08T06:30:00Z'),
    });
    expect(by(hourly, '2026-03-09T06:30:00Z')).toBe(4);
  });

  it('starts from the anchor of an edited series, and gives one before the anchor when none is due', () => {
    const edited = schedule({ anchorOccurrence: 5 });
    expect(by(edited, '2026-03-08T13:00:00Z')).toBe(6);
    expect(by(edited, '2026-03-01T00:00:00Z')).toBe(4);
  });
});

describe('recurrencePeriod', () => {
  it('is the shortest and the longest a step of the rule can be', () => {
    expect(recurrencePeriod({ frequency: 'hourly', every: 2 })).toEqual({
      shortest: 7_200_000,
      longest: 7_200_000,
    });
    expect(recurrencePeriod({ frequency: 'daily', every: 1 })).toEqual({
      shortest: 23 * 3_600_000,
      longest: 25 * 3_600_000,
    });
    expect(recurrencePeriod({ frequency: 'monthly', every: 1 }).shortest).toBe(
      28 * 86_400_000 - 3_600_000,
    );
    expect(recurrencePeriod({ frequency: 'yearly', every: 1 }).longest).toBe(
      366 * 86_400_000 + 3_600_000,
    );
  });
});
