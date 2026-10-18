// The rules behind the forms that change records (automation-record-fields.tsx): who an
// Assign owner step gives a contact to, what an Update contact step writes to each field,
// which opportunity a Find opportunity step looks for, and what an Update opportunity step
// changes. Each reads what the document holds into rows a person can edit, and writes the
// rows back as the contract's own shapes (docs/AUTOMATIONS.md section 3). Anything a row
// cannot hold whole is kept exactly as it was written, and edited in the JSON view.
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { AutomationFieldType, AutomationSetup } from '@repo/contracts';
import {
  attributionFields,
  attributionGroups,
  type AttributionGroup,
} from './automation-attribution';
import { scopeHeadings } from './automation-attribution-words';
import { isRecord } from './automation-document';
import { customFieldName, folderHeading } from './automation-summary';
import type { AnswerField } from './automation-submission';

type Config = Readonly<Record<string, unknown>>;
type Fields = Pick<AutomationSetup, 'fields'>;

/* ---------------------------------------------------------------- team members */

export interface Members {
  /** The members chosen, by id, in the order they take turns. */
  readonly ids: readonly string[];
  /** What the step names that the team doesn't have: kept in sight until taken off. */
  readonly unknown: readonly string[];
}

/** Who an Assign owner step names: one member (`user`) or several in turn (`users`). */
export function membersOf(
  config: Config,
  users: readonly { readonly id: string; readonly name: string }[],
): Members {
  const given: readonly unknown[] = Array.isArray(config['users'])
    ? (config['users'] as readonly unknown[])
    : [config['user']];
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const each of given) {
    if (typeof each !== 'string' || each === '') continue;
    const wanted = each.trim().toLowerCase();
    // A draft may name a member by what people call them; the document keeps the id.
    const named = users.filter((user) => user.name.trim().toLowerCase() === wanted);
    const member =
      users.find((user) => user.id === each) ?? (named.length === 1 ? named[0] : undefined);
    if (member === undefined) unknown.push(each);
    else if (!ids.includes(member.id)) ids.push(member.id);
  }
  return { ids, unknown };
}

/** The two members of the settings that name people: one as `user`, several as `users`. */
export function membersWritten(chosen: readonly string[]): {
  readonly user: string | undefined;
  readonly users: string[] | undefined;
} {
  return {
    user: chosen.length === 1 ? chosen[0] : undefined,
    users: chosen.length > 1 ? [...chosen] : undefined,
  };
}

/* ---------------------------------------------------------------- fields to pick */

export type SourceGroup =
  'contact' | 'custom' | 'opportunity' | AttributionGroup | 'values' | 'submission';

export interface FieldChoice {
  readonly path: string;
  readonly label: string;
  readonly type: AutomationFieldType;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  readonly group: SourceGroup;
  /** For a contact's custom field in a folder: the heading it is listed under. */
  readonly heading?: string | undefined;
}

type BuiltIn = readonly [key: string, type: AutomationFieldType, label: MessageDescriptor];

// The contact's own fields a step may write (the validator's table, less what it marks as
// read-only), and those a value can be read from.
const writableContact: readonly BuiltIn[] = [
  ['firstName', 'text', msg`First name`],
  ['lastName', 'text', msg`Last name`],
  ['email', 'email', msg`Email`],
  ['phone', 'phone', msg`Phone`],
];
const readableContact: readonly BuiltIn[] = [
  ...writableContact,
  ['name', 'text', msg`Full name`],
  ['source', 'text', msg`Contact source`],
  ['type', 'single_choice', msg`Contact type`],
  ['createdAt', 'datetime', msg`Created on`],
  ['updatedAt', 'datetime', msg`Last updated`],
];
const readableDeal: readonly BuiltIn[] = [
  ['name', 'text', msg`Opportunity name`],
  ['stage', 'text', msg`Pipeline stage`],
  ['pipeline', 'text', msg`Pipeline`],
  ['status', 'single_choice', msg`Status`],
  ['value', 'money', msg`Opportunity value`],
  ['source', 'text', msg`Opportunity source`],
];

const builtIn = (head: 'contact' | 'deal', table: readonly BuiltIn[], group: SourceGroup) =>
  table.map(([key, type, label]): FieldChoice => ({
    path: `${head}.${key}`,
    label: i18n._(label),
    type,
    options: [],
    group,
  }));
const custom = (setup: Fields, head: 'contact' | 'deal', group: SourceGroup): FieldChoice[] =>
  setup.fields[head].map((field) => ({
    path: `${head}.custom.${field.key}`,
    label: customFieldName(field),
    type: field.type,
    options: field.options,
    group,
    ...(head === 'contact' ? { heading: folderHeading(field) } : {}),
  }));

/** The contact fields an Update contact step can write: its own four, then the custom ones. */
export function writableFields(setup: Fields): FieldChoice[] {
  return [
    ...builtIn('contact', writableContact, 'contact'),
    // A field of several choices is a list: no single value written here fits it.
    ...custom(setup, 'contact', 'custom').filter((field) => field.type !== 'multi_choice'),
  ];
}

/** The custom fields of an opportunity that an Update opportunity step can write. */
export function dealCustomFields(setup: Fields): FieldChoice[] {
  return custom(setup, 'deal', 'opportunity').filter((field) => field.type !== 'multi_choice');
}

/**
 * Every field a value can be read from: the contact's, its custom fields, those of the
 * opportunity the run has in hand, and where the contact came from (its first and latest
 * touch, and this lead's arrival); with `values`, the business's custom values too, which
 * only text can use, and the answers of the form submission that started the run.
 */
export function sourceFields(
  setup: Pick<AutomationSetup, 'fields' | 'values'> & {
    readonly answers?: readonly AnswerField[] | undefined;
  },
  values = false,
): FieldChoice[] {
  return [
    ...builtIn('contact', readableContact, 'contact'),
    ...(values
      ? (setup.answers ?? []).map((field): FieldChoice => ({
          ...field,
          group: 'submission',
        }))
      : []),
    ...custom(setup, 'contact', 'custom'),
    ...builtIn('deal', readableDeal, 'opportunity'),
    ...custom(setup, 'deal', 'opportunity'),
    ...attributionFields().map((field): FieldChoice => ({
      path: field.path,
      label: field.label,
      type: field.type,
      options: field.options,
      group: attributionGroups[field.scope],
    })),
    ...(values
      ? setup.values.map((key): FieldChoice => ({
          path: `custom_values.${key}`,
          label: customFieldName({ key }),
          type: 'text',
          options: [],
          group: 'values',
        }))
      : []),
  ];
}

const groupNames: Readonly<Record<SourceGroup, MessageDescriptor>> = {
  contact: msg`Contact`,
  custom: msg`Contact custom fields`,
  opportunity: msg`Opportunity (found or created in this workflow)`,
  first: scopeHeadings.first,
  latest: scopeHeadings.latest,
  arrival: scopeHeadings.trigger,
  values: msg`Custom values`,
  // Every answer carries its own heading (automation-trigger-filters.ts): this is never read.
  submission: scopeHeadings.trigger,
};

// The order the headings are listed in.
const groupOrder: readonly SourceGroup[] = [
  'contact',
  'custom',
  'opportunity',
  'submission',
  'arrival',
  'first',
  'latest',
  'values',
];

export interface FieldGroup {
  readonly group: SourceGroup;
  readonly label: string;
  readonly fields: FieldChoice[];
}

/**
 * Fields under the headings a picker shows them by; a heading with nothing is left out. A
 * contact's custom fields are listed folder by folder, as Settings keeps them; those the
 * catalog names no folder for share one heading.
 */
export function grouped(fields: readonly FieldChoice[]): FieldGroup[] {
  return groupOrder.flatMap((group) => {
    const groups: FieldGroup[] = [];
    for (const field of fields) {
      if (field.group !== group) continue;
      const label = field.heading ?? i18n._(groupNames[group]);
      const under = groups.find((each) => each.label === label);
      if (under === undefined) groups.push({ group, label, fields: [field] });
      else under.fields.push(field);
    }
    return groups;
  });
}

/** The field a path names, given the long way or the short way, or by an alias. */
export function choiceAt(
  fields: readonly FieldChoice[],
  path: string,
  setup: Fields,
): FieldChoice | undefined {
  const exact = fields.find((field) => field.path === path);
  if (exact !== undefined) return exact;
  const [head, key, more] = path.split('.');
  if ((head !== 'contact' && head !== 'deal') || key === undefined) return undefined;
  const named = more === undefined ? key : key === 'custom' ? more : undefined;
  const known = setup.fields[head].find(
    (field) => field.key === named || (named !== undefined && field.aliases.includes(named)),
  );
  return known === undefined
    ? undefined
    : fields.find((field) => field.path === `${head}.custom.${known.key}`);
}

export const isNumeric = (type: AutomationFieldType | undefined): boolean =>
  type === 'number' || type === 'money';
export const isDated = (type: AutomationFieldType | undefined): boolean =>
  type === 'date' || type === 'datetime';

/** Today as a date box holds it, in the reader's own calendar. */
export function today(now = new Date()): string {
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* ---------------------------------------------------------------- Update contact */

export const mathOperatorSigns = ['+', '-', '*', '/'] as const;
export type MathOperator = (typeof mathOperatorSigns)[number];

/** How a row sets its field. `other` is a value rows can't hold: it is kept as written. */
export type WriteMode = 'value' | 'copy' | 'text' | 'now' | 'date_add' | 'math' | 'clear' | 'other';

export type Written =
  | { readonly mode: 'value'; readonly value: string | number | boolean }
  | { readonly mode: 'copy'; readonly from: string }
  | { readonly mode: 'text'; readonly text: string }
  | { readonly mode: 'now' }
  | {
      readonly mode: 'date_add';
      /** Counted from now, from a fixed date, or from a date field. */
      readonly base: 'now' | 'date' | 'field';
      /** The date or the field's path; "now" when the document wrote it out. */
      readonly from: string;
      readonly days: number | undefined;
    }
  | {
      readonly mode: 'math';
      readonly left: number | string | undefined;
      readonly operator: MathOperator;
      readonly right: number | string | undefined;
    }
  | { readonly mode: 'clear' }
  | { readonly mode: 'other'; readonly raw: unknown };

export interface WriteRow {
  /** The field written, by its path. */
  readonly field: string;
  readonly written: Written;
  /** Written under `set`, as the document had it; a bare value otherwise. */
  readonly wrapped: boolean;
  /** `onlyIfEmpty` as the document had it; nothing when it was left out. */
  readonly onlyIfEmpty: boolean | undefined;
}

/** One merge field and nothing else, naming a field: what "copy from another field" writes. */
const LONE_FIELD = /^\{\{((?:contact|deal|trigger)(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\}\}$/;
/** As the validator finds a merge field in text (automations-validate.ts). */
const HAS_TOKEN = /\{\{\s*[^{}\s]+\s*\}\}/;

/** The merge field that stands for a field, as text holds it. */
export const tokenOf = (path: string): string => `{{${path}}}`;

const isOperator = (value: unknown): value is MathOperator =>
  mathOperatorSigns.some((sign) => sign === value);
/** A side of a sum: a number, a field's path, or nothing yet while its box is empty. */
const isOperand = (value: unknown): value is number | string | undefined =>
  value === undefined || typeof value === 'number' || typeof value === 'string';
const onlyKeys = (value: Config, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

function writtenOf(value: unknown): Written {
  if (value === null) return { mode: 'clear' };
  if (typeof value === 'number' || typeof value === 'boolean') return { mode: 'value', value };
  if (typeof value === 'string') {
    const lone = LONE_FIELD.exec(value);
    if (lone?.[1] !== undefined) return { mode: 'copy', from: lone[1] };
    return HAS_TOKEN.test(value) ? { mode: 'text', text: value } : { mode: 'value', value };
  }
  if (!isRecord(value)) return { mode: 'other', raw: value };
  if (value['op'] === 'now' && onlyKeys(value, ['op'])) return { mode: 'now' };
  if (value['op'] === 'date_add' && onlyKeys(value, ['op', 'field', 'value', 'days'])) {
    const { field, value: fixed, days } = value;
    const counted = typeof days === 'number' ? days : undefined;
    if (days !== undefined && counted === undefined) return { mode: 'other', raw: value };
    if (typeof field === 'string' && fixed === undefined)
      return { mode: 'date_add', base: 'field', from: field, days: counted };
    if (field === undefined && fixed === undefined)
      return { mode: 'date_add', base: 'now', from: '', days: counted };
    if (field === undefined && typeof fixed === 'string')
      return {
        mode: 'date_add',
        base: fixed === 'now' ? 'now' : 'date',
        from: fixed,
        days: counted,
      };
    // From a field and from a date at once is not something a row can say.
    return { mode: 'other', raw: value };
  }
  if (
    value['op'] === 'math' &&
    onlyKeys(value, ['op', 'left', 'operator', 'right']) &&
    isOperator(value['operator']) &&
    isOperand(value['left']) &&
    isOperand(value['right'])
  )
    return {
      mode: 'math',
      left: value['left'],
      operator: value['operator'],
      right: value['right'],
    };
  return { mode: 'other', raw: value };
}

/** What a step writes to one field, as a row. */
export function writeRowOf(field: string, value: unknown): WriteRow {
  const wrapped =
    isRecord(value) &&
    'set' in value &&
    onlyKeys(value, ['set', 'onlyIfEmpty']) &&
    (value['onlyIfEmpty'] === undefined || typeof value['onlyIfEmpty'] === 'boolean');
  if (!wrapped) return { field, written: writtenOf(value), wrapped: false, onlyIfEmpty: undefined };
  const only = value['onlyIfEmpty'];
  return {
    field,
    written: writtenOf(value['set']),
    wrapped: true,
    onlyIfEmpty: typeof only === 'boolean' ? only : undefined,
  };
}

/** Every field a step writes, as rows in the order written; nothing for no object. */
export function writeRowsOf(fields: unknown): WriteRow[] | undefined {
  if (fields === undefined) return [];
  if (!isRecord(fields)) return undefined;
  return Object.entries(fields).map(([path, value]) => writeRowOf(path, value));
}

function valueOf(written: Written): unknown {
  switch (written.mode) {
    case 'value':
      return written.value;
    case 'copy':
      return tokenOf(written.from);
    case 'text':
      return written.text;
    case 'now':
      return { op: 'now' };
    case 'clear':
      return null;
    case 'other':
      return written.raw;
    case 'math':
      return {
        op: 'math',
        ...(written.left === undefined ? {} : { left: written.left }),
        operator: written.operator,
        ...(written.right === undefined ? {} : { right: written.right }),
      };
    case 'date_add':
      return {
        op: 'date_add',
        ...(written.base === 'field' ? { field: written.from } : {}),
        ...(written.base === 'date' || (written.base === 'now' && written.from === 'now')
          ? { value: written.from }
          : {}),
        ...(written.days === undefined ? {} : { days: written.days }),
      };
  }
}

/** A row as the document writes it: bare, or under `set` beside `onlyIfEmpty`. */
export function writeOf(row: WriteRow): unknown {
  const value = valueOf(row.written);
  if (!row.wrapped && row.onlyIfEmpty !== true) return value;
  return { set: value, ...(row.onlyIfEmpty === undefined ? {} : { onlyIfEmpty: row.onlyIfEmpty }) };
}

/** The rows as the step's `fields`. */
export function writtenFields(rows: readonly WriteRow[]): Record<string, unknown> {
  return Object.fromEntries(rows.map((row) => [row.field, writeOf(row)]));
}

/** A row with "Only if empty" ticked or not: unticked, the value is written bare again. */
export function withOnlyIfEmpty(row: WriteRow, only: boolean): WriteRow {
  return only
    ? { ...row, wrapped: true, onlyIfEmpty: true }
    : { ...row, wrapped: false, onlyIfEmpty: undefined };
}

/** The ways a field of this kind can be set, in the order they are offered. */
export function modesFor(field: FieldChoice | undefined): WriteMode[] {
  const type = field?.type;
  return [
    'value',
    'copy',
    'text',
    ...(isDated(type) ? (['now', 'date_add'] as const) : []),
    ...(isNumeric(type) ? (['math'] as const) : []),
    // An email address or a phone number is replaced, never emptied (the contact keeps one).
    ...(type === 'email' || type === 'phone' ? [] : (['clear'] as const)),
  ];
}

/** What a value typed for a field of this kind starts as. */
export function starterValue(field: FieldChoice | undefined): string | number | boolean {
  if (field === undefined) return '';
  if (field.type === 'boolean') return true;
  if (isNumeric(field.type)) return 0;
  if (isDated(field.type)) return today();
  return field.type === 'single_choice' ? (field.options[0]?.key ?? '') : '';
}

/**
 * A row after another way of setting its field was chosen: each starts from something the
 * contract accepts, so no row is ever half written.
 */
export function withMode(
  row: WriteRow,
  mode: WriteMode,
  field: FieldChoice | undefined,
  sources: readonly FieldChoice[],
): WriteRow {
  const { written } = row;
  if (mode === written.mode) return row;
  const others = sources.filter((source) => source.path !== row.field);
  const to = (next: Written): WriteRow => ({ ...row, written: next });
  switch (mode) {
    case 'value':
      return to({ mode: 'value', value: starterValue(field) });
    case 'copy': {
      const alike = others.find((source) => source.type === field?.type) ?? others[0];
      return to({ mode: 'copy', from: alike?.path ?? 'contact.firstName' });
    }
    case 'text':
      return to({
        mode: 'text',
        text:
          written.mode === 'value' && typeof written.value === 'string'
            ? written.value
            : written.mode === 'copy'
              ? tokenOf(written.from)
              : '',
      });
    case 'now':
      return to({ mode: 'now' });
    case 'date_add':
      return to({ mode: 'date_add', base: 'now', from: '', days: 1 });
    case 'math':
      // The commonest sum: this field, and one more.
      return to({ mode: 'math', left: row.field, operator: '+', right: 1 });
    case 'clear':
      return to({ mode: 'clear' });
    case 'other':
      return row;
  }
}

/** A row after its field changed: a typed value starts again, since its kind may differ. */
export function withWriteField(row: WriteRow, field: FieldChoice): WriteRow {
  const { written } = row;
  const kept = written.mode !== 'value' && modesFor(field).includes(written.mode);
  return {
    ...row,
    field: field.path,
    written: kept ? written : { mode: 'value', value: starterValue(field) },
  };
}

/** A new row for the first field no row writes yet; nothing when every field has one. */
export function nextWriteRow(
  rows: readonly WriteRow[],
  fields: readonly FieldChoice[],
): WriteRow | undefined {
  const free = fields.find((field) => !rows.some((row) => row.field === field.path));
  return free === undefined
    ? undefined
    : {
        field: free.path,
        written: { mode: 'value', value: starterValue(free) },
        wrapped: false,
        onlyIfEmpty: undefined,
      };
}

/* ---------------------------------------------------------------- Find opportunity */

export const dealFilterKinds = [
  'pipeline',
  'stage',
  'status',
  'nameContains',
  'value',
  'customField',
] as const;
export type DealFilterKind = (typeof dealFilterKinds)[number];

/** The filters a Find opportunity step has: those its settings hold something for. */
export function dealFiltersOf(config: Config): DealFilterKind[] {
  return dealFilterKinds.filter((kind) => config[kind] !== undefined);
}

/**
 * What a filter starts as when it is added: something the contract accepts where there is
 * something to choose from, and nothing yet for text a person has to type.
 */
export function starterFilter(
  kind: DealFilterKind,
  setup: Pick<AutomationSetup, 'fields' | 'pipelines'>,
  config: Config,
): unknown {
  if (kind === 'status') return 'open';
  if (kind === 'value') return { operator: 'greater_than', value: 0 };
  if (kind === 'customField') {
    const [first] = setup.fields.deal;
    return first === undefined ? undefined : { field: `deal.custom.${first.key}`, equals: '' };
  }
  if (kind === 'pipeline') return setup.pipelines[0]?.id;
  if (kind === 'stage') {
    const chosen = setup.pipelines.find(
      (pipeline) => pipeline.id === config['pipeline'] || pipeline.name === config['pipeline'],
    );
    return (chosen ?? setup.pipelines[0])?.stages[0]?.id;
  }
  return undefined;
}

/** The filters that can still be added: each once, and only where there is something to choose. */
export function addableFilters(
  shown: readonly DealFilterKind[],
  setup: Pick<AutomationSetup, 'fields' | 'pipelines'>,
): DealFilterKind[] {
  return dealFilterKinds.filter(
    (kind) =>
      !shown.includes(kind) &&
      (kind !== 'customField' || setup.fields.deal.length > 0) &&
      ((kind !== 'pipeline' && kind !== 'stage') || setup.pipelines.length > 0),
  );
}

/* ---------------------------------------------------------------- Update opportunity */

export const dealChangeKinds = [
  'name',
  'value',
  'owner',
  'expectedCloseDate',
  'source',
  'status',
] as const;
export type DealChangeKind = (typeof dealChangeKinds)[number];

/** The members of the settings each row stands for: a value is `amount` or `amountFrom`. */
export const dealChangeMembers: Readonly<Record<DealChangeKind, readonly string[]>> = {
  name: ['name'],
  value: ['amount', 'amountFrom'],
  owner: ['owner'],
  expectedCloseDate: ['expectedCloseDate'],
  source: ['source'],
  status: ['status'],
};

/** The rows an Update opportunity step has: those its settings hold something for. */
export function dealChangesOf(config: Config): DealChangeKind[] {
  return dealChangeKinds.filter((kind) =>
    dealChangeMembers[kind].some((member) => config[member] !== undefined),
  );
}

/** The custom fields an Update opportunity step writes, by path; nothing for no object. */
export function dealFieldsOf(config: Config): Record<string, unknown> | undefined {
  const { fields } = config;
  return fields === undefined ? {} : isRecord(fields) ? fields : undefined;
}

/** What a row starts as when it is added; nothing yet for text a person has to type. */
export function starterChange(
  kind: DealChangeKind,
  setup: Pick<AutomationSetup, 'users'>,
): readonly [member: string, value: unknown] | undefined {
  if (kind === 'value') return ['amount', 0];
  if (kind === 'owner') return ['owner', setup.users[0]?.id ?? null];
  if (kind === 'expectedCloseDate') return ['expectedCloseDate', { in: 'P30D' }];
  // A source starts as how the lead arrived: the one choice that needs nothing typed.
  if (kind === 'source') return ['source', { from: 'arrival' }];
  return kind === 'status' ? ['status', 'open'] : undefined;
}
