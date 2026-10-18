import { createHash } from 'node:crypto';

import {
  simpleParser,
  type AddressObject,
  type EmailAddress,
  type HeaderLines,
  type ParsedMail,
} from 'mailparser';

/** How much of a message is read and kept. */
export const INBOUND_LIMITS = {
  /** The largest source parsed, the same cap the inbox reader fetches up to. */
  sourceBytes: 5 * 1024 * 1024,
  /** Attachments are counted, not kept; more than this is refused rather than buffered on. */
  attachments: 100,
  textChars: 1_000_000,
  /** HTML longer than this is dropped, or refused when the text would have to come from it. */
  htmlChars: 1_000_000,
  subjectChars: 998,
  nameChars: 200,
  addresses: 100,
  references: 100,
} as const;

export interface InboundAddress {
  /** Lower case, as contacts' email identities are matched. */
  readonly address: string;
  readonly name: string;
}

/**
 * Who the From header claims sent the message. It's a claim anyone can make, not proof:
 * one address, or why there isn't exactly one.
 */
export type InboundSender =
  | ({ readonly kind: 'one' } & InboundAddress)
  | { readonly kind: 'unresolved'; readonly reason: 'none' | 'multiple' | 'invalid' };

export interface InboundMessage {
  /** The one Message-ID, with its angle brackets, or null if missing, malformed or repeated. */
  readonly messageId: string | null;
  readonly inReplyTo: readonly string[];
  /** Oldest first, the newest INBOUND_LIMITS.references of them. */
  readonly references: readonly string[];
  readonly sender: InboundSender;
  readonly to: readonly InboundAddress[];
  readonly cc: readonly InboundAddress[];
  readonly replyTo: readonly InboundAddress[];
  readonly subject: string;
  /** The Date header if it is one; the sender's clock, so untrusted. */
  readonly headerDate: Date | null;
  readonly text: string;
  /** Unsanitized markup: it must never be shown without a trusted sanitizer. */
  readonly html: string | null;
  /** Auto-Submitted other than "no" (RFC 3834), or Precedence bulk, junk or auto_reply. */
  readonly automated: boolean;
  /** A delivery status notification (RFC 3464), for bounce handling. */
  readonly deliveryReport: boolean;
  /** An email feedback report (RFC 5965): a spam complaint from a feedback loop. */
  readonly feedbackReport: boolean;
  /**
   * What the receiving server found when it checked the From address (senderVerdict):
   * fail only when it says DMARC failed for the From domain, or, with no DMARC result, that
   * SPF failed and no DKIM signature of that domain passed.
   */
  readonly senderAuthentication: 'pass' | 'fail' | 'unknown';
  readonly attachmentCount: number;
  /** Set when a field was cut or dropped to fit INBOUND_LIMITS. */
  readonly truncated: boolean;
  readonly sourceSha256: Buffer;
}

export type ParsedInbound =
  | { readonly outcome: 'parsed'; readonly message: InboundMessage }
  | {
      readonly outcome: 'refused';
      readonly reason:
        'message_too_large' | 'too_many_attachments' | 'malformed' | 'html_too_large';
      readonly sourceSha256: Buffer;
    };

// msg-id = "<" id-left "@" id-right ">" (RFC 5322 3.6.4), without whitespace or brackets inside.
const MSG_ID = /<[^<>\s@]+@[^<>\s@]+>/g;
const MAX_MSG_ID = 998;
// The addr-spec forms contacts can hold: a local part, "@", and a dotted domain.
const ADDRESS = /^[^@\s<>()[\]\\,;:"]+@[^@\s<>()[\]\\,;:"]+\.[^@\s<>()[\]\\,;:".]+$/;
const MAX_ADDRESS = 320;

// mailparser keeps the last of repeated single-value headers, so repeats are counted here.
function rawValues(lines: HeaderLines, key: string): string[] {
  return lines
    .filter((line) => line.key === key)
    .map((line) =>
      line.line
        .slice(line.line.indexOf(':') + 1)
        .replace(/\r?\n[ \t]/g, ' ')
        .trim(),
    );
}

const msgIds = (value: string) =>
  (value.match(MSG_ID) ?? []).filter((id) => id.length <= MAX_MSG_ID);

function onlyMessageId(lines: HeaderLines): string | null {
  const values = rawValues(lines, 'message-id');
  if (values.length !== 1) return null;
  const ids = msgIds(values[0] ?? '');
  const [id] = ids;
  return ids.length === 1 && id !== undefined && id === values[0] ? id : null;
}

function headerDate(lines: HeaderLines): Date | null {
  const values = rawValues(lines, 'date');
  if (values.length !== 1) return null;
  const date = new Date(values[0] ?? '');
  return Number.isNaN(date.getTime()) ? null : date;
}

function mailbox(entry: EmailAddress): InboundAddress | undefined {
  const address = (entry.address ?? '').trim().toLowerCase();
  if (address.length > MAX_ADDRESS || !ADDRESS.test(address)) return undefined;
  return { address, name: entry.name.trim().slice(0, INBOUND_LIMITS.nameChars) };
}

function sender(lines: HeaderLines, from: AddressObject | undefined): InboundSender {
  const count = rawValues(lines, 'from').length;
  if (count === 0) return { kind: 'unresolved', reason: 'none' };
  if (count > 1) return { kind: 'unresolved', reason: 'multiple' };
  const entries = from?.value ?? [];
  if (entries.length > 1) return { kind: 'unresolved', reason: 'multiple' };
  const [entry] = entries;
  const parsed = entry === undefined || entry.group !== undefined ? undefined : mailbox(entry);
  return parsed === undefined
    ? { kind: 'unresolved', reason: 'invalid' }
    : { kind: 'one', ...parsed };
}

function addresses(field: AddressObject | AddressObject[] | undefined): InboundAddress[] {
  const flatten = (entries: readonly EmailAddress[]): EmailAddress[] =>
    entries.flatMap((entry) => (entry.group === undefined ? [entry] : flatten(entry.group)));
  return flatten([field ?? []].flat().flatMap((object) => object.value)).flatMap(
    (entry) => mailbox(entry) ?? [],
  );
}

function firstToken(lines: HeaderLines, key: string): string | undefined {
  const [value] = rawValues(lines, key);
  return value?.split(';')[0]?.trim().toLowerCase();
}

/** One method's result and properties in an Authentication-Results field (RFC 8601 2.2). */
interface AuthResult {
  readonly method: string;
  readonly result: string;
  readonly properties: ReadonlyMap<string, string>;
}

/** The results of one Authentication-Results value, its comments removed; [] when unreadable. */
export function authenticationResults(value: string): AuthResult[] {
  let text = value;
  // Comments may nest (RFC 5322 3.2.2); remove the innermost until none is left.
  for (let pass = 0; pass < 10 && /\([^()]*\)/.test(text); pass += 1)
    text = text.replace(/\([^()]*\)/g, ' ');
  const [, ...resinfos] = text.split(';');
  return resinfos.flatMap((resinfo): AuthResult[] => {
    const words = resinfo.trim().split(/\s+/).filter(Boolean);
    const [first, ...rest] = words;
    const result = /^([a-z0-9_-]+)(?:\/[0-9]+)?=([a-z]+)$/i.exec(first ?? '');
    if (result === null) return [];
    const properties = new Map<string, string>();
    for (const word of rest) {
      const property = /^([a-z]+\.[a-z0-9_-]+)=(.+)$/i.exec(word);
      if (property?.[1] !== undefined && property[2] !== undefined)
        properties.set(property[1].toLowerCase(), property[2].replace(/^"|"$/g, '').toLowerCase());
    }
    return [
      {
        method: (result[1] ?? '').toLowerCase(),
        result: (result[2] ?? '').toLowerCase(),
        properties,
      },
    ];
  });
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1);
// The domain a property names, from an address (smtp.mailfrom=a@b.example) or a domain.
const namedDomain = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : domainOf(value);

/**
 * The receiving server's verdict on the From address, from the topmost
 * Authentication-Results field: the one the last server, the mailbox's own, adds at the top
 * (RFC 8601 section 5). RFC 8601 asks a reader to trust only fields of a known authserv-id;
 * the CRM knows none of the providers' ids, so it acts only on a fail, which a forger can
 * claim only against mail it forged itself. A pass, or nothing, changes nothing.
 */
export function senderVerdict(
  values: readonly string[],
  sender: InboundSender,
): 'pass' | 'fail' | 'unknown' {
  const [top] = values;
  if (top === undefined || sender.kind !== 'one') return 'unknown';
  const domain = domainOf(sender.address);
  const results = authenticationResults(top);
  const about = (result: AuthResult, ...keys: string[]) =>
    keys.some((key) => namedDomain(result.properties.get(key)) === domain);
  const dmarc = results.filter((each) => each.method === 'dmarc' && about(each, 'header.from'));
  if (dmarc.some((each) => each.result === 'fail')) return 'fail';
  if (dmarc.some((each) => each.result === 'pass')) return 'pass';
  if (dmarc.length > 0) return 'unknown';
  const spfFailed = results.some(
    (each) => each.method === 'spf' && each.result === 'fail' && about(each, 'smtp.mailfrom'),
  );
  const dkimPassed = results.some(
    (each) =>
      each.method === 'dkim' && each.result === 'pass' && about(each, 'header.d', 'header.i'),
  );
  return spfFailed && !dkimPassed ? 'fail' : 'unknown';
}

function isFeedbackReport(mail: ParsedMail): boolean {
  const type = mail.headers.get('content-type');
  return (
    typeof type === 'object' &&
    'value' in type &&
    'params' in type &&
    type.value.toLowerCase() === 'multipart/report' &&
    type.params['report-type']?.toLowerCase() === 'feedback-report'
  );
}

function isDeliveryReport(mail: ParsedMail): boolean {
  const type = mail.headers.get('content-type');
  return (
    typeof type === 'object' &&
    'value' in type &&
    'params' in type &&
    type.value.toLowerCase() === 'multipart/report' &&
    type.params['report-type']?.toLowerCase() === 'delivery-status'
  );
}

/**
 * Reads one inbound message's source. Everything in it is the sender's claim: the From
 * address isn't authenticated, the Date is the sender's clock, and the HTML is unsanitized.
 * A source that can't be read is refused, so the caller can record it and go on.
 */
export async function parseInboundMessage(source: Buffer): Promise<ParsedInbound> {
  const sourceSha256 = createHash('sha256').update(source).digest();
  if (source.length > INBOUND_LIMITS.sourceBytes)
    return { outcome: 'refused', reason: 'message_too_large', sourceSha256 };
  let mail: ParsedMail;
  try {
    mail = await simpleParser(source, {
      keepCidLinks: true,
      skipImageLinks: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      maxHtmlLengthToParse: INBOUND_LIMITS.htmlChars,
    });
  } catch (error) {
    // mailparser's one error for HTML it won't convert to text (lib/mail-parser.js).
    const tooLong = error instanceof Error && error.message.startsWith('HTML too long for parsing');
    return { outcome: 'refused', reason: tooLong ? 'html_too_large' : 'malformed', sourceSha256 };
  }
  if (mail.attachments.length > INBOUND_LIMITS.attachments)
    return { outcome: 'refused', reason: 'too_many_attachments', sourceSha256 };
  const lines = mail.headerLines;
  let truncated = false;
  const cap = <T>(values: readonly T[], limit: number, keep: 'first' | 'last' = 'first'): T[] => {
    if (values.length <= limit) return [...values];
    truncated = true;
    return keep === 'first' ? values.slice(0, limit) : values.slice(-limit);
  };
  const capText = (value: string, limit: number) => {
    if (value.length <= limit) return value;
    truncated = true;
    return value.slice(0, limit);
  };

  const html = typeof mail.html === 'string' ? mail.html : null;
  const keptHtml = html !== null && html.length > INBOUND_LIMITS.htmlChars ? null : html;
  if (keptHtml !== html) truncated = true;
  const autoSubmitted = firstToken(lines, 'auto-submitted');
  const precedence = firstToken(lines, 'precedence');

  const message: InboundMessage = {
    messageId: onlyMessageId(lines),
    inReplyTo: cap(rawValues(lines, 'in-reply-to').flatMap(msgIds), INBOUND_LIMITS.references),
    references: cap(
      rawValues(lines, 'references').flatMap(msgIds),
      INBOUND_LIMITS.references,
      'last',
    ),
    sender: sender(lines, mail.from),
    to: cap(addresses(mail.to), INBOUND_LIMITS.addresses),
    cc: cap(addresses(mail.cc), INBOUND_LIMITS.addresses),
    replyTo: cap(addresses(mail.replyTo), INBOUND_LIMITS.addresses),
    subject: capText(mail.subject ?? '', INBOUND_LIMITS.subjectChars),
    headerDate: headerDate(lines),
    text: capText((mail.text ?? '').trim(), INBOUND_LIMITS.textChars),
    html: keptHtml,
    automated:
      (autoSubmitted !== undefined && autoSubmitted !== 'no') ||
      ['bulk', 'junk', 'auto_reply'].includes(precedence ?? ''),
    deliveryReport: isDeliveryReport(mail),
    feedbackReport: isFeedbackReport(mail),
    senderAuthentication: senderVerdict(
      rawValues(lines, 'authentication-results'),
      sender(lines, mail.from),
    ),
    attachmentCount: mail.attachments.length,
    truncated: false,
    sourceSha256,
  };
  return { outcome: 'parsed', message: { ...message, truncated } };
}
