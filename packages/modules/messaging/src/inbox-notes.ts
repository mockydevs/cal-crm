// Internal notes in a conversation. A note is a message row of its own kind: channel
// 'note', direction 'internal', status 'note', with no account and no recipient. It gets no
// dispatch row, and the database refuses one (migration 0046), so nothing that sends can
// ever pick a note up.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  addConversationNote,
  addConversationNoteInput,
  threadNote,
  type ThreadNote,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, toPublicId, type TenantContext } from '@repo/kernel';

import { holdBusiness, requireConversation, type InboxOptions } from './inbox-list.js';
import { readThreadItem } from './inbox-thread.js';

const noteInput = addConversationNoteInput.extend(addConversationNote.params.shape);

/**
 * Stores a note once for its retry key, and says whether this call stored it. The only
 * columns it sets are the ones a note has. The caller holds the conversation, so two
 * requests with one key can't both find nothing.
 */
async function storeNote(
  trx: DatabaseTransaction,
  context: TenantContext,
  conversationId: string,
  text: string,
  key: string,
): Promise<{ readonly id: string; readonly stored: boolean }> {
  // Apart from every sender's keys: the pipeline never looks a note up by this.
  const idempotencyKey = `inbox-note:${conversationId}:${key}`;
  const earlier = await trx
    .selectFrom('messaging.messages')
    .select(['id', 'channel', 'body_text'])
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  if (earlier !== undefined) {
    if (earlier.channel !== 'note' || earlier.body_text !== text)
      throw new ConflictError('This key already belongs to a different note. Make a new one.');
    return { id: earlier.id, stored: false };
  }
  const note = await trx
    .insertInto('messaging.messages')
    .values({
      business_id: requireBusiness(context),
      conversation_id: conversationId,
      channel: 'note',
      direction: 'internal',
      status: 'note',
      body_text: text,
      idempotency_key: idempotencyKey,
      author_kind: context.actorKind,
      author_id: context.actorId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: note.id, stored: true };
}

export function addConversationNoteCommand(
  options: InboxOptions,
): Command<typeof noteInput, ThreadNote> {
  return defineCommand({
    name: 'conversation.add_note',
    permission: 'conversations.manage',
    input: noteInput,
    // The note's words stay out of the audit log.
    audit: ({ id }) => ({ id }),
    async handle(trx, input, command): Promise<ThreadNote> {
      await holdBusiness(trx, command.context);
      const conversation = await requireConversation(trx, input.id, true);
      const note = await storeNote(
        trx,
        command.context,
        conversation.id,
        input.text,
        input.idempotencyKey,
      );
      // A repeat is answered with the note already there, and recorded once.
      if (note.stored)
        await command.emit({
          type: 'conversation.note_added',
          subject: { kind: 'message', id: note.id },
          records: [conversation.contact_id],
          payload: { conversationId: toPublicId('conversation', conversation.id) },
        });
      // Read back as the thread shows it: anything but a note fails here, loudly.
      return threadNote.parse(await readThreadItem(trx, command, conversation, note.id, options));
    },
  });
}
