import { fixtureResolver } from '@repo/mail-checks/testing';
import { describe, expect, it } from 'vitest';

import type { MailboxOutcome, MailboxProvider, VerificationReason } from './provider.js';
import { verifyEmail } from './verify.js';

const zone = fixtureResolver({
  'example.com': { MX: [{ exchange: 'mx.example.com', priority: 10 }] },
  'mailinator.com': { MX: [{ exchange: 'mail.mailinator.com', priority: 10 }] },
  'nullmx.example': { MX: [{ exchange: '.', priority: 0 }] },
  'broken.example': { error: 'ESERVFAIL' },
});

interface FakeProvider extends MailboxProvider {
  readonly asked: string[];
}

function fakeProvider(answer: MailboxOutcome | (() => Promise<MailboxOutcome>)): FakeProvider {
  const asked: string[] = [];
  return {
    name: 'fake',
    asked,
    verify(address) {
      asked.push(address);
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    },
    account: () => Promise.resolve({ kind: 'ok', availableCredits: 1, testMode: true }),
  };
}

const result = (
  status: 'valid' | 'risky' | 'invalid' | 'unknown',
  reasons: readonly VerificationReason[] = [],
): MailboxOutcome => ({
  kind: 'result',
  status,
  reasons,
  raw: { state: status, reason: null },
  charged: status !== 'unknown',
});

describe('verifyEmail with the free checks only', () => {
  it('says valid at domain depth when the domain takes mail', async () => {
    await expect(verifyEmail('Jane@Example.com', { resolve: zone })).resolves.toEqual({
      status: 'valid',
      depth: 'domain',
      reasons: [],
      address: 'Jane@example.com',
    });
  });

  it('says invalid for bad syntax, asking DNS nothing', async () => {
    const resolve = fixtureResolver({});
    await expect(verifyEmail('jane@@example.com', { resolve })).resolves.toEqual({
      status: 'invalid',
      depth: 'domain',
      reasons: ['bad_syntax'],
    });
    expect(resolve.queries).toEqual([]);
  });

  it('says unknown for syntax it does not read', async () => {
    await expect(verifyEmail('"jane doe"@example.com', { resolve: zone })).resolves.toEqual({
      status: 'unknown',
      depth: 'domain',
      reasons: ['unsupported_syntax'],
    });
  });

  it.each([
    ['jane@nowhere.example', 'domain_not_found'],
    ['jane@nullmx.example', 'no_mail_accepted'],
  ])('says %s is invalid: %s', async (address, reason) => {
    await expect(verifyEmail(address, { resolve: zone })).resolves.toMatchObject({
      status: 'invalid',
      depth: 'domain',
      reasons: [reason],
    });
  });

  it('says unknown, never invalid, when DNS fails', async () => {
    await expect(verifyEmail('jane@broken.example', { resolve: zone })).resolves.toMatchObject({
      status: 'unknown',
      reasons: ['dns_unavailable'],
    });
  });

  it('warns of a disposable domain and hints at a role address, neither blocking', async () => {
    await expect(verifyEmail('jane@mailinator.com', { resolve: zone })).resolves.toMatchObject({
      status: 'risky',
      reasons: ['disposable'],
    });
    await expect(verifyEmail('info@example.com', { resolve: zone })).resolves.toMatchObject({
      status: 'valid',
      reasons: ['role'],
    });
  });
});

describe('verifyEmail with a provider', () => {
  it('asks the provider once the free checks pass and answers at mailbox depth', async () => {
    const provider = fakeProvider(result('valid'));
    await expect(verifyEmail('jane@example.com', { resolve: zone, provider })).resolves.toEqual({
      status: 'valid',
      depth: 'mailbox',
      reasons: [],
      address: 'jane@example.com',
      provider: { name: 'fake', outcome: result('valid') },
    });
    expect(provider.asked).toEqual(['jane@example.com']);
  });

  it('spends nothing on an address the free checks already refuse', async () => {
    const provider = fakeProvider(result('valid'));
    await verifyEmail('jane@nullmx.example', { resolve: zone, provider });
    await verifyEmail('not an address', { resolve: zone, provider });
    await verifyEmail('"quoted"@example.com', { resolve: zone, provider });
    expect(provider.asked).toEqual([]);
  });

  it('takes the provider invalid over a domain that takes mail', async () => {
    const provider = fakeProvider(result('invalid', ['mailbox_not_found']));
    await expect(
      verifyEmail('jane@example.com', { resolve: zone, provider }),
    ).resolves.toMatchObject({
      status: 'invalid',
      depth: 'mailbox',
      reasons: ['mailbox_not_found'],
    });
  });

  it('keeps the disposable warning when the provider says deliverable', async () => {
    const provider = fakeProvider(result('valid', ['role']));
    await expect(
      verifyEmail('jane@mailinator.com', { resolve: zone, provider }),
    ).resolves.toMatchObject({
      status: 'risky',
      reasons: ['disposable', 'role'],
    });
  });

  it('lets the provider answer when our own DNS failed, dropping the DNS reason', async () => {
    const provider = fakeProvider(result('valid'));
    await expect(
      verifyEmail('jane@broken.example', { resolve: zone, provider }),
    ).resolves.toMatchObject({
      status: 'valid',
      depth: 'mailbox',
      reasons: [],
    });
  });

  it('says unknown when the provider cannot tell', async () => {
    const provider = fakeProvider(result('unknown', ['mail_server_unavailable']));
    await expect(
      verifyEmail('jane@example.com', { resolve: zone, provider }),
    ).resolves.toMatchObject({
      status: 'unknown',
      depth: 'mailbox',
      reasons: ['mail_server_unavailable'],
    });
  });

  it('says unknown at domain depth when the provider fails, keeping why', async () => {
    const failed: MailboxOutcome = {
      kind: 'failed',
      problem: 'no_credits',
      connectionFailing: true,
    };
    const provider = fakeProvider(failed);
    await expect(verifyEmail('jane@example.com', { resolve: zone, provider })).resolves.toEqual({
      status: 'unknown',
      depth: 'domain',
      reasons: ['provider_error'],
      address: 'jane@example.com',
      provider: { name: 'fake', outcome: failed },
    });
  });

  it('keeps a risky finding of its own when the provider fails', async () => {
    const provider = fakeProvider({ kind: 'failed', problem: 'timeout', connectionFailing: false });
    await expect(
      verifyEmail('jane@mailinator.com', { resolve: zone, provider }),
    ).resolves.toMatchObject({
      status: 'risky',
      reasons: ['disposable', 'provider_error'],
    });
  });

  it('turns a provider that throws into unknown rather than a crash', async () => {
    const provider = fakeProvider(() => Promise.reject(new Error('jane@example.com leaked')));
    const verification = await verifyEmail('jane@example.com', { resolve: zone, provider });
    expect(verification).toMatchObject({
      status: 'unknown',
      reasons: ['provider_error'],
      provider: { outcome: { kind: 'failed', problem: 'unexpected_error' } },
    });
    expect(JSON.stringify(verification.provider)).not.toContain('jane');
  });

  it('passes the caller signal to the provider', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const provider: MailboxProvider = {
      name: 'fake',
      verify(_, call) {
        received = call?.signal;
        return Promise.resolve(result('valid'));
      },
      account: () => Promise.resolve({ kind: 'ok', availableCredits: 1, testMode: true }),
    };
    await verifyEmail('jane@example.com', { resolve: zone, provider, signal: controller.signal });
    expect(received).toBe(controller.signal);
  });
});
