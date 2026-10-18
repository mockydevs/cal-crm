// A trigger's filters and an If / else's conditions as rows: a field, how it is compared,
// and with what. The rows are the document's own condition (docs/AUTOMATIONS.md section 3):
// one comparison, or several that must all hold. A condition written another way in the
// JSON view (any of, not, groups inside groups) has no rows, and is shown as it reads.
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  automationOperatorValues,
  type AutomationFieldType,
  type AutomationSetup,
} from '@repo/contracts';
import { attributionFields } from './automation-attribution';
import { isRecord } from './automation-document';
import { durationParts } from './automation-fields';
import { customFieldName, folderHeading } from './automation-summary';
import type { AnswerField } from './automation-answer-field';

export type FilterOperator = keyof typeof automationOperatorValues;

export interface FilterRow {
  /** A field by its path, such as contact.email; empty until one is chosen. */
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string | number | boolean | undefined;
}

export interface FilterField {
  readonly path: string;
  readonly label: string;
  readonly type: AutomationFieldType;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  readonly group: 'standard' | 'custom' | 'opportunity' | 'attribution' | 'submission';
  /**
   * What the field is listed under, where it has a heading: a folder, the opportunity, or
   * the touch it is read from ("Attribution (first)", "This lead's arrival").
   */
  readonly heading?: string | undefined;
}

// As the validator's own table of fields (automations-validate.ts): the test of this file
// checks each one against it, so a field added there and not here fails loudly.
const contactFields: readonly (readonly [string, AutomationFieldType, MessageDescriptor])[] = [
  ['firstName', 'text', msg`First name`],
  ['lastName', 'text', msg`Last name`],
  ['name', 'text', msg`Full name`],
  ['email', 'email', msg`Email`],
  ['phone', 'phone', msg`Phone`],
  ['tags', 'tags', msg`Tag`],
  ['createdAt', 'datetime', msg`Created on`],
  ['updatedAt', 'datetime', msg`Last updated`],
  // What email verification last found of the primary email address; read-only.
  ['emailVerification', 'single_choice', msg`Email verification`],
  ['emailVerified', 'boolean', msg`Email verified`],
];
const dealFields: readonly (readonly [string, AutomationFieldType, MessageDescriptor])[] = [
  ['name', 'text', msg`Opportunity name`],
  ['stage', 'text', msg`Pipeline stage`],
  ['pipeline', 'text', msg`Pipeline`],
  ['status', 'single_choice', msg`Status`],
  // The value under the name people know it by; a draft that wrote deal.amount is the same.
  ['value', 'money', msg`Opportunity value`],
  ['source', 'text', msg`Opportunity source`],
  ['currency', 'text', msg`Currency`],
  ['expectedCloseDate', 'date', msg`Expected close date`],
  ['createdAt', 'datetime', msg`Opportunity created on`],
  ['closedAt', 'datetime', msg`Closed on`],
];
/** Email verification's results, worded as the contact page's badge words them. */
const emailVerifications = [
  { key: 'valid', label: msg`Verified` },
  { key: 'risky', label: msg`Risky` },
  { key: 'invalid', label: msg`Invalid` },
  { key: 'unknown', label: msg`Unknown` },
  { key: 'unchecked', label: msg`Not verified` },
  { key: 'excluded', label: msg`Excluded` },
];
const dealStatuses = [
  { key: 'open', label: msg`Open` },
  { key: 'won', label: msg`Won` },
  { key: 'lost', label: msg`Lost` },
];

/**
 * Every field a row can compare: the contact's, its custom fields, the opportunity's, and
 * where the contact came from (its first and latest touch, and this lead's arrival). In a
 * workflow a form submission starts, the answers of that submission come right after the
 * contact's own fields (automation-trigger-filters.ts).
 */
export function filterFields(
  setup: Pick<AutomationSetup, 'fields'> & {
    readonly answers?: readonly AnswerField[] | undefined;
  },
): FilterField[] {
  const custom = (head: 'contact' | 'deal', group: FilterField['group']): FilterField[] =>
    setup.fields[head].map((field) => ({
      path: `${head}.custom.${field.key}`,
      label: customFieldName(field),
      type: field.type,
      options: field.options,
      group,
      heading: head === 'contact' ? folderHeading(field) : opportunityHeading(),
    }));
  return [
    ...contactFields.map(([key, type, label]) => ({
      path: `contact.${key}`,
      label: i18n._(label),
      type,
      options:
        key === 'emailVerification'
          ? emailVerifications.map((each) => ({ key: each.key, label: i18n._(each.label) }))
          : [],
      group: 'standard' as const,
    })),
    ...(setup.answers ?? []).map((field): FilterField => ({
      ...field,
      group: 'submission',
    })),
    ...custom('contact', 'custom'),
    ...dealFields.map(([key, type, label]) => ({
      path: `deal.${key}`,
      label: i18n._(label),
      type,
      options:
        key === 'status'
          ? dealStatuses.map((status) => ({ key: status.key, label: i18n._(status.label) }))
          : [],
      group: 'opportunity' as const,
      heading: opportunityHeading(),
    })),
    ...custom('deal', 'opportunity'),
    ...attributionFields().map((field): FilterField => ({
      path: field.path,
      label: field.label,
      type: field.type,
      options: field.options,
      group: 'attribution',
      heading: field.heading,
    })),
  ];
}

/**
 * The field a path names. A draft may write a custom field the short way (contact.services
 * for contact.custom.services), or by an alias; both are the same field.
 */
export function fieldAt(
  fields: readonly FilterField[],
  path: string,
  setup: Pick<AutomationSetup, 'fields'>,
): FilterField | undefined {
  const exact = fields.find(
    (field) => field.path === (path === 'deal.amount' ? 'deal.value' : path),
  );
  if (exact !== undefined) return exact;
  const [head, key, more] = path.split('.');
  if ((head !== 'contact' && head !== 'deal') || key === undefined) return undefined;
  const named = more === undefined ? key : key === 'custom' ? more : undefined;
  const custom = setup.fields[head].find(
    (field) => field.key === named || (named !== undefined && field.aliases.includes(named)),
  );
  return custom === undefined
    ? undefined
    : fields.find((field) => field.path === `${head}.custom.${custom.key}`);
}

const always: readonly FilterOperator[] = ['is_set', 'is_empty'];
const sameOrNot: readonly FilterOperator[] = ['equals', 'not_equals'];

/** The comparisons that apply to a field of this type, in the order they are offered. */
export function operatorsFor(type: AutomationFieldType): readonly FilterOperator[] {
  switch (type) {
    case 'tags':
    case 'multi_choice':
      return ['includes', 'excludes', ...always];
    case 'text':
    case 'long_text':
    case 'email':
    case 'url':
      return [...sameOrNot, 'includes', 'excludes', 'starts_with', ...always];
    case 'number':
    case 'money':
      return [...sameOrNot, 'greater_than', 'less_than', ...always];
    case 'date':
    case 'datetime':
      return ['before', 'after', 'within_last', 'within_next', ...always];
    case 'boolean':
      return ['equals', ...always];
    case 'phone':
      return [...sameOrNot, 'starts_with', ...always];
    case 'single_choice':
      return [...sameOrNot, ...always];
  }
}

const operatorNames: Readonly<Record<FilterOperator, MessageDescriptor>> = {
  equals: msg`Is`,
  not_equals: msg`Is not`,
  includes: msg`Contains`,
  excludes: msg`Does not contain`,
  starts_with: msg`Starts with`,
  greater_than: msg`Is greater than`,
  less_than: msg`Is less than`,
  is_set: msg`Is filled in`,
  is_empty: msg`Is empty`,
  before: msg`Is before`,
  after: msg`Is after`,
  within_last: msg`Is in the last`,
  within_next: msg`Is in the next`,
};

const listOperatorNames: Readonly<Record<'includes' | 'excludes', MessageDescriptor>> = {
  includes: msg`Includes`,
  excludes: msg`Does not include`,
};

/**
 * What a comparison is called. A list (tags, several choices) "includes" a value where
 * text "contains" it: the words differ, the stored operator is the same.
 */
export const operatorName = (operator: FilterOperator, type?: AutomationFieldType): string =>
  i18n._(
    (type === 'tags' || type === 'multi_choice') &&
      (operator === 'includes' || operator === 'excludes')
      ? listOperatorNames[operator]
      : operatorNames[operator],
  );

/** What the opportunity's fields are listed under, wherever a field is chosen. */
export function opportunityHeading(): string {
  return i18n._(msg`Opportunity (found or created in this workflow)`);
}

export type ValueKind = 'none' | 'text' | 'number' | 'date' | 'duration' | 'choice' | 'yes_no';

/** What a row's value is typed into: nothing, for a comparison that needs none. */
export function valueKind(field: FilterField | undefined, operator: FilterOperator): ValueKind {
  const takes = automationOperatorValues[operator];
  if (takes === 'none') return 'none';
  if (takes === 'duration') return 'duration';
  if (field === undefined) return 'text';
  if (field.type === 'boolean') return 'yes_no';
  if (field.type === 'date' || field.type === 'datetime') return 'date';
  if ((field.type === 'number' || field.type === 'money') && operator !== 'includes')
    return 'number';
  return field.options.length > 0 ? 'choice' : 'text';
}

/** A new row: no field yet. */
export const emptyRow: FilterRow = { field: '', operator: 'equals', value: undefined };

/** A row after its field changed: the first comparison that applies, and no value. */
export function withField(row: FilterRow, field: FilterField): FilterRow {
  const operators = operatorsFor(field.type);
  const operator = operators.includes(row.operator) ? row.operator : (operators[0] ?? 'equals');
  return { field: field.path, operator, value: undefined };
}

/** A row after its comparison changed: its value kept only when it is still the same kind. */
export function withOperator(
  row: FilterRow,
  operator: FilterOperator,
  field: FilterField | undefined,
): FilterRow {
  const same = valueKind(field, row.operator) === valueKind(field, operator);
  return { ...row, operator, value: same ? row.value : undefined };
}

const operators = Object.keys(automationOperatorValues);
const isOperator = (value: unknown): value is FilterOperator =>
  typeof value === 'string' && operators.includes(value);

function rowOf(condition: unknown): FilterRow | undefined {
  if (!isRecord(condition)) return undefined;
  const { field, operator, value } = condition;
  if (typeof field !== 'string' || !isOperator(operator)) return undefined;
  if (Object.keys(condition).some((key) => !['field', 'operator', 'value'].includes(key)))
    return undefined;
  if (value !== undefined && !['string', 'number', 'boolean'].includes(typeof value))
    return undefined;
  return { field, operator, value: value as FilterRow['value'] };
}

/**
 * A condition as rows: none for no condition, one for a comparison, several for
 * comparisons that must all hold. Nothing for a condition rows can't hold whole.
 */
export function rowsOf(condition: unknown): FilterRow[] | undefined {
  if (condition === undefined) return [];
  const all = isRecord(condition) && Object.keys(condition).length === 1 ? condition['all'] : null;
  if (!Array.isArray(all)) {
    const row = rowOf(condition);
    return row === undefined ? undefined : [row];
  }
  const rows = (all as readonly unknown[]).map(rowOf);
  return rows.every((row) => row !== undefined) ? rows : undefined;
}

/** The rows as the document's condition: nothing for no rows. */
export function conditionOf(rows: readonly FilterRow[]): Record<string, unknown> | undefined {
  const leaves = rows.map((row) =>
    automationOperatorValues[row.operator] === 'none'
      ? { field: row.field, operator: row.operator }
      : { field: row.field, operator: row.operator, value: row.value },
  );
  if (leaves.length === 0) return undefined;
  return leaves.length === 1 ? leaves[0] : { all: leaves };
}

/** What is missing from each row, in its place; nothing for a row that is whole. */
export function rowProblems(
  rows: readonly FilterRow[],
  fields: readonly FilterField[],
  setup: Pick<AutomationSetup, 'fields'>,
): (string | undefined)[] {
  return rows.map((row) => {
    if (row.field === '') return i18n._(msg`Choose a field.`);
    const kind = valueKind(fieldAt(fields, row.field, setup), row.operator);
    if (kind === 'none') return undefined;
    if (row.value === undefined || row.value === '')
      return i18n._(msg`Enter what to compare with.`);
    if (kind === 'duration' && durationParts(row.value) === undefined)
      return i18n._(msg`Enter a whole number of minutes, hours, days or weeks.`);
    return undefined;
  });
}
