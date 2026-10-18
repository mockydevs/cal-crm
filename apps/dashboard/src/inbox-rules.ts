// The Inbox's rules, as pure functions with tests beside them: the order of a thread, a
// message's delivery state in plain words, what a reply may be sent from and to, the
// idempotency key that keeps a retry from sending twice, what may be marked read, how an
// answer from the API is put into what the page already shows, and which text is a link.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { WEBCHAT_LIMITS } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import type {
  addConversationNote,
  ComposerUnavailableCode,
  Conversation,
  ConversationChannel,
  ConversationComposer,
  ConversationList,
  ConversationThread,
  EndpointInput,
  InboxSummary,
  MessageHoldCode,
  MessageProblemCode,
  MessageStatus,
  ReplyChannel,
  ReplyRefusalCode,
  sendConversationReply,
  ThreadItem,
  ThreadMessage,
} from '@repo/contracts';

// The thread ---------------------------------------------------------------------------

/** What useInfiniteQuery keeps: the pages read so far, the first read first. */
export interface Pages<Page> {
  readonly pages: readonly Page[];
  readonly pageParams: readonly unknown[];
}

/**
 * A thread's messages and notes, oldest first, as a conversation reads. The API answers
 * newest first, a page at a time, each page older than the one before. An item that two
 * pages both hold (one arrived between the reads) is shown once, as the newer read has it.
 */
export function threadItemsOf(pages: readonly ConversationThread[]): ThreadItem[] {
  const seen = new Set<string>();
  const newestFirst: ThreadItem[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      newestFirst.push(item);
    }
  }
  return newestFirst.reverse();
}

/** The calendar day a moment falls on where the reader is, as 2026-10-09. */
export function dayOf(at: string, timeZone?: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(at));
}

export interface ThreadDay {
  readonly day: string;
  readonly items: readonly ThreadItem[];
}

/**
 * A thread with each of the contact's replies put straight under the message it answers,
 * so a message and its answer read as a pair even when other messages went out in between.
 * A reply whose message isn't among those loaded, and everything else, keeps its place.
 * Each item comes with the item that decides its day: a moved reply stays under its
 * message's day heading.
 */
export function repliesUnderMessages(
  items: readonly ThreadItem[],
): { readonly item: ThreadItem; readonly anchor: ThreadItem }[] {
  const shown = new Set(items.map((item) => item.id));
  const answers = new Map<string, ThreadItem[]>();
  for (const item of items) {
    if (item.kind !== 'message' || item.direction !== 'inbound') continue;
    if (item.replyTo === null || !shown.has(item.replyTo)) continue;
    answers.set(item.replyTo, [...(answers.get(item.replyTo) ?? []), item]);
  }
  const moved = new Set([...answers.values()].flat().map((item) => item.id));
  const ordered: { item: ThreadItem; anchor: ThreadItem }[] = [];
  const place = (item: ThreadItem, anchor: ThreadItem): void => {
    ordered.push({ item, anchor });
    for (const answer of answers.get(item.id) ?? []) place(answer, anchor);
  };
  for (const item of items) if (!moved.has(item.id)) place(item, item);
  return ordered;
}

/**
 * A thread under a heading for each day, in the order it was given, but with each reply
 * of the contact's under the message it answers (repliesUnderMessages).
 */
export function threadDaysOf(items: readonly ThreadItem[], timeZone?: string): ThreadDay[] {
  const days: { day: string; items: ThreadItem[] }[] = [];
  for (const { item, anchor } of repliesUnderMessages(items)) {
    const day = dayOf(anchor.createdAt, timeZone);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, items: [item] });
  }
  return days;
}

/** The newest message the contact sent, if any: what a "new message" announcement names. */
export function newestInboundOf(items: readonly ThreadItem[]): ThreadMessage | undefined {
  return items.findLast(
    (item): item is ThreadMessage => item.kind === 'message' && item.direction === 'inbound',
  );
}

// Delivery, in plain words -------------------------------------------------------------

export const deliveryStates = [
  'received',
  'queued',
  'held',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'bounced',
  'unknown',
] as const;
export type DeliveryState = (typeof deliveryStates)[number];

/** Every status the contract defines has a state here, or this file doesn't compile. */
export const stateOfStatus = {
  received: 'received',
  queued: 'queued',
  sending: 'sending',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  bounced: 'bounced',
  unknown: 'unknown',
} as const satisfies Record<MessageStatus, DeliveryState>;

export const deliveryWords: Readonly<Record<DeliveryState, MessageDescriptor>> = {
  received: msg`Received`,
  queued: msg`Queued to send`,
  held: msg`Waiting to send`,
  sending: msg`Sending`,
  sent: msg`Sent`,
  delivered: msg`Delivered`,
  read: msg`Read`,
  failed: msg`Not sent`,
  bounced: msg`Bounced: it didn't reach the contact`,
  unknown: msg`Delivery not confirmed`,
};

/** Whether a state is a routine one, one that waits, or one that needs someone's eye. */
export const deliveryTones = {
  received: 'routine',
  queued: 'routine',
  held: 'waiting',
  sending: 'routine',
  sent: 'routine',
  delivered: 'routine',
  read: 'routine',
  failed: 'problem',
  bounced: 'problem',
  unknown: 'problem',
} as const satisfies Record<DeliveryState, 'routine' | 'waiting' | 'problem'>;

/**
 * Why a message failed, bounced or has unknown delivery, a line for every code the
 * contract defines (or this file doesn't compile). The words say what happened and, where
 * there is one, what to do next.
 */
export const problemWords: Readonly<Record<MessageProblemCode, MessageDescriptor>> = {
  contact_inactive: msg`This contact is in the trash.`,
  sender_inactive: msg`The sending account or the business isn't active.`,
  do_not_contact: msg`This contact is marked do not contact.`,
  suppressed: msg`This address is blocked: it bounced, unsubscribed, complained or was blocked by the team.`,
  consent_withdrawn: msg`This contact withdrew their agreement to receive these messages.`,
  consent_required: msg`This contact hasn't agreed to receive messages on this channel.`,
  timing_unknown: msg`Quiet hours are on and no time zone can be used for this contact. Set one, then send again.`,
  recipient_changed: msg`The contact's address changed after this was written.`,
  delivery_rejected: msg`The sending account's server refused the message.`,
  delivery_unknown: msg`We couldn't confirm whether this was delivered. It wasn't sent again, to avoid a duplicate. Check with the contact before sending it again.`,
  unsupported_channel: msg`This channel can't send messages yet.`,
  unsubscribe_unavailable: msg`Marketing mail needs a secure public address for unsubscribing.`,
  postal_address_missing: msg`Marketing email needs your postal address. Add it to the Business profile.`,
  mailbox_unavailable: msg`The mailbox it was to be sent from is no longer connected.`,
  mailbox_use_disabled: msg`The mailbox isn't set to be used for this kind of message.`,
  hard_bounce: msg`The address doesn't exist or refuses mail. It is now blocked.`,
  soft_bounce: msg`The recipient's server couldn't accept it for now.`,
  status_callback_unavailable: msg`Text messages need a public address the provider can report delivery to.`,
  sms_body_too_long: msg`The text message is too long.`,
  sms_number_unavailable: msg`The number it was to be sent from can't send text messages.`,
  sms_connection_unavailable: msg`The text message provider isn't connected.`,
  provider_failed: msg`The text message provider couldn't deliver it.`,
  failed: msg`This message wasn't sent.`,
  bounced: msg`This message bounced.`,
};

/** Why a queued message is waiting, a line for every code the contract defines. */
export const holdWords: Readonly<Record<MessageHoldCode, MessageDescriptor>> = {
  quiet_hours: msg`It's quiet hours where this contact is. It will be sent when they end.`,
  frequency_cap: msg`This contact has had the most messages allowed in a day. It will be sent when there is room.`,
  mailbox_daily_limit: msg`The mailbox reached its daily limit. It will be sent when there is room.`,
  mailbox_warmup_limit: msg`The mailbox reached today's warm-up limit. It will be sent when there is room.`,
  mailbox_pacing: msg`The mailbox sends a few messages a minute. It will be sent shortly.`,
  provider_temporary: msg`The mailbox's server asked us to slow down. It will be tried again shortly.`,
  waiting: msg`It's waiting its turn to be sent.`,
};

export interface Delivery {
  readonly state: DeliveryState;
  /** Why it waits, or why it wasn't sent, in our words for the server's code. */
  readonly reason: MessageDescriptor | null;
  /** When a waiting message is tried again, if the server knows. */
  readonly until: string | null;
}

/** A message's delivery state. A queued message the pipeline holds is "waiting to send". */
export function deliveryOf(message: Pick<ThreadMessage, 'status' | 'held' | 'problem'>): Delivery {
  if (message.status === 'queued' && message.held !== null) {
    return { state: 'held', reason: holdWords[message.held.code], until: message.held.until };
  }
  const state: DeliveryState = stateOfStatus[message.status];
  return {
    state,
    reason:
      deliveryTones[state] === 'problem' && message.problem !== null
        ? problemWords[message.problem.code]
        : null,
    until: null,
  };
}

export const channelWords: Readonly<Record<ConversationChannel, MessageDescriptor>> = {
  email: msg`Email`,
  sms: msg`Text message`,
  webchat: msg`Web chat`,
};

// The composer ---------------------------------------------------------------------------

type ComposerChannel = ConversationComposer['channels'][number];
export type ComposerAccount = ComposerChannel['accounts'][number];
export type ComposerRecipient = ComposerChannel['recipients'][number];

/**
 * Why a channel can't be sent on: the server's code, or `not_offered` for a channel the
 * server didn't list at all.
 */
export type ChannelGap = ComposerUnavailableCode | 'not_offered';

export interface ChannelChoice {
  readonly channel: ReplyChannel;
  /** Offered only when the server says it can send and there is an account and an address. */
  readonly usable: boolean;
  /** Null when usable. */
  readonly gap: ChannelGap | null;
  readonly accounts: readonly ComposerAccount[];
  readonly recipients: readonly ComposerRecipient[];
}

// Every channel the composer can send on, in the order it offers them.
const replyChannelOrder = {
  email: 0,
  sms: 1,
  webchat: 2,
} as const satisfies Record<ReplyChannel, number>;

function isReplyChannel(value: string): value is ReplyChannel {
  return Object.hasOwn(replyChannelOrder, value);
}

const replyChannelList: readonly ReplyChannel[] = Object.keys(replyChannelOrder)
  .filter(isReplyChannel)
  .sort((left, right) => replyChannelOrder[left] - replyChannelOrder[right]);

/**
 * Each channel a reply could go on, usable or not. A channel the server left out, or says
 * it can't send on, or that has no account or no address of the contact's (whatever the
 * server says), is listed as unavailable with the reason: never as if it works.
 *
 * Web chat differs in two ways. It has no address: a reply goes to the visitor in the
 * chat. And it belongs only to a conversation someone chatted in: anywhere else it is not
 * a channel that happens to be unavailable, it is no channel at all, and is left out.
 */
export function channelChoicesOf(composer: ConversationComposer | undefined): ChannelChoice[] {
  return replyChannelList.flatMap((channel): ChannelChoice[] => {
    const offered = composer?.channels.find((each) => each.channel === channel);
    if (offered === undefined) {
      return channel === 'webchat'
        ? []
        : [{ channel, usable: false, gap: 'not_offered', accounts: [], recipients: [] }];
    }
    const gap: ChannelGap | null = !offered.available
      ? (offered.unavailable?.code ?? 'channel_unavailable')
      : offered.accounts.length === 0
        ? 'no_account'
        : offered.recipients.length === 0 && channel !== 'webchat'
          ? 'no_recipient'
          : null;
    if (channel === 'webchat' && gap === 'no_recipient') return [];
    return [
      {
        channel,
        usable: gap === null,
        gap,
        accounts: gap === null ? offered.accounts : [],
        recipients: gap === null ? offered.recipients : [],
      },
    ];
  });
}

// The same on every channel: do not contact, or do not disturb for the channel.
const doNotDisturbGap = msg`Do not disturb is on for this contact, so nothing can be sent on this channel.`;

/** Why each channel can't be used, a line for every code the contract defines. */
export const channelGapWords: Readonly<
  Record<ReplyChannel, Readonly<Record<ChannelGap, MessageDescriptor>>>
> = {
  email: {
    not_offered: msg`Email isn't available for this conversation.`,
    channel_unavailable: msg`Email can't be sent yet: no mailbox is connected for conversations.`,
    contact_inactive: msg`This contact is in the trash, so nothing can be sent.`,
    no_account: msg`Email isn't connected yet. Connect a mailbox in Settings, under Email Services.`,
    no_recipient: msg`This contact has no email address.`,
    visitor_left: msg`Email can't be sent to this contact right now.`,
    do_not_contact: doNotDisturbGap,
  },
  sms: {
    not_offered: msg`Text messages aren't connected yet.`,
    channel_unavailable: msg`Text messages can't be sent: this install isn't set up to deliver them.`,
    contact_inactive: msg`This contact is in the trash, so nothing can be sent.`,
    no_account: msg`Text messages aren't connected yet.`,
    no_recipient: msg`This contact has no phone number.`,
    visitor_left: msg`Text messages can't be sent to this contact right now.`,
    do_not_contact: doNotDisturbGap,
  },
  webchat: {
    not_offered: msg`Web chat isn't available for this conversation.`,
    channel_unavailable: msg`Web chat can't be answered right now.`,
    contact_inactive: msg`This contact is in the trash, so nothing can be sent.`,
    no_account: msg`The chat widget is turned off. Turn it on in Sites, under Chat Widget.`,
    no_recipient: msg`This contact didn't write through web chat.`,
    visitor_left: msg`The visitor has left the chat, so a reply would reach nobody.`,
    do_not_contact: doNotDisturbGap,
  },
};

/**
 * What the server says when it refuses a reply the page let through (the page's options
 * were out of date), a line for every code the contract defines.
 */
export const serverRefusalWords: Readonly<Record<ReplyRefusalCode, MessageDescriptor>> = {
  channel_unavailable: msg`This channel can't send right now. Choose another.`,
  account_channel_mismatch: msg`Choose an account that sends on this channel.`,
  account_unavailable: msg`This account can't send right now. Check its connection in Settings.`,
  account_not_for_conversations: msg`This mailbox isn't used for conversations. Choose another, or change it in Settings.`,
  recipient_not_in_conversation: msg`Choose one of this contact's own addresses or numbers.`,
  recipient_channel_mismatch: msg`That address doesn't belong to this channel. Choose another.`,
  text_too_long: msg`A text message can hold 1,600 characters at most. Shorten it, or send an email.`,
  contact_inactive: msg`This contact is in the trash, so nothing can be sent.`,
  subject_not_supported: msg`Only email has a subject.`,
  recipient_required: msg`Choose one of this contact's own addresses or numbers.`,
  recipient_not_supported: msg`A chat reply goes to the visitor in the chat. It takes no address.`,
  visitor_left: msg`The visitor has left the chat, so your reply wasn't sent. Reply another way if you can.`,
  do_not_contact: msg`Do not disturb is on for this contact, so your reply wasn't sent.`,
};

function isServerRefusal(code: string): code is ReplyRefusalCode {
  return Object.hasOwn(serverRefusalWords, code);
}

/** Our words for a code the server refused a reply with, or undefined for any other code. */
export function serverRefusalOf(code: string | undefined): MessageDescriptor | undefined {
  return code !== undefined && isServerRefusal(code) ? serverRefusalWords[code] : undefined;
}

/**
 * A contact's name as shown, or undefined for a contact with no name and no address:
 * the page then says "Unknown contact".
 */
export function knownNameOf(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface ReplySelection {
  readonly channel: ReplyChannel;
  readonly accountId: string;
  /** One of the contact's addresses; null for web chat, which goes to the visitor in the chat. */
  readonly to: string | null;
}

/**
 * What a reply would be sent on, from and to. What the person chose is kept only where it
 * still fits: the channel must be usable, the account one of that channel's, and the
 * address one of the contact's on that channel. Anything else falls back to the channel's
 * first account and the contact's primary address. Undefined when no channel is usable.
 *
 * Until the person chooses, the reply starts on the channel the server suggests: the one
 * the contact last wrote on, when a reply can go that way. The server decides that, so
 * every client starts in the same place; the first usable channel is only what is left
 * when it suggests none, or one that can't be used here.
 */
export function selectionFor(
  choices: readonly ChannelChoice[],
  wanted: {
    readonly channel?: ReplyChannel | undefined;
    readonly accountId?: string | undefined;
    readonly to?: string | undefined;
  } = {},
  suggested: ReplyChannel | null = null,
): ReplySelection | undefined {
  const usable = choices.filter((choice) => choice.usable);
  const choice =
    usable.find((each) => each.channel === wanted.channel) ??
    usable.find((each) => each.channel === suggested) ??
    usable[0];
  const firstAccount = choice?.accounts[0];
  const firstRecipient =
    choice?.recipients.find((recipient) => recipient.primary) ?? choice?.recipients[0];
  if (choice === undefined || firstAccount === undefined) return undefined;
  const accountId = choice.accounts.some((account) => account.id === wanted.accountId)
    ? (wanted.accountId ?? firstAccount.id)
    : firstAccount.id;
  if (choice.channel === 'webchat') return { channel: choice.channel, accountId, to: null };
  if (firstRecipient === undefined) return undefined;
  return {
    channel: choice.channel,
    accountId,
    to: choice.recipients.some((recipient) => recipient.id === wanted.to)
      ? (wanted.to ?? firstRecipient.id)
      : firstRecipient.id,
  };
}

/** What may be written under a thread. Nothing at all for someone who may only read. */
export type ComposerMode = 'reply' | 'note';

export function composerModesOf(access: {
  readonly canReply: boolean;
  readonly canManage: boolean;
}): ComposerMode[] {
  return [
    ...(access.canReply ? ['reply' as const] : []),
    ...(access.canManage ? ['note' as const] : []),
  ];
}

/** A reply to the contact, as the reply form holds it. */
export interface ReplyDraft {
  readonly kind: 'reply';
  readonly channel: ReplyChannel;
  readonly accountId: string;
  readonly to: string | null;
  readonly subject: string;
  readonly text: string;
}

/** An internal note, as the note form holds it. It has nowhere to be sent. */
export interface NoteDraft {
  readonly kind: 'note';
  readonly text: string;
}

export type ReplyBody = EndpointInput<typeof sendConversationReply>['body'];
export type ReplyContent = Omit<ReplyBody, 'idempotencyKey'>;

export type ReplyRefusal =
  | 'not_a_reply'
  | 'not_allowed'
  | 'channel_unavailable'
  | 'account_mismatch'
  | 'recipient_mismatch'
  | 'empty'
  | 'chat_too_long'
  | 'subject_lines';

export const replyRefusalWords: Readonly<Record<ReplyRefusal, MessageDescriptor>> = {
  not_a_reply: msg`An internal note can't be sent to the contact.`,
  not_allowed: msg`You can't send replies in this business.`,
  channel_unavailable: msg`This channel can't be used right now. Choose another.`,
  account_mismatch: msg`Choose an account that sends on this channel.`,
  recipient_mismatch: msg`Choose one of the contact's own addresses for this channel.`,
  empty: msg`Write a message first.`,
  chat_too_long: msg`A chat message can hold 2,000 characters at most. Shorten it, or send it in parts.`,
  subject_lines: msg`Keep the subject on one line.`,
};

/**
 * The only way a reply's content is made for sendConversationReply. It refuses anything
 * that isn't a reply draft (a note never gets this far), someone who may not reply, a
 * channel that can't send, an account of another channel, and an address that isn't the
 * contact's on that channel. The server checks all of it again.
 */
export function replyContentOf(
  composer: ConversationComposer | undefined,
  draft: ReplyDraft | NoteDraft,
):
  | { readonly ok: true; readonly content: ReplyContent }
  | { readonly ok: false; readonly why: ReplyRefusal } {
  if (draft.kind !== 'reply') return { ok: false, why: 'not_a_reply' };
  if (composer?.canReply !== true) return { ok: false, why: 'not_allowed' };
  const choice = channelChoicesOf(composer).find((each) => each.channel === draft.channel);
  if (choice?.usable !== true) return { ok: false, why: 'channel_unavailable' };
  if (!choice.accounts.some((account) => account.id === draft.accountId)) {
    return { ok: false, why: 'account_mismatch' };
  }
  // Web chat has no address to choose; every other channel needs one of the contact's own.
  const addressed =
    draft.channel === 'webchat'
      ? draft.to === null
      : choice.recipients.some((recipient) => recipient.id === draft.to);
  if (!addressed) return { ok: false, why: 'recipient_mismatch' };
  const text = draft.text.trim();
  if (text === '') return { ok: false, why: 'empty' };
  if (draft.channel === 'webchat' && text.length > WEBCHAT_LIMITS.messageLength)
    return { ok: false, why: 'chat_too_long' };
  const subject = draft.subject.trim();
  if (/[\r\n]/.test(subject)) return { ok: false, why: 'subject_lines' };
  return {
    ok: true,
    content: {
      channel: draft.channel,
      accountId: draft.accountId,
      to: draft.to,
      // Only email has a subject.
      subject: draft.channel === 'email' && subject !== '' ? subject : null,
      text,
    },
  };
}

// When the API says no to a proposal ---------------------------------------------------

/**
 * Why applying, dismissing or undoing one of the assistant's proposals did not go through,
 * sorted by what the person can do about it. The composer needs it too: a draft changed in
 * the reply box is sent by applying its proposal.
 */
export type ActionFailure =
  /** It changed first: stale, expired, dismissed, undone. The server says which, plainly. */
  | { readonly kind: 'conflict'; readonly detail: string }
  /** The proposal's command refused: our words for a code we know, or else the server's. */
  | {
      readonly kind: 'refused';
      readonly words: MessageDescriptor | undefined;
      readonly message: string;
    }
  /** The person's role doesn't allow it. */
  | { readonly kind: 'forbidden' }
  /** The server never answered. */
  | { readonly kind: 'network' }
  | { readonly kind: 'other'; readonly message: string };

export function failureOf(error: unknown): ActionFailure {
  if (!(error instanceof ApiError)) return { kind: 'network' };
  if (error.status === 409) return { kind: 'conflict', detail: error.message };
  if (error.status === 403) return { kind: 'forbidden' };
  if (error.status === 422) {
    const issue = error.problem.errors?.[0];
    return {
      kind: 'refused',
      words: serverRefusalOf(issue?.code),
      message: issue?.message ?? error.message,
    };
  }
  return { kind: 'other', message: error.message };
}

// Sending once ---------------------------------------------------------------------------

/** A key the contract accepts: 32 letters and digits, new for each message written. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** What makes two sends the same message: everything about it but the key. */
export function fingerprintOf(content: ReplyContent): string {
  return JSON.stringify([
    content.channel,
    content.accountId,
    content.to,
    content.subject ?? null,
    content.text,
  ]);
}

export interface PendingSend {
  readonly key: string;
  readonly fingerprint: string;
}

/**
 * The key a send carries. The same message sent again (a retry after an error, or a
 * second click) keeps its key, so the server answers with the message it already has. A
 * message that was changed is a new message, with a new key.
 */
export function sendKeyFor(
  pending: PendingSend | undefined,
  fingerprint: string,
  make: () => string = newIdempotencyKey,
): PendingSend {
  return pending?.fingerprint === fingerprint ? pending : { key: make(), fingerprint };
}

export interface Outbox<Content, Sent> {
  /** Sends once. While a send is on its way in a conversation, a second call joins it. */
  readonly submit: (conversationId: string, content: Content) => Promise<Sent>;
  /** The key the next send of this content would carry, if an earlier try is remembered. */
  readonly pendingFor: (conversationId: string) => PendingSend | undefined;
}

/**
 * Sends what a person wrote so that nothing goes twice. One request at a time for each
 * conversation: a double click gets the first request's answer. A send that failed keeps
 * its key for the retry of the same words; a send the server answered is done, and the
 * next thing written gets a new key.
 */
export function createOutbox<Content, Sent>(
  send: (conversationId: string, content: Content, idempotencyKey: string) => Promise<Sent>,
  fingerprint: (content: Content) => string,
  make: () => string = newIdempotencyKey,
): Outbox<Content, Sent> {
  const pending = new Map<string, PendingSend>();
  const inFlight = new Map<string, Promise<Sent>>();
  return {
    submit(conversationId, content) {
      const running = inFlight.get(conversationId);
      if (running !== undefined) return running;
      const next = sendKeyFor(pending.get(conversationId), fingerprint(content), make);
      pending.set(conversationId, next);
      const request = send(conversationId, content, next.key)
        .then((sent) => {
          if (pending.get(conversationId) === next) pending.delete(conversationId);
          return sent;
        })
        .finally(() => {
          inFlight.delete(conversationId);
        });
      inFlight.set(conversationId, request);
      return request;
    },
    pendingFor: (conversationId) => pending.get(conversationId),
  };
}

export type ReplyOutbox<Sent> = Outbox<ReplyContent, Sent>;

/** Replies, sent once each: the key is for the channel, account, address, subject and text. */
export function createReplyOutbox<Sent>(
  send: (conversationId: string, body: ReplyBody) => Promise<Sent>,
  make: () => string = newIdempotencyKey,
): ReplyOutbox<Sent> {
  return createOutbox(
    (conversationId, content, idempotencyKey) =>
      send(conversationId, { ...content, idempotencyKey }),
    fingerprintOf,
    make,
  );
}

export type NoteBody = EndpointInput<typeof addConversationNote>['body'];

/** Internal notes, stored once each: the key is for the note's text. */
export function createNoteOutbox<Sent>(
  send: (conversationId: string, body: NoteBody) => Promise<Sent>,
  make: () => string = newIdempotencyKey,
): Outbox<string, Sent> {
  return createOutbox(
    (conversationId, text, idempotencyKey) => send(conversationId, { text, idempotencyKey }),
    (text) => text,
    make,
  );
}

// Reading ----------------------------------------------------------------------------------

/**
 * The message to mark the conversation read up to, or undefined to leave it as it is. A
 * conversation is read only by someone who may manage it or reply, and is looking at it: open
 * here, and this window is the one in front. A message that arrives while they look
 * elsewhere stays unread. The same message is never marked twice.
 */
export function readThroughOf(input: {
  /** Oldest first, as the thread shows them. */
  readonly items: readonly ThreadItem[];
  readonly unreadCount: number;
  /** Whether the person may manage conversations or reply: either one may mark read. */
  readonly mayMarkRead: boolean;
  readonly attending: boolean;
  readonly lastMarked: string | undefined;
}): string | undefined {
  const newest = input.items.at(-1);
  if (newest === undefined || !input.mayMarkRead || !input.attending) return undefined;
  if (input.unreadCount === 0 || newest.id === input.lastMarked) return undefined;
  return newest.id;
}

// Putting an answer into what the page shows ---------------------------------------------

/**
 * The list with a conversation as the API last answered it. A conversation the list
 * doesn't hold changes nothing: whether it belongs under these filters is the server's to
 * say, on the next read. Applying the same answer twice changes nothing more.
 */
export function withConversation(
  data: Pages<ConversationList> | undefined,
  next: Conversation,
): Pages<ConversationList> | undefined {
  if (data === undefined) return undefined;
  if (!data.pages.some((page) => page.items.some((item) => item.id === next.id))) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === next.id ? next : item)),
    })),
  };
}

/**
 * The thread with a message or note the API just answered with: in its place if the thread
 * already holds it, or else as the newest. A thread that was never read stays unread.
 */
export function withThreadItem(
  data: Pages<ConversationThread> | undefined,
  item: ThreadItem,
): Pages<ConversationThread> | undefined {
  const [first, ...older] = data?.pages ?? [];
  if (data === undefined || first === undefined) return data;
  if (data.pages.some((page) => page.items.some((each) => each.id === item.id))) {
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((each) => (each.id === item.id ? item : each)),
      })),
    };
  }
  return { ...data, pages: [{ ...first, items: [item, ...first.items] }, ...older] };
}

function counted(conversation: Conversation | undefined): InboxSummary {
  const counts = conversation?.status === 'open' && !conversation.contact.trashed;
  return {
    unreadConversations: counts && conversation.unreadCount > 0 ? 1 : 0,
    unreadMessages: counts ? conversation.unreadCount : 0,
    needsReply: counts && conversation.needsReply ? 1 : 0,
  };
}

/**
 * The inbox's counts after one conversation changed from `before` to `after`, until the
 * server's own counts arrive. They count open conversations of contacts not in the trash.
 * Without knowing what the conversation was before, the counts are left alone.
 */
export function summaryAfter(
  summary: InboxSummary | undefined,
  before: Conversation | undefined,
  after: Conversation,
): InboxSummary | undefined {
  if (summary === undefined || before?.id !== after.id) return summary;
  const was = counted(before);
  const is = counted(after);
  return {
    ...summary,
    unreadConversations: Math.max(
      0,
      summary.unreadConversations - was.unreadConversations + is.unreadConversations,
    ),
    unreadMessages: Math.max(0, summary.unreadMessages - was.unreadMessages + is.unreadMessages),
    needsReply: Math.max(0, summary.needsReply - was.needsReply + is.needsReply),
  };
}

// Text from outside ------------------------------------------------------------------------

export type TextPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

/**
 * The address a piece of text may link to, or undefined. Only whole http and https
 * addresses: never javascript:, data: or any other scheme, and never one that carries a
 * user name or password, which is how a link pretends to go somewhere else.
 */
export function safeHref(candidate: string): string | undefined {
  if (!/^https?:\/\//i.test(candidate)) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return undefined;
  return url.href;
}

const ADDRESS = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;

/**
 * A message's text as pieces: plain text, and the web addresses in it that are safe to
 * link. The link's words are the address itself, exactly as written, so a link can't say
 * one place and go to another. Everything else stays text.
 */
export function textPartsOf(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let from = 0;
  const push = (plain: string): void => {
    if (plain === '') return;
    const last = parts.at(-1);
    if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + plain };
    else parts.push({ kind: 'text', text: plain });
  };
  for (const match of text.matchAll(ADDRESS)) {
    const written = match[0].replace(TRAILING, '');
    const href = safeHref(written);
    if (href === undefined) continue;
    push(text.slice(from, match.index));
    parts.push({ kind: 'link', text: written, href });
    from = match.index + written.length;
  }
  push(text.slice(from));
  return parts;
}

// Times ----------------------------------------------------------------------------------

/** When something happened, as a list row says it: the time today, else the date. */
export function shortTimeOf(at: string, now: Date, locale: string, timeZone?: string): string {
  const zone = timeZone === undefined ? {} : { timeZone };
  const date = new Date(at);
  if (dayOf(at, timeZone) === dayOf(now.toISOString(), timeZone)) {
    return new Intl.DateTimeFormat(locale, { timeStyle: 'short', ...zone }).format(date);
  }
  const sameYear =
    dayOf(at, timeZone).slice(0, 4) === dayOf(now.toISOString(), timeZone).slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    ...zone,
  }).format(date);
}

export type SnoozeChoice = 'three_hours' | 'tomorrow' | 'next_week';

/** When each ready-made snooze ends, on the reader's own clock. */
export function snoozeUntilOf(choice: SnoozeChoice, now: Date): Date {
  if (choice === 'three_hours') return new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const morning = new Date(now);
  morning.setHours(9, 0, 0, 0);
  if (choice === 'tomorrow') {
    morning.setDate(morning.getDate() + 1);
    return morning;
  }
  // The next Monday: seven days from now when today is one.
  const days = (8 - morning.getDay()) % 7 || 7;
  morning.setDate(morning.getDate() + days);
  return morning;
}

/** A datetime-local input's value as a moment, if it names one that is still ahead. */
export function snoozeTimeOf(
  value: string,
  now: Date,
):
  | { readonly ok: true; readonly until: string }
  | { readonly ok: false; readonly why: 'invalid' | 'past' } {
  const date = new Date(value);
  if (value === '' || !Number.isFinite(date.getTime())) return { ok: false, why: 'invalid' };
  if (date.getTime() <= now.getTime()) return { ok: false, why: 'past' };
  return { ok: true, until: date.toISOString() };
}

export { tintOf } from './avatar-tint';
