// What the API answers about the assistant in one conversation: drafts, proposals and
// autonomy, for the Inbox's unit tests and its end-to-end tests.
// inbox-assistant-rules.test.ts checks every one of them against the contract, so a fixture
// can't drift from what the server really sends.
import type {
  AutonomySetting,
  AutonomySettings,
  ConversationAssistant,
  DraftRequest,
  Proposal,
  ProposalChange,
} from '@repo/contracts';
import { bookings, conversationId, mayaEmail, messageId } from './inbox-fixtures';

// Ids the server made: the contract checks each wraps a UUIDv7.
const suffix = (last: string): string => `01k8e2wzr0e00800000000000${last}`;
export const proposalId = (last: string): string => `prop_${suffix(last)}`;
export const draftRequestId = (last: string): string => `drq_${suffix(last)}`;

export const draftedText =
  'Hi Maya, June 13 is open for both DJ and video.\nCould you do a 20-minute call this week?';

export const you = { kind: 'user', name: 'Dana Brooks', you: true } as const;
export const sam = { kind: 'user', name: 'Sam Lee', you: false } as const;
export const theAssistant = { kind: 'ai_agent', name: null, you: false } as const;

/** What the drafted reply would send: by email, from Bookings, to Maya's main address. */
export const draftedChange = {
  kind: 'reply',
  channel: 'email',
  accountId: bookings.id,
  to: mayaEmail.id,
  subject: 'Re: June 13',
  text: draftedText,
} as const satisfies ProposalChange;

/** A reply the assistant drafted, waiting for a person. */
export function replyProposalOf(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: proposalId('1'),
    agent: 'inbox',
    kind: 'reply',
    status: 'pending',
    autonomy: 'ask',
    summary: 'Reply to Maya Thompson by email',
    conversationId: conversationId('1'),
    change: draftedChange,
    basis: { messages: 4, facts: 2, summary: true, knowledge: ['Business profile'] },
    stale: false,
    edited: false,
    canDecide: true,
    result: null,
    undo: null,
    createdAt: '2026-10-09T08:00:00.000Z',
    expiresAt: '2026-10-16T08:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    undoneAt: null,
    undoneBy: null,
    ...overrides,
  };
}

/** The same reply once a person approved it: handed to sending, which can't be taken back. */
export function sentReplyOf(overrides: Partial<Proposal> = {}): Proposal {
  return replyProposalOf({
    status: 'applied',
    result: { messageId: messageId('7') },
    undo: {
      available: false,
      reason: 'message_sent',
      message: 'A message that was sent can’t be unsent.',
    },
    decidedAt: '2026-10-09T08:10:00.000Z',
    decidedBy: you,
    ...overrides,
  });
}

/** A suggestion to close the conversation, waiting for a person. */
export function statusProposalOf(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: proposalId('2'),
    agent: 'inbox',
    kind: 'conversation_status',
    status: 'pending',
    autonomy: 'ask',
    summary: 'Close the conversation with Maya Thompson',
    conversationId: conversationId('1'),
    change: { kind: 'conversation_status', from: 'open', to: 'closed', until: null },
    basis: null,
    stale: false,
    edited: false,
    canDecide: true,
    result: null,
    undo: null,
    createdAt: '2026-10-09T08:00:00.000Z',
    expiresAt: '2026-10-16T08:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    undoneAt: null,
    undoneBy: null,
    ...overrides,
  };
}

/** That suggestion once applied: the conversation is closed, and it can be undone. */
export function appliedStatusOf(overrides: Partial<Proposal> = {}): Proposal {
  return statusProposalOf({
    status: 'applied',
    result: {},
    undo: { available: true, reason: null, message: null },
    decidedAt: '2026-10-09T08:10:00.000Z',
    decidedBy: you,
    ...overrides,
  });
}

/** A request for a draft: being written, unless a test says how it ended. */
export function draftOf(overrides: Partial<DraftRequest> = {}): DraftRequest {
  return {
    id: draftRequestId('1'),
    status: 'pending',
    outcome: null,
    reason: null,
    message: null,
    origin: 'person',
    createdAt: '2026-10-09T08:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

/** A request that ended without a draft, with the API's own words for why. */
export function endedDraftOf(
  outcome: NonNullable<DraftRequest['outcome']>,
  reason: string | null = null,
): DraftRequest {
  return draftOf({
    status: 'finished',
    outcome,
    reason,
    message: 'No draft was written.',
    finishedAt: '2026-10-09T08:01:00.000Z',
  });
}

/** How much the inbox assistant does on its own: "Ask first", as every business starts. */
export function autonomyOf(overrides: Partial<AutonomySetting> = {}): AutonomySetting {
  return {
    agent: 'inbox',
    action: 'send_message',
    level: 'ask',
    source: 'default',
    businessLevel: 'ask',
    ...overrides,
  };
}

export function autonomySettingsOf(
  overrides: Partial<AutonomySetting> = {},
  canChange = true,
): AutonomySettings {
  return { canChange, items: [autonomyOf(overrides)] };
}

/**
 * A business with AI ready, someone who may reply and manage AI, nothing drafted and
 * nothing waiting, unless a test says otherwise.
 */
export function assistantOf(
  overrides: Partial<Omit<ConversationAssistant, 'autonomy'>> & {
    readonly autonomy?: Partial<ConversationAssistant['autonomy']>;
  } = {},
): ConversationAssistant {
  return {
    ai: 'ready',
    canDraft: true,
    draft: null,
    proposals: [],
    ...overrides,
    autonomy: { ...autonomyOf(), canChange: true, ...overrides.autonomy },
  };
}

/** A business with no assistant to speak of: the Inbox then shows nothing of one. */
export function noAssistant(): ConversationAssistant {
  return assistantOf({ ai: 'not_connected', canDraft: false, autonomy: { canChange: false } });
}
