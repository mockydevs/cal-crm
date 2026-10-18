// What the team decides about a conversation: who has it, whether it is open, and how far
// it has been read. Each takes the business, then the conversation's row, and never a
// message's.
import { defineCommand, type Command } from '@repo/commands';
import {
  assignConversation,
  assignConversationInput,
  markConversationRead,
  markConversationReadInput,
  setConversationStatus,
  setConversationStatusInput,
  type Conversation,
} from '@repo/contracts';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import * as z from 'zod';

import {
  holdBusiness,
  presentConversation,
  requireConversation,
  requireRevision,
  type InboxOptions,
} from './inbox-list.js';

const assignInput = assignConversationInput.extend(assignConversation.params.shape);
// A union can't take the path's id as a field of its own, so it travels beside it.
const statusInput = z.strictObject({
  ...setConversationStatus.params.shape,
  change: setConversationStatusInput,
});
const readInput = markConversationReadInput.extend(markConversationRead.params.shape);

export function assignConversationCommand(
  options: InboxOptions,
): Command<typeof assignInput, Conversation> {
  return defineCommand({
    name: 'conversation.assign',
    permission: 'conversations.manage',
    input: assignInput,
    audit: ({ id, assignee }) => ({ id, assignee }),
    async handle(trx, input, command): Promise<Conversation> {
      await holdBusiness(trx, command.context);
      const current = await requireConversation(trx, input.id, true);
      requireRevision(current, input.revision);
      // Tenancy decides who is on this team, and holds the membership until commit.
      const assignee = await options.assignees.resolve(trx, command.context, input.assignee);
      if (assignee !== current.assignee_user_id) {
        await trx
          .updateTable('messaging.conversations')
          .set({ assignee_user_id: assignee })
          .where('id', '=', current.id)
          .execute();
        await command.emit({
          type: assignee === null ? 'conversation.unassigned' : 'conversation.assigned',
          subject: { kind: 'conversation', id: current.id },
          records: [current.contact_id],
          payload: {
            contactId: toPublicId('contact', current.contact_id),
            // Who it was given to, for whoever reads the event later: the conversation may
            // have changed hands again by then (notifications).
            ...(assignee === null ? {} : { assignedUserId: assignee }),
          },
        });
      }
      return presentConversation(trx, command, await requireConversation(trx, input.id), options);
    },
  });
}

export function setConversationStatusCommand(
  options: InboxOptions,
): Command<typeof statusInput, Conversation> {
  return defineCommand({
    name: 'conversation.set_status',
    permission: 'conversations.manage',
    input: statusInput,
    audit: ({ id, change }) => ({
      id,
      status: change.status,
      until: change.status === 'snoozed' ? change.until : null,
    }),
    // An assistant may propose it, and run it only where its rule says so.
    delegation: {
      action: 'update_conversation',
      contact: async (trx, { id }) => (await requireConversation(trx, id)).contact_id,
    },
    async handle(trx, { id, change }, command): Promise<Conversation> {
      await holdBusiness(trx, command.context);
      const current = await requireConversation(trx, id, true);
      requireRevision(current, change.revision);
      const until = change.status === 'snoozed' ? new Date(change.until) : null;
      // Against the database's clock, the one that later ends the snooze.
      if (until !== null && until.getTime() <= current.now.getTime())
        throw new ValidationError([
          { path: '/until', code: 'not_in_future', message: 'Snooze until a time in the future.' },
        ]);
      if (
        change.status !== current.status ||
        until?.getTime() !== current.snoozed_until?.getTime()
      ) {
        await trx
          .updateTable('messaging.conversations')
          .set({ status: change.status, snoozed_until: until })
          .where('id', '=', current.id)
          .execute();
        await command.emit({
          type: `conversation.${change.status === 'open' ? 'opened' : change.status}`,
          subject: { kind: 'conversation', id: current.id },
          records: [current.contact_id],
          payload: { contactId: toPublicId('contact', current.contact_id) },
        });
      }
      return presentConversation(trx, command, await requireConversation(trx, id), options);
    },
  });
}

/**
 * Read state is the team's, so changing it takes a role that works conversations: one that
 * manages them, or one that replies. The route picks the permission the caller has.
 */
export function markConversationReadCommand(
  options: InboxOptions,
  permission: 'conversations.manage' | 'conversations.reply' = 'conversations.manage',
): Command<typeof readInput, Conversation> {
  return defineCommand({
    name: 'conversation.mark_read',
    permission,
    input: readInput,
    async handle(trx, input, command): Promise<Conversation> {
      await holdBusiness(trx, command.context);
      // Held next: a message arriving now is numbered after this, or was stored before it.
      const current = await requireConversation(trx, input.id, true);
      const through = await trx
        .selectFrom('messaging.messages')
        .select('seq')
        .where('id', '=', z.uuid().parse(parsePublicId('message', input.through)))
        .where('conversation_id', '=', current.id)
        .executeTakeFirst();
      if (through === undefined)
        throw new ValidationError([
          {
            path: '/through',
            code: 'unknown_message',
            message: 'Mark read up to a message of this conversation.',
          },
        ]);
      // Only up to the message the person saw, and never back: what was stored after it
      // stays unread. The database counts the rest (migration 0046).
      const moved = await trx
        .updateTable('messaging.conversations')
        .set({ read_through_seq: through.seq })
        .where('id', '=', current.id)
        .where('read_through_seq', '<', through.seq)
        .returning('id')
        .executeTakeFirst();
      if (moved !== undefined)
        await command.emit({
          type: 'conversation.read',
          subject: { kind: 'conversation', id: current.id },
        });
      return presentConversation(trx, command, await requireConversation(trx, input.id), options);
    },
  });
}
