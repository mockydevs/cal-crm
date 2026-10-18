// The conversation list: who wrote, the last message as one line of plain text, the
// channel, when, how many are unread, whose it is, a star, and a clear mark on what needs a
// reply. Above it, the view, the tabs and the filters (inbox-filters.tsx). Ticked rows can
// be marked read or unread, starred or unstarred together (inbox-bulk.ts).
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type {
  Conversation,
  ConversationBulkAction,
  ConversationList,
  InboxSummary,
} from '@repo/contracts';
import { Avatar } from '@repo/ui/components/avatar';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { EmptyState } from '@repo/ui/components/empty-state';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { Inbox, Star } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement, type Ref } from 'react';
import { bulkSkipWords, useBulkConversations, type BulkTally } from './inbox-bulk';
import { cursorChanged } from './inbox-data';
import { InboxListHeader } from './inbox-filters';
import { InboxLink, type InboxNavigation } from './inbox-link';
import {
  channelWords,
  deliveryTones,
  deliveryWords,
  knownNameOf,
  shortTimeOf,
  stateOfStatus,
  tintOf,
} from './inbox-rules';
import { filtersOf, type InboxFilters, type InboxSearch } from './inbox-search';
import { emptyKindOf } from './inbox-tabs';
import { initialsOf, useBusiness } from './workspace';

const smallBadgeClassName = 'px-2.5 py-0.5 text-xs';
const checkboxClassName = 'size-4 shrink-0 accent-primary';

/** The id of a conversation's row, so the keyboard can come back to it. */
export const rowIdOf = (conversationId: string): string => `inbox-row-${conversationId}`;

export interface InboxListProps {
  readonly search: InboxSearch;
  readonly navigation: InboxNavigation;
  readonly list: UseInfiniteQueryResult<InfiniteData<ConversationList>>;
  readonly summary: InboxSummary | undefined;
  /** When the list was last read: what "today" is measured from. */
  readonly now: Date;
  /** After a row's link opened its conversation in place. */
  readonly onOpen: () => void;
}

export function InboxList({
  search,
  navigation,
  list,
  summary,
  now,
  onOpen,
}: InboxListProps): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const filters = filtersOf(search);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const lastRowRef = useRef<HTMLAnchorElement>(null);
  const loadingMoreRef = useRef(false);
  // After more conversations load, the keyboard stays on the button, or goes to the last
  // row when there are no more to load.
  useEffect(() => {
    if (!loadingMoreRef.current || list.isFetching) return;
    loadingMoreRef.current = false;
    if (!list.hasNextPage && !list.isError) lastRowRef.current?.focus();
  }, [list.isFetching, list.hasNextPage, list.isError]);

  /** The address with these filters, keeping the open conversation open. */
  const filter = (next: InboxFilters): void => {
    navigation.go(
      {
        ...(search.conversation === undefined ? {} : { conversation: search.conversation }),
        ...next,
      },
      { replace: true },
    );
  };

  // Read state and stars are the team's: whoever may manage conversations or reply
  // changes them, and nobody else is shown the boxes.
  const first = list.data?.pages[0];
  const mayAct = first?.canManage === true || first?.canReply === true;
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  // A ticked conversation that left the list is no longer chosen.
  const chosen = items.filter((each) => ticked.has(each.id));
  const bulk = useBulkConversations(business.id);
  const [notice, setNotice] = useState('');
  const [bulkError, setBulkError] = useState('');
  const selectAllRef = useRef<HTMLInputElement>(null);
  const some = chosen.length > 0 && chosen.length < items.length;
  useEffect(() => {
    if (selectAllRef.current !== null) selectAllRef.current.indeterminate = some;
  }, [some]);

  const wordsOf = (action: ConversationBulkAction, tally: BulkTally): string => {
    const done =
      action === 'mark_read'
        ? plural(tally.changed, {
            one: '# conversation marked as read.',
            other: '# conversations marked as read.',
          })
        : action === 'mark_unread'
          ? plural(tally.changed, {
              one: '# conversation marked as unread.',
              other: '# conversations marked as unread.',
            })
          : action === 'star'
            ? plural(tally.changed, {
                one: '# conversation starred.',
                other: '# conversations starred.',
              })
            : plural(tally.changed, {
                one: 'Star removed from # conversation.',
                other: 'Star removed from # conversations.',
              });
    if (tally.skipped === 0) return done;
    const skipped = plural(tally.skipped, {
      one: "# couldn't be changed.",
      other: "# couldn't be changed.",
    });
    const why = tally.reason === null ? '' : i18n._(bulkSkipWords[tally.reason]);
    return [tally.changed === 0 ? '' : done, skipped, tally.skipped === 1 ? why : '']
      .filter((part) => part !== '')
      .join(' ');
  };
  const act = (action: ConversationBulkAction): void => {
    setNotice('');
    setBulkError('');
    bulk.mutate(
      { action, conversations: chosen },
      {
        onSuccess: (tally) => {
          setTicked(new Set());
          setNotice(wordsOf(action, tally));
        },
        onError: () => {
          setBulkError(t`That didn't go through. Check your connection and try again.`);
        },
      },
    );
  };
  const actions: readonly { readonly action: ConversationBulkAction; readonly label: string }[] = [
    { action: 'mark_read', label: t`Mark as read` },
    { action: 'mark_unread', label: t`Mark as unread` },
    { action: 'star', label: t`Star` },
    { action: 'unstar', label: t`Unstar` },
  ];
  const empty = emptyKindOf(filters);

  return (
    <section aria-labelledby={headingId} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <InboxListHeader
        headingId={headingId}
        search={search}
        navigation={navigation}
        summary={summary}
      />

      {mayAct && items.length > 0 ? (
        <div className="flex min-w-0 flex-col border-b px-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3">
            <label className="inline-flex min-h-11 items-center gap-2.5 text-sm lg:min-h-9">
              <input
                ref={selectAllRef}
                type="checkbox"
                className={checkboxClassName}
                checked={chosen.length === items.length}
                onChange={(event) => {
                  setTicked(
                    event.target.checked ? new Set(items.map((each) => each.id)) : new Set(),
                  );
                }}
              />
              <Trans>Select all</Trans>
            </label>
            {chosen.length === 0 ? null : (
              <p className="text-sm text-muted-foreground">
                {plural(chosen.length, { one: '# selected', other: '# selected' })}
              </p>
            )}
          </div>
          {chosen.length === 0 ? null : (
            <div
              role="group"
              aria-label={t`Selected conversations`}
              className="flex min-w-0 flex-wrap gap-1.5 pb-2"
            >
              {actions.map((each) => (
                <Button
                  key={each.action}
                  variant="secondary"
                  size="small"
                  disabled={bulk.isPending}
                  onClick={() => {
                    act(each.action);
                  }}
                >
                  {each.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : null}
      <p role="status" className="px-3 py-1.5 text-sm empty:sr-only">
        {notice}
      </p>
      {bulkError === '' ? null : (
        <p role="alert" className="px-3 py-1.5 text-sm text-destructive">
          {bulkError}
        </p>
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2 lg:overflow-y-auto">
        {filters.contact === undefined ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-2 p-2 text-sm">
            <p>
              <Trans>Showing one contact's conversations.</Trans>
            </p>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                const { contact: _contact, ...rest } = filters;
                filter(rest);
              }}
            >
              <Trans>Show every contact</Trans>
            </Button>
          </div>
        )}
        {list.isPending ? (
          <p role="status" className="p-3">
            <Trans>Loading conversations…</Trans>
          </p>
        ) : null}
        {list.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm">
            <p>
              <Trans>Conversations couldn't be loaded.</Trans>
            </p>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void (list.isFetchNextPageError && !cursorChanged(list.error, 'after')
                  ? list.fetchNextPage()
                  : list.refetch());
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
        {list.data !== undefined && items.length === 0 && !list.isPlaceholderData ? (
          empty === 'filtered' ? (
            <EmptyState
              className="border-0 p-4"
              icon={<Inbox strokeWidth={1.8} />}
              title={<Trans>Nothing matches these filters</Trans>}
              description={<Trans>Try a different status, person or channel.</Trans>}
              action={
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    filter({});
                  }}
                >
                  <Trans>Clear filters</Trans>
                </Button>
              }
            />
          ) : empty === 'unread' ? (
            <EmptyState
              className="border-0 p-4"
              icon={<Inbox strokeWidth={1.8} />}
              title={<Trans>No unread conversations</Trans>}
              description={<Trans>Every open conversation has been read.</Trans>}
            />
          ) : empty === 'starred' ? (
            <EmptyState
              className="border-0 p-4"
              icon={<Star strokeWidth={1.8} />}
              title={<Trans>No starred conversations</Trans>}
              description={<Trans>Star a conversation to keep it here for the team.</Trans>}
            />
          ) : (
            <EmptyState
              className="border-0 p-4"
              icon={<Inbox strokeWidth={1.8} />}
              title={<Trans>No conversations yet</Trans>}
              description={<Trans>Messages from every channel arrive here.</Trans>}
            />
          )
        ) : null}
        <ul aria-busy={list.isPlaceholderData} className="flex min-w-0 flex-col gap-0.5">
          {items.map((conversation, index) => {
            const name = knownNameOf(conversation.contact.name) ?? t`Unknown contact`;
            return (
              <li key={conversation.id} className="flex min-w-0 items-start">
                {mayAct ? (
                  <label className="flex size-11 shrink-0 items-center justify-center lg:w-9">
                    <input
                      type="checkbox"
                      aria-label={t`Select ${name}`}
                      className={checkboxClassName}
                      checked={ticked.has(conversation.id)}
                      onChange={(event) => {
                        const next = new Set(chosen.map((each) => each.id));
                        if (event.target.checked) next.add(conversation.id);
                        else next.delete(conversation.id);
                        setTicked(next);
                      }}
                    />
                  </label>
                ) : null}
                <ConversationRow
                  rowRef={index === items.length - 1 ? lastRowRef : undefined}
                  conversation={conversation}
                  contactName={name}
                  selected={conversation.id === search.conversation}
                  showStatus={filters.status !== undefined}
                  to={{ ...filters, conversation: conversation.id }}
                  navigation={navigation}
                  now={now}
                  onOpen={onOpen}
                />
              </li>
            );
          })}
        </ul>
        {list.hasNextPage ? (
          <Button
            variant="secondary"
            size="small"
            className="self-center"
            disabled={list.isFetching}
            onClick={() => {
              loadingMoreRef.current = true;
              void list.fetchNextPage();
            }}
          >
            <Trans>Load more conversations</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function ConversationRow({
  conversation,
  contactName,
  selected,
  showStatus,
  to,
  navigation,
  now,
  onOpen,
  rowRef,
}: {
  readonly conversation: Conversation;
  readonly contactName: string;
  readonly selected: boolean;
  readonly showStatus: boolean;
  readonly to: InboxSearch;
  readonly navigation: InboxNavigation;
  readonly now: Date;
  readonly onOpen: () => void;
  readonly rowRef: Ref<HTMLAnchorElement> | undefined;
}): ReactElement {
  const { t, i18n } = useLingui();
  const last = conversation.lastMessage;
  const unread = conversation.unreadCount;
  const preview = last?.preview ?? '';
  const troubled =
    last?.direction === 'outbound' && deliveryTones[stateOfStatus[last.status]] === 'problem'
      ? i18n._(deliveryWords[stateOfStatus[last.status]])
      : null;
  const assignee = conversation.assignee;
  const assigneeName = assignee?.name ?? t`another team member`;
  return (
    <InboxLink
      id={rowIdOf(conversation.id)}
      {...(rowRef === undefined ? {} : { ref: rowRef })}
      to={to}
      navigation={navigation}
      onGo={onOpen}
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      className="flex min-w-0 flex-1 gap-2.5 rounded-lg p-2.5 text-foreground hover:bg-muted aria-[current=true]:bg-background"
    >
      <Avatar
        fallback={initialsOf(knownNameOf(conversation.contact.name) ?? '', '?')}
        tint={tintOf(conversation.contact.id)}
        size="medium"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span
            className={`min-w-0 truncate text-md ${unread > 0 ? 'font-semibold' : 'font-medium'}`}
          >
            {contactName}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
            {conversation.starred === true ? (
              <>
                <Star aria-hidden className="size-3.5 fill-current" strokeWidth={1.8} />
                <span className="sr-only">
                  <Trans>Starred</Trans>
                </span>
              </>
            ) : null}
            <time dateTime={conversation.lastActivityAt}>
              {shortTimeOf(conversation.lastActivityAt, now, i18n.locale)}
            </time>
          </span>
        </span>
        <span className="min-w-0 truncate text-sm text-secondary-foreground">
          {last === null ? (
            <Trans>No messages yet</Trans>
          ) : last.direction === 'outbound' ? (
            // As plain text, not <Trans>, which reads angle brackets in a value as markup of
            // its own and drops them: a preview is shown exactly as it was written.
            t`Sent: ${preview}`
          ) : (
            preview
          )}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {conversation.needsReply ? (
            <Badge variant="attention" className={smallBadgeClassName}>
              <Trans>Needs reply</Trans>
            </Badge>
          ) : null}
          {conversation.unverified ? (
            <Badge variant="neutral" className={smallBadgeClassName}>
              <Trans>Unverified</Trans>
            </Badge>
          ) : null}
          {unread > 0 ? (
            <Badge variant="neutral" className={smallBadgeClassName}>
              {plural(unread, { one: '# unread', other: '# unread' })}
            </Badge>
          ) : null}
          {troubled === null ? null : (
            <Badge variant="neutral" className={smallBadgeClassName}>
              {troubled}
            </Badge>
          )}
          {showStatus && conversation.status !== 'open' ? (
            <Badge variant="neutral" className={smallBadgeClassName}>
              {conversation.status === 'closed' ? <Trans>Closed</Trans> : <Trans>Snoozed</Trans>}
            </Badge>
          ) : null}
          {last === null ? null : <span>{i18n._(channelWords[last.channel])}</span>}
          <span>
            {assignee === null ? (
              <Trans>Unassigned</Trans>
            ) : assignee.you ? (
              <Trans>Assigned to you</Trans>
            ) : (
              <Trans>Assigned to {assigneeName}</Trans>
            )}
          </span>
        </span>
      </span>
    </InboxLink>
  );
}
