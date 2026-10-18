import { describe, expect, it } from 'vitest';

import { isSensitive, mapFields } from './fields.js';

describe('the fields of a form on another website', () => {
  it('fill the contact by name, as GoHighLevel matches a field name to a contact property', () => {
    expect(
      mapFields([
        { name: 'first_name', value: 'Pat' },
        { name: 'last_name', value: 'Lee' },
        { name: 'email', value: ' pat@example.com ' },
        { name: 'phone', value: '+1 415 555 0100' },
        { name: 'message', label: 'How can we help?', value: 'A quote, please.' },
      ]),
    ).toEqual({
      email: 'pat@example.com',
      phone: '+1 415 555 0100',
      firstName: 'Pat',
      lastName: 'Lee',
      kept: [
        { name: 'first_name', value: 'Pat' },
        { name: 'last_name', value: 'Lee' },
        { name: 'email', value: 'pat@example.com' },
        { name: 'phone', value: '+1 415 555 0100' },
        { name: 'message', label: 'How can we help?', value: 'A quote, please.' },
      ],
      unmapped: [{ name: 'message', label: 'How can we help?', value: 'A quote, please.' }],
    });
  });

  it('match WordPress-style names and labels too', () => {
    const mapped = mapFields([
      { name: 'your-name', value: 'Sam Rivera Jones' },
      { name: 'your-email', value: 'sam@example.com' },
      { name: 'input_3', label: 'Mobile', value: '(415) 555-0101' },
    ]);
    expect(mapped).toMatchObject({
      email: 'sam@example.com',
      phone: '(415) 555-0101',
      firstName: 'Sam',
      lastName: 'Rivera Jones',
      unmapped: [],
    });
  });

  it('keep a single full name as the first name', () => {
    expect(mapFields([{ name: 'name', value: 'Cher' }])).toMatchObject({ firstName: 'Cher' });
    expect(mapFields([{ name: 'name', value: 'Cher' }]).lastName).toBeUndefined();
  });

  it('prefer the first and last name to a full name', () => {
    expect(
      mapFields([
        { name: 'name', value: 'Ignored Person' },
        { name: 'fname', value: 'Ana' },
        { name: 'surname', value: 'Diaz' },
      ]),
    ).toMatchObject({
      firstName: 'Ana',
      lastName: 'Diaz',
      unmapped: [{ name: 'name', value: 'Ignored Person' }],
    });
  });

  it('find an email address by its shape when no field is named for one', () => {
    expect(mapFields([{ name: 'contact', value: 'kim@example.org' }]).email).toBe(
      'kim@example.org',
    );
  });

  it('take an email or phone field only when its value is one', () => {
    const mapped = mapFields([
      { name: 'email', value: 'not an address' },
      { name: 'phone', value: 'call me' },
    ]);
    expect(mapped.email).toBeUndefined();
    expect(mapped.phone).toBeUndefined();
    expect(mapped.unmapped).toHaveLength(2);
  });

  it('take the first of two of the same, and leave the second unmapped', () => {
    const mapped = mapFields([
      { name: 'email', value: 'one@example.com' },
      { name: 'email_confirm', value: 'two@example.com' },
    ]);
    expect(mapped.email).toBe('one@example.com');
    expect(mapped.unmapped).toEqual([{ name: 'email_confirm', value: 'two@example.com' }]);
  });

  it('drop empty values and the characters no text holds', () => {
    expect(
      mapFields([
        { name: 'company', value: '   ' },
        { name: 'notes', value: 'a\u0000b' },
      ]).kept,
    ).toEqual([{ name: 'notes', value: 'ab' }]);
  });

  it('never keep a password, a card or an account number, even when the script sent one', () => {
    for (const name of [
      'password',
      'user_pass',
      'pwd',
      'card_number',
      'cc-number',
      'ccnum',
      'credit_card',
      'cvv',
      'CVC',
      'security_code',
      'iban',
      'ssn',
      'social_security',
      'routing_number',
      'account_number',
    ])
      expect(isSensitive({ name, value: 'x' }), name).toBe(true);
    expect(isSensitive({ name: 'x', label: 'Card number', value: '4111' })).toBe(true);
    for (const name of ['email', 'shipping', 'company', 'message', 'accent'])
      expect(isSensitive({ name, value: 'x' }), name).toBe(false);
    expect(mapFields([{ name: 'password', value: 'hunter2' }]).kept).toEqual([]);
  });
});
