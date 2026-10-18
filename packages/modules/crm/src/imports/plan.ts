// What a row of the file would become, worked out without writing anything: the preview
// shows it, and the import applies exactly this (apply.ts). A row's values are checked by
// the same contracts and the same rules a person's edit meets: createContactInput, the
// business's phone rules, the server's time zones, each field's own validation.
//
// Whose row it is follows the product's one rule for contacts: an email address or a phone
// number belongs to one contact in a business. So a row is an existing contact when one of
// its addresses is that contact's, and it is never made into a second one. Both addresses
// are looked at, as GoHighLevel's importer documents: the business's primary match field
// first (the email address unless it chose the phone number), then the other.
import type { Invocation } from '@repo/commands';
import {
  contactPreferenceChanges,
  createContactInput,
  parseInput,
  type FieldDefinition,
  type ImportColumnMapping,
  type ImportMode,
  type ImportRowIssue,
  type ImportTarget,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import type { CountryCode } from 'libphonenumber-js';

import { findTimeZone } from '../contacts/contact-settings.js';
import { countryOf } from '../contacts/contacts.js';
import { importMatchOrder, readMatchSettings } from '../contacts/duplicate-settings.js';
import { normalizePhone } from '../contacts/phones.js';
import { readFields } from '../fields/fields.js';
import { validateFieldValue } from '../fields/value-validation.js';
import { cellOf, type CsvRow } from './csv-file.js';
import { readAttributeCell, readFieldCell, type CellValue } from './mapping.js';

/** What every row of one import is planned against, read once for a batch of rows. */
export interface PlanContext {
  readonly businessId: string;
  readonly mode: ImportMode;
  readonly mapping: readonly ImportColumnMapping[];
  /** The file's header: how many columns a row may have, and what each is called. */
  readonly header: readonly string[];
  /** The business's live contact fields, by public id. */
  readonly fields: ReadonlyMap<string, FieldDefinition>;
  readonly country: CountryCode | undefined;
  /** The tags every contact the import writes is given, by public id. */
  readonly tagIds: readonly string[];
  /** The tags rows name, found once each. */
  readonly tags: TagFinder;
  /** Which of a row's addresses says whose row it is first: the primary match field's. */
  readonly matchOrder: readonly ('email' | 'phone')[];
}

/** Finds existing tags by the names rows give them, as the database compares tag names. */
export type TagFinder = (
  trx: DatabaseTransaction,
  names: readonly string[],
) => Promise<(string | undefined)[]>;

/**
 * A finder that asks the database once for each name. The comparison is the database's
 * own (crm.tags.name_key, 0005): case, spaces, hyphens and underscores don't tell two tags
 * apart, so "hot lead" finds "Hot-Lead".
 */
export function tagFinder(): TagFinder {
  const known = new Map<string, string | undefined>();
  return async (trx, names) => {
    const unknown = [...new Set(names.filter((name) => !known.has(name)))];
    if (unknown.length > 0) {
      const { rows } = await sql<{ name: string; id: string | null }>`
        select wanted.name, tag.id
        from unnest(${unknown}::text[]) as wanted (name)
        left join crm.tags tag
          on tag.name_key = lower(regexp_replace(btrim(wanted.name), '[\s_-]+', ' ', 'g'))
      `.execute(trx);
      for (const row of rows)
        known.set(row.name, row.id === null ? undefined : toPublicId('tag', row.id));
    }
    return names.map((name) => known.get(name));
  };
}

/** The business's fields a contact import can fill, and what else planning a row reads. */
export async function loadPlanContext(
  trx: DatabaseTransaction,
  invocation: Invocation,
  plan: {
    readonly businessId: string;
    readonly mode: ImportMode;
    readonly mapping: readonly ImportColumnMapping[];
    readonly header: readonly string[];
    readonly tagIds: readonly string[];
  },
): Promise<PlanContext> {
  const { items } = await readFields(trx, invocation);
  return {
    ...plan,
    fields: new Map(
      items.filter((field) => field.objectKey === 'contact').map((field) => [field.id, field]),
    ),
    country: await countryOf(trx, plan.businessId),
    tags: tagFinder(),
    matchOrder: importMatchOrder(await readMatchSettings(trx, plan.businessId)),
  };
}

/** What a row writes on its contact, each value already as it will be stored. */
export interface PlannedContact {
  readonly firstName: string | undefined;
  readonly lastName: string | undefined;
  /** Lower case; the first is the row's main address. */
  readonly emails: readonly string[];
  /** In E.164; the first is the row's main number. */
  readonly phones: readonly string[];
  /** As PostgreSQL spells it. */
  readonly timeZone: string | undefined;
  /** Only ever turned on. */
  readonly doNotContact: boolean;
  /** Public ids: the import's own tags, then the row's. */
  readonly tagIds: readonly string[];
  readonly fields: readonly { readonly fieldId: string; readonly value: NonNullable<CellValue> }[];
}

type Issues = readonly [ImportRowIssue, ...ImportRowIssue[]];

export type RowPlan =
  | { readonly outcome: 'create'; readonly contact: PlannedContact }
  | { readonly outcome: 'update'; readonly contact: PlannedContact; readonly contactId: string }
  | { readonly outcome: 'skip' | 'fail'; readonly issues: Issues };

export interface PlannedRow {
  readonly row: number;
  /** Each mapped cell as it was read, for the preview. */
  readonly values: readonly {
    readonly column: number;
    readonly target: ImportTarget;
    readonly value: CellValue;
  }[];
  readonly plan: RowPlan;
}

/** What earlier rows of the same file did, so a later row doesn't write the same contact. */
export interface EarlierRows {
  /** The row that already wrote this contact in this import, if one did. */
  rowOfContact(trx: DatabaseTransaction, contactId: string): Promise<number | undefined>;
  /** The row that will create a contact with this address, when nothing is written yet. */
  rowOfNewIdentity(kind: 'email' | 'phone', value: string): number | undefined;
}

const taken = {
  email: {
    live: 'Another contact has this email address.',
    trashed: 'A contact in the trash has this email address. Restore it first.',
  },
  phone: {
    live: 'Another contact has this phone number.',
    trashed: 'A contact in the trash has this phone number. Restore it first.',
  },
} as const;

// What to say when a field's own check refuses a value, by the field's type. The check's
// own words are kept where it has some.
const refusals: Readonly<Record<FieldDefinition['valueType'], string>> = {
  text: 'Use at most 1,000 characters.',
  long_text: 'Use at most 100,000 characters.',
  number: 'Enter a number, such as 1250.50.',
  money: 'Enter an amount, such as 1250.50.',
  date: 'Enter a date with the year first, such as 2026-10-09.',
  datetime: 'Enter a date and time with its offset, such as 2026-10-09T14:30:00+03:00.',
  boolean: 'Use yes or no.',
  single_choice: "This isn't one of the field's choices.",
  multi_choice: "One of these isn't one of the field's choices.",
  email: 'Enter an email address, such as maya@example.com.',
  phone: 'Enter a phone number, such as +1 212 555 0142.',
  url: 'Enter a web address that starts with http:// or https://.',
  text_list: "A text box list can't be filled from a column.",
  file: "A file upload field can't be filled from a column.",
};

interface Holder {
  readonly kind: 'email' | 'phone';
  readonly value: string;
  readonly contactId: string;
  readonly trashed: boolean;
}

/** Who holds each of these addresses in the business, the trash included. */
async function holdersOf(
  trx: DatabaseTransaction,
  businessId: string,
  emails: readonly string[],
  phones: readonly string[],
): Promise<Holder[]> {
  if (emails.length + phones.length === 0) return [];
  const rows = await trx
    .selectFrom('crm.contact_identities as identity')
    .innerJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.business_id', '=', 'identity.business_id')
        .onRef('contact.id', '=', 'identity.contact_id'),
    )
    .select(['identity.kind', 'identity.value_normalized', 'contact.id', 'contact.deleted_at'])
    .where('identity.business_id', '=', businessId)
    .where((where) =>
      where.or([
        ...(emails.length === 0
          ? []
          : [
              where.and([
                where('identity.kind', '=', 'email'),
                where('identity.value_normalized', 'in', [...emails]),
              ]),
            ]),
        ...(phones.length === 0
          ? []
          : [
              where.and([
                where('identity.kind', '=', 'phone'),
                where('identity.value_normalized', 'in', [...phones]),
              ]),
            ]),
      ]),
    )
    .execute();
  // Only those two kinds were asked for.
  return rows.map((row) => ({
    kind: row.kind === 'email' ? 'email' : 'phone',
    value: row.value_normalized,
    contactId: row.id,
    trashed: row.deleted_at !== null,
  }));
}

/** The list when it has something in it, typed as such. */
function nonEmpty<T>(list: readonly T[]): readonly [T, ...T[]] | undefined {
  const [first, ...rest] = list;
  return first === undefined ? undefined : [first, ...rest];
}

/** A value with the column it came from. */
interface Sourced {
  readonly value: string;
  readonly column: number;
}

/**
 * Plans one row. Whatever is wrong with it is said for the column it is in, in words that
 * hold nothing of the row itself.
 */
export async function planRow(
  trx: DatabaseTransaction,
  context: PlanContext,
  row: CsvRow,
  earlier: EarlierRows,
): Promise<PlannedRow> {
  const issues: ImportRowIssue[] = [];
  const values: {
    column: number;
    target: ImportTarget;
    value: CellValue;
  }[] = [];
  const failed = (problems: Issues): PlannedRow => ({
    row: row.row,
    values,
    plan: { outcome: 'fail', issues: problems },
  });

  if (row.cells.length > context.header.length)
    return failed([
      {
        column: null,
        code: 'too_many_cells',
        message: `This row has ${String(row.cells.length)} values and the header has ${String(context.header.length)} columns. A value with a comma in it must be inside quotation marks.`,
      },
    ]);

  // Each mapped cell, read for what it fills.
  const text: Partial<Record<'firstName' | 'lastName' | 'timeZone', Sourced>> = {};
  const emails: Sourced[] = [];
  const rawPhones: Sourced[] = [];
  const tagNames: Sourced[] = [];
  const fieldCells: { field: FieldDefinition; value: NonNullable<CellValue>; column: number }[] =
    [];
  let doNotContact = false;
  for (const { column, target } of context.mapping) {
    const cell = cellOf(row, column);
    if (target.kind === 'field') {
      const field = context.fields.get(target.fieldId);
      // The mapping was checked when the import began. A field deleted since fails each
      // row that has a value for it; an empty cell changes nothing, as ever.
      if (field === undefined) {
        values.push({ column, target, value: null });
        if (cell !== '')
          issues.push({
            column,
            code: 'field_unknown',
            message: 'The field this column fills no longer exists.',
          });
        continue;
      }
      const reading = readFieldCell(field, cell);
      if (reading.problem !== undefined) {
        values.push({ column, target, value: null });
        issues.push({ column, ...reading.problem });
        continue;
      }
      values.push({ column, target, value: reading.value });
      if (reading.value !== null) fieldCells.push({ field, value: reading.value, column });
      continue;
    }
    const reading = readAttributeCell(target.attribute, cell);
    if (reading.problem !== undefined) {
      values.push({ column, target, value: null });
      issues.push({ column, ...reading.problem });
      continue;
    }
    const { value } = reading;
    values.push({ column, target, value });
    if (value === null) continue;
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    switch (target.attribute) {
      case 'firstName':
      case 'lastName':
      case 'timeZone':
        if (typeof value === 'string') text[target.attribute] = { value, column };
        break;
      // The single address goes first, whatever order the columns are mapped in.
      case 'email':
        emails.unshift(...list.map((each) => ({ value: each, column })));
        break;
      case 'additionalEmails':
        emails.push(...list.map((each) => ({ value: each, column })));
        break;
      case 'phone':
        rawPhones.unshift(...list.map((each) => ({ value: each, column })));
        break;
      case 'additionalPhones':
        rawPhones.push(...list.map((each) => ({ value: each, column })));
        break;
      case 'tags':
        tagNames.push(...list.map((each) => ({ value: each, column })));
        break;
      case 'doNotContact':
        doNotContact = value === true;
        break;
    }
  }
  const setValue = (column: number, value: CellValue): void => {
    const shown = values.find((each) => each.column === column);
    if (shown !== undefined) shown.value = value;
  };

  // The same address twice in a row is one address.
  const distinctEmails = emails.filter(
    (email, index) => emails.findIndex((each) => each.value === email.value) === index,
  );

  // The contact's own contract: names, email addresses and how many of each there may be.
  try {
    parseInput(createContactInput, {
      firstName: text.firstName?.value ?? null,
      lastName: text.lastName?.value ?? null,
      emails: distinctEmails.map((email) => email.value),
      phones: rawPhones.map((phone) => phone.value),
    });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    for (const issue of error.issues) {
      const [, name, position] = issue.path.split('/');
      const at = Number(position ?? 0);
      const column =
        name === 'firstName' || name === 'lastName'
          ? text[name]?.column
          : name === 'emails'
            ? distinctEmails[at]?.column
            : name === 'phones'
              ? rawPhones[at]?.column
              : undefined;
      issues.push({ column: column ?? null, code: issue.code, message: issue.message });
    }
  }

  // Phone numbers by the business's own rules, each once however it is written.
  const phones: Sourced[] = [];
  const stored = new Map<string, string>();
  for (const phone of rawPhones) {
    const normalized = normalizePhone(phone.value, context.country);
    if (typeof normalized !== 'string') {
      issues.push({ column: phone.column, ...normalized });
      continue;
    }
    stored.set(phone.value, normalized);
    if (!phones.some((each) => each.value === normalized))
      phones.push({ value: normalized, column: phone.column });
  }

  let timeZone: string | undefined;
  const zone = text.timeZone;
  if (zone !== undefined) {
    const unknown = (message: string): void => {
      issues.push({ column: zone.column, code: 'time_zone_unknown', message });
    };
    const named = contactPreferenceChanges.timeZone.safeParse(zone.value);
    if (!named.success || typeof named.data !== 'string')
      unknown("This isn't a time zone, such as Africa/Nairobi.");
    else {
      timeZone = await findTimeZone(trx, named.data);
      if (timeZone === undefined)
        unknown("This isn't a time zone this server knows, such as Africa/Nairobi.");
      else setValue(zone.column, timeZone);
    }
  }

  // Each custom field's own check, the one its editor runs.
  const fields: { fieldId: string; value: NonNullable<CellValue> }[] = [];
  for (const { field, value, column } of fieldCells) {
    try {
      const checked = await validateFieldValue(trx, field, value, null, context.businessId);
      // A cell is text, a yes or no, or a list: never a text box list's boxes.
      if (checked !== null && (typeof checked !== 'object' || Array.isArray(checked))) {
        fields.push({ fieldId: field.id, value: checked });
        setValue(column, checked);
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      const [first] = error.issues;
      const own = first.code.startsWith('phone_') || first.code === 'invalid_choice';
      issues.push({
        column,
        code: own ? first.code : 'field_value_invalid',
        message: own ? first.message : refusals[field.valueType],
      });
    }
  }

  // Tags are made on purpose, in Settings: a row names tags that exist, or it fails.
  const found = await context.tags(
    trx,
    tagNames.map((tag) => tag.value),
  );
  const rowTagIds: string[] = [];
  for (const [index, tag] of tagNames.entries()) {
    const id = found[index];
    if (id !== undefined) rowTagIds.push(id);
    // Said once for the row, however many of its tags are unknown.
    else if (!issues.some((issue) => issue.code === 'tag_unknown'))
      issues.push({
        column: tag.column,
        code: 'tag_unknown',
        message:
          "This row names a tag that doesn't exist. Create the tag in Settings first, or take it out of the row.",
      });
  }

  const unreadable = nonEmpty(issues);
  if (unreadable !== undefined) return failed(unreadable);

  // The preview shows each phone number as it will be stored.
  const asStored = (written: string): string => stored.get(written) ?? written;
  for (const shown of values) {
    if (shown.target.kind !== 'attribute') continue;
    if (shown.target.attribute === 'phone' && typeof shown.value === 'string')
      shown.value = asStored(shown.value);
    if (shown.target.attribute === 'additionalPhones' && Array.isArray(shown.value))
      shown.value = [...new Set(shown.value.map(asStored))];
  }

  const contact: PlannedContact = {
    firstName: text.firstName?.value,
    lastName: text.lastName?.value,
    emails: distinctEmails.map((email) => email.value),
    phones: phones.map((phone) => phone.value),
    timeZone,
    doNotContact,
    tagIds: [...new Set([...context.tagIds, ...rowTagIds])],
    fields,
  };

  // Whose row this is: the contact that holds its address of the primary match field, else
  // its other one.
  const holders = await holdersOf(trx, context.businessId, contact.emails, contact.phones);
  const byKind: Readonly<
    Record<'email' | 'phone', readonly { kind: 'email' | 'phone'; value: string; column: number }[]>
  > = {
    email: distinctEmails.map((email) => ({ kind: 'email', ...email })),
    phone: phones.map((phone) => ({ kind: 'phone', ...phone })),
  };
  const identities = context.matchOrder.flatMap((kind) => byKind[kind]);
  const holderOf = (identity: { kind: 'email' | 'phone'; value: string }) =>
    holders.find((holder) => holder.kind === identity.kind && holder.value === identity.value);
  const owner = identities.map(holderOf).find((holder) => holder !== undefined);
  for (const identity of identities) {
    const holder = holderOf(identity);
    if (holder === undefined) continue;
    if (holder.trashed || holder.contactId !== owner?.contactId)
      issues.push({
        column: identity.column,
        code: holder.trashed ? 'contact_in_trash' : 'taken',
        message: taken[identity.kind][holder.trashed ? 'trashed' : 'live'],
      });
  }
  const held = nonEmpty(issues);
  if (held !== undefined) return failed(held);

  const skipped = (code: string, message: string): PlannedRow => ({
    row: row.row,
    values,
    plan: { outcome: 'skip', issues: [{ column: null, code, message }] },
  });
  const sameAs = (first: number): PlannedRow =>
    skipped('duplicate_in_file', `Row ${String(first)} of this file is the same contact.`);

  if (owner === undefined) {
    const first = identities
      .map((identity) => earlier.rowOfNewIdentity(identity.kind, identity.value))
      .find((each) => each !== undefined);
    if (first !== undefined) return sameAs(first);
    if (context.mode === 'update')
      return skipped(
        'no_contact',
        'No contact has this email address or phone number, and this import only updates contacts.',
      );
    return { row: row.row, values, plan: { outcome: 'create', contact } };
  }
  const first = await earlier.rowOfContact(trx, owner.contactId);
  if (first !== undefined) return sameAs(first);
  if (context.mode === 'create')
    return skipped(
      'exists',
      'A contact already has this email address or phone number, and this import only adds new contacts.',
    );
  return {
    row: row.row,
    values,
    plan: { outcome: 'update', contact, contactId: owner.contactId },
  };
}

/** What earlier rows did, for a preview: nothing is written, so it is remembered here. */
export function rememberedRows(): EarlierRows & { note(planned: PlannedRow): void } {
  const contacts = new Map<string, number>();
  const identities = new Map<string, number>();
  return {
    rowOfContact: (_trx, contactId) => Promise.resolve(contacts.get(contactId)),
    rowOfNewIdentity: (kind, value) => identities.get(`${kind}:${value}`),
    note({ row, plan }) {
      if (plan.outcome === 'update') contacts.set(plan.contactId, row);
      if (plan.outcome !== 'create') return;
      for (const email of plan.contact.emails) identities.set(`email:${email}`, row);
      for (const phone of plan.contact.phones) identities.set(`phone:${phone}`, row);
    },
  };
}
