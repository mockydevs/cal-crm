import type { FieldDefinition } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { normalizeFieldValue } from './value-validation.js';

function field(valueType: FieldDefinition['valueType']): FieldDefinition {
  return {
    id: 'field_01h455vb4pex5vsknk084sn02q',
    objectKey: 'contact',
    key: 'preference',
    label: 'Preference',
    description: 'A sanitized test preference.',
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

describe('canonical field normalization without database access', () => {
  it('normalizes email and Kenyan national phone numbers', () => {
    expect(normalizeFieldValue(field('email'), ' ADA@EXAMPLE.TEST ', null, undefined)).toBe(
      'ada@example.test',
    );
    expect(normalizeFieldValue(field('phone'), '0712345678', null, 'KE')).toBe('+254712345678');
  });
  it('refuses a national phone when the business country is unknown', () => {
    expect(() => normalizeFieldValue(field('phone'), '0712345678', null, undefined)).toThrow(
      ValidationError,
    );
  });
  it('keeps an already selected archived choice but refuses a new selection', () => {
    expect(normalizeFieldValue(field('single_choice'), 'retired', 'retired', undefined)).toBe(
      'retired',
    );
    expect(() =>
      normalizeFieldValue(field('single_choice'), 'retired', 'active', undefined),
    ).toThrow('Choose an active option from this field.');
  });
  it('preserves archived multi-choice values only when already selected', () => {
    expect(
      normalizeFieldValue(field('multi_choice'), ['retired', 'active'], ['retired'], undefined),
    ).toEqual(['retired', 'active']);
    expect(() =>
      normalizeFieldValue(field('multi_choice'), ['retired'], ['active'], undefined),
    ).toThrow(ValidationError);
    expect(() =>
      normalizeFieldValue(field('multi_choice'), ['active', 'active'], null, undefined),
    ).toThrow(ValidationError);
  });
  it('clears any field without requiring phone country or choice membership', () => {
    expect(normalizeFieldValue(field('phone'), null, '+254712345678', undefined)).toBeNull();
    expect(normalizeFieldValue(field('single_choice'), null, 'retired', undefined)).toBeNull();
  });
  it('refuses non-decimal numbers and year zero dates', () => {
    expect(() => normalizeFieldValue(field('number'), '1e3', null, undefined)).toThrow(
      ValidationError,
    );
    expect(normalizeFieldValue(field('money'), '-12.50', null, undefined)).toBe('-12.50');
    expect(() => normalizeFieldValue(field('date'), '0000-01-01', null, undefined)).toThrow(
      ValidationError,
    );
  });
});

describe('a text box list and a file upload field', () => {
  it("keeps the text of the field's own boxes and leaves empty ones out", () => {
    expect(
      normalizeFieldValue(field('text_list'), { active: 'Ann', retired: '' }, null, undefined),
    ).toEqual({ active: 'Ann' });
    expect(normalizeFieldValue(field('text_list'), { active: '  ' }, null, undefined)).toBeNull();
  });
  it('keeps an archived box only where it already held text', () => {
    expect(() =>
      normalizeFieldValue(field('text_list'), { retired: 'New' }, null, undefined),
    ).toThrow(ValidationError);
    expect(
      normalizeFieldValue(field('text_list'), { retired: 'Kept' }, { retired: 'Old' }, undefined),
    ).toEqual({ retired: 'Kept' });
  });
  it('refuses a box it does not have, text over 1,000 characters, and anything but boxes', () => {
    for (const value of [{ other: 'x' }, { active: 'x'.repeat(1001) }, 'text', ['active']])
      expect(() => normalizeFieldValue(field('text_list'), value, null, undefined)).toThrow(
        ValidationError,
      );
  });
  it("never takes a file upload field's value: its files are uploaded and deleted", () => {
    expect(() =>
      normalizeFieldValue(field('file'), ['file_01h455vb4pex5vsknk084sn02q'], null, undefined),
    ).toThrow(ValidationError);
    // Clearing it too: its files would stay on the record, out of its value.
    expect(() => normalizeFieldValue(field('file'), null, null, undefined)).toThrow(
      ValidationError,
    );
  });
});
