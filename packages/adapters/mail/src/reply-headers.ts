// The two headers that put a reply in its thread: In-Reply-To and References (RFC 5322
// section 3.6.4). What goes into them was written by whoever sent the mail being answered,
// so every id is held to the msg-id grammar before it can reach a header of ours. One that
// doesn't fit is left out: nothing is cut, unfolded, re-bracketed or otherwise repaired.

/** How much a reply's threading headers may hold. */
export const REPLY_HEADER_LIMITS = {
  /**
   * The longest id used, angle brackets included. Three of them, the fewest a trimmed
   * References keeps, fit its one line with room to spare: 12 + 3 x 320 + 2 = 974.
   */
  msgIdChars: 320,
  /** A header's length unfolded, its name included: the most a line may hold (RFC 5322 2.1.1). */
  headerChars: 998,
} as const;

// RFC 5322 3.2.3: the printable ASCII characters that are not specials.
const ATEXT = /[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]/.source;
const DOT_ATOM_TEXT = `${ATEXT}+(?:[.]${ATEXT}+)*`;
// RFC 5322 3.4.1 dtext, without its obsolete forms: printable ASCII but "[", "]" and "\".
const NO_FOLD_LITERAL = /\[[\x21-\x5a\x5e-\x7e]*\]/.source;
// msg-id = "<" id-left "@" id-right ">", in today's syntax only. The obsolete forms
// (quoted strings, comments and folding inside the brackets) are not accepted: they are
// where a line break or a second header would hide.
const MSG_ID = new RegExp(`^<${DOT_ATOM_TEXT}@(?:${DOT_ATOM_TEXT}|${NO_FOLD_LITERAL})>$`);

/** The id itself when it is one well-formed msg-id of a usable length, otherwise null. */
export function msgIdOf(value: string): string | null {
  return value.length <= REPLY_HEADER_LIMITS.msgIdChars && MSG_ID.test(value) ? value : null;
}

const wellFormed = (values: readonly string[]): string[] =>
  values.flatMap((value) => msgIdOf(value) ?? []);

const REFERENCES_NAME = 'References: ';

/**
 * A References list short enough for one line of 998 characters, unfolded and with its
 * name: the rule RFC 5537 section 3.4.4 gives for trimming one. The first id (the thread's
 * root) stays, and then as many of the newest as fit, so the last two always do.
 */
function trimmed(ids: readonly string[]): string[] {
  const length = (kept: readonly string[]) =>
    REFERENCES_NAME.length + kept.reduce((sum, id) => sum + id.length, 0) + kept.length - 1;
  if (length(ids) <= REPLY_HEADER_LIMITS.headerChars) return [...ids];
  const [first, ...rest] = ids;
  if (first === undefined) return [];
  const newest: string[] = [];
  for (const id of rest.reverse()) {
    if (length([first, id, ...newest]) > REPLY_HEADER_LIMITS.headerChars) break;
    newest.unshift(id);
  }
  return [first, ...newest];
}

/** What a message being answered says of itself, as it was received. */
export interface ReplyParent {
  /** Its Message-ID, or null when it has none that can be used. */
  readonly messageId: string | null;
  /** Every id in its In-Reply-To. */
  readonly inReplyTo: readonly string[];
  /** Its References, oldest first. */
  readonly references: readonly string[];
}

export interface ReplyHeaders {
  /** The parent's Message-ID exactly as received, or null for no In-Reply-To header. */
  readonly inReplyTo: string | null;
  /** Oldest first and ending with the parent; empty for no References header. */
  readonly references: readonly string[];
}

/**
 * The In-Reply-To and References of a reply to `parent`, built as RFC 5322 section 3.6.4
 * says: In-Reply-To is the parent's Message-ID, and References is the parent's References
 * (or its In-Reply-To, when it has no References and names one message) followed by the
 * parent's Message-ID. A parent without a usable Message-ID gives no In-Reply-To.
 */
export function replyHeadersOf(parent: ReplyParent): ReplyHeaders {
  const inReplyTo = parent.messageId === null ? null : msgIdOf(parent.messageId);
  const before =
    parent.references.length > 0
      ? parent.references
      : parent.inReplyTo.length === 1
        ? parent.inReplyTo
        : [];
  // The parent is named once, and last: a thread is read backwards from there.
  const earlier = wellFormed(before).filter((id) => id !== inReplyTo);
  return { inReplyTo, references: trimmed(inReplyTo === null ? earlier : [...earlier, inReplyTo]) };
}

/**
 * Headers someone else built, held to the same rules on their way into a message: each id
 * well-formed or left out, and References within its bound.
 */
export function safeReplyHeaders(headers: ReplyHeaders): ReplyHeaders {
  return {
    inReplyTo: headers.inReplyTo === null ? null : msgIdOf(headers.inReplyTo),
    references: trimmed(wellFormed(headers.references)),
  };
}
