import { describe, expect, it } from 'vitest';
import {
  createdSince,
  emptyTrail,
  fieldDraftReady,
  rangeOf,
  trailBack,
  trailForward,
  type FieldDraft,
} from './settings-rules';

describe('the pages of a keyset list', () => {
  it('starts on the first page, with nothing to go back to', () => {
    expect(emptyTrail).toEqual({ after: [], index: 0 });
    expect(trailBack(emptyTrail)).toBe(emptyTrail);
  });

  it('goes forward with the cursor the page gave, and back to the page before', () => {
    const second = trailForward(emptyTrail, 'fld_b');
    expect(second).toEqual({ after: ['fld_b'], index: 1 });
    const third = trailForward(second, 'fld_c');
    expect(third).toEqual({ after: ['fld_b', 'fld_c'], index: 2 });
    expect(trailBack(third)).toEqual({ after: ['fld_b'], index: 1 });
    expect(trailBack(trailBack(third))).toEqual(emptyTrail);
  });

  it('stays where it is on the last page', () => {
    const second = trailForward(emptyTrail, 'fld_b');
    expect(trailForward(second, null)).toBe(second);
  });

  it('says which rows a page shows of how many', () => {
    expect(rangeOf({ index: 0, pageSize: 20, shown: 20, total: 58 })).toEqual({
      from: 1,
      to: 20,
      total: 58,
    });
    expect(rangeOf({ index: 2, pageSize: 20, shown: 18, total: 58 })).toEqual({
      from: 41,
      to: 58,
      total: 58,
    });
  });

  it('says nothing is shown when the list is empty', () => {
    expect(rangeOf({ index: 0, pageSize: 20, shown: 0, total: 0 })).toEqual({
      from: 0,
      to: 0,
      total: 0,
    });
  });

  it('never claims fewer rows in all than it has shown', () => {
    // A row added since the count was taken.
    expect(rangeOf({ index: 1, pageSize: 20, shown: 20, total: 39 }).total).toBe(40);
  });
});

describe('the Created filter', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');

  it('asks for nothing when any time will do', () => {
    expect(createdSince('any', now)).toBeUndefined();
  });

  it('counts whole days back from now', () => {
    expect(createdSince('7', now)).toBe('2026-10-04T12:00:00.000Z');
    expect(createdSince('30', now)).toBe('2026-09-11T12:00:00.000Z');
    expect(createdSince('90', now)).toBe('2026-07-13T12:00:00.000Z');
  });
});

describe('a field that is ready to save', () => {
  const draft: FieldDraft = {
    label: 'Guest count',
    key: 'guest_count',
    description: 'The latest expected number of guests.',
    valueType: 'number',
    currency: '',
    options: [],
  };

  it('needs a name, a key and what it means', () => {
    expect(fieldDraftReady(draft, true)).toBe(true);
    expect(fieldDraftReady({ ...draft, label: '  ' }, true)).toBe(false);
    expect(fieldDraftReady({ ...draft, description: '' }, true)).toBe(false);
    expect(fieldDraftReady({ ...draft, key: 'Guest count' }, true)).toBe(false);
    expect(fieldDraftReady({ ...draft, key: '' }, true)).toBe(false);
  });

  it('does not ask again for what a saved field can never change', () => {
    expect(fieldDraftReady({ ...draft, key: '', valueType: 'money', currency: '' }, false)).toBe(
      true,
    );
  });

  it('needs a three-letter currency for money', () => {
    expect(fieldDraftReady({ ...draft, valueType: 'money', currency: 'KE' }, true)).toBe(false);
    expect(fieldDraftReady({ ...draft, valueType: 'money', currency: 'KES' }, true)).toBe(true);
  });

  it('needs at least one named choice for a dropdown, and no unnamed one', () => {
    const choice = { ...draft, valueType: 'single_choice' as const };
    expect(fieldDraftReady(choice, true)).toBe(false);
    expect(fieldDraftReady({ ...choice, options: [{ label: 'Vinyl' }] }, true)).toBe(true);
    expect(
      fieldDraftReady({ ...choice, options: [{ label: 'Vinyl' }, { label: ' ' }] }, true),
    ).toBe(false);
    expect(fieldDraftReady({ ...choice, options: [{ label: 'Vinyl' }] }, false)).toBe(true);
  });
});
