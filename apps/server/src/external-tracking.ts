// External Tracking's public HTTP surface: the script a business pastes into its other
// websites, and the one address that script reports to. Built like the forms transport
// (forms-embed/transport.ts), with the same shared limiter and the same rules:
//
// 1. the shared rate limit, by address and, once this process has admitted a request for
//    the tracking id, by its business too; fail closed;
// 2. the gate: the tracking id and the Origin header. A request it refuses learns nothing:
//    one generic answer and no CORS header;
// 3. JSON only, a small body, and the contract's strict schema;
// 4. the handler's answer, or one of a few generic problems.
//
// Two answers are readable from any website because they carry nothing: the limiter's
// refusal and the preflight. Every other answer names the admitted origin and allows no
// credentials: the script sends no cookie and no token of a person.
//
// The script is the same bytes for everyone, from memory, with no database call, so loading
// it costs nothing an attacker could use up, as /forms/embed.js and /calendars/embed.js.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  parseInput,
  postPublicTrackingEvent,
  PROBLEM_CONTENT_TYPE,
  publicTrackingReceipt,
  type Problem,
  type PublicTrackingEvent,
  type PublicTrackingReceipt,
} from '@repo/contracts';
import { AppError, httpStatus } from '@repo/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { PublicBookingRateLimit } from './public-booking.js';
import { createIntakeScopes, type IntakeScopes } from './public-intake-limit.js';

/** Where websites load the script from: the address the Installation tab hands out. */
export const TRACKING_SCRIPT_URL = '/tracking/external-tracking.js';
const PREFIX = '/api/v1/public/tracking';
/** The largest event: fifty fields of a thousand characters fit with room to spare. */
const BODY_LIMIT = 32_768;
const PREFLIGHT_SECONDS = 600;

export interface TrackingRequestInfo {
  readonly requestId: string;
  readonly ipAddress: string;
  readonly gpc: boolean;
}

export type PublicTrackingRefusal =
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'limited'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'stale' };

/** What the transport reads of an admission: where it came from and whose id it is. */
export interface AdmittedTracking {
  readonly origin: string;
  readonly businessId: string;
}

/** What the transport needs from the forms module's PublicTrackingHandlers. */
export interface PublicTrackingPorts<Admission extends AdmittedTracking> {
  readonly admit: (trackingId: string, originHeader: unknown) => Promise<Admission | undefined>;
  readonly record: (
    admission: Admission,
    event: PublicTrackingEvent,
    request: TrackingRequestInfo,
  ) => Promise<
    { readonly outcome: 'ok'; readonly receipt: PublicTrackingReceipt } | PublicTrackingRefusal
  >;
}

export interface TrackingScript {
  readonly body: Buffer;
  readonly etag: string;
}

export interface PublicTrackingTransport<Admission extends AdmittedTracking> {
  readonly handlers: PublicTrackingPorts<Admission>;
  readonly rateLimit: PublicBookingRateLimit;
  /** Left out where the script was not built: the API still answers, the script is a 404. */
  readonly script?: TrackingScript | undefined;
  readonly scopes?: IntakeScopes | undefined;
}

/** The bundle the build step wrote (tracking-script/tools/build.ts), or undefined. */
export function loadTrackingScript(
  file: URL = new URL('./tracking-script/external-tracking.bundle.js', import.meta.url),
): TrackingScript | undefined {
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    return undefined;
  }
  return { body, etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
}

const messages: Readonly<Record<number, readonly [string, string]>> = {
  400: ['Bad Request', 'The tracking request cannot be read.'],
  403: ['Forbidden', 'Tracking is not available here.'],
  404: ['Not Found', 'Tracking is not available here.'],
  409: ['Conflict', 'The page changed. Load it again.'],
  413: ['Content Too Large', 'The tracking request is too large.'],
  415: ['Unsupported Media Type', 'Send tracking requests as JSON.'],
  422: ['Unprocessable Content', 'The tracking request does not fit.'],
  429: ['Too Many Requests', 'Wait before trying again.'],
  500: ['Internal Server Error', 'The tracking request could not be completed.'],
  503: ['Service Unavailable', 'Tracking is temporarily unavailable. Try again later.'],
};
const refusalStatus = { unavailable: 403, limited: 429, stale: 409 } as const;

function refuse(reply: FastifyReply, status: number): FastifyReply {
  const [title, detail] = messages[status] ?? messages[500] ?? ['Error', 'Failed.'];
  const problem: Problem = { type: 'about:blank', title, status, detail };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

const readableAnywhere = (reply: FastifyReply): FastifyReply =>
  reply
    .header('access-control-allow-origin', '*')
    .header('access-control-expose-headers', 'Retry-After');

const boundedWait = (seconds: number): string =>
  String(Number.isSafeInteger(seconds) && seconds >= 1 ? Math.min(seconds, 86_400) : 60);

export async function registerPublicTracking<Admission extends AdmittedTracking>(
  app: FastifyInstance,
  transport: PublicTrackingTransport<Admission>,
): Promise<void> {
  const { handlers, script } = transport;
  const scopes = transport.scopes ?? createIntakeScopes();

  if (script !== undefined)
    app.get(TRACKING_SCRIPT_URL, { exposeHeadRoute: false }, (request, reply) => {
      void reply
        .header('cache-control', 'public, max-age=300')
        .header('etag', script.etag)
        .header('x-content-type-options', 'nosniff')
        .header('cross-origin-resource-policy', 'cross-origin')
        .header('referrer-policy', 'no-referrer');
      if (request.headers['if-none-match'] === script.etag) return reply.code(304).send();
      return reply.type('text/javascript; charset=utf-8').send(script.body);
    });

  await app.register(
    (publicApp, _options, done) => {
      const admissions = new WeakMap<FastifyRequest, Admission>();
      publicApp.removeContentTypeParser('text/plain');
      publicApp.addHook('onSend', async (_request, reply) => {
        reply
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .header('x-content-type-options', 'nosniff')
          .header('vary', 'Origin');
      });
      publicApp.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS') return;
        const trackingId = (request.params as { trackingId?: unknown } | null)?.trackingId;
        const businessId = typeof trackingId === 'string' ? scopes.get(trackingId) : undefined;
        try {
          const decision = await transport.rateLimit(
            {
              requestId: request.id,
              ipAddress: request.ip,
              ...(businessId === undefined ? {} : { businessId }),
            },
            'write',
          );
          if (!decision.allowed) {
            reply.header('retry-after', boundedWait(decision.retryAfterSeconds));
            return await refuse(readableAnywhere(reply), 429);
          }
        } catch {
          request.log.error({ statusCode: 503 }, 'Public tracking limiter unavailable');
          return refuse(readableAnywhere(reply), 503);
        }
      });
      // The gate: unknown id, business off, website not admitted, no Origin: one answer.
      publicApp.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS') return;
        const params = postPublicTrackingEvent.params.safeParse(request.params);
        const admission = params.success
          ? await handlers.admit(params.data.trackingId, request.headers.origin)
          : undefined;
        if (admission === undefined) return refuse(reply, 403);
        if (params.success) scopes.learn(params.data.trackingId, admission.businessId);
        admissions.set(request, admission);
        reply
          .header('access-control-allow-origin', admission.origin)
          .header('access-control-expose-headers', 'Retry-After');
      });
      publicApp.setErrorHandler((error, request, reply) => {
        const status =
          error instanceof AppError
            ? httpStatus(error)
            : error instanceof Error &&
                'statusCode' in error &&
                typeof error.statusCode === 'number' &&
                error.statusCode >= 400 &&
                error.statusCode < 500
              ? error.statusCode
              : 500;
        // The status alone: never the body, the page or the error's text.
        if (status >= 500)
          request.log.error({ statusCode: status }, 'Public tracking request failed');
        return refuse(reply, status);
      });
      publicApp.setNotFoundHandler((_request, reply) => refuse(reply, 404));

      publicApp.route({
        method: 'POST',
        url: '/:trackingId/events',
        bodyLimit: BODY_LIMIT,
        exposeHeadRoute: false,
        handler: async (request, reply) => {
          const admission = admissions.get(request);
          // Every route is behind the gate; a request without an admission never reaches one.
          if (admission === undefined) throw new Error('A tracking request passed no gate.');
          const event = parseInput(postPublicTrackingEvent.body, request.body);
          const result = await handlers.record(admission, event, {
            requestId: request.id,
            ipAddress: request.ip,
            gpc: request.headers['sec-gpc'] === '1',
          });
          if (result.outcome === 'ok')
            return reply.code(200).send(publicTrackingReceipt.parse(result.receipt));
          if (result.outcome === 'limited')
            reply.header('retry-after', boundedWait(result.retryAfterSeconds));
          return refuse(reply, refusalStatus[result.outcome]);
        },
      });
      // The preflight before a JSON post: the same for everyone, from memory.
      publicApp.options('/:trackingId/events', (_request, reply) =>
        readableAnywhere(reply)
          .header('access-control-allow-methods', 'POST')
          .header('access-control-allow-headers', 'content-type')
          .header('access-control-max-age', String(PREFLIGHT_SECONDS))
          .code(204)
          .send(),
      );
      done();
    },
    { prefix: PREFIX },
  );
}
