import { describe, expect, it } from 'vitest';
import { draftOf, recurrenceOf, NO_RECURRENCE, seriesRecurrenceOf } from './task-recurrence-rules';

describe('a recurrence draft', () => {
  it('starts off, daily, every 1, never ending, and not made while overdue', () => {
    expect(draftOf(undefined)).toEqual(NO_RECURRENCE);
    expect(NO_RECURRENCE).toEqual({
      on: false,
      frequency: 'daily',
      every: '1',
      ends: 'never',
      endsOn: '',
      occurrences: '10',
      createIfOverdue: false,
    });
  });

  it('opens on the rule a task of a series has', () => {
    expect(
      draftOf({
        frequency: 'monthly',
        every: 2,
        ends: { type: 'after', occurrences: 6 },
        createIfOverdue: true,
        occurrence: 1,
        active: true,
        nextDueAt: null,
      }),
    ).toEqual({
      on: true,
      frequency: 'monthly',
      every: '2',
      ends: 'after',
      endsOn: '',
      occurrences: '6',
      createIfOverdue: true,
    });
    expect(
      draftOf({
        frequency: 'weekly',
        every: 1,
        ends: { type: 'on', date: '2026-12-31' },
        createIfOverdue: false,
        occurrence: 0,
        active: false,
        nextDueAt: null,
      }),
    ).toMatchObject({ ends: 'on', endsOn: '2026-12-31', on: false });
  });
});

describe('the recurrence a draft sends', () => {
  it('is none when it is off', () => {
    expect(recurrenceOf(NO_RECURRENCE)).toEqual({ ok: true, value: null });
  });

  it('is the rule, with the end it says', () => {
    const on = { ...NO_RECURRENCE, on: true };
    expect(recurrenceOf({ ...on, frequency: 'weekly', every: '2' })).toEqual({
      ok: true,
      value: { frequency: 'weekly', every: 2, ends: { type: 'never' }, createIfOverdue: false },
    });
    expect(recurrenceOf({ ...on, ends: 'on', endsOn: '2027-01-31' })).toMatchObject({
      ok: true,
      value: { ends: { type: 'on', date: '2027-01-31' } },
    });
    expect(recurrenceOf({ ...on, ends: 'after', occurrences: '4', createIfOverdue: true })).toEqual(
      {
        ok: true,
        value: {
          frequency: 'daily',
          every: 1,
          ends: { type: 'after', occurrences: 4 },
          createIfOverdue: true,
        },
      },
    );
  });

  it('names the field that cannot be sent', () => {
    const on = { ...NO_RECURRENCE, on: true };
    expect(recurrenceOf({ ...on, every: '0' })).toEqual({ ok: false, field: 'every' });
    expect(recurrenceOf({ ...on, every: '1.5' })).toEqual({ ok: false, field: 'every' });
    expect(recurrenceOf({ ...on, every: '1000' })).toEqual({ ok: false, field: 'every' });
    expect(recurrenceOf({ ...on, ends: 'on', endsOn: '' })).toEqual({ ok: false, field: 'endsOn' });
    expect(recurrenceOf({ ...on, ends: 'after', occurrences: '0' })).toEqual({
      ok: false,
      field: 'occurrences',
    });
    expect(recurrenceOf({ ...on, ends: 'after', occurrences: '1001' })).toEqual({
      ok: false,
      field: 'occurrences',
    });
  });
});

describe('what an edit of a whole series sends', () => {
  const original = {
    frequency: 'monthly' as const,
    every: 1,
    ends: { type: 'never' as const },
    createIfOverdue: false,
    occurrence: 1,
    active: true,
    nextDueAt: '2027-03-31T13:00:00.000Z',
  };

  it('is nothing while the rule is as it was', () => {
    expect(seriesRecurrenceOf(original, draftOf(original))).toEqual({ ok: true, value: undefined });
    expect(seriesRecurrenceOf(original, { ...draftOf(original), endsOn: '2030-01-01' })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('is the new rule when it changed, and null to stop', () => {
    expect(seriesRecurrenceOf(original, { ...draftOf(original), every: '2' })).toEqual({
      ok: true,
      value: { frequency: 'monthly', every: 2, ends: { type: 'never' }, createIfOverdue: false },
    });
    expect(seriesRecurrenceOf(original, { ...draftOf(original), on: false })).toEqual({
      ok: true,
      value: null,
    });
    // A stopped series left stopped sends nothing.
    const stopped = { ...original, active: false, nextDueAt: null };
    expect(seriesRecurrenceOf(stopped, draftOf(stopped))).toEqual({ ok: true, value: undefined });
  });
});
