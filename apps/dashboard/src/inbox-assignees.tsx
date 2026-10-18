// The people a conversation can be assigned to, a page at a time: for the thread's
// "Assigned to" control and the list's filter. Both read the same pages.
import { Trans } from '@lingui/react/macro';
import { listConversationAssignees, type ConversationAssigneeList } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { apiIn } from './api';
import { inboxKeys, retryRead } from './inbox-data';

export type Assignee = ConversationAssigneeList['items'][number];
export type AssigneePages = UseInfiniteQueryResult<InfiniteData<ConversationAssigneeList>>;

export function useAssignees(businessId: string, enabled: boolean): AssigneePages {
  return useInfiniteQuery({
    queryKey: inboxKeys.assignees(businessId),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(businessId).request(listConversationAssignees, {
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    retry: retryRead,
    staleTime: 60_000,
  });
}

/**
 * The teammates to offer besides "You": everyone read so far who isn't the reader, and
 * the person named in `current` when no page read so far holds them, so a choice already
 * made always has its option.
 */
export function teammatesOf(
  pages: readonly ConversationAssigneeList[] | undefined,
  current?: { readonly id: string; readonly name: string | null },
): { readonly id: string; readonly name: string | null }[] {
  const read = (pages ?? []).flatMap((page) => page.items);
  const others = read.filter((person) => !person.you);
  return current === undefined || read.some((person) => person.id === current.id)
    ? others
    : [{ id: current.id, name: current.name }, ...others];
}

/**
 * Under a control that lists people: that they are loading, that they couldn't be loaded
 * (with a way to try again), or a button for the next page. Nothing when all are there,
 * and nothing for someone the server doesn't let see the team.
 */
export function MorePeople({
  people,
  disabled = false,
}: {
  readonly people: AssigneePages;
  readonly disabled?: boolean;
}): ReactElement | null {
  if (people.isPending && people.fetchStatus === 'fetching') {
    return (
      <p role="status" className="text-sm font-normal text-muted-foreground">
        <Trans>Loading people…</Trans>
      </p>
    );
  }
  if (people.isError) {
    if (people.error instanceof ApiError && people.error.status === 403) return null;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm font-normal">
        <p>
          <Trans>People couldn't be loaded.</Trans>
        </p>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={people.isFetching}
          onClick={() => {
            void (people.isFetchNextPageError ? people.fetchNextPage() : people.refetch());
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  return people.hasNextPage ? (
    <Button
      type="button"
      variant="quiet"
      size="small"
      className="self-start"
      disabled={people.isFetching || disabled}
      onClick={() => {
        void people.fetchNextPage();
      }}
    >
      <Trans>Load more people</Trans>
    </Button>
  ) : null;
}
