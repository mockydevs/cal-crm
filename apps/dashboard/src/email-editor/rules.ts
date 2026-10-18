// What the email editor works out besides the formatted text itself (rich-text.tsx): the
// email it holds, whether it changed, how large it is against what the server takes, which
// of its merge fields nothing can fill in, the plain-text part that goes beside the
// formatted one, and the colours its tools offer.
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { EMAIL_CONTENT_LIMITS } from '@repo/contracts';
import { isEmptyHtml, mergePathsIn, textOfHtml } from './email-html';

/** The merge field a workflow email's own unsubscribe link is written as. */
export const UNSUBSCRIBE_FIELD = 'email.unsubscribe_link';

export interface FieldGroupChoice {
  /** The heading the fields are listed under, such as "Contact". */
  readonly label: string;
  readonly fields: readonly { readonly path: string; readonly label: string }[];
}

/** An email as the editor holds it. */
export interface EmailDocument {
  readonly subject: string;
  /** The preview line mail apps show after the subject; formatted emails only. */
  readonly preheader: string;
  /** The formatted part as it is saved, or nothing for a plain-text email. */
  readonly html: string | undefined;
  /** The plain-text part: the whole message of a plain-text email. */
  readonly text: string;
  /**
   * Whether the author writes the plain-text part of a formatted email themselves. While
   * they do not, it is written from the formatted part.
   */
  readonly ownText: boolean;
}

export const emptyDocument: EmailDocument = {
  subject: '',
  preheader: '',
  html: '',
  text: '',
  ownText: false,
};

/**
 * A stored email as the editor opens it. The author is taken to have written the
 * plain-text part themselves when it is not what the formatted part reads as.
 */
export function documentOf(stored: {
  readonly subject: string;
  readonly preheader?: string | null | undefined;
  readonly html?: string | null | undefined;
  readonly text: string;
}): EmailDocument {
  const html = stored.html ?? undefined;
  return {
    subject: stored.subject,
    preheader: stored.preheader ?? '',
    html,
    text: stored.text,
    ownText:
      html !== undefined && stored.text.trim() !== '' && stored.text.trim() !== textOfHtml(html),
  };
}

/** The plain-text part that is sent: the author's own, or the formatted part as text. */
export function textPartOf(document: EmailDocument): string {
  if (document.html === undefined) return document.text;
  return document.ownText && document.text.trim() !== ''
    ? document.text
    : textOfHtml(document.html);
}

/** Whether two emails are the same to save. */
export function sameDocument(left: EmailDocument, right: EmailDocument): boolean {
  return (
    left.subject === right.subject &&
    left.preheader === right.preheader &&
    (left.html ?? null) === (right.html ?? null) &&
    textPartOf(left) === textPartOf(right)
  );
}

/** The content as the contract's pairing: plain text, or HTML with its text part. */
export function contentOf(
  document: EmailDocument,
):
  | { readonly format: 'text'; readonly text: string }
  | { readonly format: 'html'; readonly html: string; readonly text?: string } {
  if (document.html === undefined) return { format: 'text', text: document.text };
  // Left out, the server writes the text part from the HTML it cleaned.
  return document.ownText && document.text.trim() !== ''
    ? { format: 'html', html: document.html, text: document.text }
    : { format: 'html', html: document.html };
}

export type DocumentProblem =
  | 'subject_missing'
  | 'subject_long'
  | 'body_missing'
  | 'html_long'
  | 'text_long'
  | 'preheader_long';

/** What stops an email being saved, in the order it is said. */
export function documentProblems(
  document: EmailDocument,
  /** A step that sends a template may leave its subject to the template. */
  subjectRequired = true,
  subjectLimit = 255,
): DocumentProblem[] {
  const problems: DocumentProblem[] = [];
  if (subjectRequired && document.subject.trim() === '') problems.push('subject_missing');
  if (document.subject.length > subjectLimit) problems.push('subject_long');
  const empty =
    document.html === undefined ? document.text.trim() === '' : isEmptyHtml(document.html);
  if (empty) problems.push('body_missing');
  if ((document.html ?? '').length > EMAIL_CONTENT_LIMITS.html) problems.push('html_long');
  if (textPartOf(document).length > EMAIL_CONTENT_LIMITS.text) problems.push('text_long');
  if (document.preheader.length > EMAIL_CONTENT_LIMITS.preheader) problems.push('preheader_long');
  return problems;
}

export interface SizeMeter {
  readonly used: number;
  readonly limit: number;
  /** From nine tenths of the limit, the meter says so. */
  readonly near: boolean;
  readonly over: boolean;
}

/** How much of what the server takes an email uses: its formatted part, else its text. */
export function sizeOf(document: EmailDocument): SizeMeter {
  const formatted = document.html !== undefined;
  const used = document.html === undefined ? document.text.length : document.html.length;
  const limit = formatted ? EMAIL_CONTENT_LIMITS.html : EMAIL_CONTENT_LIMITS.text;
  return { used, limit, near: used >= limit * 0.9, over: used > limit };
}

/** The merge fields an email uses, each once: subject, preview text, then the message. */
export function fieldsUsed(document: EmailDocument): string[] {
  return mergePathsIn(
    [document.subject, document.preheader, document.html ?? '', textPartOf(document)].join('\n'),
  );
}

/** The merge fields an email uses that nothing here can fill in. */
export function unknownFields(
  document: EmailDocument,
  isKnown: (path: string) => boolean,
): string[] {
  return fieldsUsed(document).filter((path) => !isKnown(path));
}

export interface PaletteColour {
  readonly value: string;
  /** Its name, for the eight of the palette; a brand colour is named by its value. */
  readonly name: string;
  readonly brand: boolean;
}

// A restrained palette: each reads on white as text (4.5 to 1 or better), bar the yellow,
// which is for highlighting.
const PALETTE: readonly (readonly [string, MessageDescriptor])[] = [
  ['#111827', msg`Black`],
  ['#4b5563', msg`Grey`],
  ['#b91c1c', msg`Red`],
  ['#c2410c', msg`Orange`],
  ['#15803d', msg`Green`],
  ['#1d4ed8', msg`Blue`],
  ['#7e22ce', msg`Purple`],
  ['#fef08a', msg`Yellow`],
];

/** The colours a tool offers: the business's own first, each once, then the palette. */
export function paletteWith(brand: readonly string[]): PaletteColour[] {
  const own = [...new Set(brand.map((each) => each.trim().toLowerCase()))].filter((each) =>
    /^#[0-9a-f]{6}$/.test(each),
  );
  return [
    ...own.map((value) => ({ value, name: value, brand: true })),
    ...PALETTE.filter(([value]) => !own.includes(value)).map(([value, name]) => ({
      value,
      name: i18n._(name),
      brand: false,
    })),
  ];
}
