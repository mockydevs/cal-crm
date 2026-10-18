import { describe, expect, it } from 'vitest';

import {
  addressChoice,
  blockerOf,
  choicesOf,
  conflicts,
  defaultSource,
  mergeBodyOf,
  mergeOrder,
  movedRows,
  rowKey,
  type FieldRow,
} from './rules';

const [a, b, c] = ['con_a', 'con_b', 'con_c'] as const;
const revision = (letter: string) => letter.repeat(64);

const row = (field: string, values: Record<string, string | null>, custom = false): FieldRow => ({
  field,
  custom,
  values: new Map(Object.entries(values)),
});

describe('the order a merge reads the contacts in', () => {
  it('puts the contact kept first, then the others as given', () => {
    expect(mergeOrder([a, b, c], b)).toEqual([b, a, c]);
    expect(mergeOrder([a, b, c], a)).toEqual([a, b, c]);
  });
});

describe('which value a field keeps unless another is picked', () => {
  it("keeps the master's value, or the first value of the others when it has none", () => {
    expect(defaultSource(row('firstName', { [a]: 'Jane', [b]: 'Janet' }), [a, b])).toBe(a);
    expect(defaultSource(row('firstName', { [a]: null, [b]: null, [c]: 'J' }), [a, b, c])).toBe(c);
    expect(defaultSource(row('firstName', { [a]: null, [b]: null }), [a, b])).toBeNull();
  });

  it('asks only where two contacts have different values', () => {
    expect(conflicts(row('lastName', { [a]: 'Doe', [b]: 'Doe' }))).toBe(false);
    expect(conflicts(row('lastName', { [a]: 'Doe', [b]: null }))).toBe(false);
    expect(conflicts(row('lastName', { [a]: 'Doe', [b]: 'Dough' }))).toBe(true);
  });
});

describe('the choices a merge sends', () => {
  const firstName = row('firstName', { [a]: 'Jane', [b]: 'Janet' });
  const budget = row('budget', { [a]: '"100"', [b]: '"250"' }, true);
  const rows = [firstName, row('lastName', { [a]: null, [b]: 'Doe' }), budget];

  it('sends nothing when every field keeps its default', () => {
    expect(choicesOf(rows, new Map(), [a, b])).toEqual({});
    // Picking the default is the same as not picking.
    expect(choicesOf(rows, new Map([[rowKey(firstName), a]]), [a, b])).toEqual({});
  });

  it('sends only the fields picked away from the default, own and custom apart', () => {
    const picks = new Map([
      [rowKey(firstName), b],
      [rowKey(budget), b],
    ]);
    expect(choicesOf(rows, picks, [a, b])).toEqual({
      fields: { firstName: b },
      customFields: { budget: b },
    });
  });

  it('judges the default from the master in use, so a pick can become the default', () => {
    const picks = new Map([[rowKey(firstName), b]]);
    expect(choicesOf(rows, picks, [b, a])).toEqual({});
  });
});

describe('the primary email address and phone number', () => {
  it("offers every contact's addresses once, the master's primary first and chosen", () => {
    const choice = addressChoice(
      new Map([
        [a, ['jane@example.com', 'shared@example.com']],
        [b, ['janet@example.com', 'shared@example.com']],
      ]),
      [b, a],
    );
    expect(choice.options).toEqual(['janet@example.com', 'shared@example.com', 'jane@example.com']);
    expect(choice.fallback).toBe('janet@example.com');
  });

  it('takes the first primary of the others when the master has none, and nothing if none has', () => {
    expect(
      addressChoice(
        new Map([
          [a, []],
          [b, ['+12125550142']],
        ]),
        [a, b],
      ).fallback,
    ).toBe('+12125550142');
    expect(addressChoice(new Map([[a, []]]), [a]).fallback).toBeUndefined();
  });
});

describe('the request a merge sends', () => {
  const preview = {
    contacts: [
      { id: b, revision: revision('b') },
      { id: a, revision: revision('a') },
    ],
    moved: {},
    rows: 4,
    maxRows: 50_000,
  };

  it("names the others, every contact's revision, and only the choices changed", () => {
    expect(
      mergeBodyOf({
        order: [b, a],
        rows: [row('firstName', { [a]: 'Jane', [b]: 'Janet' })],
        picks: new Map([['own:firstName', a]]),
        emails: addressChoice(
          new Map([
            [a, ['jane@example.com']],
            [b, ['janet@example.com']],
          ]),
          [b, a],
        ),
        email: 'jane@example.com',
        phones: addressChoice(
          new Map([
            [a, ['+12125550142']],
            [b, []],
          ]),
          [b, a],
        ),
        phone: '+12125550142',
        preview,
      }),
    ).toEqual({
      mergeIds: [a],
      fields: { firstName: a },
      primaryEmail: 'jane@example.com',
      revisions: { [b]: revision('b'), [a]: revision('a') },
    });
  });
});

describe('what may stop the merge button', () => {
  const preview = { contacts: [], moved: {}, rows: 10, maxRows: 100 };

  it('waits for the preview, refuses one too large, and needs the box ticked', () => {
    expect(blockerOf({ preview: undefined, confirmed: true })).toBe('loading');
    expect(blockerOf({ preview: { ...preview, rows: 101 }, confirmed: true })).toBe('too_large');
    expect(blockerOf({ preview, confirmed: false })).toBe('unconfirmed');
    expect(blockerOf({ preview, confirmed: true })).toBeUndefined();
  });
});

describe('what moves', () => {
  it('lists each kind of row that moves, by module, and leaves out what moves none of', () => {
    expect(
      movedRows({ crm: { notes: 3, tasks: 0, timeline: 12 }, messaging: { conversations: 1 } }),
    ).toEqual([
      { module: 'crm', kind: 'notes', count: 3 },
      { module: 'crm', kind: 'timeline', count: 12 },
      { module: 'messaging', kind: 'conversations', count: 1 },
    ]);
  });
});
