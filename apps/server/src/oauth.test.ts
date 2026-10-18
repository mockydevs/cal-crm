// The OAuth endpoints' transport, with the auth module's work faked: what reaches
// it, and how each answer goes back. The real work runs against Postgres in
// marketplace-oauth.int.test.ts and the auth module's app-tokens.int.test.ts.
import type { OAuthRevokeRequest, OAuthTokenRequest } from '@repo/module-auth';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerOAuth, type OAuthTransport } from './oauth.js';

const ISSUER = 'https://crm.example.test';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const TOKENS = {
  access_token: `crm_at_${'a'.repeat(64)}`,
  token_type: 'Bearer' as const,
  expires_in: 86_400,
  refresh_token: `crm_rt_${'b'.repeat(64)}`,
  scope: 'tags.manage',
};

async function server(overrides: Partial<OAuthTransport> = {}) {
  const seen: { token: OAuthTokenRequest[]; revoke: OAuthRevokeRequest[] } = {
    token: [],
    revoke: [],
  };
  const app = Fastify({ logger: false });
  await registerOAuth(app, {
    issuer: ISSUER,
    token: (request) => {
      seen.token.push(request);
      return Promise.resolve({ outcome: 'issued', tokens: TOKENS });
    },
    revoke: (request) => {
      seen.revoke.push(request);
      return Promise.resolve({ outcome: 'revoked' });
    },
    rateLimit: () => Promise.resolve({ allowed: true }),
    ...overrides,
  });
  return { app, seen };
}

const basic = (pair: string) => `Basic ${Buffer.from(pair).toString('base64')}`;

describe('POST /oauth/token', () => {
  it('passes the form on by RFC 6749’s names, with Basic credentials decoded', async () => {
    const { app, seen } = await server();
    const answer = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { ...FORM, authorization: basic('mapp_x:crm%2Bcs+one') },
      payload:
        'grant_type=authorization_code&code=c&redirect_uri=https%3A%2F%2Fa.example%2Fcb&code_verifier=v&client_id=mapp_x',
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual(TOKENS);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers.pragma).toBe('no-cache');
    expect(seen.token).toEqual([
      {
        grantType: 'authorization_code',
        code: 'c',
        redirectUri: 'https://a.example/cb',
        codeVerifier: 'v',
        clientId: 'mapp_x',
        clientSecret: 'crm+cs one',
      },
    ]);
  });

  it('takes the client in the body, and a refresh token', async () => {
    const { app, seen } = await server();
    await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: 'grant_type=refresh_token&refresh_token=r&client_id=mapp_x&client_secret=s',
    });
    expect(seen.token).toEqual([
      { grantType: 'refresh_token', refreshToken: 'r', clientId: 'mapp_x', clientSecret: 's' },
    ]);
  });

  it('refuses malformed Basic, a second client, a mismatched client id and a repeated name', async () => {
    const { app, seen } = await server();
    for (const [authorization, payload] of [
      ['Bearer x', 'grant_type=refresh_token'],
      [basic('no-colon'), 'grant_type=refresh_token'],
      [basic('mapp_x:%E0%A4%A'), 'grant_type=refresh_token'],
      [basic('mapp_x:s'), 'grant_type=refresh_token&client_secret=s'],
      [basic('mapp_x:s'), 'grant_type=refresh_token&client_id=mapp_y'],
      [basic('mapp_x:s'), 'grant_type=refresh_token&grant_type=password'],
    ] as const) {
      const answer = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { ...FORM, authorization },
        payload,
      });
      expect(answer.statusCode, `${authorization} ${payload}`).toBe(400);
      expect(answer.json()).toMatchObject({ error: 'invalid_request' });
    }
    expect(seen.token).toEqual([]);
  });

  it('answers a refusal with its status, and Basic’s challenge when Basic failed', async () => {
    const { app } = await server({
      token: () =>
        Promise.resolve({
          outcome: 'refused',
          status: 401,
          error: 'invalid_client',
          description: 'The client id or secret is not valid.',
        }),
    });
    const withBasic = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { ...FORM, authorization: basic('mapp_x:s') },
      payload: 'grant_type=refresh_token&refresh_token=r',
    });
    expect(withBasic.statusCode).toBe(401);
    expect(withBasic.headers['www-authenticate']).toBe('Basic realm="oauth"');
    expect(withBasic.json()).toEqual({
      error: 'invalid_client',
      error_description: 'The client id or secret is not valid.',
    });
    const inBody = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: 'grant_type=refresh_token&refresh_token=r&client_id=x&client_secret=s',
    });
    expect(inBody.statusCode).toBe(401);
    expect(inBody.headers['www-authenticate']).toBeUndefined();
  });

  it('refuses what isn’t a form, or is too long, in OAuth’s words', async () => {
    const { app } = await server();
    const json = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(json.statusCode).toBe(415);
    expect(json.json()).toMatchObject({ error: 'invalid_request' });
    const long = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: `code=${'x'.repeat(9000)}`,
    });
    expect(long.statusCode).toBe(413);
    const empty = await app.inject({ method: 'POST', url: '/oauth/token' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('says only server_error when the work fails, and logs neither token nor secret', async () => {
    const { app } = await server({ token: () => Promise.reject(new Error('crm_cs_secret')) });
    const answer = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: 'grant_type=refresh_token',
    });
    expect(answer.statusCode).toBe(500);
    expect(answer.json()).toEqual({ error: 'server_error' });
  });
});

describe('the shared limiter', () => {
  it('goes first: a refusal is 429 with Retry-After, a broken limiter 503', async () => {
    const limited = await server({
      rateLimit: () => Promise.resolve({ allowed: false, retryAfterSeconds: 30 }),
    });
    const refused = await limited.app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('30');
    const nonsense = await server({
      rateLimit: () => Promise.resolve({ allowed: false, retryAfterSeconds: 0 }),
    });
    expect(
      (
        await nonsense.app.inject({
          method: 'POST',
          url: '/oauth/token',
          headers: FORM,
          payload: '',
        })
      ).statusCode,
    ).toBe(503);
    const broken = await server({ rateLimit: () => Promise.reject(new Error('down')) });
    expect(
      (await broken.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' }))
        .statusCode,
    ).toBe(503);
  });
});

describe('POST /oauth/revoke', () => {
  it('passes the token and client on, and answers 200 with nothing', async () => {
    const { app, seen } = await server();
    const answer = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { ...FORM, authorization: basic('mapp_x:s') },
      payload: 'token=t&token_type_hint=refresh_token',
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toBe('');
    expect(seen.revoke).toEqual([{ token: 't', clientId: 'mapp_x', clientSecret: 's' }]);
    await app.inject({ method: 'POST', url: '/oauth/revoke', headers: FORM, payload: 'x=1' });
    expect(seen.revoke[1]).toEqual({});
  });

  it('answers its refusals in OAuth’s words', async () => {
    for (const [error, status, description] of [
      ['invalid_client', 401, 'The client id or secret is not valid.'],
      ['invalid_request', 400, 'Send token.'],
    ] as const) {
      const { app } = await server({
        revoke: () => Promise.resolve({ outcome: 'refused', status, error }),
      });
      const answer = await app.inject({
        method: 'POST',
        url: '/oauth/revoke',
        headers: FORM,
        payload: 'client_id=x',
      });
      expect(answer.statusCode).toBe(status);
      expect(answer.json()).toEqual({ error, error_description: description });
    }
    const { app } = await server();
    const twice = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: FORM,
      payload: 'token=a&token=b',
    });
    expect(twice.statusCode).toBe(400);
  });
});

describe('GET /.well-known/oauth-authorization-server', () => {
  it('describes the server from its issuer', async () => {
    const { app } = await server();
    const answer = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(answer.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      revocation_endpoint: `${ISSUER}/oauth/revoke`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    });
    expect(answer.json<{ scopes_supported: string[] }>().scopes_supported).toContain('tags.manage');
  });
});
