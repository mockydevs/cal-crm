// The assistant's floating panel: beside the page, never over it as a dialog would be, so
// the person can read the page while they ask about it. 400px wide above the launcher; a
// sheet from the bottom edge on a phone. Escape closes it and the keyboard goes back to the
// launcher. Nothing slides: it is there or it is not, which is also what reduced motion
// asks for.
//
// Fetched when the launcher is first pressed (launcher.tsx), so no page waits for it.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { History, Maximize2, SquarePen, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { Conversation, useConversationKey } from './conversation';
import { useConversation } from './data';
import { pageContextOf, pathInBusiness } from './pages';
import { ThreadList } from './threads';
import { setAssistantView, useAssistantView } from './view-state';

export interface AssistantPanelProps {
  readonly businessId: string;
  readonly slug: string;
  /** The id the launcher names the panel by. */
  readonly id: string;
  /** Closes the panel; the launcher takes the keyboard back. */
  readonly onClose: () => void;
}

const iconButtonClassName = 'px-2.5';

export default function AssistantPanel({
  businessId,
  slug,
  id,
  onClose,
}: AssistantPanelProps): ReactElement {
  const { t } = useLingui();
  const titleId = useId();
  const navigate = useNavigate();
  const view = useAssistantView(businessId);
  const client = useMemo(() => apiIn(businessId), [businessId]);
  const [history, setHistory] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Where the person is: the page a message is sent from, as ids.
  const location = useRouterState({ select: (state) => state.resolvedLocation ?? state.location });
  const paramsText = useRouterState({
    select: (state) => JSON.stringify(state.matches.at(-1)?.params ?? {}),
  });
  const page = useMemo(
    () =>
      pageContextOf({
        path: pathInBusiness(location.pathname, slug),
        params: JSON.parse(paramsText) as Record<string, unknown>,
        search: location.search,
      }),
    [location.pathname, location.search, paramsText, slug],
  );

  const title = useConversation(client, businessId, view.threadId).data?.title;
  const conversation = useConversationKey(view.threadId);

  // Opening it takes the keyboard into it: to its name first, then to the box to type in
  // once there is one.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  const toComposer = useCallback((box: HTMLTextAreaElement) => {
    if (document.activeElement === titleRef.current) box.focus();
  }, []);

  const open = (threadId: string | null): void => {
    setAssistantView(businessId, { threadId });
    setHistory(false);
    titleRef.current?.focus();
  };
  const expand = (): void => {
    setAssistantView(businessId, { open: false, from: location.href, fromPage: page });
    void (view.threadId === null
      ? navigate({ to: '/b/$slug/assistant', params: { slug } })
      : navigate({
          to: '/b/$slug/assistant/$threadId',
          params: { slug, threadId: view.threadId },
        }));
  };

  return (
    // Escape closes it from anywhere inside, as it would a dialog.
    // eslint-disable-next-line jsx-a11y-x/no-noninteractive-element-interactions
    <section
      id={id}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
      className="fixed inset-x-0 bottom-0 z-[35] flex h-[min(85dvh,640px)] min-w-0 flex-col rounded-t-card border bg-card text-card-foreground shadow-xl sm:inset-x-auto sm:right-4 sm:bottom-[76px] sm:h-[min(640px,calc(100dvh-92px))] sm:w-[400px] sm:rounded-card"
    >
      <header className="flex min-w-0 shrink-0 items-center gap-1 border-b py-1.5 pr-1.5 pl-4">
        <h2
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          title={history ? undefined : title}
          className="min-w-0 flex-1 truncate text-md font-medium focus:outline-none"
        >
          {history ? <Trans>Past conversations</Trans> : (title ?? <Trans>New conversation</Trans>)}
        </h2>
        <Button
          variant="quiet"
          size="small"
          aria-label={t`New conversation`}
          title={t`New conversation`}
          className={iconButtonClassName}
          onClick={() => {
            open(null);
          }}
        >
          <SquarePen aria-hidden className="size-4" strokeWidth={1.8} />
        </Button>
        <Button
          variant="quiet"
          size="small"
          aria-label={t`Past conversations`}
          title={t`Past conversations`}
          aria-pressed={history}
          className={`${iconButtonClassName} aria-pressed:bg-muted aria-pressed:text-foreground`}
          onClick={() => {
            setHistory(!history);
          }}
        >
          <History aria-hidden className="size-4" strokeWidth={1.8} />
        </Button>
        <Button
          variant="quiet"
          size="small"
          aria-label={t`Open full screen`}
          title={t`Open full screen`}
          className={iconButtonClassName}
          onClick={expand}
        >
          <Maximize2 aria-hidden className="size-4" strokeWidth={1.8} />
        </Button>
        <Button
          variant="quiet"
          size="small"
          aria-label={t`Close the assistant`}
          title={t`Close`}
          className={iconButtonClassName}
          onClick={onClose}
        >
          <X aria-hidden className="size-4" strokeWidth={1.8} />
        </Button>
      </header>
      {history ? (
        <ThreadList
          businessId={businessId}
          current={view.threadId}
          onOpen={open}
          onDeleted={() => {
            setAssistantView(businessId, { threadId: null });
          }}
          className="flex-1"
        />
      ) : (
        <Conversation
          key={conversation.key}
          businessId={businessId}
          slug={slug}
          threadId={view.threadId}
          onThread={(threadId) => {
            if (threadId !== null) conversation.onStarted(threadId);
            setAssistantView(businessId, { threadId });
          }}
          page={page}
          here={location.href}
          onComposer={toComposer}
        />
      )}
    </section>
  );
}
