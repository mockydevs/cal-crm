// The Google calls Calendar sync makes, and nothing else. Each shape is from Google's own
// reference, read 2026-10-15:
//   OAuth:     https://developers.google.com/identity/protocols/oauth2/web-server
//              https://accounts.google.com/.well-known/openid-configuration
//   freeBusy:  https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
//   calendars: https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list
//   events:    https://developers.google.com/workspace/calendar/api/v3/reference/events
//              (insert, get, patch, delete; conferences in guides/create-events)
//   errors:    https://developers.google.com/workspace/calendar/api/guides/errors
//
// The hosts are constants. No caller, database row or Google answer can send a request, or
// a token, anywhere else. Tests point the transport's fetch at a local stand-in
// (test/fake-google.ts); the addresses it is asked for are still Google's.
import * as z from 'zod';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** The scopes asked for on the consent screen. */
export const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

/** Without these three a connection can neither check nor write: partial consent is refused. */
export const GOOGLE_REQUIRED_SCOPES = GOOGLE_SCOPES.slice(2);

export interface GoogleRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** A full address on one of Google's hosts above. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}
export interface GoogleResponse {
  readonly status: number;
  readonly body: string;
}
/** Sends one request. A rejection means no answer was read. */
export type GoogleTransport = (request: GoogleRequest) => Promise<GoogleResponse>;

const ALLOWED_ORIGINS = new Set(['https://oauth2.googleapis.com', 'https://www.googleapis.com']);

/** Whether a request goes to a host this module may ever call. */
export function isGoogleAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_ORIGINS.has(parsed.origin) && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

/** The largest answer read: a page of 250 calendars is far below it. */
const MAX_RESPONSE_BYTES = 2_000_000;

/**
 * Node's fetch to Google, with a deadline and no redirects (a token is never forwarded).
 * An address off Google's hosts is refused before anything is sent.
 */
export function createGoogleTransport(
  fetcher: typeof fetch = fetch,
  options: { readonly timeoutMs?: number } = {},
): GoogleTransport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (request) => {
    if (!isGoogleAddress(request.url))
      throw new Error('This address is not one Calendar sync calls.');
    const response = await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('Google answered too much.');
    return { status: response.status, body: text };
  };
}

/**
 * What a call came to:
 * - unauthorized: the access token was refused (401); refresh it and try once more;
 * - retry: a rate limit, Google's own fault or no answer at all; try again later;
 * - not_found, gone: the thing is not there (404, 410);
 * - duplicate: an event with this id already exists (409);
 * - rejected: Google refused this request itself; sending it again changes nothing.
 */
export type GoogleFailure =
  'unauthorized' | 'retry' | 'not_found' | 'gone' | 'duplicate' | 'rejected';
export type GoogleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: GoogleFailure };

const errorReasons = z.looseObject({
  error: z
    .looseObject({ errors: z.array(z.looseObject({ reason: z.string() })).optional() })
    .optional(),
});

/** Google's documented reasons for a 403 that a later try may get past. */
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

/** The reasons in an error answer's body; none when it is not Google's error shape. */
function reasonsOf(body: string): string[] {
  try {
    return (errorReasons.parse(JSON.parse(body)).error?.errors ?? []).map((error) => error.reason);
  } catch {
    return [];
  }
}

export function failureOf(response: GoogleResponse): GoogleFailure {
  const { status } = response;
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'duplicate';
  if (status === 410) return 'gone';
  if (status === 429 || status >= 500) return 'retry';
  if (status === 403)
    return reasonsOf(response.body).some((reason) => RATE_REASONS.has(reason))
      ? 'retry'
      : 'rejected';
  return 'rejected';
}

async function send<T>(
  transport: GoogleTransport,
  request: GoogleRequest,
  read: (body: unknown) => T,
): Promise<GoogleResult<T>> {
  let response: GoogleResponse;
  try {
    response = await transport(request);
  } catch {
    return { ok: false, failure: 'retry' };
  }
  if (response.status < 200 || response.status >= 300)
    return { ok: false, failure: failureOf(response) };
  let body: unknown = null;
  if (response.body !== '') {
    try {
      body = JSON.parse(response.body);
    } catch {
      return { ok: false, failure: 'retry' };
    }
  }
  const parsed = (() => {
    try {
      return { value: read(body) };
    } catch {
      return undefined;
    }
  })();
  return parsed === undefined ? { ok: false, failure: 'retry' } : { ok: true, value: parsed.value };
}

const bearer = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`,
  accept: 'application/json',
});

// ---------------------------------------------------------------------------------- OAuth

export interface GoogleClient {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `${PUBLIC_URL}/api/v1/integrations/google/callback`, exactly as registered. */
  readonly redirectUri: string;
}

/** Google's consent page for one attempt (web-server guide, step 1). */
export function authorizationUrl(
  client: GoogleClient,
  attempt: { readonly state: string; readonly codeChallenge: string },
): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // A refresh token on every consent, also when the person connected before.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: attempt.state,
    code_challenge: attempt.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

const tokenAnswer = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(''),
  id_token: z.string().optional(),
});

const idTokenClaims = z.looseObject({
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(320),
});

/**
 * The account an ID token names. It came straight from Google's token endpoint over TLS,
 * so its payload is read without checking the signature (OpenID Connect guide,
 * "Obtaining user profile information"; the token is never passed on).
 */
export function accountOf(idToken: string): { readonly sub: string; readonly email: string } {
  const payload = idToken.split('.')[1];
  if (payload === undefined) throw new Error('The ID token has no payload.');
  const claims = idTokenClaims.parse(
    JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
  );
  return { sub: claims.sub, email: claims.email };
}

export interface ExchangedTokens {
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: ReadonlySet<string>;
  readonly account: { readonly sub: string; readonly email: string };
}

/** The code for tokens (web-server guide, step 5), with the PKCE verifier and the secret. */
export async function exchangeCode(
  transport: GoogleTransport,
  client: GoogleClient,
  code: string,
  codeVerifier: string,
): Promise<GoogleResult<ExchangedTokens>> {
  return send(
    transport,
    {
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }).toString(),
    },
    (body) => {
      const answer = tokenAnswer.parse(body);
      if (answer.refresh_token === undefined || answer.id_token === undefined)
        throw new Error('Google gave no refresh token or ID token.');
      return {
        refreshToken: answer.refresh_token,
        accessToken: answer.access_token,
        expiresInSeconds: answer.expires_in,
        scopes: new Set(answer.scope.split(' ').filter((scope) => scope !== '')),
        account: accountOf(answer.id_token),
      };
    },
  );
}

const oauthError = z.looseObject({ error: z.string() });

/**
 * A new access token. `invalid_grant` is Google's word for a refresh token that expired or
 * was revoked (web-server guide, "Refreshing an access token"; RFC 6749 section 5.2): then
 * only the member can connect again.
 */
export async function refreshAccessToken(
  transport: GoogleTransport,
  client: GoogleClient,
  refreshToken: string,
): Promise<
  | { readonly outcome: 'ok'; readonly accessToken: string; readonly expiresInSeconds: number }
  | { readonly outcome: 'invalid_grant' }
  | { readonly outcome: 'unavailable' }
> {
  let response: GoogleResponse;
  try {
    response = await transport({
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch {
    return { outcome: 'unavailable' };
  }
  try {
    const body: unknown = JSON.parse(response.body);
    if (response.status === 200) {
      const answer = tokenAnswer.parse(body);
      return {
        outcome: 'ok',
        accessToken: answer.access_token,
        expiresInSeconds: answer.expires_in,
      };
    }
    if (response.status === 400 && oauthError.parse(body).error === 'invalid_grant')
      return { outcome: 'invalid_grant' };
  } catch {
    return { outcome: 'unavailable' };
  }
  return { outcome: 'unavailable' };
}

/**
 * Revokes the grant (web-server guide, "Revoking a token"): 200, or 400 when the token is
 * already invalid, which is as good. Anything else may be tried again.
 */
export async function revokeToken(transport: GoogleTransport, token: string): Promise<boolean> {
  try {
    const response = await transport({
      method: 'POST',
      url: GOOGLE_REVOKE_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.status === 200 || response.status === 400;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------- Calendar list

export interface GoogleListedCalendar {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
  readonly accessRole:
    'freeBusyReader' | 'reader' | 'writerWithoutPrivateAccess' | 'writer' | 'owner';
}

const calendarListPage = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(1024),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        primary: z.boolean().optional(),
        accessRole: z.enum([
          'freeBusyReader',
          'reader',
          'writerWithoutPrivateAccess',
          'writer',
          'owner',
        ]),
        deleted: z.boolean().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

/** The most pages read: 250 calendars each (the page size's maximum). */
const MAX_CALENDAR_PAGES = 4;

/** The member's calendar list, every page, without deleted entries. */
export async function listCalendars(
  transport: GoogleTransport,
  accessToken: string,
): Promise<GoogleResult<GoogleListedCalendar[]>> {
  const calendars: GoogleListedCalendar[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
    const url = new URL(`${GOOGLE_CALENDAR_API}/users/me/calendarList`);
    url.searchParams.set('maxResults', '250');
    if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
    const result = await send(
      transport,
      { method: 'GET', url: url.href, headers: bearer(accessToken) },
      (body) => calendarListPage.parse(body),
    );
    if (!result.ok) return result;
    for (const item of result.value.items)
      if (item.deleted !== true)
        calendars.push({
          id: item.id,
          name:
            (item.summaryOverride ?? item.summary ?? '').trim().slice(0, 300) ||
            item.id.slice(0, 300),
          primary: item.primary === true,
          accessRole: item.accessRole,
        });
    pageToken = result.value.nextPageToken;
    if (pageToken === undefined) break;
  }
  return { ok: true, value: calendars };
}

// --------------------------------------------------------------------------- freeBusy

export interface BusyInterval {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

const freeBusyAnswer = z.looseObject({
  calendars: z.record(
    z.string(),
    z.looseObject({
      busy: z
        .array(
          z.looseObject({
            start: z.iso.datetime({ offset: true }),
            end: z.iso.datetime({ offset: true }),
          }),
        )
        .default([]),
      errors: z.array(z.looseObject({ reason: z.string() })).optional(),
    }),
  ),
});

/**
 * The busy time of the calendars between two instants. A calendar Google answers with
 * `errors` (notFound, internalError, …) makes the whole answer a failure: its time is
 * unknown, and unknown time is not free.
 */
export async function queryFreeBusy(
  transport: GoogleTransport,
  accessToken: string,
  calendarIds: readonly string[],
  from: Date,
  to: Date,
): Promise<GoogleResult<BusyInterval[]>> {
  if (calendarIds.length === 0) return { ok: true, value: [] };
  const result = await send(
    transport,
    {
      method: 'POST',
      url: `${GOOGLE_CALENDAR_API}/freeBusy`,
      headers: { ...bearer(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: calendarIds.map((id) => ({ id })),
      }),
    },
    (body) => freeBusyAnswer.parse(body),
  );
  if (!result.ok) return result;
  const intervals: BusyInterval[] = [];
  for (const id of calendarIds) {
    const calendar = result.value.calendars[id];
    if (calendar === undefined || (calendar.errors?.length ?? 0) > 0)
      return { ok: false, failure: 'retry' };
    for (const period of calendar.busy) {
      const startsAt = new Date(period.start);
      const endsAt = new Date(period.end);
      if (endsAt > startsAt) intervals.push({ startsAt, endsAt });
    }
  }
  return { ok: true, value: intervals };
}

// ----------------------------------------------------------------------------- Events

/** What the CRM writes into a Google event: no attendees, so Google sends nobody mail. */
export interface GoogleEventBody {
  readonly summary: string;
  readonly description: string;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
  readonly appointmentId: string;
}

export interface WrittenEvent {
  /** The Meet link, once Google has made it. */
  readonly meetUrl: string | null;
  /** Google is still making the Meet (createRequest status `pending`). */
  readonly meetPending: boolean;
}

const eventAnswer = z.looseObject({
  conferenceData: z
    .looseObject({
      createRequest: z
        .looseObject({ status: z.looseObject({ statusCode: z.string() }).optional() })
        .optional(),
      entryPoints: z
        .array(z.looseObject({ entryPointType: z.string(), uri: z.string() }))
        .optional(),
    })
    .optional(),
});

function writtenOf(body: unknown): WrittenEvent {
  const conference = eventAnswer.parse(body ?? {}).conferenceData;
  const video = conference?.entryPoints?.find(
    (entry) => entry.entryPointType === 'video' && entry.uri.startsWith('https://'),
  );
  return {
    meetUrl: video?.uri.slice(0, 1300) ?? null,
    meetPending: video === undefined && conference?.createRequest?.status?.statusCode === 'pending',
  };
}

function eventFields(event: GoogleEventBody) {
  return {
    summary: event.summary,
    description: event.description,
    location: event.location ?? '',
    start: { dateTime: event.startsAt.toISOString(), timeZone: event.timeZone },
    end: { dateTime: event.endsAt.toISOString(), timeZone: event.timeZone },
    extendedProperties: { private: { crmAppointmentId: event.appointmentId } },
  };
}

const eventUrl = (calendarId: string, eventId?: string) =>
  `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events${
    eventId === undefined ? '' : `/${encodeURIComponent(eventId)}`
  }`;

/** A Meet is asked for with this request id; the same id asks for the same Meet. */
const meetRequest = (requestId: string) => ({
  conferenceData: {
    createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
  },
});

export async function insertEvent(
  transport: GoogleTransport,
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: GoogleEventBody,
  meet: boolean,
): Promise<GoogleResult<WrittenEvent>> {
  const url = new URL(eventUrl(calendarId));
  if (meet) url.searchParams.set('conferenceDataVersion', '1');
  return send(
    transport,
    {
      method: 'POST',
      url: url.href,
      headers: { ...bearer(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: eventId,
        ...eventFields(event),
        ...(meet ? meetRequest(eventId) : {}),
      }),
    },
    writtenOf,
  );
}

/** Patch semantics: only the fields sent change; a Meet is added when asked for. */
export async function patchEvent(
  transport: GoogleTransport,
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: GoogleEventBody,
  meet: boolean,
): Promise<GoogleResult<WrittenEvent>> {
  const url = new URL(eventUrl(calendarId, eventId));
  if (meet) url.searchParams.set('conferenceDataVersion', '1');
  return send(
    transport,
    {
      method: 'PATCH',
      url: url.href,
      headers: { ...bearer(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        ...eventFields(event),
        ...(meet ? meetRequest(eventId) : {}),
      }),
    },
    writtenOf,
  );
}

export async function getEvent(
  transport: GoogleTransport,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<GoogleResult<WrittenEvent>> {
  return send(
    transport,
    { method: 'GET', url: eventUrl(calendarId, eventId), headers: bearer(accessToken) },
    writtenOf,
  );
}

/** Deleting what is already gone (404, 410) is done: "no action is needed". */
export async function deleteEvent(
  transport: GoogleTransport,
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<GoogleResult<null>> {
  const result = await send(
    transport,
    { method: 'DELETE', url: eventUrl(calendarId, eventId), headers: bearer(accessToken) },
    () => null,
  );
  if (!result.ok && (result.failure === 'not_found' || result.failure === 'gone'))
    return { ok: true, value: null };
  return result;
}
