// The assistant, full screen (one assistant, two sizes): the same conversation the floating
// panel shows, with the person's past conversations on the left. "Back to the page" returns
// to where it was opened from, with the panel open on the same conversation. Under 1024px
// the list is a drawer behind a button.
import { Trans, useLingui } from '@lingui/react/macro';
import { assistantPageContext } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { History, Minimize2, SquarePen, X } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { usePageTitle } from '../shell/page';
import { useBusiness } from '../workspace';
import { Conversation, useConversationKey } from './conversation';
import { useConversation } from './data';
import { assistantPageItself } from './pages';
import { ThreadList } from './threads';
import { setAssistantView, useAssistantView } from './view-state';

export function AssistantPage({ threadId }: { readonly threadId: string | null }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const { id: businessId, slug } = business;
  const navigate = useNavigate();
  const router = useRouter();
  const view = useAssistantView(businessId);
  const client = useMemo(() => apiIn(businessId), [businessId]);
  const [listing, setListing] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  usePageTitle(t`Assistant`);

  // The page it was opened from is still what a message is about; opened by its own
  // address, it is about no page.
  const page = useMemo(() => {
    const from = assistantPageContext.safeParse(view.fromPage);
    return from.success ? from.data : assistantPageItself;
  }, [view.fromPage]);
  const here = `/b/${slug}/assistant`;
  const title = useConversation(client, businessId, threadId).data?.title;
  const conversation = useConversationKey(threadId);

  // As tall as the window leaves it, so the box to type in stays in view. How much is above
  // is measured, since the top bar grows when the window is narrow.
  const frameRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const measure = (): void => {
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

  const open = (next: string | null): void => {
    setListing(false);
    void (next === null
      ? navigate({ to: '/b/$slug/assistant', params: { slug } })
      : navigate({ to: '/b/$slug/assistant/$threadId', params: { slug, threadId: next } }));
    titleRef.current?.focus();
  };
  const minimise = (): void => {
    const from = view.from;
    // Only ever back to a page of this business.
    const back = from !== null && (from === `/b/${slug}` || from.startsWith(`/b/${slug}/`));
    setAssistantView(businessId, { open: true, threadId, from: null, fromPage: null });
    void router.navigate({ href: back ? from : `/b/${slug}` });
  };

  const newButton = (
    <Button
      variant="quiet"
      size="small"
      aria-label={t`New conversation`}
      title={t`New conversation`}
      className="px-2.5"
      onClick={() => {
        open(null);
      }}
    >
      <SquarePen aria-hidden className="size-4" strokeWidth={1.8} />
    </Button>
  );
  const list = (
    <ThreadList
      businessId={businessId}
      current={threadId}
      onOpen={open}
      onDeleted={() => {
        open(null);
      }}
      className="flex-1"
    />
  );

  return (
    <div
      ref={frameRef}
      className="-mb-16 flex h-[calc(100dvh-var(--panes-top,108px)-16px)] min-h-[420px] min-w-0 gap-3"
    >
      <section
        aria-label={t`Your conversations`}
        className="hidden min-h-0 w-[280px] shrink-0 flex-col rounded-card border bg-card lg:flex"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b py-2 pr-2 pl-4">
          <h2 className="text-xs text-muted-foreground">
            <Trans>Past conversations</Trans>
          </h2>
          {newButton}
        </div>
        {list}
      </section>
      <section
        aria-label={t`Assistant`}
        className="flex min-h-0 min-w-0 flex-1 flex-col rounded-card border bg-card"
      >
        <header className="flex min-w-0 shrink-0 items-center gap-1.5 border-b py-1.5 pr-2 pl-2 lg:pl-4">
          <Dialog.Root open={listing} onOpenChange={setListing}>
            <Dialog.Trigger
              render={
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Past conversations`}
                  title={t`Past conversations`}
                  className="px-2.5 lg:hidden"
                />
              }
            >
              <History aria-hidden className="size-4" strokeWidth={1.8} />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
              <Dialog.Popup className="fixed inset-y-0 left-0 z-60 flex w-[min(320px,calc(100%-32px))] flex-col rounded-r-card bg-card text-card-foreground shadow-xl outline-none">
                <div className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
                  <Dialog.Title className="min-w-0 flex-1 text-md font-medium">
                    <Trans>Past conversations</Trans>
                  </Dialog.Title>
                  {newButton}
                  <Dialog.Close
                    render={
                      <Button
                        variant="quiet"
                        size="small"
                        aria-label={t`Close the list`}
                        className="px-2.5"
                      />
                    }
                  >
                    <X aria-hidden className="size-4" strokeWidth={1.8} />
                  </Dialog.Close>
                </div>
                {list}
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
          <h1
            ref={titleRef}
            tabIndex={-1}
            title={title}
            className="min-w-0 flex-1 truncate text-base font-medium focus:outline-none"
          >
            {title ?? <Trans>New conversation</Trans>}
          </h1>
          <Button
            variant="quiet"
            size="small"
            aria-label={t`Back to the page`}
            title={t`Back to the page`}
            className="px-2.5"
            onClick={minimise}
          >
            <Minimize2 aria-hidden className="size-4" strokeWidth={1.8} />
            {/* On a phone the icon alone, so the conversation's name has the room. */}
            <span className="hidden sm:inline">
              <Trans>Back to the page</Trans>
            </span>
          </Button>
        </header>
        <Conversation
          key={conversation.key}
          businessId={businessId}
          slug={slug}
          threadId={threadId}
          onThread={(next) => {
            if (next === null) {
              open(null);
              return;
            }
            conversation.onStarted(next);
            void navigate({
              to: '/b/$slug/assistant/$threadId',
              params: { slug, threadId: next },
              replace: true,
            });
          }}
          page={page}
          here={here}
          columnClassName="mx-auto w-full max-w-3xl"
        />
      </section>
    </div>
  );
}
