// What the Custom Fields and Custom Values pages work out before they draw: where a keyset
// list is among its pages, which rows a page shows, what the Created filter asks the server
// for, and whether a field is ready to save.
import type { FieldDefinition } from '@repo/contracts';

/**
 * Where a list is among its pages. The API's lists are keyset lists: a page is asked for
 * with the cursor the page before it gave, so the way back is the cursors already used.
 */
export interface Trail {
  /** The cursor each page after the first was asked for with, in order. */
  readonly after: readonly string[];
  /** The page showing, from 0. */
  readonly index: number;
}

export const emptyTrail: Trail = { after: [], index: 0 };

/** The page after this one, asked for with the cursor this one gave; the same on the last. */
export function trailForward(trail: Trail, next: string | null): Trail {
  return next === null ? trail : { after: [...trail.after, next], index: trail.index + 1 };
}

/** The page before this one; the same on the first. */
export function trailBack(trail: Trail): Trail {
  return trail.index === 0 ? trail : { after: trail.after.slice(0, -1), index: trail.index - 1 };
}

/** The cursor the page showing is asked for with: none for the first. */
export function trailCursor(trail: Trail): string | undefined {
  return trail.after[trail.index - 1];
}

export interface Range {
  readonly from: number;
  readonly to: number;
  readonly total: number;
}

/** "1 - 20 of 58": the rows a page shows, and how many the list holds. */
export function rangeOf({
  index,
  pageSize,
  shown,
  total,
}: {
  readonly index: number;
  readonly pageSize: number;
  readonly shown: number;
  readonly total: number;
}): Range {
  if (shown === 0) return { from: 0, to: 0, total };
  const to = index * pageSize + shown;
  return { from: index * pageSize + 1, to, total: Math.max(total, to) };
}

/** The numbers of rows a page may hold: each within what the API allows (100). */
export const pageSizes = [10, 20, 50, 100] as const;
export type PageSize = (typeof pageSizes)[number];

/** What the Created filter offers: any time, or the last so many days. */
export const createdPresets = ['any', '7', '30', '90'] as const;
export type CreatedPreset = (typeof createdPresets)[number];

/** The moment the Created filter asks for fields from, or none for any time. */
export function createdSince(preset: CreatedPreset, now: Date): string | undefined {
  if (preset === 'any') return undefined;
  return new Date(now.getTime() - Number(preset) * 24 * 60 * 60 * 1000).toISOString();
}

/** What the field panel holds that decides whether it can be saved. */
export interface FieldDraft {
  readonly label: string;
  readonly key: string;
  readonly description: string;
  readonly valueType: FieldDefinition['valueType'];
  readonly currency: string;
  readonly options: readonly { readonly label: string }[];
  /** A file upload field's formats; any other field has none. */
  readonly formats?: readonly string[];
}

export const isChoiceType = (type: FieldDefinition['valueType']): boolean =>
  type === 'single_choice' || type === 'multi_choice';

/** The types whose options the panel edits: choices, or a text box list's boxes. */
export const hasOptions = (type: FieldDefinition['valueType']): boolean =>
  isChoiceType(type) || type === 'text_list';

/**
 * Whether the panel's primary button is on: everything the API requires is there. A saved
 * field's key, type and currency never change, so only a new field is asked for them.
 */
export function fieldDraftReady(draft: FieldDraft, creating: boolean): boolean {
  if (draft.label.trim() === '' || draft.description.trim() === '') return false;
  if (draft.options.some((option) => option.label.trim() === '')) return false;
  if (draft.valueType === 'file' && (draft.formats ?? []).length === 0) return false;
  if (!creating) return true;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(draft.key)) return false;
  if (draft.valueType === 'money' && !/^[A-Z]{3}$/.test(draft.currency)) return false;
  return !hasOptions(draft.valueType) || draft.options.length > 0;
}
