// API keys over HTTP: an app signs in with one, and does only what its scopes allow, in its
// own business, until it's revoked.
import { allowEveryone } from '@repo/commands';
import {
  createdApiKey,
  apiKeyList,
  apiKeyContext,
  listBusinesses,
  eventChain,
  tag,
  tagConfiguration,
  recordTagList,
  userDetail,
  type CreateApiKeyInput,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { createAuthentication, type Authentication } from '@repo/module-auth';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import { API_PREFIX, buildServer, type Server } from './server.js';

const PUBLIC_URL = 'https://crm.example.test';
const PASSWORD = 'correct horse battery staple';

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
    routes: apiRoutes(authentication),
    services: { db, authorize: allowEveryone },
    authentication,
    files: undefined,
    readinessChecks: {},
  });
  servers.push(server);
  return server.app;
}

type App = Awaited<ReturnType<typeof api>>;

let people = 0;
/** A business, and its owner signed in: someone who may manage its keys. */
async function businessWithOwner(app: App, agencyWide = false) {
  const agency = await database.fixtures.agency();
  const number = ++people;
  const businessSlug = `key-http-${String(number)}`;
  const business = await database.fixtures.business(agency.id, { slug: businessSlug });
  const email = `owner-${String(number)}@harborlights.example`;
  const { id: userId } = await authentication.createUser({
    email,
    name: 'Dana Brooks',
    password: PASSWORD,
    emailVerified: true,
  });
  await database.as('crm_owner', async (sql) => {
    const { id: roleId } = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       values ($1, $2, 'owner', 'Owner', true) returning id`,
      [agency.id, agencyWide ? 'agency' : 'business'],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, $3, $4)`,
      [userId, agency.id, agencyWide ? null : business.id, roleId],
    );
  });
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
    payload: { email, password: PASSWORD },
    remoteAddress: `198.51.100.${String(people)}`,
  });
  expect(signIn.statusCode).toBe(200);
  const setCookie = signIn.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((each) => each.split(';')[0] ?? '')
    .join('; ');
  const asOwner = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) =>
    app.inject({
      method,
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: PUBLIC_URL },
      ...(payload === undefined ? {} : { payload }),
    });
  return { agency, business, businessSlug, asOwner };
}

/** A request signed with a key, from an app: no cookie, no origin. */
const withKey = (
  app: App,
  key: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: { payload?: object; business?: string; businessSlug?: string } = {},
) =>
  app.inject({
    method,
    url: `${API_PREFIX}${path}`,
    headers: {
      authorization: `Bearer ${key}`,
      ...(options.business === undefined
        ? {}
        : { 'business-id': toPublicId('business', options.business) }),
      ...(options.businessSlug === undefined ? {} : { 'business-slug': options.businessSlug }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });

async function keyFor(
  owner: Awaited<ReturnType<typeof businessWithOwner>>,
  scopes: readonly string[],
  policy: Pick<CreateApiKeyInput, 'readOnly' | 'readGroups' | 'expiresAt'> = {},
) {
  const made = await owner.asOwner('POST', '/api-keys', { name: 'Zapier', scopes, ...policy });
  expect(made.statusCode).toBe(201);
  return createdApiKey.parse(made.json());
}

describe('an API key', () => {
  it('binds a restricted read-only credential without a business ID and refuses writes or unselected reads', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, [], { readOnly: true, readGroups: ['Tags'] });
    expect((await withKey(app, made.key, 'GET', '/tags')).statusCode).toBe(200);
    expect((await withKey(app, made.key, 'GET', '/contacts')).statusCode).toBe(403);
    expect(
      (await withKey(app, made.key, 'POST', '/tags', { payload: { name: 'Refused' } })).statusCode,
    ).toBe(403);
    const self = await withKey(app, made.key, 'GET', '/integration/context');
    expect(self.statusCode, self.body).toBe(200);
    expect(apiKeyContext.parse(self.json())).toMatchObject({
      scope: 'business',
      business: { id: toPublicId('business', owner.business.id) },
      scopes: [],
      readOnly: true,
      readGroups: ['Tags'],
    });
    expect(self.body).not.toContain(made.key);
    const denied = await owner.asOwner('GET', '/integration/context');
    expect(denied.statusCode).toBe(403);
  });

  it('preserves legacy key metadata reads without recovering any credential', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, ['tags.manage']);
    const response = await withKey(app, made.key, 'GET', '/api-keys');
    expect(response.statusCode, response.body).toBe(200);
    expect(apiKeyList.parse(response.json())).toMatchObject({
      canManage: false,
      items: [{ id: made.id, prefix: made.prefix }],
    });
    expect(response.body).not.toContain(made.key);
  });

  it('uses agency discovery and concurrent per-call slugs without switching the key default', async () => {
    const app = await api();
    const owner = await businessWithOwner(app, true);
    const siblingSlug = `sibling-${String(people)}`;
    const sibling = await database.fixtures.business(owner.agency.id, { slug: siblingSlug });
    const foreign = await businessWithOwner(app);
    const limited = await keyFor(owner, ['tags.manage'], { readGroups: ['Tags', 'Businesses'] });
    const refusedDefinition = await withKey(app, limited.key, 'POST', '/tags', {
      businessSlug: owner.businessSlug,
      payload: { name: 'Missing configuration grant' },
    });
    expect(refusedDefinition.statusCode).toBe(403);
    expect(refusedDefinition.json()).toMatchObject({ permission: 'tags.configure' });
    const made = await keyFor(owner, ['tags.manage', 'tags.configure'], {
      readGroups: ['Tags', 'Businesses'],
    });
    const defaultContext = await withKey(app, made.key, 'GET', '/integration/context');
    expect(defaultContext.statusCode).toBe(200);
    expect(apiKeyContext.parse(defaultContext.json())).toMatchObject({
      scope: 'agency',
      business: null,
    });
    const discovery = await withKey(app, made.key, 'GET', '/integration/businesses');
    expect(discovery.statusCode, discovery.body).toBe(200);
    const found = listBusinesses.response.schema.parse(discovery.json());
    expect(found.items.map((item) => item.id).sort()).toEqual(
      [owner.business.id, sibling.id].map((id) => toPublicId('business', id)).sort(),
    );
    const tags = await Promise.all([
      withKey(app, made.key, 'POST', '/tags', {
        businessSlug: owner.businessSlug,
        payload: { name: 'Agency first' },
      }),
      withKey(app, made.key, 'POST', '/tags', {
        businessSlug: siblingSlug,
        payload: { name: 'Agency second' },
      }),
    ]);
    expect(
      tags.map((response) => response.statusCode),
      tags.map((response) => response.body).join('\n'),
    ).toEqual([201, 201]);
    const scoped = await Promise.all([
      withKey(app, made.key, 'GET', '/tags', { businessSlug: owner.businessSlug }),
      withKey(app, made.key, 'GET', '/tags', { business: sibling.id }),
    ]);
    expect(scoped.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(scoped[0].body).toContain('Agency first');
    expect(scoped[0].body).not.toContain('Agency second');
    expect(scoped[1].body).toContain('Agency second');
    expect(scoped[1].body).not.toContain('Agency first');
    expect(
      (await withKey(app, made.key, 'GET', '/tags', { businessSlug: foreign.businessSlug }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await withKey(app, made.key, 'GET', '/tags', {
          business: sibling.id,
          businessSlug: owner.businessSlug,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      apiKeyContext.parse((await withKey(app, made.key, 'GET', '/integration/context')).json())
        .business,
    ).toBeNull();
  });

  it('makes expiry effective at authentication and never widens a suspended account target', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, ['tags.manage'], {
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(
      (await withKey(app, made.key, 'GET', '/tags', { businessSlug: owner.businessSlug }))
        .statusCode,
    ).toBe(200);
    await database.as('crm_owner', (sql) =>
      sql.query("update tenancy.api_keys set expires_at=now()-interval '1 second' where id=$1", [
        parsePublicId('api_key', made.id),
      ]),
    );
    expect((await withKey(app, made.key, 'GET', '/tags')).statusCode).toBe(401);
    const other = await keyFor(owner, ['tags.manage']);
    await database.as('crm_owner', (sql) =>
      sql.query("update tenancy.businesses set status='suspended' where id=$1", [
        owner.business.id,
      ]),
    );
    expect(
      (await withKey(app, other.key, 'GET', '/tags', { businessSlug: owner.businessSlug }))
        .statusCode,
    ).toBe(401);
  });

  it('adds a synthetic user using a real member role and native team grant without sending external email', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const role = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        "insert into tenancy.roles (agency_id,scope,key,name,is_builtin) values ($1,'business','member','Member',true) returning id",
        [owner.agency.id],
      ),
    );
    const made = await keyFor(owner, ['team.manage'], { readGroups: ['Users'] });
    const response = await withKey(app, made.key, 'POST', '/users', {
      payload: {
        firstName: 'Demo',
        lastName: 'Member',
        email: `demo-${String(people)}@client.example`,
        roleId: toPublicId('role', role.id),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(userDetail.parse(response.json())).toMatchObject({
      status: 'invited',
      roleId: toPublicId('role', role.id),
      deliveryFailed: false,
    });
  });
  it('does what its scopes allow, in its business, as the key, which activity names', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, ['tags.manage', 'tags.configure']);

    const created = await withKey(app, made.key, 'POST', '/tags', {
      payload: { name: 'From Zapier' },
    });
    const listed = await withKey(app, made.key, 'GET', '/tags');

    expect(created.statusCode).toBe(201);
    expect(listed.json()).toMatchObject({ items: [{ name: 'From Zapier' }] });
    const [event] = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string; actor_kind: string; actor_id: string; business_id: string }>(
        `select id, actor_kind, actor_id, business_id from events.events
         where type = 'tag.created' and subject_id = $1`,
        [parsePublicId('tag', tag.parse(created.json()).id)],
      ),
    );
    expect(event).toMatchObject({
      actor_kind: 'api_key',
      actor_id: parsePublicId('api_key', made.id),
      business_id: owner.business.id,
    });
    const why = await withKey(
      app,
      made.key,
      'GET',
      `/events/${toPublicId('event', event?.id ?? '')}/why`,
    );
    expect(eventChain.parse(why.json()).items[0]?.actor).toEqual({
      kind: 'api_key',
      name: 'Zapier',
      you: false,
    });
  });

  it('enforces the creation rule for a daily-work key, even though it may manage assignments', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, ['tags.manage']);
    const refused = await withKey(app, made.key, 'POST', '/tags', {
      payload: { name: 'Not yet allowed' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ permission: 'tags.configure' });
    const config = tagConfiguration.parse(
      (await owner.asOwner('GET', '/tag-configuration')).json(),
    );
    const updated = await owner.asOwner('PUT', '/tag-rules', {
      ...config.rules,
      creation: 'everyone',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const allowed = await withKey(app, made.key, 'POST', '/tags', {
      payload: { name: 'Explicitly allowed' },
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it('lets a daily-work key apply and remove an existing tag under the admin creation rule', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, ['tags.manage']);
    const existing = tag.parse(
      (await owner.asOwner('POST', '/tags', { name: 'Existing VIP' })).json(),
    );
    const contact = await database.fixtures.contact(owner.business.context);
    const id = toPublicId('contact', contact.id);
    const applied = await withKey(app, made.key, 'PUT', `/records/${id}/tags/${existing.id}`, {
      payload: {},
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const listed = recordTagList.parse(
      (await withKey(app, made.key, 'GET', `/records/${id}/tags`)).json(),
    );
    expect(listed).toMatchObject({
      canManage: true,
      items: [{ tag: { id: existing.id }, source: { kind: 'api_key', you: false } }],
    });
    expect(
      (await withKey(app, made.key, 'DELETE', `/records/${id}/tags/${existing.id}`)).statusCode,
    ).toBe(204);
    expect(
      recordTagList.parse((await withKey(app, made.key, 'GET', `/records/${id}/tags`)).json())
        .items,
    ).toEqual([]);
  });

  it("can't do what its scopes leave out, or make keys", async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, ['files.upload']);

    const tagging = await withKey(app, made.key, 'POST', '/tags', { payload: { name: 'Nope' } });
    const keying = await withKey(app, made.key, 'POST', '/api-keys', {
      payload: { name: 'Another', scopes: ['files.upload'] },
    });

    expect([tagging.statusCode, keying.statusCode]).toEqual([403, 403]);
    expect([tagging.json(), keying.json()]).toMatchObject([
      { permission: 'tags.manage' },
      { permission: 'apps.manage' },
    ]);
  });

  it('works only in its own business', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const other = await businessWithOwner(app);
    const made = await keyFor(owner, ['tags.manage']);

    const elsewhere = await withKey(app, made.key, 'GET', '/tags', { business: other.business.id });
    const named = await withKey(app, made.key, 'GET', '/tags', { business: owner.business.id });

    expect(elsewhere.statusCode).toBe(403);
    expect(named.statusCode).toBe(200);
  });

  it('fails on the request after it is revoked', async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, ['tags.manage']);
    expect((await withKey(app, made.key, 'GET', '/tags')).statusCode).toBe(200);

    const revoked = await owner.asOwner('DELETE', `/api-keys/${made.id}`);
    const after = await withKey(app, made.key, 'GET', '/tags');

    expect(revoked.statusCode).toBe(204);
    expect(after.statusCode).toBe(401);
    expect(after.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
  });

  it.each([
    ['a key nobody made', `Bearer crm_live_${'0'.repeat(64)}`],
    ['something that is no key', 'Bearer not-a-key'],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
  ])('is refused when it is %s', async (_case, authorization) => {
    const app = await api();

    const refused = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/tags`,
      headers: { authorization },
    });

    expect(refused.statusCode).toBe(401);
    expect(refused.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
  });

  it("isn't a person, so /me doesn't answer it", async () => {
    const app = await api();
    const owner = await businessWithOwner(app);
    const made = await keyFor(owner, ['tags.manage']);

    expect((await withKey(app, made.key, 'GET', '/me')).statusCode).toBe(401);
  });
});
