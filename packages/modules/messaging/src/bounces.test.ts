import { describe, expect, it } from 'vitest';

import {
  bounceOf,
  bounceRate,
  recordBounceCommand,
  type BounceRecipient,
  type BounceReport,
} from './bounces.js';

const group = (patch: Partial<BounceRecipient> = {}): BounceRecipient => ({
  finalRecipient: 'nobody@example.com',
  originalRecipient: null,
  status: '5.1.1',
  bounce: 'hard',
  ...patch,
});
const report = (...recipients: BounceRecipient[]): BounceReport => ({
  originalMessageId: null,
  recipients,
});

describe('what a report says about an address', () => {
  it('is the bounce of the group naming it as final or original recipient', () => {
    expect(bounceOf(report(group()), 'nobody@example.com')).toEqual({
      kind: 'hard',
      status: '5.1.1',
    });
    const forwarded = group({
      finalRecipient: 'elsewhere@example.org',
      originalRecipient: 'nobody@example.com',
      status: '4.4.7',
      bounce: 'soft',
    });
    expect(bounceOf(report(forwarded), 'nobody@example.com')).toEqual({
      kind: 'soft',
      status: '4.4.7',
    });
  });

  it('is nothing when no group names the address', () => {
    expect(bounceOf(report(), 'nobody@example.com')).toBeNull();
    expect(bounceOf(report(group()), 'victim@example.com')).toBeNull();
    const unreadable = group({ finalRecipient: null, originalRecipient: null });
    expect(bounceOf(report(unreadable), 'nobody@example.com')).toBeNull();
  });

  it('is nothing when the group is not a bounce', () => {
    const delayed = group({ status: '4.0.0', bounce: null });
    expect(bounceOf(report(delayed), 'nobody@example.com')).toBeNull();
  });

  it('ignores groups about other addresses', () => {
    const other = group({ finalRecipient: 'other@example.com', status: '4.2.2', bounce: 'soft' });
    expect(bounceOf(report(other, group()), 'nobody@example.com')).toEqual({
      kind: 'hard',
      status: '5.1.1',
    });
  });

  it('is nothing when groups about the address disagree, in either order', () => {
    const soft = group({ status: '5.2.2', bounce: 'soft' });
    const delivered = group({ status: '2.0.0', bounce: null });
    for (const groups of [
      [group(), soft],
      [soft, group()],
      [group(), delivered],
      [delivered, group()],
    ])
      expect(bounceOf(report(...groups), 'nobody@example.com')).toBeNull();
    // Agreeing groups are one answer.
    expect(bounceOf(report(group(), group({ status: '5.1.2' })), 'nobody@example.com')).toEqual({
      kind: 'hard',
      status: '5.1.1',
    });
  });
});

describe('the bounce rate', () => {
  it('is the share of attempted messages that bounced', () => {
    expect(bounceRate(200, 3)).toBe(0.015);
    expect(bounceRate(4, 4)).toBe(1);
    expect(bounceRate(5, 0)).toBe(0);
  });

  it('is unknown, not zero, when nothing was attempted', () => {
    expect(bounceRate(0, 0)).toBeNull();
  });
});

describe('the command input', () => {
  // What @repo/mail's parseDeliveryReport returns, with the fields this module doesn't use.
  const parsed = {
    reportingMta: { type: 'dns', name: 'mx.example.test' },
    originalMessageId: null,
    recipients: [
      {
        finalRecipient: 'nobody@example.com',
        originalRecipient: null,
        action: 'failed',
        reportedStatus: '5.0.0',
        status: '5.1.1',
        bounce: 'hard',
      },
    ],
  } as const;
  const mailboxId = '0199c0de-0000-7000-8000-000000000001';

  it("takes the mail adapter's parsed report as it is when called from the inbound batch", () => {
    // Typed as the handler's own input: the inbound hook passes the parsed report unchanged.
    const input: Parameters<typeof recordBounceCommand.handle>[1] = { mailboxId, report: parsed };
    expect(bounceOf(input.report, 'nobody@example.com')).toEqual({ kind: 'hard', status: '5.1.1' });
  });

  it('refuses a malformed status or an oversized report at the command boundary', () => {
    const accepts = (recipients: readonly unknown[]) =>
      recordBounceCommand.input.safeParse({
        mailboxId,
        report: { originalMessageId: null, recipients },
      }).success;
    const one = { finalRecipient: null, originalRecipient: null, status: '5.1.1', bounce: null };
    expect(accepts([one])).toBe(true);
    for (const status of ['5.1', '3.1.1', '5.01.1', '5.1.1 x'])
      expect(accepts([{ ...one, status }])).toBe(false);
    expect(accepts(Array.from({ length: 100 }, () => one))).toBe(true);
    expect(accepts(Array.from({ length: 101 }, () => one))).toBe(false);
  });
});
