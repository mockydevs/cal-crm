// The public HTTP surface of forms: what a visitor's browser calls from a business's
// website, with no sign-in. Built like the web chat transport, with the same shared limiter
// and the same rule: every request must come from a website on the form's list, and only
// such a request ever gets a CORS header.
//
// Order of checks, before any handler: 1. the shared rate limit, by address and, once this
// process has admitted a request for the form, by the form's business too (fail closed);
// 2. the form key and the Origin header (the gate). A request the gate refuses learns
// nothing: one generic answer, and no CORS header, so a page elsewhere cannot even read it.
//
// Two answers are readable from any website, because they are the same for every website
// and every key, and carry nothing: the limiter's refusal (so the embed sees 429 and its
// Retry-After instead of a network failure) and the preflight (a browser drops the real
// request when its preflight fails). Neither looks anything up.
//
// What the Origin check is worth: a browser sets Origin and a page cannot forge it, so no
// other website can show a form. A program that is not a browser can send any Origin. For
// that there are the rate limit, the form's own limits, the hidden field and the proof of
// when the form was shown.
//
// The CRM's own pages (page.ts: a form's page and the preview of a draft) are a website
// too, on the CRM's own address. A browser sends no Origin header with a GET to the
// address the page itself came from (the Fetch standard appends one only to requests to
// another origin and to requests that are not GET or HEAD), so the embed on those pages
// marks its requests with a header of its own, X-CRM-Form. A page on any other website
// cannot send it: it is not a header a cross-origin request may carry unless the
// preflight allows it, and the preflight here allows only Content-Type. So a request with
// that header and no Origin comes from a page of this address, or from a program that is
// not a browser, which could have sent any Origin anyway. Such a request is put to the
// gate as coming from the CRM's own origin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  FORM_PAGE_PATH,
  FORM_PREVIEW_PAGE_PATH,
  getPublicForm,
  getPublicFormChallenge,
  getPublicFormPreview,
  getPublicFormPreviewChallenge,
  parseInput,
  PROBLEM_CONTENT_TYPE,
  submitPublicForm,
  submitPublicFormPreview,
  type Problem,
  type PublicFormSubmissionInput,
} from '@repo/contracts';
import { AppError, httpStatus, type Issue } from '@repo/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';

import { fastifyPath } from '../api-path.js';
import type { PublicBookingRateLimit } from '../public-booking.js';
import { createIntakeScopes, type IntakeScopes } from '../public-intake-limit.js';
import { formPage, PAGE_POLICY, previewPage } from './page.js';

/** Where websites load the script from, and where the API lives. */
export const FORM_SCRIPT_URL = '/forms/embed.js';
/**
 * The header the embed sends from the CRM's own pages, where a browser sends no Origin
 * with a GET. Lowercase, as Node gives header names. Its value is always `1`.
 */
export const FORM_PAGE_HEADER = 'x-crm-form';
const PREFIX = '/api/v1/public/forms';
/**
 * A submission is at most 30 answers of at most 5000 characters. Most are a few hundred
 * bytes; this bounds the largest the server will read, well under what is stored.
 */
const BODY_LIMIT = 131_072;
/** How long a browser may remember a preflight answer. */
const PREFLIGHT_SECONDS = 600;
/** What is kept of a browser's name for itself. */
const USER_AGENT_LENGTH = 500;

/** Why a handler stored nothing; the module's FormRefusal. */
export type PublicFormRefusal =
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'limited'; readonly retryAfterSeconds: number }
  | { readonly outcome: 'stale' }
  | { readonly outcome: 'invalid'; readonly issues: readonly Issue[] }
  | { readonly outcome: 'changed' };

interface RequestInfo {
  readonly requestId: string;
  readonly ipAddress: string;
  readonly userAgent?: string | undefined;
}

/** What the transport reads of an admission: where it came from and whose form it is. */
export interface AdmittedForm {
  readonly origin: string;
  /** The form's business, for the limit each business has. Left out, only the address counts. */
  readonly businessId?: string | undefined;
}

/**
 * What the transport needs from the forms module (its PublicFormHandlers). The admission is
 * the module's own value: the transport reads only the stored origin from it, for the CORS
 * header, and the business, for the limiter, and hands it back unchanged.
 */
export interface PublicFormPorts<Admission extends AdmittedForm> {
  readonly admit: (formKey: string, originHeader: unknown) => Promise<Admission | undefined>;
  /** The gate of a preview: a link to a draft, from the CRM's own page and nowhere else. */
  readonly admitPreview: (
    previewToken: string,
    originHeader: unknown,
  ) => Promise<Admission | undefined>;
  /** The token in the answer is bound to the address that asked, so the address goes along. */
  readonly form: (
    admission: Admission,
    request: RequestInfo,
  ) => Promise<{ readonly outcome: 'ok'; readonly form: unknown } | PublicFormRefusal>;
  readonly submit: (
    admission: Admission,
    input: PublicFormSubmissionInput,
    request: RequestInfo,
  ) => Promise<{ readonly outcome: 'ok'; readonly receipt: unknown } | PublicFormRefusal>;
  /** A bot challenge bound to the render token the form was shown with. */
  readonly challenge: (
    admission: Admission,
    input: { readonly renderToken: string },
    request: RequestInfo,
  ) => Promise<{ readonly outcome: 'ok'; readonly challenge: unknown } | PublicFormRefusal>;
}

/** The built embed, held in memory. */
export interface EmbedScript {
  readonly body: Buffer;
  readonly etag: string;
}

export interface PublicFormTransport<Admission extends AdmittedForm> {
  readonly handlers: PublicFormPorts<Admission>;
  /** The shared limiter of every public route. Required: without it nothing is mounted. */
  readonly rateLimit: PublicBookingRateLimit;
  /** Left out where the embed was not built: the API still answers, the script is a 404. */
  readonly script?: EmbedScript | undefined;
  /**
   * The CRM's own origin, as a browser writes it (the forms module's ownOrigin). With it,
   * and the script, a form has a page of its own and a draft a preview. Left out, neither
   * page is served and no request is taken as the CRM's own.
   */
  readonly ownOrigin?: string | undefined;
  /** Which business a form key belongs to, as learned from requests admitted. Its own by default. */
  readonly scopes?: IntakeScopes | undefined;
}

/**
 * The bundle the build step wrote next to this file (forms-embed/tools/build.ts), or
 * undefined when it is not there, as in tests and in development before a build.
 */
export function loadEmbedScript(
  file: URL = new URL('./embed.bundle.js', import.meta.url),
): EmbedScript | undefined {
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
  400: ['Bad Request', 'The form request cannot be read.'],
  403: ['Forbidden', 'This form cannot be used here.'],
  404: ['Not Found', 'This form cannot be used here.'],
  409: ['Conflict', 'The form changed. Load it again and send it again.'],
  413: ['Content Too Large', 'The form request is too large.'],
  415: ['Unsupported Media Type', 'Send form requests as JSON.'],
  422: ['Unprocessable Content', 'Check the answers and try again.'],
  429: ['Too Many Requests', 'Wait before trying again.'],
  500: ['Internal Server Error', 'The form request could not be completed.'],
  503: ['Service Unavailable', 'The form is temporarily unavailable. Try again later.'],
};
const refusalStatus = {
  unavailable: 403,
  limited: 429,
  stale: 409,
  invalid: 422,
  changed: 409,
} as const satisfies Record<PublicFormRefusal['outcome'], number>;

/** Only a question or a box of the form, or the form as a whole, can be pointed at. */
const ANSWER_PATH = /^(?:\/(?:values|consents)\/[a-z][a-z0-9_]{0,39})?$/;

function refuse(reply: FastifyReply, status: number, issues: readonly Issue[] = []): FastifyReply {
  const [title, detail] = messages[status] ??
    messages[500] ?? ['Internal Server Error', 'The form request could not be completed.'];
  const problem: Problem = {
    type: 'about:blank',
    title,
    status,
    detail,
    // The module's own words about an answer, never the answer and never a stored value.
    ...(issues.length === 0
      ? {}
      : {
          errors: issues
            .filter((issue) => ANSWER_PATH.test(issue.path))
            .map(({ path, code, message }) => ({ path, code, message })),
        }),
  };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

const READS = new Set(['GET', 'HEAD']);

/** For the two answers that say nothing about any form; never with credentials. */
function readableAnywhere(reply: FastifyReply): FastifyReply {
  return reply
    .header('access-control-allow-origin', '*')
    .header('access-control-expose-headers', 'Retry-After');
}

/**
 * Mounts the public forms API in a scope of its own, apart from the signed-in API, and the
 * embed script when there is one.
 */
export async function registerPublicForms<Admission extends AdmittedForm>(
  app: FastifyInstance,
  transport: PublicFormTransport<Admission>,
): Promise<void> {
  const { handlers, script, ownOrigin } = transport;
  const scopes = transport.scopes ?? createIntakeScopes();

  if (script !== undefined && ownOrigin !== undefined) {
    // A form's own page and the preview of a draft. The same shell for every form, from
    // memory, with no database call, so not counted by the limiter, as the script is not.
    // The preview's address holds the token that opens the draft: it is never cached, and
    // the server's log leaves it out (sensitive-paths.ts).
    const page = (reply: FastifyReply, html: string | undefined, cache: string): FastifyReply => {
      void reply
        .header('cache-control', cache)
        .header('content-security-policy', PAGE_POLICY)
        .header('x-content-type-options', 'nosniff')
        .header('x-frame-options', 'DENY')
        .header('x-robots-tag', 'noindex')
        .header('referrer-policy', 'no-referrer');
      // Not the shape of a key or a link: there is no such page, and nothing is echoed.
      if (html === undefined) return reply.code(404).type('text/plain; charset=utf-8').send('');
      return reply.type('text/html; charset=utf-8').send(html);
    };
    app.get<{ Params: { formKey: string } }>(
      `${FORM_PAGE_PATH}/:formKey`,
      { exposeHeadRoute: false },
      (request, reply) =>
        page(reply, formPage(FORM_SCRIPT_URL, request.params.formKey), 'public, max-age=300'),
    );
    app.get<{ Params: { previewToken: string } }>(
      `${FORM_PREVIEW_PAGE_PATH}/:previewToken`,
      { exposeHeadRoute: false },
      (request, reply) =>
        page(reply, previewPage(FORM_SCRIPT_URL, request.params.previewToken), 'no-store'),
    );
  }

  if (script !== undefined) {
    // Loaded by a plain <script> tag on any website: no Origin to check and nothing
    // secret in it. It is the same bytes for everyone, from memory, with no database
    // call, so it is not counted by the limiter: a page view must cost the CRM nothing
    // that an attacker could use up. It changes with each release, so it is cached briefly.
    app.get(FORM_SCRIPT_URL, { exposeHeadRoute: false }, (request, reply) => {
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
        if (admission === undefined) throw new Error('A form request passed no gate.');
        return admission;
      };

      // Only JSON bodies: a cross-site HTML form or a text/plain post gets 415, and a JSON
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
        // A form this process has already admitted a request for: its business is known,
        // and this request counts toward that business's own ceiling as well.
        const formKey = (request.params as { formKey?: unknown } | null)?.formKey;
        const businessId = typeof formKey === 'string' ? scopes.get(formKey) : undefined;
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
          request.log.error({ statusCode: 503 }, 'Public forms limiter unavailable');
          return refuse(readableAnywhere(reply), 503);
        }
      });
      // The gate. Unknown key, form not published, website not listed, Origin missing: one answer.
      publicApp.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS') return;
        // A request from the CRM's own page: no Origin, and the header only such a page
        // can send (see the top of this file). Any Origin that was sent is used as it is.
        const origin: unknown =
          request.headers.origin === undefined &&
          ownOrigin !== undefined &&
          request.headers[FORM_PAGE_HEADER] === '1'
            ? ownOrigin
            : request.headers.origin;
        const given = request.params as Readonly<Record<string, unknown>> | null;
        let admission: Admission | undefined;
        if (given?.['previewToken'] !== undefined) {
          const params = getPublicFormPreview.params.safeParse({
            previewToken: given['previewToken'],
          });
          if (params.success)
            admission = await handlers.admitPreview(params.data.previewToken, origin);
        } else {
          const params = getPublicForm.params.safeParse({
            // A path with more after the key carries it in the same place.
            formKey: given?.['formKey'],
          });
          if (params.success) {
            admission = await handlers.admit(params.data.formKey, origin);
            // Only a key that names a published form is remembered: made-up keys fill nothing.
            if (admission?.businessId !== undefined)
              scopes.learn(params.data.formKey, admission.businessId);
          }
        }
        if (admission === undefined) return refuse(reply, 403);
        admissions.set(request, admission);
        // The stored origin of the form's own list: never `*`, never the header's text.
        // No credentials are allowed: the embed sends no cookie and no token of a person.
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
        if (status >= 500) request.log.error({ statusCode: status }, 'Public form request failed');
        // A body that does not fit the contract is refused in general: nothing is echoed.
        return refuse(reply, status);
      });
      // Declared here so that a path or method this API does not have is answered inside
      // this scope: its hooks run first, and the gate, which finds no form key in such a
      // request, refuses it like any other.
      publicApp.setNotFoundHandler((_request, reply) => refuse(reply, 404));

      const answer = (
        reply: FastifyReply,
        endpoint: { readonly response: { readonly status: number; readonly schema: z.ZodType } },
        result: PublicFormRefusal | { readonly outcome: 'ok' },
        value: unknown,
      ): FastifyReply => {
        if (result.outcome === 'ok')
          // The contract's strict schema is the last word on what leaves.
          return reply.code(endpoint.response.status).send(endpoint.response.schema.parse(value));
        if (result.outcome === 'limited') {
          const wait = result.retryAfterSeconds;
          reply.header(
            'retry-after',
            String(Number.isSafeInteger(wait) && wait >= 1 ? Math.min(wait, 86_400) : 60),
          );
        }
        return refuse(
          reply,
          refusalStatus[result.outcome],
          result.outcome === 'invalid' ? result.issues : [],
        );
      };
      const route = (
        endpoint: { readonly method: string; readonly path: string },
        handler: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>,
      ): void => {
        publicApp.route({
          method: endpoint.method.toUpperCase(),
          url: fastifyPath(endpoint.path.slice('/public/forms'.length)),
          bodyLimit: BODY_LIMIT,
          exposeHeadRoute: false,
          handler,
        });
      };

      // The same two calls for a published form and for a preview: the gate decided which
      // this request is, and the module shows the draft and stores nothing for a preview.
      for (const endpoint of [getPublicForm, getPublicFormPreview])
        route(endpoint, async (request, reply) => {
          parseInput(emptyQuery, request.query);
          const result = await handlers.form(admitted(request), {
            requestId: request.id,
            // The address the server saw, after its trusted proxies, as for a submission.
            ipAddress: request.ip,
          });
          return answer(reply, endpoint, result, 'form' in result ? result.form : undefined);
        });
      for (const endpoint of [submitPublicForm, submitPublicFormPreview])
        route(endpoint, async (request, reply) => {
          parseInput(emptyQuery, request.query);
          const input = parseInput(endpoint.body, request.body);
          const userAgent = request.headers['user-agent'];
          const result = await handlers.submit(admitted(request), input, {
            requestId: request.id,
            // The address the server saw, after its trusted proxies: never one the body names.
            ipAddress: request.ip,
            ...(typeof userAgent === 'string' && userAgent !== ''
              ? { userAgent: userAgent.slice(0, USER_AGENT_LENGTH) }
              : {}),
          });
          return answer(reply, endpoint, result, 'receipt' in result ? result.receipt : undefined);
        });
      for (const endpoint of [getPublicFormChallenge, getPublicFormPreviewChallenge])
        route(endpoint, async (request, reply) => {
          parseInput(emptyQuery, request.query);
          const input = parseInput(endpoint.body, request.body);
          const result = await handlers.challenge(admitted(request), input, {
            requestId: request.id,
            ipAddress: request.ip,
          });
          return answer(
            reply,
            endpoint,
            result,
            'challenge' in result ? result.challenge : undefined,
          );
        });

      // The preflight a browser sends before a JSON post. It allows the browser to send the
      // request, whose own answer is then the gate's: a website that is not listed gets
      // that far and no further.
      const preflight = (_request: FastifyRequest, reply: FastifyReply): FastifyReply =>
        readableAnywhere(reply)
          .header('access-control-allow-methods', 'GET, POST')
          .header('access-control-allow-headers', 'content-type')
          .header('access-control-max-age', String(PREFLIGHT_SECONDS))
          .code(204)
          .send();
      publicApp.options('/:formKey', preflight);
      publicApp.options('/:formKey/*', preflight);
      done();
    },
    { prefix: PREFIX },
  );
}
