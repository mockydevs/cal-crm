// The team's reply to a web chat visitor, which the Inbox's reply command calls
// (inbox-reply.ts). Web chat has no provider: a reply is delivered by being stored where
// the visitor's session reads it. So "sent" here means stored for the session, and nothing
// proves the visitor saw it.
import { requireBusiness, type CommandContext } from '@repo/commands';
import { parseInput, webchatMessageText } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';
import * as z from 'zod';

import { evaluateDoNotDisturb } from './outbound-policy.js';
import { holdBusinessIfActive } from './webchat-locks.js';

const replyInput = z.strictObject({
  conversationId: z.uuid(),
  // The bounds of a visitor's message, so every stored reply fits the public response.
  text: webchatMessageText,
  /** One per reply the person makes, so a repeated request stores one message. */
  idempotencyKey: z.string().min(1).max(200),
});

export interface WebchatReplyInput {
  readonly conversationId: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

/** Why a conversation's web chat can't be answered now. */
export type WebchatSilence =
  /** Nobody ever wrote in this conversation through web chat. */
  | 'no_chat'
  /** The visitor ended the chat, it expired, or the widget's key was replaced. */
  | 'visitor_left'
  /** The widget, or the business, is turned off. */
  | 'widget_off';

export type WebchatReplyResult =
  | { readonly outcome: 'sent'; readonly messageId: string }
  /** Nothing was stored. The composer should offer another channel. */
  | { readonly outcome: 'no_session'; readonly reason: WebchatSilence };

/** The one web chat session of a conversation, and whether it still answers. */
export interface WebchatTarget {
  readonly sessionId: string;
  readonly widgetId: string;
  readonly widgetName: string;
  readonly lastSeq: number;
  /** Undefined while a reply stored now would reach the visitor. */
  readonly silence: Exclude<WebchatSilence, 'no_chat'> | undefined;
}

/**
 * The session a conversation's reply would go to. A conversation has at most one (the
 * database's webchat_sessions_conversation_unique): a visitor's session gets a contact and
 * a conversation of its own, so a reply can never reach anybody but the visitor who wrote.
 * With `lock`, the session row is held until the transaction ends.
 */
export async function readWebchatTarget(
  trx: DatabaseTransaction,
  conversationId: string,
  lock = false,
): Promise<WebchatTarget | undefined> {
  const query = trx
    .selectFrom('messaging.webchat_sessions as session')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'session.widget_id')
        .onRef('channel.business_id', '=', 'session.business_id'),
    )
    .innerJoin('tenancy.businesses as business', 'business.id', 'session.business_id')
    .select([
      'session.id',
      'session.widget_id',
      'session.last_seq',
      'session.ended_at',
      'channel.name',
      'channel.status',
      'business.status as business_status',
      sql<boolean>`session.expires_at > clock_timestamp()`.as('unexpired'),
    ])
    .where('session.conversation_id', '=', conversationId);
  const row = await (lock ? query.forUpdate('session') : query).executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    sessionId: row.id,
    widgetId: row.widget_id,
    widgetName: row.name,
    lastSeq: row.last_seq,
    silence:
      row.ended_at !== null || !row.unexpired
        ? 'visitor_left'
        : row.status !== 'active' || row.business_status !== 'active'
          ? 'widget_off'
          : undefined,
  };
}

/**
 * Whether do not disturb stops a reply to the contact on web chat now: `all` for do not
 * contact, `channel` for do not disturb on web chat alone, undefined when neither is on. It
 * is the outbound policy's own rule (evaluateDoNotDisturb).
 *
 * The contact's row is read, never locked, as queueing an email or a text message reads it.
 * A reply holds the business row FOR UPDATE, and a change to the contact locks the contact's
 * row and then takes the business FOR KEY SHARE for its event: a lock on the contact here
 * would take the two in the opposite order and deadlock. A change that commits after this
 * read is one made at the same moment as the reply, which went out just before it, as an
 * email already handed to its provider does.
 */
export async function webchatDoNotDisturb(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
): Promise<'all' | 'channel' | undefined> {
  const contact = await trx
    .selectFrom('crm.contacts')
    .select(['do_not_contact', 'dnd_channels'])
    .where('business_id', '=', businessId)
    .where('id', '=', contactId)
    .executeTakeFirst();
  if (contact === undefined) return undefined;
  const refusal = evaluateDoNotDisturb({
    doNotContact: contact.do_not_contact,
    channelDoNotDisturb: contact.dnd_channels.includes('webchat'),
  });
  return refusal === undefined ? undefined : 'scope' in refusal ? refusal.scope : 'all';
}

/**
 * Stores a plain-text reply for a conversation's web chat session. The caller's command
 * has already decided the person may reply, and supplies the conversation it resolved
 * under row-level security.
 *
 * Locks, in the one order (webchat-locks.ts): the business, the conversation, the session.
 * A caller that locks anything itself must take the business before a conversation too.
 */
export async function sendWebchatReply(
  trx: DatabaseTransaction,
  input: WebchatReplyInput,
  command: CommandContext,
): Promise<WebchatReplyResult> {
  const { conversationId, text, idempotencyKey } = parseInput(replyInput, input);
  const businessId = requireBusiness(command.context);
  if (!(await holdBusinessIfActive(trx, command.context)))
    return { outcome: 'no_session', reason: 'widget_off' };
  const conversation = await trx
    .selectFrom('messaging.conversations')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', '=', conversationId)
    .forUpdate()
    .executeTakeFirst();
  if (conversation === undefined) return { outcome: 'no_session', reason: 'no_chat' };

  const repeated = await trx
    .selectFrom('messaging.messages')
    .select(['id', 'conversation_id', 'channel'])
    .where('business_id', '=', businessId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  if (repeated !== undefined)
    return repeated.conversation_id === conversationId && repeated.channel === 'webchat'
      ? { outcome: 'sent', messageId: repeated.id }
      : { outcome: 'no_session', reason: 'no_chat' };

  const target = await readWebchatTarget(trx, conversationId, true);
  if (target === undefined) return { outcome: 'no_session', reason: 'no_chat' };
  if (target.silence !== undefined) return { outcome: 'no_session', reason: target.silence };

  const stored = await trx
    .insertInto('messaging.messages')
    .values({
      business_id: businessId,
      conversation_id: conversationId,
      channel: 'webchat',
      channel_account_id: target.widgetId,
      direction: 'outbound',
      status: 'sent',
      // Plain text. The widget shows it as text, never as HTML.
      body_text: text,
      idempotency_key: idempotencyKey,
      author_kind: command.context.actorKind,
      author_id: command.context.actorId ?? null,
      sent_at: sql<Date>`clock_timestamp()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const seq = target.lastSeq + 1;
  await trx
    .insertInto('messaging.webchat_session_messages')
    .values({ business_id: businessId, session_id: target.sessionId, seq, message_id: stored.id })
    .execute();
  await trx
    .updateTable('messaging.webchat_sessions')
    .set({ last_seq: seq })
    .where('id', '=', target.sessionId)
    .execute();
  await trx
    .updateTable('messaging.conversations')
    .set({ needs_reply: false, last_message_at: sql<Date>`greatest(last_message_at, now())` })
    .where('id', '=', conversationId)
    .execute();
  await command.emit({
    type: 'message.sent',
    subject: { kind: 'message', id: stored.id },
    payload: { conversationId, widgetId: target.widgetId, channel: 'webchat' },
  });
  return { outcome: 'sent', messageId: stored.id };
}
