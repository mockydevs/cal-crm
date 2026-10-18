// The words Custom Fields uses for what the API names by key: a field's type, under
// GoHighLevel's names where it has the type, and who or what created a field.
import { useLingui } from '@lingui/react/macro';
import type { CustomField, DocumentFormat, FieldDefinition } from '@repo/contracts';

/**
 * A field's type as the type picker and the list name it: the API's value types, and
 * GoHighLevel's Radio select and Checkbox, which are a single and a multiple choice shown
 * as radio buttons and checkboxes.
 */
export type FieldKind = FieldDefinition['valueType'] | 'radio' | 'checkbox';

/** The type picker's order: GoHighLevel's first, then the types this product adds. */
export const fieldKinds: readonly FieldKind[] = [
  'text',
  'long_text',
  'text_list',
  'number',
  'phone',
  'money',
  'single_choice',
  'multi_choice',
  'radio',
  'checkbox',
  'date',
  'file',
  'datetime',
  'boolean',
  'email',
  'url',
];

/** The kind a field is, from its type and how its choices are shown. */
export function kindOf(field: Pick<FieldDefinition, 'valueType' | 'display'>): FieldKind {
  if (field.valueType === 'single_choice' && field.display === 'radio') return 'radio';
  if (field.valueType === 'multi_choice' && field.display === 'checkbox') return 'checkbox';
  return field.valueType;
}

/** The value type and choice display a kind is made with. */
export function typeOfKind(kind: FieldKind): {
  readonly valueType: FieldDefinition['valueType'];
  readonly display?: 'radio' | 'checkbox';
} {
  if (kind === 'radio') return { valueType: 'single_choice', display: 'radio' };
  if (kind === 'checkbox') return { valueType: 'multi_choice', display: 'checkbox' };
  return { valueType: kind };
}

export function useFieldTypeNames(): Readonly<Record<FieldKind, string>> {
  const { t } = useLingui();
  return {
    text: t`Single line`,
    long_text: t`Multi line`,
    text_list: t`Text box list`,
    number: t`Number`,
    money: t`Monetary`,
    date: t`Date picker`,
    datetime: t`Date and time`,
    boolean: t`Yes or no`,
    single_choice: t`Dropdown (single)`,
    multi_choice: t`Dropdown (multiple)`,
    radio: t`Radio select`,
    checkbox: t`Checkbox`,
    email: t`Email`,
    phone: t`Phone`,
    url: t`URL`,
    file: t`File upload`,
  };
}

export function useFieldSourceNames(): Readonly<Record<CustomField['source'], string>> {
  const { t } = useLingui();
  return {
    user: t`A person`,
    ai_agent: t`The assistant`,
    automation: t`An automation`,
    api_key: t`An API key`,
    system: t`The system`,
    contact: t`A contact`,
    form: t`A form`,
    import: t`An import`,
  };
}

/** Every kind of actor the Source filter can ask for: the keys of the names above. */
export const fieldSources: readonly CustomField['source'][] = [
  'user',
  'ai_agent',
  'automation',
  'api_key',
  'system',
  'contact',
  'form',
  'import',
];

/** The types whose empty input can show a hint. */
export const placeholderTypes: readonly FieldDefinition['valueType'][] = [
  'text',
  'long_text',
  'number',
  'email',
  'phone',
  'url',
];

/** A document format as people write it. */
export const formatNames: Readonly<Record<DocumentFormat, string>> = {
  pdf: 'PDF',
  doc: 'DOC',
  docx: 'DOCX',
  jpg: 'JPG',
  png: 'PNG',
  gif: 'GIF',
  csv: 'CSV',
  xls: 'XLS',
  xlsx: 'XLSX',
};
