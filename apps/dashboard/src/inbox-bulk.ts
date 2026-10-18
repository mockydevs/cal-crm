// What is done to conversations from the list's selection and from the thread's star and
// "Mark as unread": one command on the server, `POST /conversations/bulk`, for 1
// to 100 conversations. Read state and stars are the team's, so everyone sees the result.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  bulkUpdateConversations,
  CONVERSATION_BULK_LIMIT,
  type BulkConversationsResult,
  type Conversation,
  type ConversationBulkAction,
  type ConversationBulkSkipCode,
  type EndpointInput,
} from '@repo/contracts';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiIn } from './api';
import { inboxKeys } from './inbox-data';

export type BulkBody = EndpointInput<typeof bulkUpdateConversations>['body'];

export interface BulkPlan {
  /** One request for each 100 conversations. */
  readonly bodies: readonly BulkBody[];
  /** Conversations left out: marking read needs the message a row was read up to. */
  readonly left: number;
}

function inHundreds<Item>(items: readonly Item[]): Item[][] {
  const groups: Item[][] = [];
  for (let start = 0; start < items.length; start += CONVERSATION_BULK_LIMIT)
    groups.push(items.slice(start, start + CONVERSATION_BULK_LIMIT));
  return groups;
}

/** The requests that do one thing to these conversations. */
export function bulkPlanOf(
  action: ConversationBulkAction,
  conversations: readonly Pick<Conversation, 'id' | 'lastMessage'>[],
): BulkPlan {
  if (action !== 'mark_read') {
    return {
      bodies: inHundreds(conversations.map((each) => each.id)).map((ids) => ({ action, ids })),
      left: 0,
    };
  }
  const items = conversations.flatMap((each) =>
    each.lastMessage?.id === undefined ? [] : [{ id: each.id, through: each.lastMessage.id }],
  );
  return {
    bodies: inHundreds(items).map((group) => ({ action, items: group })),
    left: conversations.length - items.length,
  };
}

export interface BulkTally {
  /** Now as asked: changed, or already so. */
  readonly changed: number;
  readonly skipped: number;
  /** Why the server skipped the first one it skipped. */
  readonly reason: ConversationBulkSkipCode | null;
}

/** Why a conversation was left as it was, in the dashboard's words for the server's code. */
export const bulkSkipWords: Readonly<Record<ConversationBulkSkipCode, MessageDescriptor>> = {
  not_found: msg`It can't be found. It may have been removed.`,
  unknown_message: msg`It changed after the list was read. Try again.`,
  nothing_to_mark_unread: msg`The contact hasn't written in it, so there is nothing to mark as unread.`,
};

export function bulkTallyOf(answers: readonly BulkConversationsResult[], left: number): BulkTally {
  const results = answers.flatMap((answer) => answer.results);
  const skipped = results.filter((each) => each.outcome === 'skipped');
  return {
    changed: results.length - skipped.length,
    skipped: skipped.length + left,
    reason: skipped[0]?.reason?.code ?? null,
  };
}

export interface BulkRequest {
  readonly action: ConversationBulkAction;
  readonly conversations: readonly Pick<Conversation, 'id' | 'lastMessage'>[];
}

/**
 * Does one thing to some conversations, then reads the Inbox again: only the server knows
 * which lists and counts they now belong to.
 */
export function useBulkConversations(
  businessId: string,
): UseMutationResult<BulkTally, Error, BulkRequest> {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, conversations }: BulkRequest) => {
      const plan = bulkPlanOf(action, conversations);
      const answers: BulkConversationsResult[] = [];
      for (const body of plan.bodies) {
        answers.push(await apiIn(businessId).request(bulkUpdateConversations, { body }));
      }
      return bulkTallyOf(answers, plan.left);
    },
    onSettled: () => cache.invalidateQueries({ queryKey: inboxKeys.all(businessId) }),
  });
}
