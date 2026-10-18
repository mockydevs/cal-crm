// Settings → Integrations' two addresses outside the JSON API.
//
// GET /api/v1/integrations/{key}/callback is where a provider sends the browser back after
// consent. It reads the session cookie the dashboard signed in with, finishes the connection
// as that person, and sends them to Settings → Integrations with the provider and one word for
// what happened, never a token. Registered beside the API plugin, as Google Calendar's own
// callback is: the attempt named by the state says which business it is for. Google
// Calendar's address (/api/v1/integrations/google/callback) is static and so is matched first.
//
// POST /webhooks/integrations/{provider}/{token} is where a provider sends its updates for one
// connection. The raw body is stored unverified and the worker checks its signature; the
// answer says only whether it was taken.
import type { Authentication } from '@repo/module-auth';
import type {
  CallbackPerson,
  CallbackResult,
  IntegrationCallback,
  IntegrationWebhookOutcome,
  IntegrationWebhookRequest,
} from '@repo/module-integrations';
import { INTEGRATION_WEBHOOK_BODY_BYTES } from '@repo/module-integrations';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod';

export const INTEGRATION_CALLBACK_PATH = '/api/v1/integrations/:key/callback';

export interface IntegrationCallbackTransport {
  readonly complete: (
    key: string,
    callback: IntegrationCallback,
    person: CallbackPerson,
    correlationId: string,
  ) => Promise<CallbackResult>;
}

export interface IntegrationWebhookTransport {
  readonly accept: (request: IntegrationWebhookRequest) => Promise<IntegrationWebhookOutcome>;
}

// What a provider sends back (RFC 6749 section 4.1.2); any other parameter is ignored.
const answer = z.looseObject({
  state: z.string().max(200).optional(),
  code: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
});

const key = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

/** The browser's request headers, as the session reader takes them. */
function headersOf(raw: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const each of value) headers.append(name, each);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function registerIntegrationCallback(
  app: FastifyInstance,
  options: {
    readonly authentication: Authentication;
    readonly transport: IntegrationCallbackTransport;
    readonly publicUrl: string;
  },
): void {
  const back = (path: string, integration: string | undefined, outcome: string) => {
    const url = new URL(path, options.publicUrl);
    if (integration !== undefined) url.searchParams.set('integration', integration);
    url.searchParams.set('outcome', outcome);
    return url.href;
  };
  app.get<{ Params: { key: string } }>(
    INTEGRATION_CALLBACK_PATH,
    { exposeHeadRoute: false },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      const provider = key.safeParse(request.params.key);
      if (!provider.success) return reply.redirect(back('/', undefined, 'failed'), 302);
      const parsed = answer.safeParse(request.query);
      const session = await options.authentication.signedIn(headersOf(request.headers));
      // Signed out meanwhile: sign in again, then connect again.
      if (session?.agencyId === undefined)
        return reply.redirect(back('/', provider.data, 'expired'), 302);
      if (session.twoFactorRequired && !session.twoFactorEnabled)
        return reply.redirect(back('/', provider.data, 'failed'), 302);
      const { authentication } = options;
      let result: CallbackResult;
      try {
        result = await options.transport.complete(
          provider.data,
          parsed.success
            ? { state: parsed.data.state, code: parsed.data.code, error: parsed.data.error }
            : { state: undefined, code: undefined, error: undefined },
          {
            userId: session.userId,
            grantsIn: async (businessId) => {
              const workplace = await authentication.workplace(session, businessId);
              return workplace.at === 'business' && workplace.businessId === businessId
                ? workplace.permissions
                : undefined;
            },
          },
          request.id,
        );
      } catch (error) {
        // Nothing of the request (its code) is logged; the error is the database's or ours.
        request.log.error({ err: error }, 'An integration could not be connected');
        return reply.redirect(back('/', provider.data, 'failed'), 302);
      }
      return reply.redirect(back(result.path ?? '/', provider.data, result.outcome), 302);
    },
  );
}

/**
 * Fastify 5 encapsulation keeps the API's JSON parser outside this plugin; parseAs buffer
 * keeps the bytes that were signed, and the limit applies before the handler.
 * https://fastify.dev/docs/latest/Reference/ContentTypeParser/#body-parser
 */
export async function registerIntegrationWebhooks(
  app: FastifyInstance,
  transport: IntegrationWebhookTransport,
): Promise<void> {
  await app.register((webhooks, _options, done) => {
    // Driver errors and anything a provider sent stay out of the log.
    webhooks.setErrorHandler((failure, request, reply) => {
      const status =
        failure instanceof Error &&
        'statusCode' in failure &&
        typeof failure.statusCode === 'number'
          ? failure.statusCode
          : undefined;
      if (status !== undefined && status >= 400 && status < 500) return reply.code(status).send();
      request.log.warn(
        { code: 'integration_webhook_unavailable' },
        'Integration intake unavailable',
      );
      return reply.code(503).send();
    });
    webhooks.removeAllContentTypeParsers();
    webhooks.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: INTEGRATION_WEBHOOK_BODY_BYTES },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    webhooks.route<{ Params: { provider: string; token: string } }>({
      method: 'POST',
      url: '/webhooks/integrations/:provider/:token',
      bodyLimit: INTEGRATION_WEBHOOK_BODY_BYTES,
      async handler(request, reply) {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const outcome = await transport.accept({
          provider: request.params.provider,
          token: request.params.token,
          headers: request.headers,
          body,
        });
        const status = { accepted: 200, unknown: 404, refused: 400, over_capacity: 503 }[outcome];
        return reply.code(status).send();
      },
    });
    done();
  });
}
