import { describe, expect, it, vi } from 'vitest';
import { isAllowedVoiceRequest, type VoiceTransport } from './twilio-voice.js';
import { createVoiceSigningKey, revokeVoiceSigningKey } from './voice-signing-key.js';

const accountSid = `AC${'1'.repeat(32)}`;
const keySid = `SK${'2'.repeat(32)}`;
const credentials = {
  accountSid,
  authToken: 'synthetic-token',
  apiKey: { sid: `SK${'3'.repeat(32)}`, secret: 'sms-only-key' },
};
const base = `/2010-04-01/Accounts/${accountSid}/Keys`;
const answer =
  (status = 201, body: unknown = { sid: keySid, secret: 'synthetic-secret' }): VoiceTransport =>
  () =>
    Promise.resolve({ status, body: JSON.stringify(body) });

describe('dedicated Standard voice signing key boundary', () => {
  it('creates a Standard key with account credentials and keeps it on the worker boundary', async () => {
    const transport = vi.fn<VoiceTransport>(answer());
    expect(await createVoiceSigningKey(transport, credentials)).toEqual({
      outcome: 'created',
      key: { sid: keySid, secret: 'synthetic-secret', type: 'standard' },
    });
    expect(transport).toHaveBeenCalledExactlyOnceWith({
      method: 'POST',
      path: `${base}.json`,
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${accountSid}:${credentials.authToken}`).toString('base64')}`,
      },
      body: new URLSearchParams({ FriendlyName: 'CRM browser calling' }).toString(),
    });
  });
  it.each([
    ['POST', `${base}.json`, true],
    ['DELETE', `${base}/${keySid}.json`, true],
    ['GET', `${base}.json`, false],
    ['POST', `${base}/${keySid}.json`, false],
    ['DELETE', `${base}.json`, false],
    ['POST', `${base}.json?KeyType=restricted`, false],
    ['DELETE', `${base}/../${keySid}.json`, false],
  ])('keeps the voice setup allowlist exact: %s %s', (method, path, allowed) => {
    expect(isAllowedVoiceRequest(method, path)).toBe(allowed);
  });
  it.each([401, 403, 422, 429])('does not retry a refused creation HTTP %i', async (status) => {
    const transport = vi.fn<VoiceTransport>(answer(status, { code: 20003, message: 'private' }));
    expect(await createVoiceSigningKey(transport, credentials)).toEqual({
      outcome: 'rejected',
      code: 20003,
    });
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each([
    {},
    { sid: keySid },
    { sid: 'bad', secret: 'secret' },
    { sid: keySid, secret: '' },
    { sid: keySid, secret: 'x'.repeat(513) },
  ])('keeps an unreadable creation unknown: %j', async (body) => {
    expect(await createVoiceSigningKey(answer(201, body), credentials)).toEqual({
      outcome: 'unknown',
    });
  });
  it('does not repeat uncertain creation or expose private provider text', async () => {
    for (const transport of [
      vi.fn<VoiceTransport>().mockRejectedValue(new Error('private')),
      vi.fn<VoiceTransport>(answer(500)),
      vi.fn<VoiceTransport>(answer(302)),
    ]) {
      expect(await createVoiceSigningKey(transport, credentials)).toEqual({ outcome: 'unknown' });
      expect(transport).toHaveBeenCalledOnce();
    }
  });
  it('revokes one named key, treats a missing key as gone and preserves uncertain outcomes', async () => {
    for (const status of [204, 404]) {
      const transport = vi.fn<VoiceTransport>(answer(status));
      expect(await revokeVoiceSigningKey(transport, credentials, keySid)).toEqual({
        outcome: 'revoked',
      });
      expect(transport.mock.calls[0]?.[0]).toMatchObject({
        method: 'DELETE',
        path: `${base}/${keySid}.json`,
      });
    }
    expect(await revokeVoiceSigningKey(answer(503), credentials, keySid)).toEqual({
      outcome: 'unknown',
    });
    expect(await revokeVoiceSigningKey(answer(403, {}), credentials, keySid)).toEqual({
      outcome: 'rejected',
      code: null,
    });
  });
  it('refuses invalid identities before any request', async () => {
    const transport = vi.fn<VoiceTransport>();
    expect(
      await createVoiceSigningKey(transport, { accountSid: 'bad', authToken: 'token' }),
    ).toEqual({ outcome: 'rejected', code: null });
    expect(await createVoiceSigningKey(transport, { accountSid, authToken: '' })).toEqual({
      outcome: 'rejected',
      code: null,
    });
    expect(await revokeVoiceSigningKey(transport, credentials, 'bad')).toEqual({
      outcome: 'rejected',
      code: null,
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
