// The public address of a site's pages on the install itself, before any domain is
// connected:
//
//   GET /s/<siteKey>             the site's own address: a funnel's first step, a website's home
//   GET /s/<siteKey>/<path>      the step at that path
//   GET /s/_preview/<token>      a page's newest saved version, for whoever holds the link
//   GET /s/_js/<name>.<digest>.js  one of the CRM's own small page scripts (a countdown that
//                                ticks, popups that open by themselves), for a page that names it
//
// HEAD answers as GET does, without the page. Nothing else is taken: no other method, no
// body, no cookie in and none out.
//
// Order of checks, before any handler: the shared rate limit, by address and, once this
// process has served a page of the site, by the site's business too (fail closed). Every
// request asks the database whether the page is still the page, so every request is counted.
//
// What a visit costs: the limiter's statement
// and one more, which reads everything the page is made from. A page that has not changed
// is not rendered again; a visitor who holds it already is told so (304) and sent no bytes;
// the bytes are compressed once for each coding a browser asks for, and kept with the page.
//
// Caching (RFC 9111, RFC 9110): `public, max-age=0, must-revalidate, no-transform` with a
// validator. A browser or a proxy may keep the page and must ask before every use, and may
// never show a kept page it could not ask about, so a publish or an unpublish shows on the
// next visit. An operator with a CDN in front may let it answer by itself for a stated
// number of seconds (`sharedCacheSeconds`, SITES_SHARED_CACHE_SECONDS): that number is then
// how long an unpublished page can still be shown by the CDN, and no longer.
//
// The small scripts are bytes this process holds from the moment it
// starts, so, like the form embed, they are not counted by the limiter and read nothing.
// Each is served at an address that holds the digest of its bytes: the address never names
// other bytes, so it is sent to be kept for a year and never asked about again
// (`immutable`), and a release that changes a script changes its address, which changes
// every page that names it, and so that page's own tag.
//
// This address is shared by every tenant and by the dashboard, so what a page may do is
// decided here and in the renderer, never by the page: the policy sent with each page
// allows no script but the CRM's own, from this address, the renderer writes no code a
// tenant wrote, and of a site's own response headers only those that can do no more than narrow
// the page are sent (the sites module chooses them). A preview is never stored. Nothing
// here is listed by a search engine: listing is for a site's own domain.
//
// A key that names nothing, a path no step has, a page that is not published and a site
// that was deleted are one answer, the same bytes.
import { promisify } from 'node:util';
import { brotliCompress, brotliCompressSync, constants, gzip, gzipSync } from 'node:zlib';

import { SITE_PAGE_PATH, sitePath, sitePreviewToken, sitePublicKey } from '@repo/contracts';
import type {
  PageScriptFile,
  PublicSiteHandlers,
  ServedSitePage,
  ServedView,
} from '@repo/module-sites';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { PublicBookingRateLimit } from './public-booking.js';
import { createIntakeScopes, type IntakeScopes } from './public-intake-limit.js';

/** A published page that a visitor's browser was answered about. Ids only. */
export interface ServedSiteVisit extends ServedView {
  /** True when the browser already held the page and was told so (304): no bytes were sent. */
  readonly notModified: boolean;
}

export interface PublicSiteTransport {
  readonly handlers: PublicSiteHandlers;
  /** Mandatory, as for every public surface: a transport cannot answer without it. */
  readonly rateLimit: PublicBookingRateLimit;
  /**
   * How long a shared cache (a CDN in front of the server) may answer for a page without
   * asking, in whole seconds, 0 to 300. Left out or 0: it asks every time, as a browser
   * always does. Whatever it is, it is the longest a CDN can go on showing a page after it
   * was unpublished or published again.
   */
  readonly sharedCacheSeconds?: number | undefined;
  /**
   * Told of each published page a browser was answered about with GET, never of a
   * preview, a HEAD or a refusal. The contract counting views relies on:
   * - it is called after the response has been sent, so it cannot slow one down;
   * - it is not awaited: what it returns is not waited for;
   * - whatever it throws, and whatever a promise it returns rejects with, is logged and
   *   changes nothing a visitor sees.
   */
  readonly onServed?: ((visit: ServedSiteVisit) => unknown) | undefined;
  /** Which business a site key belongs to, as learned from pages served. Its own by default. */
  readonly scopes?: IntakeScopes | undefined;
  /**
   * The CRM's own small page scripts, as built (loadPageScripts). Left out or empty where
   * they were not built: no address answers for one, and the handlers, given no address
   * for them, render pages that name none.
   */
  readonly scripts?: readonly PageScriptFile[] | undefined;
}

/**
 * Where the small page scripts are served: under the pages' own address, at a name no
 * site's key can be (a key has no underscore).
 */
export const SITE_SCRIPTS_PATH = `${SITE_PAGE_PATH}/_js`;

/** A script's address names its bytes, so a browser may keep it for a year without asking. */
const FOREVER = 'public, max-age=31536000, immutable';

/** The most a shared cache may be told to keep answering by itself, in seconds. */
export const MAX_SHARED_CACHE_SECONDS = 300;

/** The one page for an address that shows nothing. It says nothing about why. */
export const NOT_FOUND_PAGE = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="robots" content="noindex">',
  '<title>Page not found</title>',
  '</head>',
  '<body>',
  '<main><h1>Page not found</h1><p>There is no page at this address.</p></main>',
  '</body>',
  '</html>',
  '',
].join('\n');

/** The policy of every answer that is not a rendered page: it loads and runs nothing. */
const BARE_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const messages: Readonly<Record<number, string>> = {
  400: 'This request cannot be read.',
  405: 'This address only shows pages.',
  429: 'Too many requests. Try again in a minute.',
  500: 'This page could not be shown. Try again later.',
  503: 'This page is temporarily unavailable. Try again later.',
};

/** One plain line for anything that is not a page: never the address, never an error's own words. */
function refuse(reply: FastifyReply, status: number): FastifyReply {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('content-security-policy', BARE_POLICY)
    .type('text/plain; charset=utf-8')
    .send(messages[status] ?? messages[400] ?? '');
}

const notFound = (reply: FastifyReply): FastifyReply =>
  reply
    .code(404)
    .header('cache-control', 'no-store')
    .header('content-security-policy', BARE_POLICY)
    .type('text/html; charset=utf-8')
    .send(NOT_FOUND_PAGE);

type Coding = 'br' | 'gzip' | 'identity';
const CODINGS = ['br', 'gzip'] as const;
const compress = {
  br: (body: Buffer) =>
    promisify(brotliCompress)(body, {
      params: {
        // Made once for a page and kept with it, so a little more work than a stream
        // would get (Node's own default, 11, takes twenty times as long for a sixth less).
        [constants.BROTLI_PARAM_QUALITY]: 9,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
      },
    }),
  gzip: (body: Buffer) => promisify(gzip)(body, { level: 9 }),
};

/**
 * The content coding to answer with (RFC 9110, 12.5.3): of the two this server writes, the
 * one the browser weighs highest and does not refuse, Brotli before gzip when it weighs
 * them the same; otherwise the page as it is. A request that names no coding gets the page
 * as it is.
 */
export function chooseCoding(header: unknown): Coding {
  if (typeof header !== 'string') return 'identity';
  const weights = new Map<string, number>();
  for (const part of header.split(',')) {
    const [name = '', ...parameters] = part.split(';').map((each) => each.trim().toLowerCase());
    if (name === '') continue;
    const q = parameters.find((each) => each.startsWith('q='))?.slice(2);
    const weight = q === undefined ? 1 : /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(q) ? Number(q) : 0;
    weights.set(name, weight);
  }
  let chosen: Coding = 'identity';
  let best = 0;
  for (const coding of CODINGS) {
    const weight = weights.get(coding) ?? weights.get('*') ?? 0;
    if (weight > best) {
      chosen = coding;
      best = weight;
    }
  }
  return chosen;
}

/** A page's tag in one coding: a strong tag names exactly one set of bytes (RFC 9110, 8.8.3.3). */
const tagOf = (etag: string, coding: Coding): string =>
  coding === 'identity' ? etag : `${etag.slice(0, -1)}.${coding === 'br' ? 'br' : 'gz'}"`;

/**
 * Whether the visitor already holds this page, in any coding (RFC 9110, 13.1.2): the
 * comparison is the weak one, so a tag a proxy weakened still matches.
 */
function holds(request: FastifyRequest, etag: string): boolean {
  const given = request.headers['if-none-match'];
  if (typeof given !== 'string') return false;
  const tags = new Set([etag, tagOf(etag, 'br'), tagOf(etag, 'gzip')]);
  return given
    .split(',')
    .map((each) => each.trim().replace(/^W\//, ''))
    .some((each) => each === '*' || tags.has(each));
}

/**
 * The small page scripts, each at the address its digest names. No limiter and no handler
 * of the pages' runs here: the bytes are held in memory and nothing is read.
 */
async function registerSiteScripts(
  app: FastifyInstance,
  scripts: readonly PageScriptFile[],
): Promise<void> {
  // Made once, when the server starts: a script is a kilobyte or two.
  const files = new Map(
    scripts.map((script) => [
      script.file,
      {
        etag: script.etag,
        identity: script.body,
        br: brotliCompressSync(script.body, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_SIZE_HINT]: script.body.byteLength,
          },
        }),
        gzip: gzipSync(script.body, { level: 9 }),
      },
    ]),
  );
  await app.register(
    (scriptsApp, _options, done) => {
      scriptsApp.addHook('onRequest', async (request, reply) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(reply, 405);
      });
      scriptsApp.addHook('onSend', async (_request, reply) => {
        reply
          .header('x-content-type-options', 'nosniff')
          .header('x-robots-tag', 'noindex')
          .header('referrer-policy', 'strict-origin-when-cross-origin');
        reply.removeHeader('set-cookie');
      });
      scriptsApp.setNotFoundHandler((_request, reply) => notFound(reply));
      scriptsApp.removeAllContentTypeParsers();
      scriptsApp.get<{ Params: { file: string } }>('/:file', (request, reply) => {
        const found = files.get(request.params.file);
        // A name this release did not build: an older page's script, or nothing at all.
        if (found === undefined) return notFound(reply);
        const coding = chooseCoding(request.headers['accept-encoding']);
        void reply
          .header('cache-control', FOREVER)
          .header('content-security-policy', BARE_POLICY)
          // Only a page of this address loads it.
          .header('cross-origin-resource-policy', 'same-origin')
          .header('vary', 'Accept-Encoding')
          .header('etag', tagOf(found.etag, coding));
        if (holds(request, found.etag)) return reply.code(304).send();
        if (coding !== 'identity') void reply.header('content-encoding', coding);
        return reply.type('text/javascript; charset=utf-8').send(found[coding]);
      });
      done();
    },
    { prefix: SITE_SCRIPTS_PATH },
  );
}

/** Fastify's scope isolates these routes from the authenticated /api/v1 plugin. */
export async function registerPublicSites(
  app: FastifyInstance,
  transport: PublicSiteTransport,
): Promise<void> {
  if (transport.scripts !== undefined && transport.scripts.length > 0)
    await registerSiteScripts(app, transport.scripts);
  const { handlers, rateLimit, onServed } = transport;
  const scopes = transport.scopes ?? createIntakeScopes();
  const shared = transport.sharedCacheSeconds ?? 0;
  if (!Number.isSafeInteger(shared) || shared < 0 || shared > MAX_SHARED_CACHE_SECONDS)
    throw new Error(
      `A shared cache may keep a page for 0 to ${String(MAX_SHARED_CACHE_SECONDS)} seconds.`,
    );
  // A browser asks every time. So does a shared cache, unless the operator gave it a time
  // of its own; past that time it too must ask, and may show nothing it could not ask about
  // (RFC 9111, 5.2.2.2 and 5.2.2.10).
  //
  // `no-transform` (RFC 9111, 5.2.2.6): an intermediary "MUST NOT transform the content".
  // A page's policy names its stylesheet by its digest and allows no script but the CRM's
  // own, so a proxy that rewrites the HTML on the way (hides email addresses behind a
  // script, adds a beacon) breaks the page. This asks it not to; it changes nothing about
  // how long a page may be kept. A proxy may still be set to ignore it, so an operator is
  // also told to switch such features off (docs/HOSTING.md, 13.5).
  const LIVE =
    shared === 0
      ? 'public, max-age=0, must-revalidate, no-transform'
      : `public, max-age=0, s-maxage=${String(shared)}, must-revalidate, no-transform`;

  // A page's bytes in each coding, made the first time a browser asks for that coding and
  // kept for as long as the page itself is (the sites module keeps the page; when it lets
  // go of one, these go with it).
  const coded = new WeakMap<ServedSitePage, Map<'br' | 'gzip', Promise<Buffer>>>();
  const bytesOf = (page: ServedSitePage, coding: 'br' | 'gzip'): Promise<Buffer> => {
    const held = coded.get(page) ?? new Map<'br' | 'gzip', Promise<Buffer>>();
    coded.set(page, held);
    let made = held.get(coding);
    if (made === undefined) {
      made = compress[coding](page.body);
      held.set(coding, made);
      const mine = made;
      // A failure is this request's (it falls back below) and is not kept for the next.
      mine.catch(() => {
        if (held.get(coding) === mine) held.delete(coding);
      });
    }
    return made;
  };

  /** The visits to tell `onServed` of once their response has gone. */
  const visits = new WeakMap<FastifyRequest, ServedSiteVisit>();

  await app.register(
    (publicApp, _options, done) => {
      publicApp.addHook('onSend', async (_request, reply) => {
        reply
          .header('x-content-type-options', 'nosniff')
          .header('x-robots-tag', 'noindex')
          // A site's own header of this name, where it set one, stands.
          .header(
            'referrer-policy',
            reply.getHeader('referrer-policy') ?? 'strict-origin-when-cross-origin',
          );
        // No answer of this address sets a cookie, whatever ran before.
        reply.removeHeader('set-cookie');
      });
      publicApp.addHook('onRequest', async (request, reply) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(reply, 405);
        const siteKey = (request.params as { siteKey?: unknown } | null)?.siteKey;
        const businessId = typeof siteKey === 'string' ? scopes.get(siteKey) : undefined;
        try {
          const decision = await rateLimit(
            {
              requestId: request.id,
              ipAddress: request.ip,
              ...(businessId === undefined ? {} : { businessId }),
            },
            'read',
          );
          if (!decision.allowed) {
            if (!Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 1)
              throw new Error('Invalid limiter decision.');
            reply.header('retry-after', String(decision.retryAfterSeconds));
            return await refuse(reply, 429);
          }
        } catch {
          request.log.error({ statusCode: 503 }, 'Public sites limiter unavailable');
          return refuse(reply, 503);
        }
      });
      if (onServed !== undefined)
        // After the response has gone: nothing here is waited for, and nothing here can
        // change what the visitor was sent.
        publicApp.addHook('onResponse', (request, _reply, next) => {
          next();
          const visit = visits.get(request);
          if (visit === undefined) return;
          const failed = (): void => {
            request.log.error({ statusCode: 200 }, 'Counting a site page view failed');
          };
          try {
            const counted = onServed(visit);
            if (counted instanceof Promise) counted.catch(failed);
          } catch {
            failed();
          }
        });
      publicApp.setErrorHandler((error, request, reply) => {
        const status =
          error instanceof Error &&
          'statusCode' in error &&
          typeof error.statusCode === 'number' &&
          error.statusCode >= 400 &&
          error.statusCode < 500
            ? error.statusCode
            : 500;
        // Neither the address nor a raw database error enters the log.
        if (status === 500) request.log.error({ statusCode: 500 }, 'Public site request failed');
        return refuse(reply, status);
      });
      publicApp.setNotFoundHandler((_request, reply) => notFound(reply));
      // No body is read at this address, of any kind.
      publicApp.removeAllContentTypeParsers();

      const requestOf = (request: FastifyRequest) => ({ requestId: request.id });
      /** A draft, as it is, to whoever holds the link: never stored, never told to another website. */
      const sendPreview = (reply: FastifyReply, page: ServedSitePage): FastifyReply => {
        for (const header of page.headers) void reply.header(header.name, header.value);
        return (
          reply
            .header('content-security-policy', page.policy)
            // Never stored, and never rewritten on the way either: its policy is as exact.
            .header('cache-control', 'no-store, no-transform')
            .header('referrer-policy', 'no-referrer')
            .type('text/html; charset=utf-8')
            .send(page.body)
        );
      };
      const sendLive = async (
        request: FastifyRequest,
        reply: FastifyReply,
        page: ServedSitePage,
      ): Promise<FastifyReply> => {
        // The site's own headers first, so nothing a site sets replaces one written below.
        for (const header of page.headers) void reply.header(header.name, header.value);
        let coding = chooseCoding(request.headers['accept-encoding']);
        let body = page.body;
        if (coding !== 'identity')
          try {
            body = await bytesOf(page, coding);
          } catch {
            // The page as it is, rather than no page.
            coding = 'identity';
          }
        void reply
          .header('content-security-policy', page.policy)
          .header('cache-control', LIVE)
          // The same address answers in more than one coding: a cache keeps them apart.
          .header('vary', 'Accept-Encoding')
          .header('etag', tagOf(page.etag, coding));
        const notModified = holds(request, page.etag);
        if (request.method === 'GET' && page.view !== undefined)
          visits.set(request, { ...page.view, notModified });
        // The same headers a page would carry, and no bytes (RFC 9110, 15.4.5).
        if (notModified) return reply.code(304).send();
        if (coding !== 'identity') void reply.header('content-encoding', coding);
        return reply.type('text/html; charset=utf-8').send(body);
      };
      const page = async (
        request: FastifyRequest,
        reply: FastifyReply,
        siteKey: string,
        path: string,
      ): Promise<FastifyReply> => {
        if (!sitePublicKey.safeParse(siteKey).success) return notFound(reply);
        if (path !== '' && !sitePath.safeParse(path).success) return notFound(reply);
        const found = await handlers.page(siteKey, path, requestOf(request));
        if (found === undefined) return notFound(reply);
        // From the next request on, this site's pages count toward its business's ceiling.
        if (found.view !== undefined) scopes.learn(siteKey, found.view.businessId);
        return sendLive(request, reply, found);
      };

      publicApp.get<{ Params: { token: string } }>('/_preview/:token', async (request, reply) => {
        if (!sitePreviewToken.safeParse(request.params.token).success) return notFound(reply);
        const found = await handlers.preview(request.params.token, requestOf(request));
        return found === undefined ? notFound(reply) : sendPreview(reply, found);
      });
      publicApp.get<{ Params: { siteKey: string } }>('/:siteKey', (request, reply) =>
        page(request, reply, request.params.siteKey, ''),
      );
      publicApp.get<{ Params: { siteKey: string; '*': string } }>('/:siteKey/*', (request, reply) =>
        // A slash after the key alone is the site's own address too.
        page(request, reply, request.params.siteKey, request.params['*']),
      );
      done();
    },
    { prefix: SITE_PAGE_PATH },
  );
}
