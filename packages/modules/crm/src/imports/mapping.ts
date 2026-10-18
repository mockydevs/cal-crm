// How a file's columns become a contact: which column a header suggests, which mappings
// can't work, and how each cell is read for what it fills. Everything here is plain
// reading of text: no database, and nothing is written. What a value must be is still
// decided by the same contracts and commands a person's edit goes through (plan.ts,
// apply.ts); this only turns a cell's text into what those take.
import {
  contactImportAttributes,
  importTargetKey,
  type ContactImportAttribute,
  type FieldDefinition,
  type ImportColumnMapping,
  type ImportMode,
  type ImportTarget,
} from '@repo/contracts';
import type { Issue } from '@repo/kernel';

/** A custom field a column can fill: a live contact field, by its public id. */
export type ImportField = Pick<
  FieldDefinition,
  'id' | 'key' | 'label' | 'valueType' | 'options' | 'archived'
>;

/** A cell read for its target: null for an empty cell, which changes nothing. */
export type CellValue = string | boolean | string[] | null;

export interface CellProblem {
  readonly code: string;
  readonly message: string;
}

export type CellReading =
  { readonly value: CellValue; readonly problem?: undefined } | { readonly problem: CellProblem };

/** A header, or a field's name, as headers are compared: letters and digits, lower case. */
export function nameKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// The headers each attribute is known by, as nameKey gives them. They include the column
// names of GoHighLevel's own sample file (its help article "CSV File Format for Importing
// Objects"), so a file exported from there maps itself.
const attributeHeaders: Readonly<Record<ContactImportAttribute, readonly string[]>> = {
  firstName: ['firstname', 'first', 'givenname', 'forename'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  email: ['email', 'emailaddress', 'mail', 'primaryemail'],
  additionalEmails: ['additionalemails', 'additionalemail', 'otheremails', 'secondaryemail'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'cell', 'cellphone', 'telephone'],
  additionalPhones: [
    'additionalphones',
    'additionalphone',
    'additionalphonenumbers',
    'otherphones',
    'secondaryphone',
  ],
  timeZone: ['timezone', 'tz'],
  doNotContact: ['dnd', 'donotdisturb', 'donotcontact'],
  tags: ['tags', 'tag'],
};

/**
 * Whether a column can fill the field. A text box list has a box for each of its options
 * and a file upload field holds files, neither of which one cell can say.
 */
export const importable = (field: Pick<ImportField, 'valueType'>): boolean =>
  field.valueType !== 'text_list' && field.valueType !== 'file';

/** The names a header can call a custom field by: its key, its label and its merge key. */
function fieldHeaders(field: ImportField): string[] {
  const key = nameKey(field.key);
  return [key, nameKey(field.label), `contact${key}`, `contactcustom${key}`];
}

/**
 * A mapping worked out from the header: each column whose header names an attribute or a
 * live custom field, the first such column for each. An attribute comes before a field of
 * the same name. A column nothing is known by is left out, to be mapped by hand or ignored.
 */
export function suggestMapping(
  header: readonly string[],
  fields: readonly ImportField[],
): ImportColumnMapping[] {
  const targets = new Map<string, ImportTarget>();
  for (const attribute of contactImportAttributes)
    for (const name of attributeHeaders[attribute])
      targets.set(name, { kind: 'attribute', attribute });
  for (const field of fields) {
    if (field.archived || !importable(field)) continue;
    for (const name of fieldHeaders(field))
      if (name !== '' && !targets.has(name))
        targets.set(name, { kind: 'field', fieldId: field.id });
  }
  const taken = new Set<string>();
  const mapping: ImportColumnMapping[] = [];
  for (const [column, cell] of header.entries()) {
    const target = targets.get(nameKey(cell));
    if (target === undefined || taken.has(importTargetKey(target))) continue;
    taken.add(importTargetKey(target));
    mapping.push({ column, target });
  }
  return mapping;
}

const mapped = (mapping: readonly ImportColumnMapping[], attribute: ContactImportAttribute) =>
  mapping.some(({ target }) => target.kind === 'attribute' && target.attribute === attribute);

/**
 * Why a mapping can't be imported with, as issues that point into it: a column the file
 * doesn't have, a field that isn't a live contact field of the business, nothing that
 * could say who a row is, or nothing to find an existing contact by when only updating.
 */
export function checkMapping(
  mapping: readonly ImportColumnMapping[],
  options: {
    readonly columns: number;
    readonly fields: readonly ImportField[];
    readonly mode: ImportMode;
  },
): Issue[] {
  const issues: Issue[] = [];
  for (const [index, entry] of mapping.entries()) {
    if (entry.column >= options.columns)
      issues.push({
        path: `/mapping/${String(index)}/column`,
        code: 'column_unknown',
        message: `The file has ${String(options.columns)} columns: there is no column ${String(entry.column + 1)}.`,
      });
    const { target } = entry;
    if (target.kind !== 'field') continue;
    const field = options.fields.find((each) => each.id === target.fieldId);
    if (field === undefined)
      issues.push({
        path: `/mapping/${String(index)}/target/fieldId`,
        code: 'field_unknown',
        message: "This isn't a contact field of this business.",
      });
    else if (field.archived)
      issues.push({
        path: `/mapping/${String(index)}/target/fieldId`,
        code: 'field_archived',
        message: 'This field is archived. Restore it before importing into it.',
      });
    else if (!importable(field))
      issues.push({
        path: `/mapping/${String(index)}/target/fieldId`,
        code: 'field_not_importable',
        message: "A text box list or a file upload field can't be filled from a column.",
      });
  }
  const identifying = (
    ['firstName', 'lastName', 'email', 'additionalEmails', 'phone', 'additionalPhones'] as const
  ).some((attribute) => mapped(mapping, attribute));
  if (!identifying)
    issues.push({
      path: '/mapping',
      code: 'nothing_to_identify',
      message: 'Map a column to a name, an email address or a phone number.',
    });
  const matching = (['email', 'additionalEmails', 'phone', 'additionalPhones'] as const).some(
    (attribute) => mapped(mapping, attribute),
  );
  if (identifying && options.mode === 'update' && !matching)
    issues.push({
      path: '/mapping',
      code: 'nothing_to_match',
      message:
        'To update contacts, map a column to an email address or a phone number: that is how each row finds its contact.',
    });
  return issues;
}

const yes = new Set(['yes', 'y', 'true', 't', '1', 'on']);
const no = new Set(['no', 'n', 'false', 'f', '0', 'off']);

/** A cell's several values: separated by commas or semicolons, each trimmed, none empty. */
function listOf(cell: string, separators: RegExp): string[] {
  return cell
    .split(separators)
    .map((each) => each.trim())
    .filter((each) => each !== '');
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * A phone number or a number as a spreadsheet's owner may have written it to keep it as
 * text: with one apostrophe in front. Nothing else is ever taken off a value.
 */
const withoutTextMark = (cell: string): string => cell.replace(/^'(?=[+\-(\d.])/, '');

const problem = (code: string, message: string): CellReading => ({ problem: { code, message } });

/** A cell read for one of the contact's own attributes. */
export function readAttributeCell(attribute: ContactImportAttribute, text: string): CellReading {
  const cell = text.trim();
  if (cell === '') return { value: null };
  switch (attribute) {
    case 'firstName':
    case 'lastName':
    case 'timeZone':
      return { value: cell };
    case 'email':
      return { value: cell.toLowerCase() };
    case 'additionalEmails': {
      const emails = unique(listOf(cell.toLowerCase(), /[,;\s]+/));
      return { value: emails.length === 0 ? null : emails };
    }
    case 'phone':
      return { value: withoutTextMark(cell) };
    case 'additionalPhones': {
      const phones = unique(listOf(cell, /[,;]+/).map(withoutTextMark));
      return { value: phones.length === 0 ? null : phones };
    }
    case 'tags': {
      const tags = unique(listOf(cell, /[,;]+/));
      return { value: tags.length === 0 ? null : tags };
    }
    case 'doNotContact': {
      const word = cell.toLowerCase();
      if (yes.has(word)) return { value: true };
      // No is not "turn it off": an import never lets someone be messaged again.
      if (no.has(word)) return { value: null };
      return problem('do_not_contact_unreadable', 'Use yes or no for do not contact.');
    }
  }
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
// Thousands marked with commas, as spreadsheets format money: 1,234,567.89.
const GROUPED = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
// Year first, so the day and the month can't be mistaken for each other.
const YEAR_FIRST = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;

/** The option a cell names: by its key or its name, whatever the letter case. */
function optionOf(field: ImportField, cell: string): string | undefined {
  const wanted = cell.toLowerCase();
  return field.options.find(
    (option) =>
      !option.archived &&
      (option.key.toLowerCase() === wanted || option.label.toLowerCase() === wanted),
  )?.key;
}

/** A cell read for a custom field, into the value the field's own command takes. */
export function readFieldCell(field: ImportField, text: string): CellReading {
  const cell = text.trim();
  if (cell === '') return { value: null };
  switch (field.valueType) {
    case 'text':
    case 'long_text':
    case 'url':
      return { value: cell };
    case 'email':
      return { value: cell.toLowerCase() };
    case 'phone':
      return { value: withoutTextMark(cell) };
    case 'number':
    case 'money': {
      const number = withoutTextMark(cell);
      if (DECIMAL.test(number)) return { value: number };
      if (GROUPED.test(number)) return { value: number.replaceAll(',', '') };
      return problem('number_unreadable', 'Enter a number, such as 1250.50.');
    }
    case 'date': {
      const parts = YEAR_FIRST.exec(cell);
      if (parts === null)
        return problem('date_unreadable', 'Enter a date with the year first, such as 2026-10-09.');
      return { value: `${parts[1] ?? ''}-${parts[2] ?? ''}-${parts[3] ?? ''}` };
    }
    case 'datetime':
      return { value: cell };
    case 'boolean': {
      const word = cell.toLowerCase();
      if (yes.has(word)) return { value: true };
      if (no.has(word)) return { value: false };
      return problem('boolean_unreadable', 'Use yes or no.');
    }
    case 'single_choice': {
      const option = optionOf(field, cell);
      return option === undefined
        ? problem('choice_unknown', "This isn't one of the field's choices.")
        : { value: option };
    }
    case 'multi_choice': {
      const options = listOf(cell, /[,;]+/).map((each) => optionOf(field, each));
      const chosen = options.filter((option) => option !== undefined);
      return chosen.length < options.length
        ? problem('choice_unknown', "One of these isn't one of the field's choices.")
        : { value: chosen.length === 0 ? null : unique(chosen) };
    }
    case 'text_list':
    case 'file':
      return problem(
        'field_not_importable',
        "A text box list or a file upload field can't be filled from a column.",
      );
  }
}
