// One conversation: who it is with, who has it and whether it is open, its messages on
// every channel with the team's notes among them, what the assistant proposes, and the
// composer. Opening it marks it read; what the contact wrote is shown as text only
// (inbox-text.tsx).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  assignConversation,
  getConversation,
  getConversationComposer,
  listConversationMessages,
  markConversationRead,
  setConversationStatus,
  type Conversation,
  type ConversationThread,
  type ThreadMessage,
  type ThreadNote,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Avatar } from '@repo/ui/components/avatar';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { cn } from '@repo/ui/lib/utils';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  CircleAlert,
  Clock,
  Lock,
  Mail,
  PanelRight,
  Paperclip,
  Star,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type Ref,
} from 'react';
import { useActorLabel } from './activity';
import { apiIn } from './api';
import { AssistantLoader, loadAssistant } from './inbox-assistant-loader';
import { MorePeople, teammatesOf, useAssignees } from './inbox-assignees';
import { bulkSkipWords, useBulkConversations } from './inbox-bulk';
import { Composer, type ComposerHandle, type DraftStore } from './inbox-composer';
import { applyConversation, cursorChanged, inboxKeys, retryRead } from './inbox-data';
import { InboxLink, type InboxNavigation } from './inbox-link';
import {
  channelWords,
  dayOf,
  deliveryOf,
  deliveryTones,
  deliveryWords,
  knownNameOf,
  newestInboundOf,
  readThroughOf,
  snoozeTimeOf,
  snoozeUntilOf,
  repliesUnderMessages,
  threadDaysOf,
  threadItemsOf,
  tintOf,
  withThreadItem,
  type Pages,
  type ReplyContent,
  type SnoozeChoice,
} from './inbox-rules';
import { filtersOf, type InboxSearch } from './inbox-search';
import { MessageText } from './inbox-text';
import { initialsOf, useBusiness } from './workspace';

const controlClassName =
  'min-h-11 min-w-0 rounded-control border border-input bg-card px-3 text-md text-foreground lg:min-h-9';
const inlineLabelClassName = 'flex min-w-0 items-center gap-2 text-sm font-medium';
const iconButtonClassName = 'w-10 px-0 lg:w-8';

function subscribeToAttention(changed: () => void): () => void {
  window.addEventListener('focus', changed);
  window.addEventListener('blur', changed);
  document.addEventListener('visibilitychange', changed);
  return () => {
    window.removeEventListener('focus', changed);
    window.removeEventListener('blur', changed);
    document.removeEventListener('visibilitychange', changed);
  };
}

/** Whether this window is the one the person is looking at: visible, and in front. */
function useAttending(): boolean {
  return useSyncExternalStore(
    subscribeToAttention,
    () => document.visibilityState === 'visible' && document.hasFocus(),
    () => false,
  );
}

/** The list a thread was opened from, in the Inbox: how to go back to it. */
export interface InboxThreadList {
  readonly search: InboxSearch;
  readonly navigation: InboxNavigation;
  /** After "Back to conversations": the page returns the keyboard to the list. */
  readonly onBack: () => void;
  /** The pane with the contact's details: whether it shows, and how to show or hide it. */
  readonly details: {
    readonly open: boolean;
    /** The pane's id, for the button that shows and hides it. */
    readonly controls: string;
    readonly onToggle: () => void;
  };
}

export interface InboxThreadProps {
  readonly conversationId: string;
  /**
   * Left out on the contact's own page: there is no list to go back to there, and the
   * contact is already open.
   */
  readonly list?: InboxThreadList;
  /**
   * False while the thread is on the page but out of sight (another section of a narrow
   * contact page): nothing is marked read that nobody could have read.
   */
  readonly shown?: boolean;
  readonly drafts: DraftStore;
  readonly sendReply: (conversationId: string, content: ReplyContent) => Promise<ThreadMessage>;
  readonly addNote: (conversationId: string, text: string) => Promise<ThreadNote>;
  /** Gets the heading, so the page can move the keyboard here when a conversation opens. */
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

export function InboxThread({
  conversationId,
  list,
  shown = true,
  drafts,
  sendReply,
  addNote,
  headingRef,
}: InboxThreadProps): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const client = apiIn(business.id);
  const windowAttended = useAttending();
  const attending = windowAttended && shown;
  const headingId = useId();
  const endRef = useRef<HTMLDivElement>(null);
  const atEndRef = useRef(true);
  const regionRef = useRef<HTMLDivElement>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [snoozing, setSnoozing] = useState(false);
  const [snoozeValue, setSnoozeValue] = useState('');
  const [snoozeError, setSnoozeError] = useState('');
  const snoozeErrorId = useId();

  const conversationKey = inboxKeys.conversation(business.id, conversationId);
  const threadKey = inboxKeys.thread(business.id, conversationId);
  const params = { id: conversationId };

  const conversation = useQuery({
    queryKey: conversationKey,
    queryFn: () => client.request(getConversation, { params }),
    retry: retryRead,
  });
  const thread = useInfiniteQuery({
    queryKey: threadKey,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request(listConversationMessages, {
        params,
        query: pageParam === undefined ? {} : { before: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: retryRead,
  });
  const composer = useQuery({
    queryKey: inboxKeys.composer(business.id, conversationId),
    queryFn: () => client.request(getConversationComposer, { params }),
    retry: retryRead,
  });
  const composerRef = useRef<ComposerHandle>(null);
  // The proposal the reply box is changing, kept with the draft while the Inbox stays open.
  const [editing, setEditing] = useState(() => drafts.get(conversationId)?.proposalId);

  const current = conversation.data;
  const items = threadItemsOf(thread.data?.pages ?? []);
  const newestId = items.at(-1)?.id;
  /** The last item as the thread draws it, which a reply moved under its message is not. */
  const lastDrawnId = repliesUnderMessages(items).at(-1)?.item.id;
  const hasItems = newestId !== undefined;
  const contactName = knownNameOf(current?.contact.name ?? '') ?? t`Unknown contact`;
  // What this person may do comes with the conversation itself, so the thread doesn't
  // depend on the list having loaded.
  const canManage = current?.canManage === true;
  const people = useAssignees(business.id, canManage);

  const refreshAfter = async (error: Error): Promise<void> => {
    // A conflict means someone else changed it first; a refusal, that what this person
    // may do changed. Either way, show what is true now.
    if (error instanceof ApiError && (error.status === 409 || error.status === 403)) {
      await cache.invalidateQueries({ queryKey: inboxKeys.all(business.id) });
    }
  };
  const explain = (error: Error): string =>
    error instanceof ApiError
      ? error.status === 409
        ? t`Someone else just changed this conversation. It's up to date now; try again.`
        : (error.problem.errors?.[0]?.message ?? error.message)
      : t`That didn't go through. Check your connection and try again.`;

  const change = useMutation({
    mutationFn: (
      input:
        | { readonly kind: 'assign'; readonly assignee: string | null; readonly revision: string }
        | { readonly kind: 'open' | 'closed'; readonly revision: string }
        | { readonly kind: 'snoozed'; readonly until: string; readonly revision: string },
    ) =>
      input.kind === 'assign'
        ? client.request(assignConversation, {
            params,
            body: { assignee: input.assignee, revision: input.revision },
          })
        : client.request(setConversationStatus, {
            params,
            body:
              input.kind === 'snoozed'
                ? { status: 'snoozed', until: input.until, revision: input.revision }
                : { status: input.kind, revision: input.revision },
          }),
    onMutate: () => {
      setActionError('');
      setNotice('');
    },
    onSuccess: (next, input) => {
      applyConversation(cache, business.id, next);
      setSnoozing(false);
      setNotice(
        input.kind === 'assign'
          ? next.assignee === null
            ? t`Conversation unassigned.`
            : t`Conversation assigned.`
          : input.kind === 'closed'
            ? t`Conversation closed.`
            : input.kind === 'snoozed'
              ? t`Conversation snoozed.`
              : t`Conversation reopened.`,
      );
    },
    onError: async (error) => {
      setActionError(explain(error));
      await refreshAfter(error);
    },
  });

  const markRead = useMutation({
    mutationFn: (through: string) =>
      client.request(markConversationRead, { params, body: { through } }),
    onSuccess: (next) => {
      applyConversation(cache, business.id, next);
    },
  });
  // Read state and stars are the team's: anyone who may manage or reply changes them.
  const mayMark = canManage || current?.canReply === true;
  // After "Mark as unread" the conversation stays unread while it stays open here, until
  // the contact writes again.
  const [heldUnread, setHeldUnread] = useState<string>();
  const through = readThroughOf({
    items,
    unreadCount: current?.unreadCount ?? 0,
    mayMarkRead: mayMark,
    attending,
    // The newest message already asked about, answered or not: it is never asked twice.
    lastMarked:
      heldUnread !== undefined && heldUnread === newestId ? heldUnread : markRead.variables,
  });
  const { mutate: markThrough } = markRead;
  useEffect(() => {
    if (through !== undefined) markThrough(through);
  }, [through, markThrough]);

  const marking = useBulkConversations(business.id);
  const starred = current?.starred === true;
  const mark = (action: 'star' | 'unstar' | 'mark_unread'): void => {
    if (current === undefined) return;
    setActionError('');
    setNotice('');
    if (action === 'mark_unread') setHeldUnread(newestId);
    marking.mutate(
      { action, conversations: [current] },
      {
        onSuccess: (tally) => {
          if (tally.reason !== null) {
            setActionError(i18n._(bulkSkipWords[tally.reason]));
            return;
          }
          setNotice(
            action === 'star'
              ? t`Conversation starred.`
              : action === 'unstar'
                ? t`Star removed.`
                : t`Marked as unread.`,
          );
        },
        onError: (error) => {
          setActionError(explain(error));
        },
      },
    );
  };

  // A new message from the contact is said aloud once, without moving the keyboard.
  const newestInbound = newestInboundOf(items)?.id;
  const [heard, setHeard] = useState<{ readonly loaded: boolean; readonly id: string | undefined }>(
    { loaded: false, id: undefined },
  );
  const [announcement, setAnnouncement] = useState('');
  if (thread.data !== undefined && (!heard.loaded || heard.id !== newestInbound)) {
    setHeard({ loaded: true, id: newestInbound });
    if (heard.loaded && newestInbound !== undefined) {
      setAnnouncement(t`New message from ${contactName}`);
    }
  }

  // The page scrolls, not the thread, so nothing here traps the keyboard or a thumb. Go to
  // the newest message and the composer when the thread opens, and when a message arrives
  // while the person is already there. Someone reading further up is left where they are.
  useEffect(() => {
    const end = endRef.current;
    if (end === null) return;
    const observer = new IntersectionObserver((entries) => {
      atEndRef.current = entries.at(-1)?.isIntersecting ?? atEndRef.current;
    });
    observer.observe(end);
    return () => {
      observer.disconnect();
    };
  }, [hasItems]);
  useEffect(() => {
    if (newestId === undefined || !atEndRef.current) return;
    // A contact's reply sits under the message it answers (inbox-rules.ts), so the newest
    // message is not always the last one drawn: go to it wherever it is.
    const newest = endRef.current?.parentElement?.querySelector(
      `[data-item-id="${CSS.escape(newestId)}"]`,
    );
    if (newest !== null && newest !== undefined && newestId !== lastDrawnId) {
      newest.scrollIntoView({ block: 'center' });
      return;
    }
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [newestId, lastDrawnId]);

  // After older messages load, the keyboard stays on the button, or goes to the messages
  // when there are no more to load.
  const loadingOlderRef = useRef(false);
  useEffect(() => {
    if (!loadingOlderRef.current || thread.isFetching) return;
    loadingOlderRef.current = false;
    if (!thread.hasNextPage && !thread.isError) regionRef.current?.focus();
  }, [thread.isFetching, thread.hasNextPage, thread.isError]);

  const note = async (text: string): Promise<ThreadNote> => {
    const note = await addNote(conversationId, text);
    cache.setQueryData<Pages<ConversationThread>>(threadKey, (data) => withThreadItem(data, note));
    void cache.invalidateQueries({ queryKey: threadKey });
    return note;
  };
  const reply = async (content: ReplyContent): Promise<ThreadMessage> => {
    const message = await sendReply(conversationId, content);
    cache.setQueryData<Pages<ConversationThread>>(threadKey, (data) =>
      withThreadItem(data, message),
    );
    void cache.invalidateQueries({ queryKey: inboxKeys.all(business.id) });
    return message;
  };
  // A draft changed in the reply box goes by applying its proposal. How that is done comes
  // with the assistant's own code, which is on the page whenever a draft is.
  const applyDraft = async (
    proposalId: string,
    changes: ReplyContent,
  ): Promise<ThreadMessage | undefined> => {
    const { applyProposalIn } = await loadAssistant();
    const applied = await applyProposalIn(
      cache,
      client,
      { businessId: business.id, conversationId },
      proposalId,
      changes,
    );
    return applied.message;
  };

  const back =
    list === undefined ? null : (
      <InboxLink
        to={filtersOf(list.search)}
        navigation={list.navigation}
        onGo={list.onBack}
        className="inline-flex min-h-11 items-center gap-2 self-start rounded-full px-3 text-md text-link underline-offset-2 hover:underline lg:hidden"
      >
        <ArrowLeft aria-hidden className="size-[18px]" strokeWidth={1.8} />
        <Trans>Back to conversations</Trans>
      </InboxLink>
    );

  if (conversation.isError) {
    const missing = conversation.error instanceof ApiError && conversation.error.status === 404;
    return (
      <section aria-labelledby={headingId} className="flex min-w-0 flex-1 flex-col gap-3 p-5">
        {back}
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
          <Trans>Conversation</Trans>
        </h2>
        <div role="alert" className="flex flex-col items-start gap-2 text-md">
          <p>
            {missing
              ? t`This conversation can't be found. It may have been removed.`
              : t`The conversation couldn't be loaded.`}
          </p>
          {missing ? null : (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void conversation.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          )}
        </div>
      </section>
    );
  }

  const times = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const busy = change.isPending;
  const assignee =
    current?.assignee === null || current?.assignee === undefined
      ? ''
      : current.assignee.you
        ? 'me'
        : (current.assignee.membershipId ?? 'unavailable');
  const unnamed = t`Unnamed team member`;
  const teammates = teammatesOf(
    people.data?.pages,
    current?.assignee?.membershipId === null ||
      current?.assignee?.membershipId === undefined ||
      current.assignee.you
      ? undefined
      : { id: current.assignee.membershipId, name: current.assignee.name },
  );
  const snoozedUntil =
    current?.snoozedUntil === null || current?.snoozedUntil === undefined
      ? null
      : times.format(new Date(current.snoozedUntil));

  return (
    <section aria-labelledby={headingId} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        className={cn(
          'flex min-w-0 flex-col gap-2.5 border-b bg-card px-4 py-3',
          // In Conversations the thread scrolls in its own pane, under its header.
          list === undefined ? '' : 'z-10 lg:sticky lg:top-0',
        )}
      >
        {back}
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <Avatar
            fallback={initialsOf(knownNameOf(current?.contact.name ?? '') ?? '', '?')}
            tint={tintOf(current?.contact.id ?? '')}
            size="medium"
          />
          <div className="flex min-w-[140px] flex-1 flex-col gap-0.5">
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              className="text-lg leading-tight font-semibold wrap-anywhere focus:outline-none focus-visible:outline-2"
            >
              {current === undefined ? <Trans>Loading conversation…</Trans> : contactName}
            </h2>
            {current === undefined ? null : (
              <p className="text-sm text-muted-foreground">
                <ConversationState conversation={current} snoozedUntil={snoozedUntil} />
              </p>
            )}
          </div>
          {current === undefined ? null : (
            <div className="flex shrink-0 items-center gap-1">
              {mayMark ? (
                <>
                  <Button
                    variant="quiet"
                    size="small"
                    className={iconButtonClassName}
                    aria-pressed={starred}
                    aria-label={starred ? t`Remove star` : t`Star conversation`}
                    title={starred ? t`Remove star` : t`Star conversation`}
                    disabled={marking.isPending}
                    onClick={() => {
                      mark(starred ? 'unstar' : 'star');
                    }}
                  >
                    <Star
                      aria-hidden
                      className={cn('size-[18px]', starred ? 'fill-current text-link' : '')}
                      strokeWidth={1.8}
                    />
                  </Button>
                  <Button
                    variant="quiet"
                    size="small"
                    className={iconButtonClassName}
                    aria-label={t`Mark as unread`}
                    title={t`Mark as unread`}
                    disabled={marking.isPending}
                    onClick={() => {
                      mark('mark_unread');
                    }}
                  >
                    <Mail aria-hidden className="size-[18px]" strokeWidth={1.8} />
                  </Button>
                </>
              ) : null}
              {list === undefined ? null : (
                <>
                  {list.details.open || current.contact.trashed ? null : (
                    <Link
                      to="/b/$slug/contacts/$contactId"
                      params={{ slug: business.slug, contactId: current.contact.id }}
                      className="inline-flex min-h-11 items-center rounded-control px-2.5 text-sm text-link underline-offset-2 hover:underline lg:min-h-9"
                    >
                      <Trans>Open contact</Trans>
                    </Link>
                  )}
                  <Button
                    variant="quiet"
                    size="small"
                    className={iconButtonClassName}
                    aria-expanded={list.details.open}
                    aria-controls={list.details.open ? list.details.controls : undefined}
                    aria-label={t`Contact details`}
                    title={t`Contact details`}
                    onClick={list.details.onToggle}
                  >
                    <PanelRight aria-hidden className="size-[18px]" strokeWidth={1.8} />
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
        {current !== undefined && canManage ? (
          <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label className={inlineLabelClassName}>
                <Trans>Assigned to</Trans>
                <Select
                  value={assignee}
                  disabled={busy}
                  className="w-40 sm:w-44"
                  onValueChange={(value) => {
                    if (value === assignee || value === 'unavailable') return;
                    change.mutate({
                      kind: 'assign',
                      assignee: value === '' ? null : value,
                      revision: current.revision,
                    });
                  }}
                >
                  <option value="">
                    <Trans>Unassigned</Trans>
                  </option>
                  <option value="me">
                    <Trans>You</Trans>
                  </option>
                  {assignee === 'unavailable' ? (
                    <option value="unavailable" disabled>
                      {current.assignee?.name ?? unnamed}
                    </option>
                  ) : null}
                  {teammates.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name ?? unnamed}
                    </option>
                  ))}
                </Select>
              </label>
              <MorePeople people={people} disabled={busy} />
            </div>
            {current.status === 'open' ? (
              <>
                <Select
                  aria-label={t`Snooze`}
                  value={snoozing ? 'custom' : ''}
                  disabled={busy}
                  className="w-44"
                  onValueChange={(value) => {
                    setSnoozeError('');
                    if (value === 'custom') {
                      setSnoozing(true);
                      return;
                    }
                    setSnoozing(false);
                    if (value === 'three_hours' || value === 'tomorrow' || value === 'next_week') {
                      const choice: SnoozeChoice = value;
                      change.mutate({
                        kind: 'snoozed',
                        until: snoozeUntilOf(choice, new Date()).toISOString(),
                        revision: current.revision,
                      });
                    }
                  }}
                >
                  <option value="">
                    <Trans>Not snoozed</Trans>
                  </option>
                  <option value="three_hours">
                    <Trans>For 3 hours</Trans>
                  </option>
                  <option value="tomorrow">
                    <Trans>Until tomorrow at 9:00</Trans>
                  </option>
                  <option value="next_week">
                    <Trans>Until Monday at 9:00</Trans>
                  </option>
                  <option value="custom">
                    <Trans>Pick a time…</Trans>
                  </option>
                </Select>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    change.mutate({ kind: 'closed', revision: current.revision });
                  }}
                >
                  <Trans>Close conversation</Trans>
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  change.mutate({ kind: 'open', revision: current.revision });
                }}
              >
                <Trans>Reopen conversation</Trans>
              </Button>
            )}
          </div>
        ) : null}
        {current !== undefined && canManage && snoozing && current.status === 'open' ? (
          <form
            className="flex min-w-0 flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const time = snoozeTimeOf(snoozeValue, new Date());
              if (!time.ok) {
                setSnoozeError(
                  time.why === 'past' ? t`Choose a time that's still ahead.` : t`Choose a time.`,
                );
                return;
              }
              change.mutate({ kind: 'snoozed', until: time.until, revision: current.revision });
            }}
          >
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              <Trans>Snooze until</Trans>
              <input
                type="datetime-local"
                required
                value={snoozeValue}
                disabled={busy}
                aria-invalid={snoozeError !== ''}
                aria-describedby={snoozeError === '' ? undefined : snoozeErrorId}
                className={controlClassName}
                onChange={(event) => {
                  setSnoozeValue(event.target.value);
                  setSnoozeError('');
                }}
              />
            </label>
            <Button type="submit" disabled={busy}>
              <Trans>Snooze conversation</Trans>
            </Button>
            {snoozeError === '' ? null : (
              <p id={snoozeErrorId} role="alert" className="w-full text-sm text-destructive">
                {snoozeError}
              </p>
            )}
          </form>
        ) : null}
        {actionError === '' ? null : (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
        <p role="status" className="text-sm empty:sr-only">
          {notice}
        </p>
      </header>
      {(list !== undefined && current?.contact.trashed === true) || current?.unverified === true ? (
        <div className="flex min-w-0 flex-col gap-2 border-b bg-card px-4 py-3">
          {list !== undefined && current.contact.trashed ? (
            <p className="text-sm text-muted-foreground">
              <Trans>This contact is in the trash.</Trans>
            </p>
          ) : null}
          {current.unverified ? (
            <UnverifiedNote claimed={current.claimedContact} slug={business.slug} />
          ) : null}
        </div>
      ) : null}

      <div
        ref={regionRef}
        role="region"
        aria-label={current === undefined ? t`Messages` : t`Messages with ${contactName}`}
        tabIndex={-1}
        className="flex min-w-0 flex-1 flex-col gap-4 bg-background p-4 focus:outline-none"
      >
        {thread.hasNextPage ? (
          <Button
            variant="secondary"
            size="small"
            className="self-center"
            disabled={thread.isFetching}
            onClick={() => {
              loadingOlderRef.current = true;
              void thread.fetchNextPage();
            }}
          >
            <Trans>Load older messages</Trans>
          </Button>
        ) : null}
        {thread.isPending ? (
          <p role="status">
            <Trans>Loading messages…</Trans>
          </p>
        ) : null}
        {thread.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm">
            <p>
              <Trans>Messages couldn't be loaded.</Trans>
            </p>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void (thread.isFetchNextPageError && !cursorChanged(thread.error, 'before')
                  ? thread.fetchNextPage()
                  : thread.refetch());
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
        {thread.data !== undefined && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No messages in this conversation yet.</Trans>
          </p>
        ) : null}
        <ol className="flex min-w-0 flex-col gap-4">
          {threadDaysOf(items).map((day) => (
            <li key={day.day} className="flex min-w-0 flex-col gap-4">
              <h3 className="self-center text-[13px] font-normal text-muted-foreground">
                <DayHeading day={day.day} at={day.items[0]?.createdAt} />
              </h3>
              <ol className="flex min-w-0 flex-col gap-4">
                {day.items.map((item) =>
                  item.kind === 'note' ? (
                    <NoteItem key={item.id} note={item} />
                  ) : (
                    <MessageItem key={item.id} message={item} contactName={contactName} />
                  ),
                )}
              </ol>
            </li>
          ))}
        </ol>
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {current === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-4 border-t bg-background p-4">
          <AssistantLoader
            conversationId={conversationId}
            contact={current.contact}
            contactName={contactName}
            composer={composer.data}
            lastInboundAt={newestInboundOf(items)?.createdAt}
            editing={editing}
            onEdit={(draft) => {
              composerRef.current?.editDraft(draft);
            }}
          />
          <Composer
            key={conversationId}
            ref={composerRef}
            conversationId={conversationId}
            contactId={current.contact.id}
            contactName={contactName}
            composer={composer.data}
            composerFailed={composer.isError}
            onRetryComposer={() => {
              void composer.refetch();
            }}
            canManage={canManage}
            drafts={drafts}
            onSendReply={reply}
            onAddNote={note}
            onApplyDraft={applyDraft}
            onEditingDraft={setEditing}
          />
        </div>
      )}
      <div ref={endRef} aria-hidden className="h-px" />
    </section>
  );
}

/** Whether the conversation is open, and whose it is, in words. */
function ConversationState({
  conversation,
  snoozedUntil,
}: {
  readonly conversation: Conversation;
  readonly snoozedUntil: string | null;
}): ReactElement {
  const state =
    conversation.status === 'closed' ? (
      <Trans>Closed</Trans>
    ) : conversation.status === 'snoozed' ? (
      snoozedUntil === null ? (
        <Trans>Snoozed</Trans>
      ) : (
        <Trans>Snoozed until {snoozedUntil}</Trans>
      )
    ) : conversation.needsReply ? (
      <Trans>Open · needs reply</Trans>
    ) : (
      <Trans>Open</Trans>
    );
  return state;
}

function DayHeading({
  day,
  at,
}: {
  readonly day: string;
  readonly at: string | undefined;
}): ReactElement {
  const { i18n } = useLingui();
  const [today] = useState(() => new Date());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (day === dayOf(today.toISOString())) return <Trans>Today</Trans>;
  if (day === dayOf(yesterday.toISOString())) return <Trans>Yesterday</Trans>;
  return (
    <>
      {at === undefined
        ? day
        : new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(new Date(at))}
    </>
  );
}

function fileSize(bytes: number, locale: string): string {
  const unit = bytes >= 1_048_576 ? 'megabyte' : 'kilobyte';
  const amount = bytes >= 1_048_576 ? bytes / 1_048_576 : Math.max(1, bytes / 1024);
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(amount);
}

/** One message: its channel, its direction and who wrote it in words, then how it fared. */
export function MessageItem({
  message,
  contactName,
}: {
  readonly message: ThreadMessage;
  readonly contactName: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const actorLabel = useActorLabel();
  const inbound = message.direction === 'inbound';
  const channel = i18n._(channelWords[message.channel]);
  const who = actorLabel(message.author);
  const delivery = deliveryOf(message);
  const tone = deliveryTones[delivery.state];
  const times = new Intl.DateTimeFormat(i18n.locale, { timeStyle: 'short' });
  const full = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const at = message.sentAt ?? message.createdAt;
  const account = message.account?.name;
  const retryAt = delivery.until === null ? null : full.format(new Date(delivery.until));
  return (
    <li
      data-direction={message.direction}
      data-item-id={message.id}
      className={`flex max-w-[min(520px,100%)] min-w-0 flex-col gap-1 ${
        inbound ? 'items-start self-start' : 'items-end self-end'
      }`}
    >
      <p className="px-1.5 text-[13px] text-muted-foreground">
        {inbound ? (
          <Trans>
            {channel} from {who}
          </Trans>
        ) : message.author.you ? (
          <Trans>
            {channel} to {contactName}, from you
          </Trans>
        ) : (
          <Trans>
            {channel} to {contactName}, from {who}
          </Trans>
        )}
        {message.automated ? (
          <>
            {' · '}
            <Trans>Automatic reply</Trans>
          </>
        ) : null}
      </p>
      <div
        className={`flex max-w-full min-w-0 flex-col gap-1 px-3 py-2 text-md leading-snug ${
          inbound
            ? 'rounded-[14px_14px_14px_4px] border bg-card text-card-foreground'
            : 'rounded-[14px_14px_4px_14px] bg-primary text-primary-foreground'
        }`}
      >
        {message.subject === null || message.subject === '' ? null : (
          <p className="font-semibold wrap-anywhere">{message.subject}</p>
        )}
        <MessageText text={message.text} />
        {message.textTruncated ? (
          <p className="text-sm italic">
            <Trans>This message is very long. Only its first part is shown.</Trans>
          </p>
        ) : null}
        {message.attachments.length === 0 ? null : (
          <ul aria-label={t`Attachments`} className="flex flex-col gap-1 text-sm">
            {message.attachments.map((file) => (
              <li key={file.id} className="flex min-w-0 items-center gap-1.5">
                <Paperclip aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 wrap-anywhere">
                  {file.name} ({fileSize(file.sizeBytes, i18n.locale)})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p
        className={`flex flex-wrap items-center gap-x-1.5 px-1.5 text-[13px] ${
          tone === 'problem' ? 'font-medium text-destructive' : 'text-muted-foreground'
        }`}
      >
        {tone === 'problem' ? (
          <CircleAlert aria-hidden className="size-3.5 shrink-0" />
        ) : tone === 'waiting' ? (
          <Clock aria-hidden className="size-3.5 shrink-0" />
        ) : null}
        <span data-delivery={delivery.state}>{i18n._(deliveryWords[delivery.state])}</span>
        <span aria-hidden>·</span>
        <time dateTime={at} title={full.format(new Date(at))}>
          {times.format(new Date(at))}
        </time>
        {inbound || account === undefined ? null : (
          <>
            <span aria-hidden>·</span>
            <span>
              <Trans>sent from {account}</Trans>
            </span>
          </>
        )}
      </p>
      {delivery.reason === null ? null : (
        <p className="px-1.5 text-[13px] wrap-anywhere">{i18n._(delivery.reason)}</p>
      )}
      {retryAt === null ? null : (
        <p className="px-1.5 text-[13px] text-muted-foreground">
          <Trans>It will be tried again on {retryAt}.</Trans>
        </p>
      )}
    </li>
  );
}

/** An internal note: set apart by its shape, its lock and its words, not only its color. */
export function NoteItem({ note }: { readonly note: ThreadNote }): ReactElement {
  const { i18n } = useLingui();
  const actorLabel = useActorLabel();
  const who = actorLabel(note.author);
  const full = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const times = new Intl.DateTimeFormat(i18n.locale, { timeStyle: 'short' });
  return (
    <li
      data-kind="note"
      className="flex min-w-0 flex-col gap-2 self-stretch rounded-card border-2 border-dashed border-attention-foreground bg-attention px-4 py-3 text-attention-foreground"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <Badge variant="neutral" size="default" className="px-2.5 py-0.5 text-xs">
          <Lock aria-hidden />
          <Trans>Internal note</Trans>
        </Badge>
        <span className="font-medium">
          <Trans>Only your team sees this</Trans>
        </span>
      </p>
      <MessageText text={note.text} className="text-base leading-normal" />
      <p className="text-[13px]">
        {who}
        {' · '}
        <time dateTime={note.createdAt} title={full.format(new Date(note.createdAt))}>
          {times.format(new Date(note.createdAt))}
        </time>
      </p>
    </li>
  );
}

/**
 * Says that nothing proves who wrote through web chat: the name and the email address are
 * only what the visitor typed. When the address already belongs to another contact, it
 * names that contact, so the team can compare the two before trusting either.
 */
export function UnverifiedNote({
  claimed,
  slug,
}: {
  readonly claimed: Conversation['claimedContact'];
  readonly slug: string;
}): ReactElement {
  const { t } = useLingui();
  const claimedName = claimed === null ? '' : (knownNameOf(claimed.name) ?? t`another contact`);
  return (
    <div
      role="note"
      aria-label={t`Unverified identity`}
      className="flex min-w-0 flex-col gap-1 rounded-card border bg-muted p-3 text-sm"
    >
      <p className="flex items-start gap-2 font-semibold">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={2} />
        <span>
          <Trans>Unverified: this person wrote through web chat.</Trans>
        </span>
      </p>
      <p>
        <Trans>
          Their name and email address are only what they typed. Nothing proves who they are, so
          check before sharing anything private.
        </Trans>
      </p>
      {claimed === null ? null : (
        <p>
          {/* As plain text, not <Trans>: a name is whatever someone typed, and <Trans> reads
              angle brackets in a value as its own markup. */}
          {t`The email address they typed already belongs to ${claimedName}. They were kept as a separate contact, and they can't see that contact's earlier messages.`}{' '}
          {claimed.trashed ? (
            <Trans>That contact is in the trash.</Trans>
          ) : (
            <Link
              to="/b/$slug/contacts/$contactId"
              params={{ slug, contactId: claimed.id }}
              className="font-medium underline underline-offset-2"
            >
              {t`Open ${claimedName}`}
            </Link>
          )}
        </p>
      )}
    </div>
  );
}
