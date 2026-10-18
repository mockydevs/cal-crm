// What the assistant's conversation decides without drawing anything, as pure functions
// with tests beside them: how messages read after a cursor join what is on screen, which
// rows are drawn together, why a turn ended, what a confirmation card offers, and what a
// refusal says.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type {
  AssistantContext,
  AssistantMessage,
  AssistantTurn,
  AssistantTurnOutcome,
  Proposal,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';

/** A conversation as the panel holds it: everything read so far, and where reading stopped. */
export interface Conversation {
  readonly title: string;
  /** Oldest first. */
  readonly messages: readonly AssistantMessage[];
  /** The place of the newest message read: what is asked for comes after it. */
  readonly cursor: number;
  /** The newest turn: the one running, or the last that finished. */
  readonly turn: AssistantTurn | null;
}

/** Messages read later put among those already held: one for each place, oldest first. */
export function mergeMessages(
  held: readonly AssistantMessage[],
  read: readonly AssistantMessage[],
): readonly AssistantMessage[] {
  if (read.length === 0) return held;
  const bySeq = new Map(held.map((message) => [message.seq, message]));
  for (const message of read) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((one, other) => one.seq - other.seq);
}

/** Whether more messages are still to come: the turn is waiting for a worker, or running. */
export function turnIsRunning(turn: AssistantTurn | null | undefined): boolean {
  return turn !== null && turn !== undefined && turn.status !== 'finished';
}

/** What a conversation shows in one place: a message, or the steps taken one after another. */
export type MessageGroup =
  | { readonly kind: 'message'; readonly key: string; readonly message: AssistantMessage }
  | { readonly kind: 'steps'; readonly key: string; readonly steps: readonly AssistantMessage[] };

/** Activity rows that follow one another are one quiet list; everything else stands alone. */
export function groupMessages(messages: readonly AssistantMessage[]): readonly MessageGroup[] {
  const groups: MessageGroup[] = [];
  const latestCalls = new Map<string, number>();
  for (const message of messages) {
    if (message.kind === 'activity' && message.activity?.callId !== undefined)
      latestCalls.set(`${message.turnId}:${message.activity.callId}`, message.seq);
  }
  for (const message of messages) {
    if (
      message.kind === 'activity' &&
      message.activity?.callId !== undefined &&
      latestCalls.get(`${message.turnId}:${message.activity.callId}`) !== message.seq
    )
      continue;
    const last = groups.at(-1);
    if (message.kind !== 'activity') {
      groups.push({ kind: 'message', key: message.id, message });
    } else if (last?.kind === 'steps' && last.steps[0]?.turnId === message.turnId) {
      groups[groups.length - 1] = { ...last, steps: [...last.steps, message] };
    } else {
      groups.push({ kind: 'steps', key: message.id, steps: [message] });
    }
  }
  return groups;
}

// Ours, for a turn that ended with no sentence of the server's.
const outcomeFallbacks: Readonly<
  Record<Exclude<AssistantTurnOutcome, 'answered'>, MessageDescriptor>
> = {
  cancelled: msg`Stopped. What was already done stays done.`,
  step_limit: msg`The assistant stopped after the most steps one message gets. Ask it to carry on.`,
  time_limit: msg`The assistant stopped after the longest one message runs. Ask it to carry on.`,
  paused: msg`The business has reached its monthly AI spending limit, so the assistant stopped.`,
  ai_off: msg`AI is turned off for this business.`,
  not_configured: msg`No AI provider is connected yet.`,
  refused: msg`The model declined to answer that. Try asking in another way.`,
  failed: msg`The AI provider could not be reached or returned an error. Try again in a moment.`,
  no_access: msg`You no longer have access to the assistant in this business.`,
  interrupted: msg`The server restarted while the assistant was working, so it stopped. What was already done stays done.`,
};

/**
 * Why the newest turn ended without an answer, to say under the conversation: the server's
 * sentence, or ours where it sent none. Null while the turn runs, when it answered, and
 * when the conversation already ends that turn with a message that says so.
 */
export function outcomeWords(
  turn: AssistantTurn | null,
  messages: readonly AssistantMessage[],
): string | MessageDescriptor | null {
  if (turn?.status !== 'finished' || turn.outcome === null || turn.outcome === 'answered')
    return null;
  const said = messages.some(
    (message) =>
      message.turnId === turn.id &&
      message.kind === 'error' &&
      (message.code === turn.outcome || message.text === turn.message),
  );
  if (said) return null;
  return turn.message ?? outcomeFallbacks[turn.outcome];
}

/** What the turn's model calls came to, in US dollars, or null when it is not known. */
export function costOf(turn: AssistantTurn | null): number | null {
  if (turn?.status !== 'finished' || turn.costEstimate === null) return null;
  const cost = Number(turn.costEstimate);
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

/** Whether there is a box to type in: a model could be asked, and this person may ask. */
export function canAsk(context: Pick<AssistantContext, 'ai' | 'canUse'> | undefined): boolean {
  return context?.ai === 'ready' && context.canUse;
}

/** Ours, where the server gave no sentence for why there is no box to type in. */
export function unavailableWords(
  context: Pick<AssistantContext, 'ai' | 'canUse' | 'message'>,
): string | MessageDescriptor {
  if (context.message !== null) return context.message;
  if (context.ai === 'off') return msg`AI is turned off for this business.`;
  if (context.ai === 'not_connected') return msg`No AI provider is connected yet.`;
  return msg`Your role doesn’t include talking to the assistant.`;
}

/** What a confirmation card offers, by how its proposal stands. */
export interface CardState {
  /** Whether Confirm and "Not now" are drawn at all: only while it waits. */
  readonly waiting: boolean;
  /** Whether Confirm can be pressed. */
  readonly canConfirm: boolean;
  /** Whether "Not now" can be pressed: setting it aside needs the same permission. */
  readonly canDismiss: boolean;
  /** Why Confirm cannot be pressed, or what became of the proposal. */
  readonly words: MessageDescriptor | null;
  /** Whether Undo is offered. */
  readonly canUndo: boolean;
  /** The server's sentence for why an applied proposal cannot be undone. */
  readonly undoRefusal: string | null;
}

/** What a card offers and says, for a proposal as the server last answered it. */
export function cardStateOf(proposal: Proposal): CardState {
  const none = { canConfirm: false, canDismiss: false, canUndo: false, undoRefusal: null };
  const form = proposal.change.kind === 'form_publish';
  switch (proposal.status) {
    case 'pending':
      return {
        ...none,
        waiting: true,
        canConfirm: proposal.canDecide && !proposal.stale,
        canDismiss: proposal.canDecide,
        words: proposal.stale
          ? form
            ? msg`This form changed after the assistant asked, so it can’t be published from here. Ask again, or set this aside.`
            : msg`This changed after the assistant asked, so it can’t be confirmed as it is. Ask again, or set it aside.`
          : proposal.canDecide
            ? null
            : form
              ? msg`Your role doesn’t allow publishing forms. Someone who manages forms can publish it.`
              : msg`Your role doesn’t allow this, so someone who may has to confirm it.`,
      };
    case 'applied':
      return {
        ...none,
        waiting: false,
        words: null,
        canUndo: proposal.canDecide && proposal.undo?.available === true,
        undoRefusal:
          proposal.undo !== null && !proposal.undo.available ? proposal.undo.message : null,
      };
    case 'dismissed':
      return {
        ...none,
        waiting: false,
        words: form ? msg`Set aside. Nothing was published.` : msg`Set aside. Nothing was changed.`,
      };
    case 'expired':
      return {
        ...none,
        waiting: false,
        words: msg`This waited too long and expired. Ask again if you still want it.`,
      };
    case 'undone':
      return {
        ...none,
        waiting: false,
        words: form ? msg`Undone: the form is a draft again.` : msg`Undone.`,
      };
  }
}

/**
 * What to say when the server refused something: its own sentence for a refusal it
 * explains (a conversation still running, no provider, too many messages this hour, a
 * role), or null for a fault that is not the person's to read.
 */
export function refusalWords(error: unknown): string | null {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
    ? error.message
    : null;
}

/** Whether a read failed because the conversation is gone: deleted, or expired. */
export function isGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** When a conversation was last used: the time today, or the day before that. */
export function lastActivityWords(at: string, now: Date, locale: string): string {
  const then = new Date(at);
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    locale,
    sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' },
  ).format(then);
}
