// Where the Inbox keeps what it read, and how an answer from the API is put there. Every
// key is under the business's id, so the realtime hint that something changed in the
// business (realtime.ts) refreshes the list, the open thread and the counts at once.
import type { Conversation, ConversationList, InboxSummary } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import type { QueryClient } from '@tanstack/react-query';
import { inboxSummaryKey } from './inbox-badge';
import { summaryAfter, withConversation, type Pages } from './inbox-rules';
import type { InboxFilters } from './inbox-search';

export const inboxKeys = {
  all: (businessId: string): readonly unknown[] => ['b', businessId, 'inbox'],
  lists: (businessId: string): readonly unknown[] => ['b', businessId, 'inbox', 'list'],
  list: (businessId: string, filters: InboxFilters): readonly unknown[] => [
    'b',
    businessId,
    'inbox',
    'list',
    filters,
  ],
  summary: inboxSummaryKey,
  conversation: (businessId: string, id: string): readonly unknown[] => [
    'b',
    businessId,
    'inbox',
    'conversation',
    id,
  ],
  thread: (businessId: string, id: string): readonly unknown[] => [
    'b',
    businessId,
    'inbox',
    'thread',
    id,
  ],
  assignees: (businessId: string): readonly unknown[] => ['b', businessId, 'inbox', 'assignees'],
  composer: (businessId: string, id: string): readonly unknown[] => [
    'b',
    businessId,
    'inbox',
    'composer',
    id,
  ],
  /** What the assistant proposes for one conversation, and how much it does on its own. */
  assistant: (businessId: string, id: string): readonly unknown[] => [
    'b',
    businessId,
    'inbox',
    'assistant',
    id,
  ],
};

/** Try a read again, unless the server already said why it won't answer. */
export function retryRead(failures: number, error: Error): boolean {
  return failures < 3 && !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/** A page's cursor no longer fits the list: read the list afresh instead of the page. */
export function cursorChanged(error: Error | null, name: 'after' | 'before'): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.problem.errors?.some((each) => each.path === `/${name}`) === true
  );
}

/**
 * Shows a conversation as the API just answered it, everywhere the page holds it: on its
 * own, in each list that has it, and in the counts. Then asks the server for the lists and
 * the counts again, since only it knows which filters the conversation still fits.
 */
export function applyConversation(
  cache: QueryClient,
  businessId: string,
  next: Conversation,
): void {
  const key = inboxKeys.conversation(businessId, next.id);
  const before =
    cache.getQueryData<Conversation>(key) ??
    cache
      .getQueriesData<Pages<ConversationList>>({ queryKey: inboxKeys.lists(businessId) })
      .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? [])
      .find((item) => item.id === next.id);
  cache.setQueryData<Conversation>(key, next);
  cache.setQueriesData<Pages<ConversationList>>({ queryKey: inboxKeys.lists(businessId) }, (data) =>
    withConversation(data, next),
  );
  cache.setQueryData<InboxSummary>(inboxKeys.summary(businessId), (summary) =>
    summaryAfter(summary, before, next),
  );
  void cache.invalidateQueries({ queryKey: inboxKeys.lists(businessId) });
  void cache.invalidateQueries({ queryKey: inboxKeys.summary(businessId) });
}
