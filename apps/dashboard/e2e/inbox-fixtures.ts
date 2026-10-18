// Conversations, messages and a composer as the API answers them, for the Inbox's unit
// tests and its end-to-end tests. inbox-rules.test.ts checks every one of them against the
// contract, so a fixture can't drift from what the server really sends.
import type {
  Conversation,
  ConversationComposer,
  ConversationList,
  ConversationThread,
  InboxSummary,
  ThreadItem,
  ThreadMessage,
  ThreadNote,
} from '@repo/contracts';

// Ids the server made: the contract checks each wraps a UUIDv7.
const suffix = (last: string): string => `01k8e2wzr0e00800000000000${last}`;
export const conversationId = (last: string): string => `cvn_${suffix(last)}`;
export const messageId = (last: string): string => `msg_${suffix(last)}`;
export const contactId = (last: string): string => `con_${suffix(last)}`;
export const accountId = (last: string): string => `chan_${suffix(last)}`;
export const identityId = (last: string): string => `cid_${suffix(last)}`;
export const membershipId = (last: string): string => `mem_${suffix(last)}`;

export const maya = { id: contactId('1'), name: 'Maya Thompson', trashed: false };
export const ken = { id: contactId('2'), name: 'Ken Watanabe', trashed: false };
export const sofia = { id: contactId('3'), name: 'Sofia Marin', trashed: false };

export const bookings = { id: accountId('1'), name: 'Bookings', address: 'bookings@harbor.test' };
export const dana = { id: accountId('2'), name: 'Dana Brooks', address: 'dana@harbor.test' };
export const mayaEmail = { id: identityId('1'), address: 'maya@example.test', primary: true };
export const mayaOtherEmail = { id: identityId('2'), address: 'maya@work.test', primary: false };
export const mayaPhone = { id: identityId('3'), address: '+15550104471', primary: true };
/** A chat widget, as the composer names it: a widget has no address. */
export const siteChat = { id: accountId('4'), name: 'Harbor website', address: null };

/** What the composer says of web chat in a conversation nobody chatted in. */
export const noChat: ConversationComposer['channels'][number] = {
  channel: 'webchat',
  available: false,
  unavailable: { code: 'no_recipient', message: "This contact didn't write through web chat." },
  accounts: [],
  recipients: [],
};

/** Web chat while the visitor's chat is open: one widget to answer from, and no address. */
export const openChat: ConversationComposer['channels'][number] = {
  channel: 'webchat',
  available: true,
  unavailable: null,
  accounts: [siteChat],
  recipients: [],
};

/** Web chat once the visitor has ended the chat or it ran out. */
export const leftChat: ConversationComposer['channels'][number] = {
  channel: 'webchat',
  available: false,
  unavailable: { code: 'visitor_left', message: 'The visitor has left the chat.' },
  accounts: [siteChat],
  recipients: [],
};

/** Web chat while do not disturb is on for it, or for every channel, for the contact. */
export const disturbedChat: ConversationComposer['channels'][number] = {
  channel: 'webchat',
  available: false,
  unavailable: {
    code: 'do_not_contact',
    message: 'Do not disturb is on for web chat for this contact.',
  },
  accounts: [],
  recipients: [],
};

export function conversationOf(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: conversationId('1'),
    contact: maya,
    status: 'open',
    snoozedUntil: null,
    assignee: null,
    needsReply: true,
    unreadCount: 2,
    unverified: false,
    claimedContact: null,
    lastActivityAt: '2026-10-09T07:58:00.000Z',
    lastMessage: {
      preview: 'Is June 13 still open? We’d want DJ and video.',
      direction: 'inbound',
      channel: 'email',
      status: 'received',
      at: '2026-10-09T07:58:00.000Z',
    },
    canManage: true,
    canReply: true,
    revision: 'a'.repeat(64),
    ...overrides,
  };
}

export function messageOf(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    kind: 'message',
    id: messageId('1'),
    direction: 'inbound',
    channel: 'email',
    account: bookings,
    author: { kind: 'contact', name: 'Maya Thompson', you: false },
    status: 'received',
    problem: null,
    held: null,
    subject: 'June 13',
    text: 'Is June 13 still open? We’d want DJ and video.',
    textTruncated: false,
    from: 'maya@example.test',
    to: ['bookings@harbor.test'],
    cc: [],
    automated: false,
    replyTo: null,
    attachments: [],
    createdAt: '2026-10-09T07:58:00.000Z',
    sentAt: null,
    ...overrides,
  };
}

export function noteOf(overrides: Partial<ThreadNote> = {}): ThreadNote {
  return {
    kind: 'note',
    id: messageId('9'),
    author: { kind: 'user', name: 'Dana Brooks', you: true },
    text: 'She prefers email over calls.',
    createdAt: '2026-10-09T08:05:00.000Z',
    ...overrides,
  };
}

/** A page of the list: everything allowed, unless a test says otherwise. */
export function listOf(
  items: readonly Conversation[],
  overrides: Partial<ConversationList> = {},
): ConversationList {
  return { canManage: true, canReply: true, items: [...items], nextCursor: null, ...overrides };
}

/** A page of a thread. Items are given newest first, as the API answers. */
export function threadOf(
  items: readonly ThreadItem[],
  nextCursor: string | null = null,
): ConversationThread {
  return { items: [...items], nextCursor };
}

/**
 * Email works from two accounts to two of Maya's addresses; text messages aren't set up;
 * and nobody chatted here, so there is no web chat to answer. Unless a test says where a
 * reply starts, it starts where the server would start it for a contact who wrote on no
 * channel that can send: on the first that can.
 */
export function composerOf(overrides: Partial<ConversationComposer> = {}): ConversationComposer {
  const channels: ConversationComposer['channels'] = overrides.channels ?? [
    {
      channel: 'email',
      available: true,
      unavailable: null,
      accounts: [bookings, dana],
      recipients: [mayaOtherEmail, mayaEmail],
    },
    {
      channel: 'sms',
      available: false,
      unavailable: { code: 'channel_unavailable', message: "SMS isn't connected yet." },
      accounts: [],
      recipients: [mayaPhone],
    },
    noChat,
  ];
  return {
    canReply: true,
    suggestedSubject: 'Re: June 13',
    suggestedChannel: channels.find((each) => each.available)?.channel ?? null,
    ...overrides,
    channels,
  };
}

export function summaryOf(overrides: Partial<InboxSummary> = {}): InboxSummary {
  return { unreadConversations: 1, unreadMessages: 2, needsReply: 1, ...overrides };
}
