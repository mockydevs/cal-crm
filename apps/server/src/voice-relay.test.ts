import { describe, expect, it, vi } from 'vitest';

import { createVoiceRelay } from './voice-relay.js';

const token = 'a'.repeat(43);
const path = `/webhooks/twilio/voice/${token}/inbound`;
const body = Buffer.from('CallSid=synthetic&From=%2B12025550101');
const request = { path, body, signature: 'synthetic-signature' };
const xml = '<Response><Hangup/></Response>';
const response = (text = xml, status = 200, contentType = 'application/xml') =>
  new Response(text, { status, headers: { 'content-type': contentType } });

describe('voice relay boundary', () => {
  it.each(['progress', 'ended', 'recording'])(
    'accepts empty notification acknowledgements for %s',
    async (kind) => {
      for (const status of [200, 204]) {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
        const result = await createVoiceRelay({ workerOrigin: 'http://worker:3000', fetcher })({
          ...request,
          path: `/webhooks/twilio/voice/${token}/${kind}`,
        });
        expect(result).toEqual({ statusCode: status, contentType: 'text/plain', body: '' });
      }
    },
  );

  it('requires call instructions for synchronous inbound requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(
      (await createVoiceRelay({ workerOrigin: 'http://worker:3000', fetcher })(request)).statusCode,
    ).toBe(503);
  });

  it('forwards only bounded raw form and signature to the fixed worker origin', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const relay = createVoiceRelay({ workerOrigin: 'http://worker:3000', fetcher });
    expect(await relay(request)).toEqual({
      statusCode: 200,
      contentType: 'application/xml',
      body: xml,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL(`http://worker:3000${path}`));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': request.signature,
      },
    });
    expect(Object.keys(fetcher.mock.calls[0]?.[1]?.headers ?? {})).toHaveLength(2);
  });

  it('preserves the signed query without using it as a destination', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const relay = createVoiceRelay({ workerOrigin: 'https://worker.example.test', fetcher });
    const query = '?step=12345678-1234-1234-1234-123456789abc';
    await relay({ ...request, path: `${path}${query}` });
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL(`https://worker.example.test${path}${query}`),
    );
  });

  it.each([
    'http://evil.test',
    'https://user:pass@worker.test',
    'https://worker.test/prefix',
    'https://worker.test?query=1',
    'https://worker.test#fragment',
    'file:///worker',
    'not-a-url',
  ])('rejects unsafe configuration at startup: %s', (workerOrigin) => {
    expect(() => createVoiceRelay({ workerOrigin })).toThrow();
  });

  it.each([
    `https://evil.test${path}`,
    `//evil.test${path}`,
    '/api/v1/contacts',
    `/webhooks/twilio/voice/${token}/purchase`,
    `/webhooks/twilio/voice/${token}/../inbound`,
    `${path}#fragment`,
    `${path}?call=synthetic&step=1`,
    `${path}?${'a'.repeat(2049)}`,
  ])('refuses non-voice paths before transport: %s', async (unsafePath) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (
        await createVoiceRelay({ workerOrigin: 'http://worker:3000', fetcher })({
          ...request,
          path: unsafePath,
        })
      ).statusCode,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses unsigned and oversized requests before transport', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const relay = createVoiceRelay({ workerOrigin: 'http://worker:3000', fetcher });
    expect((await relay({ ...request, signature: undefined })).statusCode).toBe(403);
    expect((await relay({ ...request, body: new Uint8Array(65_537) })).statusCode).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 429])(
    'preserves worker refusal %i but drops its private error details',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response('secret-upstream-detail', status, 'text/plain'));
      const result = await createVoiceRelay({ workerOrigin: 'http://worker:3000', fetcher })(
        request,
      );
      expect(result.statusCode).toBe(status);
      expect(result.body).not.toContain('secret');
    },
  );

  it.each([302, 500, 503])('never follows or retries worker HTTP %i', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('private', status));
    const result = await createVoiceRelay({ workerOrigin: 'http://worker:3000', fetcher })(request);
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('private');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails closed on a lost response, oversized output or non-XML success', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error('private connection detail')),
      vi.fn<typeof fetch>().mockResolvedValue(response('x'.repeat(65_537))),
      vi.fn<typeof fetch>().mockResolvedValue(response('private', 200, 'text/html')),
    ]) {
      const result = await createVoiceRelay({ workerOrigin: 'http://worker:3000', fetcher })(
        request,
      );
      expect(result.statusCode).toBe(503);
      expect(result.body).not.toContain('private');
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
});
