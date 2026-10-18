import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  defineEndpoint,
  internalServerProblem,
  me,
  permissions,
  PROBLEM_CONTENT_TYPE,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  getTwoFactorRequirement,
  setTwoFactorRequirement,
  renderEmailPreview,
  listTeam,
  listUsers,
  addUser,
  inviteMember,
  type Endpoint,
} from '@repo/contracts';
import openapi from '@repo/contracts/openapi.json' with { type: 'json' };
import { connectDatabase, type DB } from '@repo/db';
import { ContentTooLargeError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { Config } from './config.js';
import { loggerOptions } from './logger.js';
import {
  allowEveryone,
  type ApiRoute,
  type Route,
  type Services,
  type UploadBody,
} from '@repo/commands';
import {
  CLIENT_IP_HEADER,
  type ApiKeyAccess,
  type Authentication,
  type SignedIn,
} from '@repo/module-auth';
import { createFiles, type Files, type OpenedFile, type OpenResult } from '@repo/module-files';
import { localStorage } from '@repo/storage';
import { teamRoutes, userRoutes } from '@repo/module-tenancy';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { buildServer, type Server, type ServerOptions } from './server.js';

const signedIn = {
  agencyId: '01a11403-3ee7-7bb3-90d9-f58f45343f61',
  businessId: '01a11403-3ee7-7bb3-90d9-f58f45343f62',
  userId: '01a11403-3ee7-7bb3-90d9-f58f45343f63',
};

const config: Config = {
  nodeEnv: 'test',
  role: 'all',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  databaseAppUrl: 'postgres://crm_app@127.0.0.1:1/crm',
  databaseWorkerUrl: undefined,
  databasePoolSize: 1,
  shutdownTimeoutMs: 8000,
  dashboardDir: undefined,
  devTenantContext: signedIn,
  publicUrl: 'https://crm.example.test',
  authentication: undefined,
  mail: undefined,
  trustProxy: [],
  files: undefined,
  vault: undefined,
};

// The server tests leave roles to the stand-in workplace below, which allows everything:
// the permission matrix test checks who may do what.
const noRoles: SignedIn['roles'] = { agency: undefined, businesses: new Map() };
const everything = new Set(permissions);

// Dana, who works in one business; a newcomer with no membership yet; Sam, who works in
// two of the agency's businesses but isn't agency staff; and Alex, agency staff whose
// agency requires two-factor sign-in, which they haven't set up.
const dana: SignedIn = {
  agencyId: signedIn.agencyId,
  memberOf: [signedIn.businessId],
  userId: '01a11403-3ee7-7bb3-90d9-f58f45343f64',
  sessionId: 's1',
  agencyStaff: false,
  roles: noRoles,
  twoFactorEnabled: false,
  twoFactorRequired: false,
};
const sessions: Record<string, SignedIn> = {
  'crm.session_token=dana': dana,
  'crm.session_token=newcomer': {
    userId: '01a11403-3ee7-7bb3-90d9-f58f45343f65',
    sessionId: 's2',
    agencyId: undefined,
    memberOf: [],
    agencyStaff: false,
    roles: noRoles,
    twoFactorEnabled: false,
    twoFactorRequired: false,
  },
  'crm.session_token=sam': {
    userId: '01a11403-3ee7-7bb3-90d9-f58f45343f66',
    sessionId: 's3',
    agencyId: signedIn.agencyId,
    memberOf: [signedIn.businessId, '01a11403-3ee7-7bb3-90d9-f58f45343f68'],
    agencyStaff: false,
    roles: noRoles,
    twoFactorEnabled: false,
    twoFactorRequired: false,
  },
  'crm.session_token=alex': {
    userId: '01a11403-3ee7-7bb3-90d9-f58f45343f67',
    sessionId: 's4',
    agencyId: signedIn.agencyId,
    memberOf: [],
    agencyStaff: true,
    roles: noRoles,
    twoFactorEnabled: false,
    twoFactorRequired: true,
  },
};

/**
 * The rules in short: the auth module tests them for real. Agency staff work at the
 * agency or in any business; others in a business they belong to, or their only one.
 */
const workplaceOf: Authentication['workplace'] = (person, businessId) => {
  if (businessId === undefined) {
    if (person.agencyStaff) return Promise.resolve({ at: 'agency', permissions: everything });
    const [only] = person.memberOf;
    return Promise.resolve(
      only === undefined || person.memberOf.length > 1
        ? {
            at: 'refused',
            status: 403,
            code: 'choose_business',
            message: 'Choose a business first.',
          }
        : { at: 'business', businessId: only, permissions: everything },
    );
  }
  return Promise.resolve(
    person.agencyStaff || person.memberOf.includes(businessId)
      ? { at: 'business', businessId, permissions: everything }
      : {
          at: 'refused',
          status: 403,
          code: 'not_a_member',
          message: "You don't work in this business.",
        },
  );
};

function fakeAuthentication(
  handle: Authentication['handle'] = () => Promise.resolve(new Response()),
  workplace: Authentication['workplace'] = workplaceOf,
): Authentication {
  return {
    handle,
    signedIn: (headers) => Promise.resolve(sessions[headers.get('cookie') ?? '']),
    // API keys and app tokens are tested against the real module (api-keys.int.test.ts,
    // oauth.int.test.ts).
    apiKey: () => Promise.resolve(undefined),
    appToken: () => Promise.resolve(undefined),
    oauthToken: () =>
      Promise.resolve({
        outcome: 'refused',
        status: 401,
        error: 'invalid_client',
        description: 'The client id or secret is not valid.',
      }),
    oauthRevoke: () => Promise.resolve({ outcome: 'revoked' }),
    workplace,
    whoIs: (person) =>
      Promise.resolve({
        name: 'Dana Brooks',
        email: 'dana@harborlights.example',
        agency: { name: 'Bluebird Digital', slug: 'bluebird' },
        agencyStaff: person.agencyStaff,
        businesses: person.memberOf.map((id, index) => ({
          id,
          name: `Business ${String(index + 1)}`,
          slug: `business-${String(index + 1)}`,
          status: 'active' as const,
          city: 'Mombasa',
          region: null,
          timezone: 'America/New_York',
        })),
      }),
    createUser: () => Promise.reject(new Error('not used here')),
    idle: () => Promise.resolve(),
    firstAdminLink: () => Promise.resolve({ kind: 'admin_exists' }),
    sendInvitation: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

const logger = pino({ level: 'silent' });

// A pool that never connects: none of these tests reach the database.
const services: Services = {
  db: connectDatabase({
    connectionString: config.databaseAppUrl,
    onConnectionError: () => undefined,
  }),
  authorize: allowEveryone,
};

const createThing = defineEndpoint({
  operationId: 'createThing',
  method: 'post',
  path: '/things/{id}',
  summary: 'Create a thing',
  group: 'Things',
  response: { status: 201, description: 'Created', schema: z.object({ id: z.string() }) },
});

const removeThing = defineEndpoint({
  operationId: 'removeThing',
  method: 'delete',
  path: '/things/{id}',
  summary: 'Remove a thing',
  group: 'Things',
  response: { status: 204, description: 'Removed' },
});

function route<E extends Endpoint>(endpoint: E, run: Route<E>['run']): ApiRoute {
  return { endpoint, run };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});

async function start(overrides: Partial<ServerOptions> = {}): Promise<Server> {
  const server = await buildServer({
    config,
    logger,
    serveApi: true,
    routes: [],
    services,
    readinessChecks: {},
    ...overrides,
  });
  servers.push(server);
  return server;
}

describe('health and readiness', () => {
  it('answers /health while the process runs, with a request id', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is ready when every check passes, and names the ones that fail', async () => {
    const { app } = await start({
      readinessChecks: {
        database: () => Promise.resolve(),
        queue: () => Promise.reject(new Error('down')),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', failed: ['queue'] });

    const healthy = await start({ readinessChecks: { database: () => Promise.resolve() } });
    expect((await healthy.app.inject({ method: 'GET', url: '/ready' })).json()).toEqual({
      status: 'ready',
    });
  });
});

describe('the API', () => {
  it('runs a route with the raw input and the signed-in context', async () => {
    const run = vi.fn<Route<typeof createThing>['run']>((request) =>
      Promise.resolve({ id: (request.params as { id: string }).id }),
    );
    const { app } = await start({ routes: [route(createThing, run)] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things/abc?color=green',
      headers: { 'user-agent': 'test-agent' },
      payload: { name: 'Ada' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: 'abc' });
    const [request, given] = run.mock.calls[0] ?? [];
    expect(given).toBe(services);
    expect(request).toMatchObject({
      params: { id: 'abc' },
      query: { color: 'green' },
      body: { name: 'Ada' },
      invocation: {
        context: {
          ...signedIn,
          actorKind: 'user',
          actorId: signedIn.userId,
          correlationId: response.headers['x-request-id'],
        },
        ip: '127.0.0.1',
        userAgent: 'test-agent',
      },
    });
  });

  it('signs in agency staff with no business selected, and requests with no user agent', async () => {
    const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
    const { agencyId, userId } = signedIn;
    const { app } = await start({
      config: { ...config, devTenantContext: { agencyId, userId } },
      routes: [route(createThing, run)],
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    // fetch always sends a user agent; a raw request doesn't have to.
    const response = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${address}/api/v1/things/abc`, { method: 'POST' }, (reply) => {
        reply.resume();
        resolve(reply.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });

    expect(response).toBe(201);
    const invocation = run.mock.calls[0]?.[0].invocation;
    expect(invocation?.context).toEqual({
      agencyId,
      userId,
      actorKind: 'user',
      actorId: userId,
      correlationId: expect.any(String) as string,
    });
    expect(invocation).not.toHaveProperty('userAgent');
  });

  it('answers 204 with no body', async () => {
    const run = vi.fn(() => Promise.resolve(undefined));
    const { app } = await start({ routes: [route(removeThing, run)] });
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/things/abc' });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('refuses every API request until someone is signed in', async () => {
    const run = vi.fn();
    const { app } = await start({
      config: { ...config, devTenantContext: undefined },
      routes: [route(createThing, run)],
    });
    const response = await app.inject({ method: 'POST', url: '/api/v1/things/abc', payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toMatchObject({ status: 401, title: 'Unauthorized' });
    expect(run).not.toHaveBeenCalled();
  });

  it('serves the OpenAPI document without signing in', async () => {
    const { app } = await start({ config: { ...config, devTenantContext: undefined } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(openapi);
  });
});

describe('uploads', () => {
  const putFile = defineEndpoint({
    operationId: 'putFile',
    method: 'post',
    path: '/files',
    summary: 'Upload a file',
    group: 'Files',
    upload: { types: ['text/plain'] },
    response: { status: 201, description: 'Stored', schema: z.looseObject({}) },
  });

  /** A route that reads the whole upload and says what it got. */
  const echo = route(putFile, async ({ body }) => {
    const { stream, ...rest } = body as UploadBody;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return { ...rest, text: Buffer.concat(chunks).toString() };
  });

  it("hands an upload route the request's bytes unread, with their type and length", async () => {
    const { app } = await start({ routes: [echo] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      payload: 'hello',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      contentType: 'text/plain; charset=utf-8',
      contentLength: 5,
      text: 'hello',
    });
  });

  it('hands over an upload sent without a type, for the route to refuse', async () => {
    const { app } = await start({ routes: [echo] });

    const response = await app.inject({ method: 'POST', url: '/api/v1/files', payload: 'hi' });

    expect(response.json()).toEqual({ contentLength: 2, text: 'hi' });
  });

  it("closes the connection after refusing an upload, rather than read what's left of it", async () => {
    const tooLarge = route(putFile, () => Promise.reject(new ContentTooLargeError(4)));
    const { app } = await start({ routes: [tooLarge] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { 'content-type': 'text/plain' },
      payload: 'more than four bytes',
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers.connection).toBe('close');
    expect(response.json()).toMatchObject({
      title: 'Content Too Large',
      detail: 'Send at most 4 bytes.',
    });
  });

  it('still parses JSON for every other route', async () => {
    const created = route(createThing, ({ body }) => Promise.resolve({ id: JSON.stringify(body) }));
    const { app } = await start({ routes: [echo, created] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things/1',
      payload: { name: 'x' },
    });

    expect(response.json()).toEqual({ id: '{"name":"x"}' });
  });
});

describe('file links', () => {
  const opened: OpenResult[] = [];
  const calls: unknown[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'crm-server-files-'));
  const files: Files = {
    ...createFiles({
      storage: localStorage({ directory }),
      uploadDirectory: directory,
      maxBytes: 1024,
      linkSecret: 'a-files-link-secret-of-32-characters-or-more',
    }),
    open: (_db, request) => {
      calls.push(request);
      const next = opened.shift();
      return next === undefined
        ? Promise.reject(new Error('nothing to open'))
        : Promise.resolve(next);
    },
  };
  const file = (overrides: Partial<OpenedFile> = {}): OpenedFile => ({
    body: Readable.from([Buffer.from('hello')]),
    filename: 'notes ü (1).txt',
    contentType: 'text/plain',
    size: 5,
    inline: false,
    ...overrides,
  });

  it('serves the file a link opens, with headers that keep a browser from running it', async () => {
    opened.push(file());
    const { app } = await start({ files });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/files/file_01h455vb4pex5vsknk084sn02q/content?expires=1&signature=x',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('hello');
    expect(response.headers).toMatchObject({
      'content-type': 'text/plain',
      'content-length': '5',
      'content-disposition':
        'attachment; filename="notes _ (1).txt"; filename*=UTF-8\'\'notes%20%C3%BC%20%281%29.txt',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, no-store',
    });
    expect(calls.at(-1)).toMatchObject({
      fileId: 'file_01h455vb4pex5vsknk084sn02q',
      query: { expires: '1', signature: 'x' },
      correlationId: response.headers['x-request-id'],
    });
  });

  it('shows raster images inline', async () => {
    opened.push(file({ contentType: 'image/png', filename: 'logo.png', inline: true }));
    const { app } = await start({ files });

    const response = await app.inject({ method: 'GET', url: '/api/v1/files/f/content' });

    expect(response.headers['content-disposition']).toBe(
      'inline; filename="logo.png"; filename*=UTF-8\'\'logo.png',
    );
  });

  it('needs no session, since the link is the permission', async () => {
    opened.push(file());
    const { app } = await start({
      files,
      config: { ...config, devTenantContext: undefined },
      authentication: fakeAuthentication(),
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/files/f/content' });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    [{ refused: 'invalid' as const }, 403, "This link isn't valid."],
    [{ refused: 'expired' as const }, 403, 'This link has expired.'],
    [{ refused: 'not_found' as const }, 404, "There's no such file."],
  ])('answers a refused link (%o) with problem details', async (refusal, status, detail) => {
    opened.push(refusal);
    const { app } = await start({ files });

    const response = await app.inject({ method: 'GET', url: '/api/v1/files/f/content' });

    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toMatchObject({ status, detail });
  });

  it('has no download route without the files service, as in the worker role', async () => {
    const { app } = await start();

    const response = await app.inject({ method: 'GET', url: '/api/v1/files/f/content' });

    expect(response.statusCode).toBe(404);
  });
});

describe('signing in', () => {
  it("passes /api/auth to the authentication: the request as sent, with the client's IP", async () => {
    const handle = vi.fn<Authentication['handle']>(() =>
      Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: [
            ['content-type', 'application/json'],
            ['set-cookie', 'crm.session_token=dana; HttpOnly'],
            ['set-cookie', 'crm.session_data=x; HttpOnly'],
          ],
        }),
      ),
    );
    const { app } = await start({ authentication: fakeAuthentication(handle) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email?remember=1',
      headers: {
        'content-type': 'application/json',
        cookie: 'crm.session_token=old',
        [CLIENT_IP_HEADER]: '6.6.6.6',
      },
      payload: '{"email":"dana@example.com", "password":"secret"}',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers['set-cookie']).toEqual([
      'crm.session_token=dana; HttpOnly',
      'crm.session_data=x; HttpOnly',
    ]);
    const [request] = handle.mock.calls[0] ?? [];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://crm.example.test/api/auth/sign-in/email?remember=1');
    expect(request?.headers.get('cookie')).toBe('crm.session_token=old');
    // The client's own claim is dropped; the server's reckoning replaces it.
    expect(request?.headers.get(CLIENT_IP_HEADER)).toBe('127.0.0.1');
    expect(await request?.text()).toBe('{"email":"dana@example.com", "password":"secret"}');
  });

  it("reads the client's IP through the proxies it trusts, and through no others", async () => {
    const handle = vi.fn<Authentication['handle']>(() => Promise.resolve(new Response()));
    const forwarded = { 'x-forwarded-for': '198.51.100.9' };

    const behindProxy = await start({
      config: { ...config, trustProxy: ['127.0.0.1'] },
      authentication: fakeAuthentication(handle),
    });
    await behindProxy.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: forwarded,
    });
    const direct = await start({ authentication: fakeAuthentication(handle) });
    await direct.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: forwarded });

    expect(handle.mock.calls.map(([request]) => request.headers.get(CLIENT_IP_HEADER))).toEqual([
      '198.51.100.9',
      '127.0.0.1',
    ]);
  });

  // Through Traefik and Cloudflare, the sign-in limit counts the visitor.
  it("reads the client's IP from CF-Connecting-IP at a Cloudflare hop, and not from a direct peer", async () => {
    const handle = vi.fn<Authentication['handle']>(() => Promise.resolve(new Response()));
    const { app } = await start({
      config: { ...config, trustProxy: ['172.18.0.0/16', 'cloudflare'] },
      authentication: fakeAuthentication(handle),
    });
    const ask = (remoteAddress: string) =>
      app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
        remoteAddress,
        headers: {
          'x-forwarded-for': '203.0.113.5, 162.158.1.1',
          'cf-connecting-ip': '198.51.100.9',
        },
      });
    await ask('172.18.0.2');
    await ask('203.0.113.50');

    expect(handle.mock.calls.map(([request]) => request.headers.get(CLIENT_IP_HEADER))).toEqual([
      '198.51.100.9',
      '203.0.113.50',
    ]);
  });

  it('acts for the person the session cookie signs in, before any stub', async () => {
    const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
    const { app } = await start({
      authentication: fakeAuthentication(),
      routes: [route(createThing, run)],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things/abc',
      headers: { cookie: 'crm.session_token=dana', origin: 'https://crm.example.test' },
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    expect(run.mock.calls[0]?.[0].invocation.context).toEqual({
      agencyId: dana.agencyId,
      businessId: signedIn.businessId,
      userId: dana.userId,
      actorKind: 'user',
      actorId: dana.userId,
      correlationId: response.headers['x-request-id'],
    });
  });

  it('refuses a change from another site, or with no origin, but not a read', async () => {
    const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
    const { app } = await start({
      authentication: fakeAuthentication(),
      routes: [route(createThing, run)],
    });
    const cookie = 'crm.session_token=dana';

    const fromElsewhere = await app.inject({
      method: 'POST',
      url: '/api/v1/things/abc',
      headers: { cookie, origin: 'https://evil.example' },
      payload: {},
    });
    const withoutOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/things/abc',
      headers: { cookie },
      payload: {},
    });
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/no-such-thing',
      headers: { cookie },
    });

    expect(fromElsewhere.statusCode).toBe(403);
    expect(fromElsewhere.json()).toMatchObject({
      status: 403,
      detail: 'Changes are accepted only from https://crm.example.test.',
    });
    expect(withoutOrigin.statusCode).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect(read.statusCode).toBe(404);
  });

  it('refuses someone signed in who has no agency yet', async () => {
    const { app } = await start({
      config: { ...config, devTenantContext: undefined },
      authentication: fakeAuthentication(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/no-such-thing',
      headers: { cookie: 'crm.session_token=newcomer' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ detail: "You aren't a member of an agency yet." });
  });

  // The Business-Id header names the business a request works in.
  describe('the business a request works in', () => {
    const businessId = '01a11403-3ee7-7bb3-90d9-f58f45343f68';
    const header = toPublicId('business', businessId);

    async function contextFor(
      cookie: string,
      headers: Record<string, string>,
      workplace?: Authentication['workplace'],
    ) {
      const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
      const { app } = await start({
        config: { ...config, devTenantContext: undefined },
        authentication: fakeAuthentication(undefined, workplace),
        routes: [route(createThing, run)],
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/things/abc',
        headers: { cookie, origin: 'https://crm.example.test', ...headers },
        payload: {},
      });
      return { response, context: run.mock.calls[0]?.[0].invocation.context };
    }

    it('works in the business the header names, as the auth module allows', async () => {
      const workplace = vi.fn<Authentication['workplace']>(workplaceOf);

      const { context } = await contextFor(
        'crm.session_token=sam',
        { 'business-id': header },
        workplace,
      );

      expect(workplace.mock.calls[0]?.[1]).toBe(businessId);
      expect(context?.businessId).toBe(businessId);
    });

    it('works at the agency for agency staff who name no business', async () => {
      sessions['crm.session_token=staff'] = {
        ...dana,
        sessionId: 's5',
        memberOf: [],
        agencyStaff: true,
      };

      const { context } = await contextFor('crm.session_token=staff', {});

      expect(context).toBeDefined();
      expect(context).not.toHaveProperty('businessId');
    });

    it('answers what the auth module refuses with, and runs nothing', async () => {
      const { response, context } = await contextFor('crm.session_token=dana', {
        'business-id': header,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ detail: "You don't work in this business." });
      expect(context).toBeUndefined();
    });

    it.each([
      ['not a business id', 'tag_01h455vb4pex5vsknk084sn02q'],
      ['not an id at all', 'Harbor Lights'],
      ['two of them', `${header}, ${header}`],
    ])('answers a header that is %s as if there were no such business', async (_case, value) => {
      const workplace = vi.fn<Authentication['workplace']>(workplaceOf);

      const { response } = await contextFor(
        'crm.session_token=dana',
        { 'business-id': value },
        workplace,
      );

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ detail: "There's no such business." });
      expect(workplace).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/me', () => {
    it('says who is signed in, and where they may work, in the contract’s shape', async () => {
      const { app } = await start({
        config: { ...config, devTenantContext: undefined },
        authentication: fakeAuthentication(),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: 'crm.session_token=dana' },
      });

      expect(response.statusCode).toBe(200);
      expect(me.parse(response.json())).toEqual({
        user: { name: 'Dana Brooks', email: 'dana@harborlights.example' },
        agency: { name: 'Bluebird Digital', slug: 'bluebird' },
        agencyStaff: false,
        businesses: [
          {
            id: toPublicId('business', signedIn.businessId),
            name: 'Business 1',
            slug: 'business-1',
            status: 'active',
            // The town and region of its profile's address, as the reader gives them.
            city: 'Mombasa',
            region: null,
            // Its own zone, which its calendar is drawn in.
            timezone: 'America/New_York',
          },
        ],
        business: toPublicId('business', signedIn.businessId),
      });
    });

    it('says null for the business when the request works at the agency', async () => {
      sessions['crm.session_token=staff'] = {
        ...dana,
        sessionId: 's5',
        memberOf: [],
        agencyStaff: true,
      };
      const { app } = await start({
        config: { ...config, devTenantContext: undefined },
        authentication: fakeAuthentication(),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: 'crm.session_token=staff' },
      });

      expect(response.json()).toMatchObject({ agencyStaff: true, business: null });
    });

    it('answers someone in several businesses who has chosen none yet, so the switcher can offer them', async () => {
      const { app } = await start({
        config: { ...config, devTenantContext: undefined },
        authentication: fakeAuthentication(),
      });

      const answer = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: 'crm.session_token=sam' },
      });
      const elsewhere = await app.inject({
        method: 'GET',
        url: '/api/v1/no-such-thing',
        headers: { cookie: 'crm.session_token=sam' },
      });

      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({ business: null });
      expect(me.parse(answer.json()).businesses).toHaveLength(2);
      expect(elsewhere.statusCode).toBe(403);
    });

    it("still refuses /me for any other reason, such as a business they don't work in", async () => {
      const { app } = await start({
        config: { ...config, devTenantContext: undefined },
        authentication: fakeAuthentication(),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: {
          cookie: 'crm.session_token=dana',
          'business-id': toPublicId('business', '01a11403-3ee7-7bb3-90d9-f58f45343f68'),
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('is for people who signed in: the development stand-in has no one to describe', async () => {
      const { app } = await start({ authentication: fakeAuthentication() });

      const response = await app.inject({ method: 'GET', url: '/api/v1/me' });

      expect(response.statusCode).toBe(401);
    });
  });

  it('refuses someone with no business to act in who is not agency staff', async () => {
    // Without a business the context would be agency staff's, which sees every business in
    // the agency.
    const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
    const { app } = await start({
      config: { ...config, devTenantContext: undefined },
      authentication: fakeAuthentication(),
      routes: [route(createThing, run)],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things/abc',
      headers: { cookie: 'crm.session_token=sam', origin: 'https://crm.example.test' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ detail: 'Choose a business first.' });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses everything until someone whose agency requires two-factor sign-in sets it up', async () => {
    const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
    const { app } = await start({
      config: { ...config, devTenantContext: undefined },
      authentication: fakeAuthentication(),
      routes: [route(createThing, run)],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things/abc',
      headers: { cookie: 'crm.session_token=alex', origin: 'https://crm.example.test' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      detail: 'Set up two-factor sign-in first: your agency requires it.',
    });
    expect(run).not.toHaveBeenCalled();
  });

  describe('with an installed app’s access token', () => {
    const token = `crm_at_${'a'.repeat(64)}`;
    const access = {
      keyId: '01a11403-3ee7-7bb3-90d9-f58f45343f70',
      agencyId: '01a11403-3ee7-7bb3-90d9-f58f45343f73',
      businessId: '01a11403-3ee7-7bb3-90d9-f58f45343f71',
      readGroups: ['Tags'] as const,
      permissions: new Set(['tags.manage'] as const),
    };

    async function signedWith(headers: Record<string, string>) {
      const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
      const apiKey = vi.fn<Authentication['apiKey']>(() => Promise.resolve(undefined));
      const { app } = await start({
        config: { ...config, devTenantContext: undefined },
        authentication: {
          ...fakeAuthentication(),
          apiKey,
          appToken: (given, target) =>
            Promise.resolve(
              given === token &&
                (target?.businessId === undefined || target.businessId === access.businessId)
                ? access
                : undefined,
            ),
        },
        routes: [route(createThing, run)],
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/things/abc',
        headers,
        payload: {},
      });
      return { response, invocation: run.mock.calls[0]?.[0].invocation, apiKey };
    }

    it('acts as the install’s app key, and is never looked up as a key', async () => {
      const { response, invocation, apiKey } = await signedWith({
        authorization: `Bearer ${token}`,
      });
      expect(response.statusCode).toBe(201);
      expect(invocation?.context).toMatchObject({
        businessId: access.businessId,
        actorKind: 'api_key',
        actorId: access.keyId,
      });
      expect(apiKey).not.toHaveBeenCalled();
    });

    it('says when it no longer works, and that it works only in its own business', async () => {
      const expired = await signedWith({ authorization: `Bearer crm_at_${'b'.repeat(64)}` });
      expect(expired.response.statusCode).toBe(401);
      expect(expired.response.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
      expect(expired.response.json()).toMatchObject({
        detail: "That access token doesn't work: it may have expired, or the app was uninstalled.",
      });
      const other = await signedWith({
        authorization: `Bearer ${token}`,
        'business-id': toPublicId('business', '01a11403-3ee7-7bb3-90d9-f58f45343f72'),
      });
      expect(other.response.statusCode).toBe(403);
      expect(other.response.json()).toMatchObject({
        detail: 'This access token works only in the business that installed the app.',
      });
      expect(other.invocation).toBeUndefined();
    });
  });

  describe('with an API key', () => {
    const key = `crm_live_${'a'.repeat(64)}`;
    const access = {
      keyId: '01a11403-3ee7-7bb3-90d9-f58f45343f70',
      agencyId: '01a11403-3ee7-7bb3-90d9-f58f45343f73',
      businessId: '01a11403-3ee7-7bb3-90d9-f58f45343f71',
      permissions: new Set(['tags.manage'] as const),
    };

    async function signedWith(headers: Record<string, string>) {
      const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
      const { app } = await start({
        config: { ...config, devTenantContext: undefined },
        authentication: {
          ...fakeAuthentication(),
          apiKey: (given, target) =>
            Promise.resolve(
              given === key &&
                (target?.businessId === undefined || target.businessId === access.businessId) &&
                (target?.businessSlug === undefined || target.businessSlug === 'harbor-lights')
                ? access
                : undefined,
            ),
        },
        routes: [route(createThing, run)],
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/things/abc',
        headers,
        payload: {},
      });
      return { response, invocation: run.mock.calls[0]?.[0].invocation };
    }

    it('acts as the key, in its business, with its scopes, whatever the origin', async () => {
      const { response, invocation } = await signedWith({ authorization: `Bearer ${key}` });

      expect(response.statusCode).toBe(201);
      expect(invocation?.context).toEqual({
        agencyId: access.agencyId,
        businessId: access.businessId,
        actorKind: 'api_key',
        actorId: access.keyId,
        correlationId: response.headers['x-request-id'],
      });
      expect(invocation?.permissions).toEqual(new Set(['tags.manage']));
    });

    it.each([
      ['a key that does not work', `Bearer crm_live_${'b'.repeat(64)}`],
      ['another scheme', 'Basic dXNlcjpwYXNz'],
    ])('refuses %s, and says why in WWW-Authenticate', async (_case, authorization) => {
      const { response, invocation } = await signedWith({ authorization });

      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
      expect(invocation).toBeUndefined();
    });

    it('works only in its own business', async () => {
      const own = await signedWith({
        authorization: `Bearer ${key}`,
        'business-id': toPublicId('business', access.businessId),
      });
      const other = await signedWith({
        authorization: `Bearer ${key}`,
        'business-id': toPublicId('business', '01a11403-3ee7-7bb3-90d9-f58f45343f72'),
      });
      const malformed = await signedWith({ authorization: `Bearer ${key}`, 'business-id': 'x' });

      expect([own.response.statusCode, other.response.statusCode]).toEqual([201, 403]);
      expect(malformed.response.statusCode).toBe(403);
      expect(other.invocation).toBeUndefined();
    });

    it('resolves the own slug and refuses another slug rather than silently ignoring it', async () => {
      const own = await signedWith({
        authorization: `Bearer ${key}`,
        'business-slug': 'harbor-lights',
      });
      const sibling = await signedWith({
        authorization: `Bearer ${key}`,
        'business-slug': 'sibling',
      });
      expect(own.response.statusCode).toBe(201);
      expect(sibling.response.statusCode).toBe(403);
      expect(sibling.invocation).toBeUndefined();
    });

    it.each(['', 'Harbor-Lights', 'harbor lights', '-harbor', 'harbor-', 'a'.repeat(64)])(
      'refuses malformed slug %j after authenticating the key',
      async (slug) => {
        const result = await signedWith({ authorization: `Bearer ${key}`, 'business-slug': slug });
        expect(result.response.statusCode).toBe(403);
        expect(result.invocation).toBeUndefined();
      },
    );

    it('refuses conflicting selectors and preserves invalid-token precedence', async () => {
      const headers = {
        'business-id': toPublicId('business', access.businessId),
        'business-slug': 'harbor-lights',
      };
      expect(
        (await signedWith({ ...headers, authorization: `Bearer ${key}` })).response.statusCode,
      ).toBe(403);
      const invalid = await signedWith({ ...headers, authorization: 'Bearer invalid' });
      expect(invalid.response.statusCode).toBe(401);
      expect(invalid.invocation).toBeUndefined();
    });

    it.each(['foreign', 'suspended', 'closed', 'missing'])(
      'refuses a valid but unavailable target %s',
      async (slug) => {
        const result = await signedWith({ authorization: `Bearer ${key}`, 'business-slug': slug });
        expect(result.response.statusCode).toBe(403);
        expect(result.invocation).toBeUndefined();
      },
    );

    it('keeps an agency key at the agency and isolates simultaneous slug selections', async () => {
      const agency: ApiKeyAccess = {
        keyId: access.keyId,
        agencyId: access.agencyId,
        scope: 'agency',
        permissions: access.permissions,
      };
      const businessIds = {
        harbor: access.businessId,
        sibling: '01a11403-3ee7-7bb3-90d9-f58f45343f72',
      };
      const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
      const { app } = await start({
        authentication: {
          ...fakeAuthentication(),
          apiKey: async (given, target) => {
            if (given !== key) return undefined;
            // Give concurrent requests a chance to interleave their authentication.
            await Promise.resolve();
            if (target === undefined) return agency;
            const id = Object.entries(businessIds).find(
              ([slug, id]) => target.businessSlug === slug || target.businessId === id,
            )?.[1];
            return id === undefined ? undefined : { ...agency, businessId: id };
          },
        },
        routes: [route(createThing, run)],
      });
      const send = (slug?: string) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/things/abc',
          payload: {},
          headers: {
            authorization: `Bearer ${key}`,
            ...(slug === undefined ? {} : { 'business-slug': slug }),
          },
        });
      expect((await send()).statusCode).toBe(201);
      expect(run.mock.calls[0]?.[0].invocation.context).not.toHaveProperty('businessId');
      run.mockClear();
      const responses = await Promise.all([send('harbor'), send('sibling')]);
      expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
      expect(
        new Set(run.mock.calls.map(([request]) => request.invocation.context.businessId)),
      ).toEqual(new Set(Object.values(businessIds)));
      run.mockClear();
      await send();
      expect(run.mock.calls[0]?.[0].invocation.context).not.toHaveProperty('businessId');
    });

    it.each(['cookie', 'stub'])('refuses slug selection with %s authentication', async (kind) => {
      const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
      const { app } = await start({
        ...(kind === 'cookie' ? { authentication: fakeAuthentication() } : {}),
        routes: [route(createThing, run)],
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/things/abc',
        payload: {},
        headers: {
          'business-slug': 'harbor-lights',
          cookie: 'crm.session_token=dana',
          origin: config.publicUrl,
        },
      });
      expect(response.statusCode).toBe(403);
      expect(run).not.toHaveBeenCalled();
    });

    it('allows only the matching fixed Business-Id for the development stand-in', async () => {
      const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
      const { app } = await start({ routes: [route(createThing, run)] });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/things/abc',
        payload: {},
        headers: { 'business-id': toPublicId('business', signedIn.businessId) },
      });
      expect(response.statusCode).toBe(201);
      expect(run.mock.calls[0]?.[0].invocation.context.businessId).toBe(signedIn.businessId);
      run.mockClear();
      for (const businessId of [toPublicId('business', access.businessId), 'malformed', '']) {
        const refused = await app.inject({
          method: 'POST',
          url: '/api/v1/things/abc',
          payload: {},
          headers: { 'business-id': businessId },
        });
        expect(refused.statusCode).toBe(403);
      }
      expect(run).not.toHaveBeenCalled();
    });

    it('never falls back to the development stand-in for an unverifiable bearer token', async () => {
      const run = vi.fn<Route<typeof createThing>['run']>(() => Promise.resolve({ id: 'abc' }));
      const { app } = await start({ routes: [route(createThing, run)] });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/things/abc',
        payload: {},
        headers: { authorization: 'Bearer invalid', 'business-slug': 'INVALID SLUG' },
      });
      expect(response.statusCode).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });

    async function withPolicy(
      endpoint: Endpoint,
      policy: Partial<ApiKeyAccess>,
      headers: Record<string, string> = { authorization: `Bearer ${key}` },
    ) {
      const run = vi.fn<ApiRoute['run']>(() => Promise.resolve({ id: 'abc' }));
      const { app } = await start({
        authentication: {
          ...fakeAuthentication(),
          apiKey: (given) => Promise.resolve(given === key ? { ...access, ...policy } : undefined),
        },
        routes: [{ endpoint, run }],
      });
      const response = await app.inject({
        method: (
          { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE' } as const
        )[endpoint.method],
        url: `/api/v1${endpoint.path.replace('{id}', 'abc')}`,
        headers: {
          ...headers,
          ...(endpoint.upload === undefined ? {} : { 'content-type': 'application/octet-stream' }),
        },
        ...(endpoint.method === 'get'
          ? {}
          : { payload: endpoint.upload === undefined ? {} : Buffer.from('bytes') }),
      });
      return { response, run };
    }

    it.each([
      createThing,
      removeThing,
      defineEndpoint({ ...createThing, method: 'put' }),
      defineEndpoint({ ...createThing, method: 'patch' }),
      defineEndpoint({
        ...createThing,
        operationId: 'uploadThing',
        path: '/upload',
        upload: { types: ['application/octet-stream'] },
      }),
    ])('blocks a read-only mutation $operationId before the route runs', async (endpoint) => {
      const result = await withPolicy(endpoint, { readOnly: true });
      expect(result.response.statusCode).toBe(403);
      expect(result.run).not.toHaveBeenCalled();
    });

    const readContacts = defineEndpoint({
      ...createThing,
      operationId: 'readContacts',
      method: 'get',
      path: '/contacts',
      group: 'Contacts',
      response: { status: 200, description: 'Contacts' },
    });

    it('applies selected read groups without granting writes or restricting legacy reads', async () => {
      expect(
        (await withPolicy(readContacts, { readGroups: ['Contacts'], readOnly: true })).response
          .statusCode,
      ).toBe(200);
      const denied = await withPolicy(readContacts, { readGroups: ['Files'] });
      expect(denied.response.statusCode).toBe(403);
      expect(denied.run).not.toHaveBeenCalled();
      expect((await withPolicy(readContacts, { readGroups: [] })).response.statusCode).toBe(403);
      expect((await withPolicy(readContacts, { readGroups: null })).response.statusCode).toBe(200);
      const write = await withPolicy(createThing, { readGroups: ['Contacts'] });
      expect(write.response.statusCode).toBe(201);
      expect(write.run.mock.calls[0]?.[0].invocation.permissions).toEqual(new Set(['tags.manage']));
    });

    it.each([listTeam, listUsers])(
      'permits selected $group reads and retains their read-group restriction',
      async (endpoint) => {
        const readGroups = endpoint.group === 'Team' ? (['Team'] as const) : (['Users'] as const);
        const allowed = await withPolicy(endpoint, {
          readOnly: true,
          readGroups,
          permissions: new Set(),
        });
        expect(allowed.response.statusCode).toBe(200);
        expect(allowed.run).toHaveBeenCalledOnce();
        expect(allowed.run.mock.calls[0]?.[0].invocation.permissions).toEqual(new Set());
        const denied = await withPolicy(endpoint, { readGroups: ['Contacts'] });
        expect(denied.response.statusCode).toBe(403);
        expect(denied.run).not.toHaveBeenCalled();
      },
    );

    it.each([addUser, inviteMember])(
      'passes scoped $group writes to their route with exactly the native grants',
      async (endpoint) => {
        const allowed = await withPolicy(endpoint, {
          permissions: new Set(['team.manage']),
          readGroups: ['Contacts'],
        });
        expect(allowed.response.statusCode).toBe(201);
        expect(allowed.run.mock.calls[0]?.[0].invocation.permissions).toEqual(
          new Set(['team.manage']),
        );
        const denied = await withPolicy(endpoint, {
          readOnly: true,
          permissions: new Set(['team.manage']),
        });
        expect(denied.response.statusCode).toBe(403);
        expect(denied.run).not.toHaveBeenCalled();
      },
    );

    it.each([
      { endpoint: addUser, command: 'team.add_user', grant: false },
      { endpoint: addUser, command: 'team.add_user', grant: true },
      { endpoint: inviteMember, command: 'team.invite', grant: false },
      { endpoint: inviteMember, command: 'team.invite', grant: true },
    ])(
      'keeps native $command authorization for a key (team.manage: $grant)',
      async ({ endpoint, command, grant }) => {
        // Installed Kysely's DummyDriver executes only in memory. Native command refusals
        // can audit without connecting to Postgres or reaching a mutation handler.
        const db = new Kysely<DB>({
          dialect: {
            createDriver: () => new DummyDriver(),
            createAdapter: () => new PostgresAdapter(),
            createIntrospector: (database) => new PostgresIntrospector(database),
            createQueryCompiler: () => new PostgresQueryCompiler(),
          },
        });
        const authorize = vi.fn<Services['authorize']>(() => false);
        const sendInvitation = vi.fn(() => Promise.resolve(true));
        const options: Parameters<typeof userRoutes>[0] = {
          people: () => Promise.resolve(new Map()),
          checkAvatar: () => Promise.resolve(),
          sendInvitation,
        };
        const native = [...teamRoutes(options), ...userRoutes(options)].find(
          (route) => route.endpoint.operationId === endpoint.operationId,
        );
        if (native === undefined) throw new Error('The native team route must be registered.');
        const scopes = grant
          ? new Set(['team.manage'] as const)
          : new Set(['tags.manage'] as const);
        try {
          const { app } = await start({
            authentication: {
              ...fakeAuthentication(),
              apiKey: () => Promise.resolve({ ...access, permissions: scopes }),
            },
            services: { db, authorize },
            routes: [native],
          });
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1${endpoint.path}`,
            headers: { authorization: `Bearer ${key}` },
            payload: {
              email: 'bot-invite@example.test',
              ...(endpoint.operationId === 'addUser'
                ? { firstName: 'Bot', lastName: 'Invite' }
                : {}),
              roleId: toPublicId('role', '01a11403-3ee7-7bb3-90d9-f58f45343f72'),
            },
          });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({
            detail: grant
              ? "You don't have permission to do this."
              : "Your role doesn't allow this: it needs team.manage.",
          });
          if (grant) {
            expect(authorize).toHaveBeenCalledOnce();
            expect(authorize.mock.calls[0]?.[0]).toMatchObject({
              permissions: scopes,
              context: { actorKind: 'api_key', actorId: access.keyId },
            });
            expect(authorize.mock.calls[0]?.[1]).toBe(command);
          } else expect(authorize).not.toHaveBeenCalled();
          expect(sendInvitation).not.toHaveBeenCalled();
        } finally {
          await db.destroy();
        }
      },
    );

    it('allows only the explicit read-only preview POST and applies its read group', async () => {
      const allowed = await withPolicy(renderEmailPreview, {
        readOnly: true,
        readGroups: ['Message templates'],
      });
      expect(allowed.response.statusCode).toBe(200);
      expect(allowed.run).toHaveBeenCalledOnce();
      const denied = await withPolicy(renderEmailPreview, {
        readOnly: true,
        readGroups: ['Contacts'],
      });
      expect(denied.response.statusCode).toBe(403);
      expect(denied.run).not.toHaveBeenCalled();
    });

    it.each([createApiKey, revokeApiKey, getTwoFactorRequirement, setTwoFactorRequirement])(
      'refuses key/security endpoint $operationId even with unrestricted key policy',
      async (endpoint) => {
        const result = await withPolicy(endpoint, { permissions: everything });
        expect(result.response.statusCode).toBe(403);
        expect(result.run).not.toHaveBeenCalled();
      },
    );

    it('preserves redacted key metadata reads while enforcing the selected read group', async () => {
      const allowed = await withPolicy(listApiKeys, { readOnly: true, readGroups: ['API keys'] });
      expect(allowed.response.statusCode).toBe(200);
      expect(allowed.run).toHaveBeenCalledOnce();
      const denied = await withPolicy(listApiKeys, { readGroups: ['Contacts'] });
      expect(denied.response.statusCode).toBe(403);
      expect(denied.run).not.toHaveBeenCalled();
    });

    it('refuses even non-command credential mutations with the established apps.manage permission error', async () => {
      const endpoint = defineEndpoint({ ...createApiKey, operationId: 'rotateApiKey' });
      const refused = await withPolicy(endpoint, { permissions: everything });
      expect(refused.response.statusCode).toBe(403);
      expect(refused.response.json()).toMatchObject({ permission: 'apps.manage' });
      expect(refused.run).not.toHaveBeenCalled();
    });

    const keyContext = defineEndpoint({
      operationId: 'getApiKeyContext',
      method: 'get',
      path: '/integration/context',
      group: 'Account',
      summary: 'Read the key identity',
      response: { status: 200, description: 'Key identity' },
    });

    it('exempts minimal key context from read groups and requires key identity', async () => {
      expect(
        (await withPolicy(keyContext, { readOnly: true, readGroups: [] })).response.statusCode,
      ).toBe(200);
      const person = await withPolicy(keyContext, {}, { cookie: 'crm.session_token=dana' });
      expect(person.response.statusCode).toBe(403);
      expect(person.run).not.toHaveBeenCalled();
    });

    it.each([
      'Account',
      'AI',
      'Assistant',
      'Assistant conversations',
      'Audit log',
      'Views',
      'Notifications',
    ])('refuses personal %s reads even with unrestricted key policy', async (group) => {
      const endpoint = defineEndpoint({
        ...readContacts,
        operationId: 'readPersonalState',
        path: '/personal',
        group,
      });
      const result = await withPolicy(endpoint, { permissions: everything });
      expect(result.response.statusCode).toBe(403);
      expect(result.run).not.toHaveBeenCalled();
    });
  });

  it("signs nobody in with a cookie it doesn't know", async () => {
    const { app } = await start({
      config: { ...config, devTenantContext: undefined },
      authentication: fakeAuthentication(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/no-such-thing',
      headers: { cookie: 'crm.session_token=forged' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('errors', () => {
  async function failWith(
    error: unknown,
  ): Promise<{ status: number; body: unknown; type: string }> {
    const { app } = await start({
      routes: [route(createThing, () => Promise.reject(error as Error))],
    });
    const response = await app.inject({ method: 'POST', url: '/api/v1/things/abc', payload: {} });
    return {
      status: response.statusCode,
      body: response.json(),
      type: String(response.headers['content-type']),
    };
  }

  it('turns the errors callers can act on into problem details', async () => {
    const missing = await failWith(new NotFoundError('thing', 'abc'));
    expect(missing.status).toBe(404);
    expect(missing.type).toContain(PROBLEM_CONTENT_TYPE);
    expect(missing.body).toMatchObject({ type: 'about:blank', title: 'Not Found', status: 404 });

    const invalid = await failWith(
      new ValidationError([{ path: '/name', code: 'too_small', message: 'Name is required.' }]),
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({
      errors: [{ path: '/name', code: 'too_small', message: 'Name is required.' }],
    });
  });

  it('hides everything else behind a 500', async () => {
    const failure = await failWith(new Error('connection to 10.0.0.5 refused: password=hunter2'));
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual(internalServerProblem);
  });

  it('hides server errors that carry their own status, too', async () => {
    const upstream = Object.assign(new Error('upstream at 10.0.0.5 failed'), { statusCode: 503 });
    const failure = await failWith(upstream);
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual(internalServerProblem);

    expect((await failWith('a string, not an Error')).body).toEqual(internalServerProblem);
  });

  it("explains Fastify's own refusals, such as malformed JSON", async () => {
    const { app } = await start({ routes: [route(createThing, vi.fn())] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/things/abc',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ title: 'Bad Request', status: 400 });
  });

  it('answers an unknown API path with problem details', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/api/v1/nothing-here' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  });
});

describe('the worker role', () => {
  it('mounts an explicitly supplied voice callback handler without exposing the API', async () => {
    const handle = vi.fn().mockResolvedValue({
      statusCode: 200,
      contentType: 'application/xml',
      body: '<Response/>',
    });
    const { app } = await start({ serveApi: false, voiceWebhooks: { handle } });
    const result = await app.inject({
      method: 'POST',
      url: `/webhooks/twilio/voice/${'a'.repeat(43)}/inbound`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'synthetic',
      },
      payload: 'CallSid=synthetic',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('<Response/>');
    expect(handle).toHaveBeenCalledOnce();
    expect((await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).statusCode).toBe(404);
  });
  it('serves only health and readiness', async () => {
    const { app } = await start({ serveApi: false, routes: [route(createThing, vi.fn())] });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const api = await app.inject({ method: 'POST', url: '/api/v1/things/abc', payload: {} });
    expect(api.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).statusCode).toBe(404);
  });
});

describe('the dashboard', () => {
  function dashboard(): string {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>CRM</title>');
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'index-a1b2c3.js'), 'console.log(1)');
    return root;
  }

  it('caches hashed assets for good, and never caches the page', async () => {
    const { app } = await start({ config: { ...config, dashboardDir: dashboard() } });

    const asset = await app.inject({ method: 'GET', url: '/assets/index-a1b2c3.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const page = await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { accept: 'text/html' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>CRM</title>');
    expect(page.headers['cache-control']).toBe('no-cache');
    // Another site may not put the app's page in a frame of its own.
    expect(page.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(page.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('lets any website frame a calendar’s booking page, and no other page', async () => {
    const { app } = await start({ config: { ...config, dashboardDir: dashboard() } });
    for (const url of [
      '/book/bluebird/harbor/tours',
      '/book/bluebird/harbor/tours/',
      '/book/bluebird/harbor/tours?utm_source=site',
    ]) {
      const page = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      expect(page.statusCode, url).toBe(200);
      expect(page.body, url).toContain('<title>CRM</title>');
      // Its address names the business, so it is kept by nobody (sensitive-paths.ts).
      expect(page.headers['cache-control'], url).toBe('no-store');
      expect(page.headers['content-security-policy'], url).toBe('frame-ancestors *');
      // No X-Frame-Options: it has no value for "any site", and frame-ancestors overrides it.
      expect(page.headers['x-frame-options'], url).toBeUndefined();
    }
    // Every other page of the app stays the install's own, near misses included.
    for (const url of [
      '/',
      '/sign-in',
      '/b/harbor/settings/calendars',
      '/book/bluebird/harbor',
      '/book/bluebird/harbor/tours/more',
      '/booking/bluebird/harbor/tours',
      '/x/book/bluebird/harbor/tours',
      `/appointments/manage/${'A'.repeat(40)}.${'B'.repeat(22)}`,
    ]) {
      const page = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      expect(page.statusCode, url).toBe(200);
      expect(page.headers['content-security-policy'], url).toBe("frame-ancestors 'self'");
      expect(page.headers['x-frame-options'], url).toBe('SAMEORIGIN');
    }
    // The page by its file name is the dashboard's, whatever page it would become.
    const named = await app.inject({ method: 'GET', url: '/index.html' });
    expect(named.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('lets only a file with a hash in its name be kept for good: the page by name is asked about', async () => {
    const root = dashboard();
    writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const { app } = await start({ config: { ...config, dashboardDir: root } });
    // The page asked for by its file name is the page: a release must show on the next load.
    for (const url of ['/index.html', '/favicon.svg']) {
      const named = await app.inject({ method: 'GET', url });
      expect(named.statusCode, url).toBe(200);
      expect(named.headers['cache-control'], url).toBe('no-cache');
      // The page by name is the page: not framed elsewhere either. A picture carries no such rule.
      expect(named.headers['content-security-policy'], url).toBe(
        url.endsWith('.html') ? "frame-ancestors 'self'" : undefined,
      );
      // Still validated, so asking costs no bytes when nothing changed.
      expect(named.headers.etag ?? named.headers['last-modified'], url).toBeDefined();
    }
    const asset = await app.inject({ method: 'GET', url: '/assets/index-a1b2c3.js' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    // A name that only looks like the folder is not in it.
    writeFileSync(join(root, 'assets.txt'), 'not hashed');
    expect((await app.inject({ method: 'GET', url: '/assets.txt' })).headers['cache-control']).toBe(
      'no-cache',
    );
  });

  it('never lets the page of an appointment’s own link be stored, and keeps its token out of the log', async () => {
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    const { app } = await start({
      config: { ...config, dashboardDir: dashboard() },
      logger: pino(loggerOptions({ ...config, logLevel: 'info' }), stream),
    });
    const token = `${'A'.repeat(40)}.${'B'.repeat(22)}`;
    const page = await app.inject({
      method: 'GET',
      url: `/appointments/manage/${token}`,
      headers: { accept: 'text/html' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>CRM</title>');
    // The token is the whole permission: the page it opens is kept by nobody.
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(logs.join('')).not.toContain(token);
    expect(logs.join('')).toContain('/appointments/manage/[redacted]');
    // Any other page of the dashboard is asked about, as before.
    const inbox = await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { accept: 'text/html' },
    });
    expect(inbox.headers['cache-control']).toBe('no-cache');
  });

  it('serves the page at the site root, where the app opens', async () => {
    const { app } = await start({ config: { ...config, dashboardDir: dashboard() } });

    const page = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>CRM</title>');
    expect(page.headers['cache-control']).toBe('no-cache');

    const notPage = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'application/json' },
    });
    expect(notPage.statusCode).toBe(404);
    expect(notPage.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  });

  it("doesn't answer API calls or non-page requests with the page", async () => {
    const { app } = await start({ config: { ...config, dashboardDir: dashboard() } });
    const missing = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { accept: 'application/json' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const api = await app.inject({
      method: 'GET',
      url: '/api/v1/nope',
      headers: { accept: 'text/html' },
    });
    expect(api.statusCode).toBe(404);
    const noAccept = await app.inject({ method: 'GET', url: '/nope' });
    expect(noAccept.statusCode).toBe(404);
    const post = await app.inject({
      method: 'POST',
      url: '/nope',
      headers: { accept: 'text/html' },
    });
    expect(post.statusCode).toBe(404);
  });

  it('has no page to serve without a dashboard folder', async () => {
    const { app } = await start();
    const page = await app.inject({
      method: 'GET',
      url: '/inbox',
      headers: { accept: 'text/html' },
    });
    expect(page.statusCode).toBe(404);
  });
});

describe('shutdown', () => {
  async function listening(
    run: Route<typeof createThing>['run'],
  ): Promise<{ server: Server; url: string }> {
    const server = await buildServer({
      config,
      logger,
      serveApi: true,
      routes: [route(createThing, run)],
      services,
      readinessChecks: {},
    });
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    return { server, url: `${address}/api/v1/things/abc` };
  }

  it('finishes requests in flight, then closes every connection at once', async () => {
    const { server, url } = await listening(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { id: 'abc' };
    });
    // A request beforehand leaves an idle keep-alive connection behind.
    await fetch(url, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });

    const inFlight = fetch(url, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const began = performance.now();
    const closed = server.close(8000);

    const response = await inFlight;
    expect(response.status).toBe(201);
    expect(response.headers.get('connection')).toBe('close');
    await closed;
    // Not Fastify's 72-second keep-alive timeout.
    expect(performance.now() - began).toBeLessThan(2000);
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('closes whatever is left when the deadline passes', async () => {
    const { server, url } = await listening(() => new Promise<never>(() => undefined));
    const stuck = fetch(url, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const began = performance.now();
    await server.close(300);
    expect(performance.now() - began).toBeLessThan(1500);
    await expect(stuck).rejects.toThrow();
  });
});
