// OAuth for installed apps over HTTP: a person consents, the app trades the code
// for tokens at /oauth/token, calls the API with the access token as its install's app key,
// refreshes, and loses everything when it is uninstalled or a token is replayed.
import { createHash, randomBytes } from 'node:crypto';

import { allowEveryone } from '@repo/commands';
import {
  agencyMarketplaceApp,
  apiKeyContext,
  marketplaceClientSecret,
  oauthAuthorizationGrant,
  oauthAuthorizationView,
  oauthTokenResponse,
  tag,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createAuthentication, type Authentication } from '@repo/module-auth';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import { API_PREFIX, buildServer, type Server } from './server.js';

const PUBLIC_URL = 'https://crm.example.test';
const PASSWORD = 'correct horse battery staple';
const REDIRECT = 'https://sync.example/oauth/callback';

let database: TestDatabase;
let db: Database;
let authentication: Authentication;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  authentication = createAuthentication({
    connectionString: database.url('crm_auth'),
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
    publicUrl: PUBLIC_URL,
    onConnectionError: () => undefined,
    log: () => undefined,
    sendMail: () => Promise.resolve(),
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});

afterAll(async () => {
  await authentication.close();
  await db.destroy();
  await database.close();
});

async function api() {
  const server = await buildServer({
    config: {
      nodeEnv: 'test',
      role: 'app',
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      databaseAppUrl: database.url('crm_app'),
      databaseWorkerUrl: undefined,
      databasePoolSize: 2,
      shutdownTimeoutMs: 1000,
      dashboardDir: undefined,
      devTenantContext: undefined,
      publicUrl: PUBLIC_URL,
      authentication: undefined,
      trustProxy: [],
      mail: undefined,
      files: undefined,
      vault: undefined,
    },
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes: apiRoutes(authentication, undefined, false, PUBLIC_URL),
    services: { db, authorize: allowEveryone },
    authentication,
    oauth: {
      issuer: PUBLIC_URL,
      token: (request) => authentication.oauthToken(request),
      revoke: (request) => authentication.oauthRevoke(request),
      rateLimit: () => Promise.resolve({ allowed: true }),
    },
    files: undefined,
    readinessChecks: {},
  });
  servers.push(server);
  return server.app;
}

type App = Awaited<ReturnType<typeof api>>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

let people = 0;

/**
 * An agency with two businesses, its owner signed in, and a listed app asking for
 * tags.manage and tags.configure, with its redirect address and client secret.
 */
async function agencyWithApp(app: App) {
  const agency = await database.fixtures.agency();
  const number = ++people;
  const business = await database.fixtures.business(agency.id, { slug: `oauth-${String(number)}` });
  const other = await database.fixtures.business(agency.id);
  const email = `oauth-owner-${String(number)}@harborlights.example`;
  const { id: userId } = await authentication.createUser({
    email,
    name: 'Dana Brooks',
    password: PASSWORD,
    emailVerified: true,
  });
  await database.as('crm_owner', async (sql) => {
    const { id: roleId } = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       values ($1, 'agency', 'owner', 'Owner', true) returning id`,
      [agency.id],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, null, $3)`,
      [userId, agency.id, roleId],
    );
  });
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
    payload: { email, password: PASSWORD },
    remoteAddress: `198.51.100.${String(number)}`,
  });
  expect(signIn.statusCode).toBe(200);
  const setCookie = signIn.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((each) => each.split(';')[0] ?? '')
    .join('; ');
  const asOwner = (method: Method, path: string, payload?: object, businessId?: string) =>
    app.inject({
      method,
      url: `${API_PREFIX}${path}`,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(businessId === undefined ? {} : { 'business-id': toPublicId('business', businessId) }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const body = {
    name: 'Harbor Sync',
    developer: 'Harbor Labs',
    scopes: ['tags.manage', 'tags.configure'],
    readGroups: ['Tags'],
    redirectUris: [REDIRECT],
  };
  const made = await asOwner('POST', '/agency/marketplace/apps', body);
  expect(made.statusCode, made.body).toBe(201);
  const marketplaceApp = agencyMarketplaceApp.parse(made.json());
  const listed = await asOwner('PUT', `/agency/marketplace/apps/${marketplaceApp.id}`, {
    ...body,
    status: 'listed',
  });
  expect(listed.statusCode, listed.body).toBe(200);
  const secret = await asOwner(
    'POST',
    `/agency/marketplace/apps/${marketplaceApp.id}/client-secret`,
  );
  expect(secret.statusCode, secret.body).toBe(201);
  const { clientId, clientSecret } = marketplaceClientSecret.parse(secret.json());
  return { agency, business, other, asOwner, clientId, clientSecret };
}

type Agency = Awaited<ReturnType<typeof agencyWithApp>>;

/** A PKCE pair (RFC 7636 section 4.1 and 4.2). */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const query = (values: Record<string, string>) => new URLSearchParams(values).toString();

/** The owner consents in the business; the code the app's redirect address receives. */
async function consent(agency: Agency, challenge: string, state = 'state-1') {
  const request = {
    clientId: agency.clientId,
    redirectUri: REDIRECT,
    responseType: 'code',
    state,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
  };
  const read = await agency.asOwner(
    'GET',
    `/oauth/authorize?${query(request)}`,
    undefined,
    agency.business.id,
  );
  expect(read.statusCode, read.body).toBe(200);
  expect(oauthAuthorizationView.parse(read.json())).toMatchObject({
    kind: 'consent',
    scopes: ['tags.manage', 'tags.configure'],
    readGroups: ['Tags'],
    missingScopes: [],
  });
  const granted = await agency.asOwner('POST', '/oauth/authorize', request, agency.business.id);
  expect(granted.statusCode, granted.body).toBe(201);
  const url = new URL(oauthAuthorizationGrant.parse(granted.json()).redirectUrl);
  expect(url.searchParams.get('state')).toBe(state);
  expect(url.searchParams.get('iss')).toBe(PUBLIC_URL);
  return url.searchParams.get('code') ?? '';
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

/** A form post to /oauth/token or /oauth/revoke, the client authenticating with Basic. */
const post = (
  app: App,
  path: '/oauth/token' | '/oauth/revoke',
  form: Record<string, string>,
  authorization?: string,
) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(authorization === undefined ? {} : { authorization }),
    },
    payload: query(form),
  });

async function tokensFor(app: App, agency: Agency) {
  const { verifier, challenge } = pkce();
  const code = await consent(agency, challenge);
  const answer = await post(
    app,
    '/oauth/token',
    { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
    basic(agency.clientId, agency.clientSecret),
  );
  expect(answer.statusCode, answer.body).toBe(200);
  return { code, verifier, tokens: oauthTokenResponse.parse(answer.json()) };
}

const withToken = (
  app: App,
  token: string,
  method: Method,
  path: string,
  options: { payload?: object; business?: string } = {},
) =>
  app.inject({
    method,
    url: `${API_PREFIX}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.business === undefined
        ? {}
        : { 'business-id': toPublicId('business', options.business) }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });

describe('an installed app’s access token', () => {
  it('works as the install’s app key: its scopes, its business, its name in the log', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const answer = await tokensFor(app, agency);
    expect(answer.tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: 86_400,
      // The catalogue's order, as every list of permissions is.
      scope: 'tags.configure tags.manage',
    });

    const made = await withToken(app, answer.tokens.access_token, 'POST', '/tags', {
      payload: { name: 'From Harbor Sync' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const created = tag.parse(made.json());
    expect((await withToken(app, answer.tokens.access_token, 'GET', '/tags')).statusCode).toBe(200);
    // Nothing it wasn't granted, not even a read, and nothing a key can't do.
    expect((await withToken(app, answer.tokens.access_token, 'GET', '/contacts')).statusCode).toBe(
      403,
    );
    expect((await withToken(app, answer.tokens.access_token, 'GET', '/api-keys')).statusCode).toBe(
      403,
    );
    const self = await withToken(app, answer.tokens.access_token, 'GET', '/integration/context');
    expect(self.statusCode, self.body).toBe(200);
    expect(apiKeyContext.parse(self.json())).toMatchObject({
      scope: 'business',
      business: { id: toPublicId('business', agency.business.id) },
      scopes: ['tags.configure', 'tags.manage'],
      readGroups: ['Tags'],
    });
    // Its own business only.
    const elsewhere = await withToken(app, answer.tokens.access_token, 'GET', '/tags', {
      business: agency.other.id,
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(
      (
        await withToken(app, answer.tokens.access_token, 'GET', '/tags', {
          business: agency.business.id,
        })
      ).statusCode,
    ).toBe(200);

    const [event] = await database.as('crm_owner', (sql) =>
      sql.query<{ actor_kind: string; name: string }>(
        `select e.actor_kind, k.name from events.events e
           join tenancy.api_keys k on k.id = e.actor_id
          where e.type = 'tag.created' and e.subject_id = (
            select id from crm.tags where name = $1 and business_id = $2)`,
        [created.name, agency.business.id],
      ),
    );
    expect(event).toEqual({ actor_kind: 'api_key', name: 'Harbor Sync' });
    // The API keys page doesn't list it.
    const keys = await agency.asOwner('GET', '/api-keys', undefined, agency.business.id);
    expect(keys.statusCode).toBe(200);
    expect(keys.body).not.toContain('Harbor Sync');
  });

  it('refreshes into a new pair, and a refresh token replayed stops the whole family', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const { tokens } = await tokensFor(app, agency);
    const auth = basic(agency.clientId, agency.clientSecret);
    const refreshed = await post(
      app,
      '/oauth/token',
      { grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
      auth,
    );
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const next = oauthTokenResponse.parse(refreshed.json());
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await withToken(app, next.access_token, 'GET', '/tags')).statusCode).toBe(200);

    const replayed = await post(
      app,
      '/oauth/token',
      { grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
      auth,
    );
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await withToken(app, next.access_token, 'GET', '/tags')).statusCode).toBe(401);
    const afterReplay = await post(
      app,
      '/oauth/token',
      { grant_type: 'refresh_token', refresh_token: next.refresh_token },
      auth,
    );
    expect(afterReplay.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('a code works once: used again, it stops what it gave', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const { code, verifier, tokens } = await tokensFor(app, agency);
    const again = await post(
      app,
      '/oauth/token',
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
      basic(agency.clientId, agency.clientSecret),
    );
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: 'invalid_grant' });
    const refused = await withToken(app, tokens.access_token, 'GET', '/tags');
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
  });

  it('stops when the app is uninstalled, the token is revoked, or it expires', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const auth = basic(agency.clientId, agency.clientSecret);

    const revoked = await tokensFor(app, agency);
    const answer = await post(app, '/oauth/revoke', { token: revoked.tokens.refresh_token }, auth);
    expect(answer.statusCode).toBe(200);
    expect((await withToken(app, revoked.tokens.access_token, 'GET', '/tags')).statusCode).toBe(
      401,
    );
    // An unknown token is answered the same (RFC 7009 section 2.2).
    expect((await post(app, '/oauth/revoke', { token: 'nothing' }, auth)).statusCode).toBe(200);

    const expiring = await tokensFor(app, agency);
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.marketplace_oauth_tokens
            set created_at = now() - interval '2 days', access_expires_at = now() - interval '1 day'
          where access_hash = $1`,
        [createHash('sha256').update(expiring.tokens.access_token).digest()],
      ),
    );
    expect((await withToken(app, expiring.tokens.access_token, 'GET', '/tags')).statusCode).toBe(
      401,
    );

    const live = await tokensFor(app, agency);
    const installs = await agency.asOwner(
      'GET',
      '/marketplace/installs',
      undefined,
      agency.business.id,
    );
    const installId = installs.json<{ items: { install: { id: string } }[] }>().items[0]?.install
      .id;
    const removed = await agency.asOwner(
      'DELETE',
      `/marketplace/installs/${String(installId)}`,
      undefined,
      agency.business.id,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await withToken(app, live.tokens.access_token, 'GET', '/tags')).statusCode).toBe(401);
    const refresh = await post(
      app,
      '/oauth/token',
      { grant_type: 'refresh_token', refresh_token: live.tokens.refresh_token },
      auth,
    );
    expect(refresh.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('stops while its business is suspended', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const { tokens } = await tokensFor(app, agency);
    await database.as('crm_owner', (sql) =>
      sql.query(`update tenancy.businesses set status = 'suspended' where id = $1`, [
        agency.business.id,
      ]),
    );
    expect((await withToken(app, tokens.access_token, 'GET', '/tags')).statusCode).toBe(401);
  });
});

describe('the token endpoint', () => {
  it('refuses a wrong verifier, redirect address or code, each as invalid_grant', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const auth = basic(agency.clientId, agency.clientSecret);
    const { verifier, challenge } = pkce();
    const code = await consent(agency, challenge);
    for (const form of [
      { code, redirect_uri: REDIRECT, code_verifier: pkce().verifier },
      { code, redirect_uri: 'https://sync.example/other', code_verifier: verifier },
      { code: `crm_ac_${'0'.repeat(64)}`, redirect_uri: REDIRECT, code_verifier: verifier },
      { code: 'not-a-code', redirect_uri: REDIRECT, code_verifier: verifier },
    ]) {
      const answer = await post(
        app,
        '/oauth/token',
        { grant_type: 'authorization_code', ...form },
        auth,
      );
      expect(answer.statusCode, JSON.stringify(form)).toBe(400);
      expect(answer.json()).toMatchObject({ error: 'invalid_grant' });
      expect(answer.headers['cache-control']).toBe('no-store');
    }
  });

  it('refuses a code that has expired', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const { verifier, challenge } = pkce();
    const code = await consent(agency, challenge);
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.marketplace_oauth_codes
            set created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
          where code_hash = $1`,
        [createHash('sha256').update(code).digest()],
      ),
    );
    const answer = await post(
      app,
      '/oauth/token',
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier },
      basic(agency.clientId, agency.clientSecret),
    );
    expect(answer.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('authenticates the client with Basic or the body, never both, and never another app', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const { verifier, challenge } = pkce();
    const code = await consent(agency, challenge);
    const grant = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    };

    const wrong = await post(app, '/oauth/token', grant, basic(agency.clientId, 'crm_cs_wrong'));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: 'invalid_client' });
    expect(wrong.headers['www-authenticate']).toBe('Basic realm="oauth"');

    const both = await post(
      app,
      '/oauth/token',
      { ...grant, client_secret: agency.clientSecret },
      basic(agency.clientId, agency.clientSecret),
    );
    expect(both.statusCode).toBe(400);
    expect(both.json()).toMatchObject({ error: 'invalid_request' });

    // Another agency's app can't spend this app's code.
    const another = await agencyWithApp(app);
    const stolen = await post(
      app,
      '/oauth/token',
      grant,
      basic(another.clientId, another.clientSecret),
    );
    expect(stolen.json()).toMatchObject({ error: 'invalid_grant' });

    const inBody = await post(app, '/oauth/token', {
      ...grant,
      client_id: agency.clientId,
      client_secret: agency.clientSecret,
    });
    expect(inBody.statusCode, inBody.body).toBe(200);
  });

  it('refuses what isn’t a form, a parameter sent twice, and other grant types', async () => {
    const app = await api();
    const agency = await agencyWithApp(app);
    const auth = basic(agency.clientId, agency.clientSecret);
    const json = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/json', authorization: auth },
      payload: { grant_type: 'refresh_token' },
    });
    expect(json.statusCode).toBe(415);
    expect(json.json()).toMatchObject({ error: 'invalid_request' });
    const twice = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: auth },
      payload: 'grant_type=refresh_token&grant_type=authorization_code',
    });
    expect(twice.statusCode).toBe(400);
    expect(twice.json()).toMatchObject({ error: 'invalid_request' });
    const password = await post(app, '/oauth/token', { grant_type: 'password' }, auth);
    expect(password.json()).toMatchObject({ error: 'unsupported_grant_type' });
    const none = await post(app, '/oauth/token', {}, auth);
    expect(none.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('describes itself at the well-known address (RFC 8414)', async () => {
    const app = await api();
    const answer = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      revocation_endpoint: `${PUBLIC_URL}/oauth/revoke`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
  });
});
