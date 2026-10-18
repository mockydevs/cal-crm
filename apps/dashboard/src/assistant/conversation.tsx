// One conversation with the assistant, drawn the same in both of its sizes: the floating
// panel and the full-screen view. From the top: why there is no box to type in (when there
// is none), what the server found wrong or missing on the page, the messages, things to ask
// from this page, and the box.
//
// The server answers everything shown here. What the page is about goes to it as ids
// (pages.ts); what a model wrote is drawn as text and never acted on.
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  applyProposal,
  ASSISTANT_LIMITS,
  cancelAssistantTurn,
  createAssistantThread,
  dismissProposal,
  getAssistantContext,
  postAssistantTurn,
  undoProposal,
  type AssistantCheck,
  type AssistantContext,
  type AssistantMessage,
  type AssistantPageContext,
  type Proposal,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { cn } from '@repo/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ArrowUp, Check, CircleAlert, Lightbulb, LoaderCircle, Square, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiIn } from '../api';
import { assistantKeys, useConversation, withProposal, withTurnStarted } from './data';
import { ProposalCard, type Decision } from './proposal-card';
import {
  canAsk,
  costOf,
  groupMessages,
  isGone,
  outcomeWords,
  refusalWords,
  turnIsRunning,
  unavailableWords,
  type Conversation as ConversationData,
} from './rules';
import { targetLink } from './targets';

const linkClassName = 'text-link underline underline-offset-2 hover:no-underline';
const labelClassName = 'text-xs text-muted-foreground';

/** A link to a page of the dashboard, followed without loading the app again. */
function PageLink({
  href,
  className,
  children,
}: {
  readonly href: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  const router = useRouter();
  return (
    <a
      href={href}
      className={cn(linkClassName, className)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        void router.navigate({ href });
      }}
    >
      {children}
    </a>
  );
}

/** Server's words, or ours: both are drawn as text. */
function useWords(): (words: string | MessageDescriptor) => string {
  const { i18n } = useLingui();
  return (words) => (typeof words === 'string' ? words : i18n._(words));
}

function Checks({
  context,
  slug,
  here,
}: {
  readonly context: AssistantContext;
  readonly slug: string;
  readonly here: string;
}): ReactElement | null {
  const headingId = useId();
  const subject = context.subject?.name;
  const blockers = context.checks.filter((check) => check.severity === 'blocker');
  const suggestions = context.checks.filter((check) => check.severity !== 'blocker');
  if (context.checks.length === 0) return null;
  const list = (checks: readonly AssistantCheck[], blocker: boolean): ReactElement => (
    <ul className="flex flex-col gap-1.5">
      {checks.map((check) => {
        const href = targetLink(slug, check.target, here);
        return (
          <li key={`${check.code}:${check.target?.path ?? ''}`} className="flex min-w-0 gap-2">
            {blocker ? (
              <CircleAlert
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-destructive"
                strokeWidth={1.8}
              />
            ) : (
              <Lightbulb
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                strokeWidth={1.8}
              />
            )}
            <span className="min-w-0 text-sm wrap-anywhere text-body">
              {href === null ? check.message : <PageLink href={href}>{check.message}</PageLink>}
            </span>
          </li>
        );
      })}
    </ul>
  );
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2 rounded-card border bg-card p-3"
    >
      <h3 id={headingId} className="text-sm font-medium wrap-anywhere">
        {subject === undefined ? <Trans>On this page</Trans> : <Trans>On “{subject}”</Trans>}
      </h3>
      {blockers.length === 0 ? null : (
        <>
          <p className={labelClassName}>
            <Trans>Needs fixing</Trans>
          </p>
          {list(blockers, true)}
        </>
      )}
      {suggestions.length === 0 ? null : (
        <>
          <p className={labelClassName}>
            <Trans>Suggestions</Trans>
          </p>
          {list(suggestions, false)}
        </>
      )}
    </section>
  );
}

/** What the assistant did, one quiet row for each step, with a link to what it made. */
function Steps({
  steps,
  slug,
  here,
}: {
  readonly steps: readonly AssistantMessage[];
  readonly slug: string;
  readonly here: string;
}): ReactElement {
  const { t } = useLingui();
  return (
    <ul aria-label={t`What the assistant did`} className="flex min-w-0 flex-col gap-1">
      {steps.map((step) => {
        const ok = step.activity?.ok !== false;
        const href = targetLink(slug, step.activity?.target ?? null, here);
        const Icon =
          step.activity?.state === 'started'
            ? LoaderCircle
            : step.activity?.state === 'uncertain'
              ? CircleAlert
              : ok
                ? Check
                : X;
        return (
          <li
            key={step.id}
            className="flex min-w-0 gap-2 text-[13px] leading-5 text-muted-foreground"
          >
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 wrap-anywhere">
              {ok ? null : (
                <span className="sr-only">
                  <Trans>Not done:</Trans>{' '}
                </span>
              )}
              {href === null ? step.text : <PageLink href={href}>{step.text}</PageLink>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What tells one conversation's drawing from another's: it changes when the person opens
 * another conversation, so nothing typed in one goes to another, and stays when a new
 * conversation is given its id by its first message, so the keyboard stays where it is.
 */
export function useConversationKey(threadId: string | null): {
  readonly key: string;
  /** Told the id a new conversation was given. */
  readonly onStarted: (threadId: string) => void;
} {
  const [started, setStarted] = useState<string | null>(null);
  return {
    key: threadId === null || threadId === started ? 'new' : threadId,
    onStarted: setStarted,
  };
}

export interface ConversationProps {
  readonly businessId: string;
  readonly slug: string;
  /** The conversation shown; null for one that starts with the next message. */
  readonly threadId: string | null;
  readonly onThread: (threadId: string | null) => void;
  /** The page a message is sent from. */
  readonly page: AssistantPageContext;
  /** The address the person is at, so that a link to it is not drawn. */
  readonly here: string;
  /** Told when the box to type in appears, so whoever opened this can put the keyboard there. */
  readonly onComposer?: (box: HTMLTextAreaElement) => void;
  /**
   * Classes for the column the conversation is read in, where the place it is drawn in is
   * wider than a line of text should be: the full-screen view.
   */
  readonly columnClassName?: string;
}

export function Conversation({
  businessId,
  slug,
  threadId,
  onThread,
  page,
  here,
  onComposer,
  columnClassName,
}: ConversationProps): ReactElement {
  const { t, i18n } = useLingui();
  const words = useWords();
  const cache = useQueryClient();
  const client = useMemo(() => apiIn(businessId), [businessId]);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const setBox = useCallback(
    (box: HTMLTextAreaElement | null) => {
      boxRef.current = box;
      if (box !== null) onComposer?.(box);
    },
    [onComposer],
  );
  const stopRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  const context = useQuery({
    queryKey: assistantKeys.context(businessId, page),
    queryFn: () => client.request(getAssistantContext, { body: page }),
    // Moving to another page keeps what the last one said until the new answer lands, so the
    // message box stays where it is, with the keyboard in it. Never across businesses.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === businessId ? previous : undefined,
  });
  const threadKey = assistantKeys.thread(businessId, threadId ?? '');
  const conversation = useConversation(client, businessId, threadId);
  const held = threadId === null ? undefined : conversation.data;
  const messages = held?.messages ?? [];
  const turn = held?.turn ?? null;
  const running = turnIsRunning(turn);
  const gone = threadId !== null && isGone(conversation.error);

  const send = useMutation({
    mutationFn: (message: string) =>
      threadId === null
        ? client.request(createAssistantThread, { body: { message, page } })
        : client.request(postAssistantTurn, { params: { id: threadId }, body: { message, page } }),
    onSuccess: (started) => {
      cache.setQueryData<ConversationData>(
        assistantKeys.thread(businessId, started.thread.id),
        (before) => withTurnStarted(before, started),
      );
      setDraft('');
      if (threadId === null) onThread(started.thread.id);
      void cache.invalidateQueries({ queryKey: assistantKeys.threads(businessId) });
    },
    onError: () => {
      // A refusal can mean the page was out of date: a provider was disconnected meanwhile.
      void cache.invalidateQueries({ queryKey: assistantKeys.context(businessId, page) });
    },
  });
  const stop = useMutation({
    mutationFn: (turnId: string) => client.request(cancelAssistantTurn, { params: { id: turnId } }),
    onSuccess: (stopped) => {
      cache.setQueryData<ConversationData>(threadKey, (before) =>
        before === undefined ? before : { ...before, turn: stopped },
      );
      void conversation.refetch();
    },
  });
  const decide = useMutation({
    mutationFn: ({ decision, proposal }: { decision: Decision; proposal: Proposal }) => {
      const params = { id: proposal.id };
      if (decision === 'apply') return client.request(applyProposal, { params, body: {} });
      if (decision === 'dismiss') return client.request(dismissProposal, { params });
      return client.request(undoProposal, { params });
    },
    onSuccess: (proposal) => {
      cache.setQueryData<ConversationData>(threadKey, (before) =>
        before === undefined ? before : withProposal(before, proposal),
      );
      // What was confirmed changed the business: its pages read again, as on a realtime hint.
      void cache.invalidateQueries({
        predicate: ({ queryKey }) => queryKey.includes(businessId) && queryKey[2] !== 'assistant',
      });
    },
    onError: () => {
      // A refusal means the card was out of date: it is read again as it stands.
      void conversation.refetch();
    },
  });

  const askable = canAsk(context.data) && !gone;
  const waiting = running || send.isPending;
  const submit = (text: string): void => {
    const message = text.trim();
    if (message === '' || waiting || !askable) return;
    send.mutate(message);
  };

  // The newest message stays in view, as in any conversation.
  const count = messages.length;
  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll !== null) scroll.scrollTop = scroll.scrollHeight;
  }, [count, running]);

  // The box grows with what is typed, to a few lines, then scrolls.
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    box.style.height = 'auto';
    box.style.height = `${String(Math.min(box.scrollHeight, 132))}px`;
  }, [draft]);

  // While the assistant works the box is off, so the keyboard waits on Stop, and comes
  // back to the box when the answer is in.
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (wasRunningRef.current === running) return;
    wasRunningRef.current = running;
    const active = document.activeElement;
    if (running && (active === boxRef.current || active === document.body))
      stopRef.current?.focus();
    else if (!running && (active === stopRef.current || active === document.body))
      boxRef.current?.focus();
  }, [running]);

  const outcome = outcomeWords(turn, messages);
  const cost = costOf(turn);
  const price =
    cost === null
      ? null
      : new Intl.NumberFormat(i18n.locale, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 4,
        }).format(cost);
  const sendFailure = send.isError
    ? (refusalWords(send.error) ??
      t`Your message couldn’t be sent. Check your connection and try again.`)
    : null;
  const decided = decide.variables?.proposal.id;
  const decideFailure = decide.isError
    ? (refusalWords(decide.error) ??
      t`That didn’t go through. Check your connection and try again.`)
    : null;
  const connectHref =
    context.data === undefined ? null : targetLink(slug, context.data.connect, here);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="region"
        aria-label={t`Conversation`}
        // Scrolls by itself, so the keyboard has to be able to reach it.
        // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <div className={cn('flex min-w-0 flex-col gap-3', columnClassName)}>
          {context.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <p>
                <Trans>The assistant couldn’t load. Check your connection.</Trans>
              </p>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void context.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : null}
          {context.data !== undefined && !canAsk(context.data) ? (
            <div className="flex min-w-0 flex-col gap-1.5 rounded-card bg-secondary p-3 text-sm text-body">
              <p className="wrap-anywhere">{words(unavailableWords(context.data))}</p>
              {connectHref === null ? null : (
                <p>
                  <PageLink href={connectHref}>
                    <Trans>Open Settings → AI models</Trans>
                  </PageLink>
                </p>
              )}
            </div>
          ) : null}
          {context.data === undefined ? null : (
            <Checks context={context.data} slug={slug} here={here} />
          )}
          {gone ? (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <p>
                <Trans>This conversation is no longer here. It was deleted, or it expired.</Trans>
              </p>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  onThread(null);
                }}
              >
                <Trans>Start a new one</Trans>
              </Button>
            </div>
          ) : conversation.isError && held === undefined ? (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <p>
                <Trans>This conversation couldn’t load. Check your connection.</Trans>
              </p>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void conversation.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : null}
          {threadId === null && askable ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Ask about this page, or describe what you want built. Nothing goes live until you
                confirm it.
              </Trans>
            </p>
          ) : null}
          <div
            role="log"
            aria-label={t`Messages`}
            className="flex min-w-0 flex-col gap-3 empty:hidden"
          >
            {gone
              ? null
              : groupMessages(messages).map((group) => {
                  if (group.kind === 'steps')
                    return <Steps key={group.key} steps={group.steps} slug={slug} here={here} />;
                  const { message } = group;
                  if (message.kind === 'user')
                    return (
                      <div
                        key={group.key}
                        className="max-w-[85%] self-end rounded-card bg-accent px-3 py-2 text-md wrap-anywhere whitespace-pre-wrap"
                      >
                        <span className="sr-only">
                          <Trans>You:</Trans>{' '}
                        </span>
                        {message.text}
                      </div>
                    );
                  if (message.kind === 'proposal' && message.proposal !== null)
                    return (
                      <ProposalCard
                        key={group.key}
                        proposal={message.proposal}
                        busy={decide.isPending}
                        failure={decided === message.proposal.id ? decideFailure : null}
                        onDecide={(decision, proposal) => {
                          decide.mutate({ decision, proposal });
                        }}
                      />
                    );
                  if (message.kind === 'error')
                    return (
                      <p
                        key={group.key}
                        className={cn(
                          'flex min-w-0 gap-2 text-sm wrap-anywhere',
                          message.code === 'cancelled' ? 'text-muted-foreground' : 'text-body',
                        )}
                      >
                        {message.code === 'cancelled' ? null : (
                          <CircleAlert
                            aria-hidden
                            className="mt-0.5 size-4 shrink-0 text-destructive"
                            strokeWidth={1.8}
                          />
                        )}
                        <span className="min-w-0">{message.text}</span>
                      </p>
                    );
                  return (
                    <div key={group.key} className="text-md wrap-anywhere whitespace-pre-wrap">
                      <span className="sr-only">
                        <Trans>Assistant:</Trans>{' '}
                      </span>
                      {message.text}
                    </div>
                  );
                })}
          </div>
          {outcome === null ? null : (
            <p className="text-sm wrap-anywhere text-body">{words(outcome)}</p>
          )}
          {running ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle
                aria-hidden
                className="size-4 shrink-0 motion-safe:animate-spin"
                strokeWidth={1.8}
              />
              {turn?.cancelRequested === true ? <Trans>Stopping…</Trans> : <Trans>Working…</Trans>}
            </p>
          ) : price === null ? null : (
            <p className={labelClassName}>
              <Trans>That answer cost about {price}.</Trans>
            </p>
          )}
        </div>
      </div>
      {askable ? (
        <div className="shrink-0 border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          <div className={cn('flex min-w-0 flex-col gap-2', columnClassName)}>
            {context.data === undefined || context.data.chips.length === 0 ? null : (
              <div
                role="group"
                aria-label={t`Things to ask`}
                className="flex min-w-0 flex-wrap gap-1.5"
              >
                {context.data.chips.map((chip) => (
                  <button
                    key={chip.code}
                    type="button"
                    disabled={waiting}
                    onClick={() => {
                      submit(chip.prompt);
                    }}
                    className="min-h-10 rounded-full border border-input bg-card px-3 text-left text-sm text-body hover:bg-muted disabled:opacity-50 lg:min-h-8"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            )}
            {sendFailure === null ? null : (
              <p role="alert" className="text-sm wrap-anywhere text-destructive">
                {sendFailure}
              </p>
            )}
            <form
              className="flex min-w-0 items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit(draft);
              }}
            >
              <textarea
                ref={setBox}
                rows={1}
                value={draft}
                disabled={running}
                maxLength={ASSISTANT_LIMITS.messageLength}
                aria-label={t`Message the assistant`}
                placeholder={t`Ask, or describe what to build…`}
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  submit(draft);
                }}
                className="max-h-[132px] min-h-11 min-w-0 flex-1 resize-none rounded-control border border-input bg-card px-3 py-2.5 text-md text-foreground placeholder:text-muted-foreground disabled:opacity-50 lg:min-h-9 lg:py-2"
              />
              {running && turn !== null ? (
                <Button
                  // Its own button, not Send redrawn: when it goes, the keyboard is free to
                  // go back to the box.
                  key="stop"
                  ref={stopRef}
                  variant="secondary"
                  aria-label={t`Stop`}
                  title={t`Stop`}
                  className="px-2.5 aria-disabled:opacity-50"
                  disabled={stop.isPending || turn.cancelRequested}
                  focusableWhenDisabled
                  onClick={() => {
                    stop.mutate(turn.id);
                  }}
                >
                  <Square aria-hidden className="size-4" strokeWidth={2} />
                </Button>
              ) : (
                <Button
                  key="send"
                  type="submit"
                  aria-label={t`Send`}
                  title={t`Send`}
                  className="px-2.5 aria-disabled:opacity-50"
                  disabled={draft.trim() === '' || send.isPending}
                  focusableWhenDisabled
                >
                  <ArrowUp aria-hidden className="size-4" strokeWidth={2} />
                </Button>
              )}
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
