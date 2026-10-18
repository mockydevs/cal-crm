// What the Merge Contacts dialog decides by itself, with nothing to show: the order the
// contacts are read in, which value each field keeps unless another is picked (the
// server's own rule: the master's value, or the first value of the others when it has
// none), which choices the request names, the primary address offered first, and what
// stops the Merge button.
import {
  contactMergeChoiceFields,
  type ContactMergeChoiceField,
  type ContactMergePreview,
  type MergeContactsInput,
} from '@repo/contracts';

/** The contacts in the order a merge reads them: the master, then the others as given. */
export function mergeOrder(ids: readonly string[], master: string): string[] {
  return [master, ...ids.filter((id) => id !== master)];
}

/**
 * One field across the contacts: each contact's value as something to compare (two equal
 * strings are the same value), null where it has none.
 */
export interface FieldRow {
  /** The contact's own field, or a custom field's key. */
  readonly field: string;
  readonly custom: boolean;
  readonly values: ReadonlyMap<string, string | null>;
}

/** What a field's pick is kept under. */
export function rowKey(row: Pick<FieldRow, 'field' | 'custom'>): string {
  return `${row.custom ? 'custom' : 'own'}:${row.field}`;
}

/** The contact whose value the field keeps when nobody picks one; null when none has one. */
export function defaultSource(row: FieldRow, order: readonly string[]): string | null {
  return order.find((id) => (row.values.get(id) ?? null) !== null) ?? null;
}

/** Whether the contacts have different values in the field, so there is something to pick. */
export function conflicts(row: FieldRow): boolean {
  const values = new Set([...row.values.values()].filter((value) => value !== null));
  return values.size > 1;
}

const isChoiceField = (field: string): field is ContactMergeChoiceField =>
  contactMergeChoiceFields.some((each) => each === field);

/** The picks the request names: only those that differ from what the field keeps anyway. */
export function choicesOf(
  rows: readonly FieldRow[],
  picks: ReadonlyMap<string, string>,
  order: readonly string[],
): Pick<MergeContactsInput, 'fields' | 'customFields'> {
  const fields: Partial<Record<ContactMergeChoiceField, string>> = {};
  const customFields: Record<string, string> = {};
  for (const row of rows) {
    const picked = picks.get(rowKey(row));
    if (picked === undefined || picked === defaultSource(row, order)) continue;
    if (row.custom) customFields[row.field] = picked;
    else if (isChoiceField(row.field)) fields[row.field] = picked;
  }
  return {
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(Object.keys(customFields).length === 0 ? {} : { customFields }),
  };
}

/** The addresses of one kind a merge can make primary, and the one it makes unless asked. */
export interface AddressChoice {
  /** Every contact's addresses, each once, the master's first. */
  readonly options: readonly string[];
  /** The master's primary, or the first primary of the others; none when nobody has one. */
  readonly fallback: string | undefined;
}

/** Each contact's addresses of one kind, the primary first, read in the merge's order. */
export function addressChoice(
  lists: ReadonlyMap<string, readonly string[]>,
  order: readonly string[],
): AddressChoice {
  const ordered = order.map((id) => lists.get(id) ?? []);
  return {
    options: [...new Set(ordered.flat())],
    fallback: ordered.find((list) => list.length > 0)?.[0],
  };
}

/** What stops the Merge button, if anything. */
export type MergeBlocker = 'loading' | 'too_large' | 'unconfirmed';

export function blockerOf({
  preview,
  confirmed,
}: {
  readonly preview: ContactMergePreview | undefined;
  readonly confirmed: boolean;
}): MergeBlocker | undefined {
  if (preview === undefined) return 'loading';
  if (preview.rows > preview.maxRows) return 'too_large';
  if (!confirmed) return 'unconfirmed';
  return undefined;
}

/** One kind of row that moves to the master, and how many. */
export interface MovedRow {
  readonly module: string;
  readonly kind: string;
  readonly count: number;
}

/** What moves, by module and kind, leaving out the kinds none of moves. */
export function movedRows(moved: ContactMergePreview['moved']): MovedRow[] {
  return Object.entries(moved).flatMap(([module, kinds]) =>
    Object.entries(kinds)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => ({ module, kind, count })),
  );
}

/** The merge request: the others, the choices changed, and every contact's revision. */
export function mergeBodyOf({
  order,
  rows,
  picks,
  emails,
  email,
  phones,
  phone,
  preview,
}: {
  readonly order: readonly string[];
  readonly rows: readonly FieldRow[];
  readonly picks: ReadonlyMap<string, string>;
  readonly emails: AddressChoice;
  /** The email address picked as primary, if one was. */
  readonly email: string | undefined;
  readonly phones: AddressChoice;
  readonly phone: string | undefined;
  readonly preview: ContactMergePreview;
}): MergeContactsInput {
  return {
    mergeIds: order.slice(1),
    ...choicesOf(rows, picks, order),
    ...(email === undefined || email === emails.fallback ? {} : { primaryEmail: email }),
    ...(phone === undefined || phone === phones.fallback ? {} : { primaryPhone: phone }),
    revisions: Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision])),
  };
}
