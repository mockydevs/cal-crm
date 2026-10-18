// Contacts → Export as CSV: the file a bulk export writes once every contact of it has its
// outcome. GoHighLevel's export has the columns the list shows, in its order; so does this
// one, with a custom field by its label and a choice by its option's name. The contacts are
// read a page at a time in the transaction that keeps the file, so the file and the action
// that names it are written together or not at all; the file is at most what the files
// service keeps, and reading stops as soon as it would be more.
//
// Every cell holds what a person or an import typed, so each is written as a spreadsheet
// will show it and never as a formula it will run (formatCsvRecord's spreadsheetSafe, as an
// import's file of rows not applied is written).
import { contactExportColumnKeys, type ContactExportColumnKey } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { formatCsvRecord, parsePublicId, toPublicId } from '@repo/kernel';
import * as z from 'zod';

import { countryOf } from './country.js';
import { readContactExtras } from './extras.js';
import { readListFields } from './list-fields.js';
import { asContactPhone } from './phones.js';

/** How many contacts of an export are read at a time. */
export const EXPORT_PAGE_SIZE = 500;

// A byte order mark, so a spreadsheet reads the file as UTF-8 rather than guessing.
const BYTE_ORDER_MARK = '﻿';

const BUILT_IN_HEADERS: Readonly<Record<ContactExportColumnKey, string>> = {
  name: 'Contact Name',
  phone: 'Phone',
  email: 'Email',
  company: 'Business Name',
  added: 'Created',
  lastActivity: 'Last Activity',
  tags: 'Tags',
};

const isBuiltIn = (column: string): column is ContactExportColumnKey =>
  (contactExportColumnKeys as readonly string[]).includes(column);

const storedOptions = z.array(z.looseObject({ key: z.string(), label: z.string() }));

/** A column of an export: a built-in one, or a custom field with its label and choices. */
type Column =
  | { readonly kind: 'built_in'; readonly key: ContactExportColumnKey }
  | {
      readonly kind: 'field';
      readonly id: string;
      readonly label: string;
      readonly choices: ReadonlyMap<string, string>;
    };

/** The custom fields an export names that are fields of contacts of this business. */
async function fieldColumns(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, Column>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.id', '=', 'f.object_type_id').onRef('o.business_id', '=', 'f.business_id'),
    )
    .select(['f.id', 'f.label', 'f.options'])
    .where('f.business_id', '=', businessId)
    .where('f.id', 'in', [...ids])
    .where('o.kind', '=', 'contact')
    .where('f.merged_into_field_id', 'is', null)
    .execute();
  return new Map(
    rows.map((row) => {
      const parsed = storedOptions.safeParse(row.options);
      const choices = new Map(
        (parsed.success ? parsed.data : []).map((option) => [option.key, option.label]),
      );
      return [row.id, { kind: 'field', id: row.id, label: row.label, choices }];
    }),
  );
}

/**
 * The columns named, by stored id or built-in key, that can still be read. A field deleted
 * since the export started is left out of the file rather than written empty.
 */
export async function exportColumns(
  trx: DatabaseTransaction,
  businessId: string,
  named: readonly string[],
): Promise<Column[]> {
  const fields = await fieldColumns(
    trx,
    businessId,
    named.filter((column) => !isBuiltIn(column)),
  );
  return named.flatMap((column): Column[] => {
    if (isBuiltIn(column)) return [{ kind: 'built_in', key: column }];
    const field = fields.get(column);
    return field === undefined ? [] : [field];
  });
}

/**
 * Checks the columns an export names, as the request named them, and answers them as they
 * are kept: a built-in key, or a field's stored id. A field that is not one of this
 * business's contact fields is refused with its place.
 */
export async function checkExportColumns(
  trx: DatabaseTransaction,
  businessId: string,
  named: readonly string[],
): Promise<
  { readonly ok: true; readonly columns: string[] } | { readonly ok: false; readonly at: number }
> {
  const stored = named.map((column) =>
    isBuiltIn(column) ? column : (parsePublicId('field', column) ?? ''),
  );
  const fields = await fieldColumns(
    trx,
    businessId,
    stored.filter((column) => !isBuiltIn(column) && column !== ''),
  );
  const at = stored.findIndex((column) => !isBuiltIn(column) && !fields.has(column));
  return at === -1 ? { ok: true, columns: stored } : { ok: false, at };
}

type Cell =
  string | boolean | readonly string[] | Readonly<Record<string, string>> | null | undefined;

function cellOf(value: Cell, choices?: ReadonlyMap<string, string>): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const name = (key: string) => choices?.get(key) ?? key;
  if (typeof value === 'string') return name(value);
  if (isList(value)) return value.map(name).join(', ');
  // A text box list: each box's name and its text.
  return Object.entries(value)
    .map(([key, text]) => `${name(key)}: ${text}`)
    .join('; ');
}

const isList = (
  value: readonly string[] | Readonly<Record<string, string>>,
): value is readonly string[] => Array.isArray(value);

interface ExportRow {
  readonly id: string;
  readonly display_name: string | null;
  readonly created_at: Date;
  readonly email: string | null;
  readonly phone: string | null;
}

/** One page of the export's contacts: those changed without a skip, after a place. */
async function page(
  trx: DatabaseTransaction,
  businessId: string,
  bulkActionId: string,
  after: number,
): Promise<(ExportRow & { readonly position: number })[]> {
  return (
    trx
      .selectFrom('crm.contact_bulk_action_items as item')
      .innerJoin('crm.contacts as c', (join) =>
        join.onRef('c.business_id', '=', 'item.business_id').onRef('c.id', '=', 'item.contact_id'),
      )
      .select(['item.position', 'c.id', 'c.display_name', 'c.created_at'])
      .select((select) =>
        (['email', 'phone'] as const).map((kind) =>
          select
            .selectFrom('crm.contact_identities as i')
            .select('i.value_normalized')
            .whereRef('i.business_id', '=', 'c.business_id')
            .whereRef('i.contact_id', '=', 'c.id')
            .where('i.kind', '=', kind)
            .where('i.is_primary', '=', true)
            .as(kind),
        ),
      )
      .where('item.business_id', '=', businessId)
      .where('item.bulk_action_id', '=', bulkActionId)
      .where('item.outcome', '=', 'done')
      // A contact moved to the trash since it was counted is left out of the file.
      .where('c.deleted_at', 'is', null)
      .where('item.position', '>', after)
      .orderBy('item.position')
      .limit(EXPORT_PAGE_SIZE)
      .execute()
  );
}

/**
 * The export's file: its header, then each contact the export wrote, in the order the list
 * had them, read a page at a time in the caller's transaction. Too large is said as soon as
 * the file passes the most the files service keeps, before the rest is read.
 */
export async function exportContent(
  trx: DatabaseTransaction,
  businessId: string,
  bulkActionId: string,
  named: readonly string[],
  maxBytes: number,
): Promise<Uint8Array | 'too_large'> {
  const line = (cells: readonly string[]): string =>
    formatCsvRecord(cells, { spreadsheetSafe: true });
  const columns = await exportColumns(trx, businessId, named);
  const country = await countryOf(trx, businessId);
  const chunks: Buffer[] = [];
  let size = 0;
  const add = (text: string): boolean => {
    const bytes = Buffer.from(text, 'utf8');
    size += bytes.length;
    chunks.push(bytes);
    return size <= maxBytes;
  };
  if (
    !add(
      BYTE_ORDER_MARK +
        line(
          columns.map((column) =>
            column.kind === 'built_in' ? BUILT_IN_HEADERS[column.key] : column.label,
          ),
        ),
    )
  )
    return 'too_large';
  const extras = columns.flatMap((column) =>
    column.kind === 'built_in' &&
    (column.key === 'lastActivity' || column.key === 'tags' || column.key === 'company')
      ? [column.key]
      : [],
  );
  const fieldIds = columns.flatMap((column) =>
    column.kind === 'field' ? [toPublicId('field', column.id)] : [],
  );
  const readValues = await readListFields(trx, businessId, fieldIds);
  let after = 0;
  for (;;) {
    const rows = await page(trx, businessId, bulkActionId, after);
    const ids = rows.map((row) => row.id);
    const more = await readContactExtras(trx, businessId, ids, extras);
    const values = await readValues(ids);
    for (const row of rows) {
      const extra = more(row.id);
      const fields = values(row.id).fields ?? {};
      const written = line(
        columns.map((column) => {
          if (column.kind === 'field')
            return cellOf(fields[toPublicId('field', column.id)], column.choices);
          switch (column.key) {
            case 'name':
              return cellOf(row.display_name);
            // As the list shows it: a number of the business's own country in that
            // country's form, which a spreadsheet keeps as text; any other with its +.
            case 'phone':
              return cellOf(row.phone === null ? null : asContactPhone(row.phone, country).display);
            case 'email':
              return cellOf(row.email);
            case 'company':
              return cellOf(extra.company?.name);
            case 'added':
              return row.created_at.toISOString();
            case 'lastActivity':
              return cellOf(extra.lastActivity?.at);
            case 'tags':
              return cellOf(extra.tags?.map((each) => each.name));
          }
        }),
      );
      if (!add(written)) return 'too_large';
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < EXPORT_PAGE_SIZE) return Buffer.concat(chunks);
    after = last.position;
  }
}

/** The name an export's file is kept and downloaded under: Export_Contacts_2026-10-17.csv. */
export function exportFileName(name: string | null, at: Date): string {
  const stem = (name ?? '')
    .replace(/[^A-Za-z0-9 _-]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
  const day = at.toISOString().slice(0, 10);
  return `${stem === '' ? 'Export_Contacts' : stem.slice(0, 120)}_${day}.csv`;
}
