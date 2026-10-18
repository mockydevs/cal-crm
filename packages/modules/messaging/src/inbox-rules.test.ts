import { describe, expect, it } from 'vitest';

import {
  boundText,
  decodeCursor,
  effectiveStatus,
  encodeCursor,
  heldReason,
  holdCodes,
  needsReply,
  previewOf,
  problemCodes,
  problemReason,
  replyRefusal,
  replySubject,
  suggestedChannel,
  unreadCount,
  type ReplyFacts,
  type StoredMessage,
} from './inbox-rules.js';

const inbound = (seq: number): StoredMessage => ({ seq, direction: 'inbound', status: 'received' });
const outbound = (seq: number, status = 'sent'): StoredMessage => ({
  seq,
  direction: 'outbound',
  status,
});
const note = (seq: number): StoredMessage => ({ seq, direction: 'internal', status: 'note' });

describe('needs reply', () => {
  it('is false with no messages, and true once the contact writes', () => {
    expect(needsReply([])).toBe(false);
    expect(needsReply([inbound(1)])).toBe(true);
  });

  it('is cleared by a reply that is on its way or was sent', () => {
    for (const status of ['queued', 'sending', 'sent', 'delivered', 'read'])
      expect(needsReply([inbound(1), outbound(2, status)]), status).toBe(false);
  });

  it('is not cleared by a reply that failed, bounced or has unknown delivery', () => {
    for (const status of ['failed', 'bounced', 'unknown'])
      expect(needsReply([inbound(1), outbound(2, status)]), status).toBe(true);
  });

  it('is not cleared by an internal note', () => {
    expect(needsReply([inbound(1), note(2)])).toBe(true);
    expect(needsReply([note(1)])).toBe(false);
  });

  it('follows the order messages were stored in, not the order they are given in', () => {
    expect(needsReply([outbound(2), inbound(1)])).toBe(false);
    expect(needsReply([inbound(3), outbound(2), inbound(1)])).toBe(true);
  });

  it('stays false when a failed reply follows a reply that was sent', () => {
    expect(needsReply([inbound(1), outbound(2), outbound(3, 'failed')])).toBe(false);
  });

  it('comes back when a later message from the contact follows the reply', () => {
    expect(needsReply([inbound(1), outbound(2), note(3), inbound(4)])).toBe(true);
  });
});

describe('unread count', () => {
  const thread = [inbound(1), outbound(2), inbound(3), note(4), inbound(5)];

  it("counts only the contact's messages stored after the one read through", () => {
    expect(unreadCount(thread, 0)).toBe(3);
    expect(unreadCount(thread, 1)).toBe(2);
    expect(unreadCount(thread, 3)).toBe(1);
    expect(unreadCount(thread, 4)).toBe(1);
    expect(unreadCount(thread, 5)).toBe(0);
  });

  it('never counts notes or replies', () => {
    expect(unreadCount([outbound(1), note(2)], 0)).toBe(0);
  });
});

describe('effective status', () => {
  const now = new Date('2026-10-09T12:00:00.000Z');

  it('keeps a snooze until its time, then shows the conversation as open', () => {
    expect(effectiveStatus('snoozed', new Date('2026-10-09T12:00:00.001Z'), now)).toBe('snoozed');
    expect(effectiveStatus('snoozed', new Date('2026-10-09T12:00:00.000Z'), now)).toBe('open');
    expect(effectiveStatus('snoozed', new Date('2026-10-09T11:00:00.000Z'), now)).toBe('open');
  });

  it('leaves open and closed as they are', () => {
    expect(effectiveStatus('open', null, now)).toBe('open');
    expect(effectiveStatus('closed', null, now)).toBe('closed');
  });

  it('refuses a status the database does not have', () => {
    expect(() => effectiveStatus('archived', null, now)).toThrow(TypeError);
    expect(() => effectiveStatus('snoozed', null, now)).toThrow(TypeError);
  });
});

describe('cursors', () => {
  const position = {
    at: '2026-10-09T09:30:00.123456Z',
    id: '01890a5d-ac96-774b-bcce-b302099a8057',
  };

  it('round-trips a position, keeping microseconds', () => {
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(decodeCursor(cursor)).toEqual(position);
  });

  it('gives nothing for text that is not a cursor', () => {
    const encode = (text: string) => Buffer.from(text).toString('base64url');
    expect(decodeCursor('')).toBeUndefined();
    expect(decodeCursor('not a cursor')).toBeUndefined();
    expect(decodeCursor(encode('2026-10-09T09:30:00.123456Z'))).toBeUndefined();
    expect(decodeCursor(encode(`yesterday|${position.id}`))).toBeUndefined();
    expect(decodeCursor(encode(`${position.at}|not-an-id`))).toBeUndefined();
    expect(decodeCursor(encode(`${position.at}|${position.id}|more`))).toBeUndefined();
    // SQL in either part never reaches a query.
    expect(
      decodeCursor(encode(`${position.at}'; drop table x; --|${position.id}`)),
    ).toBeUndefined();
  });

  it('refuses to encode a position it could not read back', () => {
    expect(() => encodeCursor({ at: 'now', id: position.id })).toThrow(TypeError);
  });
});

describe('previews', () => {
  it('puts the text on one line', () => {
    expect(previewOf('  Hi there,\r\n\r\n\tIs June 13\u00a0still open?  ', 160)).toBe(
      'Hi there, Is June 13 still open?',
    );
  });

  it('removes control characters', () => {
    expect(previewOf('one\u0000two\u0007three\u200b', 160)).toBe('one two three');
  });

  it('never returns more than the bound, and marks a cut', () => {
    const cut = previewOf('x'.repeat(500), 160);
    expect(cut).toHaveLength(160);
    expect(cut.endsWith('…')).toBe(true);
    expect(previewOf('x'.repeat(160), 160)).toBe('x'.repeat(160));
  });

  it('never cuts a character in half', () => {
    const cut = previewOf('😀'.repeat(200), 11);
    expect(cut.length).toBeLessThanOrEqual(11);
    expect(cut).toBe(`${'😀'.repeat(5)}…`);
  });

  it('is empty for text with nothing to show', () => {
    expect(previewOf(' \n\t ', 160)).toBe('');
  });
});

describe('who a reply may be sent from and to', () => {
  const facts: ReplyFacts = {
    channel: 'email',
    smsAvailable: false,
    account: { channel: 'email', status: 'active', forConversations: true, smsReady: false },
    recipient: { kind: 'email', contactId: 'contact-1' },
    contactId: 'contact-1',
    textLength: 20_000,
    smsTextLimit: 1600,
    webchatTextLimit: 2000,
    webchat: undefined,
  };
  const number = { channel: 'sms', status: 'active', forConversations: false, smsReady: true };
  const widget = { channel: 'webchat', status: 'active', forConversations: false, smsReady: false };
  const chat: ReplyFacts = {
    ...facts,
    channel: 'webchat',
    account: widget,
    // A web chat reply has no address: it goes to the visitor in the chat.
    recipient: undefined,
    textLength: 2000,
    webchat: { widgetChosen: true, silence: undefined },
  };
  const text: ReplyFacts = {
    ...facts,
    channel: 'sms',
    smsAvailable: true,
    account: number,
    recipient: { kind: 'phone', contactId: 'contact-1' },
    textLength: 1600,
  };

  it('allows an active conversation mailbox and an address of the contact', () => {
    expect(replyRefusal(facts)).toBeUndefined();
  });

  it('allows a connected number and a phone number of the contact', () => {
    expect(replyRefusal(text)).toBeUndefined();
  });

  it("allows a web chat reply through the visitor's own widget while their chat is open", () => {
    expect(replyRefusal(chat)).toBeUndefined();
    // Whether this install can send text messages has nothing to do with it.
    expect(replyRefusal({ ...chat, smsAvailable: true })).toBeUndefined();
  });

  it('refuses a web chat reply where nobody wrote through web chat', () => {
    expect(replyRefusal({ ...chat, webchat: undefined })).toMatchObject({
      path: '/channel',
      code: 'channel_unavailable',
    });
  });

  it('refuses a web chat reply through anything but the widget the visitor wrote through', () => {
    const mismatch = { path: '/accountId', code: 'account_channel_mismatch' };
    expect(
      replyRefusal({ ...chat, webchat: { widgetChosen: false, silence: undefined } }),
    ).toMatchObject(mismatch);
    expect(replyRefusal({ ...chat, account: facts.account })).toMatchObject(mismatch);
    expect(replyRefusal({ ...chat, account: number })).toMatchObject(mismatch);
    expect(replyRefusal({ ...chat, account: undefined })).toMatchObject(mismatch);
  });

  it('refuses a web chat reply while the widget is off, and once the visitor has left', () => {
    const off = { path: '/accountId', code: 'account_unavailable' };
    expect(replyRefusal({ ...chat, account: { ...widget, status: 'paused' } })).toMatchObject(off);
    expect(
      replyRefusal({ ...chat, webchat: { widgetChosen: true, silence: 'widget_off' } }),
    ).toMatchObject(off);
    expect(
      replyRefusal({ ...chat, webchat: { widgetChosen: true, silence: 'visitor_left' } }),
    ).toMatchObject({ path: '/channel', code: 'visitor_left' });
  });

  it('refuses a web chat reply longer than the widget shows', () => {
    expect(replyRefusal({ ...chat, textLength: 2001 })).toMatchObject({
      path: '/text',
      code: 'text_too_long',
      message: 'A chat message can hold 2000 characters at most.',
    });
  });

  it('refuses a number that is not registered for text messages or whose provider is not connected', () => {
    expect(replyRefusal({ ...text, account: { ...number, smsReady: false } })).toMatchObject({
      path: '/accountId',
      code: 'account_unavailable',
    });
  });

  it('refuses a text message longer than one can be, and leaves email its own bound', () => {
    expect(replyRefusal({ ...text, textLength: 1601 })).toMatchObject({
      path: '/text',
      code: 'text_too_long',
      message: 'A text message can hold 1600 characters at most.',
    });
    expect(replyRefusal({ ...facts, textLength: 100_000 })).toBeUndefined();
  });

  it('refuses text messages until an account can send them', () => {
    expect(replyRefusal({ ...text, smsAvailable: false })).toMatchObject({
      path: '/channel',
      code: 'channel_unavailable',
    });
  });

  it('refuses an account of another channel, and one it cannot see, the same way', () => {
    const mismatch = { path: '/accountId', code: 'account_channel_mismatch' };
    expect(replyRefusal({ ...facts, account: number })).toMatchObject(mismatch);
    expect(replyRefusal({ ...text, account: facts.account })).toMatchObject(mismatch);
    expect(replyRefusal({ ...facts, account: undefined })).toMatchObject(mismatch);
  });

  it('refuses an account that is not active', () => {
    for (const status of ['paused', 'failing', 'disconnected'])
      expect(
        replyRefusal({
          ...facts,
          account: { ...number, channel: 'email', forConversations: true, status },
        }),
        status,
      ).toMatchObject({ path: '/accountId', code: 'account_unavailable' });
  });

  it('refuses a mailbox that is not used for conversations', () => {
    expect(
      replyRefusal({
        ...facts,
        account: { channel: 'email', status: 'active', forConversations: false, smsReady: false },
      }),
    ).toMatchObject({ path: '/accountId', code: 'account_not_for_conversations' });
  });

  it('refuses an address of another contact, and one it cannot see, the same way', () => {
    const elsewhere = { path: '/to', code: 'recipient_not_in_conversation' };
    expect(
      replyRefusal({ ...facts, recipient: { kind: 'email', contactId: 'contact-2' } }),
    ).toMatchObject(elsewhere);
    expect(replyRefusal({ ...facts, recipient: undefined })).toMatchObject(elsewhere);
  });

  it("refuses the contact's phone number for an email, and an address for a text", () => {
    expect(
      replyRefusal({ ...facts, recipient: { kind: 'phone', contactId: 'contact-1' } }),
    ).toMatchObject({ path: '/to', code: 'recipient_channel_mismatch' });
    expect(
      replyRefusal({ ...text, recipient: { kind: 'email', contactId: 'contact-1' } }),
    ).toMatchObject({ path: '/to', code: 'recipient_channel_mismatch' });
  });
});

describe('reasons in plain words', () => {
  it('explains why a message failed', () => {
    expect(problemReason('failed', 'consent_required', null)).toEqual({
      code: 'consent_required',
      message: "Not sent: this contact hasn't agreed to receive messages on this channel.",
    });
    expect(problemReason('failed', 'suppressed', 'hard_bounce')).toEqual({
      code: 'suppressed',
      message: 'Not sent: an earlier message to this address bounced, so it is blocked.',
    });
    // Do not disturb for one channel is the same code as do not contact, in its own words.
    expect(problemReason('failed', 'do_not_contact', null)).toEqual({
      code: 'do_not_contact',
      message: 'Not sent: this contact is marked do not contact.',
    });
    expect(problemReason('failed', 'do_not_contact', 'channel')).toEqual({
      code: 'do_not_contact',
      message: 'Not sent: do not disturb is on for this channel for this contact.',
    });
    expect(problemReason('failed', 'do_not_contact', 'something else')?.message).toBe(
      'Not sent: this contact is marked do not contact.',
    );
    expect(problemReason('bounced', 'hard_bounce', null)?.message).toMatch(/does not exist/);
    expect(problemReason('unknown', 'delivery_unknown', null)?.message).toMatch(
      /could not confirm/,
    );
  });

  it('has words for every reason the pipeline records', () => {
    // A reason this version doesn't know is answered with the status's general code.
    const generic = problemReason('failed', 'something_new', null);
    expect(generic).toEqual({ code: 'failed', message: 'This message was not sent.' });
    expect(problemReason('bounced', 'something_new', null)?.code).toBe('bounced');
    expect(problemReason('unknown', 'something_new', null)?.code).toBe('delivery_unknown');
    for (const code of [
      'contact_inactive',
      'sender_inactive',
      'do_not_contact',
      'consent_withdrawn',
      'consent_required',
      'timing_unknown',
      'recipient_changed',
      'delivery_rejected',
      'unsupported_channel',
      'unsubscribe_unavailable',
      'mailbox_unavailable',
      'mailbox_use_disabled',
      'status_callback_unavailable',
      'sms_body_too_long',
      'sms_number_unavailable',
      'sms_connection_unavailable',
      'provider_failed',
    ])
      expect(problemReason('failed', code, null)?.message, code).not.toBe(generic?.message);
    for (const detail of ['hard_bounce', 'complaint', 'unsubscribe', 'invalid', 'manual'])
      expect(problemReason('failed', 'suppressed', detail)?.message, detail).not.toBe(
        problemReason('failed', 'suppressed', null)?.message,
      );
  });

  it("answers a provider's own error number with one reason, never the number", () => {
    expect(problemReason('failed', 'twilio_30003', 'undelivered')).toEqual({
      code: 'provider_failed',
      message: 'Not delivered: the text message provider could not deliver it.',
    });
    expect(problemReason('failed', 'provider_failed', 'failed')?.code).toBe('provider_failed');
    expect(problemCodes).not.toContain('twilio_30003');
  });

  it('never repeats stored detail it does not know', () => {
    expect(problemReason('failed', 'suppressed', 'someone@example.com')?.message).not.toContain(
      'example.com',
    );
  });

  it('gives a reason even when none was recorded', () => {
    expect(problemReason('failed', null, null)).toEqual({
      code: 'failed',
      message: 'This message was not sent.',
    });
    expect(problemReason('bounced', null, null)?.code).toBe('bounced');
    expect(problemReason('unknown', null, null)?.code).toBe('delivery_unknown');
  });

  it('has no problem for a message that is fine', () => {
    for (const status of ['received', 'queued', 'sending', 'sent', 'delivered', 'read', 'note'])
      expect(problemReason(status, 'quiet_hours', null), status).toBeNull();
  });

  it('explains why a queued message is waiting', () => {
    expect(heldReason('queued', 'quiet_hours')).toEqual({
      code: 'quiet_hours',
      message: 'Waiting: it is quiet hours where this contact is. It will be sent when they end.',
    });
    for (const code of [
      'frequency_cap',
      'mailbox_daily_limit',
      'mailbox_warmup_limit',
      'mailbox_pacing',
      'provider_temporary',
    ])
      expect(heldReason('queued', code)?.message, code).toMatch(/^Waiting: /);
    expect(heldReason('queued', 'something_new')).toEqual({
      code: 'waiting',
      message: 'Waiting to be sent.',
    });
  });

  it('lists every code it can give, each once', () => {
    for (const status of ['failed', 'bounced', 'unknown'])
      for (const code of [...problemCodes, 'something_new', null])
        expect(problemCodes).toContain(problemReason(status, code, null)?.code);
    for (const code of [...holdCodes, 'something_new'])
      expect(holdCodes).toContain(heldReason('queued', code)?.code);
    expect(new Set(problemCodes).size).toBe(problemCodes.length);
    expect(new Set(holdCodes).size).toBe(holdCodes.length);
  });

  it('holds nothing that is not queued, or queued with no reason', () => {
    expect(heldReason('queued', null)).toBeNull();
    expect(heldReason('failed', 'quiet_hours')).toBeNull();
    expect(heldReason('sent', 'quiet_hours')).toBeNull();
  });
});

describe('message text', () => {
  it('returns short text as it is', () => {
    expect(boundText('Hello\nthere', 100)).toEqual({ text: 'Hello\nthere', truncated: false });
  });

  it('cuts long text at the bound and says so', () => {
    expect(boundText('x'.repeat(12), 10)).toEqual({ text: 'x'.repeat(10), truncated: true });
  });

  it('never cuts a character in half, and never goes over the bound', () => {
    const cut = boundText('😀'.repeat(6), 5);
    expect(cut).toEqual({ text: '😀😀', truncated: true });
  });
});

describe('the subject a reply starts with', () => {
  it('answers the last email', () => {
    expect(replySubject('Your June date')).toBe('Re: Your June date');
  });

  it('does not stack prefixes', () => {
    expect(replySubject('Re: Your June date')).toBe('Re: Your June date');
    expect(replySubject('RE:Your June date')).toBe('RE:Your June date');
  });

  it('has nothing to suggest without a subject', () => {
    expect(replySubject(null)).toBeNull();
    expect(replySubject('  ')).toBeNull();
  });

  it('stays on one line and within what a subject may hold', () => {
    expect(replySubject('Hello\r\nBcc: someone@example.com')).toBe(
      'Re: Hello Bcc: someone@example.com',
    );
    expect(replySubject('x'.repeat(2000))).toHaveLength(998);
  });
});

describe('the channel a reply starts on', () => {
  const offered = (email: boolean, sms: boolean, webchat: boolean) => [
    { channel: 'email' as const, available: email },
    { channel: 'sms' as const, available: sms },
    { channel: 'webchat' as const, available: webchat },
  ];

  it('is the channel the contact last wrote on, when a reply can go that way', () => {
    expect(suggestedChannel('email', offered(true, true, true))).toBe('email');
    expect(suggestedChannel('sms', offered(true, true, true))).toBe('sms');
    expect(suggestedChannel('webchat', offered(true, true, true))).toBe('webchat');
  });

  it('falls back to the first channel that can send, in the order they are offered', () => {
    // They wrote by text, and no number can send now.
    expect(suggestedChannel('sms', offered(true, false, true))).toBe('email');
    // The visitor left the chat.
    expect(suggestedChannel('webchat', offered(false, true, false))).toBe('sms');
    expect(suggestedChannel('email', offered(false, false, true))).toBe('webchat');
  });

  it('is the first channel that can send when the contact never wrote', () => {
    expect(suggestedChannel(null, offered(true, true, true))).toBe('email');
    expect(suggestedChannel(null, offered(false, true, true))).toBe('sms');
  });

  it('is not a channel the contact wrote on that nothing is ever sent on', () => {
    expect(suggestedChannel('note', offered(true, true, true))).toBe('email');
    expect(suggestedChannel('carrier-pigeon', offered(false, true, true))).toBe('sms');
  });

  it('is not a channel the composer does not offer at all', () => {
    expect(suggestedChannel('webchat', [{ channel: 'email', available: true }])).toBe('email');
  });

  it('is nothing when no channel can send', () => {
    expect(suggestedChannel('email', offered(false, false, false))).toBeNull();
    expect(suggestedChannel(null, [])).toBeNull();
  });
});
