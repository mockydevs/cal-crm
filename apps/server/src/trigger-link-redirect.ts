// The public address a trigger link is opened at: GET /l/<token>. The token is the whole
// request: it finds the link and the contact it was issued for, the click is recorded, and
// the browser is sent to the destination stored for the link. No query parameter, header or
// cookie has any say in where that is, so the endpoint cannot be made to redirect anywhere
// a member of the business did not write down.
import { TRIGGER_LINK_PATH } from '@repo/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { PublicBookingRateLimit } from './public-booking.js';

export interface TriggerLinkRedirect {
  /** Records the click a token stands for and gives its destination, or nothing. */
  readonly open: (token: string, requestId: string) => Promise<string | undefined>;
  /**
   * The shared public limiter, where the install has one. Without it the endpoint still
   * answers: an unknown token costs one indexed read, and a known one records at most one
   * click a minute.
   */
  readonly rateLimit?: PublicBookingRateLimit | undefined;
}

const messages: Readonly<Record<number, string>> = {
  404: 'This link cannot be used.',
  429: 'Too many requests. Try the link again in a minute.',
  503: 'This link is temporarily unavailable. Try again later.',
  500: 'This link could not be opened. Try again later.',
};

function refuse(reply: FastifyReply, status: 404 | 429 | 500 | 503): FastifyReply {
  return reply
    .code(status)
    .type('text/plain; charset=utf-8')
    .send(messages[status] ?? '');
}

/** Fastify's scope isolates this route from the authenticated /api/v1 plugin. */
export async function registerTriggerLinkRedirect(
  app: FastifyInstance,
  transport: TriggerLinkRedirect,
): Promise<void> {
  await app.register(
    (publicApp, _options, done) => {
      publicApp.addHook('onSend', async (_request, reply) => {
        reply
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .header('x-content-type-options', 'nosniff')
          .header('x-robots-tag', 'noindex, nofollow');
      });
      const { rateLimit } = transport;
      if (rateLimit !== undefined)
        publicApp.addHook('onRequest', async (request, reply) => {
          try {
            const decision = await rateLimit(
              { requestId: request.id, ipAddress: request.ip },
              'write',
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
            request.log.error({ statusCode: 503 }, 'Trigger link limiter unavailable');
            return refuse(reply, 503);
          }
        });
      publicApp.setErrorHandler((_error, request, reply) => {
        // Neither the token nor a raw database error enters the log.
        request.log.error({ statusCode: 500 }, 'Trigger link could not be opened');
        return refuse(reply, 500);
      });
      publicApp.setNotFoundHandler((_request, reply) => refuse(reply, 404));
      publicApp.get<{ Params: { token: string } }>('/:token', async (request, reply) => {
        const destination = await transport.open(request.params.token, request.id);
        if (destination === undefined) return refuse(reply, 404);
        return reply.redirect(destination, 302);
      });
      done();
    },
    { prefix: TRIGGER_LINK_PATH },
  );
}
