// One action on many conversations, from the list's selection: mark read, mark unread,
// star, unstar. One command, one transaction, one audit row.
//
// It takes the business, then every conversation named, in the order of their ids, and
// never a message's row: the lock order of everything that writes conversations (0046), so
// two requests that name the same conversations in different orders cannot wait on each
// other. Each conversation is found under row-level security: one of another business is
// simply not found. What can't be done to one is that one's outcome and never stops the
// rest, and doing again what is already done writes nothing.
import { defineCommand, type Command } from '@repo/commands';
import {
  bulkConversationsInput,
  type BulkConversationsResult,
  type ConversationBulkSkipCode,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { holdBusiness } from './inbox-list.js';

type Result = BulkConversationsResult['results'][number];
type Outcome = Pick<Result, 'outcome' | 'reason'>;

const reasons: Record<ConversationBulkSkipCode, string> = {
  not_found: 'This conversation was not found.',
  unknown_message: "That message isn't in this conversation.",
  nothing_to_mark_unread: 'The contact has not written in this conversation.',
};
const skipped = (code: ConversationBulkSkipCode): Outcome => ({
  outcome: 'skipped',
  reason: { code, message: reasons[code] },
});
const did = (changed: boolean): Outcome => ({
  outcome: changed ? 'done' : 'unchanged',
  reason: null,
});

/** A conversation as this command needs it, held for the write. */
interface Held {
  readonly id: string;
  readonly starred_at: Date | null;
  readonly unread_count: number;
}

/** The newest message of the contact's in each of these conversations, by conversation. */
async function lastInbound(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rows = await trx
    .selectFrom('messaging.messages')
    .select(['conversation_id'])
    .select(sql<string>`max(seq)::text`.as('seq'))
    .where('conversation_id', 'in', [...ids])
    .where('direction', '=', 'inbound')
    .groupBy('conversation_id')
    .execute();
  return new Map(rows.map((row) => [row.conversation_id, row.seq]));
}

/**
 * Read state and stars are the team's, so changing them takes a role that works
 * conversations: one that manages them, or one that replies. The route picks the permission
 * the caller has, as it does for marking one conversation read.
 */
export function bulkConversationsCommand(
  permission: 'conversations.manage' | 'conversations.reply' = 'conversations.manage',
): Command<typeof bulkConversationsInput, BulkConversationsResult> {
  return defineCommand({
    name: 'conversation.bulk',
    permission,
    input: bulkConversationsInput,
    // Which conversations, and what was asked: never anything of what they say.
    audit: (input) => ({
      action: input.action,
      ids: input.action === 'mark_read' ? input.items.map((item) => item.id) : input.ids,
    }),
    async handle(trx, input, command): Promise<BulkConversationsResult> {
      await holdBusiness(trx, command.context);
      const named =
        input.action === 'mark_read'
          ? input.items
          : input.ids.map((id) => ({ id, through: undefined }));
      const wanted = named.map((item) => ({
        publicId: item.id,
        id: parsePublicId('conversation', item.id),
        through: item.through === undefined ? undefined : parsePublicId('message', item.through),
      }));
      const ids = wanted.flatMap((item) => (item.id === undefined ? [] : [item.id]));
      // Held in the order of their ids, whatever order the request names them in. A message
      // arriving in one of them now is numbered after this, or was stored before it.
      const held = new Map<string, Held>(
        (ids.length === 0
          ? []
          : await trx
              .selectFrom('messaging.conversations')
              .select(['id', 'starred_at', 'unread_count'])
              .where('id', 'in', ids)
              .orderBy('id')
              .forUpdate()
              .execute()
        ).map((row) => [row.id, row]),
      );
      const found = [...held.keys()];

      const outcomes = new Map<string, Outcome>();
      const changed: string[] = [];
      const settle = (id: string, outcome: Outcome): void => {
        outcomes.set(id, outcome);
        if (outcome.outcome === 'done') changed.push(id);
      };

      if (input.action === 'star' || input.action === 'unstar') {
        const star = input.action === 'star';
        for (const row of held.values()) {
          const change = (row.starred_at !== null) !== star;
          if (change)
            await trx
              .updateTable('messaging.conversations')
              .set({ starred_at: star ? sql<Date>`now()` : null })
              .where('id', '=', row.id)
              .execute();
          settle(row.id, did(change));
        }
      } else if (input.action === 'mark_unread') {
        const last = found.length === 0 ? new Map<string, string>() : await lastInbound(trx, found);
        for (const row of held.values()) {
          const seq = last.get(row.id);
          if (seq === undefined) {
            settle(row.id, skipped('nothing_to_mark_unread'));
            continue;
          }
          // Already unread stays as it is: how much of it is unread is not made smaller.
          const change = row.unread_count === 0;
          if (change)
            await trx
              .updateTable('messaging.conversations')
              // Back to just before the contact's newest message, which becomes unread
              // again. The database counts from there (0046).
              .set({ read_through_seq: sql<string>`${seq}::bigint - 1` })
              .where('id', '=', row.id)
              .execute();
          settle(row.id, did(change));
        }
      } else {
        const messageIds = wanted.flatMap((item) =>
          item.through === undefined ? [] : [item.through],
        );
        const messages = new Map(
          (messageIds.length === 0
            ? []
            : await trx
                .selectFrom('messaging.messages')
                .select(['id', 'conversation_id'])
                .select(sql<string>`seq::text`.as('seq'))
                .where('id', 'in', messageIds)
                .execute()
          ).map((row) => [row.id, row]),
        );
        for (const item of wanted) {
          if (item.id === undefined || !held.has(item.id)) continue;
          const through = item.through === undefined ? undefined : messages.get(item.through);
          if (through?.conversation_id !== item.id) {
            settle(item.id, skipped('unknown_message'));
            continue;
          }
          // Only up to the message the person saw, and never back: what was stored after
          // it stays unread.
          const moved = await trx
            .updateTable('messaging.conversations')
            .set({ read_through_seq: through.seq })
            .where('id', '=', item.id)
            .where('read_through_seq', '<', through.seq)
            .returning('id')
            .executeTakeFirst();
          settle(item.id, did(moved !== undefined));
        }
      }

      const type = {
        mark_read: 'conversation.read',
        mark_unread: 'conversation.marked_unread',
        star: 'conversation.starred',
        unstar: 'conversation.unstarred',
      }[input.action];
      for (const id of changed) await command.emit({ type, subject: { kind: 'conversation', id } });

      const results = wanted.map((item): Result => {
        const outcome =
          (item.id === undefined ? undefined : outcomes.get(item.id)) ?? skipped('not_found');
        return { id: item.publicId, ...outcome };
      });
      const count = (outcome: Result['outcome']) =>
        results.filter((result) => result.outcome === outcome).length;
      return {
        action: input.action,
        results,
        done: count('done'),
        unchanged: count('unchanged'),
        skipped: count('skipped'),
      };
    },
  });
}
