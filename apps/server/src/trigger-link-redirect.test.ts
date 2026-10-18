// The public address of a trigger link as a transport, with what opens a link and what
// limits it stood in for: where it sends the browser, what it answers when there is nothing
// to open, when it is limited and when something fails, and what it never says. The click
// itself is proved against Postgres in conversation-extras-http.int.test.ts.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { PublicBookingRateLimit } from './public-booking.js';
import { redactedRequestUrl } from './sensitive-paths.js';
import { registerTriggerLinkRedirect } from './trigger-link-redirect.js';

const TOKEN = 'A'.repeat(43);
const DESTINATION = 'https://harbor.example/offer?utm=spring&next=/thanks#top';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function serving(
  options: {
    open?: (token: string, requestId: string) => Promise<string | undefined>;
    rateLimit?: PublicBookingRateLimit;
  } = {},
) {
  const opened: string[] = [];
  const app = Fastify();
  await registerTriggerLinkRedirect(app, {
    open: (token, requestId) => {
      opened.push(token);
      return options.open === undefined
        ? Promise.resolve(token === TOKEN ? DESTINATION : undefined)
        : options.open(token, requestId);
    },
    rateLimit: options.rateLimit,
  });
  apps.push(app);
  return { app, opened };
}

describe('the public address of a trigger link', () => {
  it('redirects to what opening the token gave, exactly as given, and keeps the answer private', async () => {
    const { app, opened } = await serving();
    const response = await app.inject({ method: 'GET', url: `/l/${TOKEN}` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(DESTINATION);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(opened).toEqual([TOKEN]);
  });

  it('takes the destination from the token alone: no query or header moves it', async () => {
    const { app } = await serving();
    const response = await app.inject({
      method: 'GET',
      url: `/l/${TOKEN}?url=https://evil.example/&next=//evil.example`,
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(DESTINATION);
  });

  it('answers a plain 404 when there is nothing to open, for any path or method under it', async () => {
    const { app } = await serving();
    const unknown = await app.inject({ method: 'GET', url: `/l/${'B'.repeat(43)}` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['content-type']).toContain('text/plain');
    expect(unknown.body).toBe('This link cannot be used.');
    expect(unknown.headers.location).toBeUndefined();
    expect(unknown.headers['cache-control']).toBe('no-store');
    for (const [method, url] of [
      ['GET', '/l/'],
      ['GET', `/l/${TOKEN}/more`],
      ['POST', `/l/${TOKEN}`],
      ['DELETE', `/l/${TOKEN}`],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.body).toBe(unknown.body);
      expect(response.headers.location).toBeUndefined();
    }
  });

  it('answers a plain 500, with nothing of the error, when opening fails', async () => {
    const { app } = await serving({
      open: (token) => Promise.reject(new Error(`relation missing while reading ${token}`)),
    });
    const response = await app.inject({ method: 'GET', url: `/l/${TOKEN}` });
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('This link could not be opened. Try again later.');
    expect(response.body).not.toContain(TOKEN);
    expect(response.headers.location).toBeUndefined();
  });

  it('opens nothing for a request the limiter refuses, and says when to come back', async () => {
    const seen: string[] = [];
    const { app, opened } = await serving({
      rateLimit: (request, operation) => {
        seen.push(`${operation} ${request.ipAddress}`);
        return Promise.resolve({ allowed: false, retryAfterSeconds: 42 });
      },
    });
    const response = await app.inject({ method: 'GET', url: `/l/${TOKEN}` });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
    expect(response.headers.location).toBeUndefined();
    expect(opened).toEqual([]);
    // A click writes, so it is counted against the smaller quota.
    expect(seen).toEqual(['write 127.0.0.1']);
  });

  it('lets a request the limiter allows through', async () => {
    const { app, opened } = await serving({
      rateLimit: () => Promise.resolve({ allowed: true }),
    });
    expect((await app.inject({ method: 'GET', url: `/l/${TOKEN}` })).statusCode).toBe(302);
    expect(opened).toEqual([TOKEN]);
  });

  it.each([
    ['fails', () => Promise.reject(new Error('down'))],
    ['answers a wait of no time', () => Promise.resolve({ allowed: false, retryAfterSeconds: 0 })],
    [
      'answers a wait that is not a number of seconds',
      () => Promise.resolve({ allowed: false, retryAfterSeconds: 1.5 }),
    ],
  ] as const)('answers 503 and opens nothing when the limiter %s', async (_name, rateLimit) => {
    const { app, opened } = await serving({ rateLimit });
    const response = await app.inject({ method: 'GET', url: `/l/${TOKEN}` });
    expect(response.statusCode).toBe(503);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['retry-after']).toBeUndefined();
    expect(opened).toEqual([]);
  });
});

describe('a trigger link’s token in a logged address', () => {
  it('is replaced, whatever follows /l', () => {
    for (const url of [`/l/${TOKEN}`, `/l/${TOKEN}?x=1`, '/l', '/l/', `/l/%41${TOKEN}`])
      expect(redactedRequestUrl(url), url).toBe('/l/[redacted]');
    expect(redactedRequestUrl(`https://crm.example/l/${TOKEN}`)).toBe('/l/[redacted]');
  });

  it('leaves other addresses that start with the same letter alone', () => {
    for (const url of ['/login', '/leads/1', '/api/v1/trigger-links', '/b/harbor/l/x'])
      expect(redactedRequestUrl(url), url).toBe(url);
  });
});
