import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  decodeGroupCursor,
  encodeGroupCursor,
  isRejected,
  isWeakGroup,
  nameGroupsOf,
  nameKeyOf,
} from './duplicate-keys.js';
import { importMatchOrder, matchFields } from './duplicate-settings.js';

const uuid = (n: number) => `01890a5d-ac96-774b-bcce-b3020990${String(n).padStart(4, '0')}`;

describe('the order details are matched in', () => {
  const both = { email: true, phone: true };
  const emailOnly = { email: true, phone: false };
  const phoneOnly = { email: false, phone: true };
  const neither = { email: false, phone: false };

  it('is unchanged by default: email, and phone only when no email was given', () => {
    const settings = { primary: 'email', secondary: null } as const;
    expect(matchFields(settings, both)).toEqual(['email']);
    expect(matchFields(settings, emailOnly)).toEqual(['email']);
    expect(matchFields(settings, phoneOnly)).toEqual(['phone']);
    expect(matchFields(settings, neither)).toEqual([]);
  });

  it('tries the secondary field when one is set, after the primary', () => {
    const settings = { primary: 'email', secondary: 'phone' } as const;
    expect(matchFields(settings, both)).toEqual(['email', 'phone']);
    expect(matchFields(settings, emailOnly)).toEqual(['email']);
    expect(matchFields(settings, phoneOnly)).toEqual(['phone']);
  });

  it('starts with the phone number when it is the primary field', () => {
    const alone = { primary: 'phone', secondary: null } as const;
    expect(matchFields(alone, both)).toEqual(['phone']);
    expect(matchFields(alone, emailOnly)).toEqual(['email']);
    expect(matchFields(alone, phoneOnly)).toEqual(['phone']);
    const withEmail = { primary: 'phone', secondary: 'email' } as const;
    expect(matchFields(withEmail, both)).toEqual(['phone', 'email']);
    expect(matchFields(withEmail, neither)).toEqual([]);
  });

  it('has an import look at both, the primary field first', () => {
    expect(importMatchOrder({ primary: 'email', secondary: null })).toEqual(['email', 'phone']);
    expect(importMatchOrder({ primary: 'phone', secondary: null })).toEqual(['phone', 'email']);
    expect(importMatchOrder({ primary: 'phone', secondary: 'email' })).toEqual(['phone', 'email']);
  });
});

describe('a page cursor', () => {
  it('carries a match key, or a contact for names, and reads back', () => {
    for (const [by, value] of [
      ['email', 'janedoe@gmail.com'],
      ['phone', '2125550142'],
      ['name', uuid(7)],
    ] as const)
      expect(decodeGroupCursor(by, encodeGroupCursor(by, value))).toBe(value);
    expect(decodeGroupCursor('email', undefined)).toBeUndefined();
  });

  it('refuses one it did not make', () => {
    expect(() => decodeGroupCursor('name', 'not-a-cursor')).toThrow(ValidationError);
    expect(() => decodeGroupCursor('email', '***')).toThrow(ValidationError);
    expect(() => decodeGroupCursor('phone', encodeGroupCursor('phone', ''))).toThrow(
      ValidationError,
    );
  });
});

describe('a weaker sign', () => {
  it('is another +tag outside Gmail, never a Gmail variant', () => {
    expect(isWeakGroup('email', 'j.doe@work.example', [])).toBe(true);
    expect(isWeakGroup('email', 'janedoe@gmail.com', [])).toBe(false);
  });

  it('is the same last ten digits under names that differ', () => {
    expect(isWeakGroup('phone', '2125550142', ['Jane Doe', ' jane doe '])).toBe(false);
    expect(isWeakGroup('phone', '2125550142', ['Jane Doe', 'Sam Lee'])).toBe(true);
    expect(isWeakGroup('phone', '2125550142', ['Jane Doe', null])).toBe(true);
  });

  it('is never a similar name, which two signs back up', () => {
    expect(isWeakGroup('name', 'jane doe', ['Jane Doe', 'Sam Lee'])).toBe(false);
  });
});

describe('name groups', () => {
  it('puts each contact with the later ones a second sign backs, and says which signs', () => {
    const groups = nameGroupsOf([
      { a: uuid(8), o: uuid(9), company: true, emailName: false, phone: false },
      { a: uuid(1), o: uuid(2), company: true, emailName: false, phone: false },
      { a: uuid(1), o: uuid(3), company: false, emailName: false, phone: false },
      { a: uuid(1), o: uuid(4), company: false, emailName: true, phone: true },
      { a: uuid(5), o: uuid(6), company: false, emailName: false, phone: false },
    ]);
    expect(groups).toEqual([
      {
        anchor: uuid(1),
        ids: [uuid(1), uuid(2), uuid(4)],
        reasons: ['name', 'company', 'email_name', 'phone'],
      },
      { anchor: uuid(8), ids: [uuid(8), uuid(9)], reasons: ['name', 'company'] },
    ]);
  });

  it('keys a group by its first contact’s name, lowercased and trimmed', () => {
    expect(nameKeyOf('  Jane DOE ')).toBe('jane doe');
    expect(nameKeyOf('x'.repeat(400))).toHaveLength(320);
  });
});

describe('a rejected group', () => {
  const rejected = [[uuid(1), uuid(2), uuid(3)]];

  it('stays hidden while every contact in it was rejected together', () => {
    expect(isRejected([uuid(1), uuid(2)], rejected)).toBe(true);
    expect(isRejected([uuid(3), uuid(1), uuid(2)], rejected)).toBe(true);
  });

  it('shows again once another contact joins it', () => {
    expect(isRejected([uuid(1), uuid(2), uuid(4)], rejected)).toBe(false);
    expect(isRejected([uuid(1), uuid(2)], [])).toBe(false);
  });
});
