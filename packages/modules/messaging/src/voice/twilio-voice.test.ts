import { describe, expect, it, vi } from 'vitest';

import type { TwilioCredentials, TwilioRequest, TwilioTransport } from '../twilio-api.js';
import {
  createVoiceCall,
  createVoiceTransport,
  endVoiceCall,
  fetchVoiceCall,
  isAllowedVoiceRequest,
} from './twilio-voice.js';

const accountSid = `AC${'1'.repeat(32)}`;
const callSid = `CA${'2'.repeat(32)}`;
const credentials: TwilioCredentials = { accountSid, authToken: 'synthetic-auth-token' };
const input = {
  to: '+12025550101',
  from: '+12025550102',
  twiml: '<Response><Hangup/></Response>',
  statusCallback: 'https://crm.example.test/webhooks/voice/status',
  timeout: 20,
};
const resource = {
  sid: callSid,
  account_sid: accountSid,
  parent_call_sid: null,
  status: 'queued',
  from: input.from,
  to: input.to,
  duration: null,
};
const answer =
  (status = 201, body: unknown = resource): TwilioTransport =>
  () =>
    Promise.resolve({ status, body: JSON.stringify(body) });

describe('voice request boundary', () => {
  const base = `/2010-04-01/Accounts/${accountSid}/Calls`;
  it.each([
    ['POST', `${base}.json`, true],
    ['GET', `${base}/${callSid}.json`, true],
    ['POST', `${base}/${callSid}.json`, true],
    ['DELETE', `${base}/${callSid}.json`, false],
    ['GET', `${base}.json`, false],
    ['POST', `${base}/../Messages.json`, false],
    ['POST', `${base}.json?extra=1`, false],
    ['POST', `https://evil.test${base}.json`, false],
    ['GET', `${base}/${callSid}/Recordings.json`, false],
  ])('%s %s allowed=%s', (method, path, allowed) => {
    expect(isAllowedVoiceRequest(method, path)).toBe(allowed);
  });

  it('uses only the fixed provider origin and refuses redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(resource));
    const transport = createVoiceTransport({ fetcher });
    await transport({ method: 'GET', path: `${base}/${callSid}.json`, headers: {} });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL(`https://api.twilio.com${base}/${callSid}.json`),
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    await expect(
      transport({ method: 'POST', path: '//evil.test/Calls.json', headers: {} }),
    ).rejects.toThrow('not allowed');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('bounds the response stream', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('too many bytes'));
    const transport = createVoiceTransport({ fetcher, maxResponseBytes: 4 });
    await expect(
      transport({ method: 'GET', path: `${base}/${callSid}.json`, headers: {} }),
    ).rejects.toThrow('too large');
  });

  it('supports an empty response body without leaking provider text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const transport = createVoiceTransport({ fetcher });
    expect(
      await transport({ method: 'GET', path: `${base}/${callSid}.json`, headers: {} }),
    ).toEqual({ status: 204, body: '' });
  });
});

describe('voice calls using synthetic transport only', () => {
  it('refuses inline TwiML beyond the documented 4000-character limit before sending', async () => {
    const transport = vi.fn<TwilioTransport>(answer());
    const prefix = '<Response><Say>';
    const suffix = '</Say></Response>';
    const twiml = prefix + 'a'.repeat(4000 - prefix.length - suffix.length) + suffix;
    expect(await createVoiceCall(transport, credentials, { ...input, twiml })).toMatchObject({
      outcome: 'accepted',
    });
    transport.mockClear();
    expect(await createVoiceCall(transport, credentials, { ...input, twiml: twiml + ' ' })).toEqual(
      {
        outcome: 'rejected',
        httpStatus: 0,
        code: null,
      },
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('accepts documented nullable endpoints when reconciling a call', async () => {
    expect(
      await fetchVoiceCall(
        answer(200, { ...resource, from: null, to: null }),
        credentials,
        callSid,
      ),
    ).toMatchObject({ outcome: 'accepted', call: { from: null, to: null } });
  });

  it('creates exactly one call with the documented form fields', async () => {
    const requests: TwilioRequest[] = [];
    const transport: TwilioTransport = (request) => {
      requests.push(request);
      return Promise.resolve({ status: 201, body: JSON.stringify(resource) });
    };
    expect(await createVoiceCall(transport, credentials, input)).toMatchObject({
      outcome: 'accepted',
      call: { sid: callSid, accountSid, status: 'queued', durationSeconds: null },
    });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toMatchObject({
      method: 'POST',
      path: `/2010-04-01/Accounts/${accountSid}/Calls.json`,
    });
    const form = new URLSearchParams(request?.body);
    expect(form.get('To')).toBe(input.to);
    expect(form.get('From')).toBe(input.from);
    expect(form.get('Twiml')).toBe(input.twiml);
    expect(form.get('Timeout')).toBe('20');
    expect(form.get('StatusCallbackMethod')).toBe('POST');
    expect(form.getAll('StatusCallbackEvent')).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ]);
    expect(request?.headers['authorization']).toBe(
      `Basic ${Buffer.from(`${accountSid}:${credentials.authToken}`).toString('base64')}`,
    );
  });

  it('uses an API key when supplied while preserving the account path', async () => {
    const apiKey = { sid: `SK${'3'.repeat(32)}`, secret: 'synthetic-key-secret' };
    const transport = vi.fn<TwilioTransport>(answer());
    await createVoiceCall(transport, { ...credentials, apiKey }, input);
    expect(transport.mock.calls[0]?.[0].headers['authorization']).toBe(
      `Basic ${Buffer.from(`${apiKey.sid}:${apiKey.secret}`).toString('base64')}`,
    );
  });

  it('rings a browser by its client identifier, from a business number', async () => {
    const transport = vi.fn<TwilioTransport>(answer(201));
    await createVoiceCall(transport, credentials, { ...input, to: 'client:b0123_u4567' });
    expect(new URLSearchParams(transport.mock.calls[0]?.[0].body).get('To')).toBe(
      'client:b0123_u4567',
    );
  });

  it.each([
    { to: 'invalid' },
    { to: 'client:' },
    { to: 'client:has space' },
    { to: 'client:dash-not-allowed' },
    { from: 'client:untrusted' },
    { twiml: '' },
    { statusCallback: 'http://crm.example.test/status' },
    { statusCallback: 'https://user:secret@crm.example.test/status' },
    { statusCallback: 'https://bad_host.test/status' },
    { statusCallback: 'https://crm.example.test/status#fragment' },
    { timeout: 0 },
    { timeout: 601 },
    { timeout: 1.5 },
  ])('refuses invalid input before any provider request: %j', async (change) => {
    const transport = vi.fn<TwilioTransport>(answer());
    expect(await createVoiceCall(transport, credentials, { ...input, ...change })).toEqual({
      outcome: 'rejected',
      httpStatus: 0,
      code: null,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses malformed account identifiers before transport', async () => {
    const transport = vi.fn<TwilioTransport>(answer());
    expect(
      await createVoiceCall(transport, { ...credentials, accountSid: '../foreign' }, input),
    ).toMatchObject({ outcome: 'rejected', httpStatus: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 429])('reports HTTP %i refusal without retry', async (status) => {
    const transport = vi.fn<TwilioTransport>(
      answer(status, { code: 21211, message: 'private provider detail' }),
    );
    const result = await createVoiceCall(transport, credentials, input);
    expect(result).toEqual({ outcome: 'rejected', httpStatus: status, code: 21211 });
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([302, 500, 503])(
    'treats HTTP %i as unknown and never repeats a potentially placed call',
    async (status) => {
      const transport = vi.fn<TwilioTransport>(answer(status));
      expect(await createVoiceCall(transport, credentials, input)).toMatchObject({
        outcome: 'unknown',
      });
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it('does not repeat a timed-out call', async () => {
    const transport = vi
      .fn<TwilioTransport>()
      .mockRejectedValue(new Error('secret-network-detail'));
    expect(await createVoiceCall(transport, credentials, input)).toEqual({
      outcome: 'unknown',
      reason: 'no_response',
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    { ...resource, account_sid: `AC${'9'.repeat(32)}` },
    { ...resource, sid: 'invalid' },
    { ...resource, status: 'invented' },
    { ...resource, duration: '-1' },
    { ...resource, parent_call_sid: 'foreign' },
    null,
  ])('treats malformed or foreign-account success as unknown', async (body) => {
    expect(await createVoiceCall(answer(201, body), credentials, input)).toEqual({
      outcome: 'unknown',
      reason: 'unreadable',
    });
  });

  it('handles unreadable JSON', async () => {
    const transport: TwilioTransport = () => Promise.resolve({ status: 201, body: '{not json' });
    expect(await createVoiceCall(transport, credentials, input)).toMatchObject({
      outcome: 'unknown',
      reason: 'unreadable',
    });
  });

  it('fetches and reconciles a specific call with final duration', async () => {
    const transport = vi.fn<TwilioTransport>(
      answer(200, { ...resource, status: 'completed', duration: '42' }),
    );
    expect(await fetchVoiceCall(transport, credentials, callSid)).toMatchObject({
      outcome: 'accepted',
      call: { status: 'completed', durationSeconds: 42 },
    });
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      method: 'GET',
      path: `/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
    });
  });

  it('refuses a response naming a different call', async () => {
    expect(
      await fetchVoiceCall(
        answer(200, { ...resource, sid: `CA${'9'.repeat(32)}` }),
        credentials,
        callSid,
      ),
    ).toMatchObject({ outcome: 'unknown', reason: 'unreadable' });
  });

  it.each(['canceled', 'completed'] as const)(
    'ends a call using documented Status=%s',
    async (status) => {
      const transport = vi.fn<TwilioTransport>(answer(200, { ...resource, status }));
      expect(await endVoiceCall(transport, credentials, callSid, status)).toMatchObject({
        outcome: 'accepted',
      });
      expect(new URLSearchParams(transport.mock.calls[0]?.[0].body).get('Status')).toBe(status);
    },
  );

  it('rejects malformed call identifiers without transport', async () => {
    const transport = vi.fn<TwilioTransport>(answer());
    expect(await fetchVoiceCall(transport, credentials, '../Calls')).toMatchObject({
      outcome: 'rejected',
      httpStatus: 0,
    });
    expect(await endVoiceCall(transport, credentials, 'not-a-call', 'completed')).toMatchObject({
      outcome: 'rejected',
      httpStatus: 0,
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
