// Reporting through the actual Fastify composition, with a real migrated Postgres. Direct
// route.run tests cannot detect a missing mount or a path that another route takes first;
// and only here does a contact made through the API get its touch and show up in a report
// the same API answers.
import { allowEveryone } from '@repo/commands';
import {
  appointmentOverview,
  attributionReport,
  contact as contactContract,
  contactAttributions,
  problem,
  PROBLEM_CONTENT_TYPE,
  report,
  reportCatalog,
  reportList,
  reportResult,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config, DevTenantContext } from './config.js';
import { buildServer, type Server } from './server.js';

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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Api = (
  method: Method,
  path: string,
  payload?: object,
) => Promise<{ status: number; body: string; json: unknown; type: string }>;

/** The API as someone signed in to a business of their own calls it. */
async function api(): Promise<Api> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const signedIn: Required<DevTenantContext> = {
    agencyId: agency.id,
    businessId: business.id,
    userId: user.id,
  };
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
    publicUrl: 'https://crm.example.test',
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
    routes: apiRoutes(),
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
  });
  servers.push(server);
  return async (method, path, payload) => {
    const response = await server.app.inject({
      method,
      url: `/api/v1${path}`,
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body,
      json: response.body === '' ? undefined : response.json<unknown>(),
      // The media type, without its charset.
      type: String(response.headers['content-type']).split(';')[0] ?? '',
    };
  };
}

const TODAY = { preset: 'today' };

it('serves the catalogue, a query and the fixed reports, with a contact the API just made', async () => {
  const call = await api();
  const made = await call('POST', '/contacts', {
    firstName: 'Maya',
    emails: ['maya@example.test'],
  });
  expect(made.status, made.body).toBe(201);
  const { id } = contactContract.parse(made.json);

  // The contact has its first touch: made by hand.
  const touch = await call('GET', `/contacts/${id}/attribution`);
  expect(touch.status, touch.body).toBe(200);
  const attribution = contactAttributions.parse(touch.json);
  expect(attribution.first).toMatchObject({ medium: 'manual', sessionSource: 'crm_ui' });
  expect(attribution.latest).toEqual(attribution.first);

  const catalog = await call('GET', '/reports/catalog');
  expect(catalog.status, catalog.body).toBe(200);
  expect(reportCatalog.parse(catalog.json).sources.map((source) => source.key)).toEqual([
    'contacts',
    'opportunities',
    'appointments',
    'attribution',
  ]);

  const counted = await call('POST', '/reports/query', {
    source: 'contacts',
    measures: ['count'],
    groupBy: ['sessionSource'],
    range: TODAY,
    compare: 'previous_period',
  });
  expect(counted.status, counted.body).toBe(200);
  const result = reportResult.parse(counted.json);
  expect(result.totals).toEqual([1]);
  expect(result.rows).toMatchObject([
    { group: [{ key: 'crm_ui', label: 'CRM UI' }], values: [1], compare: [0], other: false },
  ]);

  const sources = await call('GET', '/reports/attribution?preset=today');
  expect(sources.status, sources.body).toBe(200);
  expect(attributionReport.parse(sources.json)).toMatchObject({
    totals: { leads: 1, appointments: 0, opportunities: 0, won: 0, wonValue: [] },
    sources: [{ sessionSource: 'crm_ui', leads: 1 }],
    touches: [{ contact: { id }, first: true, medium: 'manual' }],
  });

  const appointments = await call('GET', '/reports/appointment-overview?preset=this_month');
  expect(appointments.status, appointments.body).toBe(200);
  expect(appointmentOverview.parse(appointments.json)).toMatchObject({
    total: 0,
    reschedules: null,
  });

  // The reports that were there before are still served where they were.
  const older = await call(
    'GET',
    '/reports/appointments?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z',
  );
  expect(older.status, older.body).toBe(200);
});

it('refuses a query the catalogue does not allow as a problem that points at it', async () => {
  const call = await api();
  for (const [body, pointer] of [
    [{ source: 'contacts', measures: ['revenue'], range: TODAY }, '/measures/0'],
    [{ source: 'contacts', measures: ['count'], groupBy: ['stage'], range: TODAY }, '/groupBy/0'],
    [{ source: 'payments', measures: ['count'], range: TODAY }, '/source'],
    [
      { source: 'contacts', measures: ['count'], range: { from: '2026-09-02', to: '2026-09-01' } },
      '/range/to',
    ],
    [{ source: 'contacts', measures: ['count'], range: TODAY, sql: 'select 1' }, ''],
  ] as const) {
    const refused = await call('POST', '/reports/query', body);
    expect(refused.status, refused.body).toBe(422);
    expect(refused.type).toBe(PROBLEM_CONTENT_TYPE);
    expect(JSON.stringify(problem.parse(refused.json).errors), pointer).toContain(
      `"path":"${pointer}`,
    );
  }
  const range = await call('GET', '/reports/attribution?from=2026-09-01');
  expect(range.status, range.body).toBe(422);
});

it('answers a query that runs out of time with a refusal, never a server fault', async () => {
  const call = await api();
  // Another session holds the table for longer than a report statement may take.
  const blocker = database.as('crm_owner', async (sql) => {
    await sql.query('lock table crm.contacts in access exclusive mode');
    await sql.query('select pg_sleep(6)');
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const refused = await call('POST', '/reports/query', {
    source: 'contacts',
    measures: ['count'],
    range: TODAY,
  });
  await blocker;
  expect(refused.status, refused.body).toBe(422);
  expect(problem.parse(refused.json).errors).toMatchObject([{ code: 'query_timeout' }]);
});

it('keeps saved reports: made from the library, listed, saved under a revision, copied and deleted', async () => {
  const call = await api();
  const templates = await call('GET', '/reports/templates');
  expect(templates.status, templates.body).toBe(200);
  expect(templates.json).toMatchObject({ items: [{ key: 'pipeline_attribution', version: 1 }] });

  const created = await call('POST', '/reports', { templateKey: 'pipeline_attribution' });
  expect(created.status, created.body).toBe(201);
  const made = report.parse(created.json);
  expect(made).toMatchObject({
    name: 'Pipeline & Attribution Report',
    createdBy: { kind: 'template_library' },
    revision: 1,
  });

  // A static path is not taken for a report's id, and a report's id is not taken for one.
  const read = await call('GET', `/reports/${made.id}`);
  expect(read.status, read.body).toBe(200);
  expect(report.parse(read.json)).toEqual(made);

  const saved = await call('PUT', `/reports/${made.id}`, {
    name: 'Monthly review',
    definition: made.definition,
    revision: 1,
  });
  expect(saved.status, saved.body).toBe(200);
  expect(report.parse(saved.json)).toMatchObject({ name: 'Monthly review', revision: 2 });
  const stale = await call('PUT', `/reports/${made.id}`, {
    name: 'Mine',
    definition: made.definition,
    revision: 1,
  });
  expect(stale.status, stale.body).toBe(409);

  const copied = await call('POST', `/reports/${made.id}/clone`, {});
  expect(copied.status, copied.body).toBe(201);
  const copy = report.parse(copied.json);
  expect(copy.name).toBe('Copy of Monthly review');

  const listed = await call('GET', '/reports?q=monthly');
  expect(listed.status, listed.body).toBe(200);
  expect(reportList.parse(listed.json).items.map((item) => item.id)).toEqual([copy.id, made.id]);

  const gone = await call('DELETE', `/reports/${copy.id}`, { revision: 1 });
  expect(gone.status, gone.body).toBe(204);
  expect((await call('GET', `/reports/${copy.id}`)).status).toBe(404);
  expect(
    reportList.parse((await call('GET', '/reports')).json).items.map((item) => item.id),
  ).toEqual([made.id]);
});
