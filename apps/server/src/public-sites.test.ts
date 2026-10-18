import { once } from 'node:events';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { allowEveryone } from '@repo/commands';
import { connectDatabase } from '@repo/db';
import type { PublicSiteHandlers, ServedSitePage } from '@repo/module-sites';
import { pino } from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { loggerOptions } from './logger.js';
import type { PublicBookingRateLimit } from './public-booking.js';
import { createIntakeScopes } from './public-intake-limit.js';
import {
  chooseCoding,
  NOT_FOUND_PAGE,
  type PublicSiteTransport,
  type ServedSiteVisit,
} from './public-sites.js';
import { redactedRequestUrl } from './sensitive-paths.js';
import { buildServer, type Server } from './server.js';

const key = 'ab'.repeat(16);
const token = `${'A'.repeat(70)}.${'B'.repeat(22)}`;
const POLICY =
  "default-src 'none'; style-src 'sha256-abc='; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BARE = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HTML = `<!doctype html><title>Landing</title><h1>Welcome</h1>${'<p>Words that repeat.</p>'.repeat(40)}`;
const VIEW = {
  businessId: '01890f3e-7b1c-7cc0-8a51-000000000001',
  siteId: '01890f3e-7b1c-7cc0-8a51-000000000002',
  stepId: '01890f3e-7b1c-7cc0-8a51-000000000003',
  pageId: '01890f3e-7b1c-7cc0-8a51-000000000004',
};
const served: ServedSitePage = {
  html: HTML,
  body: Buffer.from(HTML, 'utf8'),
  etag: '"tag-of-these-bytes"',
  policy: POLICY,
  headers: [],
  view: VIEW,
};
const BR = '"tag-of-these-bytes.br"';
const GZ = '"tag-of-these-bytes.gz"';
const config: Config = {
  nodeEnv: 'test',
  role: 'app',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'info',
  databaseAppUrl: 'postgres://crm_app@127.0.0.1:1/crm',
  databaseWorkerUrl: undefined,
  databasePoolSize: 1,
  shutdownTimeoutMs: 1000,
  dashboardDir: undefined,
  devTenantContext: undefined,
  publicUrl: 'https://crm.example.test',
  authentication: undefined,
  mail: undefined,
  trustProxy: [],
  files: undefined,
  vault: undefined,
};
const servers: Server[] = [];
const databases: ReturnType<typeof connectDatabase>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function start(mounted = true, over: Partial<PublicSiteTransport> = {}) {
  const handlers = {
    page: vi.fn<PublicSiteHandlers['page']>().mockResolvedValue(served),
    preview: vi.fn<PublicSiteHandlers['preview']>().mockResolvedValue(served),
  };
  const rateLimit = vi.fn<PublicBookingRateLimit>().mockResolvedValue({ allowed: true });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  const db = connectDatabase({
    connectionString: config.databaseAppUrl,
    onConnectionError: () => undefined,
  });
  databases.push(db);
  const server = await buildServer({
    config,
    logger: pino(loggerOptions(config), stream),
    serveApi: true,
    routes: [],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
    ...(mounted ? { publicSites: { handlers, rateLimit, ...over } } : {}),
  });
  servers.push(server);
  return { app: server.app, handlers, rateLimit, logs };
}

it('shows a published page to anyone, with the page’s own policy and nothing a browser may keep unasked', async () => {
  const { app, handlers, rateLimit } = await start();
  const response = await app.inject({
    url: `/s/${key}/offers/spring?utm_source=mail`,
    remoteAddress: '192.0.2.8',
    headers: { cookie: 'session=abc' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(response.body).toBe(served.html);
  expect(response.headers).toMatchObject({
    'content-security-policy': POLICY,
    'cache-control': 'public, max-age=0, must-revalidate, no-transform',
    etag: served.etag,
    vary: 'Accept-Encoding',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  // No cookie is ever set here, and the one a browser sent is no part of the request.
  expect(response.headers['set-cookie']).toBeUndefined();
  const requestId = response.headers['x-request-id'];
  expect(handlers.page).toHaveBeenCalledExactlyOnceWith(key, 'offers/spring', { requestId });
  expect(rateLimit).toHaveBeenCalledExactlyOnceWith({ requestId, ipAddress: '192.0.2.8' }, 'read');
  // No coding was asked for, so none is used.
  expect(response.headers['content-encoding']).toBeUndefined();
});

it('counts a site’s pages toward its business once it has served one, and never a key that shows nothing', async () => {
  const { app, handlers, rateLimit } = await start();
  await app.inject({ url: `/s/${key}/landing`, remoteAddress: '192.0.2.8' });
  await app.inject({ url: `/s/${key}`, remoteAddress: '192.0.2.9' });
  const other = 'f'.repeat(32);
  handlers.page.mockResolvedValue(undefined);
  await app.inject({ url: `/s/${other}/landing`, remoteAddress: '192.0.2.8' });
  await app.inject({ url: `/s/${other}/landing`, remoteAddress: '192.0.2.8' });
  expect(
    rateLimit.mock.calls.map(([request]) => ({
      ipAddress: request.ipAddress,
      businessId: request.businessId,
    })),
  ).toEqual([
    // The first request for a key: which business it is for is not known yet.
    { ipAddress: '192.0.2.8', businessId: undefined },
    { ipAddress: '192.0.2.9', businessId: VIEW.businessId },
    { ipAddress: '192.0.2.8', businessId: undefined },
    { ipAddress: '192.0.2.8', businessId: undefined },
  ]);
  // And no key at all for a business that is not known: the limiter is told nothing.
  expect(rateLimit.mock.calls[0]?.[0]).not.toHaveProperty('businessId');
  // What one transport learned, another given the same memory knows.
  const scopes = createIntakeScopes();
  scopes.learn(key, VIEW.businessId);
  const second = await start(true, { scopes });
  await second.app.inject({ url: `/s/${key}/landing`, remoteAddress: '192.0.2.8' });
  expect(second.rateLimit.mock.calls[0]?.[0]).toMatchObject({ businessId: VIEW.businessId });
});

it('compresses a page for a browser that asks, once for each coding, under a tag of its own', async () => {
  const { app } = await start();
  const ask = (accept: string) =>
    app.inject({ url: `/s/${key}/landing`, headers: { 'accept-encoding': accept } });
  const brotli = await ask('gzip, deflate, br, zstd');
  expect(brotli.statusCode).toBe(200);
  expect(brotli.headers).toMatchObject({
    'content-encoding': 'br',
    'content-type': 'text/html; charset=utf-8',
    vary: 'Accept-Encoding',
    etag: BR,
    'content-length': String(brotli.rawPayload.byteLength),
  });
  expect(brotliDecompressSync(brotli.rawPayload).toString()).toBe(HTML);
  expect(brotli.rawPayload.byteLength).toBeLessThan(served.body.byteLength / 2);
  const zipped = await ask('gzip, deflate');
  expect(zipped.headers).toMatchObject({ 'content-encoding': 'gzip', etag: GZ });
  expect(gunzipSync(zipped.rawPayload).toString()).toBe(HTML);
  // The same bytes the second time: they were made once and kept with the page.
  expect((await ask('br')).rawPayload.equals(brotli.rawPayload)).toBe(true);
  // A browser that takes neither is sent the page as it is, and a cache is still told why.
  const plain = await ask('deflate, identity');
  expect(plain.headers['content-encoding']).toBeUndefined();
  expect(plain.headers).toMatchObject({ vary: 'Accept-Encoding', etag: served.etag });
  expect(plain.body).toBe(HTML);
});

it('chooses the coding a browser weighs highest and does not refuse', () => {
  expect(chooseCoding(undefined)).toBe('identity');
  expect(chooseCoding(['br'])).toBe('identity');
  expect(chooseCoding('')).toBe('identity');
  expect(chooseCoding('br')).toBe('br');
  expect(chooseCoding('gzip')).toBe('gzip');
  expect(chooseCoding('GZIP , BR')).toBe('br');
  expect(chooseCoding('br;q=0.5, gzip;q=0.9')).toBe('gzip');
  expect(chooseCoding('br;q=0, gzip')).toBe('gzip');
  expect(chooseCoding('br;q=0, gzip;q=0')).toBe('identity');
  expect(chooseCoding('*')).toBe('br');
  expect(chooseCoding('*;q=0.3, gzip;q=0.2')).toBe('br');
  expect(chooseCoding('br;q=0, *')).toBe('gzip');
  expect(chooseCoding('identity, *;q=0')).toBe('identity');
  expect(chooseCoding('deflate, zstd')).toBe('identity');
  // A weight that is not one is no weight at all.
  expect(chooseCoding('br;q=2, gzip;q=0.001')).toBe('gzip');
  expect(chooseCoding('br;q=high')).toBe('identity');
  expect(chooseCoding('br;level=4;q=1.000')).toBe('br');
});

it('lets a shared cache answer by itself only for as long as the operator says', async () => {
  const { app } = await start(true, { sharedCacheSeconds: 60 });
  const response = await app.inject(`/s/${key}/landing`);
  expect(response.headers['cache-control']).toBe(
    'public, max-age=0, s-maxage=60, must-revalidate, no-transform',
  );
  const held = await app.inject({
    url: `/s/${key}/landing`,
    headers: { 'if-none-match': served.etag },
  });
  expect(held.statusCode).toBe(304);
  expect(held.headers['cache-control']).toBe(
    'public, max-age=0, s-maxage=60, must-revalidate, no-transform',
  );
  // A preview and an address that shows nothing are never kept by anyone, whatever is set.
  expect((await app.inject(`/s/_preview/${token}`)).headers['cache-control']).toBe(
    'no-store, no-transform',
  );
  expect((await app.inject('/s/nothing')).headers['cache-control']).toBe('no-store');
  for (const sharedCacheSeconds of [-1, 1.5, 301, Number.NaN])
    await expect(start(true, { sharedCacheSeconds })).rejects.toThrow(/0 to 300 seconds/);
});

it('tells who counts views after the response has gone, waits for nothing, and survives its failure', async () => {
  const visits: ServedSiteVisit[] = [];
  let behaviour: 'record' | 'throw' | 'reject' | 'hang' = 'record';
  const { app, handlers, logs } = await start(true, {
    onServed: (visit) => {
      visits.push(visit);
      if (behaviour === 'throw') throw new Error('the counter is broken');
      if (behaviour === 'reject') return Promise.reject(new Error('the counter is down'));
      // Never settles: a response that waited for it would never be sent.
      if (behaviour === 'hang') return new Promise(() => undefined);
      return undefined;
    },
  });
  const get = (headers: Record<string, string> = {}) =>
    app.inject({ url: `/s/${key}/landing`, headers });
  expect((await get()).statusCode).toBe(200);
  await delay(0);
  expect(visits).toEqual([{ ...VIEW, notModified: false }]);
  // A browser that already held the page visited it too, and is told apart.
  expect((await get({ 'if-none-match': served.etag })).statusCode).toBe(304);
  await delay(0);
  expect(visits[1]).toEqual({ ...VIEW, notModified: true });

  for (const failing of ['throw', 'reject', 'hang'] as const) {
    behaviour = failing;
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(HTML);
  }
  await delay(0);
  expect(visits).toHaveLength(5);
  expect(logs.join('').match(/Counting a site page view failed/g)).toHaveLength(2);
  expect(logs.join('')).not.toContain('the counter is');

  // Nobody viewed anything: a HEAD, a preview, a page that is not there, a refusal.
  behaviour = 'record';
  await app.inject({ method: 'HEAD', url: `/s/${key}/landing` });
  await app.inject(`/s/_preview/${token}`);
  await app.inject({ method: 'POST', url: `/s/${key}/landing` });
  handlers.page.mockResolvedValue(undefined);
  await get();
  handlers.page.mockResolvedValue({ ...served, view: undefined });
  await get();
  await delay(0);
  expect(visits).toHaveLength(5);
});

it('is told of a view only once the page has been sent', async () => {
  // Fastify runs an onResponse hook "when a response has been sent" (its Hooks reference),
  // and that is where a view is told. Shown here from the outside: the counter holds this
  // whole thread for a second and a half, and a browser in a thread of its own still has
  // the whole page long before that is over, so the page had left before the counter began.
  const HELD_MS = 1500;
  let counted = 0;
  const { app } = await start(true, {
    onServed: () => {
      counted += 1;
      const until = Date.now() + HELD_MS;
      while (Date.now() < until);
    },
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const browser = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const started = Date.now();
     require('node:http').get(workerData, (response) => {
       let bytes = 0;
       response.on('data', (chunk) => { bytes += chunk.length; });
       response.on('end', () => parentPort.postMessage(
         { status: response.statusCode, bytes, ms: Date.now() - started }));
     });`,
    { eval: true, workerData: `${address}/s/${key}/landing` },
  );
  try {
    const [seen] = (await once(browser, 'message')) as [
      { status: number; bytes: number; ms: number },
    ];
    expect(seen).toMatchObject({ status: 200, bytes: served.body.byteLength });
    expect(seen.ms).toBeLessThan(HELD_MS - 500);
    expect(counted).toBe(1);
  } finally {
    await browser.terminate();
  }
});

it('shows the site’s own address with or without a slash after its key', async () => {
  const { app, handlers } = await start();
  for (const url of [`/s/${key}`, `/s/${key}/`, `/s/${key}?a=1`]) {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
  }
  expect(handlers.page.mock.calls.map(([, path]) => path)).toEqual(['', '', '']);
});

it('answers a visitor who holds the same bytes with 304 and no page', async () => {
  const { app } = await start();
  // The page in any coding is the same page: a tag a proxy weakened, or the tag of the
  // bytes another browser was sent, still says the visitor holds it.
  for (const held of [
    served.etag,
    `W/${served.etag}`,
    `"other", ${served.etag}`,
    '*',
    BR,
    `W/${GZ}`,
  ]) {
    const response = await app.inject({
      url: `/s/${key}/landing`,
      headers: { 'if-none-match': held },
    });
    expect(response.statusCode).toBe(304);
    expect(response.body).toBe('');
    expect(response.headers).toMatchObject({
      etag: served.etag,
      vary: 'Accept-Encoding',
      'cache-control': 'public, max-age=0, must-revalidate, no-transform',
      'content-security-policy': POLICY,
    });
    expect(response.headers['content-encoding']).toBeUndefined();
  }
  // The tag sent back is the one a page would carry for this request (RFC 9110, 15.4.5).
  const coded = await app.inject({
    url: `/s/${key}/landing`,
    headers: { 'if-none-match': served.etag, 'accept-encoding': 'br' },
  });
  expect(coded.statusCode).toBe(304);
  expect(coded.headers.etag).toBe(BR);
  expect(coded.headers['content-encoding']).toBeUndefined();
  const changed = await app.inject({
    url: `/s/${key}/landing`,
    headers: { 'if-none-match': '"an-older-tag"' },
  });
  expect(changed.statusCode).toBe(200);
  expect(changed.body).toBe(served.html);
});

it('answers HEAD as GET, without the page', async () => {
  const { app, handlers } = await start();
  const response = await app.inject({ method: 'HEAD', url: `/s/${key}/landing` });
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe('');
  expect(response.headers).toMatchObject({
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(served.html)),
    etag: served.etag,
    'content-security-policy': POLICY,
  });
  expect(handlers.page).toHaveBeenCalledOnce();
  const coded = await app.inject({
    method: 'HEAD',
    url: `/s/${key}/landing`,
    headers: { 'accept-encoding': 'gzip' },
  });
  expect(coded.body).toBe('');
  expect(coded.headers).toMatchObject({ 'content-encoding': 'gzip', etag: GZ });
  const held = await app.inject({
    method: 'HEAD',
    url: `/s/${key}/landing`,
    headers: { 'if-none-match': GZ },
  });
  expect(held.statusCode).toBe(304);
  const missing = await app.inject({ method: 'HEAD', url: '/s/nothing' });
  expect(missing.statusCode).toBe(404);
  expect(missing.body).toBe('');
});

it('sends a site’s own headers the module chose, and never lets one replace the page’s policy', async () => {
  const { app, handlers } = await start();
  handlers.page.mockResolvedValue({
    ...served,
    headers: [
      { name: 'referrer-policy', value: 'no-referrer' },
      { name: 'permissions-policy', value: 'camera=()' },
      // The module sends no such header; if one came, the page's own would still stand.
      { name: 'content-security-policy', value: 'default-src *' },
    ],
  });
  const response = await app.inject(`/s/${key}/landing`);
  expect(response.headers).toMatchObject({
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=()',
    'content-security-policy': POLICY,
  });
});

it('answers every address that shows nothing with the same page, and looks up only what could be one', async () => {
  const { app, handlers } = await start();
  handlers.page.mockResolvedValue(undefined);
  handlers.preview.mockResolvedValue(undefined);
  const responses = [
    await app.inject(`/s/${key}/landing`),
    await app.inject(`/s/${key}`),
    await app.inject(`/s/_preview/${token}`),
  ];
  expect(handlers.page).toHaveBeenCalledTimes(2);
  expect(handlers.preview).toHaveBeenCalledOnce();
  // What cannot be a key, a path or a link is not looked up at all.
  responses.push(
    await app.inject('/s'),
    await app.inject('/s/'),
    await app.inject('/s/short/landing'),
    await app.inject(`/s/${key.toUpperCase()}/landing`),
    await app.inject(`/s/${key}/Landing`),
    await app.inject(`/s/${key}/a//b`),
    await app.inject(`/s/${key}/landing/`),
    await app.inject(`/s/${key}/..%2f..%2fapi/v1/me`),
    await app.inject(`/s/${key}/${'a'.repeat(201)}`),
    await app.inject('/s/_preview/not-a-token'),
    await app.inject('/s/_preview'),
    await app.inject(`/s/_preview/${token}/more`),
  );
  expect(handlers.page).toHaveBeenCalledTimes(2);
  expect(handlers.preview).toHaveBeenCalledOnce();
  for (const response of responses) {
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(NOT_FOUND_PAGE);
    expect(response.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': BARE,
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
    });
    expect(response.headers.etag).toBeUndefined();
  }
});

it('serves a long nested path, as a step may have one', async () => {
  const { app, handlers } = await start();
  const path = `${'a'.repeat(99)}/${'b'.repeat(100)}`;
  expect((await app.inject(`/s/${key}/${path}`)).statusCode).toBe(200);
  expect(handlers.page).toHaveBeenCalledExactlyOnceWith(key, path, expect.anything());
});

it('shows a preview to whoever holds its link, never stored and never told to another website', async () => {
  const { app, handlers, logs } = await start();
  handlers.preview.mockResolvedValue({
    ...served,
    policy: POLICY.replace("'none'", "'self'"),
    headers: [{ name: 'referrer-policy', value: 'unsafe-url' }],
  });
  const response = await app.inject({
    url: `/s/_preview/${token}`,
    headers: { 'if-none-match': served.etag },
  });
  // Never 304: a preview has no validator, and every look reads the draft again.
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe(served.html);
  expect(response.headers).toMatchObject({
    'cache-control': 'no-store, no-transform',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
  });
  expect(response.headers.etag).toBeUndefined();
  expect(handlers.preview).toHaveBeenCalledExactlyOnceWith(token, expect.anything());
  expect(logs.join('')).not.toContain(token);
  expect(logs.join('')).toContain('/s/_preview/[redacted]');
});

it('keeps the token of a page preview out of what is logged, and leaves a site’s own pages as they are', () => {
  for (const path of [
    `/s/_preview/${token}`,
    `/s/_preview/${token}?a=1`,
    '/s/_preview',
    '/s/_preview/',
    '/s/%5Fpreview/anything',
    `https://crm.example.test/s/_preview/${token}`,
  ])
    expect(redactedRequestUrl(path)).toBe('/s/_preview/[redacted]');
  expect(redactedRequestUrl(`/s/${key}/landing`)).toBe(`/s/${key}/landing`);
  expect(redactedRequestUrl('/s/_previews')).toBe('/s/_previews');
  expect(redactedRequestUrl('/settings')).toBe('/settings');
});

it('takes nothing but GET and HEAD, and reads no body', async () => {
  const { app, handlers, rateLimit } = await start();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const response = await app.inject({
      method,
      url: `/s/${key}/landing`,
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    expect(response.statusCode).toBe(405);
    expect(response.body).toBe('This address only shows pages.');
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-security-policy': BARE,
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  }
  expect(handlers.page).not.toHaveBeenCalled();
  expect(rateLimit).not.toHaveBeenCalled();
});

it('counts every request against the shared limit, and fails closed', async () => {
  const { app, handlers, rateLimit, logs } = await start();
  rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 });
  const limited = await app.inject(`/s/${key}/landing`);
  expect(limited.statusCode).toBe(429);
  expect(limited.headers['retry-after']).toBe('17');
  expect(limited.body).toBe('Too many requests. Try again in a minute.');
  expect(limited.headers['cache-control']).toBe('no-store');

  rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 0 });
  expect((await app.inject(`/s/${key}/landing`)).statusCode).toBe(503);
  rateLimit.mockRejectedValueOnce(new Error('database down'));
  const down = await app.inject(`/s/_preview/${token}`);
  expect(down.statusCode).toBe(503);
  expect(down.body).toBe('This page is temporarily unavailable. Try again later.');
  // An address that shows nothing is counted too: guessing keys costs the guesser.
  await app.inject('/s/nothing-here');
  expect(rateLimit).toHaveBeenCalledTimes(4);
  expect(handlers.page).not.toHaveBeenCalled();
  expect(handlers.preview).not.toHaveBeenCalled();
  expect(logs.join('')).toContain('Public sites limiter unavailable');
});

it('says one plain line when a page cannot be read, and logs neither the address nor the error', async () => {
  const { app, handlers, logs } = await start();
  handlers.page.mockRejectedValue(new Error('relation "sites.pages" does not exist'));
  const response = await app.inject(`/s/${key}/landing`);
  expect(response.statusCode).toBe(500);
  expect(response.body).toBe('This page could not be shown. Try again later.');
  expect(response.headers['content-security-policy']).toBe(BARE);
  expect(logs.join('')).toContain('Public site request failed');
  expect(logs.join('')).not.toContain('sites.pages');
  handlers.page.mockRejectedValue(Object.assign(new Error('teapot'), { statusCode: 418 }));
  expect((await app.inject(`/s/${key}/landing`)).statusCode).toBe(418);
});

it('is not mounted without its transport: nothing answers at the address', async () => {
  const { app, handlers } = await start(false);
  for (const url of [`/s/${key}/landing`, `/s/${key}`, `/s/_preview/${token}`]) {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).not.toBe(NOT_FOUND_PAGE);
  }
  expect(handlers.page).not.toHaveBeenCalled();
});

// The small page scripts ------------------------------------------------------------------

const CODE = `(function(){${'var words=1;'.repeat(60)}})();`;
const script = {
  name: 'countdown' as const,
  file: 'countdown.0123456789abcdef.js',
  body: Buffer.from(CODE, 'utf8'),
  etag: '"0123456789abcdef-digest"',
};
const SCRIPT = `/s/_js/${script.file}`;

it('serves a page script at the address its digest names, to be kept for good, and counts nothing', async () => {
  const { app, handlers, rateLimit } = await start(true, { scripts: [script] });
  const response = await app.inject({ url: SCRIPT, headers: { cookie: 'session=abc' } });
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe(CODE);
  expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
  expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(response.headers.etag).toBe(script.etag);
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(response.headers['content-security-policy']).toBe(BARE);
  expect(response.headers.vary).toBe('Accept-Encoding');
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.headers['content-encoding']).toBeUndefined();
  // Bytes this process holds: no limiter, no handler, no database.
  expect(rateLimit).not.toHaveBeenCalled();
  expect(handlers.page).not.toHaveBeenCalled();
  const head = await app.inject({ method: 'HEAD', url: SCRIPT });
  expect(head.statusCode).toBe(200);
  expect(head.body).toBe('');
  expect(head.headers.etag).toBe(script.etag);
});

it('sends a page script compressed to a browser that takes it, each coding under its own tag', async () => {
  const { app } = await start(true, { scripts: [script] });
  const br = await app.inject({ url: SCRIPT, headers: { 'accept-encoding': 'gzip, br' } });
  expect(br.headers['content-encoding']).toBe('br');
  expect(br.headers.etag).toBe('"0123456789abcdef-digest.br"');
  expect(brotliDecompressSync(br.rawPayload).toString('utf8')).toBe(CODE);
  expect(br.rawPayload.byteLength).toBeLessThan(script.body.byteLength);
  const gz = await app.inject({ url: SCRIPT, headers: { 'accept-encoding': 'gzip' } });
  expect(gz.headers['content-encoding']).toBe('gzip');
  expect(gz.headers.etag).toBe('"0123456789abcdef-digest.gz"');
  expect(gunzipSync(gz.rawPayload).toString('utf8')).toBe(CODE);
  // Whoever holds it, in any coding, is sent no bytes.
  for (const held of [
    script.etag,
    '"0123456789abcdef-digest.br"',
    'W/"0123456789abcdef-digest.gz"',
  ]) {
    const again = await app.inject({ url: SCRIPT, headers: { 'if-none-match': held } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  }
});

it('answers nothing for a script this release did not build, and takes no other method', async () => {
  const { app, handlers } = await start(true, { scripts: [script] });
  for (const url of [
    '/s/_js/countdown.ffffffffffffffff.js',
    '/s/_js/countdown.js',
    '/s/_js/popup.0123456789abcdef.js',
    '/s/_js/',
    '/s/_js/a/b.js',
  ]) {
    const response = await app.inject({ url });
    expect(response.statusCode, url).toBe(404);
    expect(response.body).toBe(NOT_FOUND_PAGE);
    expect(response.headers['cache-control']).toBe('no-store');
  }
  const posted = await app.inject({ method: 'POST', url: SCRIPT, payload: 'x' });
  expect(posted.statusCode).toBe(405);
  // Whatever the address, "_js" is no site's key: no page is ever looked up for it.
  expect(handlers.page).not.toHaveBeenCalled();
});

it('has no script address at all where none was built: it is a page that is not there', async () => {
  for (const scripts of [undefined, []]) {
    const { app, handlers } = await start(true, { scripts });
    const response = await app.inject({ url: SCRIPT });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(NOT_FOUND_PAGE);
    // "_js" is no site's key, so nothing is looked up for it.
    expect(handlers.page).not.toHaveBeenCalled();
  }
});
