// The composer's send. The caller chooses the channel, the sending account and one of the
// contact's own addresses; everything else is the outbound pipeline's: consent,
// suppressions, quiet hours, limits and the delivery itself. What the pipeline decided is
// returned as it is, a refusal included.
//
// Web chat is the one channel with no pipeline: there is no provider and no address. The
// reply is stored where the visitor's own session reads it (webchat-reply.ts), in answer to
// a message they just wrote, so it is sent or refused at once. Of the pipeline's rules it
// keeps do not contact and do not disturb for web chat, refused here in so many words.
//
// An assistant's draft comes through here too, when a person applies it
// (inbox-proposals.ts): the same command, with the same checks, as the person. The message
// then names the proposal it was drafted in. An assistant may run the command itself only
// where its autonomy rule for sending says `act`, which the command layer checks.
import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import {
  noteDocument,
  noteDocumentToText,
  publicId,
  sendConversationReplyInput,
  threadMessage,
  WEBCHAT_LIMITS,
  type ThreadMessage,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import * as z from 'zod';

import { readSendingAccounts, requireConversation, type InboxOptions } from './inbox-list.js';
import { replyRefusal } from './inbox-rules.js';
import { readThreadItem } from './inbox-thread.js';
import { queueOutboundMessage } from './outbound.js';
import { SMS_BODY_MAX } from './sms-send.js';
import { readWebchatTarget, sendWebchatReply, webchatDoNotDisturb } from './webchat-reply.js';

// The reply's own rule (a subject only on email) keeps it from taking the path's id as a
// field, so the id travels beside it.
const replyInput = z.strictObject({
  id: publicId('conversation'),
  reply: sendConversationReplyInput,
});

/**
 * The pipeline's purpose for a person's answer in a conversation. It is not marketing:
 * marketing consent is for campaigns, and replies share the transactional lane's top
 * priority. The pipeline still requires the contact's recorded transactional consent for
 * the channel, and refuses without it; that refusal is shown, never worked around.
 */
const REPLY_PURPOSE = 'transactional';

/**
 * Stores a web chat reply for the conversation's visitor. The visitor can leave between the
 * check above and this (the session is locked only here), so the answer is checked again.
 */
async function chatReply(
  trx: DatabaseTransaction,
  command: CommandContext,
  conversationId: string,
  idempotencyKey: string,
  text: string,
): Promise<string> {
  const result = await sendWebchatReply(trx, { conversationId, text, idempotencyKey }, command);
  if (result.outcome === 'sent') return result.messageId;
  throw new ValidationError([
    result.reason === 'widget_off'
      ? {
          path: '/accountId',
          code: 'account_unavailable',
          message: 'This chat widget is turned off. Turn it on in Settings to answer.',
        }
      : {
          path: '/channel',
          code: 'visitor_left',
          message: 'The visitor has left the chat, so a reply would reach nobody.',
        },
  ]);
}

// The line "-- " is the mark mail readers know a signature by.
const SIGNATURE_MARK = '\n\n-- \n';

/**
 * A person's email reply with their signature under it, when the agency keeps one for them
 * and they have it switched on (Settings → Users). An assistant, an automation or an API
 * key signs nothing.
 */
async function signed(
  trx: DatabaseTransaction,
  command: CommandContext,
  text: string,
): Promise<string> {
  const { actorKind, userId, agencyId } = command.context;
  if (actorKind !== 'user' || userId === undefined) return text;
  const profile = await trx
    .selectFrom('tenancy.user_profiles')
    .select('signature')
    .where('agency_id', '=', agencyId)
    .where('user_id', '=', userId)
    .where('signature_enabled', '=', true)
    .executeTakeFirst();
  const document = noteDocument.safeParse(profile?.signature);
  return document.success ? `${text}${SIGNATURE_MARK}${noteDocumentToText(document.data)}` : text;
}

export function sendConversationReplyCommand(
  options: InboxOptions,
): Command<typeof replyInput, ThreadMessage> {
  return defineCommand({
    name: 'conversation.reply',
    permission: 'conversations.reply',
    input: replyInput,
    // Who and through what, never the words or the retry key.
    audit: ({ id, reply }) => ({
      id,
      channel: reply.channel,
      accountId: reply.accountId,
      to: reply.to,
    }),
    // Sending is what an assistant's rule for a contact is about.
    delegation: {
      action: 'send_message',
      contact: async (trx, { id }) => (await requireConversation(trx, id)).contact_id,
    },
    async handle(trx, { id, reply }, command): Promise<ThreadMessage> {
      const businessId = requireBusiness(command.context);
      const conversation = await requireConversation(trx, id);
      // The pipeline's own lock, taken first: a second submit of the same reply waits
      // here and then finds the first one's message.
      const business = await trx
        .selectFrom('tenancy.businesses')
        .select('id')
        .where('id', '=', businessId)
        .where('agency_id', '=', command.context.agencyId)
        .forUpdate()
        .executeTakeFirst();
      if (business === undefined) throw new NotFoundError('business', businessId);
      // One key per conversation and message written, apart from every other sender's keys.
      const idempotencyKey = `inbox-reply:${conversation.id}:${reply.idempotencyKey}`;
      const earlier = await trx
        .selectFrom('messaging.messages')
        .select(['id', 'body_text'])
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      // The input's schema has already checked both ids, and that only web chat has no address.
      const accountId = z.uuid().parse(parsePublicId('channel_account', reply.accountId));
      const identityId =
        reply.to === null ? undefined : z.uuid().parse(parsePublicId('contact_identity', reply.to));
      // A repeat is answered with the message already there; only a new reply is checked.
      if (earlier === undefined) {
        if (conversation.contact_trashed)
          throw new ValidationError([
            {
              path: '',
              code: 'contact_inactive',
              message: 'This contact is in the trash. Restore the contact to reply.',
            },
          ]);
        const [account] = await readSendingAccounts(trx, accountId);
        const recipient =
          identityId === undefined
            ? undefined
            : await trx
                .selectFrom('crm.contact_identities')
                .select(['kind', 'contact_id'])
                .where('id', '=', identityId)
                .executeTakeFirst();
        const chat =
          reply.channel === 'webchat' ? await readWebchatTarget(trx, conversation.id) : undefined;
        const refusal = replyRefusal({
          channel: reply.channel,
          smsAvailable: options.smsAvailable,
          account:
            account === undefined
              ? undefined
              : {
                  channel: account.channel,
                  status: account.status,
                  forConversations: account.for_conversations,
                  smsReady: account.sms_ready,
                },
          recipient:
            recipient === undefined
              ? undefined
              : { kind: recipient.kind, contactId: recipient.contact_id },
          contactId: conversation.contact_id,
          textLength: reply.text.length,
          smsTextLimit: SMS_BODY_MAX,
          webchatTextLimit: WEBCHAT_LIMITS.messageLength,
          webchat:
            chat === undefined
              ? undefined
              : {
                  widgetChosen: chat.widgetId === accountId,
                  silence: chat.silence,
                  doNotDisturb: await webchatDoNotDisturb(trx, businessId, conversation.contact_id),
                },
        });
        if (refusal !== undefined) throw new ValidationError([refusal]);
      }
      const messageId =
        reply.channel === 'webchat' || identityId === undefined
          ? await chatReply(trx, command, conversation.id, idempotencyKey, reply.text)
          : await queueOutboundMessage(trx, command.context, {
              identityId,
              accountId,
              channel: reply.channel,
              purpose: REPLY_PURPOSE,
              lane: 'reply',
              idempotencyKey,
              ...(reply.subject === null ? {} : { subject: reply.subject }),
              text:
                reply.channel !== 'email'
                  ? reply.text
                  : earlier === undefined
                    ? await signed(trx, command, reply.text)
                    : // A repeat is the message already there, signature and all, when the
                      // words are the same; other words under the same key are still refused.
                      earlier.body_text.startsWith(`${reply.text}${SIGNATURE_MARK}`)
                      ? earlier.body_text
                      : reply.text,
            });
      // A reply applied from an assistant's proposal says so on the message itself.
      if (earlier === undefined && command.proposal !== undefined)
        await trx
          .updateTable('messaging.messages')
          .set({ proposal_id: command.proposal.id })
          .where('id', '=', messageId)
          .execute();
      // Read back as the thread shows it: anything but a message fails here, loudly.
      const item = threadMessage.parse(
        await readThreadItem(trx, command, conversation, messageId, options),
      );
      if (earlier === undefined)
        await command.emit({
          type: 'message.submitted',
          subject: { kind: 'message', id: messageId },
          records: [conversation.contact_id],
          payload: {
            conversationId: toPublicId('conversation', conversation.id),
            channel: reply.channel,
            status: item.status,
          },
        });
      return item;
    },
  });
}
