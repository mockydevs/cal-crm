import { automationDocument, type FieldDefinition, type ConditionValues } from '@repo/contracts';
import { expect, it } from 'vitest';
import type { FieldNormalizationContext } from '@repo/module-crm';
import { simulateAutomation } from './simulate.js';

function definition(valueType: FieldDefinition['valueType']): FieldDefinition {
  return {
    id: 'field_01h455vb4pex5vsknk084sn02q',
    objectKey: 'contact',
    key: 'preference',
    label: 'Preference',
    description: 'Sanitized preference.',
    valueType,
    currency: null,
    revision: '1',
    archived: false,
    aiFillSources: [],
    aiOverwrite: 'never',
    options: [
      { key: 'active', label: 'Active', description: '', archived: false },
      { key: 'retired', label: 'Retired', description: '', archived: true },
    ],
  };
}

function run(
  field: FieldDefinition,
  value: string | number | boolean | null,
  values: ConditionValues,
  expected: string | number | boolean | null,
  alias = false,
  context: FieldNormalizationContext = {
    definitions: [field],
    aliases: [{ fieldId: field.id, key: 'old_preference' }],
    country: 'KE',
  },
) {
  return simulateAutomation({
    document: automationDocument.parse({
      name: 'Custom field route',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'change',
      steps: {
        change: {
          type: 'contact.update',
          config: { fields: { 'contact.custom.preference': value } },
          next: 'check',
        },
        check: {
          type: 'condition',
          config: {
            if:
              expected === null
                ? { field: 'contact.custom.preference', operator: 'is_empty' }
                : {
                    field: alias ? 'contact.old_preference' : 'contact.custom.preference',
                    operator: field.valueType === 'single_choice' ? 'includes' : 'equals',
                    value: expected,
                  },
          },
          next: { yes: 'matched', no: 'stale' },
        },
        matched: { type: 'wait', config: { duration: 'PT1S' } },
        stale: { type: 'wait', config: { duration: 'PT1S' } },
      },
    }),
    values,
    events: [],
    start: new Date('2031-03-01T09:00:00Z'),
    timeZone: 'UTC',
    enrolmentId: 'sample',
    fields: context,
  });
}

it('refuses an unknown field even when sample values claim it exists', () => {
  const trace = run(
    definition('text'),
    'new',
    { 'contact.custom.preference': 'old' },
    'new',
    false,
    { definitions: [], aliases: [], country: undefined },
  );
  expect(trace.outcome).toEqual({ kind: 'failed', step: 'change', error: 'unknown_field' });
  expect(trace.steps).toEqual([]);
});

it('requires country metadata for a national custom phone', () => {
  const field = definition('phone');
  const trace = run(field, '0712345678', {}, '+254712345678', false, {
    definitions: [field],
    aliases: [],
    country: undefined,
  });
  expect(trace.outcome).toEqual({ kind: 'failed', step: 'change', error: 'phone_country_unknown' });
});

it('never overwrites another real field through a colliding alias', () => {
  const field = definition('text');
  const trace = run(
    field,
    'new',
    { 'contact.old_preference': 'independent' },
    'independent',
    true,
    {
      definitions: [
        field,
        { ...field, id: 'field_01h455vb4pex5vsknk084sn02r', key: 'old_preference' },
      ],
      aliases: [{ fieldId: field.id, key: 'old_preference' }],
      country: undefined,
    },
  );
  expect(trace.outcome).toEqual({ kind: 'completed' });
  expect(trace.steps.map((step) => step.step)).toEqual(['change', 'check', 'matched']);
});

it.each([
  { type: 'email', value: ' GRACE@EXAMPLE.TEST ', expected: 'grace@example.test' },
  { type: 'number', value: 12.5, expected: 12.5 },
  { type: 'datetime', value: '2031-03-01T12:00:00+03:00', expected: '2031-03-01T09:00:00.000Z' },
  { type: 'phone', value: '0712345678', expected: '+254712345678' },
  { type: 'boolean', value: false, expected: false },
  { type: 'single_choice', value: 'active', expected: 'active' },
] as const)(
  'routes using canonical custom $type values and updates aliases',
  ({ type, value, expected }) => {
    const values = Object.freeze({
      'contact.custom.preference': null,
      'contact.old_preference': null,
    });
    const trace = run(definition(type), value, values, expected, true);
    expect(trace.outcome).toEqual({ kind: 'completed' });
    expect(trace.steps.map((step) => step.step)).toEqual(['change', 'check', 'matched']);
    expect(values).toEqual({ 'contact.custom.preference': null, 'contact.old_preference': null });
  },
);

it('keeps a retained archived choice and clears it without changing caller state', () => {
  const values = Object.freeze({ 'contact.custom.preference': Object.freeze(['retired']) });
  expect(
    run(definition('single_choice'), 'retired', values, 'retired').steps.map((step) => step.step),
  ).toEqual(['change', 'check', 'matched']);
  expect(
    run(definition('single_choice'), null, values, null).steps.map((step) => step.step),
  ).toEqual(['change', 'check', 'matched']);
  expect(values['contact.custom.preference']).toEqual(['retired']);
});

it.each([
  { field: definition('single_choice'), value: 'retired', error: 'invalid_choice' },
  { field: definition('number'), value: '1e3', error: 'invalid_format' },
  { field: { ...definition('text'), archived: true }, value: 'new', error: 'conflict' },
])('refuses invalid or archived custom-field writes %#', ({ field, value, error }) => {
  const trace = run(field, value, {}, 'new');
  expect(trace.outcome).toEqual({ kind: 'failed', step: 'change', error });
  expect(trace.steps).toEqual([]);
});
