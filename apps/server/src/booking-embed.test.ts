// The booking embed: which paths are the booking page, the script as it is built
// (booking-embed/tools/build.ts, into a temporary folder) and as it is served.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildBookingEmbed, BOOKING_EMBED_BUNDLE } from '../booking-embed/tools/build.js';
import {
  BOOKING_EMBED_SCRIPT_URL,
  isBookingPagePath,
  loadBookingEmbedScript,
  registerBookingEmbedScript,
} from './booking-embed.js';

/** The most it may weigh gzipped. It sizes frames and nothing else. */
const BUDGET = 1024;

let folder: string;
let code: string;
beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'crm-booking-embed-'));
  code = readFileSync(await buildBookingEmbed(folder), 'utf8');
}, 60_000);
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the booking page’s address', () => {
  it('is three names after /book/, with or without a slash, a query or a fragment', () => {
    for (const url of [
      '/book/bluebird/harbor/tours',
      '/book/bluebird/harbor/tours/',
      '/book/bluebird/harbor/tours?utm_source=site',
      '/book/bluebird/harbor/tours#top',
    ])
      expect(isBookingPagePath(url), url).toBe(true);
  });

  it('is no other page', () => {
    for (const url of [
      '/',
      '/sign-in',
      '/book',
      '/book/',
      '/book/bluebird/harbor',
      '/book/bluebird/harbor/tours/more',
      '/book//harbor/tours',
      '/booking/bluebird/harbor/tours',
      '/appointments/manage/token',
      '/b/harbor/settings/calendars',
      '/x/book/bluebird/harbor/tours',
    ])
      expect(isBookingPagePath(url), url).toBe(false);
  });
});

describe('the booking embed script, as built', () => {
  it('is one file, within its budget gzipped', () => {
    expect(readdirSync(folder)).toEqual([BOOKING_EMBED_BUNDLE]);
    const gzipped = gzipSync(Buffer.from(code, 'utf8'), { level: 6 }).length;
    expect(gzipped).toBeGreaterThan(200);
    expect(gzipped).toBeLessThanOrEqual(BUDGET);
  });

  it('is one function call that adds no name to the page and loads nothing', () => {
    expect(code.startsWith('(function(){')).toBe(true);
    expect(code.trimEnd().endsWith('})();')).toBe(true);
    expect(code).not.toMatch(/\bimport\s*\(|\bimport\s+[\w{*]|\brequire\s*\(/);
    expect(code).not.toMatch(/\b(window|globalThis)\.[A-Za-z_$][\w$]*\s*=[^=]/);
  });

  it('has no way to turn text into markup or code, to call a server, or to keep anything', () => {
    for (const sink of [
      ...['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser'],
      ...['srcdoc', 'eval(', 'new Function', 'setAttribute("style"', "setAttribute('style'"],
      ...['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource'],
      ...['document.cookie', 'localStorage', 'sessionStorage', 'indexedDB'],
    ])
      expect(code, sink).not.toContain(sink);
    // It posts only to a frame's own origin: never to any window at all.
    expect(code).not.toMatch(/postMessage\([^)]*["'`]\*["'`]/);
    expect(code.match(/https?:\/\/[^\s`'"\\)]+/g) ?? []).toEqual([]);
  });
});

describe('the booking embed script, as served', () => {
  it('is loaded from the folder it was built in, named by the digest of its bytes', () => {
    const script = loadBookingEmbedScript(pathToFileURL(path.join(folder, BOOKING_EMBED_BUNDLE)));
    expect(script?.body.toString('utf8')).toBe(code);
    expect(script?.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(loadBookingEmbedScript(pathToFileURL(path.join(folder, 'missing.js')))).toBeUndefined();
  });

  it('answers at one address any website may load, cached briefly and validated', async () => {
    const script = { body: Buffer.from('(function(){})();'), etag: '"abc"' };
    const app = Fastify();
    registerBookingEmbedScript(app, script);
    const answer = await app.inject({ method: 'GET', url: BOOKING_EMBED_SCRIPT_URL });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toBe('(function(){})();');
    expect(answer.headers).toMatchObject({
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      etag: '"abc"',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      'referrer-policy': 'no-referrer',
    });
    const again = await app.inject({
      method: 'GET',
      url: BOOKING_EMBED_SCRIPT_URL,
      headers: { 'if-none-match': '"abc"' },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect((await app.inject({ method: 'HEAD', url: BOOKING_EMBED_SCRIPT_URL })).statusCode).toBe(
      404,
    );
    await app.close();
  });
});
