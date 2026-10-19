// The API over HTTP, against a migrated Postgres: the request hook's tenant context, the
// command layer and the error mapping together, and signing in.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowEveryone } from '@repo/commands';
import {
  appointmentDetail,
  appointmentList,
  calendarConfiguration,
  company,
  companyList,
  PROBLEM_CONTENT_TYPE,
  tag,
  tagList,
  task,
  taskList,
  taskAssigneeList,
  auditPage,
  bulkTasksResult,
  savedView,
  viewList,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { createAuthentication, type Authentication } from '@repo/module-auth';
import { createFiles, fileRoutes, type Files } from '@repo/module-files';
import { localStorage } from '@repo/storage';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config, DevTenantContext } from './config.js';
import { API_PREFIX, buildServer, type Server } from './server.js';

let database: TestDatabase;
let db: Database;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

/** The API, signed in as this context (the stub from before sign-in existed). */
async function apiFor(
  signedIn: DevTenantContext | undefined,
  options: { readonly files?: Files | undefined; readonly publicUrl?: string | undefined } = {},
): Promise<Server> {
  const publicUrl = options.publicUrl ?? 'https://crm.example.test';
  const config: Config = {
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
    devTenantContext: signedIn,
    publicUrl,
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault: undefined,
  };
  const server = await buildServer({
    config,
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes:
      options.files === undefined
        ? apiRoutes()
        : [
            ...apiRoutes(undefined, undefined, false, publicUrl, { files: options.files }),
            ...fileRoutes(options.files, { apiUrl: `${publicUrl}${API_PREFIX}` }),
          ],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
    files: options.files,
  });
  servers.push(server);
  return server;
}

/** A user signed in to a new business of a new agency. */
async function signedInToBusiness(): Promise<Required<DevTenantContext>> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return { agencyId: agency.id, businessId: business.id, userId: user.id };
}

const asOwner = <Row extends object>(text: string, values: unknown[]) =>
  database.as('crm_owner', (sql) => sql.query<Row>(text, values));

describe('POST /tags', () => {
  it('creates the tag in the signed-in business, and answers 201 with it', async () => {
    const signedIn = await signedInToBusiness();
    const { app } = await apiFor(signedIn);

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/tags`,
      payload: { name: '  Hot lead ', description: 'Asked for a quote.' },
    });

    expect(response.statusCode).toBe(201);
    const created = tag.parse(response.json());
    expect(created).toMatchObject({ name: 'Hot lead', description: 'Asked for a quote.' });
    const rows = await asOwner('select business_id from crm.tags where id = $1', [
      parsePublicId('tag', created.id),
    ]);
    expect(rows).toEqual([{ business_id: signedIn.businessId }]);
  });

  it('records an event with the actor and the request id as correlation, and an audit row', async () => {
    const signedIn = await signedInToBusiness();
    const { app } = await apiFor(signedIn);

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/tags`,
      headers: { 'user-agent': 'HTTP test' },
      payload: { name: 'VIP' },
    });

    const requestId = response.headers['x-request-id'];
    const events = await asOwner(
      `select type, actor_kind, actor_id, causation_id, business_id
       from events.events where correlation_id = $1`,
      [requestId],
    );
    expect(events).toEqual([
      {
        type: 'tag.created',
        actor_kind: 'user',
        actor_id: signedIn.userId,
        causation_id: null,
        business_id: signedIn.businessId,
      },
    ]);
    const audits = await asOwner(
      `select command, outcome, actor_id, host(ip) as ip, user_agent
       from audit.commands where correlation_id = $1`,
      [requestId],
    );
    expect(audits).toEqual([
      {
        command: 'tag.create',
        outcome: 'ok',
        actor_id: signedIn.userId,
        ip: '127.0.0.1',
        user_agent: 'HTTP test',
      },
    ]);
  });

  it('answers 422, naming the field, when the name is taken, and writes only the audit row', async () => {
    const { app } = await apiFor(await signedInToBusiness());
    await app.inject({ method: 'POST', url: `${API_PREFIX}/tags`, payload: { name: 'Hot lead' } });

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/tags`,
      payload: { name: 'hot-lead' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toMatchObject({
      status: 422,
      errors: [{ path: '/name', code: 'taken', message: 'A tag with this name already exists.' }],
    });
    const requestId = response.headers['x-request-id'];
    expect(
      await asOwner('select id from events.events where correlation_id = $1', [requestId]),
    ).toEqual([]);
    expect(
      await asOwner('select outcome, error_code from audit.commands where correlation_id = $1', [
        requestId,
      ]),
    ).toEqual([{ outcome: 'invalid', error_code: 'validation' }]);
  });

  it('answers 422 for a body that does not fit, naming each field', async () => {
    const { app } = await apiFor(await signedInToBusiness());

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/tags`,
      payload: { description: 7 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: { path: string }[] }>().errors.map(({ path }) => path)).toEqual(
      expect.arrayContaining(['/name', '/description']),
    );
  });
});

describe('GET /tags', () => {
  it("lists only the signed-in business's tags, by name", async () => {
    const harbor = await apiFor(await signedInToBusiness());
    const bakery = await apiFor(await signedInToBusiness());
    for (const name of ['wedding', 'Corporate']) {
      await harbor.app.inject({ method: 'POST', url: `${API_PREFIX}/tags`, payload: { name } });
    }
    await bakery.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/tags`,
      payload: { name: 'Wholesale' },
    });

    const response = await harbor.app.inject({ method: 'GET', url: `${API_PREFIX}/tags` });

    expect(response.statusCode).toBe(200);
    expect(tagList.parse(response.json()).items.map((item) => item.name)).toEqual([
      'Corporate',
      'wedding',
    ]);
  });

  it('answers 422 to agency staff who have not chosen a business', async () => {
    const { businessId: _none, ...agencyStaff } = await signedInToBusiness();
    const { app } = await apiFor(agencyStaff);

    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/tags` });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ errors: [{ code: 'business_required' }] });
  });
});

describe('signed in with a session (P1.01)', () => {
  const PUBLIC_URL = 'https://crm.example.test';
  const PASSWORD = 'correct horse battery staple';
  let authentication: Authentication;

  beforeAll(() => {
    authentication = createAuthentication({
      connectionString: database.url('crm_auth'),
      secret: 'a-test-secret-that-is-at-least-32-characters-long',
      publicUrl: PUBLIC_URL,
      onConnectionError: () => undefined,
      log: () => undefined,
      sendMail: () => Promise.resolve(),
    });
  });

  afterAll(async () => {
    await authentication.close();
  });

  let people = 0;
  /**
   * Someone who signs in with a password, with a membership in each business given, and
   * in the agency itself (agency staff) when given one.
   */
  async function person(memberships: {
    businesses?: readonly { id: string; agencyId: string }[];
    staffOf?: string;
  }): Promise<{ userId: string; email: string }> {
    const email = `person-${String(++people)}@harborlights.example`;
    const { id: userId } = await authentication.createUser({
      email,
      name: 'Dana Brooks',
      password: PASSWORD,
      emailVerified: true,
    });
    const role = (sql: Sql, agencyId: string, scope: 'agency' | 'business') =>
      sql.one<{ id: string }>(
        `insert into tenancy.roles (agency_id, scope, key, name, is_builtin) values ($1, $2, 'owner', 'Owner', true)
         on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
        [agencyId, scope],
      );
    await database.as('crm_owner', async (sql) => {
      for (const business of memberships.businesses ?? []) {
        const { id: roleId } = await role(sql, business.agencyId, 'business');
        await sql.query(
          `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
           values ($1, $2, $3, $4)`,
          [userId, business.agencyId, business.id, roleId],
        );
      }
      if (memberships.staffOf !== undefined) {
        const { id: roleId } = await role(sql, memberships.staffOf, 'agency');
        await sql.query(
          'insert into tenancy.memberships (user_id, agency_id, role_id) values ($1, $2, $3)',
          [userId, memberships.staffOf, roleId],
        );
      }
    });
    return { userId, email };
  }

  /** The API with sign-in, and the headers a browser sends once this person signed in. */
  async function signedInAs(email: string): Promise<{
    app: Server['app'];
    headers: Record<string, string>;
  }> {
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
      readinessChecks: {},
    });
    servers.push(server);
    const { app } = server;
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL },
      payload: { email, password: PASSWORD },
      // A client of its own, so sign-in's rate limit (ten in fifteen minutes from one
      // address) counts each person apart, as the isolation suite does.
      remoteAddress: `198.18.0.${String((people % 250) + 1)}`,
    });
    expect(signIn.statusCode).toBe(200);
    const setCookie = signIn.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
      .map((each) => each.split(';')[0] ?? '')
      .join('; ');
    return { app, headers: { cookie, origin: PUBLIC_URL } };
  }

  it('creates a tag in the business of the person who signed in, until they sign out', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const { userId, email } = await person({ businesses: [business] });
    const { app, headers } = await signedInAs(email);

    const created = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/tags`,
      headers,
      payload: { name: 'Wedding' },
    });
    expect(created.statusCode).toBe(201);
    const tagId = parsePublicId('tag', tag.parse(created.json()).id);
    expect(
      await asOwner<{ business_id: string; created_by_id: string }>(
        'select business_id, created_by_id from crm.tags where id = $1',
        [tagId],
      ),
    ).toEqual([{ business_id: business.id, created_by_id: userId }]);

    const signOut = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers });
    expect(signOut.statusCode).toBe(200);
    const afterwards = await app.inject({ method: 'GET', url: `${API_PREFIX}/tags`, headers });
    expect(afterwards.statusCode).toBe(401);
  });

  it('saves and shares views over signed-in HTTP without disclosing private state across people or businesses', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const elsewhere = await database.fixtures.business(agency.id);
    const owner = await person({ businesses: [business] });
    const colleague = await person({ businesses: [business] });
    const foreign = await person({ businesses: [elsewhere] });
    const ownerSession = await signedInAs(owner.email);
    const colleagueSession = await signedInAs(colleague.email);
    const foreignSession = await signedInAs(foreign.email);
    const request = (
      session: typeof ownerSession,
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      payload?: object,
    ) =>
      session.app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: session.headers,
        ...(payload === undefined ? {} : { payload }),
      });
    const input = {
      objectKey: 'contact',
      name: 'Garden enquiries',
      state: { q: 'garden', sort: 'name', added: 'week' },
      columns: ['name', 'phone'],
    };
    const created = await request(ownerSession, 'POST', '/views', input);
    expect(created.statusCode, created.body).toBe(201);
    const saved = savedView.parse(created.json());
    expect(saved).toMatchObject({
      ...input,
      visibility: 'private',
      owner: { name: 'Dana Brooks', you: true },
    });
    expect(
      viewList.parse((await request(ownerSession, 'GET', '/views?object=contact')).json()).items,
    ).toEqual([saved]);
    expect((await request(ownerSession, 'GET', '/views?object=company')).statusCode).toBe(422);
    for (const reader of [colleagueSession, foreignSession]) {
      expect(
        viewList.parse((await request(reader, 'GET', '/views?object=contact')).json()).items,
      ).toEqual([]);
      for (const [method, suffix] of [
        ['PUT', ''],
        ['DELETE', ''],
        ['POST', '/share'],
        ['POST', '/unshare'],
      ] as const) {
        expect(
          (await request(reader, method, `/views/${saved.id}${suffix}`, { malformed: true }))
            .statusCode,
        ).toBe(404);
      }
    }
    const sharedResponse = await request(ownerSession, 'POST', `/views/${saved.id}/share`, {
      revision: saved.revision,
    });
    expect(sharedResponse.statusCode, sharedResponse.body).toBe(200);
    const shared = savedView.parse(sharedResponse.json());
    const visible = viewList.parse(
      (await request(colleagueSession, 'GET', '/views?object=contact')).json(),
    ).items[0];
    expect(visible).toMatchObject({
      ...input,
      id: saved.id,
      visibility: 'shared',
      owner: { name: 'Dana Brooks', you: false },
      canChange: true,
      canShare: false,
      canUnshare: false,
    });
    expect(
      viewList.parse((await request(foreignSession, 'GET', '/views?object=contact')).json()).items,
    ).toEqual([]);
    const changes = {
      name: 'Garden team',
      state: { q: 'garden' },
      columns: ['phone', 'name'],
      revision: shared.revision,
    };
    const changedResponse = await request(colleagueSession, 'PUT', `/views/${saved.id}`, changes);
    expect(changedResponse.statusCode, changedResponse.body).toBe(200);
    const changed = savedView.parse(changedResponse.json());
    expect(
      (await request(ownerSession, 'DELETE', `/views/${saved.id}`, { revision: shared.revision }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await request(colleagueSession, 'POST', `/views/${saved.id}/unshare`, {
          revision: changed.revision,
        })
      ).statusCode,
    ).toBe(403);
    const privateResponse = await request(ownerSession, 'POST', `/views/${saved.id}/unshare`, {
      revision: changed.revision,
    });
    expect(privateResponse.statusCode, privateResponse.body).toBe(200);
    const personal = savedView.parse(privateResponse.json());
    expect(
      viewList.parse((await request(colleagueSession, 'GET', '/views?object=contact')).json())
        .items,
    ).toEqual([]);
    const deleted = await request(ownerSession, 'DELETE', `/views/${saved.id}`, {
      revision: personal.revision,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(deleted.body).toBe('');
    const audit = await asOwner<{ input: unknown }>(
      'select input from audit.commands where correlation_id=$1',
      [created.headers['x-request-id']],
    );
    expect(audit).toEqual([{ input: { objectKey: 'contact' } }]);
  });

  it('assigns and changes tasks over signed-in HTTP using real eligible memberships and trusted provenance', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const owner = await person({ businesses: [business] });
    const teammate = await person({ businesses: [business] });
    const foreignBusiness = await database.fixtures.business(agency.id);
    const foreign = await person({ businesses: [foreignBusiness] });
    const record = await database.fixtures.contact(business.context, { firstName: 'Maya' });
    const { app, headers } = await signedInAs(owner.email);
    const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: unknown) =>
      app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: {
          ...headers,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const people = await request('GET', '/tasks/assignees');
    expect(people.statusCode, people.body).toBe(200);
    const assignees = taskAssigneeList.parse(people.json()).items;
    expect(assignees.map((each) => [each.name, each.you]).sort()).toEqual([
      ['Dana Brooks', false],
      ['Dana Brooks', true],
    ]);
    const target = assignees.find((each) => !each.you);
    const self = assignees.find((each) => each.you);
    if (target === undefined || self === undefined)
      throw new Error('Expected both eligible people.');
    const created = await request('POST', '/tasks', {
      title: 'Call Maya',
      description: 'Private venue details.',
      recordId: toPublicId('contact', record.id),
      assignee: 'me',
      dueAt: '2001-01-01T12:00:00Z',
    });
    expect(created.statusCode, created.body).toBe(201);
    const saved = task.parse(created.json());
    expect(saved.assignee).toEqual({ membershipId: self.id, name: 'Dana Brooks', you: true });
    expect(
      taskList.parse((await request('GET', '/tasks?scope=mine&due=overdue')).json()).items,
    ).toEqual([saved]);
    const completeEdit = {
      title: 'Confirm venue',
      description: saved.description,
      dueAt: saved.dueAt,
      assignee: self.id,
      revision: saved.revision,
    };
    for (const key of ['description', 'dueAt', 'assignee'] as const) {
      const { [key]: _omitted, ...incomplete } = completeEdit;
      const refused = await request('PUT', `/tasks/${saved.id}`, incomplete);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(
        taskList.parse((await request('GET', '/tasks?scope=mine&due=overdue')).json()).items,
      ).toEqual([saved]);
    }
    const editedResponse = await request('PUT', `/tasks/${saved.id}`, {
      title: 'Confirm venue',
      description: 'Private venue details.',
      dueAt: null,
      assignee: target.id,
      revision: saved.revision,
    });
    expect(editedResponse.statusCode, editedResponse.body).toBe(200);
    const edited = task.parse(editedResponse.json());
    expect(edited.assignee).toEqual({ membershipId: target.id, name: 'Dana Brooks', you: false });
    expect(taskList.parse((await request('GET', '/tasks?scope=mine')).json()).items).toEqual([]);
    const completedResponse = await request('POST', `/tasks/${saved.id}/completion`, {
      completed: true,
      revision: edited.revision,
    });
    expect(completedResponse.statusCode, completedResponse.body).toBe(200);
    const completed = task.parse(completedResponse.json());
    expect(completed.completedBy).toEqual({ kind: 'user', name: 'Dana Brooks', you: true });
    const stale = await request('DELETE', `/tasks/${saved.id}`, { revision: edited.revision });
    expect(stale.statusCode, stale.body).toBe(409);
    await asOwner('delete from tenancy.memberships where id = $1', [
      parsePublicId('membership', target.id),
    ]);
    const remaining = taskList.parse((await request('GET', '/tasks?status=all')).json()).items[0];
    expect(remaining?.assignee).toMatchObject({ membershipId: null, you: false });
    expect(
      (
        await request('PUT', `/tasks/${saved.id}`, {
          title: 'Unavailable assignee',
          description: edited.description,
          dueAt: edited.dueAt,
          assignee: target.id,
          revision: completed.revision,
        })
      ).statusCode,
    ).toBe(422);
    const foreignMembership = await asOwner<{ id: string }>(
      'select id from tenancy.memberships where user_id = $1',
      [foreign.userId],
    );
    const foreignId = foreignMembership[0]?.id;
    if (foreignId === undefined) throw new Error('Expected the foreign membership.');
    expect(
      (
        await request('POST', '/tasks', {
          title: 'Foreign assignment',
          assignee: toPublicId('membership', foreignId),
        })
      ).statusCode,
    ).toBe(422);
    const deleted = await request('DELETE', `/tasks/${saved.id}`, { revision: completed.revision });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(deleted.body).toBe('');
    const audit = await asOwner<{ command: string; outcome: string; input: unknown }>(
      'select command, outcome, input from audit.commands where correlation_id = $1',
      [created.headers['x-request-id']],
    );
    expect(audit).toEqual([
      { command: 'task.create', outcome: 'ok', input: { recordId: saved.record?.id } },
    ]);
    const event = await asOwner<{ actor_kind: string; actor_id: string; payload: unknown }>(
      'select actor_kind, actor_id, payload from events.events where correlation_id = $1',
      [completedResponse.headers['x-request-id']],
    );
    expect(event).toEqual([
      { actor_kind: 'user', actor_id: owner.userId, payload: { recordId: saved.record?.id } },
    ]);
    expect(JSON.stringify(assignees)).not.toContain(teammate.userId);
  });

  it('lists tasks over HTTP by one real member, with a total, a page size, a title search and an order', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const owner = await person({ businesses: [business] });
    await person({ businesses: [business] });
    const foreignBusiness = await database.fixtures.business(agency.id);
    const foreign = await person({ businesses: [foreignBusiness] });
    const { app, headers } = await signedInAs(owner.email);
    const request = (method: 'GET' | 'POST', path: string, payload?: unknown) =>
      app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: {
          ...headers,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const assignees = taskAssigneeList.parse((await request('GET', '/tasks/assignees')).json());
    const target = assignees.items.find((each) => !each.you);
    const self = assignees.items.find((each) => each.you);
    if (target === undefined || self === undefined)
      throw new Error('Expected both eligible people.');
    for (const [title, assignee, dueAt] of [
      ['Call the venue', target.id, '2031-03-02T09:00:00Z'],
      ['Book the caterer', target.id, '2031-03-01T09:00:00Z'],
      ['call the florist', 'me', '2031-03-03T09:00:00Z'],
      ['Send invitations', null, null],
    ] as const) {
      const created = await request('POST', '/tasks', { title, assignee, dueAt });
      expect(created.statusCode, created.body).toBe(201);
    }
    const list = async (query: string) => {
      const response = await request('GET', `/tasks?${query}`);
      expect(response.statusCode, response.body).toBe(200);
      const page = taskList.parse(response.json());
      return { titles: page.items.map((item) => item.title), total: page.total, page };
    };
    // A request with none of the new parameters: newest first, and now with how many.
    expect(await list('status=all')).toMatchObject({
      titles: ['Send invitations', 'call the florist', 'Book the caterer', 'Call the venue'],
      total: 4,
    });
    expect(await list(`assignee=${target.id}`)).toMatchObject({
      titles: ['Book the caterer', 'Call the venue'],
      total: 2,
    });
    expect(await list(`assignee=${self.id}&q=CALL`)).toMatchObject({
      titles: ['call the florist'],
      total: 1,
    });
    const first = await list('sort=due&limit=2');
    expect(first).toMatchObject({ titles: ['Book the caterer', 'Call the venue'], total: 4 });
    expect(await list(`sort=due&limit=2&after=${first.page.nextCursor ?? ''}`)).toMatchObject({
      titles: ['call the florist', 'Send invitations'],
      total: 4,
      page: { nextCursor: null },
    });
    expect(await list('sort=title&direction=desc&limit=1')).toMatchObject({
      titles: ['Send invitations'],
      total: 4,
    });
    // An offset in a URL: 12:00 at +03:00 is 09:00 UTC, the caterer's own due time.
    expect(
      await list('dueFrom=2031-03-01T12%3A00%3A00%2B03%3A00&dueBefore=2031-03-02T09%3A00%3A00Z'),
    ).toMatchObject({ titles: ['Book the caterer'], total: 1 });
    expect(await list('due=upcoming')).toMatchObject({ total: 3 });
    expect(await list('due=today')).toMatchObject({ titles: [], total: 0 });

    // A member of a sibling business is not someone to list by; nor are both ways at once.
    const [{ id: foreignId } = { id: '' }] = await asOwner<{ id: string }>(
      'select id from tenancy.memberships where user_id = $1',
      [foreign.userId],
    );
    for (const query of [
      `assignee=${toPublicId('membership', foreignId)}`,
      `assignee=${target.id}&scope=mine`,
      'limit=101',
      'limit=0',
      'sort=updated',
      'due=tomorrow',
      'dueFrom=2031-03-02T00%3A00%3A00Z&dueBefore=2031-03-01T00%3A00%3A00Z',
      `q=${'a'.repeat(201)}`,
    ]) {
      const refused = await request('GET', `/tasks?${query}`);
      expect(refused.statusCode, query).toBe(422);
    }
  });

  it('books, lists, reads, moves, marks and cancels an appointment over HTTP as a signed-in member', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const owner = await person({ businesses: [business] });
    const foreign = await person({ businesses: [await database.fixtures.business(agency.id)] });
    const { app, headers } = await signedInAs(owner.email);
    const request = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) =>
      app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: {
          ...headers,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const membershipOf = async (userId: string) => {
      const [{ id } = { id: '' }] = await asOwner<{ id: string }>(
        'select id from tenancy.memberships where user_id = $1',
        [userId],
      );
      return toPublicId('membership', id);
    };
    const me = await membershipOf(owner.userId);
    const createdCalendar = await request('POST', '/calendars', {
      name: 'Site visits',
      kind: 'personal',
      timezone: 'UTC',
      bookingSlug: 'site-visits',
      isActive: true,
      minNoticeMinutes: 0,
      members: [{ membershipId: me, weight: 1 }],
      weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        startTime: '09:00',
        endTime: '17:00',
      })),
      dateOverrides: [],
    });
    expect(createdCalendar.statusCode, createdCalendar.body).toBe(201);
    const calendarId = calendarConfiguration.parse(createdCalendar.json()).calendar.id;
    const createdContact = await request('POST', '/contacts', {
      firstName: 'Amina',
      emails: ['amina@example.test'],
    });
    expect(createdContact.statusCode, createdContact.body).toBe(201);
    const contactId = createdContact.json<{ id: string }>().id;
    const day = (ahead: number) =>
      new Date(Date.now() + ahead * 86_400_000).toISOString().slice(0, 10);
    const booking = {
      requestId: '0199b7a0-0000-4000-8000-0000000000c1',
      calendarId,
      contactId,
      startsAt: `${day(1)}T10:00:00Z`,
      notes: 'Bring the plans.',
    };

    const created = await request('POST', '/appointments', booking);
    expect(created.statusCode, created.body).toBe(201);
    const booked = appointmentDetail.parse(created.json());
    expect(booked).toMatchObject({
      title: 'Site visits',
      status: 'confirmed',
      endsAt: `${day(1)}T10:30:00.000Z`,
      source: 'user',
      notes: 'Bring the plans.',
      assignee: { membershipId: me, you: true, name: 'Dana Brooks' },
      createdBy: { name: 'Dana Brooks' },
      contact: { id: contactId },
      canManage: true,
    });
    // The same request again is the same appointment, not a second one.
    const again = await request('POST', '/appointments', booking);
    expect(again.statusCode, again.body).toBe(201);
    expect(appointmentDetail.parse(again.json()).id).toBe(booked.id);

    const listed = await request('GET', `/appointments?q=SITE&calendar=${calendarId}&user=${me}`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(appointmentList.parse(listed.json())).toMatchObject({
      total: 1,
      next: null,
      canManage: true,
      items: [{ id: booked.id, assignee: { name: 'Dana Brooks' } }],
    });
    const none = await request('GET', '/appointments?view=cancelled');
    expect(appointmentList.parse(none.json())).toMatchObject({ total: 0, items: [] });

    const moved = await request('POST', `/appointments/${booked.id}/reschedule`, {
      revision: booked.revision,
      startsAt: `${day(2)}T11:00:00Z`,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const afterMove = appointmentDetail.parse(moved.json());
    // What the screen held before the move is a conflict, not a change.
    const stale = await request('PUT', `/appointments/${booked.id}/status`, {
      revision: booked.revision,
      status: 'completed',
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const marked = await request('PUT', `/appointments/${booked.id}/status`, {
      revision: afterMove.revision,
      status: 'invalid',
    });
    expect(marked.statusCode, marked.body).toBe(200);
    const cancelled = await request('POST', `/appointments/${booked.id}/cancel`, {
      revision: appointmentDetail.parse(marked.json()).revision,
      reason: 'Asked to come another week.',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const read = await request('GET', `/appointments/${booked.id}`);
    expect(read.statusCode, read.body).toBe(200);
    const final = appointmentDetail.parse(read.json());
    expect(final).toMatchObject({
      status: 'cancelled',
      startsAt: `${day(2)}T11:00:00.000Z`,
      cancelReason: 'Asked to come another week.',
    });
    expect(final.history.map((entry) => [entry.type, entry.actor.name])).toEqual([
      ['booked', 'Dana Brooks'],
      ['rescheduled', 'Dana Brooks'],
      ['status_changed', 'Dana Brooks'],
      ['status_changed', 'Dana Brooks'],
      ['cancelled', 'Dana Brooks'],
      ['status_changed', 'Dana Brooks'],
    ]);

    // A time outside the calendar's hours is a conflict; an end without setting
    // availability aside, a sibling business's member and a page size of none are refused.
    const outside = await request('POST', '/appointments', {
      ...booking,
      requestId: '0199b7a0-0000-4000-8000-0000000000c2',
      startsAt: `${day(1)}T03:00:00Z`,
    });
    expect(outside.statusCode, outside.body).toBe(409);
    const withEnd = await request('POST', '/appointments', {
      ...booking,
      requestId: '0199b7a0-0000-4000-8000-0000000000c3',
      endsAt: `${day(1)}T11:00:00Z`,
    });
    expect(withEnd.statusCode, withEnd.body).toBe(422);
    for (const query of [`user=${await membershipOf(foreign.userId)}`, 'limit=0', 'view=deleted']) {
      const refused = await request('GET', `/appointments?${query}`);
      expect(refused.statusCode, query).toBe(422);
    }
  });

  it('keeps a company over HTTP with every field, names who made it, and lists by a column with a total', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const owner = await person({ businesses: [business] });
    const colleague = await person({ businesses: [business] });
    const outsider = await person({ businesses: [await database.fixtures.business(agency.id)] });
    const sessions = {
      owner: await signedInAs(owner.email),
      colleague: await signedInAs(colleague.email),
      outsider: await signedInAs(outsider.email),
    };
    const request = (
      who: keyof typeof sessions,
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      payload?: unknown,
    ) =>
      sessions[who].app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: {
          ...sessions[who].headers,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });

    const created = await request('owner', 'POST', '/companies', {
      name: 'Harbor Lights Events',
      email: 'Hello@HarborLights.Example',
      website: 'www.harborlights.example',
      address: '12 Riverside Drive',
      city: 'Nairobi',
      state: 'Nairobi County',
      postalCode: '00100',
      country: 'ke',
      description: 'Plans weddings.',
    });
    expect(created.statusCode, created.body).toBe(201);
    const made = company.parse(created.json());
    expect(made).toMatchObject({
      email: 'hello@harborlights.example',
      website: 'www.harborlights.example',
      address: '12 Riverside Drive',
      city: 'Nairobi',
      state: 'Nairobi County',
      postalCode: '00100',
      country: 'KE',
      description: 'Plans weddings.',
      createdBy: { kind: 'user', name: 'Dana Brooks', you: true },
    });
    // A colleague reads the same company, made by someone else.
    const read = await request('colleague', 'GET', `/companies/${made.id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(company.parse(read.json())).toEqual({
      ...made,
      createdBy: { kind: 'user', name: 'Dana Brooks', you: false },
    });
    const second = await request('colleague', 'POST', '/companies', { name: 'anchor Catering' });
    expect(second.statusCode, second.body).toBe(201);
    const changed = await request('colleague', 'PATCH', `/companies/${made.id}`, { city: '' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(company.parse(changed.json())).toMatchObject({ city: null, state: 'Nairobi County' });

    const list = async (who: keyof typeof sessions, query: string) => {
      const response = await request(who, 'GET', `/companies${query}`);
      expect(response.statusCode, response.body).toBe(200);
      const page = companyList.parse(response.json());
      return { names: page.items.map((item) => item.name), total: page.total, next: page.next };
    };
    // A request with none of the new parameters: newest first, and now with how many.
    expect(await list('owner', '')).toEqual({
      names: ['anchor Catering', 'Harbor Lights Events'],
      total: 2,
      next: null,
    });
    const first = await list('owner', '?sort=name&limit=1');
    expect(first).toMatchObject({ names: ['anchor Catering'], total: 2 });
    expect(await list('owner', `?sort=name&limit=1&after=${first.next ?? ''}`)).toEqual({
      names: ['Harbor Lights Events'],
      total: 2,
      next: null,
    });
    expect(await list('owner', '?sort=email&direction=desc')).toMatchObject({
      names: ['Harbor Lights Events', 'anchor Catering'],
    });
    expect(await list('owner', '?sort=createdBy')).toMatchObject({ total: 2 });
    expect(await list('owner', '?q=HARBORLIGHTS.example')).toMatchObject({
      names: ['Harbor Lights Events'],
      total: 1,
    });

    // Another business sees none of it, and cannot page from it.
    expect(await list('outsider', '')).toEqual({ names: [], total: 0, next: null });
    expect((await request('outsider', 'GET', `/companies/${made.id}`)).statusCode).toBe(404);
    for (const query of [
      `after=${made.id}`,
      `sort=name&after=${made.id}`,
      'limit=0',
      'limit=101',
      'sort=domain',
      'direction=asc',
      'sort=name&sortField=fld_01h455vb4pex5vsknk084sn02q',
    ]) {
      const refused = await request(
        query.includes('after') ? 'outsider' : 'owner',
        'GET',
        `/companies?${query}`,
      );
      expect(refused.statusCode, query).toBe(422);
    }
    for (const body of [
      { name: 'Unsafe', website: 'javascript:alert(1)' },
      { name: 'Unsafe', country: 'KEN' },
      { name: 'Unsafe', email: 'hello' },
      { name: 'Unsafe', createdBy: { kind: 'user', name: 'Someone Else', you: false } },
    ]) {
      const refused = await request('owner', 'POST', '/companies', body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(422);
    }
  });

  it('changes many tasks in one request over HTTP, and lists who changed what across the business', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const owner = await person({ businesses: [business] });
    await person({ businesses: [business] });
    const sibling = await database.fixtures.business(agency.id);
    const outsider = await person({ businesses: [sibling] });
    const { app, headers } = await signedInAs(owner.email);
    const request = (method: 'GET' | 'POST', path: string, payload?: unknown) =>
      app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers: {
          ...headers,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const assignees = taskAssigneeList.parse((await request('GET', '/tasks/assignees')).json());
    const target = assignees.items.find((each) => !each.you);
    const self = assignees.items.find((each) => each.you);
    if (target === undefined || self === undefined)
      throw new Error('Expected both eligible people.');
    const made: string[] = [];
    for (const title of ['Call the venue', 'Book the caterer']) {
      const created = await request('POST', '/tasks', { title });
      expect(created.statusCode, created.body).toBe(201);
      made.push(task.parse(created.json()).id);
    }
    const unknown = toPublicId('task', '01890a5d-ac96-774b-bcce-000000000001');

    // Through tenancy's own membership lookup: a real member is assigned, a stranger refused.
    const assigned = await request('POST', '/tasks/bulk', {
      action: 'assign',
      ids: [...made, unknown],
      assignee: target.id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(bulkTasksResult.parse(assigned.json())).toMatchObject({
      action: 'assign',
      done: 2,
      unchanged: 0,
      skipped: 1,
      results: [
        { id: made[0], outcome: 'done', reason: null },
        { id: made[1], outcome: 'done', reason: null },
        { id: unknown, outcome: 'skipped', reason: { code: 'not_found' } },
      ],
    });
    const listed = taskList.parse((await request('GET', '/tasks')).json()).items;
    expect(listed.map((each) => each.assignee?.membershipId)).toEqual([target.id, target.id]);
    const outsiders = await asOwner<{ id: string }>(
      'select id from tenancy.memberships where user_id = $1',
      [outsider.userId],
    );
    const stranger = await request('POST', '/tasks/bulk', {
      action: 'assign',
      ids: made,
      assignee: toPublicId('membership', outsiders[0]?.id ?? ''),
    });
    expect(stranger.statusCode, stranger.body).toBe(422);
    expect(stranger.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const malformed = await request('POST', '/tasks/bulk', { action: 'complete', ids: [] });
    expect(malformed.statusCode).toBe(422);
    // One audit row for the request, holding the action and the ids and both events.
    const audit = await asOwner<{ command: string; outcome: string; events: number }>(
      'select command, outcome, cardinality(event_ids) as events from audit.commands where correlation_id = $1',
      [assigned.headers['x-request-id']],
    );
    expect(audit).toEqual([{ command: 'task.bulk', outcome: 'ok', events: 2 }]);

    const read = async (query: string) => {
      const response = await request('GET', `/audit-log${query}`);
      expect(response.statusCode, response.body).toBe(200);
      return auditPage.parse(response.json());
    };
    const log = await read('');
    expect(log.items.map((entry) => [entry.command, entry.module, entry.action])).toEqual([
      ['task.bulk', 'tasks', 'updated'],
      ['task.create', 'tasks', 'created'],
      ['task.create', 'tasks', 'created'],
    ]);
    expect(log.items[0]).toMatchObject({
      actor: { kind: 'user', name: 'Dana Brooks', you: true },
      record: null,
      recordCount: 2,
    });
    expect(log.items[1]?.record).toEqual({
      kind: 'task',
      id: made[1],
      name: 'Book the caterer',
      exists: true,
    });
    expect(
      (await read(`?member=${self.id}&module=tasks&action=created&limit=1`)).items,
    ).toHaveLength(1);
    expect((await read('?member=me')).items).toHaveLength(3);
    // The teammate did nothing; the stranger's refused attempt was the reader's own.
    expect((await read(`?member=${target.id}`)).items).toEqual([]);
    expect((await read(`?subject=${made[0] ?? ''}`)).items.map((entry) => entry.command)).toEqual([
      'task.bulk',
      'task.create',
    ]);
    expect((await read('?outcome=invalid')).items.map((entry) => entry.command)).toEqual([
      'task.bulk',
      'task.bulk',
    ]);
    for (const refused of [
      `?member=${toPublicId('membership', outsiders[0]?.id ?? '')}`,
      '?member=me&actorKind=user',
      '?module=billing',
    ])
      expect((await request('GET', `/audit-log${refused}`)).statusCode, refused).toBe(422);

    // Someone of the sibling business reads none of it.
    const other = await signedInAs(outsider.email);
    const elsewhere = await other.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/audit-log`,
      headers: other.headers,
    });
    expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    expect(auditPage.parse(elsewhere.json())).toEqual({ items: [], next: null });
  });

  it('refuses someone in several businesses until they choose one', async () => {
    // Acting for neither would make the context agency staff's, which sees every business
    // in the agency, not only these two: events, files, the audit log.
    const agency = await database.fixtures.agency();
    const a = await database.fixtures.business(agency.id);
    const b = await database.fixtures.business(agency.id);
    const { email } = await person({ businesses: [a, b] });
    const { app, headers } = await signedInAs(email);

    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/tags`, headers });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ detail: 'Choose a business first.' });
  });

  it('lets agency staff in without a business, to choose one', async () => {
    const agency = await database.fixtures.agency();
    const { email } = await person({ staffOf: agency.id });
    const { app, headers } = await signedInAs(email);

    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/tags`, headers });

    // Past the sign-in check: tags belong to a business, so the command asks for one.
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ errors: [{ code: 'business_required' }] });
  });
});

describe('GET /calls/{id}/recordings', () => {
  it('returns a completed recording with audio.url through the composed routes', async () => {
    const signedIn = await signedInToBusiness();
    const storageDir = await mkdtemp(join(tmpdir(), 'crm-api-call-recordings-'));
    const files = createFiles({
      storage: localStorage({ directory: join(storageDir, 'storage') }),
      uploadDirectory: join(storageDir, 'uploads'),
      maxBytes: 10 * 1024 * 1024,
      linkSecret: 'a-files-link-secret-of-32-characters-or-more',
    });
    try {
      const publicUrl = 'https://crm.example.test';
      const { app } = await apiFor(signedIn, { files, publicUrl });

      const secretId =
        (
          await asOwner<{ id: string }>(
            `insert into vault.secrets (agency_id, business_id, purpose, key_version, ciphertext, enc)
           values ($1, $2, 'messaging.sms_credentials', 1, $3, $4) returning id`,
            [signedIn.agencyId, signedIn.businessId, Buffer.alloc(32), Buffer.alloc(32)],
          )
        )[0]?.id ?? '';

      const connectionId =
        (
          await asOwner<{ id: string }>(
            `insert into messaging.provider_connections (agency_id, business_id, provider, label, account_ref, secret_id, webhook_digest)
           values ($1, $2, 'twilio', 'Test', $3, $4, repeat('a', 64)) returning id`,
            [
              signedIn.agencyId,
              signedIn.businessId,
              `AC${randomUUID().replaceAll('-', '')}`,
              secretId,
            ],
          )
        )[0]?.id ?? '';

      const channelId =
        (
          await asOwner<{ id: string }>(
            `insert into messaging.channel_accounts (business_id, channel, name)
           values ($1, 'sms', 'Main') returning id`,
            [signedIn.businessId],
          )
        )[0]?.id ?? '';

      await asOwner(
        `insert into messaging.phone_numbers (business_id, id, e164, provider_connection_id, provider_number_ref, capabilities)
         values ($1, $2, '+15005550006', $3, 'PNtest', array['voice'])`,
        [signedIn.businessId, channelId, connectionId],
      );

      const callRow = (
        await asOwner<{ id: string }>(
          `insert into messaging.calls (business_id, direction, phone_number_id, provider_connection_id,
             local_e164, remote_e164, requested_by_kind, idempotency_key, request_hash)
           values ($1, 'inbound', $2, $3, '+15005550006', '+15005550199', 'system', $4, repeat('c', 64))
           returning id`,
          [signedIn.businessId, channelId, connectionId, `call-${randomUUID()}`],
        )
      )[0];
      if (callRow === undefined) throw new Error('Failed to insert call');

      const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02, 0x03, 0x04]);
      const tenantContext: TenantContext = {
        agencyId: signedIn.agencyId,
        ...(signedIn.businessId !== undefined ? { businessId: signedIn.businessId } : {}),
        actorKind: 'system',
        actorId: signedIn.userId,
        correlationId: randomUUID(),
      };
      const stored = await withTenant(db, tenantContext, (trx) =>
        files.store(
          trx,
          {
            context: tenantContext,
            permissions: 'all',
            emit: () => Promise.resolve('evt_id'),
            enqueue: () => undefined,
          },
          {
            filename: 'recording.mp3',
            contentType: 'audio/mpeg',
            content: mp3Bytes,
            purpose: 'call_recording',
            quota: true,
          },
        ),
      );

      await asOwner(
        `insert into messaging.call_recordings (business_id, call_id, provider_connection_id,
           provider_recording_sid, kind, status, duration_seconds, file_id)
         values ($1, $2, $3, $4, 'call', 'completed', 45, $5)`,
        [
          signedIn.businessId,
          callRow.id,
          connectionId,
          `RE${randomUUID().replaceAll('-', '')}`,
          parsePublicId('file', stored.id),
        ],
      );

      const callPublicId = toPublicId('call', callRow.id);
      const response = await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/calls/${callPublicId}/recordings`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        data: {
          id: string;
          kind: string;
          status: string;
          durationSeconds: number;
          audio: { url: string; expiresAt: string } | null;
          unavailable: string | null;
        }[];
      }>();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.status).toBe('completed');
      expect(body.data[0]?.unavailable).toBeNull();
      expect(body.data[0]?.audio).not.toBeNull();
      expect(body.data[0]?.audio?.url).toContain(`${publicUrl}${API_PREFIX}/files/`);

      const linkPath = body.data[0]?.audio?.url.replace(publicUrl, '') ?? '';
      const contentResponse = await app.inject({
        method: 'GET',
        url: linkPath,
      });
      expect(contentResponse.statusCode).toBe(200);
      expect(Buffer.compare(contentResponse.rawPayload, Buffer.from(mp3Bytes))).toBe(0);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
