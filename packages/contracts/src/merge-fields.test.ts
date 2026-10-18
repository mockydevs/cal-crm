import { describe, expect, it } from 'vitest';

import {
  contactFieldPaths,
  customValueMergeKey,
  customValuePaths,
  fieldMergeKey,
  mergeKeyFromName,
  mergeToken,
} from './merge-fields.js';
import { contactMergeFields, renderMessageTemplate } from './message-templates.js';

const KEY = /^[a-z][a-z0-9_]{0,62}$/;

describe('a field’s merge key', () => {
  it('starts with the object as GoHighLevel names it', () => {
    expect(fieldMergeKey('contact', 'select_your_fence_type')).toBe(
      'contact.select_your_fence_type',
    );
    expect(fieldMergeKey('deal', 'quote_total')).toBe('opportunity.quote_total');
    expect(fieldMergeKey('company', 'city')).toBe('business.city');
  });

  it('is absent for an object that has no merge fields', () => {
    expect(fieldMergeKey('custom', 'capacity')).toBeNull();
    expect(fieldMergeKey('nothing', 'capacity')).toBeNull();
  });

  it('names a custom object’s field under its object, as GoHighLevel’s custom_objects keys do', () => {
    expect(fieldMergeKey('custom', 'capacity', 'venue')).toBe('custom_objects.venue.capacity');
    expect(fieldMergeKey('deal', 'quote_total', 'deal')).toBe('opportunity.quote_total');
  });

  it.each(['name', 'email', 'phone', 'tags'])(
    'gives a contact field called %s the path that reaches it, not the built-in field’s',
    (key) => {
      expect(contactMergeFields).toContain(`contact.${key}`);
      expect(fieldMergeKey('contact', key)).toBe(`contact.custom.${key}`);
      expect(contactFieldPaths(key)).toEqual([`contact.custom.${key}`]);
    },
  );

  it('does not treat a deal or company field as shadowed by a contact’s built-in fields', () => {
    expect(fieldMergeKey('deal', 'name')).toBe('opportunity.name');
    expect(fieldMergeKey('company', 'email')).toBe('business.email');
  });

  it('is one of the paths a send fills in for a contact, beside the older one', () => {
    expect(contactFieldPaths('event_date')).toEqual([
      'contact.custom.event_date',
      'contact.event_date',
    ]);
    expect(contactFieldPaths('event_date')).toContain(fieldMergeKey('contact', 'event_date'));
  });
});

describe('a custom value’s merge key', () => {
  it('is custom_values.<key>, and the older values.<key> fills in too', () => {
    expect(customValueMergeKey('hours_of_operation')).toBe('custom_values.hours_of_operation');
    expect(customValuePaths('hours_of_operation')).toEqual([
      'custom_values.hours_of_operation',
      'values.hours_of_operation',
    ]);
  });
});

describe('mergeToken', () => {
  it('writes a merge key as the text a template holds, which rendering fills in', () => {
    const key = fieldMergeKey('contact', 'event_date') ?? '';
    expect(mergeToken(key)).toBe('{{contact.event_date}}');
    expect(
      renderMessageTemplate(
        {
          subject: 'S',
          body: `On ${mergeToken(key)}. ${mergeToken(customValueMergeKey('hours'))}`,
        },
        { 'contact.event_date': '2027-06-12', 'custom_values.hours': '9 to 5' },
      ),
    ).toEqual({ ok: true, subject: 'S', body: 'On 2027-06-12. 9 to 5' });
  });
});

describe('mergeKeyFromName', () => {
  it.each([
    ['My Custom Value', 'my_custom_value'],
    ['Hours of operation', 'hours_of_operation'],
    ['  Sample reel URL  ', 'sample_reel_url'],
    ['Select your fence type?', 'select_your_fence_type'],
    ['Budget (KES) - 2027', 'budget_kes_2027'],
    ['Café & Bar', 'cafe_bar'],
    ['already_a_key', 'already_a_key'],
    ['UPPER', 'upper'],
  ])('makes %j into %s', (name, key) => {
    expect(mergeKeyFromName(name, 'value')).toBe(key);
  });

  it.each([
    ['24 hour line', 'value', 'value_24_hour_line'],
    ['24 hour line', 'field', 'field_24_hour_line'],
    ['日本語', 'value', 'value'],
    ['!!!', 'field', 'field'],
    ['', 'value', 'value'],
  ] as const)('starts %j with a letter by putting %s first', (name, fallback, key) => {
    expect(mergeKeyFromName(name, fallback)).toBe(key);
  });

  it('never gives more than 63 characters, and never ends on an underscore', () => {
    expect(mergeKeyFromName('a'.repeat(100), 'value')).toBe('a'.repeat(63));
    expect(mergeKeyFromName(`${'a'.repeat(62)} b`, 'value')).toBe('a'.repeat(62));
    expect(mergeKeyFromName(`9${'a'.repeat(80)}`, 'field')).toBe(`field_9${'a'.repeat(56)}`);
  });

  it('always gives a key the database accepts', () => {
    const names = [
      'My Custom Value',
      '   ',
      '_',
      '__a__',
      '1',
      'é',
      'a\nb\tc',
      '{{contact.email}}',
      'x'.repeat(500),
      `${'-'.repeat(70)}z`,
      'Ünïcödé Nämé',
      '🎉 party 🎉',
    ];
    for (const name of names)
      for (const fallback of ['value', 'field'] as const)
        expect(mergeKeyFromName(name, fallback), JSON.stringify(name)).toMatch(KEY);
  });
});
