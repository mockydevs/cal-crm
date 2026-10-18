// The reasons the rules can give are exactly the ones the contract lists, so a new reason
// can't reach the API, or the dashboard's wording, without being added to both.
import {
  composerUnavailableCodes,
  messageHoldCodes,
  messageProblemCodes,
  replyRefusalCodes,
} from '@repo/contracts';
import { expect, it } from 'vitest';

import { holdCodes, problemCodes, replyRefusal, type ReplyFacts } from './inbox-rules.js';

it('gives a failed, bounced or unknown message only a documented reason', () => {
  expect([...problemCodes].sort()).toEqual([...messageProblemCodes].sort());
});

it('gives a waiting message only a documented reason', () => {
  expect([...holdCodes].sort()).toEqual([...messageHoldCodes].sort());
});

it('refuses a reply only with a documented code', () => {
  const ok: ReplyFacts = {
    channel: 'email',
    smsAvailable: true,
    account: { channel: 'email', status: 'active', forConversations: true, smsReady: true },
    recipient: { kind: 'email', contactId: 'c' },
    contactId: 'c',
    textLength: 10,
    smsTextLimit: 1600,
    webchatTextLimit: 2000,
    webchat: undefined,
  };
  const widget = { channel: 'webchat', status: 'active', forConversations: false, smsReady: false };
  const chat = {
    ...ok,
    channel: 'webchat' as const,
    account: widget,
    recipient: undefined,
    webchat: { widgetChosen: true, silence: undefined },
  };
  const number = { channel: 'sms', status: 'active', forConversations: false, smsReady: true };
  const given = [
    { ...ok, channel: 'sms' as const, smsAvailable: false },
    { ...ok, account: undefined },
    { ...ok, account: { ...number, channel: 'email', status: 'paused' } },
    { ...ok, account: { ...number, channel: 'email' } },
    { ...ok, recipient: undefined },
    { ...ok, recipient: { kind: 'phone', contactId: 'c' } },
    {
      ...ok,
      channel: 'sms' as const,
      account: number,
      recipient: { kind: 'phone', contactId: 'c' },
      textLength: 1601,
    },
    { ...chat, webchat: { widgetChosen: true, silence: 'visitor_left' as const } },
    { ...chat, webchat: { widgetChosen: true, silence: undefined, doNotDisturb: 'all' as const } },
  ].map((facts) => replyRefusal(facts)?.code);
  expect(given).toEqual([
    'channel_unavailable',
    'account_channel_mismatch',
    'account_unavailable',
    'account_not_for_conversations',
    'recipient_not_in_conversation',
    'recipient_channel_mismatch',
    'text_too_long',
    'visitor_left',
    'do_not_contact',
  ]);
  for (const code of given) expect(replyRefusalCodes).toContain(code);
  // Web chat's other refusals reuse the codes above.
  expect(
    [
      { ...chat, webchat: undefined },
      { ...chat, webchat: { widgetChosen: false, silence: undefined } },
      { ...chat, webchat: { widgetChosen: true, silence: 'widget_off' as const } },
      { ...chat, textLength: 2001 },
    ].map((facts) => replyRefusal(facts)?.code),
  ).toEqual([
    'channel_unavailable',
    'account_channel_mismatch',
    'account_unavailable',
    'text_too_long',
  ]);
  // The four the command and the schema add themselves.
  expect(replyRefusalCodes).toContain('contact_inactive');
  expect(replyRefusalCodes).toContain('subject_not_supported');
  expect(replyRefusalCodes).toContain('recipient_required');
  expect(replyRefusalCodes).toContain('recipient_not_supported');
  expect(replyRefusalCodes).toHaveLength(given.length + 4);
  expect(composerUnavailableCodes).toEqual([
    'channel_unavailable',
    'contact_inactive',
    'no_account',
    'no_recipient',
    'visitor_left',
    'do_not_contact',
  ]);
});
