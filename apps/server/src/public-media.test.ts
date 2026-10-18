import { Readable, Writable } from 'node:stream';

import { allowEveryone } from '@repo/commands';
import { connectDatabase } from '@repo/db';
import type { FoundMedia, FoundPreview, Media } from '@repo/module-files';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { loggerOptions } from './logger.js';
import type { PublicBookingRateLimit } from './public-booking.js';
import { buildServer, type Server } from './server.js';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const FILE = 'file_01h455vb4pex5vsknk084sn02q';
const ETAG = `"${'ab'.repeat(32)}"`;
const bytes = Buffer.from('0123456789abcdefghij');
const SANDBOX = "default-src 'none'; sandbox";

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

function file(overrides: Partial<FoundMedia> = {}): FoundMedia {
  return {
    filename: 'shop front.png',
    contentType: 'image/png',
    size: bytes.length,
    etag: ETAG,
    inline: true,
    open: (range) =>
      Promise.resolve(
        Readable.from([range === undefined ? bytes : bytes.subarray(range.start, range.end + 1)]),
      ),
    ...overrides,
  };
}

const servers: Server[] = [];
const databases: ReturnType<typeof connectDatabase>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function start(
  options: {
    readonly found?: FoundMedia | undefined;
    readonly preview?: FoundPreview;
    readonly limited?: boolean;
  } = {},
) {
  const found = 'found' in options ? options.found : file();
  const media = {
    findPublic: vi.fn<Media['findPublic']>().mockResolvedValue(found),
    findPreview: vi.fn<Media['findPreview']>().mockResolvedValue(options.preview ?? file()),
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
    publicMedia: { media, db, rateLimit: options.limited === false ? undefined : rateLimit },
  });
  servers.push(server);
  return { app: server.app, media, rateLimit, logs, db };
}

describe('a public media address', () => {
  it('answers with the file, its stored type, and headers that let anyone keep it', async () => {
    const { app, media, rateLimit, db } = await start();

    const response = await app.inject({ method: 'GET', url: `/m/${KEY}/anything.png` });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(bytes.length),
      'content-disposition':
        'inline; filename="shop front.png"; filename*=UTF-8\'\'shop%20front.png',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: ETAG,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'content-security-policy': SANDBOX,
      'cross-origin-resource-policy': 'cross-origin',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(media.findPublic).toHaveBeenCalledWith(db, {
      key: KEY,
      correlationId: expect.any(String) as string,
    });
    expect(rateLimit).toHaveBeenCalledWith(
      { requestId: expect.any(String) as string, ipAddress: '127.0.0.1' },
      'read',
    );
  });

  it('downloads a document rather than showing it', async () => {
    const { app } = await start({
      found: file({ filename: 'menu.pdf', contentType: 'application/pdf', inline: false }),
    });

    const response = await app.inject({ method: 'GET', url: `/m/${KEY}/menu.pdf` });

    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="menu.pdf"; filename*=UTF-8\'\'menu.pdf',
    );
    expect(response.headers['content-type']).toBe('application/pdf');
  });

  it('sends nothing to a visitor who already holds these bytes', async () => {
    const open = vi.fn<FoundMedia['open']>();
    const { app } = await start({ found: file({ open }) });

    for (const held of [ETAG, `W/${ETAG}`, `"other", ${ETAG}`, '*']) {
      const response = await app.inject({
        method: 'GET',
        url: `/m/${KEY}/a.png`,
        headers: { 'if-none-match': held },
      });
      expect(response.statusCode, held).toBe(304);
      expect(response.body).toBe('');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(response.headers.etag).toBe(ETAG);
    }
    expect(open).not.toHaveBeenCalled();

    const other = await app.inject({
      method: 'GET',
      url: `/m/${KEY}/a.png`,
      headers: { 'if-none-match': '"something-else"' },
    });
    expect(other.statusCode).toBe(200);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('serves one byte range, so a video plays from anywhere in it', async () => {
    const { app } = await start();

    const part = await app.inject({
      method: 'GET',
      url: `/m/${KEY}/a.png`,
      headers: { range: 'bytes=5-9' },
    });
    const tail = await app.inject({
      method: 'GET',
      url: `/m/${KEY}/a.png`,
      headers: { range: 'bytes=-4' },
    });

    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('56789');
    expect(part.headers).toMatchObject({
      'content-range': `bytes 5-9/${String(bytes.length)}`,
      'content-length': '5',
      'content-type': 'image/png',
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.body).toBe('ghij');
    expect(tail.headers['content-range']).toBe('bytes 16-19/20');
  });

  it('answers with the whole file for a range it does not serve in part', async () => {
    const { app } = await start();

    const response = await app.inject({
      method: 'GET',
      url: `/m/${KEY}/a.png`,
      headers: { range: 'bytes=0-1,4-5' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
  });

  it('says so when the range lies past the end', async () => {
    const open = vi.fn<FoundMedia['open']>();
    const { app } = await start({ found: file({ open }) });

    const response = await app.inject({
      method: 'GET',
      url: `/m/${KEY}/a.png`,
      headers: { range: 'bytes=20-' },
    });

    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */20');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(open).not.toHaveBeenCalled();
  });

  it('is one plain 404 for anything that is not public now, and nobody keeps it', async () => {
    const { app } = await start({ found: undefined });

    const response = await app.inject({ method: 'GET', url: `/m/${KEY}/a.png` });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('There is no such file.');
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
  });

  it.each([
    ['nothing after /m', '/m'],
    ['a key with no name', `/m/${KEY}`],
    ['more than a key and a name', `/m/${KEY}/a/b.png`],
  ])('finds nothing at %s', async (_case, url) => {
    const { app, media } = await start();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);
    expect(media.findPublic).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'DELETE', 'HEAD'] as const)('takes no %s', async (method) => {
    const { app, media, rateLimit } = await start();

    const response = await app.inject({ method, url: `/m/${KEY}/a.png` });

    expect(response.statusCode).toBe(405);
    expect(media.findPublic).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('refuses past the shared public limit, before looking anything up', async () => {
    const { app, media, rateLimit } = await start();
    rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });

    const response = await app.inject({ method: 'GET', url: `/m/${KEY}/a.png` });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(media.findPublic).not.toHaveBeenCalled();
  });

  it.each([
    ['fails', () => Promise.reject(new Error('database down'))],
    ['answers nonsense', () => Promise.resolve({ allowed: false as const, retryAfterSeconds: 0 })],
  ])('is unavailable when the limiter %s: it never opens without it', async (_case, decide) => {
    const { app, media, rateLimit, logs } = await start();
    rateLimit.mockImplementation(decide);

    const response = await app.inject({ method: 'GET', url: `/m/${KEY}/a.png` });

    expect(response.statusCode).toBe(503);
    expect(media.findPublic).not.toHaveBeenCalled();
    expect(logs.join('')).toContain('Public media limiter unavailable');
    expect(logs.join('')).not.toContain('database down');
  });

  it('is not mounted on an install without the public limit', async () => {
    const { app, media } = await start({ limited: false });

    const response = await app.inject({ method: 'GET', url: `/m/${KEY}/a.png` });

    expect(response.statusCode).toBe(404);
    expect(media.findPublic).not.toHaveBeenCalled();
  });

  it('says only that the file could not be opened when storage fails', async () => {
    const { app, logs } = await start({
      found: file({ open: () => Promise.reject(new Error('bucket secret-bucket refused')) }),
    });

    const response = await app.inject({ method: 'GET', url: `/m/${KEY}/a.png` });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('This file could not be opened. Try again later.');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(logs.join('')).toContain('Media request failed');
    expect(logs.join('')).not.toContain('secret-bucket');
  });
});

describe('a preview address', () => {
  const url = `/m/p/${FILE}?agency=a&expires=1&signature=s`;

  it('shows the file to its one viewer, who may keep it for the hour', async () => {
    const { app, media, rateLimit, db } = await start();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers).toMatchObject({
      'content-type': 'image/png',
      'cache-control': 'private, max-age=3600',
      'content-security-policy': SANDBOX,
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      etag: ETAG,
    });
    expect(media.findPreview).toHaveBeenCalledWith(db, {
      fileId: FILE,
      query: { agency: 'a', expires: '1', signature: 's' },
      now: expect.any(Date) as Date,
      correlationId: expect.any(String) as string,
    });
    // The signature is the permission: a preview takes no share of the public quota.
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('is served on an install without the public limit too', async () => {
    const { app } = await start({ limited: false });

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });

  it("lets the browser's own viewer open a PDF, which no sandbox would", async () => {
    const { app } = await start({
      preview: file({ filename: 'menu.pdf', contentType: 'application/pdf' }),
    });

    const response = await app.inject({ method: 'GET', url });

    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe(
      'inline; filename="menu.pdf"; filename*=UTF-8\'\'menu.pdf',
    );
  });

  it('serves a part of it', async () => {
    const { app } = await start();

    const response = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-3' } });

    expect(response.statusCode).toBe(206);
    expect(response.body).toBe('0123');
  });

  it.each([
    ['invalid', 403, 'This link is not valid any more.'],
    ['expired', 403, 'This link is not valid any more.'],
    ['not_found', 404, 'There is no such file.'],
  ] as const)('refuses a link that is %s', async (refused, status, words) => {
    const { app } = await start({ preview: { refused } });

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(status);
    expect(response.body).toBe(words);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('an install without media storage', () => {
  it('serves nothing under /m', async () => {
    const db = connectDatabase({
      connectionString: config.databaseAppUrl,
      onConnectionError: () => undefined,
    });
    databases.push(db);
    const server = await buildServer({
      config,
      logger: pino({ level: 'silent' }),
      serveApi: true,
      routes: [],
      services: { db, authorize: allowEveryone },
      readinessChecks: {},
    });
    servers.push(server);

    expect((await server.app.inject({ method: 'GET', url: `/m/${KEY}/a.png` })).statusCode).toBe(
      404,
    );
  });
});
