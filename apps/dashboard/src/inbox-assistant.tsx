// The assistant in one conversation: the reply it drafted, as a draft card to send, change
// or set aside; the changes it suggests, as approval cards with before and after; what was
// done on its suggestion, with Undo where that is possible; and how much it does on its own
// for this contact.
//
// "The AI works, people decide": nothing here sends or changes anything by itself. Every
// button runs the proposal's own command as the person, and the server checks their role
// again. What the assistant wrote is shown as text and never run; what it was written from
// is what the product counted, never the model's account of itself.
//
// This is its own chunk (inbox-assistant-loader.tsx), with everything of the assistant's
// in it: what it reads, what it shows and what its buttons send. A business with no
// assistant gets an empty place from it, and nothing else.
import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  dismissProposal,
  getConversationAssistant,
  requestReplyDraft,
  setAutonomy,
  undoProposal,
  type Actor,
  type AutonomyLevel,
  type Conversation,
  type ConversationAssistant,
  type ConversationComposer,
  type Proposal,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { useActorLabel } from './activity';
import { apiIn } from './api';
import { AutonomyControl } from './autonomy-control';
import { levelAlreadySet } from './autonomy-rules';
import {
  assistantViewOf,
  basisOf,
  canWriteReply,
  firstNameOf,
  isQuiet,
  pollEveryOf,
  recentLineOf,
  replyActionsOf,
  replyRouteOf,
  staleReasonOf,
  statusSuggestionOf,
  stillOffered,
  statusWords,
  type AssistantAction,
  type DraftNotice,
  type ReplyProposal,
  type StatusProposal,
} from './inbox-assistant-rules';
import { ReplyDelivery, ReplyHandedOver, type AssistantDraft } from './inbox-composer';
import { applyProposalIn } from './inbox-assistant-data';

// For the thread, which applies a draft changed in the reply box: the same chunk, fetched once.
export { applyProposalIn };
import { inboxKeys, retryRead } from './inbox-data';
import {
  deliveryOf,
  failureOf,
  shortTimeOf,
  type ActionFailure,
  type Delivery,
} from './inbox-rules';
import { MessageText } from './inbox-text';
import { useBusiness } from './workspace';

export interface AssistantProps {
  readonly conversationId: string;
  readonly contact: Conversation['contact'];
  /** The contact as the thread names them. */
  readonly contactName: string;
  readonly composer: ConversationComposer | undefined;
  /** When the contact last wrote, to say why a draft is out of date. */
  readonly lastInboundAt: string | undefined;
  /** The proposal the reply box is changing right now, if it holds one. */
  readonly editing: string | undefined;
  /** Hands a drafted reply to the reply box, which takes the keyboard. */
  readonly onEdit: (draft: AssistantDraft) => void;
}

/** What a button was about, for the words of a refusal. */
type Subject = 'reply' | 'status' | 'draft';

/** What the last action came to, said under the cards. */
type Said =
  | { readonly kind: 'delivery'; readonly delivery: Delivery }
  | { readonly kind: 'handed_over' }
  | { readonly kind: 'status'; readonly to: Conversation['status'] }
  | { readonly kind: 'dismissed'; readonly subject: 'reply' | 'status' }
  | { readonly kind: 'undone'; readonly back: Conversation['status'] }
  | {
      readonly kind: 'failed';
      readonly failure: ActionFailure;
      readonly subject: Subject;
      /** Whether it was a send that failed: only then is "it won't go twice" worth saying. */
      readonly sending: boolean;
    };

type Busy = AssistantAction;

const cardClassName =
  'flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 focus:outline-none focus-visible:outline-2';
const whileBusy = 'aria-disabled:opacity-50';
const noDraftLabel = msg`No draft`;
const someone = msg`Someone on your team`;
const sentForGood = msg`A message that was sent can’t be unsent.`;

/**
 * Reads what the assistant proposes for the conversation, and shows it. Its key is under
 * the Inbox's, so the realtime hint that something changed in the business refreshes it; a
 * hint can be missed, so while a draft is being written it is also asked for every few
 * seconds. Reading never calls a model.
 */
export default function Assistant(props: AssistantProps): ReactElement | null {
  const business = useBusiness();
  const assistant = useQuery({
    queryKey: inboxKeys.assistant(business.id, props.conversationId),
    queryFn: () =>
      apiIn(business.id).request(getConversationAssistant, {
        params: { id: props.conversationId },
      }),
    retry: retryRead,
    refetchInterval: (query) => pollEveryOf(query.state.data),
  });
  if (assistant.data !== undefined) return <AssistantPanel {...props} assistant={assistant.data} />;
  // Nothing while it loads, and nothing when the server said why it won't answer: the
  // thread says that for itself. A read that failed some other way is worth another try.
  const unread =
    assistant.isError && !(assistant.error instanceof ApiError && assistant.error.status < 500);
  return unread ? (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <p>
        <Trans>Your assistant’s suggestions couldn’t be loaded.</Trans>
      </p>
      <Button
        variant="secondary"
        size="small"
        onClick={() => {
          void assistant.refetch();
        }}
      >
        <Trans>Try again</Trans>
      </Button>
    </div>
  ) : null;
}

function AssistantPanel({
  conversationId,
  contact,
  contactName,
  assistant,
  composer,
  lastInboundAt,
  editing,
  onEdit,
}: AssistantProps & { readonly assistant: ConversationAssistant }): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const client = apiIn(business.id);
  const assistantKey = inboxKeys.assistant(business.id, conversationId);
  const autonomyId = useId();
  const view = assistantViewOf(assistant);
  const who = firstNameOf(contact.name) ?? t`this contact`;

  const [busy, setBusy] = useState<Busy>();
  const [said, setSaid] = useState<Said>();
  // One request at a time, whatever a second click arrives before.
  const inFlightRef = useRef(false);
  const saidRef = useRef<HTMLDivElement>(null);
  const writingRef = useRef<HTMLParagraphElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // A button that did its work is often gone with its card. The keyboard then goes to what
  // the page says came of it, once the page says it.
  const moveRef = useRef<'said' | 'writing' | undefined>(undefined);
  const [moves, setMoves] = useState(0);
  useEffect(() => {
    const move = moveRef.current;
    moveRef.current = undefined;
    if (move === 'said') saidRef.current?.focus();
    if (move === 'writing') writingRef.current?.focus();
  }, [moves]);
  const moveTo = (where: 'said' | 'writing'): void => {
    moveRef.current = where;
    setMoves((count) => count + 1);
  };

  // A draft that arrives is said aloud once. If the keyboard was waiting on "writing…",
  // it goes to the draft, or to why there is none.
  const replyId = view.reply?.id;
  const [seen, setSeen] = useState({ writing: view.writing, replyId });
  const [arrived, setArrived] = useState('');
  if (seen.writing !== view.writing || seen.replyId !== replyId) {
    setSeen({ writing: view.writing, replyId });
    // Said while the draft waits, and no longer once it was sent or set aside.
    if (view.writing || replyId === undefined) setArrived('');
    else if (seen.writing && replyId !== seen.replyId) {
      setArrived(t`Your assistant drafted a reply. It’s waiting for you.`);
    }
  }
  useEffect(() => {
    if (view.writing || document.activeElement !== writingRef.current) return;
    (cardRef.current ?? noticeRef.current ?? saidRef.current)?.focus();
  }, [view.writing]);

  /** What was last read from the API: a moment ahead of what the page shows. */
  const read = (): ConversationAssistant =>
    cache.getQueryData<ConversationAssistant>(assistantKey) ?? assistant;
  const run = async (
    which: Busy,
    subject: Subject,
    proposalId: string | undefined,
    action: () => Promise<Said | undefined>,
  ): Promise<void> => {
    // One request at a time, and none for a button whose offer has already been taken up.
    if (inFlightRef.current || !stillOffered(read(), which, proposalId)) return;
    inFlightRef.current = true;
    setBusy(which);
    setSaid(undefined);
    try {
      const next = await action();
      setSaid(next);
      moveTo(next === undefined ? 'writing' : 'said');
    } catch (error) {
      const failure = failureOf(error);
      // A refusal means the page was out of date: read what is true now, before another
      // click can ask again. The card may change under the button, so the keyboard goes to
      // the reason.
      if (error instanceof ApiError) await cache.invalidateQueries({ queryKey: assistantKey });
      setSaid({ kind: 'failed', failure, subject, sending: which === 'send' });
      if (failure.kind === 'conflict' || failure.kind === 'forbidden') moveTo('said');
    } finally {
      inFlightRef.current = false;
      setBusy(undefined);
    }
  };

  const place = { businessId: business.id, conversationId };
  const send = (proposal: ReplyProposal): void => {
    void run('send', 'reply', proposal.id, async () => {
      const { message } = await applyProposalIn(cache, client, place, proposal.id);
      return message === undefined
        ? { kind: 'handed_over' }
        : { kind: 'delivery', delivery: deliveryOf(message) };
    });
  };
  const apply = (proposal: StatusProposal): void => {
    void run('apply', 'status', proposal.id, async () => {
      await applyProposalIn(cache, client, place, proposal.id);
      return { kind: 'status', to: proposal.change.to };
    });
  };
  const dismiss = (proposal: Proposal, subject: 'reply' | 'status'): void => {
    void run('dismiss', subject, proposal.id, async () => {
      await client.request(dismissProposal, { params: { id: proposal.id } });
      await cache.invalidateQueries({ queryKey: assistantKey });
      return { kind: 'dismissed', subject };
    });
  };
  const undo = (proposal: StatusProposal): void => {
    void run('undo', 'status', proposal.id, async () => {
      await client.request(undoProposal, { params: { id: proposal.id } });
      await cache.invalidateQueries({ queryKey: inboxKeys.all(business.id) });
      return { kind: 'undone', back: proposal.change.from };
    });
  };
  const draft = (): void => {
    void run('draft', 'draft', undefined, async () => {
      const request = await client.request(requestReplyDraft, { params: { id: conversationId } });
      // "Writing…" shows at once; the server's own answer follows.
      cache.setQueryData<ConversationAssistant>(assistantKey, (current) =>
        current === undefined ? current : { ...current, draft: request },
      );
      void cache.invalidateQueries({ queryKey: assistantKey });
      return undefined;
    });
  };
  const setLevel = async (level: AutonomyLevel | null): Promise<void> => {
    if (levelAlreadySet(read().autonomy, level, 'contact')) return;
    const saved = await client.request(setAutonomy, {
      body: { agent: 'inbox', action: 'send_message', contactId: contact.id, level },
    });
    cache.setQueryData<ConversationAssistant>(assistantKey, (current) =>
      current === undefined
        ? current
        : { ...current, autonomy: { ...saved, canChange: current.autonomy.canChange } },
    );
    void cache.invalidateQueries({ queryKey: assistantKey });
  };

  if (isQuiet(view) && said === undefined && busy === undefined) return null;

  const busyWords = {
    send: t`Sending…`,
    apply: t`Applying…`,
    dismiss: t`Setting it aside…`,
    undo: t`Undoing…`,
    draft: t`Asking your assistant…`,
  } satisfies Record<Busy, string>;

  return (
    <section aria-label={t`Assistant`} className="flex min-w-0 flex-col gap-3">
      {view.reply === undefined ? null : (
        <ReplyCard
          ref={cardRef}
          proposal={view.reply}
          contactName={contactName}
          who={who}
          route={replyRouteOf(composer, view.reply.change)}
          stale={staleReasonOf(view.reply, lastInboundAt)}
          editing={editing === view.reply.id}
          actions={replyActionsOf({
            proposal: view.reply,
            level: assistant.autonomy.level,
            canEdit: canWriteReply(composer),
            canDraft: view.canDraft,
          })}
          busy={busy !== undefined}
          onSend={send}
          onEdit={onEdit}
          onDismiss={(proposal) => {
            dismiss(proposal, 'reply');
          }}
          onRedraft={draft}
        />
      )}
      {view.changes.map((proposal) => (
        <StatusCard
          key={proposal.id}
          proposal={proposal}
          busy={busy !== undefined}
          onApply={apply}
          onDismiss={(each) => {
            dismiss(each, 'status');
          }}
        />
      ))}

      <p
        ref={writingRef}
        role="status"
        tabIndex={-1}
        className={`text-sm text-muted-foreground focus:outline-none focus-visible:outline-2 ${
          view.writing ? '' : 'sr-only'
        }`}
      >
        {view.writing ? t`Your assistant is writing a reply…` : arrived}
      </p>
      {view.notice === undefined ? null : (
        <DraftNoticeCard
          ref={noticeRef}
          notice={view.notice}
          canManage={assistant.autonomy.canChange}
          canRetry={view.canDraft}
          busy={busy !== undefined}
          onRetry={draft}
        />
      )}
      {view.offerDraft ? (
        <Button
          variant="secondary"
          size="small"
          className={`self-start ${whileBusy}`}
          disabled={busy !== undefined}
          focusableWhenDisabled
          onClick={draft}
        >
          <Trans>Draft a reply</Trans>
        </Button>
      ) : null}

      <div
        ref={saidRef}
        tabIndex={-1}
        className="min-w-0 empty:hidden focus:outline-none focus-visible:outline-2"
      >
        {busy === undefined ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {busyWords[busy]}
          </p>
        )}
        {said === undefined ? null : <SaidLine said={said} contactName={contactName} />}
      </div>

      {view.recent.length === 0 ? null : (
        <ul
          aria-label={t`What was done on your assistant’s suggestions`}
          className="flex flex-col gap-2"
        >
          {view.recent.map((proposal) => (
            <RecentItem
              key={proposal.id}
              proposal={proposal}
              busy={busy !== undefined}
              onUndo={undo}
            />
          ))}
        </ul>
      )}

      {view.autonomy === 'hidden' ? null : (
        <div className="flex min-w-0 flex-col gap-2 rounded-card border bg-card p-4">
          <h3 id={autonomyId} className="text-sm font-medium text-muted-foreground">
            {t`Your assistant for ${who}`}
          </h3>
          <AutonomyControl
            labelledBy={autonomyId}
            level={assistant.autonomy.level}
            who={who}
            canChange={view.autonomy === 'control'}
            businessLevel={
              assistant.autonomy.source === 'contact' ? assistant.autonomy.businessLevel : undefined
            }
            onSet={setLevel}
          />
        </div>
      )}
    </section>
  );
}

function ReplyCard({
  ref,
  proposal,
  contactName,
  who,
  route,
  stale,
  editing,
  actions,
  busy,
  onSend,
  onEdit,
  onDismiss,
  onRedraft,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly proposal: ReplyProposal;
  readonly contactName: string;
  readonly who: string;
  readonly route: ReturnType<typeof replyRouteOf>;
  readonly stale: ReturnType<typeof staleReasonOf>;
  readonly editing: boolean;
  readonly actions: ReturnType<typeof replyActionsOf>;
  readonly busy: boolean;
  readonly onSend: (proposal: ReplyProposal) => void;
  readonly onEdit: (draft: AssistantDraft) => void;
  readonly onDismiss: (proposal: ReplyProposal) => void;
  readonly onRedraft: () => void;
}): ReactElement {
  const { t } = useLingui();
  const labelId = useId();
  const whyId = useId();
  const [why, setWhy] = useState(false);
  const { change } = proposal;
  const edit = (): void => {
    onEdit({
      proposalId: proposal.id,
      channel: change.channel,
      accountId: change.accountId,
      to: change.to,
      subject: change.subject,
      text: change.text,
    });
  };
  const offered = (action: (typeof actions)[number]): boolean => actions.includes(action);
  return (
    <div ref={ref} role="group" aria-labelledby={labelId} tabIndex={-1} className={cardClassName}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="assistant" className="px-2.5 py-0.5 text-xs">
          <Trans>Assistant</Trans>
        </Badge>
        <span id={labelId} className="min-w-0 text-sm text-muted-foreground">
          {stale === undefined ? (
            <Trans>Suggested reply, waiting for you</Trans>
          ) : (
            <Trans>Suggested reply, now out of date</Trans>
          )}
        </span>
        <Button
          variant="quiet"
          size="small"
          className="ml-auto text-link"
          aria-expanded={why}
          aria-controls={whyId}
          onClick={() => {
            setWhy(!why);
          }}
        >
          <Trans>Why this reply?</Trans>
        </Button>
      </div>
      {change.subject === null || change.subject === '' ? null : (
        <p className="font-semibold wrap-anywhere">{change.subject}</p>
      )}
      <MessageText text={change.text} className="text-[17px] leading-normal" />
      {route === undefined ? null : (
        <p className="text-[13px] wrap-anywhere text-muted-foreground">
          <ReplyRouteWords route={route} />
        </p>
      )}
      <div id={whyId} hidden={!why} className="rounded-control bg-secondary p-3 text-sm">
        {why ? <BasisWords proposal={proposal} who={who} /> : null}
      </div>
      {stale === undefined ? null : (
        <p className="text-sm font-medium">
          {stale === 'contact_wrote'
            ? t`${contactName} wrote again after this was drafted, so it can’t be sent as it is.`
            : t`This conversation changed after this was drafted, so it can’t be sent as it is.`}
        </p>
      )}
      {stale === undefined && !proposal.canDecide ? (
        <p className="text-sm text-muted-foreground">
          <PermissionWords subject="reply" />
        </p>
      ) : null}
      {editing ? (
        <p className="text-sm text-muted-foreground">
          <Trans>You’re changing this draft in the reply box below.</Trans>
        </p>
      ) : actions.length === 0 ? null : (
        <div className="flex min-w-0 flex-wrap gap-2.5">
          {offered('send') ? (
            <Button
              className={whileBusy}
              disabled={busy}
              focusableWhenDisabled
              onClick={() => {
                onSend(proposal);
              }}
            >
              <Trans>Send it</Trans>
            </Button>
          ) : null}
          {offered('use') ? (
            <Button className={whileBusy} disabled={busy} focusableWhenDisabled onClick={edit}>
              <Trans>Use this draft</Trans>
            </Button>
          ) : null}
          {offered('change') ? (
            <Button
              variant="secondary"
              className={whileBusy}
              disabled={busy}
              focusableWhenDisabled
              onClick={edit}
            >
              <Trans>Change it</Trans>
            </Button>
          ) : null}
          {offered('redraft') ? (
            <Button
              variant="secondary"
              className={whileBusy}
              disabled={busy}
              focusableWhenDisabled
              onClick={onRedraft}
            >
              <Trans>Draft a new reply</Trans>
            </Button>
          ) : null}
          {offered('dismiss') ? (
            <Button
              variant="quiet"
              className={whileBusy}
              disabled={busy}
              focusableWhenDisabled
              onClick={() => {
                onDismiss(proposal);
              }}
            >
              <Trans>Not now</Trans>
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Where the draft would go, in words: the channel, the account and the address. */
function ReplyRouteWords({
  route,
}: {
  readonly route: NonNullable<ReturnType<typeof replyRouteOf>>;
}): ReactElement {
  const { from, to } = route;
  if (route.channel === 'webchat') {
    return <Trans>In web chat, from {from} to the visitor in their chat</Trans>;
  }
  return route.channel === 'email' ? (
    <Trans>
      By email, from {from} to {to}
    </Trans>
  ) : (
    <Trans>
      By text message, from {from} to {to}
    </Trans>
  );
}

/** What the product counted that the assistant was given. Never the model's own reasons. */
function BasisWords({
  proposal,
  who,
}: {
  readonly proposal: ReplyProposal;
  readonly who: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const { parts, knowledge } = basisOf(proposal.basis);
  const listed = (items: readonly string[]): string =>
    new Intl.ListFormat(i18n.locale || undefined, { style: 'long', type: 'conjunction' }).format(
      items,
    );
  const sources = listed(
    parts.map((part) =>
      part.kind === 'messages'
        ? plural(part.count, {
            one: 'the last message here',
            other: 'the last # messages here',
          })
        : part.kind === 'facts'
          ? plural(part.count, {
              one: `# thing your assistant knows about ${who}`,
              other: `# things your assistant knows about ${who}`,
            })
          : t`their saved summary`,
    ),
  );
  const names = listed(knowledge);
  if (parts.length === 0 && knowledge.length === 0) {
    return (
      <p>
        <Trans>Nothing was recorded about what this draft was written from.</Trans>
      </p>
    );
  }
  return (
    <p className="wrap-anywhere">
      {parts.length === 0 ? null : t`Written from ${sources}.`}
      {parts.length === 0 || knowledge.length === 0 ? null : ' '}
      {knowledge.length === 0
        ? null
        : parts.length === 0
          ? t`Your assistant was given: ${names}.`
          : t`It was also given: ${names}.`}
    </p>
  );
}

/** The line someone reads when their role can't do what a card offers. */
function PermissionWords({ subject }: { readonly subject: Subject }): ReactElement {
  return subject === 'reply' ? (
    <Trans>Sending this reply needs a permission your role doesn’t have.</Trans>
  ) : subject === 'status' ? (
    <Trans>Changing this conversation needs a permission your role doesn’t have.</Trans>
  ) : (
    <Trans>Asking your assistant for a draft needs a permission your role doesn’t have.</Trans>
  );
}

function StatusCard({
  proposal,
  busy,
  onApply,
  onDismiss,
}: {
  readonly proposal: StatusProposal;
  readonly busy: boolean;
  readonly onApply: (proposal: StatusProposal) => void;
  readonly onDismiss: (proposal: StatusProposal) => void;
}): ReactElement {
  const { i18n } = useLingui();
  const labelId = useId();
  const { change } = proposal;
  const suggestion = statusSuggestionOf(change);
  const until =
    change.until === null
      ? null
      : new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(change.until),
        );
  const from = i18n._(statusWords[change.from]);
  const to = i18n._(statusWords[change.to]);
  return (
    <div role="group" aria-labelledby={labelId} className={cardClassName}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant="assistant" className="px-2.5 py-0.5 text-xs">
          <Trans>Assistant</Trans>
        </Badge>
        <span id={labelId} className="min-w-0 text-md font-medium">
          {suggestion === 'close' ? (
            <Trans>Your assistant suggests closing this conversation</Trans>
          ) : suggestion === 'reopen' ? (
            <Trans>Your assistant suggests reopening this conversation</Trans>
          ) : until === null ? (
            <Trans>Your assistant suggests snoozing this conversation</Trans>
          ) : (
            <Trans>Your assistant suggests snoozing this conversation until {until}</Trans>
          )}
        </span>
      </div>
      <p className="text-sm">
        <Trans>
          {from} → {to}
        </Trans>
      </p>
      {proposal.stale ? (
        <p className="text-sm font-medium">
          <Trans>
            This conversation changed after this was suggested, so it can’t be applied as it is.
          </Trans>
        </p>
      ) : proposal.canDecide ? null : (
        <p className="text-sm text-muted-foreground">
          <PermissionWords subject="status" />
        </p>
      )}
      {proposal.canDecide ? (
        <div className="flex min-w-0 flex-wrap gap-2.5">
          {proposal.stale ? null : (
            <Button
              size="small"
              className={whileBusy}
              disabled={busy}
              focusableWhenDisabled
              onClick={() => {
                onApply(proposal);
              }}
            >
              <Trans>Apply</Trans>
            </Button>
          )}
          <Button
            variant="quiet"
            size="small"
            className={whileBusy}
            disabled={busy}
            focusableWhenDisabled
            onClick={() => {
              onDismiss(proposal);
            }}
          >
            <Trans>Dismiss</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Why there is no draft, and the way forward: another try, or Settings. */
function DraftNoticeCard({
  ref,
  notice,
  canManage,
  canRetry,
  busy,
  onRetry,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly notice: DraftNotice;
  /** Whether this person may manage AI: only they are sent to its settings. */
  readonly canManage: boolean;
  readonly canRetry: boolean;
  readonly busy: boolean;
  readonly onRetry: () => void;
}): ReactElement {
  const { i18n } = useLingui();
  const business = useBusiness();
  return (
    <div
      ref={ref}
      role="group"
      aria-label={i18n._(noDraftLabel)}
      tabIndex={-1}
      className={`${cardClassName} text-sm`}
    >
      <p>{i18n._(notice.words)}</p>
      {!notice.settings ? null : canManage ? (
        <p>
          <Link
            to="/b/$slug/settings/ai-models"
            params={{ slug: business.slug }}
            className="inline-flex min-h-11 items-center text-link underline underline-offset-2"
          >
            <Trans>Open AI models in Settings</Trans>
          </Link>
        </p>
      ) : (
        <p className="text-muted-foreground">
          <Trans>Ask someone who manages AI for this business to look at it in Settings.</Trans>
        </p>
      )}
      {notice.retry === null || !canRetry ? null : (
        <Button
          variant="secondary"
          size="small"
          className={`self-start ${whileBusy}`}
          disabled={busy}
          focusableWhenDisabled
          onClick={onRetry}
        >
          {notice.retry === 'draft_again' ? <Trans>Draft again</Trans> : <Trans>Try again</Trans>}
        </Button>
      )}
    </div>
  );
}

function SaidLine({
  said,
  contactName,
}: {
  readonly said: Said;
  readonly contactName: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  if (said.kind === 'delivery') {
    return <ReplyDelivery delivery={said.delivery} contactName={contactName} kept={false} />;
  }
  if (said.kind === 'failed') {
    const { failure } = said;
    return (
      <p role="alert" className="text-sm text-destructive">
        {failure.kind === 'conflict' ? (
          failure.detail
        ) : failure.kind === 'refused' ? (
          failure.words === undefined ? (
            failure.message
          ) : (
            i18n._(failure.words)
          )
        ) : failure.kind === 'forbidden' ? (
          <PermissionWords subject={said.subject} />
        ) : failure.kind === 'other' ? (
          failure.message
        ) : said.sending ? (
          t`That didn’t go through. Check your connection and try again. Trying again won’t send it twice.`
        ) : (
          t`That didn’t go through. Check your connection and try again.`
        )}
      </p>
    );
  }
  const words: ReactNode =
    said.kind === 'handed_over' ? (
      <ReplyHandedOver />
    ) : said.kind === 'status' ? (
      said.to === 'closed' ? (
        t`Conversation closed.`
      ) : said.to === 'snoozed' ? (
        t`Conversation snoozed.`
      ) : (
        t`Conversation reopened.`
      )
    ) : said.kind === 'dismissed' ? (
      said.subject === 'reply' ? (
        t`Draft set aside. Nothing was sent.`
      ) : (
        t`Suggestion dismissed. Nothing was changed.`
      )
    ) : said.back === 'open' ? (
      t`Undone: the conversation is open again.`
    ) : said.back === 'closed' ? (
      t`Undone: the conversation is closed again.`
    ) : (
      t`Undone: the conversation is snoozed again.`
    );
  return (
    <p role="status" className="text-sm">
      {words}
    </p>
  );
}

/** One quiet line for what was applied or undone in the last day. */
function RecentItem({
  proposal,
  busy,
  onUndo,
}: {
  readonly proposal: Proposal;
  readonly busy: boolean;
  readonly onUndo: (proposal: StatusProposal) => void;
}): ReactElement | null {
  const { i18n } = useLingui();
  const actorLabel = useActorLabel();
  const lineId = useId();
  const [now] = useState(() => new Date());
  const line = recentLineOf(proposal);
  if (line === undefined) return null;
  const undone = line === 'status_undone';
  const actor: Actor | null = undone ? proposal.undoneBy : proposal.decidedBy;
  const at = undone ? proposal.undoneAt : proposal.decidedAt;
  const byYou = actor?.you === true;
  const name = actor === null ? i18n._(someone) : actorLabel(actor);
  const status = proposal.change.kind === 'conversation_status' ? proposal.change : undefined;
  const from = status === undefined ? '' : i18n._(statusWords[status.from]);
  const to = status === undefined ? '' : i18n._(statusWords[status.to]);
  const words: ReactNode =
    line === 'assistant_replied' ? (
      <Trans>Your assistant replied on its own</Trans>
    ) : line === 'reply_sent' ? (
      byYou ? (
        <Trans>You sent your assistant’s draft</Trans>
      ) : (
        <Trans>{name} sent your assistant’s draft</Trans>
      )
    ) : line === 'reply_sent_changed' ? (
      byYou ? (
        <Trans>You changed your assistant’s draft and sent it</Trans>
      ) : (
        <Trans>{name} changed your assistant’s draft and sent it</Trans>
      )
    ) : line === 'reply_not_sent' ? (
      byYou ? (
        <Trans>You approved your assistant’s draft, but it wasn’t sent. The thread says why.</Trans>
      ) : (
        <Trans>
          {name} approved your assistant’s draft, but it wasn’t sent. The thread says why.
        </Trans>
      )
    ) : line === 'status_undone' ? (
      byYou ? (
        <Trans>
          You undid a change your assistant suggested ({from} → {to})
        </Trans>
      ) : (
        <Trans>
          {name} undid a change your assistant suggested ({from} → {to})
        </Trans>
      )
    ) : status?.to === 'closed' ? (
      byYou ? (
        <Trans>Closed on your assistant’s suggestion by you</Trans>
      ) : (
        <Trans>Closed on your assistant’s suggestion by {name}</Trans>
      )
    ) : status?.to === 'snoozed' ? (
      byYou ? (
        <Trans>Snoozed on your assistant’s suggestion by you</Trans>
      ) : (
        <Trans>Snoozed on your assistant’s suggestion by {name}</Trans>
      )
    ) : byYou ? (
      <Trans>Reopened on your assistant’s suggestion by you</Trans>
    ) : (
      <Trans>Reopened on your assistant’s suggestion by {name}</Trans>
    );
  const canUndo =
    line === 'status_applied' &&
    proposal.undo?.available === true &&
    proposal.canDecide &&
    status !== undefined;
  // Why there is no Undo beside a reply the assistant sent: ours for the reason the
  // contract names, or else the server's own.
  const whyNot =
    line !== 'assistant_replied' || proposal.undo === null || proposal.undo.available
      ? null
      : proposal.undo.reason === 'message_sent'
        ? i18n._(sentForGood)
        : proposal.undo.message;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
      <span id={lineId} className="min-w-0">
        {words}
      </span>
      {at === null ? null : (
        <>
          <span aria-hidden>·</span>
          <time dateTime={at}>{shortTimeOf(at, now, i18n.locale)}</time>
        </>
      )}
      {canUndo ? (
        <Button
          variant="quiet"
          size="small"
          className={`text-link ${whileBusy}`}
          aria-describedby={lineId}
          disabled={busy}
          focusableWhenDisabled
          onClick={() => {
            onUndo({ ...proposal, change: status });
          }}
        >
          <Trans>Undo</Trans>
        </Button>
      ) : null}
      {whyNot === null ? null : <span className="w-full">{whyNot}</span>}
    </li>
  );
}
