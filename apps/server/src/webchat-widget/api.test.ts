import { describe, expect, it, vi } from 'vitest';

import { createWidgetApi, readMessage, type Fetch } from './api.js';

const KEY = 'k'.repeat(32);
const TOKEN = 't'.repeat(43);
const sent = { seq: 1, from: 'visitor', text: 'Hello', sentAt: '2026-10-09T09:00:00.000Z' };

type Call = Parameters<Fetch>;
function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    calls.push([url, init]);
    return Promise.resolve({
      status,
      headers: { get: (name) => headers[name] ?? null },
      json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
    });
  };
  return { api: createWidgetApi('https://crm.example.test', KEY, fetch), calls };
}

describe('the requests', () => {
  it('reads the widget with no token, no cookies, no referrer and no redirect', async () => {
    const { api, calls } = answering(200, {
      title: 'Chat',
      greeting: '',
      emailRequired: true,
      marketingConsentWording: null,
      messageLength: 2000,
    });
    expect((await api.config()).ok).toBe(true);
    expect(calls).toEqual([
      [
        `https://crm.example.test/api/v1/public/webchat/${KEY}`,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'omit',
          mode: 'cors',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
        },
      ],
    ]);
  });

  it('starts a session with only what the visitor gave', async () => {
    const { api, calls } = answering(201, { token: TOKEN, expiresAt: '2026-11-08T09:00:00Z' });
    const result = await api.start({ email: 'maya@example.test', marketingConsent: false });
    expect(result).toEqual({
      ok: true,
      value: { token: TOKEN, expiresAt: '2026-11-08T09:00:00Z' },
    });
    expect(calls[0]?.[0]).toBe(`https://crm.example.test/api/v1/public/webchat/${KEY}/sessions`);
    expect(calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'maya@example.test', marketingConsent: false }),
    });
    expect(calls[0]?.[1].headers).not.toHaveProperty('authorization');
  });

  it('sends the token in a header, never in the address', async () => {
    const { api, calls } = answering(200, sent);
    await api.send(TOKEN, 'id-1', 'Hello');
    await api.messages(TOKEN, 7);
    await api.end(TOKEN);
    for (const [url, init] of calls) {
      expect(url).not.toContain(TOKEN);
      expect(init.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(init.body ?? '').not.toContain(TOKEN);
    }
    expect(calls.map(([url, init]) => `${init.method} ${url.split(KEY)[1] ?? ''}`)).toEqual([
      'POST /messages',
      'GET /messages?after=7',
      'POST /session/end',
    ]);
    expect(calls[0]?.[1].body).toBe(JSON.stringify({ clientMessageId: 'id-1', text: 'Hello' }));
  });

  it('asks for a whole place that is not negative', async () => {
    const { api, calls } = answering(200, { messages: [], cursor: 0, more: false });
    await api.messages(TOKEN, -5);
    await api.messages(TOKEN, 3.9);
    expect(calls.map(([url]) => url.split('?')[1])).toEqual(['after=0', 'after=3']);
  });
});

describe('the answers', () => {
  it('gives the stored message, a page and an ended session', async () => {
    expect(await answering(200, sent).api.send(TOKEN, 'id', 'Hello')).toEqual({
      ok: true,
      value: sent,
    });
    const page = { messages: [sent, { ...sent, seq: 2, from: 'team' }], cursor: 2, more: true };
    expect(await answering(200, page).api.messages(TOKEN, 0)).toEqual({ ok: true, value: page });
    // 204 has no body; it is not read.
    expect(await answering(204, new Error('no body')).api.end(TOKEN)).toEqual({
      ok: true,
      value: null,
    });
  });

  it.each([
    [401, 'session'],
    [410, 'full'],
    [429, 'limited'],
    [400, 'invalid'],
    [413, 'invalid'],
    [415, 'invalid'],
    [422, 'invalid'],
    [409, 'network'],
    [403, 'unavailable'],
    [404, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [302, 'unavailable'],
    [199, 'unavailable'],
  ])('reads status %i as %s', async (status, failure) => {
    expect(await answering(status, {}).api.messages(TOKEN, 0)).toEqual({ ok: false, failure });
  });

  it('passes on a retry time only when it is a plain number of seconds', async () => {
    const wait = async (header: string) =>
      await answering(429, {}, { 'retry-after': header }).api.send(TOKEN, 'id', 'x');
    expect(await wait('30')).toEqual({ ok: false, failure: 'limited', retryAfterSeconds: 30 });
    for (const header of ['0', '-1', '1.5', 'soon', '999999', 'Wed, 21 Oct 2026 07:28:00 GMT'])
      expect(await wait(header)).toEqual({ ok: false, failure: 'limited' });
  });

  it('never throws: a failed request, a thrown error and a broken body are all outcomes', async () => {
    const failing: Fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const throwing: Fetch = () => {
      throw new Error('blocked');
    };
    for (const fetch of [failing, throwing]) {
      const api = createWidgetApi('https://crm.example.test', KEY, fetch);
      expect(await api.config()).toEqual({ ok: false, failure: 'network' });
      expect(await api.end(TOKEN)).toEqual({ ok: false, failure: 'network' });
    }
    expect(await answering(200, new SyntaxError('not JSON')).api.config()).toEqual({
      ok: false,
      failure: 'network',
    });
  });

  it('refuses an answer that is not what the contract says, rather than showing it', async () => {
    for (const body of [
      null,
      'text',
      [],
      { ...sent, seq: 0 },
      { ...sent, seq: '1' },
      { ...sent, from: 'system' },
      { ...sent, text: { html: '<b>x</b>' } },
      { ...sent, text: undefined },
      { ...sent, sentAt: 5 },
    ])
      expect(await answering(200, body).api.send(TOKEN, 'id', 'x')).toEqual({
        ok: false,
        failure: 'unavailable',
      });
    for (const body of [
      { messages: 'none', cursor: 0, more: false },
      { messages: [sent, { ...sent, from: 'robot' }], cursor: 2, more: false },
      { messages: [], cursor: -1, more: false },
      { messages: [], cursor: 0 },
    ])
      expect(await answering(200, body).api.messages(TOKEN, 0)).toEqual({
        ok: false,
        failure: 'unavailable',
      });
    for (const body of [
      { token: 'short', expiresAt: 'x' },
      { token: `${'t'.repeat(42)}\n`, expiresAt: 'x' },
      { token: `${'t'.repeat(40)}\r\nx`, expiresAt: 'x' },
      { token: TOKEN },
      { expiresAt: 'x' },
    ])
      expect(await answering(201, body).api.start({ marketingConsent: false })).toEqual({
        ok: false,
        failure: 'unavailable',
      });
    for (const body of [
      {
        title: 'Chat',
        greeting: '',
        emailRequired: 'yes',
        marketingConsentWording: null,
        messageLength: 1,
      },
      {
        title: 'Chat',
        greeting: '',
        emailRequired: true,
        marketingConsentWording: 5,
        messageLength: 1,
      },
      {
        title: 'Chat',
        greeting: '',
        emailRequired: true,
        marketingConsentWording: null,
        messageLength: 0,
      },
      {
        title: 7,
        greeting: '',
        emailRequired: true,
        marketingConsentWording: null,
        messageLength: 1,
      },
    ])
      expect(await answering(200, body).api.config()).toEqual({
        ok: false,
        failure: 'unavailable',
      });
  });

  it('keeps only the fields of a message it knows', () => {
    expect(readMessage({ ...sent, html: '<b>x</b>', authorName: 'Agent' })).toEqual(sent);
  });

  it('puts the widget key in the path as one segment', async () => {
    const fetch = vi.fn<Fetch>().mockRejectedValue(new Error('no'));
    await createWidgetApi('https://crm.example.test', '../../admin?x=', fetch).config();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://crm.example.test/api/v1/public/webchat/..%2F..%2Fadmin%3Fx%3D',
    );
  });
});
