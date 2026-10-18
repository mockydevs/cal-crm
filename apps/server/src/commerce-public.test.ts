import { Readable, Writable } from 'node:stream';
import { allowEveryone } from '@repo/commands';
import { connectDatabase } from '@repo/db';
import { DOCUMENT_PAGE_POLICY, type PublicDocumentHandlers } from '@repo/module-commerce';
import { pino } from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { loggerOptions } from './logger.js';
import type { PublicBookingRateLimit } from './public-booking.js';
import { buildServer, type Server } from './server.js';

const token = Buffer.alloc(32, 11).toString('base64url');
const path = `/d/${token}`;
const documentHtml = '<!doctype html><title>Quote Q-0007</title><p>Harbor Lights Events</p>';
const unavailableHtml = '<!doctype html><p>This document is no longer available.</p>';
const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.7 synthetic quote'));
const logoBytes = Buffer.from('synthetic-png-bytes');
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
const privateHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};
const servers: Server[] = [];
const databases: ReturnType<typeof connectDatabase>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function start() {
  const handlers: PublicDocumentHandlers = {
    page: vi
      .fn<PublicDocumentHandlers['page']>()
      .mockResolvedValue({ outcome: 'ok', value: documentHtml }),
    pdf: vi.fn<PublicDocumentHandlers['pdf']>().mockResolvedValue({
      outcome: 'ok',
      value: { content: pdfBytes, contentType: 'application/pdf', filename: 'Quote Q-0007 é.pdf' },
    }),
    logo: vi.fn<PublicDocumentHandlers['logo']>().mockImplementation(() =>
      Promise.resolve({
        outcome: 'ok',
        value: {
          contentType: 'image/png',
          size: logoBytes.byteLength,
          body: Readable.from([logoBytes]),
        },
      }),
    ),
    answer: vi
      .fn<PublicDocumentHandlers['answer']>()
      .mockResolvedValue({ outcome: 'ok', value: { answered: true, html: documentHtml } }),
    unavailable: vi.fn<PublicDocumentHandlers['unavailable']>().mockReturnValue(unavailableHtml),
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
    publicDocuments: { handlers, rateLimit },
  });
  servers.push(server);
  return { app: server.app, handlers, rateLimit, logs };
}

const form = { 'content-type': 'application/x-www-form-urlencoded' };

it('shows the document behind a good address to anyone, as a page that runs and loads nothing', async () => {
  const { app, handlers, rateLimit } = await start();
  const response = await app.inject({
    url: path,
    remoteAddress: '192.0.2.8',
    headers: {
      'user-agent': 'Customer Browser/1.0',
      'x-request-id': 'client-chosen',
      'x-forwarded-for': '198.51.100.1',
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(response.body).toBe(documentHtml);
  expect(response.headers['content-security-policy']).toBe(DOCUMENT_PAGE_POLICY);
  expect(response.headers).toMatchObject(privateHeaders);
  // The token is the whole request: who asks is what the server saw, not what was sent.
  const requestId = response.headers['x-request-id'];
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(handlers.page).toHaveBeenCalledExactlyOnceWith(token, {
    requestId,
    ipAddress: '192.0.2.8',
    userAgent: 'Customer Browser/1.0',
  });
  expect(rateLimit).toHaveBeenCalledExactlyOnceWith({ requestId, ipAddress: '192.0.2.8' }, 'read');
});

it("keeps at most 500 characters of a browser's name for itself", async () => {
  const { app, handlers } = await start();
  await app.inject({ url: path, headers: { 'user-agent': 'a'.repeat(499) + 'bcd' } });
  expect(vi.mocked(handlers.page).mock.calls[0]?.[1].userAgent).toBe('a'.repeat(499) + 'b');
});

it.each([
  { outcome: 'unknown' as const, status: 404 },
  { outcome: 'gone' as const, status: 410 },
])(
  'answers an address that opens nothing ($outcome) with the one plain page, whatever was asked for',
  async ({ outcome, status }) => {
    const { app, handlers } = await start();
    vi.mocked(handlers.page).mockResolvedValue({ outcome });
    vi.mocked(handlers.pdf).mockResolvedValue({ outcome });
    vi.mocked(handlers.logo).mockResolvedValue({ outcome });
    vi.mocked(handlers.answer).mockResolvedValue({ outcome });
    const responses = [
      await app.inject(path),
      await app.inject(`${path}/pdf`),
      await app.inject(`${path}/logo`),
      await app.inject({ method: 'POST', url: `${path}/accept`, headers: form, payload: '' }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(status);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.body).toBe(unavailableHtml);
      expect(response.headers['content-security-policy']).toBe(DOCUMENT_PAGE_POLICY);
      expect(response.headers).toMatchObject(privateHeaders);
      expect(response.headers.location).toBeUndefined();
    }
  },
);

it('downloads the PDF under its own name, as a file a browser may not run anything from', async () => {
  const { app, handlers } = await start();
  const response = await app.inject(`${path}/pdf`);
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('application/pdf');
  expect(response.headers['content-length']).toBe(String(pdfBytes.byteLength));
  expect(response.headers['content-disposition']).toBe(
    `attachment; filename="Quote Q-0007 _.pdf"; filename*=UTF-8''Quote%20Q-0007%20%C3%A9.pdf`,
  );
  expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(response.headers).toMatchObject(privateHeaders);
  expect(response.rawPayload.equals(Buffer.from(pdfBytes))).toBe(true);
  expect(vi.mocked(handlers.pdf).mock.calls[0]?.[0]).toBe(token);
  expect(handlers.page).not.toHaveBeenCalled();
});

it("streams the seller's logo for the page's own image", async () => {
  const { app, handlers } = await start();
  const response = await app.inject(`${path}/logo`);
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('image/png');
  expect(response.headers['content-length']).toBe(String(logoBytes.byteLength));
  expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(response.headers).toMatchObject(privateHeaders);
  expect(response.rawPayload.equals(logoBytes)).toBe(true);
  expect(vi.mocked(handlers.logo).mock.calls[0]?.[0]).toBe(token);
});

it.each(['accept', 'decline'] as const)(
  "takes a customer's answer (%s) from the path alone and sends them back to the page",
  async (answer) => {
    const { app, handlers, rateLimit } = await start();
    const response = await app.inject({
      method: 'POST',
      url: `${path}/${answer}`,
      remoteAddress: '192.0.2.8',
      headers: { ...form, 'user-agent': 'Customer Browser/1.0' },
      // Nothing a form posts is read: neither another answer nor another document.
      payload: 'answer=decline&documentId=forged&contactId=forged',
    });
    // 303, so reloading the page never posts the answer again.
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(path);
    expect(response.headers).toMatchObject(privateHeaders);
    expect(handlers.answer).toHaveBeenCalledExactlyOnceWith(token, answer, {
      requestId: response.headers['x-request-id'],
      ipAddress: '192.0.2.8',
      userAgent: 'Customer Browser/1.0',
    });
    expect(rateLimit.mock.calls[0]?.[1]).toBe('write');
  },
);

it('shows why an answer was refused on the page itself, without a redirect', async () => {
  const { app, handlers } = await start();
  const refusedHtml = '<!doctype html><p>This quote has expired.</p>';
  vi.mocked(handlers.answer).mockResolvedValue({
    outcome: 'ok',
    value: { answered: false, html: refusedHtml },
  });
  const response = await app.inject({
    method: 'POST',
    url: `${path}/accept`,
    headers: form,
    payload: '',
  });
  expect(response.statusCode).toBe(409);
  expect(response.body).toBe(refusedHtml);
  expect(response.headers['content-security-policy']).toBe(DOCUMENT_PAGE_POLICY);
  expect(response.headers.location).toBeUndefined();
});

it('takes no answer but accept and decline, and no other way of asking', async () => {
  const { app, handlers } = await start();
  for (const request of [
    { method: 'POST' as const, url: `${path}/approve`, headers: form, payload: '' },
    { method: 'POST' as const, url: `${path}/pdf`, headers: form, payload: '' },
    { method: 'POST' as const, url: path, headers: form, payload: '' },
    { method: 'GET' as const, url: `${path}/accept` },
    { method: 'GET' as const, url: `${path}/pdf/extra` },
    { method: 'HEAD' as const, url: path },
    { method: 'DELETE' as const, url: path },
  ]) {
    const response = await app.inject(request);
    expect(response.statusCode).toBe(404);
    if (request.method !== 'HEAD') expect(response.body).toBe(unavailableHtml);
    expect(response.headers).toMatchObject(privateHeaders);
  }
  for (const handler of [handlers.page, handlers.pdf, handlers.logo, handlers.answer])
    expect(handler).not.toHaveBeenCalled();
});

it('refuses a body of another kind or size before an answer is taken', async () => {
  const { app, handlers, logs } = await start();
  for (const [headers, payload, status] of [
    [{ 'content-type': 'application/json' }, '{"answer":"accept"}', 415],
    [form, `note=${'x'.repeat(2000)}`, 413],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: `${path}/accept`, headers, payload });
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.body).toBe('This request cannot be read.');
    expect(response.headers).toMatchObject(privateHeaders);
  }
  expect(handlers.answer).not.toHaveBeenCalled();
  expect(logs.join('')).not.toContain(token);
});

it('fails closed when the address is rate-limited or the limiter cannot answer', async () => {
  const { app, handlers, rateLimit, logs } = await start();
  rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 37 });
  const limited = await app.inject(path);
  expect(limited.statusCode).toBe(429);
  expect(limited.headers['retry-after']).toBe('37');
  expect(limited.headers['content-type']).toBe('text/plain; charset=utf-8');
  expect(limited.body).toBe('Too many requests. Try again in a minute.');
  expect(limited.headers).toMatchObject(privateHeaders);

  rateLimit.mockRejectedValueOnce(new Error(`limiter secret ${token}`));
  // A refusal that does not say when to come back is not a decision to act on.
  rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 0 });
  for (const request of [
    { method: 'GET' as const, url: `${path}/pdf` },
    { method: 'POST' as const, url: `${path}/accept`, headers: form, payload: '' },
  ]) {
    const unavailable = await app.inject(request);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).toBe('This document is temporarily unavailable. Try again later.');
    expect(unavailable.headers).toMatchObject(privateHeaders);
  }
  for (const handler of [handlers.page, handlers.pdf, handlers.logo, handlers.answer])
    expect(handler).not.toHaveBeenCalled();
  expect(logs.join('')).not.toContain(token);
});

it("keeps the token and an error's own words out of the answer and the log", async () => {
  const { app, handlers, logs } = await start();
  vi.mocked(handlers.page).mockRejectedValue(new Error(`relation private_table, token ${token}`));
  const response = await app.inject(path);
  expect(response.statusCode).toBe(500);
  expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
  expect(response.body).toBe('This document could not be opened. Try again later.');
  expect(response.headers).toMatchObject(privateHeaders);
  const logged = logs.join('');
  expect(logged).toContain('Public document request failed');
  expect(logged).not.toContain(token);
  expect(logged).not.toContain('private_table');
});

it('mounts no public document address for a role that does not serve the API', async () => {
  const handlers: PublicDocumentHandlers = {
    page: vi.fn<PublicDocumentHandlers['page']>(),
    pdf: vi.fn<PublicDocumentHandlers['pdf']>(),
    logo: vi.fn<PublicDocumentHandlers['logo']>(),
    answer: vi.fn<PublicDocumentHandlers['answer']>(),
    unavailable: vi.fn<PublicDocumentHandlers['unavailable']>(),
  };
  const rateLimit = vi.fn<PublicBookingRateLimit>().mockResolvedValue({ allowed: true });
  const db = connectDatabase({
    connectionString: config.databaseAppUrl,
    onConnectionError: () => undefined,
  });
  databases.push(db);
  const server = await buildServer({
    config: { ...config, role: 'worker' },
    logger: pino({ level: 'silent' }),
    serveApi: false,
    routes: [],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
    publicDocuments: { handlers, rateLimit },
  });
  servers.push(server);
  const response = await server.app.inject(path);
  expect(response.statusCode).toBe(404);
  expect(response.body).not.toContain(token);
  expect(handlers.page).not.toHaveBeenCalled();
  expect(rateLimit).not.toHaveBeenCalled();
});
