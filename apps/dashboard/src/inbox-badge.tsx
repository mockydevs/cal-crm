// The unread count beside Conversations in the sidebar, and the read behind it. This file is loaded
// with the shell, so it holds nothing else: the page is the route's own chunk.
import { plural } from '@lingui/core/macro';
import { getInboxSummary, type InboxSummary } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { apiIn } from './api';

/** Under the business's id, so a change in the business refreshes it (realtime.ts). */
export const inboxSummaryKey = (businessId: string): readonly string[] => [
  'b',
  businessId,
  'inbox',
  'summary',
];

/** The inbox's counts, or undefined until they are known. */
export function useInboxSummary(businessId: string): InboxSummary | undefined {
  return useQuery({
    queryKey: inboxSummaryKey(businessId),
    queryFn: () => apiIn(businessId).request(getInboxSummary, {}),
    staleTime: 30_000,
  }).data;
}

/** A count as a badge shows it: exact up to 99. */
export function badgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * How many conversations have unread messages, beside "Conversations" in the sidebar. Nothing
 * when there are none, or before the count is known: a badge never shows a guess.
 */
export function InboxUnreadBadge({
  businessId,
}: {
  readonly businessId: string;
}): ReactElement | null {
  const count = useInboxSummary(businessId)?.unreadConversations ?? 0;
  if (count === 0) return null;
  return (
    <Badge variant="attention" size="count" className="ml-auto">
      <span aria-hidden>{badgeCount(count)}</span>
      <span className="sr-only">
        {plural(count, { one: '# unread conversation', other: '# unread conversations' })}
      </span>
    </Badge>
  );
}
