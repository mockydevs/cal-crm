// The public address of a quote or an invoice: /d/<token>. The token is the whole request:
// it finds the document, and nothing else a visitor sends has any say.
//
//   GET  /d/<token>          the document as a page: read-only, the same words as its PDF
//   GET  /d/<token>/pdf      the PDF
//   GET  /d/<token>/logo     the seller's logo, for the page's own image
//   POST /d/<token>/accept   a quote's customer accepts it, then is sent back to the page
//   POST /d/<token>/decline  the same, declining
//
// Order of checks, before any handler: the shared rate limit, by address (fail closed).
// The page runs no script, loads nothing from anywhere else and cannot be framed; the
// policy for that is the commerce module's, which also writes the page. An address that
// opens nothing (never issued, replaced, its document void or withdrawn) gets one plain
// page, whichever of those it is.
import { quoteAnswers, SALES_DOCUMENT_LINK_PATH, type QuoteAnswer } from '@repo/contracts';
import type { Database } from '@repo/db';
import {
  createPublicDocumentHandlers,
  DOCUMENT_PAGE_POLICY,
  type CommerceOptions,
  type PublicAnswer,
  type PublicDocumentHandlers,
  type PublicDocumentRequest,
} from '@repo/module-commerce';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { contentDisposition } from './content-disposition.js';
import type { PublicBookingRateLimit } from './public-booking.js';

export interface PublicDocumentTransport {
  readonly handlers: PublicDocumentHandlers;
  /** Mandatory, as for every public surface: a transport cannot answer without it. */
  readonly rateLimit: PublicBookingRateLimit;
}

/** The transport of an install: the module's own handlers, behind the shared limiter. */
export function registeredPublicDocuments(
  db: Database,
  options: CommerceOptions,
  rateLimit: PublicBookingRateLimit,
): PublicDocumentTransport {
  return { handlers: createPublicDocumentHandlers(db, options), rateLimit };
}

/** What is kept of a browser's name for itself. */
const USER_AGENT_LENGTH = 500;
/** An answer's form posts a button and nothing else. */
const BODY_LIMIT = 1024;

const messages: Readonly<Record<number, string>> = {
  400: 'This request cannot be read.',
  429: 'Too many requests. Try again in a minute.',
  500: 'This document could not be opened. Try again later.',
  503: 'This document is temporarily unavailable. Try again later.',
};

/** One plain line for anything that is not a page: never the token, never an error's own words. */
function refuse(reply: FastifyReply, status: number): FastifyReply {
  return reply
    .code(status)
    .type('text/plain; charset=utf-8')
    .send(messages[status] ?? messages[400] ?? '');
}

const page = (reply: FastifyReply, status: number, html: string): FastifyReply =>
  reply
    .code(status)
    .header('content-security-policy', DOCUMENT_PAGE_POLICY)
    .type('text/html; charset=utf-8')
    .send(html);

function requestOf(request: FastifyRequest): PublicDocumentRequest {
  const userAgent = request.headers['user-agent'];
  return {
    requestId: request.id,
    ipAddress: request.ip,
    ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, USER_AGENT_LENGTH) }),
  };
}

const isAnswer = (value: string): value is QuoteAnswer =>
  quoteAnswers.some((answer) => answer === value);

/** Fastify's scope isolates these routes from the authenticated /api/v1 plugin. */
export async function registerPublicDocuments(
  app: FastifyInstance,
  transport: PublicDocumentTransport,
): Promise<void> {
  const { handlers, rateLimit } = transport;
  await app.register(
    (publicApp, _options, done) => {
      publicApp.addHook('onSend', async (_request, reply) => {
        reply
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .header('x-content-type-options', 'nosniff')
          .header('x-robots-tag', 'noindex, nofollow');
      });
      publicApp.addHook('onRequest', async (request, reply) => {
        try {
          const decision = await rateLimit(
            { requestId: request.id, ipAddress: request.ip },
            request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'write',
          );
          if (!decision.allowed) {
            if (!Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 1)
              throw new Error('Invalid limiter decision.');
            reply.header('retry-after', String(decision.retryAfterSeconds));
            return await refuse(reply, 429);
          }
        } catch {
          request.log.error({ statusCode: 503 }, 'Public document limiter unavailable');
          return refuse(reply, 503);
        }
      });
      publicApp.setErrorHandler((error, request, reply) => {
        // A request Fastify itself refuses (a body of a kind or a size this address does
        // not take) keeps its own 4xx status.
        const status =
          error instanceof Error &&
          'statusCode' in error &&
          typeof error.statusCode === 'number' &&
          error.statusCode >= 400 &&
          error.statusCode < 500
            ? error.statusCode
            : 500;
        // Neither the token nor a raw database error enters the log.
        if (status === 500)
          request.log.error({ statusCode: 500 }, 'Public document request failed');
        return refuse(reply, status);
      });
      const unavailable = (reply: FastifyReply, status: 404 | 410) =>
        page(reply, status, handlers.unavailable());
      publicApp.setNotFoundHandler((_request, reply) => unavailable(reply, 404));
      // A browser posts a form as urlencoded text. Nothing in it is read: the path says
      // which document and which answer.
      publicApp.removeAllContentTypeParsers();
      publicApp.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: BODY_LIMIT },
        (_request, _body, parsed) => {
          parsed(null, undefined);
        },
      );

      /** Sends what a handler found, or the one page for an address that opens nothing. */
      const answered = async <Value>(
        reply: FastifyReply,
        found: PublicAnswer<Value>,
        send: (value: Value) => FastifyReply | Promise<FastifyReply>,
      ): Promise<FastifyReply> =>
        found.outcome === 'ok'
          ? send(found.value)
          : unavailable(reply, found.outcome === 'gone' ? 410 : 404);

      interface Token {
        Params: { token: string };
      }
      const options = { exposeHeadRoute: false } as const;

      publicApp.get<Token>('/:token', options, async (request, reply) =>
        answered(reply, await handlers.page(request.params.token, requestOf(request)), (html) =>
          page(reply, 200, html),
        ),
      );
      publicApp.get<Token>('/:token/pdf', options, async (request, reply) =>
        answered(reply, await handlers.pdf(request.params.token, requestOf(request)), (file) =>
          reply
            .header('content-type', file.contentType)
            .header('content-length', String(file.content.byteLength))
            .header('content-disposition', contentDisposition(false, file.filename))
            .header('content-security-policy', "default-src 'none'; sandbox")
            .send(Buffer.from(file.content)),
        ),
      );
      publicApp.get<Token>('/:token/logo', options, async (request, reply) =>
        answered(reply, await handlers.logo(request.params.token, requestOf(request)), (logo) =>
          reply
            .header('content-type', logo.contentType)
            .header('content-length', String(logo.size))
            .header('content-security-policy', "default-src 'none'; sandbox")
            .send(logo.body),
        ),
      );
      publicApp.post<{ Params: { token: string; answer: string } }>(
        '/:token/:answer',
        { bodyLimit: BODY_LIMIT },
        async (request, reply) => {
          const { token, answer } = request.params;
          if (!isAnswer(answer)) return unavailable(reply, 404);
          return answered(
            reply,
            await handlers.answer(token, answer, requestOf(request)),
            (result) =>
              result.answered
                ? // Back to the page, so reloading it never posts the answer again.
                  reply.redirect(`${SALES_DOCUMENT_LINK_PATH}/${token}`, 303)
                : page(reply, 409, result.html),
          );
        },
      );
      done();
    },
    { prefix: SALES_DOCUMENT_LINK_PATH },
  );
}
