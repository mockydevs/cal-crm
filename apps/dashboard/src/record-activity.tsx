import { Trans, useLingui } from '@lingui/react/macro';
import { listRecordActivity } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { EventExplanation, useActorLabel, useEventLabel } from './activity';
import { apiIn } from './api';
import { ContactPanel, PanelEmpty } from './contact-panels';
import { useBusiness } from './workspace';

export function RecordActivity({
  recordId,
  lead,
}: {
  readonly recordId: string;
  /** Above the history, under the title: on a contact, what the assistant knows of them. */
  readonly lead?: ReactNode;
}): ReactElement {
  const { t, i18n } = useLingui();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const business = useBusiness();
  const actorLabel = useActorLabel();
  const eventLabel = useEventLabel();
  const lastEntryRef = useRef<HTMLLIElement>(null);
  const loadTriggerRef = useRef<HTMLButtonElement>(null);
  // The server owns ordering and exact cursors. Refetches rebuild each page's cursor
  // from the preceding fresh page (query-core5.104.1 infiniteQueryBehavior.ts).
  const activity = useInfiniteQuery({
    queryKey: ['b', business.id, 'activity', recordId],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(business.id).request(listRecordActivity, {
        params: { id: recordId },
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const entries = activity.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    const trigger = loadTriggerRef.current;
    if (trigger === null || activity.isFetching) return;
    loadTriggerRef.current = null;
    if (
      !activity.hasNextPage &&
      !activity.isError &&
      (document.activeElement === trigger || document.activeElement === document.body)
    )
      lastEntryRef.current?.focus();
  }, [activity.data, activity.isFetching, activity.hasNextPage, activity.isError]);
  return (
    <ContactPanel title={t`Activity`}>
      {lead}
      {activity.isPending ? (
        <p aria-live="polite">
          <Trans>Loading activity…</Trans>
        </p>
      ) : null}
      {activity.isError ? (
        <div role="alert" className="text-sm">
          <p>
            {activity.isFetchNextPageError
              ? t`Older activity couldn't be loaded. Your current history is still here.`
              : t`Activity couldn't be loaded.`}
          </p>
          {activity.isFetchNextPageError ? null : (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void activity.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          )}
        </div>
      ) : null}
      {activity.data !== undefined && entries.length === 0 ? (
        <PanelEmpty
          icon={<History />}
          title={t`No activity yet.`}
          description={t`Changes to this record show here as they happen.`}
        />
      ) : null}
      <ol className="flex min-w-0 flex-col divide-y divide-border">
        {entries.map((entry, index) => (
          <li
            key={entry.id}
            ref={index === entries.length - 1 ? lastEntryRef : undefined}
            tabIndex={-1}
            className="flex min-w-0 flex-col items-start gap-2 py-4 first:pt-0 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2">
              <Badge
                variant={entry.actor.kind === 'ai_agent' ? 'assistant' : 'neutral'}
                className="max-w-full whitespace-normal break-words"
              >
                {actorLabel(entry.actor)}
              </Badge>
              <time className="text-sm text-muted-foreground" dateTime={entry.occurredAt}>
                {dates.format(new Date(entry.occurredAt))}
              </time>
            </div>
            <p className="font-medium break-words">{eventLabel(entry.type)}</p>
            <EventExplanation eventId={entry.id} label={t`Why this change happened`} />
          </li>
        ))}
      </ol>
      {activity.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={activity.isFetching}
          onClick={(event) => {
            loadTriggerRef.current = event.currentTarget;
            void activity.fetchNextPage();
          }}
        >
          {activity.isFetchingNextPage ? t`Loading older activity…` : t`Load older activity`}
        </Button>
      ) : activity.data !== undefined && entries.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>All activity loaded.</Trans>
        </p>
      ) : null}
    </ContactPanel>
  );
}
