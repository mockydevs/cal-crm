// What the assistant's conversation reads from the API, and where it keeps it. Nothing is
// streamed: while a turn runs, the messages after a cursor are read again when the realtime
// hint says the business changed (realtime.ts refetches every query whose key names the
// business), with a slow poll behind it for a hint that never came.
import {
  ASSISTANT_LIMITS,
  getAssistantThread,
  listAssistantMessages,
  type AssistantMessage,
  type AssistantPageContext,
  type AssistantTurnStarted,
  type Proposal,
} from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { skipToken, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { mergeMessages, turnIsRunning, type Conversation } from './rules';

export const assistantKeys = {
  all: (businessId: string) => ['b', businessId, 'assistant'] as const,
  context: (businessId: string, page: AssistantPageContext) =>
    ['b', businessId, 'assistant', 'context', page.route, page.record?.id ?? null] as const,
  threads: (businessId: string) => ['b', businessId, 'assistant', 'threads'] as const,
  thread: (businessId: string, threadId: string) =>
    ['b', businessId, 'assistant', 'thread', threadId] as const,
};

/** How often a running turn is asked about when no hint arrives. */
export const POLL_MS = 4000;

// A conversation is read a page at a time; this many pages is far more than one holds.
const MOST_PAGES = 20;

/**
 * Reads a conversation. While its turn runs, only what came after the cursor, joined to
 * what is held. Otherwise all of it again, so a card shows its proposal as it stands now
 * (applied by someone else, expired, out of date).
 */
export async function readConversation(
  client: Client,
  threadId: string,
  held?: Conversation,
): Promise<Conversation> {
  const page = (after: number) =>
    client.request(listAssistantMessages, {
      params: { id: threadId },
      query: { after, limit: ASSISTANT_LIMITS.messagePageSize },
    });
  if (held !== undefined && turnIsRunning(held.turn)) {
    let { messages, cursor, turn } = held;
    for (let read = 0, more = true; more && read < MOST_PAGES; read++) {
      const next = await page(cursor);
      messages = mergeMessages(messages, next.items);
      ({ cursor, turn, more } = next);
    }
    return { title: held.title, messages, cursor, turn };
  }
  const { thread, messages: newest } = await client.request(getAssistantThread, {
    params: { id: threadId },
  });
  // The thread answers with its newest messages; a long one has earlier ones before them.
  let messages: readonly AssistantMessage[] = newest.items;
  const first = newest.items[0]?.seq ?? 1;
  for (let read = 0, after = 0; read < MOST_PAGES && after + 1 < first; read++) {
    const earlier = await page(after);
    if (earlier.items.length === 0) break;
    messages = mergeMessages(messages, earlier.items);
    after = earlier.cursor;
  }
  return { title: thread.title, messages, cursor: newest.cursor, turn: newest.turn };
}

/**
 * How a conversation is read and kept, for everything that shows it: the conversation
 * itself, and the header that names it. Without a thread there is nothing to read yet.
 */
export function useConversation(
  client: Client,
  businessId: string,
  threadId: string | null,
): UseQueryResult<Conversation> {
  const cache = useQueryClient();
  const queryKey = assistantKeys.thread(businessId, threadId ?? '');
  return useQuery({
    queryKey,
    queryFn:
      threadId === null
        ? skipToken
        : () => readConversation(client, threadId, cache.getQueryData<Conversation>(queryKey)),
    refetchInterval: (query) => (turnIsRunning(query.state.data?.turn) ? POLL_MS : false),
  });
}

/** A conversation once a message was sent into it: the message, and the turn now waiting. */
export function withTurnStarted(
  held: Conversation | undefined,
  started: AssistantTurnStarted,
): Conversation {
  return {
    title: started.thread.title,
    messages: mergeMessages(held?.messages ?? [], [started.message]),
    cursor: Math.max(held?.cursor ?? 0, started.message.seq),
    turn: started.turn,
  };
}

/** A conversation with one card's proposal as the server just answered it. */
export function withProposal(held: Conversation, proposal: Proposal): Conversation {
  return {
    ...held,
    messages: held.messages.map((message) =>
      message.proposal?.id === proposal.id ? { ...message, proposal } : message,
    ),
  };
}
