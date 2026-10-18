// "Statuses update messages in order": Twilio does not promise the order of its status
// callbacks, so a message only ever moves forward, whatever order they arrive in.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  advanceStatus,
  isTwilioStatus,
  messageStatusOf,
  statusRank,
  TWILIO_STATUSES,
  type SmsDeliveryStatus,
  type TwilioStatus,
} from './twilio-status.js';

const spec: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/twilio/spec-excerpt.json', import.meta.url), 'utf8'),
);
const specStatuses = (): string[] => {
  if (typeof spec !== 'object' || spec === null || !('message_enum_status' in spec)) return [];
  const { message_enum_status: list } = spec;
  return Array.isArray(list) ? list.filter((each): each is string => typeof each === 'string') : [];
};

it("knows every status in Twilio's OpenAPI enum, and no other", () => {
  expect(specStatuses().length).toBe(13);
  expect([...TWILIO_STATUSES].sort()).toEqual(specStatuses().sort());
  for (const status of specStatuses()) expect(isTwilioStatus(status)).toBe(true);
  expect(isTwilioStatus('Delivered')).toBe(false);
  expect(isTwilioStatus('rejected')).toBe(false);
  expect(isTwilioStatus('')).toBe(false);
});

it('ranks statuses in the order a message passes through them', () => {
  expect(
    (['queued', 'sending', 'sent', 'delivered', 'read'] as const).map((each) => statusRank(each)),
  ).toEqual([1, 2, 3, 4, 5]);
  for (const first of ['accepted', 'scheduled'] as const) expect(statusRank(first)).toBe(1);
  for (const final of ['undelivered', 'failed', 'canceled', 'rejected'] as const)
    expect(statusRank(final)).toBe(4);
  expect(statusRank('partially_delivered')).toBe(3);
  // Inbound-only statuses never describe one of our sends.
  expect(statusRank('receiving')).toBe(0);
  expect(statusRank('received')).toBe(0);
});

it('maps each provider status to the message status the inbox shows', () => {
  const all = [
    'accepted',
    'scheduled',
    'queued',
    'sending',
    'sent',
    'partially_delivered',
    'delivered',
    'undelivered',
    'failed',
    'canceled',
    'rejected',
    'read',
  ] as const;
  expect(Object.fromEntries(all.map((each) => [each, messageStatusOf(each)]))).toEqual({
    accepted: 'sent',
    scheduled: 'sent',
    queued: 'sent',
    sending: 'sent',
    sent: 'sent',
    partially_delivered: 'sent',
    delivered: 'delivered',
    undelivered: 'failed',
    failed: 'failed',
    canceled: 'failed',
    rejected: 'failed',
    read: 'read',
  });
  expect(messageStatusOf('received')).toBeNull();
  expect(messageStatusOf('receiving')).toBeNull();
});

describe('advanceStatus', () => {
  it('applies the first status a message gets', () => {
    expect(advanceStatus(null, 'sent')).toBe('advance');
    expect(advanceStatus(null, 'delivered')).toBe('advance');
  });

  it('ignores inbound-only statuses', () => {
    expect(advanceStatus(null, 'received')).toBe('ignore');
    expect(advanceStatus('queued', 'receiving')).toBe('ignore');
  });

  it('never moves a message backwards, and treats a repeat as nothing new', () => {
    expect(advanceStatus('delivered', 'sent')).toBe('ignore');
    expect(advanceStatus('sent', 'queued')).toBe('ignore');
    expect(advanceStatus('sent', 'sent')).toBe('ignore');
    expect(advanceStatus('delivered', 'delivered')).toBe('ignore');
    expect(advanceStatus('failed', 'failed')).toBe('ignore');
    expect(advanceStatus('failed', 'sent')).toBe('ignore');
  });

  it('keeps the first final status when a different final one follows', () => {
    expect(advanceStatus('delivered', 'failed')).toBe('conflict');
    expect(advanceStatus('failed', 'delivered')).toBe('conflict');
    expect(advanceStatus('undelivered', 'delivered')).toBe('conflict');
    expect(advanceStatus('rejected', 'delivered')).toBe('conflict');
  });

  it('lets a read receipt follow delivery, but not a failure', () => {
    expect(advanceStatus('delivered', 'read')).toBe('advance');
    expect(advanceStatus('sent', 'read')).toBe('advance');
    expect(advanceStatus('failed', 'read')).toBe('conflict');
    expect(advanceStatus('read', 'delivered')).toBe('ignore');
    expect(advanceStatus('read', 'failed')).toBe('conflict');
  });

  it('only ever advances to a higher rank, for every ordered pair of statuses', () => {
    const all: SmsDeliveryStatus[] = [...TWILIO_STATUSES, 'rejected'];
    for (const current of all)
      for (const incoming of TWILIO_STATUSES) {
        const decision = advanceStatus(current, incoming);
        if (decision === 'advance')
          expect(statusRank(incoming), `${current} -> ${incoming}`).toBeGreaterThan(
            statusRank(current),
          );
        if (statusRank(incoming) === 0) expect(decision).toBe('ignore');
      }
  });

  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );
  const settle = (order: readonly TwilioStatus[]) => {
    let current: SmsDeliveryStatus | null = null;
    for (const incoming of order)
      if (advanceStatus(current, incoming) === 'advance') current = incoming;
    return current;
  };

  it.each([
    [['queued', 'sending', 'sent', 'delivered'], 'delivered'],
    [['queued', 'sent', 'undelivered'], 'undelivered'],
    [['sending', 'sent', 'failed'], 'failed'],
    [['accepted', 'queued', 'sending', 'sent', 'delivered', 'read'], 'read'],
  ] as const)('ends the same for every arrival order of %j', (sequence, end) => {
    const orders = permutations<TwilioStatus>(sequence);
    expect(orders.length).toBeGreaterThan(5);
    for (const order of orders) expect(settle(order), order.join(' > ')).toBe(end);
    // And with every callback delivered twice.
    for (const order of orders) expect(settle([...order, ...order])).toBe(end);
  });
});
