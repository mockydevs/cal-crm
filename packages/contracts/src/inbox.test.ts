import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  addConversationNoteInput,
  assignConversationInput,
  composerUnavailableCodes,
  conversation,
  conversationAssigneeList,
  conversationComposer,
  conversationThread,
  getInboxSummary,
  inboxSummary,
  listConversationAssignees,
  listConversationMessages,
  listConversations,
  markConversationReadInput,
  messageHoldCodes,
  messageProblemCodes,
  MESSAGE_TEXT_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  PREVIEW_MAX_LENGTH,
  replyRefusalCodes,
  sendConversationReply,
  sendConversationReplyInput,
  setConversationStatusInput,
  threadItem,
  threadMessage,
  threadNote,
} from './inbox.js';

const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
const id = {
  conversation: toPublicId('conversation', uuid),
  message: toPublicId('message', uuid),
  contact: toPublicId('contact', uuid),
  membership: toPublicId('membership', uuid),
  account: toPublicId('channel_account', uuid),
  identity: toPublicId('contact_identity', uuid),
};
const revision = 'a'.repeat(64);
const at = '2026-10-09T09:30:00.000Z';

const shownConversation = {
  id: id.conversation,
  contact: { id: id.contact, name: 'Maya Thompson', trashed: false },
  status: 'open',
  snoozedUntil: null,
  assignee: { membershipId: id.membership, name: 'Dana Brooks', you: true },
  needsReply: true,
  unreadCount: 2,
  unverified: false,
  claimedContact: null,
  lastActivityAt: at,
  lastMessage: {
    preview: 'Is June 13 still open?',
    direction: 'inbound',
    channel: 'email',
    status: 'received',
    at,
  },
  canManage: true,
  canReply: false,
  revision,
};
const shownMessage = {
  kind: 'message',
  id: id.message,
  direction: 'outbound',
  channel: 'email',
  account: { id: id.account, name: 'Front desk', address: 'hello@example.test' },
  author: { kind: 'user', name: 'Dana Brooks', you: true },
  status: 'queued',
  problem: null,
  held: { code: 'quiet_hours', message: 'Waiting: it is quiet hours.', until: at },
  subject: 'Re: June 13',
  text: 'Hi Maya',
  textTruncated: false,
  from: null,
  to: ['maya@example.test'],
  cc: [],
  automated: false,
  replyTo: null,
  attachments: [],
  createdAt: at,
  sentAt: null,
};
const shownNote = {
  kind: 'note',
  id: id.message,
  author: { kind: 'user', name: 'Dana Brooks', you: true },
  text: 'She prefers texts.',
  createdAt: at,
};

describe('reading the inbox', () => {
  it('opens on open conversations for anyone, newest activity first', () => {
    expect(listConversations.query.parse({})).toEqual({
      status: 'open',
      assignee: 'anyone',
      reply: 'any',
      unread: 'any',
      // Starred or not: the list is every conversation unless told otherwise.
      starred: 'any',
    });
    expect(
      listConversations.query.parse({
        status: 'all',
        assignee: id.membership,
        reply: 'needed',
        unread: 'unread',
        channel: 'sms',
        contactId: id.contact,
      }),
    ).toMatchObject({ assignee: id.membership, channel: 'sms', contactId: id.contact });
  });

  it('refuses filters it does not have, and ids of another kind', () => {
    for (const query of [
      { sort: 'oldest' },
      { status: 'archived' },
      { assignee: id.contact },
      { assignee: 'someone' },
      { channel: 'note' },
      { contactId: id.conversation },
      { reply: 'yes' },
    ])
      expect(listConversations.query.safeParse(query).success, JSON.stringify(query)).toBe(false);
  });

  it('takes a cursor back unchanged, and nothing that could not be one', () => {
    const cursor = 'MjAyNi0xMC0wOVQwOTozMDowMC4xMjM0NTZafDAxODkwYTVk_-';
    expect(listConversations.query.parse({ after: cursor }).after).toBe(cursor);
    expect(listConversationMessages.query.parse({ before: cursor }).before).toBe(cursor);
    for (const bad of ['', 'a b', "x'; drop table", 'a'.repeat(201), 'a+b/c='])
      expect(listConversations.query.safeParse({ after: bad }).success, bad).toBe(false);
    expect(listConversationMessages.query.safeParse({ after: cursor }).success).toBe(false);
  });

  it('describes a conversation with its contact, assignee, counts and bounded preview', () => {
    expect(conversation.parse(shownConversation)).toEqual(shownConversation);
    expect(
      conversation.parse({ ...shownConversation, assignee: null, lastMessage: null }),
    ).toMatchObject({ assignee: null, lastMessage: null });
    const withPreview = (preview: string) => ({
      ...shownConversation,
      lastMessage: { ...shownConversation.lastMessage, preview },
    });
    expect(conversation.safeParse(withPreview('x'.repeat(PREVIEW_MAX_LENGTH))).success).toBe(true);
    expect(conversation.safeParse(withPreview('x'.repeat(PREVIEW_MAX_LENGTH + 1))).success).toBe(
      false,
    );
    // An internal note is never a conversation's last message.
    expect(
      conversation.safeParse({
        ...shownConversation,
        lastMessage: { ...shownConversation.lastMessage, direction: 'internal' },
      }).success,
    ).toBe(false);
    expect(conversation.safeParse({ ...shownConversation, unreadCount: -1 }).success).toBe(false);
    // Whether anybody proved who wrote is always said, never left to be assumed.
    const { unverified: _unverified, ...unmarked } = shownConversation;
    expect(conversation.safeParse(unmarked).success).toBe(false);
    const { claimedContact: _claimed, ...unclaimed } = shownConversation;
    expect(conversation.safeParse(unclaimed).success).toBe(false);
    const chat = {
      ...shownConversation,
      unverified: true,
      claimedContact: { id: id.contact, name: 'Maya Thompson', trashed: false },
    };
    expect(conversation.parse(chat)).toEqual(chat);
    expect(
      conversation.safeParse({ ...chat, claimedContact: { id: 'maya@example.test' } }).success,
    ).toBe(false);
    expect(conversation.safeParse({ ...shownConversation, status: 'archived' }).success).toBe(
      false,
    );
  });

  it('counts for the sidebar with whole numbers only', () => {
    expect(getInboxSummary.response.schema).toBe(inboxSummary);
    expect(
      inboxSummary.parse({ unreadConversations: 3, unreadMessages: 7, needsReply: 2 }),
    ).toEqual({ unreadConversations: 3, unreadMessages: 7, needsReply: 2 });
    expect(
      inboxSummary.safeParse({ unreadConversations: 1.5, unreadMessages: 0, needsReply: 0 })
        .success,
    ).toBe(false);
  });
});

describe('a thread', () => {
  it('tells a message from a note by its kind', () => {
    expect(threadItem.parse(shownMessage)).toEqual(shownMessage);
    expect(threadItem.parse(shownNote)).toEqual(shownNote);
    expect(
      conversationThread.parse({ items: [shownMessage, shownNote], nextCursor: null }),
    ).toEqual({ items: [shownMessage, shownNote], nextCursor: null });
    expect(threadItem.safeParse({ ...shownNote, kind: 'comment' }).success).toBe(false);
  });

  it('has no place for HTML, and bounds the text of a message and of a note', () => {
    expect(Object.keys(threadMessage.shape).filter((key) => /html/i.test(key))).toEqual([]);
    expect(Object.keys(threadNote.shape).filter((key) => /html/i.test(key))).toEqual([]);
    expect(
      threadMessage.safeParse({ ...shownMessage, text: 'x'.repeat(MESSAGE_TEXT_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(
      threadNote.safeParse({ ...shownNote, text: 'x'.repeat(NOTE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('gives a note no delivery: no channel, account, status or recipients are part of it', () => {
    expect(Object.keys(threadNote.shape).sort()).toEqual([
      'author',
      'createdAt',
      'id',
      'kind',
      'text',
    ]);
  });

  it('shows a message on any channel, and never as a note or with an unknown status', () => {
    for (const channel of ['email', 'sms', 'webchat'])
      expect(threadMessage.safeParse({ ...shownMessage, channel }).success, channel).toBe(true);
    for (const changes of [
      { channel: 'note' },
      { direction: 'internal' },
      { status: 'note' },
      { status: 'pending' },
      { account: { id: toPublicId('mailbox', uuid), name: 'Front desk', address: null } },
    ])
      expect(
        threadMessage.safeParse({ ...shownMessage, ...changes }).success,
        JSON.stringify(changes),
      ).toBe(false);
  });

  it('names every reason with a code from a closed list', () => {
    for (const code of messageProblemCodes)
      expect(
        threadMessage.safeParse({
          ...shownMessage,
          status: 'failed',
          held: null,
          problem: { code, message: 'Not sent.' },
        }).success,
        code,
      ).toBe(true);
    for (const code of messageHoldCodes)
      expect(
        threadMessage.safeParse({
          ...shownMessage,
          held: { code, message: 'Waiting.', until: null },
        }).success,
        code,
      ).toBe(true);
    expect(
      threadMessage.safeParse({
        ...shownMessage,
        problem: { code: 'something_new', message: 'Not sent.' },
      }).success,
    ).toBe(false);
    expect(
      threadMessage.safeParse({
        ...shownMessage,
        held: { code: 'something_new', message: 'Waiting.', until: null },
      }).success,
    ).toBe(false);
    // No code is listed twice, and the lists are the ones the UI words.
    for (const codes of [
      messageProblemCodes,
      messageHoldCodes,
      composerUnavailableCodes,
      replyRefusalCodes,
    ])
      expect(new Set<string>(codes).size).toBe(codes.length);
    expect(messageProblemCodes).toContain('consent_required');
    expect(messageHoldCodes).toContain('quiet_hours');
    expect(composerUnavailableCodes).toContain('channel_unavailable');
    expect(replyRefusalCodes).toContain('account_channel_mismatch');
  });

  it('carries why a message failed or waits, in words', () => {
    const failed = {
      ...shownMessage,
      status: 'failed',
      held: null,
      problem: { code: 'consent_required', message: 'Not sent: no consent.' },
    };
    expect(threadMessage.parse(failed)).toMatchObject({ problem: { code: 'consent_required' } });
    expect(
      threadMessage.safeParse({ ...failed, problem: { code: 'consent_required' } }).success,
    ).toBe(false);
  });

  it('describes what the composer can send from and to', () => {
    const composer = {
      canReply: true,
      channels: [
        {
          channel: 'email',
          available: true,
          unavailable: null,
          accounts: [{ id: id.account, name: 'Front desk', address: 'hello@example.test' }],
          recipients: [{ id: id.identity, address: 'maya@example.test', primary: true }],
        },
        {
          channel: 'sms',
          available: false,
          unavailable: { code: 'channel_unavailable', message: 'Not connected.' },
          accounts: [],
          recipients: [],
        },
      ],
      suggestedSubject: 'Re: June 13',
      suggestedChannel: 'email',
    };
    expect(conversationComposer.parse(composer)).toEqual(composer);
    // The channel to start on is one a reply can go on, or none; never left out.
    for (const suggestedChannel of ['sms', 'webchat', null])
      expect(conversationComposer.safeParse({ ...composer, suggestedChannel }).success).toBe(true);
    expect(conversationComposer.safeParse({ ...composer, suggestedChannel: 'note' }).success).toBe(
      false,
    );
    const { suggestedChannel: _left, ...without } = composer;
    expect(conversationComposer.safeParse(without).success).toBe(false);
    expect(
      conversationComposer.safeParse({
        ...composer,
        channels: [
          {
            ...composer.channels[1],
            unavailable: { code: 'channel_not_connected', message: 'No.' },
          },
        ],
      }).success,
    ).toBe(false);
    // Web chat has an account (the widget) and no address: the visitor in the chat.
    const chat = {
      ...composer,
      channels: [
        {
          channel: 'webchat',
          available: false,
          unavailable: { code: 'visitor_left', message: 'The visitor has left the chat.' },
          accounts: [{ id: id.account, name: 'Main site', address: null }],
          recipients: [],
        },
      ],
    };
    expect(conversationComposer.parse(chat)).toEqual(chat);
    expect(
      conversationComposer.safeParse({
        ...composer,
        channels: [{ ...composer.channels[0], channel: 'note' }],
      }).success,
    ).toBe(false);
  });
});

describe('changing a conversation', () => {
  it('assigns to me, to a member or to nobody, from a current view only', () => {
    for (const assignee of ['me', id.membership, null])
      expect(assignConversationInput.parse({ assignee, revision })).toEqual({ assignee, revision });
    for (const input of [
      { assignee: 'me' },
      { revision },
      { assignee: id.contact, revision },
      { assignee: 'me', revision: 'stale' },
      { assignee: 'me', revision, assigneeUserId: uuid },
    ])
      expect(assignConversationInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('opens and closes without a time, and snoozes only until one', () => {
    expect(setConversationStatusInput.parse({ status: 'open', revision })).toEqual({
      status: 'open',
      revision,
    });
    expect(setConversationStatusInput.parse({ status: 'closed', revision })).toEqual({
      status: 'closed',
      revision,
    });
    const snooze = { status: 'snoozed', until: '2026-10-10T08:00:00+03:00', revision };
    expect(setConversationStatusInput.parse(snooze)).toEqual(snooze);
    for (const input of [
      { status: 'snoozed', revision },
      { status: 'snoozed', until: '2026-10-10T08:00', revision },
      { status: 'open', until: '2026-10-10T08:00:00Z', revision },
      { status: 'closed' },
      { status: 'archived', revision },
    ])
      expect(setConversationStatusInput.safeParse(input).success, JSON.stringify(input)).toBe(
        false,
      );
  });

  it('marks read up to a message, never "everything"', () => {
    expect(markConversationReadInput.parse({ through: id.message })).toEqual({
      through: id.message,
    });
    for (const input of [{}, { through: id.conversation }, { through: id.message, all: true }])
      expect(markConversationReadInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('takes a note as text with a retry key, and nothing that could address it to anyone', () => {
    const idempotencyKey = 'a'.repeat(32);
    expect(addConversationNoteInput.parse({ text: '  Call her back.  ', idempotencyKey })).toEqual({
      text: 'Call her back.',
      idempotencyKey,
    });
    for (const input of [
      { text: 'Hi' },
      { text: ' ', idempotencyKey },
      { text: 'x'.repeat(NOTE_MAX_LENGTH + 1), idempotencyKey },
      { text: 'Hi', idempotencyKey: 'short' },
      { text: 'Hi', idempotencyKey, to: id.identity },
      { text: 'Hi', idempotencyKey, channel: 'email' },
      { text: 'Hi', idempotencyKey, accountId: id.account },
    ])
      expect(addConversationNoteInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('lists who a conversation can be assigned to, a page at a time', () => {
    expect(listConversationAssignees.query.parse({})).toEqual({});
    expect(listConversationAssignees.query.parse({ after: id.membership })).toEqual({
      after: id.membership,
    });
    expect(listConversationAssignees.query.safeParse({ userId: uuid }).success).toBe(false);
    const page = {
      items: [{ id: id.membership, name: 'Dana Brooks', you: true }],
      nextCursor: null,
    };
    expect(conversationAssigneeList.parse(page)).toEqual(page);
    expect(
      conversationAssigneeList.safeParse({
        ...page,
        items: [{ id: id.contact, name: null, you: false }],
      }).success,
    ).toBe(false);
  });
});

describe('sending a reply', () => {
  const reply = {
    channel: 'email',
    accountId: id.account,
    to: id.identity,
    subject: 'Re: June 13',
    text: 'Hi Maya, June 13 is open.',
    idempotencyKey: 'a'.repeat(32),
  };

  it('needs a channel, an account, one of the contact’s addresses, words and a retry key', () => {
    expect(sendConversationReplyInput.parse(reply)).toEqual(reply);
    const { subject: _subject, ...plain } = reply;
    expect(sendConversationReplyInput.parse(plain)).toEqual({ ...plain, subject: null });
    for (const field of ['channel', 'accountId', 'to', 'text', 'idempotencyKey'] as const) {
      const { [field]: _omitted, ...incomplete } = reply;
      expect(sendConversationReplyInput.safeParse(incomplete).success, field).toBe(false);
    }
  });

  it('takes text messages in the contract, without a subject', () => {
    expect(
      sendConversationReplyInput.parse({ ...reply, channel: 'sms', subject: null }),
    ).toMatchObject({ channel: 'sms', subject: null });
    const withSubject = sendConversationReplyInput.safeParse({ ...reply, channel: 'sms' });
    expect(withSubject.success).toBe(false);
    expect(withSubject.error?.issues[0]).toMatchObject({
      path: ['subject'],
      message: 'Only email has a subject.',
    });
    expect(sendConversationReplyInput.safeParse({ ...reply, channel: 'webchat' }).success).toBe(
      false,
    );
    expect(sendConversationReplyInput.safeParse({ ...reply, channel: 'note' }).success).toBe(false);
  });

  it('takes a web chat reply with no address and no subject, and refuses one with either', () => {
    const chat = { ...reply, channel: 'webchat', subject: null, to: null };
    expect(sendConversationReplyInput.parse(chat)).toEqual(chat);
    const { to: _to, subject: _subject, ...bare } = chat;
    expect(sendConversationReplyInput.parse(bare)).toEqual(chat);
    const addressed = sendConversationReplyInput.safeParse({ ...chat, to: reply.to });
    expect(addressed.success).toBe(false);
    expect(addressed.error?.issues[0]).toMatchObject({
      path: ['to'],
      params: { code: 'recipient_not_supported' },
    });
    expect(sendConversationReplyInput.safeParse({ ...chat, subject: 'Hello' }).success).toBe(false);
    // Every other channel still needs one of the contact's own addresses.
    for (const channel of ['email', 'sms']) {
      const unaddressed = sendConversationReplyInput.safeParse({
        ...reply,
        channel,
        subject: null,
        to: null,
      });
      expect(unaddressed.success, channel).toBe(false);
      expect(unaddressed.error?.issues[0]).toMatchObject({
        path: ['to'],
        params: { code: 'recipient_required' },
      });
    }
  });

  it('refuses a raw address, a sender it is not given, HTML and anything that picks a purpose', () => {
    for (const changes of [
      { to: 'maya@example.test' },
      { to: id.contact },
      { accountId: toPublicId('mailbox', uuid) },
      { from: 'ceo@example.test' },
      { html: '<b>Hi</b>' },
      { purpose: 'marketing' },
      { lane: 'campaign' },
      { cc: ['someone@example.test'] },
      { subject: 'Hello\nBcc: someone@example.test' },
      { subject: 'x'.repeat(999) },
      { text: '   ' },
      { text: 'x'.repeat(MESSAGE_TEXT_MAX_LENGTH + 1) },
    ])
      expect(
        sendConversationReplyInput.safeParse({ ...reply, ...changes }).success,
        JSON.stringify(changes).slice(0, 60),
      ).toBe(false);
  });

  it('takes only a retry key that is hard to guess and safe to store', () => {
    for (const idempotencyKey of ['a'.repeat(16), 'A-b_9'.repeat(8), 'a'.repeat(64)])
      expect(
        sendConversationReplyInput.safeParse({ ...reply, idempotencyKey }).success,
        idempotencyKey,
      ).toBe(true);
    for (const idempotencyKey of [
      '',
      'short',
      'a'.repeat(65),
      'has space in the key',
      'a:b'.repeat(8),
    ])
      expect(
        sendConversationReplyInput.safeParse({ ...reply, idempotencyKey }).success,
        idempotencyKey,
      ).toBe(false);
  });

  it('answers with the message as the pipeline left it', () => {
    expect(sendConversationReply.response.schema).toBe(threadMessage);
    expect(sendConversationReply.response.status).toBe(201);
  });
});
