import { describe, expect, it } from 'vitest';
import { contactsAfter } from './deal-people-rules';

describe("an opportunity's contacts after a change", () => {
  const linked = { primary: 'a', additional: ['b', 'c'] };

  it('adds a contact last, once', () => {
    expect(contactsAfter(linked, { kind: 'add', id: 'd' })).toEqual({
      primary: 'a',
      additional: ['b', 'c', 'd'],
    });
    expect(contactsAfter(linked, { kind: 'add', id: 'b' })).toBe(linked);
    expect(contactsAfter(linked, { kind: 'add', id: 'a' })).toBe(linked);
  });

  it('removes the primary or an additional contact, and leaves the rest', () => {
    expect(contactsAfter(linked, { kind: 'remove', id: 'a' })).toEqual({
      primary: null,
      additional: ['b', 'c'],
    });
    expect(contactsAfter(linked, { kind: 'remove', id: 'c' })).toEqual({
      primary: 'a',
      additional: ['b'],
    });
  });

  it('swaps an additional contact with the primary, in its place', () => {
    expect(contactsAfter(linked, { kind: 'primary', id: 'b' })).toEqual({
      primary: 'b',
      additional: ['a', 'c'],
    });
  });

  it('keeps the primary before as an additional contact when a new one is chosen', () => {
    expect(contactsAfter(linked, { kind: 'primary', id: 'd' })).toEqual({
      primary: 'd',
      additional: ['b', 'c', 'a'],
    });
    expect(
      contactsAfter({ primary: null, additional: ['b'] }, { kind: 'primary', id: 'b' }),
    ).toEqual({ primary: 'b', additional: [] });
    expect(contactsAfter(linked, { kind: 'primary', id: 'a' })).toBe(linked);
  });

  it('lets the primary before go when the additional contacts are full', () => {
    const full = { primary: 'a', additional: ['b', 'c'] };
    expect(contactsAfter(full, { kind: 'primary', id: 'd' }, 2)).toEqual({
      primary: 'd',
      additional: ['b', 'c'],
    });
  });
});
