// The columns a list's address can name, for the search validation every route keeps in the
// code the dashboard loads first. The keys are the contract's
// (packages/contracts/src/saved-views.ts), written again here so that code does not bring
// the contract's schemas with it: the types below fail to compile when a key is missing or
// is not the contract's, and list-columns.test.ts holds the two lists equal, order and all.
import type {
  ContactTableColumnKey,
  contactViewColumnKeys,
  DealTableColumnKey,
} from '@repo/contracts';

/** A column of the opportunity table (the contract's `dealTableColumnKeys`). */
export type DealColumnKey = DealTableColumnKey;

/** The list itself when it names every key, and nothing that compiles when it misses one. */
type Whole<Key extends string, List extends readonly Key[]> =
  Exclude<Key, List[number]> extends never ? List : never;

const everyKey =
  <Key extends string>() =>
  <const List extends readonly Key[]>(list: Whole<Key, List>): List =>
    list;

/** Every column the contact table can show, in the order a new list shows them. */
export const contactColumnKeys = everyKey<ContactTableColumnKey>()([
  'name',
  'phone',
  'email',
  'company',
  'added',
  'lastActivity',
  'tags',
  'emailVerification',
]);

/** The columns a new list shows: every built-in one but Email verification, chosen in Manage fields. */
export const newListColumns: readonly ContactTableColumnKey[] = contactColumnKeys.filter(
  (key) => key !== 'emailVerification',
);

/** A custom field shown as a column of the contact table, named by its id. */
export type FieldColumn = `fld_${string}`;

/** A column of the contact table: a built-in one by its key, or a custom field. */
export type ContactColumn = ContactTableColumnKey | FieldColumn;

/** A field id's shape (the contract's checks it fully): its prefix and a TypeID's base32. */
const fieldId = /^fld_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export function isFieldColumn(key: string): key is FieldColumn {
  return fieldId.test(key);
}

/** At most this many custom fields show as columns: as many as a list page answers. */
export const MAX_FIELD_COLUMNS = 20;

/**
 * The contact columns an address or a view names: built-in columns and custom fields, each
 * once, the name first (it always shows). Undefined for anything else.
 */
export function contactColumnsOf(value: unknown): ContactColumn[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const columns = value.filter(
    (each): each is ContactColumn =>
      typeof each === 'string' &&
      (contactColumnKeys.some((key) => key === each) || isFieldColumn(each)),
  );
  if (columns.length !== value.length || new Set(columns).size !== columns.length) return undefined;
  if (columns.filter(isFieldColumn).length > MAX_FIELD_COLUMNS) return undefined;
  return ['name', ...columns.filter((key) => key !== 'name')];
}

/** A column's width in pixels, as dragged: the contract's bounds. */
export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 800;

/** At most this many columns have a width: as many as a layout has columns. */
export const MAX_COLUMN_WIDTHS = 30;

/**
 * The column widths an address or a view names: whole pixels within the bounds, by column,
 * at most as many as a layout has columns.
 */
export function columnWidthsOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter(
      (entry): entry is [ContactColumn, number] =>
        (contactColumnKeys.some((key) => key === entry[0]) || isFieldColumn(entry[0])) &&
        Number.isInteger(entry[1]) &&
        Number(entry[1]) >= MIN_COLUMN_WIDTH &&
        Number(entry[1]) <= MAX_COLUMN_WIDTH,
    )
    .slice(0, MAX_COLUMN_WIDTHS);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The widths of the columns that show, the others left out, as a list is saved with them. */
export function widthsShown(
  widths: Readonly<Record<string, number>> | undefined,
  columns: readonly ContactColumn[],
): Record<string, number> | undefined {
  return columnWidthsOf(
    Object.fromEntries(
      Object.entries(widths ?? {}).filter(([key]) => columns.some((column) => column === key)),
    ),
  );
}

/** The four columns the first contact table had, which a saved view still names. */
export const firstTableColumnKeys = everyKey<(typeof contactViewColumnKeys)[number]>()([
  'name',
  'email',
  'phone',
  'added',
]);

/** Every column the opportunity table can show, in the contract's order. */
export const dealColumnKeys = everyKey<DealColumnKey>()([
  'name',
  'contact',
  'stage',
  'value',
  'status',
  'owner',
  'tags',
  'created',
  'updated',
  'source',
  'expectedClose',
  'pipeline',
]);

/** What the first table called two of its columns, and what the table calls them now. */
const renamed: Readonly<Record<string, DealColumnKey>> = { amount: 'value', outcome: 'status' };

/**
 * The opportunity columns an address or a view names: known columns, each once, the name
 * first (it always shows). The first table's names for the value and the status are still
 * read, so an address kept from before opens the same. Undefined for anything else.
 */
export function dealColumnsOf(value: unknown): DealColumnKey[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const columns = value.flatMap((each: unknown): DealColumnKey[] => {
    const key = typeof each === 'string' ? (renamed[each] ?? each) : undefined;
    return dealColumnKeys.filter((known) => known === key);
  });
  return columns.length === value.length && new Set(columns).size === columns.length
    ? ['name', ...columns.filter((key) => key !== 'name')]
    : undefined;
}
