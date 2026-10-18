import type { SmsWebhookAcceptance, SmsWebhookRequest } from '@repo/module-messaging';
import { parseWebhookEndpoint, SMS_WEBHOOK_LIMITS } from '@repo/module-messaging';
import type { FastifyInstance } from 'fastify';

/** Durable intake stores bytes; the worker alone opens credentials and verifies them. */
export interface SmsWebhookTransport {
  accept(request: SmsWebhookRequest): Promise<SmsWebhookAcceptance>;
}

/**
 * Fastify5 encapsulation preserves the API's JSON parser outside this plugin.
 * parseAs buffer preserves signed bytes and enforces the bound before the callback.
 * https://fastify.dev/docs/latest/Reference/ContentTypeParser/#body-parser
 */
export async function registerSmsWebhooks(
  app: FastifyInstance,
  transport: SmsWebhookTransport,
): Promise<void> {
  await app.register((webhooks, _options, done) => {
    // Encapsulated error handling keeps driver exceptions/PII out of the root logger.
    // https://fastify.dev/docs/latest/Reference/Server/#seterrorhandler
    webhooks.setErrorHandler((failure, request, reply) => {
      const status =
        failure instanceof Error &&
        'statusCode' in failure &&
        typeof failure.statusCode === 'number'
          ? failure.statusCode
          : undefined;
      if (status !== undefined && status >= 400 && status < 500) return reply.code(status).send();
      request.log.warn({ code: 'sms_webhook_intake_unavailable' }, 'SMS intake unavailable');
      return reply.code(503).send();
    });
    webhooks.removeAllContentTypeParsers();
    webhooks.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer', bodyLimit: SMS_WEBHOOK_LIMITS.bodyBytes },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    // RouteOptions.url is a string in installed Fastify5.12.5 (types/route.d.ts).
    for (const url of ['/webhooks/twilio/:token/inbound', '/webhooks/twilio/:token/status'])
      webhooks.route<{ Params: { token: string } }>({
        method: 'POST',
        url,
        bodyLimit: SMS_WEBHOOK_LIMITS.bodyBytes,
        async handler(request, reply) {
          if (!Buffer.isBuffer(request.body)) return reply.code(400).send();
          const prefix = `/webhooks/twilio/${request.params.token}/`;
          // Only the generated spelling can be reconstructed by the signature worker.
          // No query decoding, Host or forwarding-header substitution is permitted.
          const endpoint = request.url.startsWith(prefix)
            ? parseWebhookEndpoint(request.url.slice(prefix.length))
            : null;
          if (endpoint === null) return reply.code(400).send();
          const result = await transport.accept({
            token: request.params.token,
            endpoint,
            headers: request.headers,
            body: request.body,
          });
          const status = {
            accepted: 200,
            unknown: 404,
            refused: 400,
            over_capacity: 503,
          }[result.outcome];
          return status === 200
            ? reply.type('text/xml').send('<Response/>')
            : reply.code(status).send();
        },
      });
    done();
  });
}
