// The media library's two addresses that nobody signs in to open, both under /m:
//
//   GET /m/<key>/<name>     a file someone made public. The key alone finds it; the name is
//                           for people and for a file extension. Anything that is not
//                           public now is one 404. Behind the shared public rate limit,
//                           and mounted only where the install has it.
//   GET /m/p/<file id>?…    a library file, by an address signed like a file link, made
//                           for looking at it in the dashboard: kept by the browser alone,
//                           for an hour. The signature is the permission.
//
// Both answer with the stored type, never a guessed one, tell the browser to run nothing,
// and serve one byte range, so a video can be played from anywhere in it.
import type { Database } from '@repo/db';
import {
  MEDIA_PATH,
  MEDIA_PREVIEW_SEGMENT,
  rangeOf,
  type FoundMedia,
  type Media,
} from '@repo/module-files';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { contentDisposition } from './content-disposition.js';
import type { PublicBookingRateLimit } from './public-booking.js';

export interface PublicMediaTransport {
  readonly media: Pick<Media, 'findPublic' | 'findPreview'>;
  readonly db: Database;
  /** Without it, public addresses are not mounted at all; previews still are. */
  readonly rateLimit: PublicBookingRateLimit | undefined;
}

const messages: Readonly<Record<number, string>> = {
  400: 'This request cannot be read.',
  403: 'This link is not valid any more.',
  404: 'There is no such file.',
  405: 'This address only shows files.',
  416: 'The file has no such part.',
  429: 'Too many requests. Try again in a minute.',
  500: 'This file could not be opened. Try again later.',
  503: 'This file is temporarily unavailable. Try again later.',
};

/** One plain line for anything that is not a file: never the address, never an error's own words. */
function refuse(reply: FastifyReply, status: number): FastifyReply {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .type('text/plain; charset=utf-8')
    .send(messages[status] ?? messages[400] ?? '');
}

/** Whether the visitor already holds exactly these bytes (RFC 9110, If-None-Match). */
function holds(request: FastifyRequest, etag: string): boolean {
  const given = request.headers['if-none-match'];
  if (typeof given !== 'string') return false;
  return given
    .split(',')
    .map((each) => each.trim().replace(/^W\//, ''))
    .some((each) => each === etag || each === '*');
}

/** A year: the bytes under a public key never change. */
const PUBLIC_CACHE = 'public, max-age=31536000, immutable';
/** A preview is one person's, and its address changes every hour. */
const PREVIEW_CACHE = 'private, max-age=3600';
/** A browser shows the file as its type at most, and runs nothing in it. */
const SANDBOX = "default-src 'none'; sandbox";

async function send(
  request: FastifyRequest,
  reply: FastifyReply,
  found: FoundMedia,
  cache: string,
): Promise<FastifyReply> {
  void reply
    .header('cache-control', cache)
    .header('etag', found.etag)
    .header('accept-ranges', 'bytes');
  if (holds(request, found.etag)) return reply.code(304).send();
  const range = rangeOf(request.headers.range, found.size);
  if (range === 'unsatisfiable') {
    void reply.header('content-range', `bytes */${String(found.size)}`);
    return refuse(reply, 416);
  }
  const body = await found.open(range);
  if (range !== undefined)
    void reply
      .code(206)
      .header(
        'content-range',
        `bytes ${String(range.start)}-${String(range.end)}/${String(found.size)}`,
      );
  // A browser's own PDF viewer does not open inside a sandbox; a PDF is no page, and
  // nosniff keeps it from being read as one.
  if (found.contentType !== 'application/pdf')
    void reply.header('content-security-policy', SANDBOX);
  return reply
    .header('content-type', found.contentType)
    .header(
      'content-length',
      String(range === undefined ? found.size : range.end - range.start + 1),
    )
    .header('content-disposition', contentDisposition(found.inline, found.filename))
    .send(body);
}

/** Fastify's scope isolates these routes from the authenticated /api/v1 plugin. */
export async function registerPublicMedia(
  app: FastifyInstance,
  transport: PublicMediaTransport,
): Promise<void> {
  const { media, db, rateLimit } = transport;
  await app.register(
    (publicApp, _options, done) => {
      publicApp.addHook('onSend', async (_request, reply) => {
        reply
          .header('x-content-type-options', 'nosniff')
          .header('x-robots-tag', 'noindex')
          .header('referrer-policy', 'no-referrer')
          // A picture in an email or on another website is the point of the address.
          .header('cross-origin-resource-policy', 'cross-origin');
        // No answer of this address sets a cookie, whatever ran before.
        reply.removeHeader('set-cookie');
      });
      publicApp.addHook('onRequest', async (request, reply) => {
        if (request.method !== 'GET') return refuse(reply, 405);
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
        // Neither the address nor a raw storage or database error enters the log.
        if (status === 500) request.log.error({ statusCode: 500 }, 'Media request failed');
        return refuse(reply, status);
      });
      publicApp.setNotFoundHandler((_request, reply) => refuse(reply, 404));
      // No body is read at this address, of any kind.
      publicApp.removeAllContentTypeParsers();

      publicApp.get<{ Params: { id: string } }>(
        `/${MEDIA_PREVIEW_SEGMENT}/:id`,
        // HEAD would open the file only to throw it away.
        { exposeHeadRoute: false },
        async (request, reply) => {
          const found = await media.findPreview(db, {
            fileId: request.params.id,
            query: request.query,
            now: new Date(),
            correlationId: request.id,
          });
          if ('refused' in found) return refuse(reply, found.refused === 'not_found' ? 404 : 403);
          return send(request, reply, found, PREVIEW_CACHE);
        },
      );

      if (rateLimit !== undefined)
        publicApp.get<{ Params: { key: string; name: string } }>(
          '/:key/:name',
          {
            exposeHeadRoute: false,
            // Checked here, not for the whole scope: a preview is signed, and a signed
            // address needs no share of the public quota.
            onRequest: async (request, reply) => {
              try {
                const decision = await rateLimit(
                  { requestId: request.id, ipAddress: request.ip },
                  'read',
                );
                if (!decision.allowed) {
                  if (
                    !Number.isSafeInteger(decision.retryAfterSeconds) ||
                    decision.retryAfterSeconds < 1
                  )
                    throw new Error('Invalid limiter decision.');
                  reply.header('retry-after', String(decision.retryAfterSeconds));
                  return await refuse(reply, 429);
                }
              } catch {
                request.log.error({ statusCode: 503 }, 'Public media limiter unavailable');
                return refuse(reply, 503);
              }
            },
          },
          async (request, reply) => {
            const found = await media.findPublic(db, {
              key: request.params.key,
              correlationId: request.id,
            });
            return found === undefined
              ? refuse(reply, 404)
              : send(request, reply, found, PUBLIC_CACHE);
          },
        );
      done();
    },
    { prefix: MEDIA_PATH },
  );
}
