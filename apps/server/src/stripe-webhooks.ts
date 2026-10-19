// POST /webhooks/stripe/<token> is where a business's own Stripe account sends its events. The
// API keeps the request as it came; the worker alone opens the signing secret and checks it.
// Stripe needs the raw body to check a signature, so the body is kept as bytes, never parsed.
// Stripe treats any answer but a 2xx as a failure and sends the event again for up to three days
// (https://docs.stripe.com/webhooks.md), so a full queue answers 503.
import type { StripeWebhookAcceptance } from '@repo/module-commerce';
import { STRIPE_WEBHOOK_MAX_BYTES } from '@repo/module-commerce';
import type { FastifyInstance } from 'fastify';

export interface StripeWebhookTransport {
  accept(request: {
    readonly token: string;
    readonly signature: unknown;
    readonly body: Uint8Array;
  }): Promise<StripeWebhookAcceptance>;
}

const statusOf: Readonly<Record<StripeWebhookAcceptance, number>> = {
  accepted: 200,
  unknown: 404,
  refused: 400,
  over_capacity: 503,
};

/** Fastify's encapsulation keeps the API's JSON parser outside this plugin. */
export async function registerStripeWebhooks(
  app: FastifyInstance,
  transport: StripeWebhookTransport,
): Promise<void> {
  await app.register((webhooks, _options, done) => {
    // Neither the token nor a database error reaches the log.
    webhooks.setErrorHandler((failure, request, reply) => {
      const status =
        failure instanceof Error &&
        'statusCode' in failure &&
        typeof failure.statusCode === 'number'
          ? failure.statusCode
          : undefined;
      if (status !== undefined && status >= 400 && status < 500) return reply.code(status).send();
      request.log.warn({ code: 'stripe_webhook_intake_unavailable' }, 'Stripe intake unavailable');
      return reply.code(503).send();
    });
    webhooks.removeAllContentTypeParsers();
    webhooks.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: STRIPE_WEBHOOK_MAX_BYTES },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    webhooks.post<{ Params: { token: string } }>(
      '/webhooks/stripe/:token',
      { bodyLimit: STRIPE_WEBHOOK_MAX_BYTES },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body)) return reply.code(400).send();
        const outcome = await transport.accept({
          token: request.params.token,
          signature: request.headers['stripe-signature'],
          body: request.body,
        });
        return reply.code(statusOf[outcome]).send();
      },
    );
    done();
  });
}
