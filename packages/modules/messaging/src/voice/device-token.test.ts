import { webcrypto } from 'node:crypto';
import twilio from 'twilio';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mintVoiceDeviceToken } from './device-token.js';

const config = {
  accountSid: `AC${'1'.repeat(32)}`,
  keySid: `SK${'2'.repeat(32)}`,
  keySecret: 'synthetic-standard-key-secret',
  applicationSid: `AP${'3'.repeat(32)}`,
  keyType: 'standard' as const,
  identity: 'biz_synthetic_user_synthetic',
  incomingAllowed: true,
};
const now = new Date('2026-10-15T10:00:00.000Z');
const part = (token: string, index: number): unknown =>
  JSON.parse(Buffer.from(token.split('.')[index] ?? '', 'base64url').toString('utf8'));
afterEach(() => vi.restoreAllMocks());

describe('short-lived voice device grants', () => {
  it('issues incoming-only browser grants without an unused outgoing application', () => {
    const { applicationSid: _application, ...incoming } = config;
    const sdk = new twilio.jwt.AccessToken(config.accountSid, config.keySid, config.keySecret, {
      identity: config.identity,
    });
    sdk.addGrant(new twilio.jwt.AccessToken.VoiceGrant({ incomingAllow: true }));
    const made = part(mintVoiceDeviceToken(incoming).token, 1);
    expect(made).toMatchObject({
      grants: { identity: config.identity, voice: { incoming: { allow: true } } },
    });
    expect(JSON.stringify(made)).not.toContain('application_sid');
    expect(part(sdk.toJwt(), 1)).toMatchObject({
      grants: { identity: config.identity, voice: { incoming: { allow: true } } },
    });
    expect(() => mintVoiceDeviceToken({ ...incoming, incomingAllowed: false })).toThrow('invalid');
  });
  it('matches the official SDK grant contract and fixed HS256 header', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const made = mintVoiceDeviceToken(config);
    const sdk = new twilio.jwt.AccessToken(config.accountSid, config.keySid, config.keySecret, {
      identity: config.identity,
      ttl: 300,
    });
    sdk.addGrant(
      new twilio.jwt.AccessToken.VoiceGrant({
        outgoingApplicationSid: config.applicationSid,
        incomingAllow: true,
      }),
    );
    expect(part(made.token, 0)).toEqual(part(sdk.toJwt(), 0));
    for (const token of [made.token, sdk.toJwt()]) {
      expect(part(token, 1)).toMatchObject({
        iss: config.keySid,
        sub: config.accountSid,
        iat: now.getTime() / 1000,
        exp: now.getTime() / 1000 + 300,
        grants: {
          identity: config.identity,
          voice: {
            incoming: { allow: true },
            outgoing: { application_sid: config.applicationSid },
          },
        },
      });
    }
    const [header = '', payload = '', signature = ''] = made.token.split('.');
    const key = await webcrypto.subtle.importKey(
      'raw',
      Buffer.from(config.keySecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    expect(
      await webcrypto.subtle.verify(
        'HMAC',
        key,
        Buffer.from(signature, 'base64url'),
        Buffer.from(`${header}.${payload}`),
      ),
    ).toBe(true);
    expect(made.expiresAt).toBe('2026-10-15T10:05:00.000Z');
    expect(made.token).not.toContain(config.keySecret);
  });

  it('creates distinct token IDs and omits inbound permission unless granted', () => {
    const first = mintVoiceDeviceToken({ ...config, incomingAllowed: false });
    const second = mintVoiceDeviceToken({ ...config, incomingAllowed: false });
    expect(first.token).not.toBe(second.token);
    expect(part(first.token, 1)).toMatchObject({
      grants: {
        voice: { outgoing: { application_sid: config.applicationSid } },
      },
    });
    expect(JSON.stringify(part(first.token, 1))).not.toContain('incoming');
  });

  it.each([
    { keyType: 'restricted' },
    { keyType: 'unknown' },
    { keySid: 'invalid' },
    { applicationSid: 'invalid' },
    { accountSid: 'invalid' },
    { identity: 'user@example.test' },
    { keySecret: '' },
    { keySecret: 'secret with spaces' },
    { ttlSeconds: 0 },
    { ttlSeconds: 3601 },
    { ttlSeconds: 60.5 },
  ])('refuses unsupported or invalid configuration without echoing credentials: %j', (change) => {
    expect(() => mintVoiceDeviceToken({ ...config, ...change })).toThrow(
      'Voice device configuration is invalid.',
    );
  });
});
