import { describe, expect, it } from 'vitest';

import {
  authorizationUrl,
  exchangeCode,
  readIdentity,
  readTokenAnswer,
  refreshTokens,
  revokeToken,
  type Fetch,
  type OAuthClient,
  type OAuthEndpoints,
} from './oauth.js';

const endpoints: OAuthEndpoints = {
  authorizeUrl: 'https://provider.example/oauth/authorize?prompt=consent',
  tokenUrl: 'https://provider.example/oauth/token',
  revokeUrl: 'https://provider.example/oauth/revoke',
  clientAuth: 'basic',
};
const client: OAuthClient = {
  clientId: 'client id',
  clientSecret: 'se:cret',
  redirectUri: 'https://crm.example.test/api/v1/integrations/standin/callback',
};
const now = new Date('2026-10-18T09:00:00.000Z');

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that answers every request with one response, and remembers what it was asked. */
function answering(status: number, body: unknown, seen: Seen[] = []): Fetch {
  return (input, init) => {
    seen.push({ url: input instanceof Request ? input.url : String(input), init });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  };
}

const failing: Fetch = () => Promise.reject(new TypeError('fetch failed'));

describe('authorizationUrl', () => {
  it("asks for a code with the client, the way back, the scopes, the state and S256's challenge", () => {
    const url = new URL(
      authorizationUrl(endpoints, client, {
        state: 'the-state',
        scopes: ['read', 'write'],
        codeChallenge: 'challenge',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://provider.example/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: 'consent',
      response_type: 'code',
      client_id: 'client id',
      redirect_uri: client.redirectUri,
      scope: 'read write',
      state: 'the-state',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
  });

  it('leaves out scope and PKCE when there are none', () => {
    const url = new URL(authorizationUrl(endpoints, client, { state: 's', scopes: [] }));
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.has('code_challenge')).toBe(false);
  });
});

describe('readTokenAnswer', () => {
  it('reads a token set, with its lifetime and the scopes granted', () => {
    expect(
      readTokenAnswer(
        200,
        { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'read,write  extra' },
        now,
      ),
    ).toEqual({
      ok: true,
      tokens: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2026-10-18T10:00:00.000Z',
        scopes: ['read', 'write', 'extra'],
      },
    });
  });

  it('takes a lifetime given as text, and none when there is none or it is nonsense', () => {
    const read = (expires: unknown) => {
      const outcome = readTokenAnswer(200, { access_token: 'at', expires_in: expires }, now);
      return outcome.ok ? outcome.tokens.expiresAt : 'failed';
    };
    expect(read('60')).toBe('2026-10-18T09:01:00.000Z');
    expect(read(undefined)).toBeNull();
    expect(read('soon')).toBeNull();
    expect(read(0)).toBeNull();
  });

  it('keeps no empty refresh token and no scope list it was not given', () => {
    expect(readTokenAnswer(200, { access_token: 'at', refresh_token: '' }, now)).toEqual({
      ok: true,
      tokens: { accessToken: 'at', refreshToken: null, expiresAt: null, scopes: null },
    });
  });

  it.each([
    [400, { error: 'invalid_grant' }, 'invalid_grant'],
    [401, { error: 'invalid_grant' }, 'invalid_grant'],
    [400, { error: 'invalid_client' }, 'refused'],
    [403, 'Forbidden', 'refused'],
    [200, { token_type: 'bearer' }, 'unavailable'],
    [429, { error: 'slow_down' }, 'unavailable'],
    [408, undefined, 'unavailable'],
    [503, undefined, 'unavailable'],
    [400, 'not json', 'refused'],
  ])('reads %i %j as %s', (status, body, failure) => {
    expect(readTokenAnswer(status, body, now)).toEqual({ ok: false, failure });
  });
});

describe('exchangeCode', () => {
  it('posts the code, the way back and the verifier, with the client in a Basic header', async () => {
    const seen: Seen[] = [];
    const outcome = await exchangeCode(
      answering(200, { access_token: 'at', refresh_token: 'rt', expires_in: 60 }, seen),
      endpoints,
      client,
      'the-code',
      'the-verifier',
      () => now,
    );
    expect(outcome.ok).toBe(true);
    const [request] = seen;
    expect(request?.url).toBe(endpoints.tokenUrl);
    expect(request?.init?.method).toBe('POST');
    const headers = request?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('client%20id:se%3Acret').toString('base64')}`,
    );
    expect(Object.fromEntries(request?.init?.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: client.redirectUri,
      code_verifier: 'the-verifier',
    });
  });

  it('puts the client in the body for a provider that wants it there, and sends no verifier without PKCE', async () => {
    const seen: Seen[] = [];
    await exchangeCode(
      answering(200, { access_token: 'at' }, seen),
      { ...endpoints, clientAuth: 'body' },
      client,
      'code',
      undefined,
    );
    const body = Object.fromEntries(seen[0]?.init?.body as URLSearchParams);
    expect(body).toMatchObject({ client_id: 'client id', client_secret: 'se:cret' });
    expect(body).not.toHaveProperty('code_verifier');
    expect((seen[0]?.init?.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('says the provider is unavailable when it cannot be reached, or answers with no JSON', async () => {
    expect(await exchangeCode(failing, endpoints, client, 'code', undefined)).toEqual({
      ok: false,
      failure: 'unavailable',
    });
    expect(await exchangeCode(answering(502, '<html>'), endpoints, client, 'c', undefined)).toEqual(
      { ok: false, failure: 'unavailable' },
    );
    expect(await exchangeCode(answering(200, ''), endpoints, client, 'c', undefined)).toEqual({
      ok: false,
      failure: 'unavailable',
    });
  });
});

describe('refreshTokens', () => {
  it('posts the refresh token and reads the new set', async () => {
    const seen: Seen[] = [];
    const outcome = await refreshTokens(
      answering(200, { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }, seen),
      endpoints,
      client,
      'old-refresh',
      () => now,
    );
    expect(outcome).toEqual({
      ok: true,
      tokens: {
        accessToken: 'new',
        refreshToken: 'rotated',
        expiresAt: '2026-10-18T10:00:00.000Z',
        scopes: null,
      },
    });
    expect(Object.fromEntries(seen[0]?.init?.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
    });
  });

  it('reads invalid_grant, and an unreachable provider', async () => {
    expect(
      await refreshTokens(answering(400, { error: 'invalid_grant' }), endpoints, client, 'r'),
    ).toEqual({ ok: false, failure: 'invalid_grant' });
    expect(await refreshTokens(failing, endpoints, client, 'r')).toEqual({
      ok: false,
      failure: 'unavailable',
    });
  });
});

describe('revokeToken', () => {
  it('posts the token with its hint, and is done on any answer the provider means', async () => {
    const seen: Seen[] = [];
    expect(await revokeToken(answering(200, ''), endpoints, client, 't', 'refresh_token')).toBe(
      'revoked',
    );
    expect(
      await revokeToken(
        answering(400, { error: 'invalid_token' }, seen),
        endpoints,
        client,
        't',
        'access_token',
      ),
    ).toBe('revoked');
    expect(Object.fromEntries(seen[0]?.init?.body as URLSearchParams)).toEqual({
      token: 't',
      token_type_hint: 'access_token',
    });
  });

  it('is to be tried again when the provider is busy or unreachable', async () => {
    expect(await revokeToken(answering(503, ''), endpoints, client, 't', 'refresh_token')).toBe(
      'unavailable',
    );
    expect(await revokeToken(answering(429, ''), endpoints, client, 't', 'refresh_token')).toBe(
      'unavailable',
    );
    expect(await revokeToken(failing, endpoints, client, 't', 'refresh_token')).toBe('unavailable');
  });

  it('has nothing to do for a provider without a revocation endpoint', async () => {
    expect(
      await revokeToken(
        failing,
        { ...endpoints, revokeUrl: undefined },
        client,
        't',
        'refresh_token',
      ),
    ).toBe('unsupported');
  });
});

describe('readIdentity', () => {
  it('reads the account with the token as a bearer token', async () => {
    const seen: Seen[] = [];
    expect(
      await readIdentity(answering(200, { id: 'T1' }, seen), 'https://p.example/me', 'at'),
    ).toEqual({
      ok: true,
      body: { id: 'T1' },
    });
    expect((seen[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer at');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
  ])('reads %i as %s', async (status, failure) => {
    expect(await readIdentity(answering(status, {}), 'https://p.example/me', 'at')).toEqual({
      ok: false,
      failure,
    });
  });

  it('is unavailable when unreachable or the answer is not JSON', async () => {
    expect(await readIdentity(failing, 'https://p.example/me', 'at')).toEqual({
      ok: false,
      failure: 'unavailable',
    });
    expect(await readIdentity(answering(200, 'nope'), 'https://p.example/me', 'at')).toEqual({
      ok: false,
      failure: 'unavailable',
    });
  });
});
