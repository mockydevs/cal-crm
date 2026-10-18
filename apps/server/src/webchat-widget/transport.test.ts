import { Writable } from 'node:stream';

import {
  publicWebchatConfig,
  publicWebchatMessage,
  publicWebchatMessages,
  publicWebchatSession,
  WEBCHAT_LIMITS,
} from '@repo/contracts';
import { ConflictError } from '@repo/kernel';
import { WEBCHAT_SCRIPT_PATH } from '@repo/module-messaging';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPublicBooking, type PublicBookingRateLimit } from '../public-booking.js';
import {
  loadWidgetScript,
  registerPublicWebchat,
  WEBCHAT_SCRIPT_URL,
  type PublicWebchatPorts,
  type WidgetScript,
} from './transport.js';

interface Admission {
  readonly widgetId: string;
  readonly origin: string;
  readonly businessId?: string;
}
type Ports = PublicWebchatPorts<Admission>;

const KEY = 'k'.repeat(32);
const TOKEN = Buffer.alloc(32, 9).toString('base64url');
const ORIGIN = 'https://example.com';
const BASE = `/api/v1/public/webchat/${KEY}`;
const config = {
  title: 'Chat with us',
  greeting: 'Hello.',
  emailRequired: true,
  marketingConsentWording: null,
  messageLength: WEBCHAT_LIMITS.messageLength,
};
const session = { token: TOKEN, expiresAt: '2026-11-08T09:00:00.000Z' };
const sent = { seq: 1, from: 'visitor', text: 'Hello', sentAt: '2026-10-09T09:00:00.000Z' };
const page = { messages: [sent], cursor: 1, more: false };
const body = { clientMessageId: '5ef5926d-d3b7-4b95-a513-198a51a2c5d1', text: 'Hello' };
const script: WidgetScript = { body: Buffer.from('(function(){})();'), etag: '"abc"' };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function start(options: { script?: WidgetScript; booking?: boolean } = {}) {
  const handlers = {
    // As the module's gate: the key must be the widget's, the Origin exactly its website.
    admit: vi
      .fn<Ports['admit']>()
      .mockImplementation((key, origin) =>
        Promise.resolve(
          key === KEY && origin === ORIGIN ? { widgetId: 'w', origin: ORIGIN } : undefined,
        ),
      ),
    config: vi.fn<Ports['config']>().mockResolvedValue({ outcome: 'ok', config }),
    start: vi.fn<Ports['start']>().mockResolvedValue({ outcome: 'ok', session }),
    send: vi.fn<Ports['send']>().mockResolvedValue({ outcome: 'ok', message: sent }),
    messages: vi.fn<Ports['messages']>().mockResolvedValue({ outcome: 'ok', page }),
    end: vi.fn<Ports['end']>().mockResolvedValue({ outcome: 'ok' }),
  };
  const rateLimit = vi.fn<PublicBookingRateLimit>().mockResolvedValue({ allowed: true });
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(chunk.toString());
          done();
        },
      }),
    },
  });
  apps.push(app);
  if (options.booking === true) {
    const none = vi.fn().mockRejectedValue(new Error('not used'));
    await registerPublicBooking(app, {
      rateLimit,
      handlers: {
        calendar: none,
        slots: none,
        book: none,
        appointment: none,
        cancel: none,
        reschedule: none,
        appointmentSlots: none,
        challenge: none,
      },
    });
  }
  await registerPublicWebchat(app, { handlers, rateLimit, script: options.script });
  await app.ready();
  const call = (request: InjectOptions, origin: string | null = ORIGIN) =>
    app.inject({
      ...request,
      headers: { ...(origin === null ? {} : { origin }), ...request.headers },
    });
  return { app, handlers, rateLimit, logs, call };
}

const bearer = { authorization: `Bearer ${TOKEN}` };
/** Every operation of the contract: each one is behind the limiter and the gate. */
const everyRequest: InjectOptions[] = [
  { method: 'GET', url: BASE },
  { method: 'POST', url: `${BASE}/sessions`, payload: { marketingConsent: false } },
  { method: 'POST', url: `${BASE}/messages`, payload: body, headers: bearer },
  { method: 'GET', url: `${BASE}/messages?after=0`, headers: bearer },
  { method: 'POST', url: `${BASE}/session/end`, headers: bearer },
];
/** What a browser asks before any of them that carries a token or a JSON body. */
const everyPreflight: InjectOptions[] = [
  BASE,
  `${BASE}/sessions`,
  `${BASE}/messages`,
  `${BASE}/session/end`,
].map((url) => ({
  method: 'OPTIONS' as const,
  url,
  headers: {
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization,content-type',
  },
}));
const corsHeaders = (headers: Record<string, unknown>): string[] =>
  Object.keys(headers).filter((name) => name.startsWith('access-control-'));

describe('an allowed website', () => {
  it('is served every operation, each answer fitting its contract', async () => {
    const { call, handlers } = await start();
    const answers = await Promise.all(everyRequest.slice(0, 5).map((request) => call(request)));
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 201, 200, 200, 204]);
    expect(publicWebchatConfig.safeParse(answers[0]?.json()).success).toBe(true);
    expect(publicWebchatSession.safeParse(answers[1]?.json()).success).toBe(true);
    expect(publicWebchatMessage.safeParse(answers[2]?.json()).success).toBe(true);
    expect(publicWebchatMessages.safeParse(answers[3]?.json()).success).toBe(true);
    expect(answers[4]?.body).toBe('');
    for (const answer of answers) {
      expect(answer.headers).toMatchObject({
        'access-control-allow-origin': ORIGIN,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        vary: 'Origin',
      });
      expect(answer.headers).not.toHaveProperty('access-control-allow-credentials');
    }
    expect(handlers.start).toHaveBeenCalledOnce();
  });

  it('gets a preflight answer for the two methods and the two headers the widget uses', async () => {
    const { call, handlers } = await start();
    for (const request of everyPreflight) {
      const answer = await call(request);
      expect(answer.statusCode).toBe(204);
      expect(answer.body).toBe('');
      expect(answer.headers).toMatchObject({
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
      expect(answer.headers).not.toHaveProperty('access-control-allow-credentials');
    }
    expect(handlers.config).not.toHaveBeenCalled();
  });

  it('is answered with the stored origin, not with what the request sent', async () => {
    const { call, handlers } = await start();
    // A gate that wrongly let another website through still cannot make the transport
    // echo it: the header carries the admission's own value.
    handlers.admit.mockResolvedValue({ widgetId: 'w', origin: 'https://stored.example' });
    const answer = await call({ method: 'GET', url: BASE }, 'https://evil.test');
    expect(answer.headers['access-control-allow-origin']).toBe('https://stored.example');
  });
});

describe('a website that is not allowed', () => {
  it.each([
    ['another website', 'https://evil.test'],
    ['a host that starts with the allowed one', 'https://example.com.evil.test'],
    ['user information hiding another host', 'https://example.com@evil.test'],
    ['a subdomain', 'https://www.example.com'],
    ['plain HTTP', 'http://example.com'],
    ['another port', 'https://example.com:8443'],
    ['a trailing slash', 'https://example.com/'],
    ['upper case', 'HTTPS://EXAMPLE.COM'],
    ['the opaque origin', 'null'],
    ['a wildcard', '*'],
    ['an empty header', ''],
    ['no Origin header at all', null],
  ])('is refused, with no CORS header and no handler run: %s', async (_why, origin) => {
    const { call, handlers } = await start();
    for (const request of everyRequest) {
      const answer = await call(request, origin);
      expect(answer.statusCode).toBe(403);
      expect(corsHeaders(answer.headers)).toEqual([]);
      expect(answer.headers).toMatchObject({ 'cache-control': 'no-store', vary: 'Origin' });
      expect(answer.json()).toEqual({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'This chat cannot be used here.',
      });
    }
    for (const handler of [handlers.config, handlers.start, handlers.send, handlers.messages])
      expect(handler).not.toHaveBeenCalled();
    expect(handlers.end).not.toHaveBeenCalled();
  });

  it('gets the same preflight answer as everyone, which lets it read nothing', async () => {
    // A preflight only lets a browser send the request. It is answered from memory, the
    // same for every website and every key, so it says nothing about either; the request
    // it allows then meets the gate, as the test above shows for each of these origins.
    const { call, handlers, rateLimit } = await start();
    const answers = [];
    for (const origin of [ORIGIN, 'https://evil.test', 'null', null])
      for (const request of [
        ...everyPreflight,
        { ...everyPreflight[0], url: `/api/v1/public/webchat/${'u'.repeat(32)}/messages` },
      ]) {
        const answer = await call(request, origin);
        expect(answer.statusCode).toBe(204);
        answers.push(
          corsHeaders(answer.headers)
            .sort()
            .map((name) => `${name}: ${String(answer.headers[name])}`),
        );
        expect(answer.headers).not.toHaveProperty('access-control-allow-credentials');
      }
    expect(new Set(answers.map((each) => each.join('\n'))).size).toBe(1);
    expect(answers[0]).toEqual([
      'access-control-allow-headers: authorization, content-type',
      'access-control-allow-methods: GET, POST',
      'access-control-allow-origin: *',
      'access-control-expose-headers: Retry-After',
      'access-control-max-age: 600',
    ]);
    // Nothing was looked up, counted or run for any of them.
    expect(handlers.admit).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    for (const handler of [handlers.config, handlers.start, handlers.send, handlers.messages])
      expect(handler).not.toHaveBeenCalled();
  });

  it('is refused when two origins arrive in one Origin header', async () => {
    // What a repeated header becomes once joined: no stored origin is two origins.
    const { call, handlers } = await start();
    for (const origin of [`${ORIGIN}, https://evil.test`, `${ORIGIN} https://evil.test`]) {
      const answer = await call({ method: 'GET', url: BASE }, origin);
      expect(answer.statusCode).toBe(403);
      expect(corsHeaders(answer.headers)).toEqual([]);
    }
    expect(handlers.config).not.toHaveBeenCalled();
  });

  it('learns nothing about which keys exist: an unknown key, a malformed one and a listed one answer alike', async () => {
    const { call, handlers } = await start();
    const unknown = await call({ method: 'GET', url: `/api/v1/public/webchat/${'u'.repeat(32)}` });
    const malformed = await call({ method: 'GET', url: '/api/v1/public/webchat/short' });
    const elsewhere = await call({ method: 'GET', url: BASE }, 'https://evil.test');
    for (const answer of [unknown, malformed, elsewhere]) {
      expect(answer.statusCode).toBe(403);
      expect(answer.body).toBe(elsewhere.body);
      expect(corsHeaders(answer.headers)).toEqual([]);
    }
    // A key that could not be one is not even looked up.
    expect(handlers.admit).toHaveBeenCalledTimes(2);
  });
});

describe('CORS headers', () => {
  it('name a website only to that website, and are a wildcard only on the answers that say nothing', async () => {
    const { call, handlers, rateLimit } = await start({ script });
    const origins = [ORIGIN, 'https://evil.test', '*', 'null', null];
    const seen: unknown[] = [];
    const sweep = async (limited: boolean): Promise<void> => {
      for (const origin of origins)
        for (const request of [
          ...everyRequest,
          { method: 'GET' as const, url: `${BASE}/nothing-here` },
          { method: 'DELETE' as const, url: BASE },
          { method: 'POST' as const, url: `${BASE}/messages`, payload: { text: 5 } },
        ]) {
          const answer = await call(request, origin);
          const allowed = answer.headers['access-control-allow-origin'];
          seen.push(allowed);
          expect(answer.headers).not.toHaveProperty('access-control-allow-credentials');
          if (limited) {
            // The limiter's own refusal: the same for every website, and nothing but a
            // status and a wait. No handler ran and no key was looked up.
            expect([429, 503]).toContain(answer.statusCode);
            expect(allowed).toBe('*');
            expect(corsHeaders(answer.headers).sort()).toEqual([
              'access-control-allow-origin',
              'access-control-expose-headers',
            ]);
            continue;
          }
          // Everything else names the stored origin, to that website alone, or nothing.
          expect(allowed === undefined || allowed === ORIGIN).toBe(true);
          if (origin !== ORIGIN) expect(corsHeaders(answer.headers)).toEqual([]);
          if (answer.statusCode < 300) expect(allowed).toBe(ORIGIN);
        }
    };
    await sweep(false);
    handlers.config.mockRejectedValue(new Error('boom'));
    handlers.send.mockResolvedValue({ outcome: 'session_invalid' });
    await sweep(false);
    expect(seen).toContain(ORIGIN);
    expect(seen).not.toContain('*');
    rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    await sweep(true);
    rateLimit.mockRejectedValue(new Error('down'));
    await sweep(true);
  });
});

describe('the shared rate limit', () => {
  it('runs first, with the address and a server-made request id, and counts by method', async () => {
    const { app, rateLimit } = await start();
    const answer = await app.inject({
      method: 'GET',
      url: BASE,
      remoteAddress: '192.0.2.8',
      headers: { origin: ORIGIN, 'x-forwarded-for': '198.51.100.1', 'x-request-id': 'chosen' },
    });
    expect(answer.statusCode).toBe(200);
    expect(rateLimit).toHaveBeenCalledExactlyOnceWith(
      { requestId: expect.stringMatching(/^req-/) as string, ipAddress: '192.0.2.8' },
      'read',
    );
    rateLimit.mockClear();
    // A preflight is answered from memory and is not counted; what it allows is.
    await app.inject({ method: 'OPTIONS', url: BASE, headers: { origin: ORIGIN } });
    expect(rateLimit).not.toHaveBeenCalled();
    await app.inject({
      method: 'GET',
      url: `${BASE}/messages?after=0`,
      headers: { origin: ORIGIN, ...bearer },
    });
    await app.inject({
      method: 'POST',
      url: `${BASE}/sessions`,
      headers: { origin: ORIGIN },
      payload: { marketingConsent: false },
    });
    expect(rateLimit.mock.calls.map(([, operation]) => operation)).toEqual(['read', 'write']);
  });

  it('refuses before the gate with no lookup of the key, and lets any website read the wait', async () => {
    const { call, handlers, rateLimit } = await start();
    rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const bodies = new Set<string>();
    for (const origin of [ORIGIN, 'https://evil.test', null])
      for (const request of everyRequest) {
        const answer = await call(request, origin);
        expect(answer.statusCode).toBe(429);
        expect(answer.headers['retry-after']).toBe('17');
        // Without these a browser reports a network failure, and the widget, unable to
        // see that it was asked to wait, would try again sooner.
        expect(answer.headers['access-control-allow-origin']).toBe('*');
        expect(answer.headers['access-control-expose-headers']).toBe('Retry-After');
        expect(answer.headers).not.toHaveProperty('access-control-allow-credentials');
        bodies.add(answer.body);
      }
    // One answer for everybody: it says nothing of the key, the website or a session.
    expect([...bodies]).toEqual([
      JSON.stringify({
        type: 'about:blank',
        title: 'Too Many Requests',
        status: 429,
        detail: 'Wait before trying again.',
      }),
    ]);
    expect(handlers.admit).not.toHaveBeenCalled();
    for (const handler of [handlers.config, handlers.start, handlers.send, handlers.messages])
      expect(handler).not.toHaveBeenCalled();
  });

  it('counts a request toward the business of its widget, once a request for the key was admitted', async () => {
    const { call, handlers, rateLimit } = await start();
    const BUSINESS = '01890f3e-7b1c-7cc0-8a51-00000000000a';
    handlers.admit.mockImplementation((key, origin) =>
      Promise.resolve(
        key === KEY && origin === ORIGIN
          ? { widgetId: 'w', origin: ORIGIN, businessId: BUSINESS }
          : undefined,
      ),
    );
    await call({ method: 'GET', url: BASE });
    await call({ method: 'POST', url: `${BASE}/messages`, payload: body, headers: bearer });
    await call({ method: 'GET', url: BASE }, 'https://attacker.test');
    const other = `/api/v1/public/webchat/${'z'.repeat(32)}`;
    await call({ method: 'GET', url: other });
    await call({ method: 'GET', url: other });
    expect(rateLimit.mock.calls.map(([request]) => request.businessId)).toEqual([
      // The first request for a key: which business it is for is not known yet.
      undefined,
      BUSINESS,
      // Whoever sends the key, allowed or not: a flood from anywhere counts as the business.
      BUSINESS,
      // A key that names no widget is never remembered: made-up keys fill nothing.
      undefined,
      undefined,
    ]);
    expect(rateLimit.mock.calls.at(-1)?.[0]).not.toHaveProperty('businessId');
    // A preflight is answered from memory: it counts toward nothing and looks nothing up.
    rateLimit.mockClear();
    await call({ method: 'OPTIONS', url: BASE });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', () => Promise.reject(new Error('database down at 10.0.0.5'))],
    ['answers with no retry time', () => Promise.resolve({ allowed: false, retryAfterSeconds: 0 })],
    [
      'answers with a retry time that is no number',
      () => Promise.resolve({ allowed: false, retryAfterSeconds: Number.NaN }),
    ],
  ] as const)('fails closed when the limiter %s', async (_why, decide) => {
    const { call, handlers, rateLimit, logs } = await start();
    rateLimit.mockImplementation(decide);
    const answer = await call({ method: 'POST', url: `${BASE}/messages`, payload: body });
    expect(answer.statusCode).toBe(503);
    expect(answer.body).not.toContain('10.0.0.5');
    expect(logs.join('')).not.toContain('10.0.0.5');
    expect(handlers.admit).not.toHaveBeenCalled();
    expect(handlers.send).not.toHaveBeenCalled();
  });
});

describe('what reaches the handlers', () => {
  it('is the admission, validated input and a request id: never an address', async () => {
    const { app, handlers } = await start();
    await app.inject({
      method: 'POST',
      url: `${BASE}/sessions`,
      remoteAddress: '192.0.2.8',
      headers: { origin: ORIGIN, 'user-agent': 'Browser/1.0' },
      payload: { name: ' Maya ', email: ' Maya@Example.test ', marketingConsent: false },
    });
    expect(handlers.start).toHaveBeenCalledExactlyOnceWith(
      { widgetId: 'w', origin: ORIGIN },
      { name: 'Maya', email: 'maya@example.test', marketingConsent: false },
      { requestId: expect.stringMatching(/^req-/) as string },
    );
    expect(JSON.stringify(handlers.start.mock.calls)).not.toMatch(/192\.0\.2\.8|Browser/);
  });

  it('is the token of one well-formed Bearer header, and nothing from anywhere else', async () => {
    const { call, handlers } = await start();
    await call({ method: 'GET', url: `${BASE}/messages?after=3`, headers: bearer });
    expect(handlers.messages).toHaveBeenLastCalledWith({ widgetId: 'w', origin: ORIGIN }, TOKEN, 3);
    for (const authorization of [
      TOKEN,
      `bearer ${TOKEN}`,
      `Bearer ${TOKEN} `,
      `Bearer ${TOKEN.slice(1)}`,
      `Basic ${TOKEN}`,
      '',
    ]) {
      await call({ method: 'GET', url: `${BASE}/messages`, headers: { authorization } });
      expect(handlers.messages).toHaveBeenLastCalledWith(expect.anything(), undefined, 0);
    }
    await call({ method: 'GET', url: `${BASE}/messages`, headers: { cookie: `token=${TOKEN}` } });
    expect(handlers.messages).toHaveBeenLastCalledWith(expect.anything(), undefined, 0);
  });

  it('refuses a token in the address, and any other unknown query', async () => {
    const { call, handlers } = await start();
    for (const url of [
      `${BASE}/messages?token=${TOKEN}`,
      `${BASE}/messages?after=1&limit=5000`,
      `${BASE}/messages?after=-1`,
      `${BASE}?debug=1`,
    ])
      expect((await call({ method: 'GET', url, headers: bearer })).statusCode).toBe(422);
    expect(
      (await call({ method: 'POST', url: `${BASE}/session/end?token=${TOKEN}` })).statusCode,
    ).toBe(422);
    expect(handlers.messages).not.toHaveBeenCalled();
    expect(handlers.config).not.toHaveBeenCalled();
    expect(handlers.end).not.toHaveBeenCalled();
  });
});

describe('bounds', () => {
  it.each([
    ['a message one character too long', { ...body, text: 'a'.repeat(2001) }, 422],
    ['an empty message', { ...body, text: '' }, 422],
    ['a blank message', { ...body, text: ' \n ' }, 422],
    ['a NUL in the message', { ...body, text: 'a\u0000b' }, 422],
    ['a message that is not text', { ...body, text: ['Hello'] }, 422],
    ['no message id', { text: 'Hello' }, 422],
    ['a field that is not in the contract', { ...body, html: '<b>x</b>' }, 422],
    ['a forged sender', { ...body, from: 'team' }, 422],
  ])('refuse %s, and store nothing', async (_why, payload, status) => {
    const { call, handlers } = await start();
    const answer = await call({
      method: 'POST',
      url: `${BASE}/messages`,
      payload,
      headers: bearer,
    });
    expect(answer.statusCode).toBe(status);
    // Generic: the answer does not say which field, or repeat what was sent.
    expect(answer.json()).toMatchObject({ detail: 'Check the details and try again.' });
    expect(handlers.send).not.toHaveBeenCalled();
  });

  it('take the longest message the contract allows', async () => {
    const { call, handlers } = await start();
    const text = '\u{1F600}'.repeat(1000);
    handlers.send.mockResolvedValue({ outcome: 'ok', message: { ...sent, text } });
    const answer = await call({
      method: 'POST',
      url: `${BASE}/messages`,
      payload: { ...body, text },
      headers: bearer,
    });
    expect(answer.statusCode).toBe(200);
  });

  it('refuse a body past the limit before reading it as JSON', async () => {
    const { call, handlers } = await start();
    const answer = await call({
      method: 'POST',
      url: `${BASE}/sessions`,
      payload: { marketingConsent: false, name: 'a'.repeat(20_000) },
    });
    expect(answer.statusCode).toBe(413);
    expect(handlers.start).not.toHaveBeenCalled();
  });

  it.each([
    ['text/plain', JSON.stringify({ marketingConsent: false }), 415],
    ['application/x-www-form-urlencoded', 'marketingConsent=false', 415],
    ['multipart/form-data; boundary=x', '--x--', 415],
    ['application/json', '{"marketingConsent":', 400],
  ])(
    'refuse a %s body that is not JSON a browser must preflight',
    async (type, payload, status) => {
      const { call, handlers } = await start();
      const answer = await call({
        method: 'POST',
        url: `${BASE}/sessions`,
        payload,
        headers: { 'content-type': type },
      });
      expect(answer.statusCode).toBe(status);
      expect(handlers.start).not.toHaveBeenCalled();
    },
  );

  it('refuse session details that do not fit, and scope chosen by the caller', async () => {
    const { call, handlers } = await start();
    for (const payload of [
      {},
      { marketingConsent: 'true' },
      { marketingConsent: false, email: 'not-an-address' },
      { marketingConsent: false, name: 'a'.repeat(81) },
      { marketingConsent: false, businessId: 'other' },
      { marketingConsent: false, contactId: 'other' },
      { marketingConsent: false, token: TOKEN },
    ])
      expect((await call({ method: 'POST', url: `${BASE}/sessions`, payload })).statusCode).toBe(
        422,
      );
    expect(handlers.start).not.toHaveBeenCalled();
  });
});

describe('refusals and failures', () => {
  it.each([
    [{ outcome: 'session_invalid' }, 401, undefined],
    [{ outcome: 'unavailable' }, 403, undefined],
    [{ outcome: 'invalid' }, 422, undefined],
    [{ outcome: 'session_full' }, 410, undefined],
    [{ outcome: 'limited', retryAfterSeconds: 42 }, 429, '42'],
    [{ outcome: 'limited', retryAfterSeconds: 0 }, 429, '60'],
    [{ outcome: 'limited', retryAfterSeconds: 9_999_999 }, 429, '86400'],
  ] as const)(
    'answer %o with %i, readable by the allowed website',
    async (refusal, status, wait) => {
      const { call, handlers } = await start();
      handlers.send.mockResolvedValue(refusal);
      const answer = await call({
        method: 'POST',
        url: `${BASE}/messages`,
        payload: body,
        headers: bearer,
      });
      expect(answer.statusCode).toBe(status);
      expect(answer.headers['retry-after']).toBe(wait);
      expect(answer.headers).toMatchObject({
        'access-control-allow-origin': ORIGIN,
        'access-control-expose-headers': 'Retry-After',
      });
    },
  );

  it('never send what the contract does not allow, even if a handler returns it', async () => {
    const { call, handlers } = await start();
    handlers.messages.mockResolvedValue({
      outcome: 'ok',
      page: { ...page, messages: [{ ...sent, contactId: 'secret-contact', html: '<b>x</b>' }] },
    });
    const answer = await call({ method: 'GET', url: `${BASE}/messages`, headers: bearer });
    expect(answer.statusCode).toBe(500);
    expect(answer.body).not.toContain('secret-contact');
    handlers.config.mockResolvedValue({ outcome: 'ok', config: { ...config, allowedOrigins: [] } });
    expect((await call({ method: 'GET', url: BASE })).statusCode).toBe(500);
  });

  it('hide what went wrong, from the answer and from the log', async () => {
    const { call, handlers, logs } = await start();
    handlers.send.mockRejectedValue(new Error(`duplicate key for maya@example.test ${TOKEN}`));
    const answer = await call({
      method: 'POST',
      url: `${BASE}/messages`,
      payload: { ...body, text: 'my private words' },
      headers: bearer,
    });
    expect(answer.statusCode).toBe(500);
    expect(answer.json()).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'The chat request could not be completed.',
    });
    const logged = logs.join('');
    for (const secret of ['maya@example.test', TOKEN, 'my private words', 'duplicate key'])
      expect(logged).not.toContain(secret);
    expect(logged).toContain('Public web chat request failed');
  });

  it('ask the widget to send again when two requests of one session met', async () => {
    const { call, handlers } = await start();
    handlers.send.mockRejectedValue(new ConflictError('The chat changed. Send the message again.'));
    const answer = await call({
      method: 'POST',
      url: `${BASE}/messages`,
      payload: body,
      headers: bearer,
    });
    expect(answer.statusCode).toBe(409);
    expect(answer.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('answer an unknown path or method inside the scope generically', async () => {
    const { call } = await start();
    for (const request of [
      { method: 'GET' as const, url: `${BASE}/nothing-here` },
      { method: 'DELETE' as const, url: BASE },
      { method: 'PUT' as const, url: `${BASE}/messages` },
      { method: 'HEAD' as const, url: BASE },
    ]) {
      const answer = await call(request);
      expect([403, 404]).toContain(answer.statusCode);
      expect(answer.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('the widget script', () => {
  it('is served as JavaScript any website may load, briefly cached, with no rate limit call', async () => {
    const { app, rateLimit, handlers } = await start({ script });
    const answer = await app.inject({ method: 'GET', url: WEBCHAT_SCRIPT_URL });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toBe('(function(){})();');
    expect(answer.headers).toMatchObject({
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      etag: '"abc"',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
    });
    expect(corsHeaders(answer.headers)).toEqual([]);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(handlers.admit).not.toHaveBeenCalled();
  });

  it('is served where the code a business pastes points', () => {
    // The module writes the address into the embed code; the transport serves it there.
    expect(WEBCHAT_SCRIPT_URL).toBe(WEBCHAT_SCRIPT_PATH);
  });

  it('answers 304 to a browser that already has this build', async () => {
    const { app } = await start({ script });
    const answer = await app.inject({
      method: 'GET',
      url: WEBCHAT_SCRIPT_URL,
      headers: { 'if-none-match': '"abc"' },
    });
    expect(answer.statusCode).toBe(304);
    expect(answer.body).toBe('');
    const other = await app.inject({
      method: 'GET',
      url: WEBCHAT_SCRIPT_URL,
      headers: { 'if-none-match': '"old"' },
    });
    expect(other.statusCode).toBe(200);
  });

  it('is not there when the widget was not built, and the API still answers', async () => {
    const { app, call } = await start();
    expect((await app.inject({ method: 'GET', url: WEBCHAT_SCRIPT_URL })).statusCode).toBe(404);
    expect((await call({ method: 'GET', url: BASE })).statusCode).toBe(200);
  });

  it('loads a built file with an entity tag of its bytes, or nothing when there is none', () => {
    expect(loadWidgetScript(new URL('./no-such-file.js', import.meta.url))).toBeUndefined();
    const loaded = loadWidgetScript(new URL('./strings.ts', import.meta.url));
    expect(loaded?.body.length).toBeGreaterThan(0);
    expect(loaded?.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });
});

it('lives beside the public booking routes without taking them over', async () => {
  const { app, call } = await start({ booking: true });
  expect((await call({ method: 'GET', url: BASE })).statusCode).toBe(200);
  // A booking path is still the booking scope's: its own answer, and no web chat gate.
  const booking = await app.inject({ method: 'GET', url: '/api/v1/public/appointments/short' });
  expect(booking.json()).toMatchObject({ detail: expect.stringContaining('booking') as string });
  expect(corsHeaders(booking.headers)).toEqual([]);
});
