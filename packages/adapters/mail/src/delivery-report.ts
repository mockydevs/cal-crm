import {
  simpleParser,
  type Attachment,
  type ParsedMail,
  type SimpleParserOptions,
} from 'mailparser';

import { INBOUND_LIMITS } from './inbound-message.js';

/** How much of a delivery report is read. Anything larger isn't acted on. */
export const DELIVERY_REPORT_LIMITS = {
  /** The message/delivery-status part. */
  statusBytes: 64 * 1024,
  /** The returned message's header block, up to its first blank line. */
  headerBytes: 64 * 1024,
  /** Per-recipient groups in one report. */
  recipients: 100,
  mtaNameChars: 255,
} as const;

/** RFC 3464 section 2.3.3. */
export type DeliveryAction = 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded';

/**
 * A delivery the reporting server gave up on. Hard: the address itself is bad, so it's
 * never worth another message. Soft: anything else that failed.
 */
export type BounceKind = 'hard' | 'soft';

export interface DeliveryRecipient {
  /** Lower case; null unless it's an rfc822 address a contact could hold. */
  readonly finalRecipient: string | null;
  /** The address as the sender gave it, when the report carries one. Same rules. */
  readonly originalRecipient: string | null;
  readonly action: DeliveryAction;
  /** The Status field as reported (RFC 3463): class.subject.detail. */
  readonly reportedStatus: string;
  /**
   * The status the classification used: the reported one, or the enhanced code of an smtp
   * Diagnostic-Code of the same class when the reported one is only X.0.0.
   */
  readonly status: string;
  readonly bounce: BounceKind | null;
}

export interface DeliveryReport {
  readonly reportingMta: { readonly type: string; readonly name: string };
  /**
   * The Message-ID of the returned message, with its angle brackets. It links the report to
   * a message; it proves neither that the report is genuine nor that the message was sent.
   */
  readonly originalMessageId: string | null;
  readonly recipients: readonly DeliveryRecipient[];
}

// status-code = class "." subject "." detail, without leading zeros (RFC 3463 section 2).
const STATUS = /^([245])\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
// An SMTP reply code and its enhanced status code, as RFC 2034 puts them on a reply line.
const SMTP_REPLY = /^([245])\d\d[ -]([245]\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2}))(?:[ \t]|$)/;
const ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/;
// The same forms inbound mail accepts for a contact's address.
const ADDRESS = /^[^@\s<>()[\]\\,;:"]+@[^@\s<>()[\]\\,;:"]+\.[^@\s<>()[\]\\,;:".]+$/;
const MAX_ADDRESS = 320;
const MSG_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;
const MAX_MSG_ID = 998;
const ACTIONS: readonly string[] = ['failed', 'delayed', 'delivered', 'relayed', 'expanded'];

/**
 * The statuses that say the address itself is bad (RFC 3463 section 3.2, each "only useful
 * for permanent failures"; 5.1.10 is the null MX of RFC 7505): no such mailbox, no such
 * domain, bad syntax, mailbox moved, domain accepts no mail. And 5.2.1, a disabled mailbox
 * (section 3.3: "a permanent error if the mailbox will never be re-enabled"), which in
 * class 5 the reporting server says it is.
 */
const HARD_STATUSES: readonly string[] = ['5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10', '5.2.1'];

/**
 * What servers write when they give an undefined or other status for a mailbox that does
 * not exist or was shut (Exchange's 5.0.0 "User unknown", Microsoft 365's 5.4.1 "Recipient
 * address rejected", Gmail's "account disabled"), as words of their reply. Read only for a
 * class 5 failure whose status names no other reason: never a policy or security refusal
 * (X.7.X, RFC 3463 section 3.8), which is about the sender, or a full mailbox (X.2.2).
 */
const DEAD_ADDRESS_WORDS =
  /\b(?:user unknown|unknown user|no such user|user not found|unknown recipient|recipient not found|recipientnotfound|recipient unknown|invalid recipient|no such recipient|recipient address rejected|mailbox not found|no such mailbox|mailbox does not exist|does not exist|account disabled|account has been disabled|account is disabled|mailbox disabled|mailbox is disabled|inactive user|user inactive|account inactive)\b/i;

const isAction = (value: string): value is DeliveryAction => ACTIONS.includes(value);

/**
 * Whether a recipient's result is a bounce, and which kind.
 *
 * Only "failed" is a bounce: "delayed" is still being tried, and the other actions are
 * successes. A failed class 5 status is hard when it names a bad or disabled address, or
 * when the server's own words say so (DEAD_ADDRESS_WORDS) and the status is not a policy
 * refusal. Every other failure is soft: class 4 was temporary, a full mailbox is "a
 * persistent transient failure" (RFC 3463 section 3.3, X.2.2), and a refusal by policy
 * such as 5.7.1 says nothing about the address. Repeated soft bounces are counted by the
 * caller (bounces.ts). A failed action with a success status contradicts itself.
 */
export function classifyDelivery(
  action: DeliveryAction,
  status: string,
  diagnostic?: string,
): BounceKind | null {
  const match = STATUS.exec(status);
  if (action !== 'failed' || match === null || match[1] === '2') return null;
  if (HARD_STATUSES.includes(status)) return 'hard';
  const words = diagnostic ?? '';
  // Words count only where the status itself names no reason about the mailbox: undefined
  // (X.0.X, X.2.0), address (X.1.X), routing (X.4.X) or protocol (X.5.X).
  const vague = ['0', '1', '4', '5'].includes(match[2] ?? '') || status === '5.2.0';
  return match[1] === '5' && vague && DEAD_ADDRESS_WORDS.test(words) ? 'hard' : 'soft';
}

type Fields = ReadonlyMap<string, readonly string[]>;

/**
 * Splits a message/delivery-status body into its groups of fields (RFC 3464 section 2.1):
 * blank lines separate groups, and a line starting with a space or tab continues the one
 * before. A line that is neither makes the body unreadable.
 */
function fieldGroups(body: string): Fields[] | null {
  const groups: Map<string, string[]>[] = [];
  let group: Map<string, string[]> | undefined;
  let last: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '') {
      group = undefined;
      last = undefined;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      const value = last?.pop();
      if (last === undefined || value === undefined) return null;
      last.push(`${value} ${line.trim()}`.trim());
      continue;
    }
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).toLowerCase();
    if (colon < 1 || !ATOM.test(name)) return null;
    if (group === undefined) {
      group = new Map();
      groups.push(group);
    }
    last = group.get(name) ?? [];
    last.push(line.slice(colon + 1).trim());
    group.set(name, last);
  }
  return groups;
}

/** The field's value when the group has it exactly once; undefined when absent. */
function once(fields: Fields, name: string): string | null | undefined {
  const values = fields.get(name);
  if (values === undefined) return undefined;
  const [value] = values;
  return values.length === 1 && value !== undefined ? value : null;
}

/** A "type; value" field (RFC 3464 section 2.1.2), the type in lower case. */
function typed(value: string): { type: string; value: string } | null {
  const semicolon = value.indexOf(';');
  const type = value.slice(0, semicolon).trim().toLowerCase();
  if (semicolon < 1 || !ATOM.test(type)) return null;
  return { type, value: value.slice(semicolon + 1).trim() };
}

// A comment in parentheses may follow a status or an action (RFC 3464 sections 2.1.1, 2.3.4).
const withoutComment = (value: string) => value.replace(/\s*\([^()]*\)$/, '').trim();

function address(value: string): string | null {
  const parsed = typed(value);
  if (parsed?.type !== 'rfc822') return null;
  const lower = parsed.value.toLowerCase();
  return lower.length <= MAX_ADDRESS && ADDRESS.test(lower) ? lower : null;
}

/**
 * A more exact status from the remote server's own reply, used only when the reported
 * status says nothing but its class (X.0.0, RFC 3463 section 3.1) and the reply code and
 * its enhanced code are both of that same class (RFC 2034 section 4).
 */
function refined(reported: string, diagnostic: string | null | undefined): string {
  const parsed = typeof diagnostic === 'string' ? typed(diagnostic) : null;
  if (!/^[245]\.0\.0$/.test(reported) || parsed?.type !== 'smtp') return reported;
  const reply = SMTP_REPLY.exec(parsed.value);
  const enhanced = reply?.[2];
  if (reply === null || enhanced === undefined) return reported;
  return reply[1] === reported[0] && enhanced.startsWith(`${reported[0] ?? ''}.`)
    ? enhanced
    : reported;
}

/** One per-recipient group, or null when it isn't exactly what RFC 3464 section 2.3 requires. */
function recipient(fields: Fields): DeliveryRecipient | null {
  const final = once(fields, 'final-recipient');
  const original = once(fields, 'original-recipient');
  const actionValue = once(fields, 'action');
  const statusValue = once(fields, 'status');
  const diagnostic = once(fields, 'diagnostic-code');
  // Required once each; the optional ones at most once. A repeat is never resolved by guessing.
  if (typeof final !== 'string' || typeof actionValue !== 'string') return null;
  if (typeof statusValue !== 'string' || original === null || diagnostic === null) return null;
  const action = withoutComment(actionValue).toLowerCase();
  const reportedStatus = withoutComment(statusValue);
  if (!isAction(action) || !STATUS.test(reportedStatus)) return null;
  const status = refined(reportedStatus, diagnostic);
  return {
    finalRecipient: address(final),
    originalRecipient: original === undefined ? null : address(original),
    action,
    reportedStatus,
    status,
    bounce: classifyDelivery(
      action,
      status,
      typeof diagnostic === 'string' ? diagnostic : undefined,
    ),
  };
}

function reportOf(body: Buffer): Omit<DeliveryReport, 'originalMessageId'> | null {
  if (body.length > DELIVERY_REPORT_LIMITS.statusBytes) return null;
  const groups = fieldGroups(body.toString('latin1'));
  const [message, ...rest] = groups ?? [];
  if (message === undefined || rest.length > DELIVERY_REPORT_LIMITS.recipients) return null;
  // Required, at most once (RFC 3464 sections 2.2 and 2.2.2).
  const mta = once(message, 'reporting-mta');
  const reportingMta = typeof mta === 'string' ? typed(mta) : null;
  if (reportingMta === null || reportingMta.value === '') return null;
  if (reportingMta.value.length > DELIVERY_REPORT_LIMITS.mtaNameChars) return null;
  return {
    reportingMta: { type: reportingMta.type, name: reportingMta.value },
    // A group that can't be read is left out; the readable ones still count.
    recipients: rest.flatMap((fields) => recipient(fields) ?? []),
  };
}

/** The one Message-ID in a returned message's header block, read up to the first blank line. */
function returnedMessageId(content: Buffer): string | null {
  const text = content.subarray(0, DELIVERY_REPORT_LIMITS.headerBytes + 4).toString('latin1');
  const end = /\r?\n\r?\n/.exec(text)?.index ?? text.length;
  if (end > DELIVERY_REPORT_LIMITS.headerBytes) return null;
  const unfolded = text.slice(0, end).replace(/\r?\n[ \t]+/g, ' ');
  const ids = unfolded
    .split(/\r?\n/)
    .filter((line) => /^message-id[ \t]*:/i.test(line))
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
  const [id] = ids;
  return ids.length === 1 && id !== undefined && id.length <= MAX_MSG_ID && MSG_ID.test(id)
    ? id
    : null;
}

function isReport(mail: ParsedMail): boolean {
  const type = mail.headers.get('content-type');
  return (
    typeof type === 'object' &&
    'value' in type &&
    'params' in type &&
    type.value.toLowerCase() === 'multipart/report' &&
    type.params['report-type']?.toLowerCase() === 'delivery-status'
  );
}

const RETURNED_TYPES: readonly string[] = ['message/rfc822', 'text/rfc822-headers'];
const typeOf = (part: Attachment) => part.contentType.toLowerCase();

/**
 * Reads a delivery status notification (RFC 3464). Null when the source isn't one, or is one
 * that can't be read with certainty: a wrong reading could suppress a real customer, so
 * nothing here is guessed. Everything returned is still the reporting server's claim, which
 * anyone can forge; the caller decides what it may change.
 *
 * No free text from the report is returned: the human-readable part and the diagnostic text
 * can quote addresses and message content.
 */
export async function parseDeliveryReport(source: Buffer): Promise<DeliveryReport | null> {
  if (source.length > INBOUND_LIMITS.sourceBytes) return null;
  // mailsplit's ignoreEmbedded (its README, message-splitter.js) keeps a returned
  // message/rfc822 whole even when it's marked inline; @types/mailparser doesn't list it.
  const options: SimpleParserOptions & { readonly ignoreEmbedded: boolean } = {
    keepDeliveryStatus: true,
    ignoreEmbedded: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipImageLinks: true,
    keepCidLinks: true,
  };
  let mail: ParsedMail;
  try {
    mail = await simpleParser(source, options);
  } catch {
    return null;
  }
  if (!isReport(mail)) return null;
  // The status is the second top-level part and the returned message the third (RFC 3464
  // section 2); mailparser numbers parts that way. A report with two statuses is ambiguous.
  const statuses = mail.attachments.filter((part) => typeOf(part) === 'message/delivery-status');
  const [status] = statuses;
  if (statuses.length !== 1 || status?.partId !== '2') return null;
  const report = reportOf(status.content);
  if (report === null) return null;
  const returned = mail.attachments.find((part) => part.partId === '3');
  return {
    ...report,
    originalMessageId:
      returned !== undefined && RETURNED_TYPES.includes(typeOf(returned))
        ? returnedMessageId(returned.content)
        : null,
  };
}

/** An abuse report from a mailbox provider's feedback loop (RFC 5965), as far as it is read. */
export interface FeedbackReport {
  /** The Feedback-Type, in lower case: "abuse" is a spam complaint (RFC 5965 section 7.3). */
  readonly feedbackType: string;
  /** The reported message's Message-ID, with its angle brackets, from its returned header. */
  readonly originalMessageId: string | null;
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

/**
 * Reads an email feedback report (RFC 5965, the Abuse Reporting Format Yahoo's and
 * Microsoft's feedback loops send): a multipart/report with report-type feedback-report,
 * whose second part is message/feedback-report with exactly one Feedback-Type field, and
 * whose third part returns the reported message or its header block. Null when the source
 * isn't one or can't be read with certainty. Like a bounce, it is the reporter's claim:
 * the caller acts only on a message of its own that the report returns.
 */
export async function parseFeedbackReport(source: Buffer): Promise<FeedbackReport | null> {
  if (source.length > INBOUND_LIMITS.sourceBytes) return null;
  const options: SimpleParserOptions & { readonly ignoreEmbedded: boolean } = {
    ignoreEmbedded: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipImageLinks: true,
    keepCidLinks: true,
  };
  let mail: ParsedMail;
  try {
    mail = await simpleParser(source, options);
  } catch {
    return null;
  }
  if (!isFeedbackReport(mail)) return null;
  const reports = mail.attachments.filter((part) => typeOf(part) === 'message/feedback-report');
  const [report] = reports;
  if (reports.length !== 1 || report?.partId !== '2') return null;
  if (report.content.length > DELIVERY_REPORT_LIMITS.statusBytes) return null;
  const [fields, ...rest] = fieldGroups(report.content.toString('latin1')) ?? [];
  if (fields === undefined || rest.length > 0) return null;
  const feedbackType = once(fields, 'feedback-type');
  if (typeof feedbackType !== 'string' || !ATOM.test(feedbackType)) return null;
  const returned = mail.attachments.find((part) => part.partId === '3');
  return {
    feedbackType: feedbackType.toLowerCase(),
    originalMessageId:
      returned !== undefined && RETURNED_TYPES.includes(typeOf(returned))
        ? returnedMessageId(returned.content)
        : null,
  };
}
