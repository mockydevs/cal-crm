// What the template editor works out without the server: where a merge field goes in the
// text, which fields an author can use, what a draft would read as for a sample contact,
// and what someone else's save changed. Plain text throughout.
import {
  contactMergeFields,
  mergeTokens,
  previewMessageTemplate,
  type MessageTemplatePreview,
} from '@repo/contracts';

/** What the form holds. */
export interface TemplateDraft {
  readonly name: string;
  readonly subject: string;
  readonly body: string;
}

export const emptyDraft: TemplateDraft = { name: '', subject: '', body: '' };

/** A merge field an author can insert: its path, and a custom field's own name. */
export interface MergeField {
  readonly path: string;
  readonly label: string | undefined;
}

/** A field definition as GET /fields lists it, as far as merge fields need. */
export interface FieldSource {
  readonly objectKey: string;
  readonly key: string;
  readonly label: string;
  readonly archived: boolean;
}

/**
 * The contact fields a send can fill in: the built-in ones, then the business's own live
 * contact fields. Other objects' fields aren't offered, since a send has only the contact.
 */
export function mergeFieldsOf(fields: readonly FieldSource[]): MergeField[] {
  return [
    ...contactMergeFields.map((path) => ({ path, label: undefined })),
    ...fields
      .filter((field) => field.objectKey === 'contact' && !field.archived)
      .map((field) => ({ path: `contact.custom.${field.key}`, label: field.label })),
  ];
}

/** The text with a merge field put where the selection was, and where the caret goes next. */
export function insertMergeField(
  text: string,
  selection: { readonly start: number; readonly end: number },
  path: string,
): { readonly text: string; readonly caret: number } {
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  const token = `{{${path}}}`;
  return { text: text.slice(0, start) + token + text.slice(end), caret: start + token.length };
}

/** Whether the form differs from what it started from. */
export function isChanged(draft: TemplateDraft, base: TemplateDraft): boolean {
  return draft.name !== base.name || draft.subject !== base.subject || draft.body !== base.body;
}

/**
 * The merge fields a draft uses that a send could never fill in: not a contact field of
 * this business. Undefined custom fields means the list couldn't be read, so only fields
 * that are certainly wrong are named.
 */
export function unknownFields(
  draft: TemplateDraft,
  known: readonly MergeField[] | undefined,
): string[] {
  const builtIn = new Set<string>(contactMergeFields);
  const all = known === undefined ? undefined : new Set(known.map((field) => field.path));
  return mergeTokens(draft).filter((path) =>
    all === undefined ? !builtIn.has(path) && !path.startsWith('contact.custom.') : !all.has(path),
  );
}

/**
 * Sample values for the built-in fields, as a send reads them: dates are ISO text. The
 * names come from the caller, in the reader's language.
 */
export const builtInSamples = (person: {
  readonly firstName: string;
  readonly lastName: string;
}): Readonly<Record<string, string>> => ({
  'contact.firstName': person.firstName,
  'contact.lastName': person.lastName,
  'contact.name': `${person.firstName} ${person.lastName}`,
  'contact.email': 'ada@example.com',
  'contact.phone': '+254712345678',
  'contact.tags': 'VIP',
  'contact.source': 'website',
  'contact.type': 'lead',
  'contact.createdAt': '2026-01-15T09:30:00.000Z',
  'contact.updatedAt': '2026-02-01T14:00:00.000Z',
  'contact.emailVerification': 'valid',
  'contact.emailVerified': 'true',
});

/**
 * The sample value of each field a draft uses: what the author typed, else the built-in
 * sample, else nothing. A field with nothing stays empty, so the preview says so.
 */
export function sampleValuesOf(
  draft: TemplateDraft,
  typed: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    mergeTokens(draft).map((path) => [path, typed[path] ?? defaults[path] ?? '']),
  );
}

/** The draft as a send would fill it in, or the fields that would stop the send. */
export function previewDraft(
  draft: TemplateDraft,
  typed: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): MessageTemplatePreview {
  return previewMessageTemplate(draft, sampleValuesOf(draft, typed, defaults));
}

export type DraftField = keyof TemplateDraft;

/** One part someone else's save changed: as the form started, and as it's saved now. */
export interface SavedChange {
  readonly field: DraftField;
  readonly before: string;
  readonly saved: string;
  /** Whether the form also changed this part, so keeping one drops the other. */
  readonly clashes: boolean;
}

/**
 * What someone else's save changed since the form was opened, part by part, and whether
 * each clashes with what was typed here.
 */
export function savedChanges(
  base: TemplateDraft,
  saved: TemplateDraft,
  draft: TemplateDraft,
): SavedChange[] {
  const fields: readonly DraftField[] = ['name', 'subject', 'body'];
  return fields
    .filter((field) => base[field] !== saved[field])
    .map((field) => ({
      field,
      before: base[field],
      saved: saved[field],
      clashes: draft[field] !== base[field] && draft[field] !== saved[field],
    }));
}

/**
 * The form after someone else's save, keeping what was typed here: parts only they
 * changed take their text, and parts changed here keep this form's.
 */
export function reapply(
  base: TemplateDraft,
  saved: TemplateDraft,
  draft: TemplateDraft,
): TemplateDraft {
  const pick = (field: DraftField): string =>
    draft[field] === base[field] ? saved[field] : draft[field];
  return { name: pick('name'), subject: pick('subject'), body: pick('body') };
}
