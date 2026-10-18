// OAuth for installed apps, the endpoints an app calls itself:
//
//   POST /oauth/token                               a code, or a refresh token, for a token pair
//   POST /oauth/revoke                              stops a token's family (RFC 7009)
//   GET  /.well-known/oauth-authorization-server    what this server supports (RFC 8414)
//
// The person consents at /oauth/authorize, a dashboard page. Requests are form-encoded (RFC
// 6749 section 4.1.3); a parameter sent twice is refused (section 3.2). The client
// authenticates with HTTP Basic or in the body, never both (section 2.3). Answers carry
// Cache-Control: no-store (section 5.1). The shared public limiter goes first, by address.
import { apiKeyScopes, OAUTH_PATHS, type OAuthTokenError } from '@repo/contracts';
import type {
  OAuthRevokeOutcome,
  OAuthRevokeRequest,
  OAuthTokenOutcome,
  OAuthTokenRequest,
} from '@repo/module-auth';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { PublicBookingRateLimit } from './public-booking.js';

export interface OAuthTransport {
  /** The install's public address, the issuer (RFC 8414 section 2). */
  readonly issuer: string;
  readonly token: (request: OAuthTokenRequest) => Promise<OAuthTokenOutcome>;
  readonly revoke: (request: OAuthRevokeRequest) => Promise<OAuthRevokeOutcome>;
  /** Mandatory, as for every public surface. */
  readonly rateLimit: PublicBookingRateLimit;
}

/** A token request is a handful of short parameters. */
const BODY_LIMIT = 8 * 1024;

/** A form body, by name; a name sent twice is kept as a list, which is refused. */
type Form = Readonly<Record<string, string | readonly string[]>>;

function parseForm(text: string): Form {
  const form: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(text)) {
    const seen = form[name];
    form[name] =
      seen === undefined ? value : [...(typeof seen === 'string' ? [seen] : seen), value];
  }
  return form;
}

const isForm = (value: unknown): value is Form => typeof value === 'object' && value !== null;

/** Basic credentials: each part form-encoded, then the pair base64 (RFC 6749 section 2.3.1). */
function basicCredentials(
  request: FastifyRequest,
): { id: string; secret: string } | 'malformed' | undefined {
  const { authorization } = request.headers;
  if (authorization === undefined) return undefined;
  const encoded = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(authorization)?.[1];
  if (encoded === undefined) return 'malformed';
  const pair = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = pair.indexOf(':');
  if (colon < 0) return 'malformed';
  const formDecoded = (part: string) => decodeURIComponent(part.replaceAll('+', ' '));
  try {
    return { id: formDecoded(pair.slice(0, colon)), secret: formDecoded(pair.slice(colon + 1)) };
  } catch {
    return 'malformed';
  }
}

interface Parsed {
  readonly params: Readonly<Record<string, string>>;
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** Whether the client used HTTP Basic, so a refusal of it says how to authenticate. */
  readonly basic: boolean;
}

/** The request's parameters and client, or what is wrong with them. */
function parse(request: FastifyRequest): Parsed | { readonly invalid: string } {
  const body: unknown = request.body;
  if (!isForm(body)) return { invalid: 'Send the parameters form-encoded.' };
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) {
    if (typeof value !== 'string') return { invalid: `${name} is sent more than once.` };
    params[name] = value;
  }
  const basic = basicCredentials(request);
  if (basic === 'malformed') return { invalid: 'The Authorization header is not valid Basic.' };
  if (basic === undefined)
    return {
      params,
      ...(params['client_id'] === undefined ? {} : { clientId: params['client_id'] }),
      ...(params['client_secret'] === undefined ? {} : { clientSecret: params['client_secret'] }),
      basic: false,
    };
  if (params['client_secret'] !== undefined)
    return { invalid: 'Authenticate the client one way only: Basic or the body.' };
  if (params['client_id'] !== undefined && params['client_id'] !== basic.id)
    return { invalid: 'client_id does not match the Basic credentials.' };
  return { params, clientId: basic.id, clientSecret: basic.secret, basic: true };
}

function refuse(
  reply: FastifyReply,
  status: number,
  error: OAuthTokenError,
  description: string,
  basic = false,
): FastifyReply {
  // RFC 6749 section 5.2: a failed Basic authentication answers with its challenge.
  if (status === 401 && basic) void reply.header('www-authenticate', 'Basic realm="oauth"');
  return reply.code(status).send({ error, error_description: description });
}

/** Fastify's scope keeps these apart from the authenticated /api/v1 plugin. */
export async function registerOAuth(
  app: FastifyInstance,
  transport: OAuthTransport,
): Promise<void> {
  const { issuer, rateLimit } = transport;
  await app.register((oauth, _options, done) => {
    oauth.addHook('onSend', async (_request, reply) => {
      reply
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .header('referrer-policy', 'no-referrer')
        .header('x-content-type-options', 'nosniff');
    });
    oauth.addHook('onRequest', async (request, reply) => {
      try {
        const decision = await rateLimit(
          { requestId: request.id, ipAddress: request.ip },
          request.method === 'GET' ? 'read' : 'write',
        );
        if (!decision.allowed) {
          if (!Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 1)
            throw new Error('Invalid limiter decision.');
          reply.header('retry-after', String(decision.retryAfterSeconds));
          return await refuse(reply, 429, 'invalid_request', 'Too many requests. Try again later.');
        }
      } catch {
        request.log.error({ statusCode: 503 }, 'OAuth limiter unavailable');
        return refuse(reply, 503, 'invalid_request', 'Try again later.');
      }
    });
    oauth.setErrorHandler((error, request, reply) => {
      // What Fastify refuses itself (another content type, a body too large) keeps its 4xx.
      const status =
        error instanceof Error &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
          ? error.statusCode
          : 500;
      if (status === 500) {
        // Neither a token nor a secret enters the log.
        request.log.error({ statusCode: 500 }, 'OAuth request failed');
        return reply.code(500).send({ error: 'server_error' });
      }
      return refuse(reply, status, 'invalid_request', 'Send the parameters form-encoded.');
    });
    oauth.removeAllContentTypeParsers();
    oauth.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: BODY_LIMIT },
      (_request, body, parsed) => {
        parsed(null, parseForm(typeof body === 'string' ? body : body.toString('utf8')));
      },
    );

    const options = { exposeHeadRoute: false } as const;

    oauth.post(OAUTH_PATHS.token, options, async (request, reply) => {
      const found = parse(request);
      if ('invalid' in found) return refuse(reply, 400, 'invalid_request', found.invalid);
      const { params } = found;
      const outcome = await transport.token({
        ...(params['grant_type'] === undefined ? {} : { grantType: params['grant_type'] }),
        ...(params['code'] === undefined ? {} : { code: params['code'] }),
        ...(params['redirect_uri'] === undefined ? {} : { redirectUri: params['redirect_uri'] }),
        ...(params['code_verifier'] === undefined ? {} : { codeVerifier: params['code_verifier'] }),
        ...(params['refresh_token'] === undefined ? {} : { refreshToken: params['refresh_token'] }),
        ...(found.clientId === undefined ? {} : { clientId: found.clientId }),
        ...(found.clientSecret === undefined ? {} : { clientSecret: found.clientSecret }),
      });
      if (outcome.outcome === 'issued') return reply.code(200).send(outcome.tokens);
      return refuse(reply, outcome.status, outcome.error, outcome.description, found.basic);
    });

    oauth.post(OAUTH_PATHS.revoke, options, async (request, reply) => {
      const found = parse(request);
      if ('invalid' in found) return refuse(reply, 400, 'invalid_request', found.invalid);
      const outcome = await transport.revoke({
        ...(found.params['token'] === undefined ? {} : { token: found.params['token'] }),
        ...(found.clientId === undefined ? {} : { clientId: found.clientId }),
        ...(found.clientSecret === undefined ? {} : { clientSecret: found.clientSecret }),
      });
      if (outcome.outcome === 'revoked') return reply.code(200).send();
      return refuse(
        reply,
        outcome.status,
        outcome.error,
        outcome.error === 'invalid_client'
          ? 'The client id or secret is not valid.'
          : 'Send token.',
        found.basic,
      );
    });

    oauth.get(OAUTH_PATHS.metadata, options, () => ({
      issuer,
      authorization_endpoint: `${issuer}${OAUTH_PATHS.authorize}`,
      token_endpoint: `${issuer}${OAUTH_PATHS.token}`,
      revocation_endpoint: `${issuer}${OAUTH_PATHS.revoke}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: apiKeyScopes,
      authorization_response_iss_parameter_supported: true,
    }));
    done();
  });
}
