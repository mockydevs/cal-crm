// A Send email step's settings as its panel holds them, and back (docs/AUTOMATIONS.md). The
// contract writes the step in four ways:
//
//   inline      content written in the step: subject, body (plain text) and html
//   copy        the same, copied from a template, with where it came from (source)
//   sync        no content of its own: every send reads the linked template as it is then
//   reference   the older way of naming a template, which also sends it as it is then
//
// and, on all four, what the email says besides its content: the mailbox it is from, the
// From name, Reply-To, Cc, Bcc, the preview text and the attachments. Nothing here guesses
// a mode from a source id: the mode is what the step says it is.
import { EMAIL_CONTENT_LIMITS } from '@repo/contracts';

type Config = Readonly<Record<string, unknown>>;

export type EmailMode = 'inline' | 'copy' | 'sync' | 'reference';

export interface EmailSource {
  readonly id: string;
  readonly revision: string;
}

/** What the email says besides its content. An empty text or list is "not set". */
export interface EmailEnvelope {
  readonly mailbox: string;
  readonly fromName: string;
  readonly replyTo: string;
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly preheader: string;
  readonly attachments: readonly string[];
}

export interface EmailStep extends EmailEnvelope {
  readonly mode: EmailMode;
  /** The template a reference names (by id or name), or a copy or a sync came from. */
  readonly template: string | undefined;
  /** For a copy or a sync: the template and the revision it was copied or linked at. */
  readonly source: EmailSource | undefined;
  /** This step's own subject. On a sync or a reference, empty means the template's. */
  readonly subject: string;
  /** The plain-text part of content written here; empty on a sync or a reference. */
  readonly body: string;
  /** The formatted part beside it; nothing for a plain-text email. */
  readonly html: string | undefined;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const texts = (value: unknown): string[] =>
  Array.isArray(value)
    ? (value as readonly unknown[]).filter((each): each is string => typeof each === 'string')
    : [];

const sourceOf = (value: unknown): EmailSource | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, revision } = value as { readonly id?: unknown; readonly revision?: unknown };
  return typeof id === 'string' && typeof revision === 'string' ? { id, revision } : undefined;
};

/** Which of the four ways a step's settings are written. */
export function emailMode(config: Config): EmailMode {
  if (config['mode'] === 'sync') return 'sync';
  if (config['mode'] === 'copy') return 'copy';
  return typeof config['template'] === 'string' ? 'reference' : 'inline';
}

/** The settings as the panel holds them. */
export function emailStepOf(config: Config): EmailStep {
  const mode = emailMode(config);
  const source = mode === 'copy' || mode === 'sync' ? sourceOf(config['source']) : undefined;
  const html = text(config['html']);
  const written = mode === 'inline' || mode === 'copy';
  return {
    mode,
    template: mode === 'reference' ? text(config['template']) : source?.id,
    source,
    subject: text(config['subject']),
    body: written ? text(config['body']) : '',
    html: written && html.trim() !== '' ? html : undefined,
    mailbox: text(config['mailbox']),
    fromName: text(config['fromName']),
    replyTo: text(config['replyTo']),
    cc: texts(config['cc']),
    bcc: texts(config['bcc']),
    preheader: text(config['preheader']),
    attachments: texts(config['attachments']),
  };
}

const ENVELOPE_KEYS = [
  'purpose',
  'mailbox',
  'fromName',
  'replyTo',
  'cc',
  'bcc',
  'preheader',
  'attachments',
] as const;
const CONTENT_KEYS = ['mode', 'source', 'template', 'subject', 'body', 'html'] as const;

/** What a step says besides its content, as it is written: kept through every change of mode. */
export function envelopeOf(config: Config): Record<string, unknown> {
  return Object.fromEntries(
    ENVELOPE_KEYS.flatMap((key) => (config[key] === undefined ? [] : [[key, config[key]]])),
  );
}

/** Any member the panel does not know: kept as written, so a save loses nothing. */
function othersOf(config: Config): Record<string, unknown> {
  const known: readonly string[] = [...ENVELOPE_KEYS, ...CONTENT_KEYS];
  return Object.fromEntries(Object.entries(config).filter(([key]) => !known.includes(key)));
}

const kept = (config: Config): Record<string, unknown> => ({
  ...othersOf(config),
  ...envelopeOf(config),
});

export interface WrittenContent {
  readonly subject: string;
  readonly body: string;
  readonly html: string | undefined;
}

/**
 * The step with content written in it. A copy stays a copy, with where it came from; any
 * other step becomes content of its own. The formatted part is left out when there is none.
 */
export function withContent(config: Config, content: WrittenContent): Record<string, unknown> {
  const source = emailMode(config) === 'copy' ? sourceOf(config['source']) : undefined;
  const copy = emailMode(config) === 'copy';
  return {
    ...kept(config),
    ...(copy ? { mode: 'copy' } : {}),
    ...(source === undefined ? {} : { source }),
    subject: content.subject,
    body: content.body,
    ...(content.html === undefined || content.html.trim() === '' ? {} : { html: content.html }),
  };
}

/**
 * The step naming a template to copy. It is written as a reference: saving the action
 * copies the template into the step (the builder's copy command), which is what makes it
 * independent content with its source kept.
 */
export function withTemplate(config: Config, template: string): Record<string, unknown> {
  return { ...kept(config), template };
}

/** The step holding a copy of a template that was read here, to be edited at once. */
export function withCopy(
  config: Config,
  source: EmailSource,
  content: WrittenContent,
): Record<string, unknown> {
  return {
    ...withContent({ ...kept(config) }, content),
    mode: 'copy',
    source,
  };
}

/**
 * The step syncing with a template: it holds no content of its own. Its own subject is
 * kept when it is not empty, and stands in for the template's.
 */
export function withSync(config: Config, source: EmailSource): Record<string, unknown> {
  const subject = text(config['subject']).trim();
  const own = emailMode(config) === 'sync' || emailMode(config) === 'reference';
  return {
    ...kept(config),
    mode: 'sync',
    source,
    // A copy's subject is its template's as it was copied: it is not the step's own.
    ...(own && subject !== '' ? { subject: text(config['subject']) } : {}),
  };
}

/** The step with no content at all: quick compose, empty. */
export function withoutContent(config: Config): Record<string, unknown> {
  return { ...kept(config), subject: '', body: '' };
}

/** One member of the envelope set, or taken away when it is empty. */
export function withEnvelope(
  config: Config,
  key: (typeof ENVELOPE_KEYS)[number],
  value: string | readonly string[],
): Record<string, unknown> {
  const { [key]: _old, ...rest } = config;
  const empty = typeof value === 'string' ? value === '' : value.length === 0;
  return empty ? rest : { ...rest, [key]: typeof value === 'string' ? value : [...value] };
}

/**
 * The settings as they are saved. Text the person left empty is not written, a subject
 * that is the template's own is left out, and the preview text goes only with an email
 * that has a formatted part or sends a template (a plain-text email has no preview line).
 */
export function savedEmailConfig(config: Config): Record<string, unknown> {
  const mode = emailMode(config);
  const out = new Map(Object.entries(config));
  for (const key of ['fromName', 'replyTo', 'preheader', 'mailbox'])
    if (text(out.get(key)).trim() === '') out.delete(key);
  for (const key of ['cc', 'bcc', 'attachments']) {
    const list = texts(out.get(key))
      .map((each) => each.trim())
      .filter((each) => each !== '');
    if (list.length === 0) out.delete(key);
    else out.set(key, [...new Set(list)]);
  }
  if ((mode === 'sync' || mode === 'reference') && text(out.get('subject')).trim() === '')
    out.delete('subject');
  if (text(out.get('html')).trim() === '') out.delete('html');
  if ((mode === 'inline' || mode === 'copy') && !out.has('html')) out.delete('preheader');
  return Object.fromEntries(out);
}

/* ---------------------------------------------------------------- Cc, Bcc and Reply-To */

const MERGE_ADDRESS = /^\{\{\s*[a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\s*\}\}$/;
// As a browser's own email box reads an address: something, an at sign, a host with a dot.
const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Whether text is one address a step can copy an email to: an address, or one merge field. */
export const isCopyAddress = (value: string): boolean =>
  value.length <= EMAIL_CONTENT_LIMITS.address &&
  (ADDRESS.test(value) || MERGE_ADDRESS.test(value));

export type AddressProblem = 'not_an_address' | 'already_there' | 'too_many';

/**
 * A list of addresses after what was typed is added. Several can be typed or pasted at
 * once, set apart by commas, semicolons or spaces. Nothing is added when one of them is
 * not an address, is there already, or would pass the most a step takes.
 */
export function addAddresses(
  held: readonly string[],
  typed: string,
): { readonly list: readonly string[]; readonly problem?: AddressProblem } {
  // A merge field may hold spaces inside its braces: it is one address, never split.
  const parts = (typed.match(/\{\{[^}]*\}\}|[^\s,;]+/g) ?? []).map((each) => each.trim());
  if (parts.length === 0) return { list: held };
  if (parts.some((each) => !isCopyAddress(each))) return { list: held, problem: 'not_an_address' };
  const lower = held.map((each) => each.toLowerCase());
  const fresh = [...new Set(parts)].filter((each) => !lower.includes(each.toLowerCase()));
  if (fresh.length === 0) return { list: held, problem: 'already_there' };
  if (held.length + fresh.length > EMAIL_CONTENT_LIMITS.copies)
    return { list: held, problem: 'too_many' };
  return { list: [...held, ...fresh] };
}

/** The merge field a chip holds, by its path, or nothing for a plain address. */
export const mergePathOf = (address: string): string | undefined =>
  MERGE_ADDRESS.test(address) ? address.replace(/^\{\{\s*|\s*\}\}$/g, '') : undefined;

/* ---------------------------------------------------------------- what is still missing */

export type MissingPart = 'subject' | 'body' | 'template';

/**
 * What a step still lacks before it can be saved: content written here needs a subject and
 * a message; a step that names a template needs one named. A syncing step and a reference
 * may leave the subject out: the template's is used.
 */
export function missingEmailParts(config: Config): MissingPart[] {
  const step = emailStepOf(config);
  if (step.mode === 'reference') return step.template === '' ? ['template'] : [];
  if (step.mode === 'sync') return [];
  return [
    ...(step.subject.trim() === '' ? (['subject'] as const) : []),
    ...(step.body.trim() === '' ? (['body'] as const) : []),
  ];
}

/** Whether a step's email is linked to a template: copied from one, syncing, or naming one. */
export const linkedTemplate = (config: Config): string | undefined => {
  const step = emailStepOf(config);
  return step.template === '' ? undefined : step.template;
};
