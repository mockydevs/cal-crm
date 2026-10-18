// A local stand-in for the Google endpoints Calendar sync calls, over a real socket. It
// never talks to Google; its client and its accounts are made up. Shapes are Google's
// documented ones (read 2026-10-15):
//
//   POST /token           https://developers.google.com/identity/protocols/oauth2/web-server
//                         (exchange and refresh; 400 {"error":"invalid_grant"} for a refresh
//                         token that expired or was revoked, as RFC 6749 section 5.2 has it)
//   POST /revoke          the same guide, "Revoking a token": 200, or 400 for a bad token
//   GET  /calendar/v3/users/me/calendarList                 calendarList.list
//   POST /calendar/v3/freeBusy                              freebusy.query
//   POST|GET|PATCH|DELETE /calendar/v3/calendars/{id}/events[/{eventId}]  events.*
//   errors: https://developers.google.com/workspace/calendar/api/guides/errors
//
// The browser's part (the consent page) is `consent`: a test says what the person agreed
// to and gets the code Google would send back. PKCE is checked as RFC 7636 says: the
// verifier's S256 must be the challenge the consent was given with.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_CLIENT = {
  clientId: '000000000000-fixture.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-fixture-not-a-real-secret',
  redirectUri: 'https://crm.example.test/api/v1/integrations/google/callback',
} as const;

export const ALL_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

export interface FakeCalendar {
  readonly id: string;
  readonly summary: string;
  readonly primary?: boolean;
  readonly accessRole:
    'freeBusyReader' | 'reader' | 'writerWithoutPrivateAccess' | 'writer' | 'owner';
}

export interface FakeEvent {
  readonly id: string;
  status: 'confirmed' | 'cancelled';
  summary: string;
  description: string;
  location: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: unknown;
  extendedProperties?: unknown;
  conference?: { requestId: string; status: 'pending' | 'success'; uri: string };
}

interface Account {
  readonly sub: string;
  readonly email: string;
  calendars: FakeCalendar[];
  /** Busy time by calendar: what freeBusy answers. */
  readonly busy: Map<string, { start: string; end: string }[]>;
  readonly events: Map<string, Map<string, FakeEvent>>;
}

/** A scripted answer for the next request whose method and path match. */
interface Scripted {
  readonly method: string;
  readonly path: RegExp;
  readonly status: number;
  readonly body: unknown;
}

export interface FakeGoogle {
  readonly origin: string;
  /** A fetch that sends Google's own addresses here instead. */
  readonly fetch: typeof fetch;
  /** Every request answered, in order: method and path (never a body or a token). */
  readonly requests: { method: string; path: string }[];
  addAccount(account: { sub: string; email: string; calendars: FakeCalendar[] }): void;
  /** Busy time Google would answer for a calendar. */
  setBusy(calendarId: string, busy: { start: string; end: string }[]): void;
  /** The events written into a calendar, deleted ones included (status cancelled). */
  events(calendarId: string): FakeEvent[];
  /** What the consent page gives back for an account: the code. */
  consent(input: { sub: string; codeChallenge: string; scopes?: readonly string[] }): string;
  /** The person revokes the app at myaccount.google.com: every token of theirs stops working. */
  revokeAccount(sub: string): void;
  /** Answers the next matching request with this, once. */
  failNext(method: string, path: RegExp, status: number, body?: unknown): void;
  /** Makes Meets stay pending until `finishMeets`. */
  holdMeets(hold: boolean): void;
  finishMeets(): void;
  /** Refresh tokens that were revoked through /revoke. */
  readonly revoked: string[];
  close(): Promise<void>;
}

const googleError = (status: number, reason: string, message: string) => ({
  error: { errors: [{ domain: 'global', reason, message }], code: status, message },
});

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const accounts = new Map<string, Account>();
  const codes = new Map<string, { sub: string; challenge: string; scopes: readonly string[] }>();
  const refreshTokens = new Map<string, { sub: string; scopes: readonly string[] }>();
  const accessTokens = new Map<string, string>();
  const scripted: Scripted[] = [];
  const requests: { method: string; path: string }[] = [];
  const revoked: string[] = [];
  let meetsHeld = false;

  const calendarOwner = (calendarId: string): Account | undefined =>
    [...accounts.values()].find((account) =>
      account.calendars.some((calendar) => calendar.id === calendarId),
    );

  function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
    response.end(body === undefined ? '' : JSON.stringify(body));
  }

  function eventResource(event: FakeEvent) {
    return {
      kind: 'calendar#event',
      id: event.id,
      status: event.status,
      htmlLink: `https://www.google.com/calendar/event?eid=${event.id}`,
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: event.start,
      end: event.end,
      ...(event.conference === undefined
        ? {}
        : {
            conferenceData: {
              createRequest: {
                requestId: event.conference.requestId,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
                status: { statusCode: event.conference.status },
              },
              ...(event.conference.status === 'success'
                ? {
                    entryPoints: [
                      {
                        entryPointType: 'video',
                        uri: event.conference.uri,
                        label: event.conference.uri.slice(8),
                      },
                    ],
                    conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
                    conferenceId: event.conference.uri.slice(24),
                  }
                : {}),
            },
          }),
    };
  }

  const meetUri = () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const pick = (n: number) =>
      Array.from(randomBytes(n), (byte) => letters[byte % letters.length]).join('');
    return `https://meet.google.com/${pick(3)}-${pick(4)}-${pick(3)}`;
  };

  function applyFields(event: FakeEvent, body: Record<string, unknown>): void {
    if (typeof body['summary'] === 'string') event.summary = body['summary'];
    if (typeof body['description'] === 'string') event.description = body['description'];
    if (typeof body['location'] === 'string') event.location = body['location'];
    if (typeof body['start'] === 'object' && body['start'] !== null)
      event.start = body['start'] as FakeEvent['start'];
    if (typeof body['end'] === 'object' && body['end'] !== null)
      event.end = body['end'] as FakeEvent['end'];
    if ('attendees' in body) event.attendees = body['attendees'];
    if ('extendedProperties' in body) event.extendedProperties = body['extendedProperties'];
  }

  function conferenceFrom(body: Record<string, unknown>, url: URL, event: FakeEvent): void {
    if (url.searchParams.get('conferenceDataVersion') !== '1') return;
    const data = body['conferenceData'] as { createRequest?: { requestId?: string } } | undefined;
    const requestId = data?.createRequest?.requestId;
    // "If an ID provided is the same as for the previous request, the request is ignored."
    if (requestId === undefined || event.conference?.requestId === requestId) return;
    event.conference = { requestId, status: meetsHeld ? 'pending' : 'success', uri: meetUri() };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake.google');
    const method = request.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    const raw = await bodyOf(request);
    const script = scripted.findIndex(
      (each) => each.method === method && each.path.test(url.pathname),
    );
    if (script !== -1) {
      const [answer] = scripted.splice(script, 1);
      if (answer !== undefined) {
        send(response, answer.status, answer.body);
        return;
      }
    }

    if (url.pathname === '/token' && method === 'POST') {
      const form = new URLSearchParams(raw);
      if (
        form.get('client_id') !== FAKE_CLIENT.clientId ||
        form.get('client_secret') !== FAKE_CLIENT.clientSecret
      ) {
        send(response, 401, { error: 'invalid_client', error_description: 'Unauthorized' });
        return;
      }
      const issue = (sub: string, scopes: readonly string[], refreshToken?: string) => {
        const accessToken = `ya29.fixture-${randomUUID()}`;
        accessTokens.set(accessToken, sub);
        const account = accounts.get(sub);
        return {
          access_token: accessToken,
          expires_in: 3599,
          ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
          scope: scopes.join(' '),
          token_type: 'Bearer',
          ...(refreshToken === undefined
            ? {}
            : {
                id_token: `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
                  iss: 'https://accounts.google.com',
                  aud: FAKE_CLIENT.clientId,
                  sub,
                  email: account?.email,
                  email_verified: true,
                  iat: Math.floor(Date.now() / 1000),
                  exp: Math.floor(Date.now() / 1000) + 3600,
                })}.fixture-signature`,
              }),
        };
      };
      if (form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          code === undefined ||
          form.get('redirect_uri') !== FAKE_CLIENT.redirectUri ||
          challenge !== code.challenge
        ) {
          send(response, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
          return;
        }
        codes.delete(form.get('code') ?? '');
        const refreshToken = `1//fixture-${randomUUID()}`;
        refreshTokens.set(refreshToken, { sub: code.sub, scopes: code.scopes });
        send(response, 200, issue(code.sub, code.scopes, refreshToken));
        return;
      }
      if (form.get('grant_type') === 'refresh_token') {
        const held = refreshTokens.get(form.get('refresh_token') ?? '');
        if (held === undefined) {
          send(response, 400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          });
          return;
        }
        send(response, 200, issue(held.sub, held.scopes));
        return;
      }
      send(response, 400, { error: 'unsupported_grant_type' });
      return;
    }

    if (url.pathname === '/revoke' && method === 'POST') {
      const token = new URLSearchParams(raw).get('token') ?? '';
      const held = refreshTokens.get(token);
      if (held === undefined) {
        send(response, 400, { error: 'invalid_token', error_description: 'Bad Request' });
        return;
      }
      revoked.push(token);
      // Revoking ends the whole grant: every token of that account for this client.
      for (const [each, value] of refreshTokens)
        if (value.sub === held.sub) refreshTokens.delete(each);
      send(response, 200, {});
      return;
    }

    // Everything below is the Calendar API, which takes an access token.
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const sub = bearer === undefined ? undefined : accessTokens.get(bearer);
    const account = sub === undefined ? undefined : accounts.get(sub);
    if (account === undefined || sub === undefined || !refreshTokensOf(sub)) {
      send(response, 401, googleError(401, 'authError', 'Invalid Credentials'));
      return;
    }

    if (url.pathname === '/calendar/v3/users/me/calendarList' && method === 'GET') {
      send(response, 200, {
        kind: 'calendar#calendarList',
        etag: '"fixture"',
        nextSyncToken: 'fixture-sync',
        items: account.calendars.map((calendar) => ({
          kind: 'calendar#calendarListEntry',
          etag: '"fixture"',
          id: calendar.id,
          summary: calendar.summary,
          timeZone: 'America/New_York',
          colorId: '14',
          backgroundColor: '#9fe1e7',
          foregroundColor: '#000000',
          selected: true,
          accessRole: calendar.accessRole,
          defaultReminders: [],
          ...(calendar.primary === true ? { primary: true } : {}),
        })),
      });
      return;
    }

    if (url.pathname === '/calendar/v3/freeBusy' && method === 'POST') {
      const body = JSON.parse(raw) as { timeMin: string; timeMax: string; items: { id: string }[] };
      const from = Date.parse(body.timeMin);
      const to = Date.parse(body.timeMax);
      if (!(to > from)) {
        send(
          response,
          400,
          googleError(400, 'timeRangeEmpty', 'The specified time range is empty.'),
        );
        return;
      }
      const calendars: Record<string, unknown> = {};
      for (const { id } of body.items) {
        const visible = account.calendars.some((calendar) => calendar.id === id);
        calendars[id] = visible
          ? {
              busy: (account.busy.get(id) ?? []).filter(
                (period) => Date.parse(period.end) > from && Date.parse(period.start) < to,
              ),
            }
          : { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] };
      }
      send(response, 200, {
        kind: 'calendar#freeBusy',
        timeMin: body.timeMin,
        timeMax: body.timeMax,
        calendars,
      });
      return;
    }

    const event = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (event !== null) {
      const calendarId = decodeURIComponent(event[1] ?? '');
      const eventId = event[2] === undefined ? undefined : decodeURIComponent(event[2]);
      const calendar = account.calendars.find((each) => each.id === calendarId);
      if (calendar === undefined) {
        send(response, 404, googleError(404, 'notFound', 'Not Found'));
        return;
      }
      if (calendar.accessRole !== 'owner' && calendar.accessRole !== 'writer') {
        send(
          response,
          403,
          googleError(
            403,
            'requiredAccessLevel',
            'You need to have writer access to this calendar.',
          ),
        );
        return;
      }
      let stored = account.events.get(calendarId);
      if (stored === undefined) {
        stored = new Map();
        account.events.set(calendarId, stored);
      }
      if (eventId === undefined && method === 'POST') {
        const body = JSON.parse(raw) as Record<string, unknown>;
        const id = typeof body['id'] === 'string' ? body['id'] : '';
        if (!/^[a-v0-9]{5,1024}$/.test(id)) {
          send(response, 400, googleError(400, 'invalid', 'Invalid resource id value.'));
          return;
        }
        if (stored.has(id)) {
          send(
            response,
            409,
            googleError(409, 'duplicate', 'The requested identifier already exists.'),
          );
          return;
        }
        const made: FakeEvent = {
          id,
          status: 'confirmed',
          summary: '',
          description: '',
          location: '',
          start: { dateTime: '' },
          end: { dateTime: '' },
        };
        applyFields(made, body);
        conferenceFrom(body, url, made);
        stored.set(id, made);
        send(response, 200, eventResource(made));
        return;
      }
      const existing = eventId === undefined ? undefined : stored.get(eventId);
      if (existing === undefined) {
        send(response, 404, googleError(404, 'notFound', 'Not Found'));
        return;
      }
      if (method === 'GET') {
        send(response, 200, eventResource(existing));
        return;
      }
      if (existing.status === 'cancelled') {
        send(response, 410, googleError(410, 'deleted', 'Resource has been deleted'));
        return;
      }
      if (method === 'PATCH') {
        const body = JSON.parse(raw) as Record<string, unknown>;
        applyFields(existing, body);
        conferenceFrom(body, url, existing);
        send(response, 200, eventResource(existing));
        return;
      }
      if (method === 'DELETE') {
        existing.status = 'cancelled';
        response.writeHead(204);
        response.end();
        return;
      }
    }
    send(response, 404, googleError(404, 'notFound', 'Not Found'));
  }

  const refreshTokensOf = (sub: string) =>
    [...refreshTokens.values()].some((value) => value.sub === sub);

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent)
        send(response, 500, googleError(500, 'backendError', 'Backend Error'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const fakeFetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const local =
      url.origin === 'https://oauth2.googleapis.com'
        ? `${origin}${url.pathname}${url.search}`
        : url.origin === 'https://www.googleapis.com'
          ? `${origin}${url.pathname}${url.search}`
          : undefined;
    if (local === undefined)
      return Promise.reject(new Error(`Not a Google address: ${url.origin}`));
    return fetch(local, init);
  };

  return {
    origin,
    fetch: fakeFetch,
    requests,
    revoked,
    addAccount(account) {
      accounts.set(account.sub, {
        ...account,
        busy: new Map(),
        events: new Map(),
      });
    },
    setBusy(calendarId, busy) {
      const owner = calendarOwner(calendarId);
      if (owner === undefined) throw new Error(`No fake account has ${calendarId}.`);
      owner.busy.set(calendarId, busy);
    },
    events(calendarId) {
      return [...(calendarOwner(calendarId)?.events.get(calendarId)?.values() ?? [])];
    },
    consent({ sub, codeChallenge, scopes = ALL_SCOPES }) {
      const code = `4/0fixture-${randomUUID()}`;
      codes.set(code, { sub, challenge: codeChallenge, scopes });
      return code;
    },
    revokeAccount(sub) {
      for (const [token, value] of refreshTokens)
        if (value.sub === sub) refreshTokens.delete(token);
    },
    failNext(method, path, status, body) {
      scripted.push({
        method,
        path,
        status,
        body:
          body ??
          (status === 429 || status === 403
            ? googleError(status, 'rateLimitExceeded', 'Rate Limit Exceeded')
            : googleError(status, 'backendError', 'Backend Error')),
      });
    },
    holdMeets(hold) {
      meetsHeld = hold;
    },
    finishMeets() {
      for (const account of accounts.values())
        for (const events of account.events.values())
          for (const event of events.values())
            if (event.conference?.status === 'pending') event.conference.status = 'success';
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
