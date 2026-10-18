import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import type { OutboundDelivery } from './outbound.js';
import {
  evaluateSmsAdmission,
  routeOutboundByChannel,
  SMS_BODY_MAX,
  type OutboundChannel,
  type SmsAdmissionFacts,
} from './sms-send.js';

const ready: SmsAdmissionFacts = {
  channel: 'sms',
  callbackAvailable: true,
  bodyLength: 20,
  number: { capabilities: ['sms', 'voice'], connectionStatus: 'connected' },
};

describe('SMS admission', () => {
  it('allows a message a connected SMS number can send', () => {
    expect(evaluateSmsAdmission(ready)).toBeNull();
    expect(evaluateSmsAdmission({ ...ready, bodyLength: SMS_BODY_MAX })).toBeNull();
  });

  it.each([
    [{ channel: 'email' }, 'unsupported_channel'],
    [{ callbackAvailable: false }, 'status_callback_unavailable'],
    [{ bodyLength: SMS_BODY_MAX + 1 }, 'sms_body_too_long'],
    [{ number: null }, 'sms_number_unavailable'],
    [
      { number: { capabilities: ['voice'], connectionStatus: 'connected' } },
      'sms_number_unavailable',
    ],
    [
      { number: { capabilities: ['sms'], connectionStatus: 'failing' } },
      'sms_connection_unavailable',
    ],
    [
      { number: { capabilities: ['sms'], connectionStatus: 'disconnected' } },
      'sms_connection_unavailable',
    ],
  ] as const)('refuses %j as %s', (change, reason) => {
    expect(evaluateSmsAdmission({ ...ready, ...change })).toBe(reason);
  });

  it('counts 1,600 as the limit Twilio documents', () => {
    expect(SMS_BODY_MAX).toBe(1600);
  });
});

describe('routing the one dispatch task by channel', () => {
  const context: TenantContext = {
    agencyId: '0198a5d0-0000-7000-8000-00000000000a',
    businessId: '0198a5d0-0000-7000-8000-00000000000b',
    actorKind: 'system',
    correlationId: '0198a5d0-0000-7000-8000-00000000000c',
  };
  const message = (channel: 'email' | 'sms'): OutboundDelivery => ({
    messageId: '0198a5d0-0000-7000-8000-000000000001',
    accountId: '0198a5d0-0000-7000-8000-000000000002',
    channel,
    purpose: 'transactional',
    to: channel === 'sms' ? '+15558675310' : 'person@example.test',
    subject: null,
    text: 'Hello',
    html: null,
    reply: { inReplyTo: null, references: [] },
    attachments: [],
  });
  const seen: string[] = [];
  const pair = (name: string): OutboundChannel => ({
    admission: (_trx, _context, each) => {
      seen.push(`${name} admits ${each.channel}`);
      return Promise.resolve({ action: 'allow' });
    },
    sender: {
      deliver: (each) => {
        seen.push(`${name} delivers ${each.channel}`);
        return Promise.resolve({ outcome: 'accepted', providerId: name });
      },
    },
  });
  // Admission never touches the transaction in these fakes.
  const noTransaction = {} as unknown as DatabaseTransaction;

  it('gives each message to its own channel and never to the other', async () => {
    seen.length = 0;
    const routed = routeOutboundByChannel({ email: pair('smtp'), sms: pair('twilio') });
    for (const channel of ['email', 'sms'] as const) {
      expect(
        await routed.admission(noTransaction, context, { ...message(channel), lane: 'reply' }),
      ).toEqual({ action: 'allow' });
      await routed.sender.deliver(message(channel), context);
    }
    expect(seen).toEqual([
      'smtp admits email',
      'smtp delivers email',
      'twilio admits sms',
      'twilio delivers sms',
    ]);
  });

  it('refuses a channel that has no sender, before anything is reserved or sent', async () => {
    seen.length = 0;
    const routed = routeOutboundByChannel({ email: pair('smtp') });
    expect(
      await routed.admission(noTransaction, context, { ...message('sms'), lane: 'reply' }),
    ).toEqual({ action: 'refuse', reason: 'unsupported_channel' });
    expect(await routed.sender.deliver(message('sms'), context)).toEqual({ outcome: 'rejected' });
    expect(seen).toEqual([]);
  });
});
