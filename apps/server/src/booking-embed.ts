// The booking page on a business's own website: the booking page in a frame, and a small
// script that makes the frame as tall as the page.
//
// Framing. Every page of the dashboard's application may be framed by the install itself
// only (server.ts, notFramedElsewhere), with one exception: a calendar's booking page,
// /book/<agency>/<business>/<calendar>, may be framed by any website. It is sent with
// `Content-Security-Policy: frame-ancestors *` and no X-Frame-Options:
//
// - `*` matches every ancestor whose scheme is http or https (CSP Level 3, "Does url match
//   expression in origin with redirect count?", step 1: "url's scheme is an HTTP(S)
//   scheme"), and every ancestor of the frame is checked, not only its parent (MDN, CSP
//   frame-ancestors: "If any ancestor doesn't match, the load is canceled").
// - X-Frame-Options has no value that allows every site, so it is left out. A browser that
//   reads frame-ancestors ignores it anyway: "If a resource is delivered with a policy that
//   includes a directive named frame-ancestors and whose disposition is "enforce", then the
//   X-Frame-Options header will be ignored" (CSP Level 3, "Relation to X-Frame-Options").
//
// Why the booking page may be framed by anyone and nothing else may: the page holds no
// session and no secret. In a frame on another site the browser sends it no session
// cookie (Better Auth's are SameSite=Lax, which a cross-site frame's requests do not
// carry), and what it can do, read a calendar's free times and book one with what the
// visitor types, is what the public booking API already lets anyone do. The management
// page of a booking stays unframeable.
//
// The script. One file, the same bytes for everyone, served from memory at one address
// that never changes (a website keeps the code it was given for years), cached briefly
// and validated by its digest, readable from any website: exactly as /forms/embed.js is.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

/** Where websites load the script from. */
export const BOOKING_EMBED_SCRIPT_URL = '/calendars/embed.js';

/** The policy the booking page is sent with: any website may show it in a frame. */
export const BOOKING_PAGE_FRAMING = 'frame-ancestors *';

/** The built script, held in memory. */
export interface BookingEmbedScript {
  readonly body: Buffer;
  readonly etag: string;
}

/**
 * Whether a request path, with or without its query, is a calendar's booking page: three
 * names after /book/, and nothing after them but a slash. The page of an appointment's
 * own link, the sign-in page and every other page are not.
 */
export function isBookingPagePath(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return /^\/book\/[^/]+\/[^/]+\/[^/]+\/?$/.test(path);
}

/**
 * The bundle the build step wrote beside this file (booking-embed/tools/build.ts), or
 * undefined when it is not there, as in tests and in development before a build.
 */
export function loadBookingEmbedScript(
  file: URL = new URL('./booking-embed/booking-embed.bundle.js', import.meta.url),
): BookingEmbedScript | undefined {
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    return undefined;
  }
  return { body, etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
}

/**
 * Serves the script. Loaded by a plain script tag on any website: no Origin to check and
 * nothing secret in it. From memory, with no database call, so it is not counted by the
 * limiter: a page view must cost the CRM nothing an attacker could use up.
 */
export function registerBookingEmbedScript(app: FastifyInstance, script: BookingEmbedScript): void {
  app.get(BOOKING_EMBED_SCRIPT_URL, { exposeHeadRoute: false }, (request, reply) => {
    void reply
      .header('cache-control', 'public, max-age=300')
      .header('etag', script.etag)
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('referrer-policy', 'no-referrer');
    if (request.headers['if-none-match'] === script.etag) return reply.code(304).send();
    return reply.type('text/javascript; charset=utf-8').send(script.body);
  });
}
