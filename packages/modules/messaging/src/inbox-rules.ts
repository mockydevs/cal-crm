// The Inbox's rules as plain functions: what "needs reply" and "unread" mean, list
// positions, previews, who a reply may go from and to, and the words for why a message
// failed or waits. The database derives the first two itself (migration 0046); the
// integration tests hold it to these definitions.
import type { Issue } from '@repo/kernel';

/** A message as the definitions need it: its place in the conversation and what it is. */
export interface StoredMessage {
  /** The order it was stored in; later messages have higher numbers. */
  readonly seq: number;
  readonly direction: string;
  readonly status: string;
}

// A reply the contact never received is not a reply.
const NOT_A_REPLY = new Set(['failed', 'bounced', 'unknown']);

/**
 * Whether the contact is waiting: the last stored message that counts is theirs. Internal
 * notes don't count, and neither does a reply that failed, bounced or has unknown delivery.
 * A conversation shows it only while open.
 */
export function needsReply(messages: readonly StoredMessage[]): boolean {
  let last: StoredMessage | undefined;
  for (const message of messages) {
    if (message.direction === 'internal') continue;
    if (message.direction === 'outbound' && NOT_A_REPLY.has(message.status)) continue;
    if (last === undefined || message.seq > last.seq) last = message;
  }
  return last?.direction === 'inbound';
}

/** The contact's messages stored after the one the team read through. */
export function unreadCount(messages: readonly StoredMessage[], readThroughSeq: number): number {
  return messages.filter(
    (message) => message.direction === 'inbound' && message.seq > readThroughSeq,
  ).length;
}

export type ConversationStatus = 'open' | 'snoozed' | 'closed';

/** A snooze ends by itself: once its time has come the conversation is open again. */
export function effectiveStatus(
  status: string,
  snoozedUntil: Date | null,
  now: Date,
): ConversationStatus {
  if (status === 'open' || status === 'closed') return status;
  if (status !== 'snoozed' || snoozedUntil === null)
    throw new TypeError('Unknown conversation status.');
  return snoozedUntil.getTime() > now.getTime() ? 'snoozed' : 'open';
}

/** A place in a list ordered by a time and then an id. */
export interface Position {
  /** UTC with microseconds, as PostgreSQL holds it: 2026-10-09T09:30:00.123456Z. */
  readonly at: string;
  readonly id: string;
}

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(position: Position): string {
  if (!AT.test(position.at) || !ID.test(position.id)) throw new TypeError('Not a list position.');
  return Buffer.from(`${position.at}|${position.id}`).toString('base64url');
}

/** The position a cursor names, or undefined when the text isn't one of ours. */
export function decodeCursor(cursor: string): Position | undefined {
  const [at, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (at === undefined || id === undefined || rest.length > 0) return undefined;
  return AT.test(at) && ID.test(id) ? { at, id } : undefined;
}

/** A message's text on one line, never longer than the bound; a cut ends with an ellipsis. */
export function previewOf(text: string, maxLength: number): string {
  const line = text.replace(/[\s\p{Cc}\u200b\ufeff]+/gu, ' ').trim();
  if (line.length <= maxLength) return line;
  let cut = '';
  // By code point, so a character is never cut in half.
  for (const character of line) {
    if (cut.length + character.length > maxLength - 1) break;
    cut += character;
  }
  return `${cut.trimEnd()}…`;
}

/** What a reply was asked to use, as the database has it now. */
export interface ReplyFacts {
  readonly channel: 'email' | 'sms' | 'webchat';
  /** Whether this install can send text messages at all. */
  readonly smsAvailable: boolean;
  /** The chosen account, or undefined when this business has no such account. */
  readonly account:
    | {
        readonly channel: string;
        readonly status: string;
        /** A mailbox the business uses for conversations. */
        readonly forConversations: boolean;
        /** A number registered for text messages whose provider is connected. */
        readonly smsReady: boolean;
      }
    | undefined;
  /** The chosen address, or undefined when this business has no such address. */
  readonly recipient: { readonly kind: string; readonly contactId: string } | undefined;
  /** The conversation's contact. */
  readonly contactId: string;
  readonly textLength: number;
  /** The most a single text message can hold. */
  readonly smsTextLimit: number;
  /** The most a web chat message can hold. */
  readonly webchatTextLimit: number;
  /**
   * The conversation's web chat session, or undefined when nobody wrote in it through web
   * chat: whether the chosen account is the widget the visitor wrote through, and why a
   * reply would reach nobody now, if it would not.
   */
  readonly webchat:
    | {
        readonly widgetChosen: boolean;
        readonly silence: 'visitor_left' | 'widget_off' | undefined;
        /**
         * Do not disturb stops the reply: `all` for do not contact, `channel` for web chat
         * alone (webchatDoNotDisturb). Left out, neither is on.
         */
        readonly doNotDisturb?: 'all' | 'channel' | undefined;
      }
    | undefined;
}

/** Why do not disturb stops a web chat reply, in the composer and when one is tried. */
export const WEBCHAT_DO_NOT_DISTURB = {
  all: 'This contact is marked do not contact, so nothing can be sent.',
  channel: 'Do not disturb is on for web chat for this contact.',
} as const;

/**
 * Why a web chat reply can't be stored. It has no address to check: it goes to the one
 * visitor who wrote in the conversation, while their chat is open.
 */
function webchatRefusal(facts: ReplyFacts): Issue | undefined {
  if (facts.webchat === undefined)
    return {
      path: '/channel',
      code: 'channel_unavailable',
      message: 'Nobody wrote in this conversation through web chat, so there is no chat to answer.',
    };
  if (facts.account?.channel !== 'webchat' || !facts.webchat.widgetChosen)
    return {
      path: '/accountId',
      code: 'account_channel_mismatch',
      message: 'Choose the chat widget the visitor wrote through.',
    };
  if (facts.account.status !== 'active' || facts.webchat.silence === 'widget_off')
    return {
      path: '/accountId',
      code: 'account_unavailable',
      message: 'This chat widget is turned off. Turn it on in Settings to answer.',
    };
  if (facts.webchat.doNotDisturb !== undefined)
    return {
      path: '/channel',
      code: 'do_not_contact',
      message: WEBCHAT_DO_NOT_DISTURB[facts.webchat.doNotDisturb],
    };
  if (facts.webchat.silence === 'visitor_left')
    return {
      path: '/channel',
      code: 'visitor_left',
      message: 'The visitor has left the chat, so a reply would reach nobody.',
    };
  if (facts.textLength > facts.webchatTextLimit)
    return {
      path: '/text',
      code: 'text_too_long',
      message: `A chat message can hold ${String(facts.webchatTextLimit)} characters at most.`,
    };
  return undefined;
}

/**
 * Why a reply can't be queued, or undefined when it can. An account or address the
 * business doesn't have reads the same as one that doesn't fit, so nothing is learned
 * about another business.
 */
export function replyRefusal(facts: ReplyFacts): Issue | undefined {
  if (facts.channel === 'webchat') return webchatRefusal(facts);
  if (facts.channel === 'sms' && !facts.smsAvailable)
    return {
      path: '/channel',
      code: 'channel_unavailable',
      message: "Text messages can't be sent: this install isn't set up to deliver them.",
    };
  if (facts.account?.channel !== facts.channel)
    return {
      path: '/accountId',
      code: 'account_channel_mismatch',
      message: 'Choose an account that sends on this channel.',
    };
  if (facts.account.status !== 'active' || (facts.channel === 'sms' && !facts.account.smsReady))
    return {
      path: '/accountId',
      code: 'account_unavailable',
      message: "This account can't send right now. Check its connection in Settings.",
    };
  if (facts.channel === 'email' && !facts.account.forConversations)
    return {
      path: '/accountId',
      code: 'account_not_for_conversations',
      message:
        "This mailbox isn't used for conversations. Choose another, or change it in Settings.",
    };
  if (facts.recipient?.contactId !== facts.contactId)
    return {
      path: '/to',
      code: 'recipient_not_in_conversation',
      message: "Choose one of this contact's own addresses or numbers.",
    };
  if (facts.recipient.kind !== (facts.channel === 'email' ? 'email' : 'phone'))
    return {
      path: '/to',
      code: 'recipient_channel_mismatch',
      message:
        facts.channel === 'email'
          ? 'Choose an email address for an email.'
          : 'Choose a phone number for a text message.',
    };
  if (facts.channel === 'sms' && facts.textLength > facts.smsTextLimit)
    return {
      path: '/text',
      code: 'text_too_long',
      message: `A text message can hold ${String(facts.smsTextLimit)} characters at most.`,
    };
  return undefined;
}

export interface Reason {
  readonly code: string;
  readonly message: string;
}

const lookup = <Value>(
  words: Readonly<Record<string, Value>>,
  key: string | null,
): Value | undefined => (key !== null && Object.hasOwn(words, key) ? words[key] : undefined);

const SUPPRESSED: Readonly<Record<string, string>> = {
  hard_bounce: 'Not sent: an earlier message to this address bounced, so it is blocked.',
  complaint: 'Not sent: this address reported an earlier message as spam, so it is blocked.',
  unsubscribe: 'Not sent: this address unsubscribed, so it is blocked.',
  invalid: 'Not sent: this address or number is not valid, so it is blocked.',
  manual: 'Not sent: someone on the team blocked this address.',
};

/** Do not contact for one channel only, chosen by the stored detail (outbound.ts). */
const CHANNEL_DO_NOT_DISTURB = 'Not sent: do not disturb is on for this channel for this contact.';

const PROBLEMS: Readonly<Record<string, string>> = {
  contact_inactive: 'Not sent: this contact is in the trash.',
  sender_inactive: 'Not sent: the sending account or the business is not active.',
  do_not_contact: 'Not sent: this contact is marked do not contact.',
  suppressed: 'Not sent: this address is blocked.',
  consent_withdrawn: 'Not sent: this contact withdrew their agreement to receive these messages.',
  consent_required: "Not sent: this contact hasn't agreed to receive messages on this channel.",
  timing_unknown:
    'Not sent: quiet hours are on and neither this contact nor the business has a time zone we can use. Set one, then send again.',
  recipient_changed: "Not sent: the contact's address changed after this was written.",
  delivery_rejected: "Not sent: the sending account's server refused the message.",
  delivery_unknown:
    'We could not confirm whether this was delivered. It was not sent again, to avoid a duplicate. Check with the contact before sending it again.',
  unsupported_channel: "Not sent: this channel can't send messages yet.",
  unsubscribe_unavailable:
    'Not sent: marketing mail needs a secure public address for unsubscribing.',
  postal_address_missing:
    'Not sent: marketing email must show your postal address (CAN-SPAM). Add it in Settings, Business profile.',
  mailbox_unavailable: 'Not sent: the mailbox it was to be sent from is no longer connected.',
  mailbox_use_disabled: "Not sent: the mailbox isn't set to be used for this kind of message.",
  hard_bounce: 'Bounced: the address does not exist or refuses mail. It is now blocked.',
  soft_bounce: "Bounced: the recipient's server could not accept it for now.",
  status_callback_unavailable:
    'Not sent: text messages need a public address the provider can report delivery to.',
  sms_body_too_long: 'Not sent: the text message is too long.',
  sms_number_unavailable: "Not sent: the number it was to be sent from can't send text messages.",
  sms_connection_unavailable: 'Not sent: the text message provider is not connected.',
  provider_failed: 'Not delivered: the text message provider could not deliver it.',
};

const FALLBACK: Readonly<Record<string, Reason>> = {
  failed: { code: 'failed', message: 'This message was not sent.' },
  bounced: { code: 'bounced', message: 'This message bounced.' },
  unknown: { code: 'delivery_unknown', message: PROBLEMS['delivery_unknown'] ?? '' },
};

/**
 * Why a message failed, bounced or has unknown delivery, from the pipeline's recorded
 * code. Stored detail is used only to choose among known wordings, never shown.
 */
export function problemReason(
  status: string,
  code: string | null,
  detail: string | null,
): Reason | null {
  const fallback = lookup(FALLBACK, status);
  if (fallback === undefined) return null;
  if (code === null) return fallback;
  // The provider's own error number (sms-callbacks.ts) is one reason here.
  const named = code.startsWith('twilio_') ? 'provider_failed' : code;
  const known = lookup(PROBLEMS, named);
  // A reason this version has no words for is answered with the status's general one.
  if (known === undefined) return fallback;
  return {
    code: named,
    message:
      (named === 'suppressed'
        ? lookup(SUPPRESSED, detail)
        : named === 'do_not_contact' && detail === 'channel'
          ? CHANNEL_DO_NOT_DISTURB
          : undefined) ?? known,
  };
}

/** Every code problemReason can give: the known reasons and each status's general one. */
export const problemCodes: readonly string[] = [
  ...Object.keys(PROBLEMS),
  ...Object.values(FALLBACK).map((reason) => reason.code),
].filter((code, index, all) => all.indexOf(code) === index);

const HOLDS: Readonly<Record<string, string>> = {
  quiet_hours: 'Waiting: it is quiet hours where this contact is. It will be sent when they end.',
  frequency_cap:
    'Waiting: this contact has had the most messages allowed in a day. It will be sent when there is room.',
  mailbox_daily_limit:
    'Waiting: the mailbox reached its daily limit. It will be sent when there is room.',
  mailbox_warmup_limit:
    "Waiting: the mailbox reached today's warm-up limit. It will be sent when there is room.",
  mailbox_pacing: 'Waiting: the mailbox sends a few messages a minute. It will be sent shortly.',
  provider_temporary:
    "Waiting: the mailbox's server asked us to slow down. It will be tried again shortly.",
};

/** Why a queued message is waiting, or null when it is simply in the queue. */
export function heldReason(status: string, code: string | null): Reason | null {
  if (status !== 'queued' || code === null) return null;
  const known = lookup(HOLDS, code);
  return known === undefined
    ? { code: 'waiting', message: 'Waiting to be sent.' }
    : { code, message: known };
}

/** Every code heldReason can give. */
export const holdCodes: readonly string[] = [...Object.keys(HOLDS), 'waiting'];

/** A message's text, cut at the bound without splitting a character. */
export function boundText(
  text: string,
  maxLength: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false };
  let cut = '';
  for (const character of text) {
    if (cut.length + character.length > maxLength) break;
    cut += character;
  }
  return { text: cut, truncated: true };
}

/** What the composer offers as the subject of an answer to the last email. */
export function replySubject(subject: string | null): string | null {
  const line = previewOf(subject ?? '', Number.MAX_SAFE_INTEGER);
  if (line === '') return null;
  return boundText(/^re:/i.test(line) ? line : `Re: ${line}`, 998).text;
}

/**
 * The channel the composer starts on: the one the contact last wrote on, when a reply can
 * go that way now, and otherwise the first that can send, in the order they are offered.
 * Null when nothing can be sent at all. The person writing can always choose another.
 */
export function suggestedChannel<Channel extends string>(
  lastInbound: string | null,
  offered: readonly { readonly channel: Channel; readonly available: boolean }[],
): Channel | null {
  const usable = offered.filter((each) => each.available);
  return (usable.find((each) => each.channel === lastInbound) ?? usable[0])?.channel ?? null;
}
