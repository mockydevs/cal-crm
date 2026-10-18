import { Writable } from 'node:stream';

import { ConflictError } from '@repo/kernel';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerPublicTracking,
  TRACKING_SCRIPT_URL,
  type PublicTrackingPorts,
  type TrackingScript,
} from './external-tracking.js';
import type { PublicBookingRateLimit } from './public-booking.js';

const ID = `tk_${'a1'.repeat(16)}`;
const ORIGIN = 'https://www.acme.example';
const URL = `/api/v1/public/tracking/${ID}/events`;
const TOKEN = `1790000000000.${'A'.repeat(43)}`;
const view = {
  type: 'page_view',
  pageUrl: `${ORIGIN}/pricing`,
  sessionId: '5ef5926d-d3b7-4b95-a513-198a51a2c5d1',
};
const script: TrackingScript = { body: Buffer.from('(function(){})();'), etag: '"abc"' };

interface Admission {
  readonly businessId: string;
  readonly origin: string;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function start(options: { script?: TrackingScript } = {}) {
  const handlers = {
    admit: vi
      .fn<PublicTrackingPorts<Admission>['admit']>()
      .mockImplementation((id, origin) =>
        Promise.resolve(id === ID && origin === ORIGIN ? { businessId: 'b', origin } : undefined),
      ),
    record: vi
      .fn<PublicTrackingPorts<Admission>['record']>()
      .mockResolvedValue({ outcome: 'ok', receipt: { status: 'received', viewToken: TOKEN } }),
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
  await registerPublicTracking(app, {
    handlers,
    rateLimit,
    ...(options.script === undefined ? {} : { script: options.script }),
  });
  await app.ready();
  return { app, handlers, rateLimit, logs };
}

const post = (app: FastifyInstance, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: URL,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the tracking script', () => {
  it('is served to any website, cached briefly and validated by its digest', async () => {
    const { app } = await start({ script });
    const response = await app.inject({ method: 'GET', url: TRACKING_SCRIPT_URL });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toBe('(function(){})();');
    const again = await app.inject({
      method: 'GET',
      url: TRACKING_SCRIPT_URL,
      headers: { 'if-none-match': '"abc"' },
    });
    expect(again.statusCode).toBe(304);
  });

  it('is a 404 where it was not built', async () => {
    const { app } = await start();
    expect((await app.inject({ method: 'GET', url: TRACKING_SCRIPT_URL })).statusCode).toBe(404);
  });
});

describe('the events the script sends', () => {
  it('are answered to the admitted website only, with what the handler said', async () => {
    const { app, handlers } = await start();
    const response = await post(app, view, { 'sec-gpc': '1', 'x-forwarded-for': '1.2.3.4' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'received', viewToken: TOKEN });
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers.vary).toBe('Origin');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(handlers.record).toHaveBeenCalledWith(
      { businessId: 'b', origin: ORIGIN },
      view,
      expect.objectContaining({ ipAddress: '127.0.0.1', gpc: true }),
    );
    await post(app, view);
    expect(handlers.record.mock.calls[1]?.[2]).toMatchObject({ gpc: false });
  });

  it('say nothing to an unknown id or a website not admitted', async () => {
    const { app, handlers } = await start();
    for (const response of [
      await post(app, view, { origin: 'https://evil.example' }),
      await app.inject({
        method: 'POST',
        url: `/api/v1/public/tracking/tk_nope/events`,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify(view),
      }),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.json()).toMatchObject({ title: 'Forbidden' });
    }
    expect(handlers.record).not.toHaveBeenCalled();
  });

  it('are refused, readably from anywhere, when the limiter says so or cannot say', async () => {
    const { app, rateLimit, handlers } = await start();
    rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const limited = await post(app, view);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('7');
    expect(limited.headers['access-control-allow-origin']).toBe('*');
    rateLimit.mockRejectedValueOnce(new Error('down'));
    expect((await post(app, view)).statusCode).toBe(503);
    expect(handlers.admit).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '127.0.0.1' }),
      'write',
    );
    // Once the id's business is known, its own ceiling counts as well.
    await post(app, view);
    await post(app, view);
    expect(rateLimit.mock.calls.at(-1)?.[0]).toMatchObject({ businessId: 'b' });
  });

  it('answer the handler’s refusals with generic problems', async () => {
    const { app, handlers } = await start();
    handlers.record.mockResolvedValueOnce({ outcome: 'limited', retryAfterSeconds: 2 });
    const limited = await post(app, view);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('2');
    handlers.record.mockResolvedValueOnce({ outcome: 'stale' });
    expect((await post(app, view)).statusCode).toBe(409);
    handlers.record.mockResolvedValueOnce({ outcome: 'unavailable' });
    expect((await post(app, view)).statusCode).toBe(403);
    handlers.record.mockRejectedValueOnce(new ConflictError('changed'));
    expect((await post(app, view)).statusCode).toBe(409);
    handlers.record.mockRejectedValueOnce(new Error('boom'));
    const failed = await post(app, view);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('boom');
  });

  it('take only JSON that fits, within a small body', async () => {
    const { app, handlers } = await start();
    expect((await post(app, view, { 'content-type': 'text/plain' })).statusCode).toBe(415);
    expect((await post(app, { ...view, email: 'pat@example.com' })).statusCode).toBe(422);
    expect((await post(app, '{nope')).statusCode).toBe(400);
    const big = { ...view, title: 'x'.repeat(40_000) };
    expect((await post(app, big)).statusCode).toBe(413);
    expect(handlers.record).not.toHaveBeenCalled();
  });

  it('answer a preflight from memory, for any website', async () => {
    const { app, rateLimit } = await start();
    const response = await app.inject({
      method: 'OPTIONS',
      url: URL,
      headers: { origin: 'https://anyone.example', 'access-control-request-method': 'POST' },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('POST');
    expect(response.headers['access-control-allow-headers']).toBe('content-type');
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('keep what was sent out of the log', async () => {
    const { app, handlers, logs } = await start();
    handlers.record.mockRejectedValueOnce(new Error('boom'));
    await post(app, { ...view, pageUrl: `${ORIGIN}/secret-page` });
    expect(logs.join('')).not.toContain('secret-page');
  });

  it('do not exist at another path or method', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: URL, headers: { origin: ORIGIN } });
    expect([403, 404]).toContain(response.statusCode);
  });
});
