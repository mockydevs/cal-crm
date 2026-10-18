// Where an email reply from the Inbox sits in its thread. The answer is decided once, when
// the reply is written, and stored on its row: a delivery tried again later, or held for
// quiet hours, still answers the mail the person was looking at.
import type { DatabaseTransaction } from '@repo/db';
import { replyHeadersOf, type ReplyHeaders } from '@repo/mail';

/** The Message-ID every outbound email of ours is sent with. */
export const outboundMessageIdOf = (messageId: string): string =>
  `<crm-outbound.${messageId}@crm.invalid>`;

// An outbound message the mail server took: one the contact may hold.
const LEFT_US = ['sent', 'delivered', 'read'];

export interface ReplyThread {
  /** The stored message being answered, or null when the reply starts a thread. */
  readonly parentId: string | null;
  readonly headers: ReplyHeaders;
}

const NO_THREAD: ReplyThread = { parentId: null, headers: { inReplyTo: null, references: [] } };

/**
 * The thread of an email to `address` in this conversation. The parent is the latest mail
 * received from that address; when it never wrote, the latest email of ours that left for
 * it, so our own messages hold together. Mail from another of the contact's addresses is
 * not a parent: its Message-ID means nothing to a mailbox that never held it.
 *
 * Everything read here from a received message is its sender's claim. `replyHeadersOf`
 * keeps only well-formed ids, so what is returned is safe to store and to send.
 */
export async function readReplyThread(
  trx: DatabaseTransaction,
  conversationId: string,
  address: string,
): Promise<ReplyThread> {
  const received = await trx
    .selectFrom('messaging.messages')
    .select(['id', 'email_message_id', 'in_reply_to', 'email_references'])
    .where('conversation_id', '=', conversationId)
    .where('channel', '=', 'email')
    .where('direction', '=', 'inbound')
    .where('from_address', '=', address)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (received !== undefined)
    return threadOf(
      received.id,
      received.email_message_id,
      received.in_reply_to,
      received.email_references,
    );
  const sent = await trx
    .selectFrom('messaging.messages')
    .select(['id', 'in_reply_to', 'email_references'])
    .where('conversation_id', '=', conversationId)
    .where('channel', '=', 'email')
    .where('direction', '=', 'outbound')
    .where('status', 'in', LEFT_US)
    .where((eb) => eb(eb.val(address), '=', eb.fn.any('to_addresses')))
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return sent === undefined
    ? NO_THREAD
    : threadOf(sent.id, outboundMessageIdOf(sent.id), sent.in_reply_to, sent.email_references);
}

function threadOf(
  parentId: string,
  messageId: string | null,
  inReplyTo: string | null,
  references: readonly string[],
): ReplyThread {
  return {
    parentId,
    headers: replyHeadersOf({
      messageId,
      // Stored as the header had it: every id, with a space between.
      inReplyTo: (inReplyTo ?? '').split(' ').filter((id) => id !== ''),
      references,
    }),
  };
}
