// What the Inbox shows of the assistant, as pure functions with tests beside them: which
// card a proposal gets and what it offers, why there is no draft in plain words, what a
// draft was written from, where a drafted reply would go, what became of a suggestion, and
// which clicks still mean what their button said.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type {
  AutonomyLevel,
  Conversation,
  ConversationAssistant,
  ConversationComposer,
  DraftRequest,
  Proposal,
  ProposalChange,
  ReplyChannel,
} from '@repo/contracts';
import { channelChoicesOf, knownNameOf, selectionFor } from './inbox-rules';

// Proposals ------------------------------------------------------------------------------

export type ReplyChange = Extract<ProposalChange, { readonly kind: 'reply' }>;
export type StatusChange = Extract<ProposalChange, { readonly kind: 'conversation_status' }>;
export type ReplyProposal = Proposal & { readonly change: ReplyChange };
export type StatusProposal = Proposal & { readonly change: StatusChange };

export function isReplyProposal(proposal: Proposal): proposal is ReplyProposal {
  return proposal.change.kind === 'reply';
}

export function isStatusProposal(proposal: Proposal): proposal is StatusProposal {
  return proposal.change.kind === 'conversation_status';
}

/** Why there is no draft: the words, whether another try could help, and where the fix is. */
export interface DraftNotice {
  readonly words: MessageDescriptor;
  /** The button another try gets, or null where trying again would end the same way. */
  readonly retry: 'try_again' | 'draft_again' | null;
  /** Whether the way forward is in Settings, under AI models. */
  readonly settings: boolean;
}

const failedWords: Readonly<Record<string, DraftNotice>> = {
  timeout: {
    words: msg`The AI provider took too long to answer, so no draft was written. Try again, or write your own reply.`,
    retry: 'try_again',
    settings: false,
  },
  rate_limited: {
    words: msg`The AI provider is busy right now, so no draft was written. Try again in a minute, or write your own reply.`,
    retry: 'try_again',
    settings: false,
  },
  unavailable: {
    words: msg`The AI provider couldn’t be reached, so no draft was written. Try again in a minute, or write your own reply.`,
    retry: 'try_again',
    settings: false,
  },
  authentication: {
    words: msg`The AI provider didn’t accept this business’s key, so no draft was written. You can still write your own reply.`,
    retry: 'try_again',
    settings: true,
  },
  billing: {
    words: msg`The AI provider says its account has run out of credit or has a billing problem, so no draft was written. You can still write your own reply.`,
    retry: 'try_again',
    settings: true,
  },
  invalid_request: {
    words: msg`The AI provider didn’t accept the request, so no draft was written. Try again, or write your own reply.`,
    retry: 'try_again',
    settings: false,
  },
  invalid_response: {
    words: msg`The answer that came back couldn’t be used, so no draft was written. Try again, or write your own reply.`,
    retry: 'try_again',
    settings: false,
  },
  empty_answer: {
    words: msg`The answer that came back was empty, so no draft was written. Try again, or write your own reply.`,
    retry: 'try_again',
    settings: false,
  },
  not_found: {
    words: msg`The model chosen for replies couldn’t be found at its provider, so no draft was written. You can still write your own reply.`,
    retry: 'try_again',
    settings: true,
  },
  blocked_address: {
    words: msg`The model server’s address isn’t allowed from this server, so no draft was written. You can still write your own reply.`,
    retry: 'try_again',
    settings: true,
  },
  cut_short: {
    words: msg`The draft was cut off before it was finished, so it wasn’t kept. Try again, or write your own reply.`,
    retry: 'try_again',
    settings: false,
  },
  too_long: {
    words: msg`The draft came out too long to send, so it wasn’t kept. Try again, or write your own reply.`,
    retry: 'try_again',
    settings: false,
  },
};

const failedSomehow: DraftNotice = {
  words: msg`The draft couldn’t be written. Try again, or write your own reply.`,
  retry: 'try_again',
  settings: false,
};

/** Every reason for a failed draft that has words of its own. */
export const draftFailureReasons: readonly string[] = Object.keys(failedWords);

/**
 * Why a request for a draft left no draft, in the product's own words: what happened,
 * then what the person can do. Undefined while the draft is being written, and for the
 * outcomes that are never shown (a draft that was written, or one overtaken by events).
 */
export function draftNoticeOf(draft: DraftRequest | null): DraftNotice | undefined {
  if (draft === null || draft.status === 'pending') return undefined;
  switch (draft.outcome) {
    case 'refused':
      return {
        words: msg`Your assistant declined to draft a reply to this one. You can write your own reply.`,
        retry: 'draft_again',
        settings: false,
      };
    case 'failed': {
      const reason = draft.reason ?? '';
      const known = Object.hasOwn(failedWords, reason) ? failedWords[reason] : undefined;
      return known ?? failedSomehow;
    }
    case 'paused':
      return draft.reason === 'price_unknown'
        ? {
            words: msg`The model chosen for replies has no price, so its cost can’t be held to your spending limit and no draft was written. You can still write your own reply.`,
            retry: 'try_again',
            settings: true,
          }
        : {
            words: msg`This month’s AI spending limit has been reached, so no draft was written. You can still write your own reply.`,
            retry: 'try_again',
            settings: true,
          };
    case 'ai_off':
      return {
        words: msg`AI is turned off for this business, so no draft was written. You can still write your own reply.`,
        retry: 'try_again',
        settings: true,
      };
    case 'not_configured':
      return {
        words: msg`No AI provider that can write replies is connected, so no draft was written. You can still write your own reply.`,
        retry: 'try_again',
        settings: true,
      };
    case 'nothing_to_answer':
      return draft.reason === 'automated'
        ? {
            words: msg`The last message came from a machine, such as an out-of-office reply, so no draft was written. You can still write a reply yourself.`,
            retry: null,
            settings: false,
          }
        : {
            words: msg`There’s nothing new to answer: the last message here is your team’s. You can still write another reply yourself.`,
            retry: null,
            settings: false,
          };
    case 'cannot_reply':
      return {
        words: msg`No reply can reach this contact right now, so no draft was written. The reply options below say what is missing.`,
        retry: null,
        settings: false,
      };
    case 'expired':
      return {
        words: msg`No draft was written: nothing picked the request up. Try again, or write your own reply.`,
        retry: 'try_again',
        settings: false,
      };
    case 'drafted':
    case 'superseded':
    case null:
      return undefined;
  }
}

/** How a waiting reply is offered to this person. */
export type ReplyAction = 'send' | 'change' | 'use' | 'dismiss' | 'redraft';

/**
 * What a waiting reply offers. A stale draft is never sent: it can be set aside, or
 * written again. Someone whose role can't decide it only reads it. At "Suggest" the
 * assistant writes for the person to send themselves, so the draft goes to the reply box
 * instead of straight out. Changing it needs a reply box to change it in.
 */
export function replyActionsOf(input: {
  readonly proposal: Pick<Proposal, 'stale' | 'canDecide'>;
  readonly level: AutonomyLevel;
  /** Whether the composer has a reply form to put the draft in. */
  readonly canEdit: boolean;
  /** Whether this person may ask for another draft now. */
  readonly canDraft: boolean;
}): ReplyAction[] {
  const { proposal, level, canEdit, canDraft } = input;
  if (proposal.stale) {
    return [
      ...(canDraft ? ['redraft' as const] : []),
      ...(proposal.canDecide ? ['dismiss' as const] : []),
    ];
  }
  if (!proposal.canDecide) return [];
  if (level === 'suggest') return [...(canEdit ? ['use' as const] : []), 'dismiss'];
  return ['send', ...(canEdit ? ['change' as const] : []), 'dismiss'];
}

/** Why a waiting draft is out of date, as far as the page can tell. */
export type StaleReason = 'contact_wrote' | 'changed';

/**
 * Why a draft can no longer be sent as it is, or undefined for one that can. The API says
 * only that it is stale. When the contact's newest message is newer than the draft, they
 * wrote again; anything else (someone on the team replied, say) is "the conversation
 * changed".
 */
export function staleReasonOf(
  proposal: Pick<Proposal, 'stale' | 'createdAt'>,
  lastInboundAt: string | undefined,
): StaleReason | undefined {
  if (!proposal.stale) return undefined;
  return lastInboundAt !== undefined && Date.parse(lastInboundAt) > Date.parse(proposal.createdAt)
    ? 'contact_wrote'
    : 'changed';
}

/** What a suggested change of status would do to the conversation. */
export type StatusSuggestion = 'close' | 'reopen' | 'snooze';

export function statusSuggestionOf(change: Pick<StatusChange, 'to'>): StatusSuggestion {
  return change.to === 'closed' ? 'close' : change.to === 'snoozed' ? 'snooze' : 'reopen';
}

export const statusWords: Readonly<Record<Conversation['status'], MessageDescriptor>> = {
  open: msg`Open`,
  snoozed: msg`Snoozed`,
  closed: msg`Closed`,
};

/** What became of a suggestion, for the quiet line under the cards. */
export type RecentLine =
  /** The assistant sent a reply itself, at "Act". */
  | 'assistant_replied'
  /** A person approved the draft as it was, or after changing it. */
  | 'reply_sent'
  | 'reply_sent_changed'
  /** A person approved the draft and the pipeline refused the message. */
  | 'reply_not_sent'
  | 'status_applied'
  | 'status_undone';

/** The line an applied or undone proposal gets, or undefined for one that gets none. */
export function recentLineOf(proposal: Proposal): RecentLine | undefined {
  if (isStatusProposal(proposal)) {
    return proposal.status === 'applied'
      ? 'status_applied'
      : proposal.status === 'undone'
        ? 'status_undone'
        : undefined;
  }
  if (proposal.status !== 'applied') return undefined;
  if (proposal.decidedBy?.kind === 'ai_agent') return 'assistant_replied';
  if (proposal.undo?.reason === 'not_sent') return 'reply_not_sent';
  return proposal.edited ? 'reply_sent_changed' : 'reply_sent';
}

/** Everything the Assistant region shows for one conversation. */
export interface AssistantView {
  /** The reply waiting for a decision: at most one. */
  readonly reply: ReplyProposal | undefined;
  /** The changes of status waiting for a decision. */
  readonly changes: readonly StatusProposal[];
  /** What was applied or undone in the last day, as the API ordered it. */
  readonly recent: readonly Proposal[];
  /** A draft is being written right now. */
  readonly writing: boolean;
  /** Why the last request left no draft. */
  readonly notice: DraftNotice | undefined;
  /** Whether this person may ask for a draft now: for "Try again" and "Draft a new reply". */
  readonly canDraft: boolean;
  /** The quiet "Draft a reply" button: only when nothing else is waiting or said. */
  readonly offerDraft: boolean;
  /**
   * How the autonomy level shows: as a control for those who may change it, as a sentence
   * for those who may not, and not at all where there is no assistant to speak of.
   */
  readonly autonomy: 'control' | 'sentence' | 'hidden';
}

export function assistantViewOf(assistant: ConversationAssistant): AssistantView {
  const waiting = assistant.proposals.filter((each) => each.status === 'pending');
  const reply = waiting.find(isReplyProposal);
  const writing = assistant.draft?.status === 'pending';
  const notice = draftNoticeOf(assistant.draft);
  const ready = assistant.ai === 'ready';
  const canDraft = ready && assistant.canDraft && !writing;
  return {
    reply,
    changes: waiting.filter(isStatusProposal),
    recent: assistant.proposals.filter((each) => recentLineOf(each) !== undefined),
    writing,
    notice,
    canDraft,
    offerDraft: canDraft && reply === undefined && notice === undefined,
    autonomy: !ready ? 'hidden' : assistant.autonomy.canChange ? 'control' : 'sentence',
  };
}

/** Whether there is nothing at all to show: the region is then left out, with no nagging. */
export function isQuiet(view: AssistantView): boolean {
  return (
    view.reply === undefined &&
    view.changes.length === 0 &&
    view.recent.length === 0 &&
    !view.writing &&
    view.notice === undefined &&
    !view.offerDraft &&
    view.autonomy === 'hidden'
  );
}

/** What a button in the Assistant region asks for. */
export type AssistantAction = 'send' | 'apply' | 'dismiss' | 'undo' | 'draft';

/**
 * Whether a click still means what its button said, judged by what was last read from the
 * API rather than by what the page still shows. The page is drawn a moment after an answer
 * arrives, and the second click of a double click can land in that moment: on a draft that
 * was just sent, set aside or found out of date, or on "Draft a reply" when one is already
 * being written. Such a click does nothing.
 */
export function stillOffered(
  assistant: ConversationAssistant,
  action: AssistantAction,
  proposalId?: string,
): boolean {
  if (action === 'draft') return assistant.draft?.status !== 'pending';
  const proposal = assistant.proposals.find((each) => each.id === proposalId);
  if (proposal === undefined) return false;
  if (action === 'undo') return proposal.status === 'applied' && proposal.undo?.available === true;
  if (proposal.status !== 'pending') return false;
  return action === 'dismiss' || !proposal.stale;
}

/** How often to ask again: only while a draft is being written (a realtime hint can be missed). */
export function pollEveryOf(assistant: ConversationAssistant | undefined): number | false {
  return assistant?.draft?.status === 'pending' ? 3000 : false;
}

// What a draft was written from ----------------------------------------------------------

export type BasisPart =
  | { readonly kind: 'messages'; readonly count: number }
  | { readonly kind: 'facts'; readonly count: number }
  | { readonly kind: 'summary' };

export interface Basis {
  /** What it read of the conversation and the contact, in the order the card says it. */
  readonly parts: readonly BasisPart[];
  /** The names of the knowledge it was handed, as the business named them. */
  readonly knowledge: readonly string[];
}

/**
 * What the product counted that the assistant was given, for "Why this reply?". Nothing a
 * model said about its own reasons is ever shown. Parts that count nothing are left out.
 */
export function basisOf(basis: Proposal['basis']): Basis {
  if (basis === null) return { parts: [], knowledge: [] };
  return {
    parts: [
      ...(basis.messages > 0 ? [{ kind: 'messages' as const, count: basis.messages }] : []),
      ...(basis.facts > 0 ? [{ kind: 'facts' as const, count: basis.facts }] : []),
      ...(basis.summary ? [{ kind: 'summary' as const }] : []),
    ],
    knowledge: basis.knowledge.map((name) => name.trim()).filter((name) => name !== ''),
  };
}

// Where a drafted reply would go ---------------------------------------------------------

export interface ReplyRoute {
  readonly channel: ReplyChannel;
  /** The account it would be sent from: its name, and its address when it has one. */
  readonly from: string;
  /** The contact's address; null for web chat, which goes to the visitor in the chat. */
  readonly to: string | null;
}

/**
 * Where a drafted reply would go, in the composer's own names for the account and the
 * address. Undefined when either can't be found among what the composer offers now: the
 * card then says nothing about it rather than something that may be wrong.
 */
export function replyRouteOf(
  composer: ConversationComposer | undefined,
  change: Pick<ReplyChange, 'channel' | 'accountId' | 'to'>,
): ReplyRoute | undefined {
  const choice = channelChoicesOf(composer).find(
    (each) => each.usable && each.channel === change.channel,
  );
  const account = choice?.accounts.find((each) => each.id === change.accountId);
  if (choice === undefined || account === undefined) return undefined;
  const from = account.address === null ? account.name : `${account.name} · ${account.address}`;
  if (change.channel === 'webchat') return { channel: change.channel, from, to: null };
  const recipient = choice.recipients.find((each) => each.id === change.to);
  return recipient === undefined
    ? undefined
    : { channel: change.channel, from, to: recipient.address };
}

/** Whether the composer has a reply form: somewhere to put a draft to change it. */
export function canWriteReply(composer: ConversationComposer | undefined): boolean {
  return (
    composer?.canReply === true &&
    selectionFor(channelChoicesOf(composer), {}, composer.suggestedChannel) !== undefined
  );
}

// Names ------------------------------------------------------------------------------------

/**
 * What to call the contact in a short sentence: the first word of their name. Undefined
 * for a contact with no name, whom the page calls "this contact".
 */
export function firstNameOf(name: string): string | undefined {
  return knownNameOf(name)?.split(/\s+/)[0];
}
