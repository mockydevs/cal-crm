import { createHash } from 'node:crypto';
import type { PublicBookingHandlers, PublicBookingRequestContext } from '@repo/module-calendar';
import {
  bookPublicAppointment,
  cancelPublicAppointment,
  getPublicAppointment,
  getPublicAppointmentSlots,
  getPublicCalendar,
  getPublicCalendarChallenge,
  getPublicCalendarSlots,
  parseInput,
  PROBLEM_CONTENT_TYPE,
  publicBookingEndpoints,
  reschedulePublicAppointment,
  type Problem,
} from '@repo/contracts';
import { AppError, httpStatus } from '@repo/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import { fastifyPath } from './api-path.js';
import { registerBookingEmbedScript, type BookingEmbedScript } from './booking-embed.js';
import {
  createIntakeGate,
  INTAKE_GATE_FULL,
  INTAKE_GATE_RETRY_SECONDS,
  type IntakeGate,
} from './intake-gate.js';
import { createIntakeScopes, type IntakeScopes } from './intake-scopes.js';

/**
 * Mandatory shared limiter: a transport cannot silently allow requests without it. With
 * `businessId`, the request also counts toward that business's own ceiling.
 */
export type PublicBookingRateLimit = (
  request: PublicBookingRequestContext & { readonly businessId?: string | undefined },
  operation: 'read' | 'write',
) => Promise<
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }
>;

export interface PublicBookingTransport {
  readonly handlers: PublicBookingHandlers;
  readonly rateLimit: PublicBookingRateLimit;
  /**
   * Which business a booking address or an appointment's link belongs to, as learned from
   * requests the module resolved. Its own by default.
   */
  readonly scopes?: IntakeScopes | undefined;
  /**
   * Lets one request of a business at a time reach the handlers (intake-gate.ts): every
   * one of them holds the business's row. Its own by default.
   */
  readonly gate?: IntakeGate | undefined;
  /**
   * The booking embed's script, served at /calendars/embed.js. Left out where it was not
   * built: the booking page can still be framed, at the height its tag gives it.
   */
  readonly script?: BookingEmbedScript | undefined;
}

const emptyQuery = z.strictObject({});
const BODY_LIMIT = 8192;
const messages: Readonly<Record<number, readonly [string, string]>> = {
  400: ['Bad Request', 'The booking request cannot be read.'],
  403: ['Forbidden', 'This booking link cannot be used.'],
  404: ['Not Found', 'This booking link cannot be used.'],
  409: ['Conflict', 'That slot is taken, or the appointment has changed. Reload and try again.'],
  413: ['Content Too Large', 'The booking request is too large.'],
  415: ['Unsupported Media Type', 'Send booking details as JSON.'],
  422: ['Unprocessable Content', 'Check the booking details and try again.'],
  429: ['Too Many Requests', 'Wait before trying the booking request again.'],
  500: ['Internal Server Error', 'The booking request could not be completed.'],
  503: ['Service Unavailable', 'Booking is temporarily unavailable. Try again later.'],
};

function refuse(reply: FastifyReply, status: number): FastifyReply {
  const [title, detail] = messages[status] ??
    messages[500] ?? ['Internal Server Error', 'The booking request could not be completed.'];
  const problem: Problem = { type: 'about:blank', title, status, detail };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * What names a request's business before anything is looked up. A booking address names it
 * by the agency's and the business's slugs, whichever calendar it is for, so every calendar
 * of a business is counted as that business. An appointment's link is the permission
 * itself, so it is kept as a digest and never as it was sent. Undefined for anything else.
 */
function scopeKey(request: FastifyRequest): string | undefined {
  const { agencySlug, businessSlug, token } = (request.params ?? {}) as Readonly<
    Record<string, unknown>
  >;
  if (typeof agencySlug === 'string' && typeof businessSlug === 'string')
    return `book:${agencySlug}/${businessSlug}`;
  if (typeof token === 'string')
    return `link:${createHash('sha256').update(token).digest('base64url')}`;
  return undefined;
}

/** Fastify5 scope isolates these routes from the authenticated /api/v1 plugin. */
export async function registerPublicBooking(
  app: FastifyInstance,
  transport: PublicBookingTransport,
): Promise<void> {
  const scopes = transport.scopes ?? createIntakeScopes();
  const gate = transport.gate ?? createIntakeGate();
  if (transport.script !== undefined) registerBookingEmbedScript(app, transport.script);
  /**
   * The line a request waits in: its business's, once this process knows which business
   * that is. Until then a booking address waits in the line of its own two slugs, which
   * name one business. A link nobody has resolved yet waits in none: if it names nothing
   * it is answered after one statement that holds no row.
   */
  const lineOf = (request: FastifyRequest): string | undefined => {
    const key = scopeKey(request);
    if (key === undefined) return undefined;
    return scopes.get(key) ?? (key.startsWith('book:') ? key : undefined);
  };
  // The module says which business a request is for once it has found it. Only an address
  // or a link that names one is remembered, so made-up ones fill nothing.
  const requestContext = (request: FastifyRequest): PublicBookingRequestContext => {
    const key = scopeKey(request);
    return {
      requestId: request.id,
      ipAddress: request.ip,
      ...(key === undefined
        ? {}
        : {
            onBusiness: (businessId: string) => {
              scopes.learn(key, businessId);
            },
          }),
    };
  };
  await app.register(
    (publicApp, _options, done) => {
      publicApp.addHook('onSend', async (_request, reply) => {
        reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      });
      publicApp.addHook('onRequest', async (request, reply) => {
        // A business this process has already resolved a request for: this request counts
        // toward that business's own ceiling as well as its address's.
        const key = scopeKey(request);
        const businessId = key === undefined ? undefined : scopes.get(key);
        try {
          const decision = await transport.rateLimit(
            {
              requestId: request.id,
              ipAddress: request.ip,
              ...(businessId === undefined ? {} : { businessId }),
            },
            request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'write',
          );
          if (!decision.allowed) {
            if (!Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 1)
              throw new Error('Invalid limiter decision.');
            reply.header('retry-after', String(decision.retryAfterSeconds));
            return await refuse(reply, 429);
          }
        } catch {
          request.log.error({ statusCode: 503 }, 'Public booking limiter unavailable');
          return refuse(reply, 503);
        }
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
          request.log.error({ statusCode: status }, 'Public booking request failed');
        // Sent sooner after the page was shown than a person books: the page waits this
        // long and sends the same booking again.
        if (
          status === 429 &&
          error instanceof Error &&
          'retryAfterSeconds' in error &&
          typeof error.retryAfterSeconds === 'number' &&
          Number.isSafeInteger(error.retryAfterSeconds) &&
          error.retryAfterSeconds >= 1
        )
          reply.header('retry-after', String(Math.min(error.retryAfterSeconds, 86_400)));
        return refuse(reply, status);
      });
      publicApp.setNotFoundHandler((_request, reply) => refuse(reply, 404));

      const register = (
        endpoint: (typeof publicBookingEndpoints)[number],
        run: (request: FastifyRequest) => Promise<unknown>,
      ) => {
        publicApp.route({
          method: endpoint.method.toUpperCase(),
          url: fastifyPath(endpoint.path.slice('/public'.length)),
          bodyLimit: BODY_LIMIT,
          exposeHeadRoute: false,
          handler: async (request, reply) => {
            if (endpoint !== getPublicCalendarSlots && endpoint !== getPublicAppointmentSlots)
              parseInput(emptyQuery, request.query);
            const line = lineOf(request);
            const answer =
              line === undefined ? await run(request) : await gate(line, () => run(request));
            // Too many of this business's requests are waiting already: this one waits on
            // the visitor's page instead, and is sent again under the same request id.
            if (answer === INTAKE_GATE_FULL) {
              reply.header('retry-after', String(INTAKE_GATE_RETRY_SECONDS));
              return refuse(reply, 429);
            }
            const response = endpoint.response.schema.parse(answer);
            return reply.code(endpoint.response.status).send(response);
          },
        });
      };
      const { handlers } = transport;
      register(getPublicCalendar, (request) =>
        handlers.calendar(
          parseInput(getPublicCalendar.params, request.params),
          requestContext(request),
        ),
      );
      register(getPublicCalendarSlots, (request) =>
        handlers.slots(
          parseInput(getPublicCalendarSlots.params, request.params),
          parseInput(getPublicCalendarSlots.query, request.query),
          requestContext(request),
        ),
      );
      register(bookPublicAppointment, (request) =>
        handlers.book(
          parseInput(bookPublicAppointment.params, request.params),
          parseInput(bookPublicAppointment.body, request.body),
          requestContext(request),
        ),
      );
      register(getPublicCalendarChallenge, (request) =>
        handlers.challenge(
          parseInput(getPublicCalendarChallenge.params, request.params),
          parseInput(getPublicCalendarChallenge.body, request.body),
          requestContext(request),
        ),
      );
      register(getPublicAppointment, (request) =>
        handlers.appointment(
          parseInput(getPublicAppointment.params, request.params).token,
          requestContext(request),
        ),
      );
      register(getPublicAppointmentSlots, (request) =>
        handlers.appointmentSlots(
          parseInput(getPublicAppointmentSlots.params, request.params).token,
          parseInput(getPublicAppointmentSlots.query, request.query),
          requestContext(request),
        ),
      );
      register(cancelPublicAppointment, (request) =>
        handlers.cancel(
          parseInput(cancelPublicAppointment.params, request.params).token,
          parseInput(cancelPublicAppointment.body, request.body),
          requestContext(request),
        ),
      );
      register(reschedulePublicAppointment, (request) =>
        handlers.reschedule(
          parseInput(reschedulePublicAppointment.params, request.params).token,
          parseInput(reschedulePublicAppointment.body, request.body),
          requestContext(request),
        ),
      );
      done();
    },
    { prefix: '/api/v1/public' },
  );
}
