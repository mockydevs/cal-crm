import {
  conversation,
  conversationChannels,
  conversationComposer,
  conversationList,
  conversationThread,
  inboxSummary,
  composerUnavailableCodes,
  messageHoldCodes,
  messageProblemCodes,
  messageStatuses,
  replyChannels,
  replyRefusalCodes,
  sendConversationReplyInput,
  WEBCHAT_LIMITS,
  type Conversation,
  type ThreadItem,
  type ThreadMessage,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  bookings,
  composerOf,
  contactId,
  conversationId,
  conversationOf,
  dana,
  leftChat,
  listOf,
  mayaEmail,
  mayaOtherEmail,
  mayaPhone,
  messageId,
  messageOf,
  noChat,
  noteOf,
  openChat,
  siteChat,
  summaryOf,
  threadOf,
  accountId,
  identityId,
} from '../e2e/inbox-fixtures';
import {
  channelChoicesOf,
  channelGapWords,
  channelWords,
  composerModesOf,
  createReplyOutbox,
  dayOf,
  deliveryOf,
  deliveryStates,
  deliveryTones,
  deliveryWords,
  holdWords,
  problemWords,
  fingerprintOf,
  newestInboundOf,
  newIdempotencyKey,
  readThroughOf,
  replyContentOf,
  replyRefusalWords,
  safeHref,
  selectionFor,
  sendKeyFor,
  serverRefusalOf,
  serverRefusalWords,
  shortTimeOf,
  snoozeTimeOf,
  snoozeUntilOf,
  stateOfStatus,
  summaryAfter,
  textPartsOf,
  threadDaysOf,
  threadItemsOf,
  tintOf,
  withConversation,
  withThreadItem,
  type ReplyBody,
  type ReplyContent,
  type ReplyDraft,
} from './inbox-rules';

const words = (descriptor: { message?: string }): string => descriptor.message ?? '';

describe('the fixtures', () => {
  it('are what the contract says the API answers', () => {
    expect(() => conversation.parse(conversationOf())).not.toThrow();
    expect(() => conversationList.parse(listOf([conversationOf()]))).not.toThrow();
    expect(() => conversationThread.parse(threadOf([noteOf(), messageOf()]))).not.toThrow();
    expect(() => conversationComposer.parse(composerOf())).not.toThrow();
    for (const chat of [noChat, openChat, leftChat]) {
      expect(() => conversationComposer.parse(composerOf({ channels: [chat] }))).not.toThrow();
    }
    expect(() =>
      conversation.parse(
        conversationOf({
          unverified: true,
          claimedContact: { id: contactId('2'), name: 'Maya Thompson', trashed: false },
        }),
      ),
    ).not.toThrow();
    expect(() => inboxSummary.parse(summaryOf())).not.toThrow();
  });
});

describe('threadItemsOf', () => {
  const newest = messageOf({ id: messageId('3'), createdAt: '2026-10-09T09:00:00.000Z' });
  const note = noteOf({ id: messageId('2'), createdAt: '2026-10-09T08:00:00.000Z' });
  const oldest = messageOf({ id: messageId('1'), createdAt: '2026-10-08T21:38:00.000Z' });

  it('reads oldest first across pages, with notes in their place', () => {
    const items = threadItemsOf([threadOf([newest, note], 'older'), threadOf([oldest])]);
    expect(items.map((item) => item.id)).toEqual([oldest.id, note.id, newest.id]);
    expect(items.map((item) => item.kind)).toEqual(['message', 'note', 'message']);
  });

  it('shows an item two pages both hold once, as the newer read has it', () => {
    const delivered = { ...note, text: 'Edited on the server' };
    const items = threadItemsOf([threadOf([newest, delivered]), threadOf([note, oldest])]);
    expect(items.map((item) => item.id)).toEqual([oldest.id, note.id, newest.id]);
    expect(items[1]).toBe(delivered);
  });

  it('is empty before anything is read', () => {
    expect(threadItemsOf([])).toEqual([]);
  });

  it('groups a thread under each day, where the reader is', () => {
    const days = threadDaysOf([oldest, note, newest], 'UTC');
    expect(days.map((day) => [day.day, day.items.map((item) => item.id)])).toEqual([
      ['2026-10-08', [oldest.id]],
      ['2026-10-09', [note.id, newest.id]],
    ]);
    // 21:38 UTC on the 8th is already the 9th in Nairobi.
    expect(threadDaysOf([oldest, note, newest], 'Africa/Nairobi').map((day) => day.day)).toEqual([
      '2026-10-09',
    ]);
    expect(dayOf('2026-10-08T21:38:00.000Z', 'Africa/Nairobi')).toBe('2026-10-09');
  });

  it("puts the contact's reply under the message it answers, and under that message's day", () => {
    const first = messageOf({
      id: messageId('5'),
      direction: 'outbound',
      status: 'sent',
      createdAt: '2026-10-08T10:00:00.000Z',
    });
    const second = messageOf({
      id: messageId('6'),
      direction: 'outbound',
      status: 'sent',
      createdAt: '2026-10-08T10:05:00.000Z',
    });
    // Answers the first message a day later, after the second had gone out.
    const answer = messageOf({
      id: messageId('7'),
      direction: 'inbound',
      replyTo: first.id,
      createdAt: '2026-10-09T08:00:00.000Z',
    });
    // Its message isn't among those loaded, so it stays where it came.
    const orphan = messageOf({
      id: messageId('8'),
      direction: 'inbound',
      replyTo: messageId('9'),
      createdAt: '2026-10-09T09:00:00.000Z',
    });
    // The team's own reply is never moved.
    const ours = messageOf({
      id: messageId('a'),
      direction: 'outbound',
      status: 'sent',
      replyTo: first.id,
      createdAt: '2026-10-09T10:00:00.000Z',
    });
    const days = threadDaysOf([first, second, answer, orphan, ours], 'UTC');
    expect(days.map((day) => [day.day, day.items.map((item) => item.id)])).toEqual([
      ['2026-10-08', [first.id, answer.id, second.id]],
      ['2026-10-09', [orphan.id, ours.id]],
    ]);
  });

  it("finds the contact's newest message, never a note or a reply", () => {
    const reply = messageOf({ id: messageId('4'), direction: 'outbound', status: 'sent' });
    expect(newestInboundOf([oldest, newest, note, reply])?.id).toBe(newest.id);
    expect(newestInboundOf([note, reply])).toBeUndefined();
  });
});

describe('delivery in plain words', () => {
  it.each(messageStatuses)('has words for the contract status %s', (status) => {
    const delivery = deliveryOf({ status, held: null, problem: null });
    expect(deliveryStates).toContain(delivery.state);
    expect(delivery.state).toBe(stateOfStatus[status]);
    expect(words(deliveryWords[delivery.state])).not.toBe('');
  });

  it('covers exactly the statuses the contract defines', () => {
    expect(Object.keys(stateOfStatus).toSorted()).toEqual([...messageStatuses].toSorted());
  });

  it.each(deliveryStates)('says %s differently from every other state', (state) => {
    const others = deliveryStates.filter((other) => other !== state);
    expect(others.map((other) => words(deliveryWords[other]))).not.toContain(
      words(deliveryWords[state]),
    );
    expect(deliveryTones[state]).toMatch(/^(routine|waiting|problem)$/);
  });

  it('calls a queued message the pipeline holds "waiting", with why and until when', () => {
    expect(
      deliveryOf({
        status: 'queued',
        held: {
          code: 'quiet_hours',
          message: "It's outside this contact's contact hours.",
          until: '2026-10-10T05:00:00.000Z',
        },
        problem: null,
      }),
    ).toEqual({
      state: 'held',
      reason: holdWords.quiet_hours,
      until: '2026-10-10T05:00:00.000Z',
    });
    expect(words(deliveryWords.held)).toBe('Waiting to send');
    expect(words(holdWords.quiet_hours)).toBe(
      "It's quiet hours where this contact is. It will be sent when they end.",
    );
  });

  it.each(['failed', 'bounced', 'unknown'] as const)('gives the reason a message %s', (status) => {
    const problem: NonNullable<ThreadMessage['problem']> = {
      code: 'consent_required',
      message: 'This contact has not agreed to email.',
    };
    expect(deliveryOf({ status, held: null, problem })).toEqual({
      state: status,
      reason: problemWords.consent_required,
      until: null,
    });
    expect(deliveryOf({ status, held: null, problem: null }).reason).toBeNull();
    expect(deliveryTones[status]).toBe('problem');
    expect(words(problemWords.consent_required)).toBe(
      "This contact hasn't agreed to receive messages on this channel.",
    );
  });

  it('gives no reason to a message that went out', () => {
    const problem: NonNullable<ThreadMessage['problem']> = {
      code: 'failed',
      message: 'An old reason.',
    };
    expect(deliveryOf({ status: 'sent', held: null, problem }).reason).toBeNull();
  });

  it.each(conversationChannels)('names the channel %s', (channel) => {
    expect(words(channelWords[channel])).not.toBe('');
  });

  it('has translated explanations for every contract failure and hold code', () => {
    expect(Object.keys(problemWords).toSorted()).toEqual([...messageProblemCodes].toSorted());
    expect(Object.keys(holdWords).toSorted()).toEqual([...messageHoldCodes].toSorted());
    for (const code of messageProblemCodes) expect(words(problemWords[code])).not.toBe('');
    for (const code of messageHoldCodes) expect(words(holdWords[code])).not.toBe('');
  });
});

describe('what a reply can be sent from and to', () => {
  // Email and text messages reach an address, so each is listed for every conversation,
  // usable or not. Web chat reaches a visitor's open chat: it is listed wherever someone
  // chatted, usable or not, and nowhere else (the tests under "web chat" below).
  it.each(replyChannels)('lists the reply channel %s, usable or not', (channel) => {
    const chatted = composerOf({ channels: [...composerOf().channels.slice(0, 2), leftChat] });
    expect(channelChoicesOf(chatted).map((choice) => choice.channel)).toContain(channel);
    if (channel !== 'webchat') {
      expect(channelChoicesOf(composerOf()).map((choice) => choice.channel)).toContain(channel);
      expect(channelChoicesOf(undefined).map((choice) => choice.channel)).toContain(channel);
    }
    for (const gap of ['not_offered', ...composerUnavailableCodes] as const) {
      expect(words(channelGapWords[channel][gap])).not.toBe('');
    }
  });

  it('covers exactly the reply channels the contract defines', () => {
    expect(Object.keys(channelGapWords).toSorted()).toEqual([...replyChannels].toSorted());
  });

  it('offers a channel only with an account and an address, and says why not', () => {
    const [email, sms] = channelChoicesOf(composerOf());
    expect(email).toMatchObject({ channel: 'email', usable: true, gap: null });
    expect(email?.accounts).toEqual([bookings, dana]);
    expect(sms).toMatchObject({
      channel: 'sms',
      usable: false,
      gap: 'channel_unavailable',
    });
    // Nothing of an unusable channel can be chosen.
    expect(sms?.accounts).toEqual([]);
    expect(sms?.recipients).toEqual([]);
  });

  it('never offers a channel the server says is available but that has nothing to use', () => {
    const noAccount = composerOf({
      channels: [
        {
          channel: 'email',
          available: true,
          unavailable: null,
          accounts: [],
          recipients: [mayaEmail],
        },
        {
          channel: 'sms',
          available: true,
          unavailable: null,
          accounts: [{ id: accountId('3'), name: 'Front desk', address: '+15550100000' }],
          recipients: [],
        },
      ],
    });
    expect(channelChoicesOf(noAccount)).toMatchObject([
      { channel: 'email', usable: false, gap: 'no_account' },
      { channel: 'sms', usable: false, gap: 'no_recipient' },
    ]);
    expect(selectionFor(channelChoicesOf(noAccount))).toBeUndefined();
    expect(channelChoicesOf(composerOf({ channels: [] }))).toMatchObject([
      { channel: 'email', usable: false, gap: 'not_offered' },
      { channel: 'sms', usable: false, gap: 'not_offered' },
    ]);
  });

  it("starts on the first account and the contact's primary address", () => {
    expect(selectionFor(channelChoicesOf(composerOf()))).toEqual({
      channel: 'email',
      accountId: bookings.id,
      to: mayaEmail.id,
    });
  });

  it('keeps a choice that fits', () => {
    expect(
      selectionFor(channelChoicesOf(composerOf()), {
        channel: 'email',
        accountId: dana.id,
        to: mayaOtherEmail.id,
      }),
    ).toEqual({ channel: 'email', accountId: dana.id, to: mayaOtherEmail.id });
  });

  it("drops an account or an address that isn't the chosen channel's", () => {
    const both = composerOf({
      channels: [
        {
          channel: 'email',
          available: true,
          unavailable: null,
          accounts: [bookings],
          recipients: [mayaEmail],
        },
        {
          channel: 'sms',
          available: true,
          unavailable: null,
          accounts: [{ id: accountId('3'), name: 'Front desk', address: '+15550100000' }],
          recipients: [mayaPhone],
        },
      ],
    });
    // Switching to text messages while the email account and address are still chosen.
    expect(
      selectionFor(channelChoicesOf(both), {
        channel: 'sms',
        accountId: bookings.id,
        to: mayaEmail.id,
      }),
    ).toEqual({ channel: 'sms', accountId: accountId('3'), to: mayaPhone.id });
    // An unusable channel can't be chosen at all.
    expect(selectionFor(channelChoicesOf(composerOf()), { channel: 'sms' })?.channel).toBe('email');
  });
});

describe('web chat', () => {
  const email = composerOf().channels.slice(0, 2);
  const chatting = composerOf({ channels: [...email, openChat] });
  const left = composerOf({ channels: [...email, leftChat] });
  const chatDraft: ReplyDraft = {
    kind: 'reply',
    channel: 'webchat',
    accountId: siteChat.id,
    to: null,
    subject: '',
    text: ' We are open until six. ',
  };

  it('is no channel at all in a conversation nobody chatted in', () => {
    expect(composerOf().channels).toContainEqual(noChat);
    expect(channelChoicesOf(composerOf()).map((choice) => choice.channel)).toEqual([
      'email',
      'sms',
    ]);
    // Nor when the server leaves it out, or nothing was read yet.
    expect(
      channelChoicesOf(composerOf({ channels: email })).map((choice) => choice.channel),
    ).toEqual(['email', 'sms']);
    expect(channelChoicesOf(undefined).map((choice) => choice.channel)).toEqual(['email', 'sms']);
  });

  it('is usable with a widget and no address while the chat is open', () => {
    expect(channelChoicesOf(chatting).at(-1)).toEqual({
      channel: 'webchat',
      usable: true,
      gap: null,
      accounts: [siteChat],
      recipients: [],
    });
  });

  it('says the visitor has left, and that the widget is off, and offers nothing then', () => {
    expect(channelChoicesOf(left).at(-1)).toEqual({
      channel: 'webchat',
      usable: false,
      gap: 'visitor_left',
      accounts: [],
      recipients: [],
    });
    const off = composerOf({
      channels: [
        ...email,
        {
          ...leftChat,
          unavailable: { code: 'no_account', message: 'The chat widget is turned off.' },
          accounts: [],
        },
      ],
    });
    expect(channelChoicesOf(off).at(-1)).toMatchObject({ usable: false, gap: 'no_account' });
    // A widget the server calls available but doesn't name can't be answered from.
    const unnamed = composerOf({ channels: [...email, { ...openChat, accounts: [] }] });
    expect(channelChoicesOf(unnamed).at(-1)).toMatchObject({ usable: false, gap: 'no_account' });
    expect(selectionFor(channelChoicesOf(left), { channel: 'webchat' })?.channel).toBe('email');
  });

  it('says do not disturb stops web chat, and offers nothing then', () => {
    const stopped = composerOf({
      channels: [
        ...email,
        {
          ...openChat,
          available: false,
          unavailable: {
            code: 'do_not_contact',
            message: 'Do not disturb is on for web chat for this contact.',
          },
          accounts: [],
        },
      ],
    });
    expect(channelChoicesOf(stopped).at(-1)).toEqual({
      channel: 'webchat',
      usable: false,
      gap: 'do_not_contact',
      accounts: [],
      recipients: [],
    });
    expect(selectionFor(channelChoicesOf(stopped), { channel: 'webchat' })?.channel).toBe('email');
  });

  it('is chosen with its widget and no address, whatever address was chosen before', () => {
    expect(
      selectionFor(channelChoicesOf(chatting), {
        channel: 'webchat',
        accountId: bookings.id,
        to: mayaEmail.id,
      }),
    ).toEqual({ channel: 'webchat', accountId: siteChat.id, to: null });
    // Chat alone is enough to reply: no mailbox and no address are needed.
    const only = composerOf({ channels: [openChat] });
    expect(selectionFor(channelChoicesOf(only))).toEqual({
      channel: 'webchat',
      accountId: siteChat.id,
      to: null,
    });
  });

  it('makes a reply the contract accepts: no address and no subject', () => {
    const made = replyContentOf(chatting, { ...chatDraft, subject: 'Left over from email' });
    expect(made).toEqual({
      ok: true,
      content: {
        channel: 'webchat',
        accountId: siteChat.id,
        to: null,
        subject: null,
        text: 'We are open until six.',
      },
    });
    if (!made.ok) throw new Error('refused');
    expect(
      sendConversationReplyInput.safeParse({ ...made.content, idempotencyKey: newIdempotencyKey() })
        .success,
    ).toBe(true);
  });

  it('refuses an address on a chat reply, and a reply without one on any other channel', () => {
    expect(replyContentOf(chatting, { ...chatDraft, to: mayaEmail.id })).toEqual({
      ok: false,
      why: 'recipient_mismatch',
    });
    expect(
      replyContentOf(chatting, { ...chatDraft, channel: 'email', accountId: bookings.id }),
    ).toEqual({ ok: false, why: 'recipient_mismatch' });
  });

  it("refuses another channel's account, and a chat the visitor has left", () => {
    expect(replyContentOf(chatting, { ...chatDraft, accountId: bookings.id })).toEqual({
      ok: false,
      why: 'account_mismatch',
    });
    expect(replyContentOf(left, chatDraft)).toEqual({ ok: false, why: 'channel_unavailable' });
    expect(replyContentOf(composerOf(), chatDraft)).toEqual({
      ok: false,
      why: 'channel_unavailable',
    });
  });

  it('holds a chat message to the length the widget shows', () => {
    const most = 'a'.repeat(WEBCHAT_LIMITS.messageLength);
    expect(replyContentOf(chatting, { ...chatDraft, text: most }).ok).toBe(true);
    expect(replyContentOf(chatting, { ...chatDraft, text: most + 'a' })).toEqual({
      ok: false,
      why: 'chat_too_long',
    });
    // Spaces around it are not part of the message.
    expect(replyContentOf(chatting, { ...chatDraft, text: ' ' + most + ' ' }).ok).toBe(true);
  });

  it('gives a chat reply its own send key, apart from the same words by email', () => {
    const chat = replyContentOf(chatting, { ...chatDraft, text: 'Hello' });
    const mail = replyContentOf(chatting, {
      ...chatDraft,
      channel: 'email',
      accountId: bookings.id,
      to: mayaEmail.id,
      text: 'Hello',
    });
    if (!chat.ok || !mail.ok) throw new Error('refused');
    expect(fingerprintOf(chat.content)).not.toBe(fingerprintOf(mail.content));
  });
});

describe('replyContentOf', () => {
  const draft: ReplyDraft = {
    kind: 'reply',
    channel: 'email',
    accountId: bookings.id,
    to: mayaEmail.id,
    subject: ' Re: June 13 ',
    text: '  June 13 is open.\n\nShall we talk Thursday?  ',
  };

  it('makes what the contract accepts', () => {
    const made = replyContentOf(composerOf(), draft);
    expect(made).toEqual({
      ok: true,
      content: {
        channel: 'email',
        accountId: bookings.id,
        to: mayaEmail.id,
        subject: 'Re: June 13',
        text: 'June 13 is open.\n\nShall we talk Thursday?',
      },
    });
    if (!made.ok) throw new Error('refused');
    expect(
      sendConversationReplyInput.safeParse({ ...made.content, idempotencyKey: newIdempotencyKey() })
        .success,
    ).toBe(true);
  });

  it('never turns an internal note into a reply', () => {
    expect(
      replyContentOf(composerOf(), { kind: 'note', text: 'She haggles. Hold the price.' }),
    ).toEqual({
      ok: false,
      why: 'not_a_reply',
    });
    // Not even a note dressed with everything a reply has.
    const dressed = { ...draft, kind: 'note' as const };
    expect(replyContentOf(composerOf(), dressed)).toEqual({ ok: false, why: 'not_a_reply' });
  });

  it('refuses someone who may not reply', () => {
    expect(replyContentOf(composerOf({ canReply: false }), draft)).toEqual({
      ok: false,
      why: 'not_allowed',
    });
    expect(replyContentOf(undefined, draft)).toEqual({ ok: false, why: 'not_allowed' });
  });

  it("refuses an account that isn't the channel's", () => {
    expect(replyContentOf(composerOf(), { ...draft, accountId: accountId('3') })).toEqual({
      ok: false,
      why: 'account_mismatch',
    });
  });

  it("refuses an address that isn't the contact's on that channel", () => {
    expect(replyContentOf(composerOf(), { ...draft, to: mayaPhone.id })).toEqual({
      ok: false,
      why: 'recipient_mismatch',
    });
    expect(replyContentOf(composerOf(), { ...draft, to: identityId('8') })).toEqual({
      ok: false,
      why: 'recipient_mismatch',
    });
  });

  it("refuses a channel that can't send", () => {
    expect(
      replyContentOf(composerOf(), { ...draft, channel: 'sms', to: mayaPhone.id, subject: '' }),
    ).toEqual({ ok: false, why: 'channel_unavailable' });
  });

  it('refuses an empty message and a subject of several lines', () => {
    expect(replyContentOf(composerOf(), { ...draft, text: ' \n ' })).toEqual({
      ok: false,
      why: 'empty',
    });
    expect(replyContentOf(composerOf(), { ...draft, subject: 'One\nTwo' })).toEqual({
      ok: false,
      why: 'subject_lines',
    });
  });

  it('sends no subject when there is none, and never one on a text message', () => {
    const none = replyContentOf(composerOf(), { ...draft, subject: '  ' });
    expect(none.ok && none.content.subject).toBeNull();
    const texting = composerOf({
      channels: [
        {
          channel: 'sms',
          available: true,
          unavailable: null,
          accounts: [{ id: accountId('3'), name: 'Front desk', address: '+15550100000' }],
          recipients: [mayaPhone],
        },
      ],
    });
    const text = replyContentOf(texting, {
      ...draft,
      channel: 'sms',
      accountId: accountId('3'),
      to: mayaPhone.id,
      subject: 'Left over from email',
    });
    expect(text.ok && text.content.subject).toBeNull();
  });

  it('has words for every code the server refuses a reply with, and no others', () => {
    expect(Object.keys(serverRefusalWords).toSorted()).toEqual([...replyRefusalCodes].toSorted());
    for (const code of replyRefusalCodes) {
      expect(words(serverRefusalWords[code])).not.toBe('');
      expect(serverRefusalOf(code)).toBe(serverRefusalWords[code]);
    }
    expect(serverRefusalOf('not_a_code')).toBeUndefined();
    expect(serverRefusalOf(undefined)).toBeUndefined();
  });

  it('has words for every refusal', () => {
    for (const refusal of Object.values(replyRefusalWords)) expect(words(refusal)).not.toBe('');
  });

  it('lets only someone with a permission write at all', () => {
    expect(composerModesOf({ canReply: false, canManage: false })).toEqual([]);
    expect(composerModesOf({ canReply: true, canManage: false })).toEqual(['reply']);
    expect(composerModesOf({ canReply: false, canManage: true })).toEqual(['note']);
    expect(composerModesOf({ canReply: true, canManage: true })).toEqual(['reply', 'note']);
  });
});

describe('sending once', () => {
  const content: ReplyContent = {
    channel: 'email',
    accountId: bookings.id,
    to: mayaEmail.id,
    subject: 'Re: June 13',
    text: 'June 13 is open.',
  };
  const counter = (): (() => string) => {
    let made = 0;
    return () => `key-${String(++made).padStart(16, '0')}`;
  };

  it('makes keys the contract accepts, each one new', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it('keeps the key for the same message and makes a new one for a changed message', () => {
    const make = counter();
    const first = sendKeyFor(undefined, fingerprintOf(content), make);
    expect(sendKeyFor(first, fingerprintOf({ ...content }), make)).toBe(first);
    const changed = sendKeyFor(
      first,
      fingerprintOf({ ...content, text: 'June 14 is open.' }),
      make,
    );
    expect(changed.key).not.toBe(first.key);
    for (const other of [
      { ...content, accountId: dana.id },
      { ...content, to: mayaOtherEmail.id },
      { ...content, subject: null },
      { ...content, channel: 'sms' as const },
    ]) {
      expect(fingerprintOf(other)).not.toBe(fingerprintOf(content));
    }
  });

  it('sends one request for a double click, and both clicks get its answer', async () => {
    const sent: ReplyBody[] = [];
    let answer: ((value: string) => void) | undefined;
    const outbox = createReplyOutbox<string>((_, body) => {
      sent.push(body);
      return new Promise((resolve) => {
        answer = resolve;
      });
    }, counter());
    const first = outbox.submit(conversationId('1'), content);
    const second = outbox.submit(conversationId('1'), content);
    expect(sent).toHaveLength(1);
    answer?.('queued');
    expect(await Promise.all([first, second])).toEqual(['queued', 'queued']);
    expect(sent).toHaveLength(1);
  });

  it('retries a failed send with the same key, then gives the next message a new one', async () => {
    const sent: ReplyBody[] = [];
    let online = false;
    const outbox = createReplyOutbox<string>((_, body) => {
      sent.push(body);
      return online ? Promise.resolve('queued') : Promise.reject(new TypeError('Failed to fetch'));
    }, counter());
    await expect(outbox.submit(conversationId('1'), content)).rejects.toThrow('Failed to fetch');
    expect(outbox.pendingFor(conversationId('1'))?.key).toBe(sent[0]?.idempotencyKey);
    online = true;
    await expect(outbox.submit(conversationId('1'), content)).resolves.toBe('queued');
    expect(sent.map((body) => body.idempotencyKey)).toEqual([
      'key-0000000000000001',
      'key-0000000000000001',
    ]);
    expect(outbox.pendingFor(conversationId('1'))).toBeUndefined();
    // The same words again, after the first was sent, are a new message.
    await outbox.submit(conversationId('1'), content);
    expect(sent[2]?.idempotencyKey).toBe('key-0000000000000002');
  });

  it('gives a message changed after a failed send a new key', async () => {
    const sent: ReplyBody[] = [];
    const outbox = createReplyOutbox<string>((_, body) => {
      sent.push(body);
      return Promise.reject(new TypeError('Failed to fetch'));
    }, counter());
    await expect(outbox.submit(conversationId('1'), content)).rejects.toThrow();
    await expect(
      outbox.submit(conversationId('1'), { ...content, text: 'June 14 is open.' }),
    ).rejects.toThrow();
    expect(new Set(sent.map((body) => body.idempotencyKey)).size).toBe(2);
  });

  it('keeps each conversation to its own key and its own request', async () => {
    const sent: { conversation: string; key: string }[] = [];
    const outbox = createReplyOutbox<string>((conversation, body) => {
      sent.push({ conversation, key: body.idempotencyKey });
      return Promise.resolve('queued');
    }, counter());
    await Promise.all([
      outbox.submit(conversationId('1'), content),
      outbox.submit(conversationId('2'), content),
    ]);
    expect(sent.map((each) => each.conversation)).toEqual([
      conversationId('1'),
      conversationId('2'),
    ]);
    expect(sent[0]?.key).not.toBe(sent[1]?.key);
  });
});

describe('readThroughOf', () => {
  const items: ThreadItem[] = [
    messageOf({ id: messageId('1') }),
    messageOf({ id: messageId('2') }),
  ];
  const looking = {
    items,
    unreadCount: 2,
    mayMarkRead: true,
    attending: true,
    lastMarked: undefined,
  };

  it('marks an open conversation read up to the newest item on screen', () => {
    expect(readThroughOf(looking)).toBe(messageId('2'));
  });

  it('leaves a message unread when nobody is looking at it', () => {
    expect(readThroughOf({ ...looking, attending: false })).toBeUndefined();
  });

  it('marks a message that arrives while the conversation is open and in front', () => {
    const arrived = [...items, messageOf({ id: messageId('3') })];
    expect(
      readThroughOf({ ...looking, items: arrived, unreadCount: 1, lastMarked: messageId('2') }),
    ).toBe(messageId('3'));
  });

  it('never marks the same message twice, nor a conversation with nothing unread', () => {
    expect(readThroughOf({ ...looking, lastMarked: messageId('2') })).toBeUndefined();
    expect(readThroughOf({ ...looking, unreadCount: 0 })).toBeUndefined();
    expect(readThroughOf({ ...looking, items: [] })).toBeUndefined();
  });

  it("doesn't ask on behalf of someone who may only read", () => {
    expect(readThroughOf({ ...looking, mayMarkRead: false })).toBeUndefined();
  });
});

describe('putting an answer into what the page shows', () => {
  const maya = conversationOf();
  const ken = conversationOf({ id: conversationId('2'), unreadCount: 0, needsReply: false });
  const pages = {
    pages: [listOf([maya], { nextCursor: 'next' }), listOf([ken])],
    pageParams: [undefined, 'next'],
  };

  it('replaces the conversation where the list holds it', () => {
    const read: Conversation = { ...maya, unreadCount: 0, revision: 'b'.repeat(64) };
    const next = withConversation(pages, read);
    expect(next?.pages.flatMap((page) => page.items)).toEqual([read, ken]);
    expect(next?.pages[0]?.nextCursor).toBe('next');
    expect(next?.pageParams).toBe(pages.pageParams);
  });

  it('changes nothing for a conversation the list does not hold, or a list never read', () => {
    const stranger = conversationOf({ id: conversationId('7') });
    expect(withConversation(pages, stranger)).toBe(pages);
    expect(withConversation(undefined, maya)).toBeUndefined();
  });

  it('is harmless when the same answer arrives twice', () => {
    const read: Conversation = { ...maya, unreadCount: 0 };
    const once = withConversation(pages, read);
    expect(withConversation(once, read)).toEqual(once);
  });

  const first = messageOf({ id: messageId('1') });
  const thread = { pages: [threadOf([first])], pageParams: [undefined] };

  it('adds a new message or note as the newest', () => {
    const note = noteOf();
    const next = withThreadItem(thread, note);
    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual([note.id, first.id]);
    expect(threadItemsOf(next?.pages ?? []).at(-1)).toBe(note);
  });

  it('shows a message once however often its answer arrives, at its latest state', () => {
    const queued = messageOf({ id: messageId('5'), direction: 'outbound', status: 'queued' });
    const sent = { ...queued, status: 'sent' as const };
    const twice = withThreadItem(withThreadItem(withThreadItem(thread, queued), queued), sent);
    expect(twice?.pages[0]?.items.map((item) => item.id)).toEqual([queued.id, first.id]);
    expect(twice?.pages[0]?.items[0]).toBe(sent);
  });

  it('leaves a thread that was never read alone', () => {
    expect(withThreadItem(undefined, noteOf())).toBeUndefined();
    const empty = { pages: [], pageParams: [] };
    expect(withThreadItem(empty, noteOf())).toBe(empty);
  });

  it('takes a read conversation out of the unread counts', () => {
    const summary = summaryOf({ unreadConversations: 3, unreadMessages: 7, needsReply: 2 });
    expect(summaryAfter(summary, maya, { ...maya, unreadCount: 0 })).toEqual({
      unreadConversations: 2,
      unreadMessages: 5,
      needsReply: 2,
    });
  });

  it('counts a new inbound message in a conversation nobody is looking at', () => {
    const summary = summaryOf({ unreadConversations: 0, unreadMessages: 0, needsReply: 0 });
    expect(summaryAfter(summary, ken, { ...ken, unreadCount: 1, needsReply: true })).toEqual({
      unreadConversations: 1,
      unreadMessages: 1,
      needsReply: 1,
    });
  });

  it('stops counting a conversation that is closed or snoozed, and counts it when reopened', () => {
    const summary = summaryOf({ unreadConversations: 1, unreadMessages: 2, needsReply: 1 });
    const closed: Conversation = { ...maya, status: 'closed', needsReply: false };
    expect(summaryAfter(summary, maya, closed)).toEqual({
      unreadConversations: 0,
      unreadMessages: 0,
      needsReply: 0,
    });
    expect(summaryAfter(summaryAfter(summary, maya, closed), closed, maya)).toEqual(summary);
  });

  it('leaves the counts alone without knowing what the conversation was', () => {
    const summary = summaryOf();
    expect(summaryAfter(summary, undefined, maya)).toBe(summary);
    expect(summaryAfter(summary, ken, maya)).toBe(summary);
    expect(summaryAfter(undefined, maya, maya)).toBeUndefined();
  });

  it('never counts below zero, and applying the same change twice adds nothing', () => {
    const none = summaryOf({ unreadConversations: 0, unreadMessages: 0, needsReply: 0 });
    const read = { ...maya, unreadCount: 0, needsReply: false };
    expect(summaryAfter(none, maya, read)).toEqual(none);
    const summary = summaryOf({ unreadConversations: 2, unreadMessages: 4, needsReply: 2 });
    const once = summaryAfter(summary, maya, read);
    expect(summaryAfter(once, read, read)).toEqual(once);
  });
});

describe('links in text from outside', () => {
  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.test/file',
    'mailto:maya@example.test',
    '//example.test/path',
    'example.test',
    'https://',
    'https://user:secret@example.test/',
    'https://bank.example@evil.test/',
    ' https://example.test',
    'http://exa mple.test',
  ])('never links %s', (candidate) => {
    expect(safeHref(candidate)).toBeUndefined();
  });

  it('links whole http and https addresses', () => {
    expect(safeHref('https://example.test/a?b=1#c')).toBe('https://example.test/a?b=1#c');
    expect(safeHref('HTTP://Example.test')).toBe('http://example.test/');
  });

  it('splits text into plain text and safe links, keeping every character', () => {
    const text = 'See https://example.test/guide. Or (http://example.test/a?b=1), thanks!';
    const parts = textPartsOf(text);
    expect(parts).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.test/guide', href: 'https://example.test/guide' },
      { kind: 'text', text: '. Or (' },
      { kind: 'link', text: 'http://example.test/a?b=1', href: 'http://example.test/a?b=1' },
      { kind: 'text', text: '), thanks!' },
    ]);
    expect(parts.map((part) => part.text).join('')).toBe(text);
  });

  it('leaves markup, scripts and unsafe addresses as text', () => {
    const text =
      '<script>alert(1)</script> <a href="javascript:alert(1)">x</a> javascript:alert(2) https://user:pw@evil.test/x <img src=x onerror=alert(3)>';
    expect(textPartsOf(text)).toEqual([{ kind: 'text', text }]);
  });

  it("stops a link at a quote or an angle bracket, so markup can't ride along", () => {
    const parts = textPartsOf('https://example.test/"onmouseover="alert(1) <b>');
    expect(parts[0]).toEqual({
      kind: 'link',
      text: 'https://example.test/',
      href: 'https://example.test/',
    });
    expect(parts.map((part) => part.text).join('')).toBe(
      'https://example.test/"onmouseover="alert(1) <b>',
    );
  });

  it('keeps empty text empty', () => {
    expect(textPartsOf('')).toEqual([]);
  });
});

describe('times', () => {
  const now = new Date('2026-10-09T12:00:00.000Z');

  it('says the time for today, the date for this year, and the year before that', () => {
    expect(shortTimeOf('2026-10-09T07:58:00.000Z', now, 'en', 'UTC')).toBe('7:58 AM');
    expect(shortTimeOf('2026-09-28T07:58:00.000Z', now, 'en', 'UTC')).toBe('Sep 28');
    expect(shortTimeOf('2025-09-28T07:58:00.000Z', now, 'en', 'UTC')).toBe('Sep 28, 2025');
  });

  it('snoozes for three hours, until tomorrow morning, or until Monday morning', () => {
    // A Friday afternoon, on the reader's own clock.
    const friday = new Date(2026, 9, 9, 15, 30);
    expect(snoozeUntilOf('three_hours', friday).getTime() - friday.getTime()).toBe(10_800_000);
    expect(snoozeUntilOf('tomorrow', friday)).toEqual(new Date(2026, 9, 10, 9, 0));
    expect(snoozeUntilOf('next_week', friday)).toEqual(new Date(2026, 9, 12, 9, 0));
    expect(snoozeUntilOf('next_week', new Date(2026, 9, 12, 8, 0))).toEqual(
      new Date(2026, 9, 19, 9, 0),
    );
    expect(snoozeUntilOf('next_week', new Date(2026, 9, 11, 23, 0))).toEqual(
      new Date(2026, 9, 12, 9, 0),
    );
  });

  it('accepts only a snooze time that is still ahead', () => {
    expect(snoozeTimeOf('', now)).toEqual({ ok: false, why: 'invalid' });
    expect(snoozeTimeOf('not a time', now)).toEqual({ ok: false, why: 'invalid' });
    expect(snoozeTimeOf('2026-10-09T12:00:00.000Z', now)).toEqual({ ok: false, why: 'past' });
    expect(snoozeTimeOf('2026-10-10T09:00:00.000Z', now)).toEqual({
      ok: true,
      until: '2026-10-10T09:00:00.000Z',
    });
  });

  it('gives a contact the same avatar tint every time', () => {
    expect(tintOf(conversationId('1'))).toBe(tintOf(conversationId('1')));
    expect([1, 2, 3, 4]).toContain(tintOf(conversationId('2')));
    expect([1, 2, 3, 4]).toContain(tintOf(''));
  });
});

describe('the channel a reply starts on', () => {
  const frontDesk = { id: accountId('3'), name: 'Front desk', address: '+15550100000' };
  const text = {
    channel: 'sms' as const,
    available: true,
    unavailable: null,
    accounts: [frontDesk],
    recipients: [mayaPhone],
  };
  const [email] = composerOf().channels;
  if (email === undefined) throw new Error('The fixture offers no email.');
  const all = composerOf({ channels: [email, text, openChat] });
  const choices = channelChoicesOf(all);

  it('is the channel the server suggests: the one the contact last wrote on', () => {
    expect(selectionFor(choices, {}, 'sms')).toEqual({
      channel: 'sms',
      accountId: frontDesk.id,
      to: mayaPhone.id,
    });
    expect(selectionFor(choices, {}, 'webchat')).toEqual({
      channel: 'webchat',
      accountId: siteChat.id,
      to: null,
    });
    expect(selectionFor(choices, {}, 'email')?.channel).toBe('email');
  });

  it('gives way to what the person chose', () => {
    expect(selectionFor(choices, { channel: 'email' }, 'sms')?.channel).toBe('email');
    expect(selectionFor(choices, { channel: 'webchat' }, 'sms')?.channel).toBe('webchat');
  });

  it('is used when what the person chose can no longer send', () => {
    const left = channelChoicesOf(composerOf({ channels: [email, text, leftChat] }));
    expect(selectionFor(left, { channel: 'webchat' }, 'sms')?.channel).toBe('sms');
  });

  it('is the first usable channel when the server suggests none, or one that cannot send here', () => {
    expect(selectionFor(choices, {}, null)?.channel).toBe('email');
    expect(selectionFor(choices)?.channel).toBe('email');
    // The server says text messages work, and names no number to send from.
    const unnamed = channelChoicesOf(
      composerOf({ channels: [email, { ...text, accounts: [] }, openChat] }),
    );
    expect(selectionFor(unnamed, {}, 'sms')?.channel).toBe('email');
  });
});
