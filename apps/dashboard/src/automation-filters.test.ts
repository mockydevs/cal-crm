import { i18n } from '@lingui/core';
import { validateAutomation } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { harborSetup, welcome } from '../e2e/automation-fixtures';
import {
  conditionOf,
  emptyRow,
  fieldAt,
  filterFields,
  operatorName,
  operatorsFor,
  opportunityHeading,
  rowProblems,
  rowsOf,
  valueKind,
  withField,
  withOperator,
  type FilterField,
  type FilterRow,
} from './automation-filters';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const setup = {
  ...harborSetup,
  fields: {
    contact: [
      ...harborSetup.fields.contact,
      { key: 'budget', aliases: ['spend'], type: 'number' as const, options: [] },
      { key: 'newsletter', aliases: [], type: 'boolean' as const, options: [] },
    ],
    deal: [{ key: 'venue_size', aliases: [], type: 'number' as const, options: [] }],
  },
};
const fields = (): FilterField[] => filterFields(setup);
const field = (path: string): FilterField => {
  const found = fields().find((each) => each.path === path);
  if (found === undefined) throw new Error(`No field at ${path}.`);
  return found;
};

/** A value of the kind a row for this field and comparison holds. */
function sample(of: FilterField, row: FilterRow): FilterRow['value'] {
  const kind = valueKind(of, row.operator);
  if (kind === 'none') return undefined;
  if (kind === 'duration') return 'P7D';
  if (kind === 'number') return 5;
  if (kind === 'date') return '2026-12-01';
  if (kind === 'yes_no') return true;
  return kind === 'choice' ? of.options[0]?.key : 'x';
}

describe('the fields a filter can compare', () => {
  it('names a custom field as the business does, under its folder or the opportunity', () => {
    const forms = { id: 'ffld_forms', name: 'Form answers' };
    const named = filterFields({
      fields: {
        contact: [
          {
            key: 'diet',
            aliases: [],
            type: 'text',
            options: [],
            label: 'Dietary needs',
            folder: forms,
          },
          { key: 'utm_source', aliases: [], type: 'text', options: [], label: '' },
        ],
        deal: [
          {
            key: 'deposit',
            aliases: [],
            type: 'number',
            options: [],
            label: 'Deposit paid',
            folder: forms,
          },
        ],
      },
    });
    expect(
      named
        .filter((each) => each.path.includes('.custom.') || each.path === 'contact.email')
        .map((each) => [each.label, each.heading]),
    ).toEqual([
      ['Email', undefined],
      ['Dietary needs', 'Contact: Form answers'],
      ['Utm source', undefined],
      ['Deposit paid', 'Opportunity (found or created in this workflow)'],
    ]);
  });

  it("lists the contact's own, its custom fields, then the opportunity's, each named", () => {
    expect(
      fields()
        .filter((each) => each.group !== 'attribution')
        .map((each) => [each.group, each.path, each.label]),
    ).toEqual([
      ['standard', 'contact.firstName', 'First name'],
      ['standard', 'contact.lastName', 'Last name'],
      ['standard', 'contact.name', 'Full name'],
      ['standard', 'contact.email', 'Email'],
      ['standard', 'contact.phone', 'Phone'],
      ['standard', 'contact.tags', 'Tag'],
      ['standard', 'contact.createdAt', 'Created on'],
      ['standard', 'contact.updatedAt', 'Last updated'],
      ['standard', 'contact.emailVerification', 'Email verification'],
      ['standard', 'contact.emailVerified', 'Email verified'],
      ['custom', 'contact.custom.services', 'Services'],
      ['custom', 'contact.custom.budget', 'Budget'],
      ['custom', 'contact.custom.newsletter', 'Newsletter'],
      ['opportunity', 'deal.name', 'Opportunity name'],
      ['opportunity', 'deal.stage', 'Pipeline stage'],
      ['opportunity', 'deal.pipeline', 'Pipeline'],
      ['opportunity', 'deal.status', 'Status'],
      ['opportunity', 'deal.value', 'Opportunity value'],
      ['opportunity', 'deal.source', 'Opportunity source'],
      ['opportunity', 'deal.currency', 'Currency'],
      ['opportunity', 'deal.expectedCloseDate', 'Expected close date'],
      ['opportunity', 'deal.createdAt', 'Opportunity created on'],
      ['opportunity', 'deal.closedAt', 'Closed on'],
      ['opportunity', 'deal.custom.venue_size', 'Venue size'],
    ]);
  });

  it('offers nothing the engine would refuse: every field with every comparison it is given passes the checks', () => {
    for (const each of fields())
      for (const operator of operatorsFor(each.type)) {
        const row = withOperator(withField(emptyRow, each), operator, each);
        const condition = conditionOf([{ ...row, value: sample(each, row) }]);
        const result = validateAutomation(
          {
            ...welcome,
            triggers: [{ ...welcome.triggers[0], if: condition }],
          },
          setup,
        );
        expect([each.path, operator, result.errors]).toEqual([each.path, operator, []]);
      }
  });

  it("offers email verification's six results, as the contact page words them, and yes or no for verified", () => {
    const verification = field('contact.emailVerification');
    expect(verification.type).toBe('single_choice');
    expect(verification.options).toEqual([
      { key: 'valid', label: 'Verified' },
      { key: 'risky', label: 'Risky' },
      { key: 'invalid', label: 'Invalid' },
      { key: 'unknown', label: 'Unknown' },
      { key: 'unchecked', label: 'Not verified' },
      { key: 'excluded', label: 'Excluded' },
    ]);
    expect(operatorsFor(verification.type)).toEqual(['equals', 'not_equals', 'is_set', 'is_empty']);
    const verified = field('contact.emailVerified');
    expect([verified.type, verified.options]).toEqual(['boolean', []]);
  });

  it('finds a custom field written the short way, in full, or by an alias', () => {
    const budget = field('contact.custom.budget');
    expect(fieldAt(fields(), 'contact.custom.budget', setup)).toEqual(budget);
    expect(fieldAt(fields(), 'contact.budget', setup)).toEqual(budget);
    expect(fieldAt(fields(), 'contact.spend', setup)).toEqual(budget);
    expect(fieldAt(fields(), 'deal.venue_size', setup)?.path).toBe('deal.custom.venue_size');
    expect(fieldAt(fields(), 'contact.email', setup)?.label).toBe('Email');
    // The value under its older name is the same field.
    expect(fieldAt(fields(), 'deal.amount', setup)?.path).toBe('deal.value');
  });

  it('finds nothing for a path that names no field', () => {
    expect(fieldAt(fields(), 'contact.shoe_size', setup)).toBeUndefined();
    expect(fieldAt(fields(), 'company.name', setup)).toBeUndefined();
    expect(fieldAt(fields(), 'contact', setup)).toBeUndefined();
    expect(fieldAt(fields(), 'contact.other.budget', setup)).toBeUndefined();
  });
});

describe('how a field is compared', () => {
  it('offers the comparisons that apply to its type', () => {
    expect(operatorsFor('tags')).toEqual(['includes', 'excludes', 'is_set', 'is_empty']);
    expect(operatorsFor('multi_choice')).toEqual(operatorsFor('tags'));
    expect(operatorsFor('email')).toEqual([
      'equals',
      'not_equals',
      'includes',
      'excludes',
      'starts_with',
      'is_set',
      'is_empty',
    ]);
    expect(operatorsFor('money')).toEqual([
      'equals',
      'not_equals',
      'greater_than',
      'less_than',
      'is_set',
      'is_empty',
    ]);
    expect(operatorsFor('datetime')).toEqual([
      'before',
      'after',
      'within_last',
      'within_next',
      'is_set',
      'is_empty',
    ]);
    expect(operatorsFor('boolean')).toEqual(['equals', 'is_set', 'is_empty']);
    expect(operatorsFor('phone')).toEqual([
      'equals',
      'not_equals',
      'starts_with',
      'is_set',
      'is_empty',
    ]);
    expect(operatorsFor('single_choice')).toEqual(['equals', 'not_equals', 'is_set', 'is_empty']);
  });

  it('names each comparison in words', () => {
    expect(operatorsFor('datetime').map((each) => operatorName(each))).toEqual([
      'Is before',
      'Is after',
      'Is in the last',
      'Is in the next',
      'Is filled in',
      'Is empty',
    ]);
    expect(
      operatorsFor('money')
        .slice(0, 4)
        .map((each) => operatorName(each, 'money')),
    ).toEqual(['Is', 'Is not', 'Is greater than', 'Is less than']);
    // Text contains; a list includes. What the document stores is the same operator.
    for (const type of [undefined, 'text', 'email', 'url', 'long_text'] as const)
      expect((['includes', 'excludes'] as const).map((each) => operatorName(each, type))).toEqual([
        'Contains',
        'Does not contain',
      ]);
    for (const type of ['tags', 'multi_choice'] as const) {
      expect((['includes', 'excludes'] as const).map((each) => operatorName(each, type))).toEqual([
        'Includes',
        'Does not include',
      ]);
      expect(operatorName('is_set', type)).toBe('Is filled in');
    }
    expect(opportunityHeading()).toBe('Opportunity (found or created in this workflow)');
  });

  it('says what the value is typed into', () => {
    expect(valueKind(field('contact.email'), 'is_set')).toBe('none');
    expect(valueKind(field('contact.createdAt'), 'within_last')).toBe('duration');
    expect(valueKind(field('contact.createdAt'), 'before')).toBe('date');
    expect(valueKind(field('contact.custom.budget'), 'greater_than')).toBe('number');
    expect(valueKind(field('contact.custom.newsletter'), 'equals')).toBe('yes_no');
    expect(valueKind(field('contact.custom.services'), 'includes')).toBe('choice');
    expect(valueKind(field('deal.status'), 'equals')).toBe('choice');
    expect(valueKind(field('contact.email'), 'includes')).toBe('text');
    // A field this business no longer has: whatever was written is kept as text.
    expect(valueKind(undefined, 'equals')).toBe('text');
  });

  it('starts a row again when its field changes, keeping a comparison that still applies', () => {
    const row: FilterRow = { field: 'contact.email', operator: 'includes', value: 'gmail' };
    expect(withField(row, field('contact.tags'))).toEqual({
      field: 'contact.tags',
      operator: 'includes',
      value: undefined,
    });
    expect(withField(row, field('contact.createdAt'))).toEqual({
      field: 'contact.createdAt',
      operator: 'before',
      value: undefined,
    });
  });

  it('keeps the value when the comparison changes only if it is still of the same kind', () => {
    const email = field('contact.email');
    const row: FilterRow = { field: email.path, operator: 'equals', value: 'a@b.example' };
    expect(withOperator(row, 'not_equals', email).value).toBe('a@b.example');
    expect(withOperator(row, 'is_empty', email).value).toBeUndefined();
    const created = field('contact.createdAt');
    const before: FilterRow = { field: created.path, operator: 'before', value: '2026-12-01' };
    expect(withOperator(before, 'after', created).value).toBe('2026-12-01');
    expect(withOperator(before, 'within_next', created).value).toBeUndefined();
  });
});

describe('rows and the condition the document keeps', () => {
  const tagged: FilterRow = { field: 'contact.tags', operator: 'includes', value: 'VIP' };
  const hasEmail: FilterRow = { field: 'contact.email', operator: 'is_set', value: undefined };

  it('reads no condition as no rows, one comparison as one, and "all of" as several', () => {
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf({ field: 'contact.tags', operator: 'includes', value: 'VIP' })).toEqual([tagged]);
    expect(
      rowsOf({
        all: [
          { field: 'contact.tags', operator: 'includes', value: 'VIP' },
          { field: 'contact.email', operator: 'is_set' },
        ],
      }),
    ).toEqual([tagged, hasEmail]);
  });

  it('has no rows for a condition they cannot hold whole', () => {
    expect(rowsOf({ any: [{ field: 'contact.email', operator: 'is_set' }] })).toBeUndefined();
    expect(rowsOf({ not: { field: 'contact.email', operator: 'is_set' } })).toBeUndefined();
    expect(
      rowsOf({ all: [{ any: [{ field: 'contact.email', operator: 'is_set' }] }] }),
    ).toBeUndefined();
    expect(rowsOf({ field: 'contact.email', operator: 'sounds_like', value: 'x' })).toBeUndefined();
    expect(rowsOf({ field: 7, operator: 'equals', value: 'x' })).toBeUndefined();
    expect(rowsOf({ field: 'contact.email', operator: 'equals', value: ['x'] })).toBeUndefined();
    expect(
      rowsOf({ field: 'contact.email', operator: 'equals', value: 'x', note: 'mine' }),
    ).toBeUndefined();
    expect(rowsOf('contact.email')).toBeUndefined();
    expect(rowsOf({ all: [], other: 1 })).toBeUndefined();
  });

  it('writes the rows back as the same condition', () => {
    expect(conditionOf([])).toBeUndefined();
    expect(conditionOf([tagged])).toEqual({
      field: 'contact.tags',
      operator: 'includes',
      value: 'VIP',
    });
    const both = {
      all: [
        { field: 'contact.tags', operator: 'includes', value: 'VIP' },
        { field: 'contact.email', operator: 'is_set' },
      ],
    };
    expect(conditionOf([tagged, hasEmail])).toEqual(both);
    expect(rowsOf(conditionOf(rowsOf(both) ?? []))).toEqual([tagged, hasEmail]);
  });

  it('says what each row still lacks, in its place', () => {
    expect(
      rowProblems(
        [
          emptyRow,
          hasEmail,
          { field: 'contact.tags', operator: 'includes', value: undefined },
          { field: 'contact.tags', operator: 'includes', value: '' },
          tagged,
          { field: 'contact.createdAt', operator: 'within_last', value: 'P1Y2M' },
          { field: 'contact.createdAt', operator: 'within_last', value: 'P7D' },
          { field: 'contact.shoe_size', operator: 'equals', value: '44' },
        ],
        fields(),
        setup,
      ),
    ).toEqual([
      'Choose a field.',
      undefined,
      'Enter what to compare with.',
      'Enter what to compare with.',
      undefined,
      'Enter a whole number of minutes, hours, days or weeks.',
      undefined,
      undefined,
    ]);
  });
});
