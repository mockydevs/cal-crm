// What a trigger's compact filter editor works out before it draws: which of a trigger's
// settings are filters that show only once they are set (the lead sources and the session
// sources a form or a booking starts for), what the "Add filters" menu still offers, the
// answers of the form a workflow starts from as fields a filter, a condition and a message
// can read (trigger.answers.<key> and trigger.pageUrl), and what a form a trigger names is:
// one that is published, a draft, archived, or gone.
//
// Its words are in the builder's own catalog (lingui.config.ts, automation-words.ts).
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';

/** The settings of a trigger that are filters: listed once set, added from the menu. */
export const COMPACT_FILTER_KEYS = ['sources', 'sessionSources'] as const;
export type CompactFilterKey = (typeof COMPACT_FILTER_KEYS)[number];

export const isCompactFilter = (key: string): key is CompactFilterKey =>
  (COMPACT_FILTER_KEYS as readonly string[]).includes(key);

/** Whether a filter holds something: a list with at least one thing in it. */
export const isFilterSet = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/**
 * The compact filters to show, in the order the trigger lists them: those that hold
 * something, and those the person just added and has not filled in yet.
 */
export function shownCompactFilters(
  keys: readonly string[],
  config: Readonly<Record<string, unknown>>,
  opened: readonly string[],
): CompactFilterKey[] {
  return keys
    .filter(isCompactFilter)
    .filter((key) => isFilterSet(config[key]) || opened.includes(key));
}

/** The compact filters the menu still offers: those not shown yet. */
export function addableCompactFilters(
  keys: readonly string[],
  shown: readonly string[],
): CompactFilterKey[] {
  return keys.filter(isCompactFilter).filter((key) => !shown.includes(key));
}

/* ---------------------------------------------------------------- the form a trigger names */

export interface FormRecord {
  readonly id: string;
  readonly name: string;
  readonly status: 'draft' | 'published' | 'archived';
}

export type FormState =
  /** No form is named: the trigger starts for every form. */
  | { readonly kind: 'any' }
  | { readonly kind: 'published'; readonly id: string; readonly name: string }
  /** It exists and has never been published, so nothing can submit it yet. */
  | { readonly kind: 'draft'; readonly id: string; readonly name: string }
  | { readonly kind: 'archived'; readonly id: string; readonly name: string }
  /** The business's forms are still being read: nothing is said of it yet. */
  | { readonly kind: 'checking'; readonly written: string }
  /** No form of this business has this id or name. */
  | { readonly kind: 'missing'; readonly written: string };

/**
 * What the form a trigger names is. The setup lists the published forms; the business's
 * own list of forms (`records`, when it has been read) says whether another is a draft or
 * archived. A draft may name a form by what people call it: the document keeps its id.
 */
export function formState(
  value: unknown,
  published: readonly { readonly id: string; readonly name: string }[],
  records: readonly FormRecord[] | undefined,
): FormState {
  if (typeof value !== 'string' || value === '') return { kind: 'any' };
  const same = (name: string): boolean => name.trim().toLowerCase() === value.trim().toLowerCase();
  const live =
    published.find((form) => form.id === value) ?? published.find((form) => same(form.name));
  if (live !== undefined) return { kind: 'published', id: live.id, name: live.name };
  if (records === undefined) return { kind: 'checking', written: value };
  const record =
    records.find((form) => form.id === value) ?? records.find((form) => same(form.name));
  if (record === undefined) return { kind: 'missing', written: value };
  return {
    kind: record.status === 'archived' ? 'archived' : 'draft',
    id: record.id,
    name: record.name,
  };
}

/** What is said under the form's control of a form that cannot receive submissions. */
export function formStateWords(state: FormState): string | undefined {
  if (state.kind === 'draft')
    return i18n._(msg`This form is a draft. Publish it to receive submissions.`);
  if (state.kind === 'archived')
    return i18n._(msg`This form is archived. Restore and publish it to receive submissions.`);
  if (state.kind === 'missing')
    return i18n._(msg`This business has no form with this name or ID. Choose another form.`);
  return undefined;
}

export interface FormOption {
  readonly id: string;
  readonly name: string;
  /** "Draft" beside a form that is not published yet. */
  readonly mark: string | undefined;
}

/**
 * The forms a trigger can name: the published ones, then the drafts, each once. An
 * archived form is not offered; one a trigger already names is shown by `formState`.
 */
export function formOptions(
  published: readonly { readonly id: string; readonly name: string }[],
  records: readonly FormRecord[] | undefined,
): FormOption[] {
  const live = new Set(published.map((form) => form.id));
  return [
    ...published.map((form) => ({ id: form.id, name: form.name, mark: undefined })),
    ...(records ?? [])
      .filter((form) => form.status === 'draft' && !live.has(form.id))
      .map((form) => ({ id: form.id, name: form.name, mark: i18n._(msg`Draft`) })),
  ];
}
