// The HTTP server: health and readiness for every role, and for the app role the API
// (registered from the routes the modules export) and the dashboard.
import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { resolve as resolvePath, sep as pathSeparator } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { ApiRoute, Grants, Services, UploadBody } from '@repo/commands';
import {
  internalServerProblem,
  PROBLEM_CONTENT_TYPE,
  problemFor,
  apiKeyPersonalGroups,
  oauthAccessTokenFormat,
  SLUG,
  type FileDownload,
  type Problem,
} from '@repo/contracts';
import openapi from '@repo/contracts/openapi.json' with { type: 'json' };
import {
  AppError,
  ForbiddenError,
  parsePublicId,
  toPublicId,
  type TenantContext,
} from '@repo/kernel';
import {
  AUTH_BASE_PATH,
  CLIENT_IP_HEADER,
  type ApiKeyAccess,
  type ApiKeyTarget,
  type Authentication,
  type SignedIn,
} from '@repo/module-auth';
import type { WebchatAdmission } from '@repo/module-messaging';
import type { FormAdmission, TrackingAdmission } from '@repo/module-forms';
import type { Files } from '@repo/module-files';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Config } from './config.js';
import { forwardingOptions } from './client-address.js';
import { startRealtime } from './realtime.js';
import { registerTriggerLinkRedirect, type TriggerLinkRedirect } from './trigger-link-redirect.js';
import { registerUnsubscribe } from './unsubscribe.js';
import { registerPublicBooking, type PublicBookingTransport } from './public-booking.js';
import { BOOKING_PAGE_FRAMING, isBookingPagePath } from './booking-embed.js';
import { registerSmsWebhooks, type SmsWebhookTransport } from './sms-webhooks.js';
import { registerStripeWebhooks, type StripeWebhookTransport } from './stripe-webhooks.js';
import { registerVoiceWebhooks, type VoiceWebhookTransport } from './voice-webhooks.js';
import { registerGoogleCallback, type GoogleCallbackTransport } from './google-callback.js';
import {
  registerIntegrationCallback,
  registerIntegrationWebhooks,
  type IntegrationCallbackTransport,
  type IntegrationWebhookTransport,
} from './integrations-http.js';
import { registerPublicWebchat, type PublicWebchatTransport } from './webchat-widget/transport.js';
import { registerPublicForms, type PublicFormTransport } from './forms-embed/transport.js';
import { registerPublicTracking, type PublicTrackingTransport } from './external-tracking.js';
import { registerPublicDocuments, type PublicDocumentTransport } from './commerce-public.js';
import { registerOAuth, type OAuthTransport } from './oauth.js';
import { registerPublicSites, type PublicSiteTransport } from './public-sites.js';
import { registerPublicMedia, type PublicMediaTransport } from './public-media.js';
import { redactedRequestUrl } from './sensitive-paths.js';
import { fastifyPath } from './api-path.js';
import { contentDisposition } from './content-disposition.js';

export const API_PREFIX = '/api/v1';

export { fastifyPath } from './api-path.js';
export { contentDisposition } from './content-disposition.js';

export interface ServerOptions {
  readonly config: Config;
  /** pino, with the options from logger.ts; created first so the database can log too. */
  readonly logger: FastifyBaseLogger;
  /** Whether this process serves the API and the dashboard (roles app and all). */
  readonly serveApi: boolean;
  readonly routes: readonly ApiRoute[];
  readonly services: Services;
  /** Signing in (roles app and all): its endpoints, and the session behind each request. */
  readonly authentication?: Authentication | undefined;
  /** Public booking is mounted only with concrete handlers and the shared limiter. */
  readonly publicBooking?: PublicBookingTransport;
  /** Public quarantine intake; signature verification belongs to the opening worker. */
  readonly smsWebhooks?: SmsWebhookTransport;
  /** A business's Stripe events, kept for the worker, which checks their signatures. */
  readonly stripeWebhooks?: StripeWebhookTransport;
  /** Direct on the opening-vault worker/all role; fixed-target relay on app role. */
  readonly voiceWebhooks?: VoiceWebhookTransport;
  /** Where a trigger link is opened: GET /l/<token>, which redirects. */
  readonly triggerLinks?: TriggerLinkRedirect;
  /**
   * Where Google sends a member back after consent: GET
   * /api/v1/integrations/google/callback. Mounted only with sign-in and Google configured.
   */
  readonly googleCallback?: GoogleCallbackTransport;
  /**
   * Where a provider sends the browser back after consent, for Settings → Integrations: GET
   * /api/v1/integrations/{key}/callback. Mounted only with sign-in and a sealing vault.
   */
  readonly integrationCallback?: IntegrationCallbackTransport;
  /** A provider's updates for a connection: stored unverified for the worker to check. */
  readonly integrationWebhooks?: IntegrationWebhookTransport;
  /**
   * Web chat's public API and the widget script, mounted only with the messaging
   * module's handlers and the shared limiter. The admission is the module's own value.
   */
  readonly publicWebchat?: PublicWebchatTransport<WebchatAdmission>;
  /**
   * The forms' public API and the embed script, mounted only with the forms
   * module's handlers and the shared limiter. The admission is the module's own value.
   */
  readonly publicForms?: PublicFormTransport<FormAdmission>;
  /**
   * External Tracking: the script a business pastes into its other websites and the address
   * it reports to, mounted only with the forms module's handlers and the shared limiter.
   */
  readonly publicTracking?: PublicTrackingTransport<TrackingAdmission>;
  /**
   * A quote's or an invoice's public page: /d/<token>, mounted only with the
   * commerce module's handlers and the shared limiter.
   */
  readonly publicDocuments?: PublicDocumentTransport;
  /**
   * OAuth for installed apps: /oauth/token, /oauth/revoke and the server's
   * metadata. Mounted only with sign-in and the shared limiter.
   */
  readonly oauth?: OAuthTransport;
  /** A site's published pages on the install's own address: /s/<key>/<path>. */
  readonly publicSites?: PublicSiteTransport;
  /** A media file's public and preview addresses: /m/<key>/<name>, /m/p/<id>. */
  readonly publicMedia?: PublicMediaTransport;
  /** The files service (roles app and all), for downloads by link. */
  readonly files?: Files | undefined;
  /** The app process enables its authenticated, business-scoped refresh stream. */
  readonly realtime?: boolean;
  /** What /ready checks; each rejects when its dependency is down. */
  readonly readinessChecks: Readonly<Record<string, () => Promise<void>>>;
}

export interface Server {
  readonly app: FastifyInstance;
  /**
   * Stops taking requests and lets those in flight finish, then closes every connection.
   * Whatever is still open when the deadline passes is closed anyway.
   */
  close(timeoutMs: number): Promise<void>;
}

function problemWith(status: number, detail: string): Problem {
  return { type: 'about:blank', title: STATUS_CODES[status] ?? 'Error', status, detail };
}

/** What the caller sees for any error: details only for errors they can act on. */
export function toProblem(error: unknown): Problem {
  if (error instanceof AppError) return problemFor(error);
  // Fastify's own errors carry a 4xx status: malformed JSON, a body that's too large.
  if (error instanceof Error && 'statusCode' in error) {
    const status = Number(error.statusCode);
    if (status >= 400 && status < 500) return problemWith(status, error.message);
  }
  return internalServerProblem;
}

function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

const contexts = new WeakMap<FastifyRequest, TenantContext>();

/** What each request may change: its role's permissions where it works. */
const grants = new WeakMap<FastifyRequest, Grants>();
const keyAccess = new WeakMap<FastifyRequest, ApiKeyAccess>();

/** Credentials and personal-state endpoints never accept a program's identity. */
const PERSON_ONLY_GROUPS = new Set<string>(apiKeyPersonalGroups);
const KEY_FORBIDDEN_OPERATIONS = new Set(['getTwoFactorRequirement', 'setTwoFactorRequirement']);

/**
 * Who signed a request in, and the business it works in, for GET /api/v1/me. Requests the
 * development stand-in signs have none.
 */
const people = new WeakMap<
  FastifyRequest,
  { readonly person: SignedIn; readonly businessId: string | undefined }
>();

/**
 * The business a request names in its Business-Id header: undefined when it names
 * none, and null when what it names can't be a business id.
 */
function namedBusiness(request: FastifyRequest): string | null | undefined {
  const named = request.headers['business-id'];
  if (named === undefined) return undefined;
  return (typeof named === 'string' ? parsePublicId('business', named) : undefined) ?? null;
}

/** Both selectors are optional, but never together. Slugs use the creation contract. */
function keyTarget(request: FastifyRequest): ApiKeyTarget | null | undefined {
  const slug = request.headers['business-slug'];
  const id = namedBusiness(request);
  if (slug !== undefined && id !== undefined) return null;
  if (id === null) return null;
  if (slug !== undefined) {
    return typeof slug === 'string' && SLUG.test(slug) ? { businessSlug: slug } : null;
  }
  return id === undefined ? undefined : { businessId: id };
}

/**
 * The key a request signs in with, from `Authorization: Bearer …`. Undefined
 * without the header; '' when the header is there but holds no Bearer key, which no key
 * matches.
 */
function bearerKey(request: FastifyRequest): string | undefined {
  const { authorization } = request.headers;
  if (authorization === undefined) return undefined;
  return /^Bearer (\S+)$/i.exec(authorization)?.[1] ?? '';
}

/** Methods that change nothing, so a request from another site can do no harm with them. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A request's headers as the Fetch API holds them; repeated headers keep every value. */
function fetchHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const each of value) headers.append(name, each);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

/**
 * The request as Better Auth takes it: at the public address, with the body as sent, and
 * the client's IP as the server read it (TRUST_PROXY) in the one header Better Auth reads.
 */
function authRequest(request: FastifyRequest, publicUrl: string): Request {
  const headers = fetchHeaders(request);
  // Hop-by-hop headers, and the body's length, describe this connection, not the request.
  for (const name of ['host', 'connection', 'content-length', 'transfer-encoding']) {
    headers.delete(name);
  }
  headers.set(CLIENT_IP_HEADER, request.ip);
  const { body } = request;
  return new Request(new URL(request.url, publicUrl), {
    method: request.method,
    headers,
    ...(Buffer.isBuffer(body) ? { body } : {}),
  });
}

/** Sends a Fetch API response, every Set-Cookie header included. */
async function sendResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.code(response.status);
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

/** Whether a download route (Endpoint.download) answered with a file, as its contract says. */
function isDownload(value: unknown): value is FileDownload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    value.content instanceof Uint8Array &&
    'contentType' in value &&
    typeof value.contentType === 'string' &&
    'filename' in value &&
    typeof value.filename === 'string'
  );
}

/** An upload's body as the route takes it: the request's bytes, unread. */
function uploadBody(request: FastifyRequest): UploadBody {
  const length = request.headers['content-length'];
  return {
    stream: request.raw,
    contentType: request.headers['content-type'],
    contentLength: length !== undefined && /^\d+$/.test(length) ? Number(length) : undefined,
  };
}

/** Whom an API request acts for, set when it was signed in. */
export function tenantContextOf(request: FastifyRequest): TenantContext {
  const context = contexts.get(request);
  if (context === undefined) throw new Error(`No tenant context for ${request.url}`);
  return context;
}

/**
 * The app's own page (the dashboard, sign-in, an appointment's own link) may be framed by
 * itself only: on another site's page it could be dressed up to steal a click. Both headers
 * say it, the second for browsers that predate the first. A calendar's booking page alone
 * may be framed by any website (booking-embed.ts).
 */
function notFramedElsewhere<Reply extends { header: (name: string, value: string) => Reply }>(
  reply: Reply,
): Reply {
  return reply
    .header('content-security-policy', "frame-ancestors 'self'")
    .header('x-frame-options', 'SAMEORIGIN');
}

export async function buildServer(options: ServerOptions): Promise<Server> {
  const { config } = options;
  let draining = false;

  const app = Fastify({
    loggerInstance: options.logger,
    // Every request gets its own id; one sent by the client isn't trusted.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // request.ip is the visitor, read through these proxies only.
    ...forwardingOptions(config.trustProxy),
    // Router errors run before Fastify hooks. Never reflect a capability-bearing URL.
    routerOptions: {
      onBadUrl: (_path, _request, response) => {
        response.writeHead(400, {
          'content-type': PROBLEM_CONTENT_TYPE,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        response.end(JSON.stringify(problemWith(400, 'The request path is malformed.')));
      },
      onMaxParamLength: (_path, _request, response) => {
        response.writeHead(414, {
          'content-type': PROBLEM_CONTENT_TYPE,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        response.end(JSON.stringify(problemWith(414, 'The request path is too long.')));
      },
    },
  });
  const realtime =
    options.realtime === true && options.serveApi && options.authentication !== undefined
      ? startRealtime({
          httpServer: app.server,
          databaseUrl: config.databaseAppUrl,
          publicUrl: config.publicUrl,
          authentication: options.authentication,
          logger: options.logger,
        })
      : undefined;

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (redactedRequestUrl(request.url) !== request.url) {
      // Never stored. A page that also asked not to be rewritten on the way (a draft's
      // preview, whose policy names its stylesheet by its digest) still asks that.
      const exact = String(reply.getHeader('cache-control') ?? '').includes('no-transform');
      reply
        .header('cache-control', exact ? 'no-store, no-transform' : 'no-store')
        .header('referrer-policy', 'no-referrer');
    }
    // While shutting down, each finished response closes its connection, so no idle
    // keep-alive connection holds the process open.
    if (draining) reply.header('connection', 'close');
  });

  app.setErrorHandler(async (error, request, reply) => {
    const problem = toProblem(error);
    if (problem.status >= 500) request.log.error({ err: error }, 'request failed');
    return sendProblem(reply, problem);
  });

  app.get('/health', () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    if (draining) return reply.code(503).send({ status: 'shutting down' });
    const results = await Promise.allSettled(
      Object.entries({
        ...options.readinessChecks,
        ...(realtime === undefined ? {} : { realtime: realtime.ready }),
      }).map(async ([name, check]) => {
        await check();
        return name;
      }),
    );
    const failed = Object.keys({
      ...options.readinessChecks,
      ...(realtime === undefined ? {} : { realtime: realtime.ready }),
    }).filter((_name, index) => results[index]?.status === 'rejected');
    if (failed.length > 0) return reply.code(503).send({ status: 'unavailable', failed });
    return { status: 'ready' };
  });

  const { authentication } = options;
  if (options.serveApi) await registerUnsubscribe(app, options.services.db);
  if (options.serveApi && options.publicBooking !== undefined) {
    await registerPublicBooking(app, options.publicBooking);
  }
  if (options.serveApi && options.triggerLinks !== undefined) {
    await registerTriggerLinkRedirect(app, options.triggerLinks);
  }
  if (options.serveApi && options.smsWebhooks !== undefined) {
    await registerSmsWebhooks(app, options.smsWebhooks);
  }
  if (options.serveApi && options.stripeWebhooks !== undefined) {
    await registerStripeWebhooks(app, options.stripeWebhooks);
  }
  if (options.voiceWebhooks !== undefined) {
    await registerVoiceWebhooks(app, options.voiceWebhooks);
  }
  if (
    options.serveApi &&
    options.googleCallback !== undefined &&
    options.authentication !== undefined
  ) {
    registerGoogleCallback(app, {
      authentication: options.authentication,
      transport: options.googleCallback,
      publicUrl: config.publicUrl,
    });
  }
  if (
    options.serveApi &&
    options.integrationCallback !== undefined &&
    options.authentication !== undefined
  ) {
    registerIntegrationCallback(app, {
      authentication: options.authentication,
      transport: options.integrationCallback,
      publicUrl: config.publicUrl,
    });
  }
  if (options.serveApi && options.integrationWebhooks !== undefined) {
    await registerIntegrationWebhooks(app, options.integrationWebhooks);
  }
  if (options.serveApi && options.publicWebchat !== undefined) {
    await registerPublicWebchat(app, options.publicWebchat);
  }
  if (options.serveApi && options.publicForms !== undefined) {
    await registerPublicForms(app, options.publicForms);
  }
  if (options.serveApi && options.publicTracking !== undefined) {
    await registerPublicTracking(app, options.publicTracking);
  }
  if (options.serveApi && options.publicDocuments !== undefined) {
    await registerPublicDocuments(app, options.publicDocuments);
  }
  if (options.serveApi && options.oauth !== undefined) {
    await registerOAuth(app, options.oauth);
  }
  if (options.serveApi && options.publicSites !== undefined) {
    await registerPublicSites(app, options.publicSites);
  }
  if (options.serveApi && options.publicMedia !== undefined) {
    await registerPublicMedia(app, options.publicMedia);
  }
  if (options.serveApi && authentication !== undefined) {
    await app.register(
      (auth, _options, done) => {
        // Better Auth reads the body itself, so it gets the bytes as they arrived.
        auth.removeAllContentTypeParsers();
        auth.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, parsed) => {
          parsed(null, body);
        });
        auth.all('/*', async (request, reply) =>
          sendResponse(reply, await authentication.handle(authRequest(request, config.publicUrl))),
        );
        done();
      },
      { prefix: AUTH_BASE_PATH },
    );
  }

  const { files } = options;
  if (options.serveApi && files !== undefined) {
    app.get<{ Params: { id: string } }>(
      `${API_PREFIX}/files/:id/content`,
      // HEAD would open the file only to throw it away.
      { exposeHeadRoute: false },
      async (request, reply) => {
        const opened = await files.open(options.services.db, {
          fileId: request.params.id,
          query: request.query,
          now: new Date(),
          correlationId: request.id,
        });
        if ('refused' in opened) {
          return sendProblem(
            reply,
            opened.refused === 'not_found'
              ? problemWith(404, "There's no such file.")
              : problemWith(
                  403,
                  opened.refused === 'expired'
                    ? 'This link has expired.'
                    : "This link isn't valid.",
                ),
          );
        }
        // Whatever a file holds, a browser shows it as its type at most, and runs nothing.
        return reply
          .header('content-type', opened.contentType)
          .header('content-length', String(opened.size))
          .header('content-disposition', contentDisposition(opened.inline, opened.filename))
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('referrer-policy', 'no-referrer')
          .header('cache-control', 'private, no-store')
          .send(opened.body);
      },
    );
  }

  if (options.serveApi) {
    app.get(`${API_PREFIX}/openapi.json`, () => openapi);

    await app.register(
      (api, _options, done) => {
        api.addHook('onSend', async (_request, reply) => {
          reply.header('cache-control', 'private, no-store');
          reply.header('referrer-policy', 'no-referrer');
        });
        api.addHook('onRequest', async (request, reply) => {
          // Authenticate before resolving selectors, without accepting cookie fallback.
          const key = bearerKey(request);
          if (key !== undefined) {
            // An installed app's access token acts as its app key; the rest as keys.
            const appToken = oauthAccessTokenFormat.test(key);
            const find = (target?: ApiKeyTarget) =>
              appToken
                ? authentication?.appToken(key, target)
                : authentication?.apiKey(key, target);
            let access = await find();
            if (access === undefined) {
              // RFC 6750, section 3.1: the token is unknown, revoked or expired.
              void reply.header('www-authenticate', 'Bearer error="invalid_token"');
              return sendProblem(
                reply,
                problemWith(
                  401,
                  appToken
                    ? "That access token doesn't work: it may have expired, or the app was uninstalled."
                    : "That API key doesn't work: it may have been revoked.",
                ),
              );
            }
            const target = keyTarget(request);
            if (target === null) {
              return sendProblem(reply, problemWith(403, 'Choose one valid business selector.'));
            }
            if (target !== undefined) access = await find(target);
            if (access === undefined) {
              return sendProblem(
                reply,
                problemWith(
                  403,
                  appToken
                    ? 'This access token works only in the business that installed the app.'
                    : 'This API key cannot access the selected business.',
                ),
              );
            }
            keyAccess.set(request, access);
            grants.set(request, access.permissions);
            contexts.set(request, {
              agencyId: access.agencyId,
              ...(access.businessId === undefined ? {} : { businessId: access.businessId }),
              actorKind: 'api_key',
              actorId: access.keyId,
              correlationId: request.id,
            });
            return;
          }
          if (request.headers['business-slug'] !== undefined) {
            return sendProblem(reply, problemWith(403, 'Business-Slug requires an API key.'));
          }
          const session = await authentication?.signedIn(fetchHeaders(request));
          if (authentication !== undefined && session !== undefined) {
            if (session.agencyId === undefined) {
              return sendProblem(reply, problemWith(403, "You aren't a member of an agency yet."));
            }
            // Until they've set it up, only Better Auth's endpoints (/api/auth), which set it
            // up, answer them.
            if (session.twoFactorRequired && !session.twoFactorEnabled) {
              return sendProblem(
                reply,
                problemWith(403, 'Set up two-factor sign-in first: your agency requires it.'),
              );
            }
            // The business the request works in, as its memberships allow. Only
            // agency staff work at the agency, which sees every business.
            const businessId = namedBusiness(request);
            if (businessId === null) {
              return sendProblem(reply, problemWith(404, "There's no such business."));
            }
            const workplace = await authentication.workplace(session, businessId);
            // /me tells someone which businesses they may enter, so it alone answers before
            // they've chosen one, and when the only one they belong to is closed: it reads
            // only who they are, no tenant's rows.
            if (
              workplace.at === 'refused' &&
              businessId === undefined &&
              (workplace.code === 'choose_business' || workplace.code === 'unavailable') &&
              request.method === 'GET' &&
              request.routeOptions.url === `${API_PREFIX}/me`
            ) {
              people.set(request, { person: session, businessId: undefined });
              return;
            }
            if (workplace.at === 'refused') {
              return sendProblem(reply, problemWith(workplace.status, workplace.message));
            }
            // A browser sends the session cookie with requests other sites start, too; only
            // the install's own pages may change anything.
            if (!SAFE_METHODS.has(request.method) && request.headers.origin !== config.publicUrl) {
              return sendProblem(
                reply,
                problemWith(403, `Changes are accepted only from ${config.publicUrl}.`),
              );
            }
            people.set(request, {
              person: session,
              businessId: workplace.at === 'business' ? workplace.businessId : undefined,
            });
            grants.set(request, workplace.permissions);
            contexts.set(request, {
              agencyId: session.agencyId,
              ...(workplace.at === 'business' ? { businessId: workplace.businessId } : {}),
              userId: session.userId,
              actorKind: 'user',
              actorId: session.userId,
              correlationId: request.id,
            });
            return;
          }
          // Development only (refused in production): every request as one configured user.
          const stub = config.devTenantContext;
          if (stub === undefined) {
            return sendProblem(reply, problemWith(401, 'Sign in to use the API.'));
          }
          const businessId = namedBusiness(request);
          if (businessId === null || (businessId !== undefined && businessId !== stub.businessId)) {
            return sendProblem(
              reply,
              problemWith(403, 'The development identity cannot select a business.'),
            );
          }
          // The stand-in has no role to look up; it may do everything, as in development.
          grants.set(request, 'all');
          contexts.set(request, {
            agencyId: stub.agencyId,
            ...(stub.businessId === undefined ? {} : { businessId: stub.businessId }),
            userId: stub.userId,
            actorKind: 'user',
            actorId: stub.userId,
            correlationId: request.id,
          });
        });

        if (authentication !== undefined) {
          api.get('/me', async (request, reply) => {
            const signedIn = people.get(request);
            if (signedIn === undefined) {
              return sendProblem(reply, problemWith(401, 'Sign in to see who you are.'));
            }
            const profile = await authentication.whoIs(signedIn.person);
            const { businessId } = signedIn;
            return {
              user: { name: profile.name, email: profile.email },
              agency: profile.agency,
              agencyStaff: profile.agencyStaff,
              businesses: profile.businesses.map((each) => ({
                ...each,
                id: toPublicId('business', each.id),
              })),
              business: businessId === undefined ? null : toPublicId('business', businessId),
            };
          });
        }

        const register = (
          instance: FastifyInstance,
          route: ApiRoute,
          bodyOf: (request: FastifyRequest) => unknown,
        ) => {
          const { endpoint } = route;
          instance.route({
            method: endpoint.method.toUpperCase(),
            url: fastifyPath(endpoint.path),
            handler: async (request, reply) => {
              const access = keyAccess.get(request);
              if (endpoint.operationId === 'getApiKeyContext' && access === undefined) {
                return sendProblem(reply, problemWith(403, 'An API key is required.'));
              }
              if (access !== undefined) {
                const keyContext = endpoint.operationId === 'getApiKeyContext';
                if (endpoint.group === 'API keys' && endpoint.method !== 'get')
                  return sendProblem(
                    reply,
                    problemFor(
                      new ForbiddenError('An API key cannot manage credentials.', 'apps.manage'),
                    ),
                  );
                if (
                  (PERSON_ONLY_GROUPS.has(endpoint.group) && !keyContext) ||
                  KEY_FORBIDDEN_OPERATIONS.has(endpoint.operationId)
                ) {
                  return sendProblem(reply, problemWith(403, 'This endpoint requires a person.'));
                }
                const preview =
                  endpoint.operationId === 'renderEmailPreview' && endpoint.method === 'post';
                const read = endpoint.method === 'get' || preview;
                if (access.readOnly === true && !read) {
                  return sendProblem(reply, problemWith(403, 'This API key is read-only.'));
                }
                if (
                  read &&
                  !keyContext &&
                  access.readGroups !== undefined &&
                  access.readGroups !== null &&
                  !access.readGroups.some((group) => group === endpoint.group)
                ) {
                  return sendProblem(
                    reply,
                    problemWith(403, 'This API key cannot read this group.'),
                  );
                }
              }
              const userAgent = request.headers['user-agent'];
              const result = await route.run(
                {
                  invocation: {
                    context: tenantContextOf(request),
                    permissions: grants.get(request) ?? new Set(),
                    ip: request.ip,
                    ...(userAgent === undefined ? {} : { userAgent }),
                  },
                  params: request.params,
                  query: request.query,
                  body: bodyOf(request),
                },
                options.services,
              );
              reply.code(endpoint.response.status);
              if (endpoint.download !== undefined) {
                // A file, as the endpoint's contract says: saved under its own name, shown
                // as its type at most, and never run.
                if (!isDownload(result) || !endpoint.download.types.includes(result.contentType))
                  throw new Error(`${endpoint.operationId} did not answer with its file.`);
                return reply
                  .header('content-type', result.contentType)
                  .header('content-length', String(result.content.byteLength))
                  .header('content-disposition', contentDisposition(false, result.filename))
                  .header('x-content-type-options', 'nosniff')
                  .header('content-security-policy', "default-src 'none'; sandbox")
                  .send(Buffer.from(result.content));
              }
              return endpoint.response.status === 204 ? reply.send() : result;
            },
          });
        };
        for (const route of options.routes) {
          if (route.endpoint.upload === undefined) register(api, route, (request) => request.body);
        }
        // An upload's body is the file, left unread for its route to stream.
        api.register((uploads, _uploadOptions, uploadsDone) => {
          uploads.removeAllContentTypeParsers();
          uploads.addContentTypeParser('*', (_request, _payload, parsed) => {
            parsed(null);
          });
          // A refused upload's unread rest isn't worth receiving: the connection closes.
          uploads.addHook('onSend', async (_request, reply) => {
            if (reply.statusCode >= 400) reply.header('connection', 'close');
          });
          for (const route of options.routes) {
            if (route.endpoint.upload !== undefined) register(uploads, route, uploadBody);
          }
          uploadsDone();
        });

        api.setNotFoundHandler(async (request, reply) =>
          sendProblem(
            reply,
            problemWith(404, `There's no ${request.method} ${redactedRequestUrl(request.url)}.`),
          ),
        );
        done();
      },
      { prefix: API_PREFIX },
    );

    if (config.dashboardDir !== undefined) {
      // File names under /assets carry a content hash, so they never change; index.html
      // is never cached, so a new release shows up on the next load.
      const assets = `${resolvePath(config.dashboardDir, 'assets')}${pathSeparator}`;
      await app.register(fastifyStatic, {
        root: config.dashboardDir,
        index: false,
        maxAge: '365d',
        immutable: true,
        // Only a file under /assets has a hash in its name. Anything else the build wrote
        // (index.html asked for by name, an icon, a manifest) keeps its name from one
        // release to the next, so a browser asks about it every time.
        setHeaders: (reply, file) => {
          if (resolvePath(file).startsWith(assets)) return;
          void reply.header('cache-control', 'no-cache');
          // The page sent for a booking page's address keeps the allowance it was given.
          if (file.endsWith('.html') && !isBookingPagePath(reply.request.url))
            notFramedElsewhere(reply);
        },
      });
      // To the static files' route, the site root is a folder, and with index pages off it
      // answers 403. The not-found handler serves the page there, as everywhere else.
      app.get('/', (_request, reply) => {
        reply.callNotFound();
      });
    }
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/unsubscribe')) {
      return reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .code(404)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problemWith(404, 'This unsubscribe link cannot be used.'));
    }
    // The static files' catch-all GET route also sees unknown API paths, so they're
    // excluded here: an API path never gets the page.
    const wantsPage =
      options.serveApi &&
      config.dashboardDir !== undefined &&
      request.method === 'GET' &&
      !request.url.startsWith(`${API_PREFIX}/`) &&
      !request.url.startsWith('/webhooks/') &&
      (request.headers.accept ?? '').includes('text/html');
    if (wantsPage) {
      // The dashboard's router handles every other path in the browser. A booking page is
      // the one any website may show in a frame, and says so instead.
      return (
        isBookingPagePath(request.url)
          ? reply.header('content-security-policy', BOOKING_PAGE_FRAMING)
          : notFramedElsewhere(reply)
      )
        .header('cache-control', 'no-cache')
        .sendFile('index.html', { cacheControl: false });
    }
    return sendProblem(
      reply,
      problemWith(404, `There's no ${request.method} ${redactedRequestUrl(request.url)}.`),
    );
  });

  await app.ready();

  return {
    app,
    async close(timeoutMs) {
      draining = true;
      const deadline = setTimeout(() => {
        app.log.warn({ timeoutMs }, 'shutdown deadline passed; closing every connection');
        app.server.closeAllConnections();
      }, timeoutMs);
      try {
        // Stop accepting HTTP while the listener and WebSockets close, then drain
        // requests already running. Neither close may wait for the other to start.
        await Promise.all([app.close(), realtime?.close()]);
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
