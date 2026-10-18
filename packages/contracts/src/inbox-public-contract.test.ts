import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  addConversationNoteInput,
  assignConversationInput,
  listConversations,
  markConversationReadInput,
  sendConversationReplyInput,
  setConversationStatusInput,
} from './index.js';

const uuid = '01a11403-3ee7-7bb3-90d9-f58f45343f61';
const revision = 'a'.repeat(64);
const reply = {
  channel: 'email',
  accountId: toPublicId('channel_account', uuid),
  to: toPublicId('contact_identity', uuid),
  subject: 'Following up',
  text: 'Thanks for your message.',
  idempotencyKey: 'one_reply_1234567',
};

describe('the exported inbox contract', () => {
  it('defaults to an open inbox while permitting a bounded pagination cursor', () => {
    expect(listConversations.query.parse({})).toEqual({
      status: 'open',
      assignee: 'anyone',
      reply: 'any',
      unread: 'any',
      // Starred or not: the list is every conversation unless told otherwise.
      starred: 'any',
    });
    expect(listConversations.query.safeParse({ after: 'a'.repeat(201) }).success).toBe(false);
  });

  it('refuses a contact id where a recipient identity is required', () => {
    expect(sendConversationReplyInput.safeParse(reply).success).toBe(true);
    expect(
      sendConversationReplyInput.safeParse({ ...reply, to: toPublicId('contact', uuid) }).success,
    ).toBe(false);
  });

  it('refuses a mailbox id where a channel account is required', () => {
    expect(
      sendConversationReplyInput.safeParse({ ...reply, accountId: toPublicId('mailbox', uuid) })
        .success,
    ).toBe(false);
  });

  it('refuses header injection, blank messages and a missing retry key', () => {
    for (const changes of [
      { subject: 'Hello\r\nBcc: somebody@example.test' },
      { text: '  ' },
      { idempotencyKey: '' },
    ])
      expect(sendConversationReplyInput.safeParse({ ...reply, ...changes }).success).toBe(false);
  });

  it('refuses email-only fields on an SMS reply', () => {
    expect(sendConversationReplyInput.safeParse({ ...reply, channel: 'sms' }).success).toBe(false);
    expect(
      sendConversationReplyInput.safeParse({ ...reply, channel: 'sms', subject: null }).success,
    ).toBe(true);
  });

  it('requires a revision for assignment and a date for snoozing', () => {
    expect(assignConversationInput.safeParse({ assignee: 'me' }).success).toBe(false);
    expect(assignConversationInput.safeParse({ assignee: 'me', revision }).success).toBe(true);
    expect(setConversationStatusInput.safeParse({ status: 'snoozed', revision }).success).toBe(
      false,
    );
    expect(
      setConversationStatusInput.safeParse({
        status: 'snoozed',
        revision,
        until: '2026-10-10T10:00:00+03:00',
      }).success,
    ).toBe(true);
  });

  it('refuses a conversation id as a read watermark and recipient fields on an internal note', () => {
    expect(
      markConversationReadInput.safeParse({ through: toPublicId('conversation', uuid) }).success,
    ).toBe(false);
    expect(
      markConversationReadInput.safeParse({ through: toPublicId('message', uuid) }).success,
    ).toBe(true);
    expect(addConversationNoteInput.safeParse({ text: 'Team only', to: reply.to }).success).toBe(
      false,
    );
  });
});
