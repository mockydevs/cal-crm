// The person's past conversations with the assistant: their own, newest activity first,
// each opened again by pressing it and deleted by its person. The panel shows the list in
// place of the conversation; the full-screen view keeps it on the left.
import { Trans, useLingui } from '@lingui/react/macro';
import { deleteAssistantThread, listAssistantThreads, type AssistantThread } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { cn } from '@repo/ui/lib/utils';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useMemo, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { assistantKeys } from './data';
import { lastActivityWords, refusalWords } from './rules';

export interface ThreadListProps {
  readonly businessId: string;
  /** The conversation that is open, marked in the list. */
  readonly current: string | null;
  readonly onOpen: (threadId: string) => void;
  /** Told when the open conversation was deleted. */
  readonly onDeleted: (threadId: string) => void;
  readonly className?: string;
}

export function ThreadList({
  businessId,
  current,
  onOpen,
  onDeleted,
  className,
}: ThreadListProps): ReactElement {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const client = useMemo(() => apiIn(businessId), [businessId]);
  const listRef = useRef<HTMLUListElement>(null);
  // The conversation whose "Delete" was pressed, until the person confirms or keeps it.
  const [asking, setAsking] = useState<string>();
  const threads = useInfiniteQuery({
    queryKey: assistantKeys.threads(businessId),
    queryFn: ({ pageParam }) =>
      client.request(listAssistantThreads, {
        query: pageParam === null ? {} : { after: pageParam },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const remove = useMutation({
    mutationFn: (thread: AssistantThread) =>
      client.request(deleteAssistantThread, { params: { id: thread.id } }),
    onSuccess: async (_, thread) => {
      setAsking(undefined);
      cache.removeQueries({ queryKey: assistantKeys.thread(businessId, thread.id) });
      await cache.invalidateQueries({ queryKey: assistantKeys.threads(businessId) });
      if (thread.id === current) onDeleted(thread.id);
      // The row is gone: the keyboard stays in the list.
      listRef.current?.focus();
    },
  });
  const items = threads.data?.pages.flatMap((page) => page.items) ?? [];
  const now = new Date(threads.dataUpdatedAt);
  const failure = remove.isError
    ? (refusalWords(remove.error) ??
      t`The conversation couldn’t be deleted. Check your connection and try again.`)
    : null;

  if (threads.isPending)
    return (
      <p role="status" className={cn('px-4 py-3 text-sm text-muted-foreground', className)}>
        <Trans>Loading conversations…</Trans>
      </p>
    );
  if (threads.isError && threads.data === undefined)
    return (
      <div
        role="alert"
        className={cn('flex flex-col items-start gap-2 px-4 py-3 text-sm', className)}
      >
        <p>
          <Trans>Past conversations couldn’t load. Check your connection.</Trans>
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            void threads.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  if (items.length === 0)
    return (
      <p className={cn('px-4 py-3 text-sm text-muted-foreground', className)}>
        <Trans>No conversations yet.</Trans>
      </p>
    );
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto p-2', className)}>
      {failure === null ? null : (
        <p role="alert" className="px-2 text-sm wrap-anywhere text-destructive">
          {failure}
        </p>
      )}
      <ul
        ref={listRef}
        tabIndex={-1}
        aria-label={t`Past conversations`}
        className="flex min-w-0 flex-col gap-0.5 focus:outline-none"
      >
        {items.map((thread) => {
          const title = thread.title;
          return (
            <li key={thread.id} className="flex min-w-0 flex-col">
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  aria-current={thread.id === current ? 'true' : undefined}
                  onClick={() => {
                    onOpen(thread.id);
                  }}
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-control px-2 py-1 text-left hover:bg-muted aria-[current=true]:bg-accent"
                >
                  <span className="max-w-full truncate text-sm text-foreground">{title}</span>
                  <span className="text-xs text-muted-foreground">
                    {lastActivityWords(thread.lastActivityAt, now, i18n.locale)}
                  </span>
                </button>
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Delete the conversation “${title}”`}
                  title={t`Delete`}
                  aria-expanded={asking === thread.id}
                  className="px-2.5"
                  onClick={() => {
                    remove.reset();
                    setAsking(asking === thread.id ? undefined : thread.id);
                  }}
                >
                  <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                </Button>
              </div>
              {asking === thread.id ? (
                <div
                  role="group"
                  aria-label={t`Delete the conversation “${title}”`}
                  className="flex min-w-0 flex-wrap items-center gap-2 px-2 pb-2 text-sm"
                >
                  <span className="min-w-0 text-body">
                    <Trans>Delete it? What the assistant made stays.</Trans>
                  </span>
                  <Button
                    variant="secondary"
                    size="small"
                    className="text-destructive aria-disabled:opacity-50"
                    disabled={remove.isPending}
                    focusableWhenDisabled
                    onClick={() => {
                      remove.mutate(thread);
                    }}
                  >
                    <Trans>Delete</Trans>
                  </Button>
                  <Button
                    variant="quiet"
                    size="small"
                    onClick={() => {
                      setAsking(undefined);
                    }}
                  >
                    <Trans>Keep</Trans>
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {threads.hasNextPage ? (
        <Button
          variant="secondary"
          size="small"
          className="self-start aria-disabled:opacity-50"
          disabled={threads.isFetchingNextPage}
          focusableWhenDisabled
          onClick={() => {
            void threads.fetchNextPage();
          }}
        >
          <Trans>Show more conversations</Trans>
        </Button>
      ) : null}
    </div>
  );
}
