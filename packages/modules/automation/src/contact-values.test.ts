// What a contact.update step writes, value by value: no database, so each rule of copying,
// fitting and computing can be read and tested on its own.
import type { AutomationFieldWrite, ConditionValues } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_TARGETS,
  localDate,
  planFieldWrites,
  writesExplanation,
  type TargetField,
} from './contact-values.js';

const CHOICES = [
  { key: 'video', label: 'Video' },
  { key: 'photo', label: 'Photography' },
];
const TARGETS: Readonly<Record<string, TargetField>> = {
  ...BUILT_IN_TARGETS,
  'contact.custom.note': { type: 'text', options: [] },
  'contact.custom.budget': { type: 'number', options: [] },
  'contact.custom.price': { type: 'money', options: [] },
  'contact.custom.day': { type: 'date', options: [] },
  'contact.custom.moment': { type: 'datetime', options: [] },
  'contact.custom.agreed': { type: 'boolean', options: [] },
  'contact.custom.service': { type: 'single_choice', options: CHOICES },
  'contact.custom.interests': { type: 'multi_choice', options: CHOICES },
};

const plan = (
  fields: Record<string, AutomationFieldWrite>,
  values: ConditionValues = {},
  timeZone = 'Africa/Nairobi',
) =>
  planFieldWrites(fields, values, {
    now: new Date('2026-10-12T22:30:00Z'),
    timeZone,
    target: (path) => TARGETS[path],
  });

/** The code and message a refused plan gives. */
function refusal(
  fields: Record<string, AutomationFieldWrite>,
  values: ConditionValues = {},
  timeZone?: string,
): { code: string; message: string; path: string } {
  try {
    plan(fields, values, timeZone);
  } catch (error) {
    if (error instanceof ValidationError) {
      const [issue] = error.issues;
      return { code: issue.code, message: issue.message, path: issue.path };
    }
    throw error;
  }
  throw new Error('The plan was not refused.');
}

describe('fixed values', () => {
  it('are written as they are, whatever the field', () => {
    expect(
      plan({
        'contact.firstName': 'Grace',
        'contact.custom.budget': 120,
        'contact.custom.agreed': true,
        'contact.custom.note': null,
        'contact.custom.unknown': 'kept for the CRM to refuse',
      }),
    ).toEqual({
      writes: {
        'contact.firstName': 'Grace',
        'contact.custom.budget': 120,
        'contact.custom.agreed': true,
        'contact.custom.note': null,
        'contact.custom.unknown': 'kept for the CRM to refuse',
      },
      notes: [],
    });
  });

  it('are written under set as they are alone', () => {
    expect(plan({ 'contact.custom.note': { set: 'Hello' } }).writes).toEqual({
      'contact.custom.note': 'Hello',
    });
  });
});

describe('one field copied into another', () => {
  it('keeps the kind of what it copies', () => {
    const { writes, notes } = plan(
      {
        'contact.custom.note': '{{contact.custom.utm_source}}',
        'contact.custom.price': ' {{ contact.custom.budget }} ',
        'contact.custom.interests': '{{contact.custom.service}}',
        'contact.custom.agreed': '{{contact.custom.other_agreed}}',
        'contact.lastName': '{{contact.tags}}',
      },
      {
        'contact.custom.utm_source': 'facebook',
        'contact.custom.budget': 1500.5,
        'contact.custom.service': ['video'],
        'contact.custom.other_agreed': false,
        'contact.tags': ['VIP', 'Wedding'],
      },
    );
    expect(writes).toEqual({
      'contact.custom.note': 'facebook',
      'contact.custom.price': '1500.5',
      'contact.custom.interests': ['video'],
      'contact.custom.agreed': false,
      'contact.lastName': 'VIP, Wedding',
    });
    expect(notes).toEqual([]);
  });

  it.each([undefined, null, '', '   ', []])(
    'leaves the field alone when the one copied from holds %j',
    (empty) => {
      expect(
        plan(
          { 'contact.custom.note': '{{contact.custom.utm_source}}' },
          empty === undefined ? {} : { 'contact.custom.utm_source': empty },
        ),
      ).toEqual({
        writes: {},
        notes: [
          'contact.custom.utm_source has nothing in it, so contact.custom.note was left as it was.',
        ],
      });
    },
  );

  it('refuses a copy that the field cannot hold', () => {
    expect(
      refusal({ 'contact.custom.budget': '{{contact.firstName}}' }, { 'contact.firstName': 'Ada' }),
    ).toEqual({
      code: 'invalid_value',
      path: '/config/fields/contact.custom.budget',
      message: 'contact.custom.budget takes a number, and the value came out as "Ada".',
    });
  });
});

describe('text with merge fields', () => {
  const values = { 'contact.firstName': 'Ada', 'contact.custom.count': 3 };

  it('is filled in as a message is', () => {
    expect(
      plan(
        { 'contact.custom.note': 'Hi {{contact.firstName}}, {{contact.custom.count}} left' },
        values,
      ).writes,
    ).toEqual({ 'contact.custom.note': 'Hi Ada, 3 left' });
  });

  it('refuses a field with no value rather than leave a gap', () => {
    expect(refusal({ 'contact.custom.note': 'Hi {{contact.lastName}}!' }, values)).toMatchObject({
      code: 'missing_values',
      message: 'There is no value for contact.lastName.',
    });
  });

  it.each([
    ['contact.custom.budget', '{{contact.custom.count}}50', '350'],
    ['contact.custom.budget', ' -{{contact.custom.count}}.25 ', '-3.25'],
    ['contact.custom.agreed', '{{contact.custom.shout}}', true],
    ['contact.custom.agreed', 'n{{contact.custom.letter}}', false],
    ['contact.custom.day', '2026-12-0{{contact.custom.count}}', '2026-12-03'],
    ['contact.custom.day', '2026-12-0{{contact.custom.count}}T23:30:00Z', '2026-12-04'],
    ['contact.custom.moment', '2026-12-0{{contact.custom.count}}', '2026-12-02T21:00:00.000Z'],
    [
      'contact.custom.moment',
      '2026-12-0{{contact.custom.count}}T08:00:00+03:00',
      '2026-12-03T05:00:00.000Z',
    ],
    ['contact.custom.service', 'photo{{contact.custom.tail}}', 'photo'],
    ['contact.custom.interests', 'Video, {{contact.custom.shout}}', undefined],
    ['contact.custom.interests', 'Video, photo{{contact.custom.tail}}', ['video', 'photo']],
    ['contact.email', '{{contact.firstName}}@example.test', 'Ada@example.test'],
  ] as const)('fits %s from %j', (path, text, expected) => {
    const filled = {
      ...values,
      'contact.custom.shout': 'YES',
      'contact.custom.letter': 'o',
      'contact.custom.tail': 'graphy',
    };
    if (expected === undefined) {
      expect(refusal({ [path]: text }, filled).code).toBe('invalid_value');
      return;
    }
    expect(plan({ [path]: text }, filled).writes).toEqual({ [path]: expected });
  });

  it.each([
    ['contact.custom.budget', 'about {{contact.custom.count}}', 'a number'],
    ['contact.custom.agreed', 'maybe {{contact.custom.count}}', 'yes or no (true or false)'],
    ['contact.custom.day', '{{contact.custom.count}} December', 'a date, such as 2026-12-01'],
    ['contact.custom.day', '2026-02-3{{contact.custom.count}}', 'a date, such as 2026-12-01'],
    [
      'contact.custom.moment',
      'at {{contact.custom.count}}',
      'a date and time, such as 2026-12-01T09:00:00Z',
    ],
    [
      'contact.custom.service',
      'Video, Photography {{contact.custom.count}}',
      'one of its choices (Video, Photography)',
    ],
    [
      'contact.custom.interests',
      'Video, Catering {{contact.custom.count}}',
      'its choices (Video, Photography)',
    ],
  ])('refuses %s from %j', (path, text, kind) => {
    const refused = refusal({ [path]: text }, values);
    expect(refused.code).toBe('invalid_value');
    expect(refused.message).toContain(`${path} takes ${kind}, and the value came out as "`);
  });
});

describe('now', () => {
  it("is today on the zone's calendar for a date, and the instant for a date and time", () => {
    expect(
      plan({ 'contact.custom.day': { op: 'now' }, 'contact.custom.moment': { op: 'now' } }).writes,
    ).toEqual({
      'contact.custom.day': '2026-10-13',
      'contact.custom.moment': '2026-10-12T22:30:00.000Z',
    });
    expect(plan({ 'contact.custom.day': { op: 'now' } }, {}, 'America/New_York').writes).toEqual({
      'contact.custom.day': '2026-10-12',
    });
  });

  it('fails when the zone is not one', () => {
    expect(refusal({ 'contact.custom.day': { op: 'now' } }, {}, 'Mars/Olympus').code).toBe(
      'invalid_time_zone',
    );
    expect(localDate(new Date(0), 'Mars/Olympus')).toBeUndefined();
  });
});

describe('a date moved by days', () => {
  it.each([
    [{ op: 'date_add', days: 365 }, '2027-10-13'],
    [{ op: 'date_add', value: 'now', days: -13 }, '2026-09-30'],
    [{ op: 'date_add', value: '2028-02-28', days: 2 }, '2028-03-01'],
    [{ op: 'date_add', value: '2027-02-28', days: 1 }, '2027-03-01'],
    [{ op: 'date_add', value: '2026-12-31T22:00:00Z', days: 0 }, '2027-01-01'],
    [{ op: 'date_add', field: 'contact.custom.booked', days: 30 }, '2026-12-31'],
    [{ op: 'date_add', field: 'contact.custom.seen', days: 1 }, '2026-10-02'],
  ] as const)('%j gives the date %s', (value, expected) => {
    expect(
      plan(
        { 'contact.custom.day': value },
        {
          'contact.custom.booked': '2026-12-01',
          'contact.custom.seen': '2026-10-01T06:00:00.000Z',
        },
      ).writes,
    ).toEqual({ 'contact.custom.day': expected });
  });

  it('gives a date and time its instant, and a day its first moment in the zone', () => {
    expect(
      plan(
        {
          'contact.custom.moment': { op: 'date_add', days: 7 },
        },
        {},
      ).writes,
    ).toEqual({ 'contact.custom.moment': '2026-10-19T22:30:00.000Z' });
    expect(
      plan(
        { 'contact.custom.moment': { op: 'date_add', field: 'contact.custom.booked', days: 1 } },
        { 'contact.custom.booked': '2026-12-01' },
      ).writes,
    ).toEqual({ 'contact.custom.moment': '2026-12-01T21:00:00.000Z' });
  });

  it('fails on a field with no date, or with something that is not one', () => {
    const from = { op: 'date_add', field: 'contact.custom.booked', days: 1 } as const;
    expect(refusal({ 'contact.custom.day': from })).toEqual({
      code: 'missing_values',
      path: '/config/fields/contact.custom.day',
      message: 'contact.custom.booked has no date in it, so there is nothing to count from.',
    });
    expect(
      refusal({ 'contact.custom.day': from }, { 'contact.custom.booked': 'soon' }),
    ).toMatchObject({
      code: 'invalid_operand',
      message: 'contact.custom.booked holds "soon", which is not a date.',
    });
    expect(
      refusal({ 'contact.custom.day': from }, { 'contact.custom.booked': '2026-02-30' }).code,
    ).toBe('invalid_operand');
  });
});

describe('arithmetic', () => {
  const values = {
    'contact.custom.budget': 1000,
    'contact.custom.visits': 4,
    'contact.custom.zero': 0,
    'contact.custom.typed': ' 2.5 ',
    'contact.custom.word': 'many',
  };
  const math = (left: number | string, operator: '+' | '-' | '*' | '/', right: number | string) =>
    ({ op: 'math', left, operator, right }) as const;

  it.each([
    [math('contact.custom.visits', '+', 1), '5'],
    [math('contact.custom.budget', '-', 'contact.custom.visits'), '996'],
    [math('contact.custom.budget', '*', 1.16), '1160'],
    [math('contact.custom.budget', '/', 3), '333.333333'],
    [math(0.1, '+', 0.2), '0.3'],
    [math('contact.custom.typed', '*', 2), '5'],
    [math(10, '-', 25), '-15'],
  ])('%j is %s', (value, expected) => {
    expect(plan({ 'contact.custom.budget': value }, values).writes).toEqual({
      'contact.custom.budget': expected,
    });
  });

  it('fails on a division by zero, on nothing and on what is not a number', () => {
    expect(
      refusal({ 'contact.custom.budget': math(1, '/', 'contact.custom.zero') }, values),
    ).toMatchObject({
      code: 'division_by_zero',
      message: 'contact.custom.zero is 0, and nothing can be divided by zero.',
    });
    expect(refusal({ 'contact.custom.budget': math(1, '/', 0) }, values)).toMatchObject({
      code: 'division_by_zero',
      message: 'The right-hand number is 0, and nothing can be divided by zero.',
    });
    expect(
      refusal({ 'contact.custom.budget': math('contact.custom.gone', '+', 1) }, values),
    ).toMatchObject({
      code: 'missing_values',
      message: 'contact.custom.gone has nothing in it, so there is no number on the left.',
    });
    expect(
      refusal({ 'contact.custom.budget': math(1, '+', 'contact.custom.word') }, values),
    ).toMatchObject({
      code: 'invalid_operand',
      message: 'contact.custom.word holds "many", which is not a number.',
    });
    expect(refusal({ 'contact.custom.budget': math(1e308, '*', 1e308) }, values).code).toBe(
      'invalid_value',
    );
  });
});

describe('only when empty', () => {
  it('writes an empty field and leaves a filled one, saying so', () => {
    const planned = plan(
      {
        'contact.custom.moment': { set: { op: 'now' }, onlyIfEmpty: true },
        'contact.custom.note': { set: 'New', onlyIfEmpty: true },
        'contact.custom.budget': { set: 5, onlyIfEmpty: false },
      },
      { 'contact.custom.note': 'Old', 'contact.custom.budget': 9, 'contact.custom.moment': null },
    );
    expect(planned).toEqual({
      writes: {
        'contact.custom.moment': '2026-10-12T22:30:00.000Z',
        'contact.custom.budget': 5,
      },
      notes: ['contact.custom.note already has a value, so it was left as it was.'],
    });
    expect(writesExplanation(planned, 'Done.', 'Nothing.')).toBe(
      'Done. contact.custom.note already has a value, so it was left as it was.',
    );
    expect(writesExplanation({ writes: {}, notes: [] }, 'Done.', 'Nothing.')).toBe('Nothing.');
  });
});

describe('a field the business does not have', () => {
  it('is refused when its value has to be fitted to it', () => {
    expect(
      refusal({ 'contact.custom.missing': '{{contact.firstName}}' }, { 'contact.firstName': 'A' }),
    ).toEqual({
      code: 'unknown_field',
      path: '/config/fields/contact.custom.missing',
      message: 'contact.custom.missing is not a field.',
    });
  });
});
