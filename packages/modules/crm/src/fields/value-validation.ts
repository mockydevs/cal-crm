import { parseInput, textListValue, type RecordField, type FieldDefinition } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ValidationError } from '@repo/kernel';
import * as z from 'zod';
import type { CountryCode } from 'libphonenumber-js';
import { normalizePhone } from '../contacts/phones.js';
import { countryOf } from '../contacts/country.js';
type FieldValue = RecordField['value'];

export async function validateFieldValue(
  trx: DatabaseTransaction,
  definition: FieldDefinition,
  value: FieldValue,
  current: FieldValue,
  businessId: string,
): Promise<FieldValue> {
  const country =
    definition.valueType === 'phone' && value !== null
      ? await countryOf(trx, businessId)
      : undefined;
  return normalizeFieldValue(definition, value, current, country);
}

/** Canonical value rules shared by writes and simulations with authoritative metadata. */
export function normalizeFieldValue(
  definition: FieldDefinition,
  value: FieldValue,
  current: FieldValue,
  country: CountryCode | undefined,
): FieldValue {
  // Set or cleared, a file upload field's value is its files: never written here.
  if (definition.valueType === 'file')
    throw new ValidationError([
      {
        path: '/value',
        code: 'files_by_upload',
        message: "A file upload field's files are uploaded to the record and deleted there.",
      },
    ]);
  if (value === null) return null;
  if (definition.valueType === 'text_list') return textListOf(definition, value, current);
  let schema: z.ZodType<FieldValue>;
  switch (definition.valueType) {
    case 'number':
    case 'money':
      schema = z
        .string()
        .max(1000)
        .regex(/^-?\d+(?:\.\d+)?$/);
      break;
    case 'date':
      schema = z.iso
        .date()
        .refine((date) => !date.startsWith('0000-'), 'Use a year from 0001 onwards.');
      break;
    case 'datetime':
      schema = z.iso
        .datetime({ offset: true })
        .refine((date) => !date.startsWith('0000-'), 'Use a year from 0001 onwards.');
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'email':
      schema = z.string().trim().toLowerCase().max(320).regex(z.regexes.email);
      break;
    case 'url':
      schema = z.url({ protocol: /^https?$/ }).max(2000);
      break;
    case 'phone':
      schema = z.string().trim().max(40);
      break;
    case 'text':
      schema = z.string().max(1000);
      break;
    case 'long_text':
      schema = z.string().max(100000);
      break;
    case 'single_choice':
      schema = z.string();
      break;
    case 'multi_choice':
      schema = z
        .array(z.string())
        .min(1)
        .max(100)
        .refine(
          (choices) => new Set(choices).size === choices.length,
          'Use each choice only once.',
        );
      break;
  }
  const normalized = parseInput(z.strictObject({ value: schema }), { value }).value;
  if (definition.valueType === 'phone' && typeof normalized === 'string') {
    const phone = normalizePhone(normalized, country);
    if (typeof phone !== 'string') throw new ValidationError([{ path: '/value', ...phone }]);
    return phone;
  }
  if (definition.valueType === 'single_choice' || definition.valueType === 'multi_choice') {
    const selected = Array.isArray(normalized)
      ? normalized
      : typeof normalized === 'string'
        ? [normalized]
        : [];
    const previous = Array.isArray(current)
      ? current
      : typeof current === 'string'
        ? [current]
        : [];
    if (
      selected.some(
        (key) =>
          !definition.options.some(
            (option) => option.key === key && (!option.archived || previous.includes(key)),
          ),
      )
    )
      throw new ValidationError([
        {
          path: '/value',
          code: 'invalid_choice',
          message: 'Choose an active option from this field.',
        },
      ]);
  }
  return normalized;
}

/**
 * A text box list's value: some text for each of the boxes given, by option key, at most
 * 1,000 characters a box. A box left empty is left out, and a list with every box empty is
 * no value. A box whose option is archived keeps its text only when it already had some.
 */
function textListOf(
  definition: FieldDefinition,
  value: FieldValue,
  current: FieldValue,
): FieldValue {
  const boxes = parseInput(
    z.strictObject({ value: textListValue.pipe(z.record(z.string(), z.string().max(1000))) }),
    { value },
  ).value;
  const previous =
    current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const filled = Object.entries(boxes).filter(([, text]) => text.trim() !== '');
  for (const [key] of filled)
    if (
      !definition.options.some(
        (option) => option.key === key && (!option.archived || Object.hasOwn(previous, key)),
      )
    )
      throw new ValidationError([
        {
          path: `/value/${key}`,
          code: 'invalid_box',
          message: "Fill in this field's own boxes.",
        },
      ]);
  return filled.length === 0 ? null : Object.fromEntries(filled);
}
