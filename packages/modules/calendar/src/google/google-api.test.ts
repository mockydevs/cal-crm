// The Google client against answers in Google's documented shapes, through a transport that
// records what would be sent. Nothing here opens a socket.
import { describe, expect, it } from 'vitest';

import {
  accountOf,
  authorizationUrl,
  createGoogleTransport,
  deleteEvent,
  exchangeCode,
  failureOf,
  getEvent,
  insertEvent,
  isGoogleAddress,
  listCalendars,
  patchEvent,
  queryFreeBusy,
  refreshAccessToken,
  revokeToken,
  type GoogleRequest,
  type GoogleResponse,
  type GoogleTransport,
} from './google-api.js';

const client = {
  clientId: 'id.apps.googleusercontent.com',
  clientSecret: 'secret',
  redirectUri: 'https://crm.example.test/api/v1/integrations/google/callback',
};

/** A transport that answers from a list, in order, and keeps what it was asked. */
function scripted(...answers: (GoogleResponse | Error)[]): GoogleTransport & {
  sent: GoogleRequest[];
} {
  const sent: GoogleRequest[] = [];
  const transport = (request: GoogleRequest) => {
    sent.push(request);
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new Error('No answer scripted.'));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return Object.assign(transport, { sent });
}
const json = (status: number, body: unknown): GoogleResponse => ({
  status,
  body: JSON.stringify(body),
});
const googleError = (status: number, reason: string) =>
  json(status, { error: { errors: [{ domain: 'global', reason }], code: status } });
const idToken = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const event = {
  summary: 'Venue tour',
  description: 'Booked',
  location: null,
  startsAt: new Date('2026-11-02T10:00:00Z'),
  endsAt: new Date('2026-11-02T10:30:00Z'),
  timeZone: 'America/New_York',
  appointmentId: '01890a5d-ac96-774b-bcce-b302099a8057',
};

describe('where requests go', () => {
  it('sends to Google’s two API hosts only, never with credentials in the address', async () => {
    expect(isGoogleAddress('https://oauth2.googleapis.com/token')).toBe(true);
    expect(isGoogleAddress('https://www.googleapis.com/calendar/v3/freeBusy')).toBe(true);
    expect(isGoogleAddress('https://evil.example/token')).toBe(false);
    expect(isGoogleAddress('http://www.googleapis.com/calendar/v3')).toBe(false);
    expect(isGoogleAddress('https://user:pw@www.googleapis.com/x')).toBe(false);
    expect(isGoogleAddress('not a url')).toBe(false);
    const asked: string[] = [];
    const transport = createGoogleTransport((input) => {
      asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    await expect(
      transport({ method: 'GET', url: 'https://evil.example/', headers: {} }),
    ).rejects.toThrow(/not one Calendar sync calls/);
    await expect(
      transport({ method: 'GET', url: 'https://www.googleapis.com/calendar/v3/x', headers: {} }),
    ).resolves.toEqual({ status: 200, body: '{}' });
    expect(asked).toEqual(['https://www.googleapis.com/calendar/v3/x']);
  });

  it('refuses an answer too large to be Google’s', async () => {
    const transport = createGoogleTransport(() =>
      Promise.resolve(new Response('x'.repeat(2_000_001), { status: 200 })),
    );
    await expect(
      transport({ method: 'GET', url: 'https://www.googleapis.com/calendar/v3/x', headers: {} }),
    ).rejects.toThrow(/too much/);
  });
});

describe('OAuth', () => {
  it('asks for offline access, consent, the five scopes, the state and an S256 challenge', () => {
    const url = new URL(authorizationUrl(client, { state: 'st', codeChallenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope:
        'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges a code with the verifier and the secret, and reads the account from the ID token', async () => {
    const transport = scripted(
      json(200, {
        access_token: 'ya29.a',
        expires_in: 3599,
        refresh_token: '1//r',
        scope: 'openid https://www.googleapis.com/auth/calendar.events',
        token_type: 'Bearer',
        id_token: idToken({ sub: '42', email: 'dana@example.test' }),
      }),
    );
    const result = await exchangeCode(transport, client, '4/code', 'verifier');
    expect(result).toEqual({
      ok: true,
      value: {
        refreshToken: '1//r',
        accessToken: 'ya29.a',
        expiresInSeconds: 3599,
        scopes: new Set(['openid', 'https://www.googleapis.com/auth/calendar.events']),
        account: { sub: '42', email: 'dana@example.test' },
      },
    });
    expect(transport.sent[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(new URLSearchParams(transport.sent[0]?.body))).toEqual({
      code: '4/code',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: 'verifier',
    });
  });

  it('fails an exchange that gives no refresh token, a refused code, or no answer', async () => {
    expect(
      await exchangeCode(
        scripted(json(200, { access_token: 'a', expires_in: 10, scope: '' })),
        client,
        'c',
        'v',
      ),
    ).toEqual({ ok: false, failure: 'retry' });
    expect(
      await exchangeCode(scripted(json(400, { error: 'invalid_grant' })), client, 'c', 'v'),
    ).toEqual({ ok: false, failure: 'rejected' });
    expect(await exchangeCode(scripted(new Error('reset')), client, 'c', 'v')).toEqual({
      ok: false,
      failure: 'retry',
    });
    expect(
      await exchangeCode(scripted({ status: 200, body: 'not json' }), client, 'c', 'v'),
    ).toEqual({ ok: false, failure: 'retry' });
    expect(() => accountOf('only-one-part')).toThrow(/no payload/);
  });

  it('refreshes a token, and tells an expired or revoked one from Google being away', async () => {
    expect(
      await refreshAccessToken(
        scripted(json(200, { access_token: 'ya29.b', expires_in: 3599, scope: '' })),
        client,
        '1//r',
      ),
    ).toEqual({ outcome: 'ok', accessToken: 'ya29.b', expiresInSeconds: 3599 });
    expect(
      await refreshAccessToken(
        scripted(
          json(400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          }),
        ),
        client,
        '1//r',
      ),
    ).toEqual({ outcome: 'invalid_grant' });
    for (const answer of [
      json(400, { error: 'invalid_request' }),
      json(503, { error: 'unavailable' }),
      { status: 200, body: '<html>' },
      new Error('timeout'),
    ])
      expect(await refreshAccessToken(scripted(answer), client, '1//r')).toEqual({
        outcome: 'unavailable',
      });
  });

  it('revokes, taking 400 for a token already dead as done', async () => {
    expect(await revokeToken(scripted(json(200, {})), 't')).toBe(true);
    expect(await revokeToken(scripted(json(400, { error: 'invalid_token' })), 't')).toBe(true);
    expect(await revokeToken(scripted(json(503, {})), 't')).toBe(false);
    expect(await revokeToken(scripted(new Error('down')), 't')).toBe(false);
  });
});

describe('what a failure means', () => {
  it.each([
    [googleError(401, 'authError'), 'unauthorized'],
    [googleError(404, 'notFound'), 'not_found'],
    [googleError(409, 'duplicate'), 'duplicate'],
    [googleError(410, 'deleted'), 'gone'],
    [googleError(429, 'rateLimitExceeded'), 'retry'],
    [googleError(500, 'backendError'), 'retry'],
    [googleError(403, 'rateLimitExceeded'), 'retry'],
    [googleError(403, 'userRateLimitExceeded'), 'retry'],
    [googleError(403, 'quotaExceeded'), 'retry'],
    [googleError(403, 'forbiddenForNonOrganizer'), 'rejected'],
    [{ status: 403, body: 'nope' }, 'rejected'],
    [googleError(400, 'timeRangeEmpty'), 'rejected'],
  ] as const)('%j is %s', (response, failure) => {
    expect(failureOf(response)).toBe(failure);
  });
});

describe('the calendar list and busy time', () => {
  it('reads every page, names each calendar, and leaves deleted ones out', async () => {
    const transport = scripted(
      json(200, {
        items: [
          { id: 'dana@example.test', summary: 'Dana', primary: true, accessRole: 'owner' },
          { id: 'shared', summary: 'Shared', summaryOverride: 'Team', accessRole: 'writer' },
        ],
        nextPageToken: 'p2',
      }),
      json(200, {
        items: [
          { id: 'gone', summary: 'Gone', accessRole: 'reader', deleted: true },
          { id: 'nameless', accessRole: 'freeBusyReader' },
        ],
      }),
    );
    expect(await listCalendars(transport, 'ya29.a')).toEqual({
      ok: true,
      value: [
        { id: 'dana@example.test', name: 'Dana', primary: true, accessRole: 'owner' },
        { id: 'shared', name: 'Team', primary: false, accessRole: 'writer' },
        { id: 'nameless', name: 'nameless', primary: false, accessRole: 'freeBusyReader' },
      ],
    });
    expect(transport.sent.map((request) => request.url)).toEqual([
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&pageToken=p2',
    ]);
    expect(transport.sent[0]?.headers['authorization']).toBe('Bearer ya29.a');
    expect(await listCalendars(scripted(googleError(401, 'authError')), 'x')).toEqual({
      ok: false,
      failure: 'unauthorized',
    });
  });

  it('reads busy time, and fails the whole reading when one calendar can’t be read', async () => {
    const from = new Date('2026-11-02T00:00:00Z');
    const to = new Date('2026-11-03T00:00:00Z');
    const transport = scripted(
      json(200, {
        kind: 'calendar#freeBusy',
        calendars: {
          a: { busy: [{ start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z' }] },
          b: { busy: [{ start: '2026-11-02T12:00:00-05:00', end: '2026-11-02T12:00:00-05:00' }] },
        },
      }),
    );
    expect(await queryFreeBusy(transport, 't', ['a', 'b'], from, to)).toEqual({
      ok: true,
      value: [
        { startsAt: new Date('2026-11-02T10:00:00Z'), endsAt: new Date('2026-11-02T11:00:00Z') },
      ],
    });
    expect(JSON.parse(transport.sent[0]?.body ?? '')).toEqual({
      timeMin: '2026-11-02T00:00:00.000Z',
      timeMax: '2026-11-03T00:00:00.000Z',
      items: [{ id: 'a' }, { id: 'b' }],
    });
    expect(
      await queryFreeBusy(
        scripted(
          json(200, {
            calendars: { a: { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] } },
          }),
        ),
        't',
        ['a'],
        from,
        to,
      ),
    ).toEqual({ ok: false, failure: 'retry' });
    expect(
      await queryFreeBusy(scripted(json(200, { calendars: {} })), 't', ['a'], from, to),
    ).toEqual({ ok: false, failure: 'retry' });
    expect(await queryFreeBusy(scripted(), 't', [], from, to)).toEqual({ ok: true, value: [] });
  });
});

describe('events', () => {
  it('inserts with its own id, no attendees, and a Meet when asked', async () => {
    const transport = scripted(
      json(200, {
        id: 'crm1g1',
        conferenceData: {
          createRequest: { status: { statusCode: 'success' } },
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
          ],
        },
      }),
    );
    expect(await insertEvent(transport, 't', 'dana@example.test', 'crm1g1', event, true)).toEqual({
      ok: true,
      value: { meetUrl: 'https://meet.google.com/abc-defg-hij', meetPending: false },
    });
    const sent = transport.sent[0];
    expect(sent?.url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/dana%40example.test/events?conferenceDataVersion=1',
    );
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      id: 'crm1g1',
      summary: 'Venue tour',
      description: 'Booked',
      location: '',
      start: { dateTime: '2026-11-02T10:00:00.000Z', timeZone: 'America/New_York' },
      end: { dateTime: '2026-11-02T10:30:00.000Z', timeZone: 'America/New_York' },
      extendedProperties: { private: { crmAppointmentId: event.appointmentId } },
      conferenceData: {
        createRequest: { requestId: 'crm1g1', conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    });
  });

  it('patches without a Meet, says when the Meet is still being made, and reads an event', async () => {
    const pending = json(200, {
      conferenceData: { createRequest: { status: { statusCode: 'pending' } } },
    });
    const transport = scripted(json(200, {}), pending, pending);
    expect(await patchEvent(transport, 't', 'c', 'crm1g1', event, false)).toEqual({
      ok: true,
      value: { meetUrl: null, meetPending: false },
    });
    expect(transport.sent[0]?.method).toBe('PATCH');
    expect(transport.sent[0]?.url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/c/events/crm1g1',
    );
    expect(JSON.parse(transport.sent[0]?.body ?? '')).not.toHaveProperty('conferenceData');
    expect(await patchEvent(transport, 't', 'c', 'crm1g1', event, true)).toEqual({
      ok: true,
      value: { meetUrl: null, meetPending: true },
    });
    expect(await getEvent(transport, 't', 'c', 'crm1g1')).toEqual({
      ok: true,
      value: { meetUrl: null, meetPending: true },
    });
  });

  it('counts deleting what is already gone as done', async () => {
    expect(await deleteEvent(scripted({ status: 204, body: '' }), 't', 'c', 'e')).toEqual({
      ok: true,
      value: null,
    });
    expect(await deleteEvent(scripted(googleError(410, 'deleted')), 't', 'c', 'e')).toEqual({
      ok: true,
      value: null,
    });
    expect(await deleteEvent(scripted(googleError(404, 'notFound')), 't', 'c', 'e')).toEqual({
      ok: true,
      value: null,
    });
    expect(await deleteEvent(scripted(googleError(503, 'backendError')), 't', 'c', 'e')).toEqual({
      ok: false,
      failure: 'retry',
    });
  });
});
