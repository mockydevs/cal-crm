import { expect, it } from 'vitest';
import { recordField, setRecordFieldInput, confirmRecordFieldInput } from './record-fields.js';
import { listContactsQuery } from './contacts.js';
import { listCompaniesQuery } from './companies.js';
import { dealListQuery } from './deals.js';

const definition = {
  id: 'fld_01h455vb4pex5vsknk084sn02q',
  objectKey: 'contact',
  key: 'budget',
  label: 'Budget',
  description: 'The agreed event budget.',
  valueType: 'money',
  currency: 'KES',
  options: [],
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
  revision: 'a'.repeat(64),
};
const field = {
  definition,
  value: '9007199254740993.25',
  source: { kind: 'user', eventId: null, you: true },
  updatedAt: '2026-10-08T10:00:00Z',
  confidence: null,
  confirmedAt: null,
  revision: 'b'.repeat(64),
};
it('preserves exact decimal strings and rejects values incompatible with the field type', () => {
  expect(recordField.parse(field).value).toBe('9007199254740993.25');
  expect(recordField.safeParse({ ...field, value: 123.25 }).success).toBe(false);
  expect(recordField.safeParse({ ...field, value: 'not a number' }).success).toBe(false);
  expect(recordField.safeParse({ ...field, value: false }).success).toBe(false);
  expect(
    recordField.safeParse({
      ...field,
      definition: { ...definition, valueType: 'date', currency: null },
      value: '2026-02-30',
    }).success,
  ).toBe(false);
});

it.each([
  ['text', 'Some text'],
  ['date', '2026-10-31'],
  ['datetime', '2026-10-31T20:30:00Z'],
  ['boolean', false],
  ['multi_choice', ['garden']],
  ['single_choice', 'garden'],
] as const)('accepts a saved %s value with its source and update time', (valueType, value) => {
  const saved = { ...field, definition: { ...definition, valueType, currency: null }, value };
  expect(recordField.parse(saved).value).toEqual(value);
});
it('represents unset fields with no source, and refuses inconsistent provenance', () => {
  expect(
    recordField.parse({ ...field, value: null, source: null, updatedAt: null }).value,
  ).toBeNull();
  expect(recordField.safeParse({ ...field, source: null }).success).toBe(false);
  expect(recordField.safeParse({ ...field, updatedAt: null }).success).toBe(false);
  expect(recordField.safeParse({ ...field, value: null }).success).toBe(false);
});
it('accepts only trusted writable inputs and human confirmation revisions', () => {
  expect(setRecordFieldInput.parse({ value: false, revision: field.revision })).toEqual({
    value: false,
    revision: field.revision,
  });
  expect(setRecordFieldInput.parse({ value: null, revision: field.revision })).toEqual({
    value: null,
    revision: field.revision,
  });
  for (const property of [
    'source',
    'sourceKind',
    'sourceId',
    'eventId',
    'confirmedAt',
    'confirmedBy',
  ]) {
    expect(
      setRecordFieldInput.safeParse({
        value: 'Remembered',
        revision: field.revision,
        [property]: 'forged',
      }).success,
    ).toBe(false);
    expect(
      confirmRecordFieldInput.safeParse({ revision: field.revision, [property]: 'forged' }).success,
    ).toBe(false);
  }
  expect(
    setRecordFieldInput.safeParse({ value: 'Text', revision: field.revision, confidence: 1.01 })
      .success,
  ).toBe(false);
  expect(setRecordFieldInput.safeParse({ value: 'Text', revision: 'old' }).success).toBe(false);
  expect(confirmRecordFieldInput.parse({ revision: field.revision })).toEqual({
    revision: field.revision,
  });
});
it.each([listContactsQuery, listCompaniesQuery, dealListQuery])(
  'requires complete field filters and a field for sorting',
  (schema) => {
    const fieldId = definition.id;
    for (const invalid of [
      { fieldOperator: 'equals' },
      { fieldValue: '10' },
      { fieldId },
      { fieldId, fieldOperator: 'equals' },
      { fieldId, fieldOperator: 'is_unset', fieldValue: '10' },
      { fieldOrder: 'desc' },
    ])
      expect(schema.safeParse(invalid).success).toBe(false);
    expect(schema.safeParse({ fieldId, fieldOperator: 'is_set' }).success).toBe(true);
    expect(
      schema.safeParse({
        fieldId,
        fieldOperator: 'equals',
        fieldValue: '9007199254740993.25',
        sortField: fieldId,
        fieldOrder: 'desc',
      }).success,
    ).toBe(true);
  },
);
