import { parseVoiceCallbackPath } from '@repo/module-messaging';
import type { FastifyInstance } from 'fastify';
import type { VoiceRelayReply, VoiceRelayRequest } from './voice-relay.js';

/** Both direct worker handling and the app's fixed-target relay use this boundary. */
export interface VoiceWebhookTransport {
  handle(request: VoiceRelayRequest): Promise<VoiceRelayReply>;
}

/**
 * Encapsulated buffer parser preserves signed bytes without changing API JSON parsing.
 * https://fastify.dev/docs/latest/Reference/ContentTypeParser/#body-parser
 */
export async function registerVoiceWebhooks(
  app: FastifyInstance,
  transport: VoiceWebhookTransport,
): Promise<void> {
  await app.register((webhooks, _options, done) => {
    webhooks.addHook('onRequest', (_request, reply, next) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      next();
    });
    webhooks.setErrorHandler((failure, _request, reply) => {
      const status =
        failure instanceof Error &&
        'statusCode' in failure &&
        typeof failure.statusCode === 'number'
          ? failure.statusCode
          : 503;
      return reply.code(status >= 400 && status < 500 ? status : 503).send();
    });
    webhooks.removeAllContentTypeParsers();
    webhooks.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer', bodyLimit: 65_536 },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    webhooks.post(
      '/webhooks/twilio/voice/:token/:kind',
      { bodyLimit: 65_536 },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body) || parseVoiceCallbackPath(request.url) === null)
          return reply.code(400).send();
        const signature = request.headers['x-twilio-signature'];
        if (typeof signature !== 'string' || signature === '' || signature.length > 512)
          return reply.code(403).send();
        const result = await transport.handle({ path: request.url, body: request.body, signature });
        return reply.code(result.statusCode).type(result.contentType).send(result.body);
      },
    );
    done();
  });
}
