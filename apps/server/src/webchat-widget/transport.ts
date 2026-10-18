// The public HTTP surface of web chat: what a visitor's browser calls from a business's
// website, with no sign-in. Built like public-booking.ts, with the same shared limiter, and
// stricter in one way: every request must come from a website on the widget's list, and
// only such a request ever gets a CORS header.
//
// Order of checks, before any handler: 1. the shared rate limit, by address (fail closed);
// 2. the widget key and the Origin header (the gate). A request the gate refuses learns
// nothing: one generic answer, and no CORS header, so a page elsewhere cannot even read it.
//
// Two answers are readable from any website, because they are the same for every website
// and every key, and carry nothing: the limiter's refusal (so a widget sees 429 and its
// Retry-After, and waits, instead of seeing a network failure and trying again), and the
// preflight (a browser drops the real request when its preflight fails, so a refused
// preflight would hide that 429 too). Neither looks anything up. Every answer that
// depends on a widget, a website or a session still goes only to that widget's website.
//
// What the Origin check is worth: a browser sets Origin and a page cannot forge it, so no
// other website can use a widget. A program that is not a browser can send any Origin. For
// that there are the rate limit, the per-widget and per-session limits, and the bounds.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  endPublicWebchatSession,
  getPublicWebchat,
  listPublicWebchatMessages,
  parseInput,
  PROBLEM_CONTENT_TYPE,
  sendPublicWebchatMessage,
  startPublicWebchatSession,
  type Problem,
  type PublicWebchatMessageInput,
  type PublicWebchatSessionInput,
} from '@repo/contracts';
import { AppError, httpStatus } from '@repo/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';

import { fastifyPath } from '../api-path.js';
import type { PublicBookingRateLimit } from '../public-booking.js';
import { createIntakeScopes, type IntakeScopes } from '../public-intake-limit.js';

/** Where websites load the script from, and where the API lives. */
export const WEBCHAT_SCRIPT_URL = '/webchat/widget.js';
const PREFIX = '/api/v1/public/webchat';
/** A message is at most 2000 characters; as JSON that is under 12 KiB at the very worst. */
const BODY_LIMIT = 16_384;
/** How long a browser may remember a preflight answer. */
const PREFLIGHT_SECONDS = 600;

/** Why a handler did nothing; the module's WebchatRefusal. */
export type PublicWebchatRefusal =
  | { readonly outcome: 'session_invalid' }
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'limited'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'session_full' };

interface RequestInfo {
  readonly requestId: string;
}

/** What the transport reads of an admission: where it came from and whose widget it is. */
export interface AdmittedWidget {
  readonly origin: string;
  /** The widget's business, for the limit each business has. Left out, only the address counts. */
  readonly businessId?: string | undefined;
}

/**
 * What the transport needs from the messaging module (its PublicWebchatHandlers). The
 * admission is the module's own value: the transport reads only the stored origin from it,
 * for the CORS header, and the business, for the limiter, and hands it back unchanged.
 */
export interface PublicWebchatPorts<Admission extends AdmittedWidget> {
  readonly admit: (widgetKey: string, originHeader: unknown) => Promise<Admission | undefined>;
  readonly config: (
    admission: Admission,
  ) => Promise<{ readonly outcome: 'ok'; readonly config: unknown } | PublicWebchatRefusal>;
  readonly start: (
    admission: Admission,
    input: PublicWebchatSessionInput,
    request: RequestInfo,
  ) => Promise<{ readonly outcome: 'ok'; readonly session: unknown } | PublicWebchatRefusal>;
  readonly send: (
    admission: Admission,
    token: string | undefined,
    input: PublicWebchatMessageInput,
    request: RequestInfo,
  ) => Promise<{ readonly outcome: 'ok'; readonly message: unknown } | PublicWebchatRefusal>;
  readonly messages: (
    admission: Admission,
    token: string | undefined,
    after: number,
  ) => Promise<{ readonly outcome: 'ok'; readonly page: unknown } | PublicWebchatRefusal>;
  readonly end: (
    admission: Admission,
    token: string | undefined,
    request: RequestInfo,
  ) => Promise<{ readonly outcome: 'ok' } | PublicWebchatRefusal>;
}

/** The built widget, held in memory. */
export interface WidgetScript {
  readonly body: Buffer;
  readonly etag: string;
}

export interface PublicWebchatTransport<Admission extends AdmittedWidget> {
  readonly handlers: PublicWebchatPorts<Admission>;
  /** The shared limiter of every public route. Required: without it nothing is mounted. */
  readonly rateLimit: PublicBookingRateLimit;
  /** Left out where the widget was not built: the API still answers, the script is a 404. */
  readonly script?: WidgetScript | undefined;
  /** Which business a widget key belongs to, as learned from requests admitted. Its own by default. */
  readonly scopes?: IntakeScopes | undefined;
}

/**
 * The bundle the build step wrote next to this file (webchat-widget/tools/build.ts), or
 * undefined when it is not there, as in tests and in development before a build.
 */
export function loadWidgetScript(
  file: URL = new URL('./widget.bundle.js', import.meta.url),
): WidgetScript | undefined {
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    return undefined;
  }
  return { body, etag: `"${createHash('sha256').update(body).digest('base64url')}"` };
}

const emptyQuery = z.strictObject({});
const messages: Readonly<Record<number, readonly [string, string]>> = {
  400: ['Bad Request', 'The chat request cannot be read.'],
  401: ['Unauthorized', 'This chat has ended. Start a new one.'],
  403: ['Forbidden', 'This chat cannot be used here.'],
  404: ['Not Found', 'This chat cannot be used here.'],
  409: ['Conflict', 'The chat changed. Send the message again.'],
  410: ['Gone', 'This chat is full. Start a new one.'],
  413: ['Content Too Large', 'The chat request is too large.'],
  415: ['Unsupported Media Type', 'Send chat requests as JSON.'],
  422: ['Unprocessable Content', 'Check the details and try again.'],
  429: ['Too Many Requests', 'Wait before trying again.'],
  500: ['Internal Server Error', 'The chat request could not be completed.'],
  503: ['Service Unavailable', 'Chat is temporarily unavailable. Try again later.'],
};
const refusalStatus = {
  session_invalid: 401,
  unavailable: 403,
  invalid: 422,
  limited: 429,
  session_full: 410,
} as const satisfies Record<PublicWebchatRefusal['outcome'], number>;

function refuse(reply: FastifyReply, status: number): FastifyReply {
  const [title, detail] = messages[status] ??
    messages[500] ?? ['Internal Server Error', 'The chat request could not be completed.'];
  const problem: Problem = { type: 'about:blank', title, status, detail };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/** The token of one well-formed Bearer header. The module checks it again before hashing. */
function bearer(request: FastifyRequest): string | undefined {
  const { authorization } = request.headers;
  return typeof authorization === 'string'
    ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1]
    : undefined;
}

const READS = new Set(['GET', 'HEAD']);

/** For the two answers that say nothing about any widget; never with credentials. */
function readableAnywhere(reply: FastifyReply): FastifyReply {
  return reply
    .header('access-control-allow-origin', '*')
    .header('access-control-expose-headers', 'Retry-After');
}

/**
 * Mounts the public web chat API in a scope of its own, apart from the signed-in API, and
 * the widget script when there is one.
 */
export async function registerPublicWebchat<Admission extends AdmittedWidget>(
  app: FastifyInstance,
  transport: PublicWebchatTransport<Admission>,
): Promise<void> {
  const { handlers, script } = transport;
  const scopes = transport.scopes ?? createIntakeScopes();

  if (script !== undefined) {
    // Loaded by a plain <script> tag on any website: no Origin to check and nothing
    // secret in it. It is the same bytes for everyone, from memory, with no database
    // call, so it is not counted by the limiter: a page view must cost the CRM nothing
    // that an attacker could use up. It changes with each release, so it is cached briefly.
    app.get(WEBCHAT_SCRIPT_URL, { exposeHeadRoute: false }, (request, reply) => {
      void reply
        .header('cache-control', 'public, max-age=300')
        .header('etag', script.etag)
        .header('x-content-type-options', 'nosniff')
        .header('cross-origin-resource-policy', 'cross-origin')
        .header('referrer-policy', 'no-referrer');
      if (request.headers['if-none-match'] === script.etag) return reply.code(304).send();
      return reply.type('text/javascript; charset=utf-8').send(script.body);
    });
  }

  await app.register(
    (publicApp, _options, done) => {
      const admissions = new WeakMap<FastifyRequest, Admission>();
      const admitted = (request: FastifyRequest): Admission => {
        const admission = admissions.get(request);
        // Every route is behind the gate; a request without an admission never reaches one.
        if (admission === undefined) throw new Error('A web chat request passed no gate.');
        return admission;
      };

      // Only JSON bodies: a cross-site form or a text/plain post gets 415, and a JSON
      // post from a browser is always preceded by a preflight.
      publicApp.removeContentTypeParser('text/plain');
      publicApp.addHook('onSend', async (_request, reply) => {
        reply
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .header('x-content-type-options', 'nosniff')
          // The answer depends on the Origin header, allowed or not.
          .header('vary', 'Origin');
      });
      publicApp.addHook('onRequest', async (request, reply) => {
        // A preflight is answered from memory, the same for everyone: it is not counted.
        if (request.method === 'OPTIONS') return;
        // A widget this process has already admitted a request for: its business is known,
        // and this request counts toward that business's own ceiling as well.
        const widgetKey = (request.params as { widgetKey?: unknown } | null)?.widgetKey;
        const businessId = typeof widgetKey === 'string' ? scopes.get(widgetKey) : undefined;
        try {
          const decision = await transport.rateLimit(
            {
              requestId: request.id,
              ipAddress: request.ip,
              ...(businessId === undefined ? {} : { businessId }),
            },
            READS.has(request.method) ? 'read' : 'write',
          );
          if (!decision.allowed) {
            if (!Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 1)
              throw new Error('Invalid limiter decision.');
            reply.header('retry-after', String(decision.retryAfterSeconds));
            return await refuse(readableAnywhere(reply), 429);
          }
        } catch {
          request.log.error({ statusCode: 503 }, 'Public web chat limiter unavailable');
          return refuse(readableAnywhere(reply), 503);
        }
      });
      // The gate. Unknown key, widget off, website not listed, Origin missing: one answer.
      publicApp.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS') return;
        const params = getPublicWebchat.params.safeParse(
          // A path with more after the key carries it in the same place.
          {
            widgetKey: (request.params as Readonly<Record<string, unknown>> | null)?.['widgetKey'],
          },
        );
        const admission = params.success
          ? await handlers.admit(params.data.widgetKey, request.headers.origin)
          : undefined;
        if (admission === undefined) return refuse(reply, 403);
        // Only a key that names a widget that is on is remembered: made-up keys fill nothing.
        if (params.success && admission.businessId !== undefined)
          scopes.learn(params.data.widgetKey, admission.businessId);
        admissions.set(request, admission);
        // The stored origin of the widget's own list: never `*`, never the header's text.
        // No credentials are allowed: the widget sends a bearer token, not cookies.
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
        if (status >= 500)
          request.log.error({ statusCode: status }, 'Public web chat request failed');
        return refuse(reply, status);
      });
      publicApp.setNotFoundHandler((_request, reply) => refuse(reply, 404));

      const answer = (
        reply: FastifyReply,
        endpoint: { readonly response: { readonly status: number; readonly schema?: z.ZodType } },
        result: PublicWebchatRefusal | { readonly outcome: 'ok' },
        value?: unknown,
      ): FastifyReply => {
        if (result.outcome === 'ok') {
          const { status, schema } = endpoint.response;
          // The contract's strict schema is the last word on what leaves.
          return schema === undefined
            ? reply.code(status).send()
            : reply.code(status).send(schema.parse(value));
        }
        if (result.outcome === 'limited') {
          const wait = result.retryAfterSeconds;
          reply.header(
            'retry-after',
            String(Number.isSafeInteger(wait) && wait >= 1 ? Math.min(wait, 86_400) : 60),
          );
        }
        return refuse(reply, refusalStatus[result.outcome]);
      };
      const route = (
        endpoint: { readonly method: string; readonly path: string },
        handler: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>,
      ): void => {
        publicApp.route({
          method: endpoint.method.toUpperCase(),
          url: fastifyPath(endpoint.path.slice('/public/webchat'.length)),
          bodyLimit: BODY_LIMIT,
          exposeHeadRoute: false,
          handler,
        });
      };
      const info = (request: FastifyRequest): RequestInfo => ({ requestId: request.id });

      route(getPublicWebchat, async (request, reply) => {
        parseInput(emptyQuery, request.query);
        const result = await handlers.config(admitted(request));
        return answer(
          reply,
          getPublicWebchat,
          result,
          'config' in result ? result.config : undefined,
        );
      });
      route(startPublicWebchatSession, async (request, reply) => {
        parseInput(emptyQuery, request.query);
        const input = parseInput(startPublicWebchatSession.body, request.body);
        const result = await handlers.start(admitted(request), input, info(request));
        return answer(
          reply,
          startPublicWebchatSession,
          result,
          'session' in result ? result.session : undefined,
        );
      });
      route(sendPublicWebchatMessage, async (request, reply) => {
        parseInput(emptyQuery, request.query);
        const input = parseInput(sendPublicWebchatMessage.body, request.body);
        const result = await handlers.send(
          admitted(request),
          bearer(request),
          input,
          info(request),
        );
        return answer(
          reply,
          sendPublicWebchatMessage,
          result,
          'message' in result ? result.message : undefined,
        );
      });
      route(listPublicWebchatMessages, async (request, reply) => {
        const { after } = parseInput(listPublicWebchatMessages.query, request.query);
        const result = await handlers.messages(admitted(request), bearer(request), after);
        return answer(
          reply,
          listPublicWebchatMessages,
          result,
          'page' in result ? result.page : undefined,
        );
      });
      route(endPublicWebchatSession, async (request, reply) => {
        parseInput(emptyQuery, request.query);
        // No body is read: the token alone says which session.
        const result = await handlers.end(admitted(request), bearer(request), info(request));
        return answer(reply, endPublicWebchatSession, result);
      });

      // The preflight a browser sends before a JSON post or a request with a token. It
      // allows the browser to send the request, whose own answer is then the gate's: a
      // website that is not listed gets that far and no further.
      const preflight = (_request: FastifyRequest, reply: FastifyReply): FastifyReply =>
        readableAnywhere(reply)
          .header('access-control-allow-methods', 'GET, POST')
          .header('access-control-allow-headers', 'authorization, content-type')
          .header('access-control-max-age', String(PREFLIGHT_SECONDS))
          .code(204)
          .send();
      publicApp.options('/:widgetKey', preflight);
      publicApp.options('/:widgetKey/*', preflight);
      done();
    },
    { prefix: PREFIX },
  );
}
