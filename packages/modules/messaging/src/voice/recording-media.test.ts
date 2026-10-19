import { describe, expect, it, vi } from 'vitest';

import type { TwilioCredentials } from '../twilio-api.js';
import { fetchRecordingMp3 } from './recording-media.js';

describe('fetchRecordingMp3', () => {
  const accountSid = `AC${'1'.repeat(32)}`;
  const recordingSid = `RE${'2'.repeat(32)}`;
  const credentials: TwilioCredentials = {
    accountSid,
    authToken: 'synthetic-auth-token',
  };

  it('fetches with the exact URL, method and Authorization header', async () => {
    const fakeMp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(fakeMp3, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const result = await fetchRecordingMp3(fetcher, credentials, recordingSid, {
      maxBytes: 1024,
    });

    expect(result).toEqual({ outcome: 'fetched', content: fakeMp3 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [targetUrl, init] = fetcher.mock.calls[0] ?? [];
    expect(targetUrl).toEqual(
      new URL(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`,
      ),
    );
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
    });
    const expectedAuth = `Basic ${Buffer.from(`${accountSid}:synthetic-auth-token`).toString('base64')}`;
    expect((init?.headers as Record<string, string> | undefined)?.['authorization']).toBe(
      expectedAuth,
    );
  });

  it('uses API key credentials when present for Authorization', async () => {
    const credsWithApiKey: TwilioCredentials = {
      accountSid,
      authToken: 'synthetic-auth-token',
      apiKey: { sid: `SK${'3'.repeat(32)}`, secret: 'synthetic-key-secret' },
    };
    const fakeMp3 = new Uint8Array([1, 2, 3]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(fakeMp3, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    await fetchRecordingMp3(fetcher, credsWithApiKey, recordingSid, { maxBytes: 1024 });

    const expectedAuth = `Basic ${Buffer.from(`SK${'3'.repeat(32)}:synthetic-key-secret`).toString('base64')}`;
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string> | undefined)?.['authorization']).toBe(
      expectedAuth,
    );
  });

  it('refuses a malformed recording SID and never reaches the network', async () => {
    const fetcher = vi.fn<typeof fetch>();

    const result1 = await fetchRecordingMp3(fetcher, credentials, 'invalid-sid', {
      maxBytes: 1024,
    });
    expect(result1).toEqual({ outcome: 'rejected' });
    expect(fetcher).not.toHaveBeenCalled();

    const result2 = await fetchRecordingMp3(fetcher, credentials, `CA${'2'.repeat(32)}`, {
      maxBytes: 1024,
    });
    expect(result2).toEqual({ outcome: 'rejected' });
    expect(fetcher).not.toHaveBeenCalled();

    const badAccountCreds: TwilioCredentials = {
      accountSid: 'invalid-account',
      authToken: 'token',
    };
    const result3 = await fetchRecordingMp3(fetcher, badAccountCreds, recordingSid, {
      maxBytes: 1024,
    });
    expect(result3).toEqual({ outcome: 'rejected' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns not_found on 404', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result = await fetchRecordingMp3(fetcher, credentials, recordingSid, {
      maxBytes: 1024,
    });
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('returns rejected with status on 401 and other 4xx', async () => {
    const fetcher401 = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result401 = await fetchRecordingMp3(fetcher401, credentials, recordingSid, {
      maxBytes: 1024,
    });
    expect(result401).toEqual({ outcome: 'rejected', status: 401 });

    const fetcher403 = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Forbidden', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result403 = await fetchRecordingMp3(fetcher403, credentials, recordingSid, {
      maxBytes: 1024,
    });
    expect(result403).toEqual({ outcome: 'rejected', status: 403 });
  });

  it('returns unknown on 500', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result = await fetchRecordingMp3(fetcher, credentials, recordingSid, {
      maxBytes: 1024,
    });
    expect(result).toEqual({ outcome: 'unknown' });
  });

  it('returns unknown on timeout or network error', async () => {
    const fetcherNetworkError = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('connection reset'));

    const result1 = await fetchRecordingMp3(fetcherNetworkError, credentials, recordingSid, {
      maxBytes: 1024,
    });
    expect(result1).toEqual({ outcome: 'unknown' });

    const fetcherTimeout = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('Timeout'));

    const result2 = await fetchRecordingMp3(fetcherTimeout, credentials, recordingSid, {
      maxBytes: 1024,
    });
    expect(result2).toEqual({ outcome: 'unknown' });
  });

  it('returns rejected on 200 with wrong content type', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>Error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await fetchRecordingMp3(fetcher, credentials, recordingSid, {
      maxBytes: 1024,
    });
    expect(result).toEqual({ outcome: 'rejected', status: 200 });
  });

  it('returns too_large when body is one byte over maxBytes', async () => {
    const chunk1 = new Uint8Array(10);
    const chunk2 = new Uint8Array(1);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const result = await fetchRecordingMp3(fetcher, credentials, recordingSid, {
      maxBytes: 10,
    });
    expect(result).toEqual({ outcome: 'too_large' });
  });

  it('returns success with bytes unchanged', async () => {
    const originalBytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(originalBytes, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const result = await fetchRecordingMp3(fetcher, credentials, recordingSid, {
      maxBytes: 1024,
    });
    expect(result).toEqual({ outcome: 'fetched', content: originalBytes });
  });
});
