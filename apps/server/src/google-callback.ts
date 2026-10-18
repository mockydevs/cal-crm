// Where Google sends the browser back after consent: GET
// /api/v1/integrations/google/callback?state=…&code=… (or &error=access_denied). It is a
// browser address, not part of the JSON API: it reads the session cookie the dashboard
// signed in with, finishes the connection as that person, and sends them to Settings →
// Calendars → Connections with one word for what happened. It is registered beside the API
// plugin, as file downloads are, so the API's need for a Business-Id header does not apply:
// the attempt named by the state says which business it is for.
import type { CallbackPerson, CallbackResult, GoogleCallback } from '@repo/module-calendar';
import type { Authentication } from '@repo/module-auth';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod';

export const GOOGLE_CALLBACK_PATH = '/api/v1/integrations/google/callback';

export interface GoogleCallbackTransport {
  readonly complete: (
    callback: GoogleCallback,
    person: CallbackPerson,
    correlationId: string,
  ) => Promise<CallbackResult>;
}

// What Google sends back (web-server guide, "Handle the OAuth 2.0 server response"); any
// other parameter, such as scope or authuser, is ignored.
const answer = z.looseObject({
  state: z.string().max(200).optional(),
  code: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
});

/** The browser's request headers, as the session reader takes them. */
function headersOf(raw: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const each of value) headers.append(name, each);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function registerGoogleCallback(
  app: FastifyInstance,
  options: {
    readonly authentication: Authentication;
    readonly transport: GoogleCallbackTransport;
    readonly publicUrl: string;
  },
): void {
  const back = (path: string, outcome: string) => {
    const url = new URL(path, options.publicUrl);
    url.searchParams.set('google', outcome);
    return url.href;
  };
  app.get(GOOGLE_CALLBACK_PATH, { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const parsed = answer.safeParse(request.query);
    const session = await options.authentication.signedIn(headersOf(request.headers));
    // Signed out meanwhile: sign in again, then connect again.
    if (session?.agencyId === undefined) return reply.redirect(back('/', 'expired'), 302);
    if (session.twoFactorRequired && !session.twoFactorEnabled)
      return reply.redirect(back('/', 'failed'), 302);
    const { authentication } = options;
    let result: CallbackResult;
    try {
      result = await options.transport.complete(
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
      request.log.error({ err: error }, 'Google connection could not be finished');
      return reply.redirect(back('/', 'failed'), 302);
    }
    return reply.redirect(back(result.path ?? '/', result.outcome), 302);
  });
}
