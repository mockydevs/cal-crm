import { describe, expect, it } from 'vitest';

import {
  inboundWebhookUrl,
  isWebhookToken,
  newWebhookToken,
  parseWebhookEndpoint,
  smsDeliveryAvailable,
  smsWebhookOrigin,
  statusCallbackUrl,
  webhookDigest,
  webhookEndpoint,
  webhookUrlOf,
} from './sms-webhook-url.js';

const MESSAGE = '0198a5d0-0000-7000-8000-000000000001';

describe('the public address Twilio is given', () => {
  it.each([
    ['https://crm.example.test', 'https://crm.example.test'],
    ['https://crm.example.test/', 'https://crm.example.test'],
    ['https://crm.example.test:8443/app/', 'https://crm.example.test:8443'],
    ['https://CRM.Example.test', 'https://crm.example.test'],
  ])('reads %s as the origin %s', (publicUrl, origin) => {
    expect(smsWebhookOrigin(publicUrl)).toBe(origin);
  });

  it.each([
    ['plain http', 'http://crm.example.test'],
    ['credentials', 'https://user:pass@crm.example.test'],
    ['a user name', 'https://user@crm.example.test'],
    // Twilio: "URL must contain a valid hostname and underscores are not allowed."
    ['an underscore in the host', 'https://my_crm.example.test'],
    ['no host', 'https://'],
    ['not a URL', 'crm.example.test'],
    ['an empty value', ''],
  ])('refuses %s', (_what, publicUrl) => {
    expect(smsWebhookOrigin(publicUrl)).toBeNull();
  });
});

describe('whether this install can send text messages at all', () => {
  it('can where Twilio has an address to report deliveries to', () => {
    expect(smsDeliveryAvailable('https://crm.example.test')).toBe(true);
    expect(smsDeliveryAvailable('https://crm.example.test:8443/app/')).toBe(true);
  });

  it.each([
    ['plain http', 'http://crm.example.test'],
    ['http on this machine', 'http://localhost:3000'],
    ['credentials', 'https://user:pass@crm.example.test'],
    ['an underscore in the host', 'https://my_crm.example.test'],
    ['not a URL', 'crm.example.test'],
    ['an empty value', ''],
  ])('cannot with %s as the public address', (_what, publicUrl) => {
    expect(smsDeliveryAvailable(publicUrl)).toBe(false);
  });

  it('cannot when the install was given no public address', () => {
    expect(smsDeliveryAvailable(undefined)).toBe(false);
  });

  it('agrees with what a send is refused for: no address, no status callback', () => {
    for (const publicUrl of ['https://crm.example.test', 'http://crm.example.test', ''])
      expect(smsDeliveryAvailable(publicUrl)).toBe(smsWebhookOrigin(publicUrl) !== null);
  });
});

describe('webhook tokens', () => {
  it('are 32 random bytes in base64url, different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newWebhookToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isWebhookToken(token)).toBe(true);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it.each([
    '',
    'short',
    'a'.repeat(42),
    'a'.repeat(44),
    `${'a'.repeat(42)}/`,
    `${'a'.repeat(42)}=`,
  ])('does not take %j for a token', (value) => {
    expect(isWebhookToken(value)).toBe(false);
  });

  it('are stored only as a SHA-256 digest', () => {
    // sha256("abc"), a published test vector (FIPS 180-2).
    expect(webhookDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('the URLs', () => {
  const origin = 'https://crm.example.test';
  const token = 'T'.repeat(43);

  it('name the connection by its token, and a status callback its message', () => {
    expect(statusCallbackUrl(origin, token, MESSAGE)).toBe(
      `https://crm.example.test/webhooks/twilio/${token}/status?m=${MESSAGE}`,
    );
    expect(inboundWebhookUrl(origin, token)).toBe(
      `https://crm.example.test/webhooks/twilio/${token}/inbound`,
    );
  });

  it('are stored without the token, and rebuilt to the same URL', () => {
    const status = webhookEndpoint({ kind: 'status', messageId: MESSAGE });
    expect(status).toBe(`status?m=${MESSAGE}`);
    expect(webhookEndpoint({ kind: 'inbound' })).toBe('inbound');
    expect(status).not.toContain(token);
    const parsed = parseWebhookEndpoint(status);
    expect(parsed).toEqual({ kind: 'status', messageId: MESSAGE });
    expect(parsed && webhookUrlOf(origin, token, parsed)).toBe(
      statusCallbackUrl(origin, token, MESSAGE),
    );
    expect(webhookUrlOf(origin, token, { kind: 'inbound' })).toBe(inboundWebhookUrl(origin, token));
  });

  it.each([
    '',
    'status',
    'status?m=',
    'status?m=not-a-uuid',
    `status?m=${MESSAGE}&x=1`,
    `status?m=${MESSAGE.toUpperCase()}`,
    `inbound?m=${MESSAGE}`,
    'other',
    `/webhooks/twilio/x/status?m=${MESSAGE}`,
  ])('reads no endpoint from %j', (stored) => {
    expect(parseWebhookEndpoint(stored)).toBeNull();
  });

  it('refuse a message id that is not a UUID, so nothing needs escaping', () => {
    expect(() => statusCallbackUrl(origin, token, 'x&y=1')).toThrow();
    expect(() => statusCallbackUrl(origin, 'bad token', MESSAGE)).toThrow();
  });
});
