// Conversations, in three panes that fill the window: the conversation list, the open
// thread with its composer, and the details of the contact it is with. Each pane scrolls by
// itself. From 1440px the three stand side by side; below that the details take the
// thread's place when asked for, and below 1024px one pane shows at a time, with a way
// back. The address says which conversation is open and how the list is filtered.
// Everything read is kept under the business's id, so the realtime hint that something
// changed (realtime.ts) refreshes the list, the thread and the counts without a reload.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  addConversationNote,
  getConversation,
  listConversations,
  sendConversationReply,
  type ThreadMessage,
  type ThreadNote,
} from '@repo/contracts';
import { cn } from '@repo/ui/lib/utils';
import { skipToken, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CatchBoundary, useLocation } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { apiIn } from './api';
import { useInboxSummary } from './inbox-badge';
import type { DraftStore } from './inbox-composer';
import { inboxKeys, retryRead } from './inbox-data';
import type { InboxNavigation } from './inbox-link';
import { InboxList, rowIdOf } from './inbox-list';
import { createNoteOutbox, createReplyOutbox } from './inbox-rules';
import { conversationQueryOf, filtersOf, searchStringOf, type InboxSearch } from './inbox-search';
import { InboxThread } from './inbox-thread';
import { usePageTitle } from './shell/page';
import { useBusiness } from './workspace';

export type { InboxSearch } from './inbox-search';

export interface InboxPageProps {
  readonly search: InboxSearch;
  readonly onSearch: (search: InboxSearch, how?: { readonly replace?: boolean }) => void;
}

export function InboxPage(props: InboxPageProps): ReactElement {
  const business = useBusiness();
  return <InboxWorkspace key={business.id} {...props} />;
}

type Move =
  | { readonly to: 'thread' }
  | { readonly to: 'details' }
  | { readonly to: 'row'; readonly id: string };

const WIDE = '(min-width: 1440px)';

function subscribeToWidth(changed: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', changed);
  return () => {
    query.removeEventListener('change', changed);
  };
}

/** Whether the window has room for the contact's details beside the thread. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

// The contact's details bring the contact page's fields with them, so they are fetched when
// the pane is first shown.
const Contact = lazy(() => import('./inbox-contact'));

/** What the boundary shows itself: nothing, since the pane says what failed. */
function Nothing(): null {
  return null;
}

function InboxWorkspace({ search, onSearch }: InboxPageProps): ReactElement {
  const { t } = useLingui();
  usePageTitle(t`Conversations`);
  const business = useBusiness();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigation: InboxNavigation = {
    hrefFor: (to) => `${pathname}${searchStringOf(to)}`,
    go: onSearch,
  };
  // Drafts and the keys of sends still to retry live as long as the Inbox stays open.
  const [drafts] = useState<DraftStore>(() => new Map());
  const [outbox] = useState(() =>
    createReplyOutbox<ThreadMessage>((id, body) =>
      apiIn(business.id).request(sendConversationReply, { params: { id }, body }),
    ),
  );
  const [notes] = useState(() =>
    createNoteOutbox<ThreadNote>((id, body) =>
      apiIn(business.id).request(addConversationNote, { params: { id }, body }),
    ),
  );

  const filters = filtersOf(search);
  const list = useInfiniteQuery({
    queryKey: inboxKeys.list(business.id, filters),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(business.id).request(listConversations, {
        query: conversationQueryOf(filters, pageParam),
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: retryRead,
    // Changing a filter keeps the old rows, marked busy, until the new ones arrive.
    placeholderData: (previous) => previous,
  });
  const summary = useInboxSummary(business.id);
  const open = search.conversation;
  // The open conversation, as the thread reads it: the same read, so it is asked for once.
  const contact = useQuery({
    queryKey: inboxKeys.conversation(business.id, open ?? ''),
    queryFn:
      open === undefined
        ? skipToken
        : () => apiIn(business.id).request(getConversation, { params: { id: open } }),
    retry: retryRead,
  }).data?.contact;

  // The contact's details stand beside the thread where there is room, until someone
  // closes them; where there is not, they take the thread's place when asked for.
  const wide = useWide();
  const [detailsChosen, setDetailsChosen] = useState<boolean>();
  const detailsOpen = open !== undefined && contact !== undefined && (detailsChosen ?? wide);
  const threadHidden = detailsOpen && !wide;
  const [detailsFailed, setDetailsFailed] = useState(false);
  const detailsId = useId();

  // The keyboard follows the person: to the thread when they open a conversation, to the
  // contact's details when they ask for them, and back to its row when they return to the
  // list.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const moveRef = useRef<Move>(undefined);
  useEffect(() => {
    const move = moveRef.current;
    moveRef.current = undefined;
    if (move === undefined) return;
    if (move.to === 'thread') headingRef.current?.focus();
    else if (move.to === 'details') detailsRef.current?.focus();
    else (document.getElementById(rowIdOf(move.id)) ?? listRef.current)?.focus();
  }, [open, detailsOpen]);

  // The panes are as tall as the window leaves them, and each scrolls by itself. How much
  // is above them is measured, since the top bar grows when its tabs wrap.
  const frameRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const measure = () => {
      const top = Math.round(frame.getBoundingClientRect().top + window.scrollY);
      frame.style.setProperty('--panes-top', `${String(top)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={frameRef}
      className="flex min-w-0 flex-col gap-2 lg:-mb-16 lg:h-[calc(100dvh-var(--panes-top,76px)-16px)] lg:min-h-[480px] lg:flex-row"
    >
      <div
        ref={listRef}
        tabIndex={-1}
        className={cn(
          // Beside the thread, the list stays in view and scrolls by itself: its rows are links,
          // so the keyboard reaches all of it.
          'relative min-h-0 min-w-0 flex-col overflow-clip rounded-card border bg-card focus:outline-none lg:flex lg:w-[340px] lg:shrink-0',
          open === undefined ? 'flex' : 'hidden',
        )}
      >
        <InboxList
          search={search}
          navigation={navigation}
          list={list}
          summary={summary}
          now={new Date(list.dataUpdatedAt)}
          onOpen={() => {
            moveRef.current = { to: 'thread' };
          }}
        />
      </div>
      <div
        className={cn(
          // Positioned, so what is placed out of sight for screen readers scrolls with the
          // pane instead of making the page taller.
          'relative min-h-0 min-w-0 flex-1 flex-col rounded-card border bg-card lg:overflow-y-auto',
          threadHidden ? 'hidden' : open === undefined ? 'hidden lg:flex' : 'flex',
        )}
      >
        {open === undefined ? (
          <p className="m-auto max-w-prose p-8 text-center text-md text-muted-foreground">
            <Trans>Choose a conversation to read it and reply.</Trans>
          </p>
        ) : (
          <InboxThread
            key={open}
            conversationId={open}
            shown={!threadHidden}
            list={{
              search,
              navigation,
              onBack: () => {
                moveRef.current = { to: 'row', id: open };
              },
              details: {
                open: detailsOpen,
                controls: detailsId,
                onToggle: () => {
                  moveRef.current = detailsOpen ? undefined : { to: 'details' };
                  setDetailsChosen(!detailsOpen);
                },
              },
            }}
            drafts={drafts}
            sendReply={outbox.submit}
            addNote={notes.submit}
            headingRef={headingRef}
          />
        )}
      </div>
      {detailsOpen ? (
        <section
          id={detailsId}
          ref={detailsRef}
          tabIndex={-1}
          aria-label={t`Contact Details`}
          className={cn(
            'relative flex min-h-0 min-w-0 flex-col gap-3 rounded-card bg-panel p-3 focus:outline-none lg:overflow-y-auto',
            wide ? 'w-80 shrink-0 2xl:w-[360px]' : 'flex-1',
          )}
        >
          {detailsFailed ? (
            <p role="alert" className="p-1 text-sm">
              <Trans>This part of the page couldn't be loaded. Reload the page to try again.</Trans>
            </p>
          ) : (
            <CatchBoundary
              getResetKey={() => 'details'}
              errorComponent={Nothing}
              onCatch={() => {
                setDetailsFailed(true);
              }}
            >
              <Suspense
                fallback={
                  <p role="status" className="p-1">
                    <Trans>Loading…</Trans>
                  </p>
                }
              >
                <Contact
                  key={contact.id}
                  contactId={contact.id}
                  onClose={() => {
                    moveRef.current = { to: 'thread' };
                    setDetailsChosen(false);
                  }}
                />
              </Suspense>
            </CatchBoundary>
          )}
        </section>
      ) : null}
    </div>
  );
}
