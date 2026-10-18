// Document-to-workflow acceptance: canonical HTTP routes and migrated Postgres.
// Sanitized email bodies exercise authoring, not the client's missing linked copy.
import { allowEveryone } from '@repo/commands';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import {
  automationDraftSaved,
  automationTestRun,
  automationView,
  createdApiKey,
  type AutomationDocumentInput,
  type AutomationStep,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { createAuthentication, type Authentication } from '@repo/module-auth';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { API_PREFIX, buildServer, type Server } from './server.js';

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
    publicUrl: 'https://crm.example.test',
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

async function api(authenticated = false): Promise<Server> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
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
    devTenantContext: authenticated
      ? undefined
      : { agencyId: agency.id, businessId: business.id, userId: user.id },
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
    routes: apiRoutes(authenticated ? authentication : undefined),
    ...(authenticated ? { authentication } : {}),
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
  });
  servers.push(server);
  return server;
}

const schedule = [
  [0, 'Start Planning The Best Day Of Your Life!'],
  [1, 'Free Must Have Checklist'],
  [3, 'Important'],
  [6, 'How to find the right vendors for your wedding'],
  [8, 'Want a FUN wedding? Follow these 4 steps'],
  [10, 'How a wedding runs smoothly'],
  [11, 'Smoothest wedding photography secrets'],
  [13, '5 disastrous mistakes to avoid when planning your wedding'],
  [15, 'Want a flawless wedding day?'],
  [17, '4 Reasons why having a photo booth rocks'],
  [19, 'Party like a rockstar'],
  [20, 'What Makes Us Different'],
  [22, 'Party people by the dancefloor, right?'],
  [24, 'Listen to Our Podcast'],
  [29, 'Help us help you'],
] as const;

function educationDocument(): AutomationDocumentInput {
  const steps: Record<string, AutomationStep> = {
    has_initial_date: {
      type: 'condition',
      config: { if: { field: 'contact.custom.initial_contact_date', operator: 'is_set' } },
      next: { yes: 'wait_0' },
    },
  };
  for (const [index, [day, subject]] of schedule.entries()) {
    const next = index === schedule.length - 1 ? {} : { next: `wait_${String(index + 1)}` };
    steps[`wait_${String(index)}`] = {
      type: 'wait.until',
      config: {
        field: 'contact.custom.initial_contact_date',
        offset: `P${String(day)}D`,
        direction: 'after',
      },
      next: `email_${String(index)}`,
    };
    steps[`email_${String(index)}`] = {
      type: 'email.send',
      label: subject,
      config: { subject, body: 'SANITIZED ACCEPTANCE FIXTURE: client email copy not supplied.' },
      ...next,
    };
  }
  return {
    name: 'TEST — 2026 Wedding Requested Info Sequence',
    description: 'Education continues after consultation booking; no actual messages sent.',
    triggers: [{ id: 'enquiry', type: 'contact.created', config: {} }],
    stopWhen: [],
    start: 'has_initial_date',
    steps,
    settings: { reEnrollment: 'never', timezone: 'business' },
  };
}

it('authors, persists and dry-runs all 15 education emails anchored to the initial enquiry', async () => {
  const { app } = await api();
  const field = await app.inject({
    method: 'POST',
    url: `${API_PREFIX}/fields`,
    payload: {
      objectKey: 'contact',
      key: 'initial_contact_date',
      label: 'Initial Contact Date',
      description: 'First wedding enquiry instant, retained on later enquiries.',
      valueType: 'datetime',
      currency: null,
      options: [],
      aiFillSources: [],
      aiOverwrite: 'never',
      archived: false,
    },
  });
  expect(field.statusCode).toBe(201);
  const created = await app.inject({
    method: 'POST',
    url: `${API_PREFIX}/automations`,
    payload: { document: educationDocument() },
  });
  expect(created.statusCode).toBe(201);
  const saved = automationDraftSaved.parse(created.json());
  expect(saved.automation).toMatchObject({ status: 'draft', liveVersion: null, draftVersion: 1 });
  expect(saved.automation.draft['settings']).toEqual({
    reEnrollment: 'never',
    timezone: 'business',
  });
  const read = await app.inject({
    method: 'GET',
    url: `${API_PREFIX}/automations/${saved.automation.id}`,
  });
  expect(read.statusCode).toBe(200);
  expect(automationView.parse(read.json()).draft).toEqual(saved.automation.draft);

  const run = await app.inject({
    method: 'POST',
    url: `${API_PREFIX}/automations/${saved.automation.id}/test-runs`,
    payload: {
      start: '2026-10-11T09:00:00Z',
      values: { 'contact.custom.initial_contact_date': '2026-10-11T09:00:00Z' },
      events: [
        { event: 'appointment.booked', after: 'P2D' },
        { event: 'message.received', after: 'P4D' },
      ],
    },
  });
  expect(run.statusCode).toBe(201);
  const trace = automationTestRun.parse(run.json());
  expect(trace).toMatchObject({ status: 'passed', outcome: { kind: 'completed' } });
  expect(
    trace.steps.filter((step) => step.kind === 'would_send').map((step) => [step.step, step.at]),
  ).toEqual([
    ['email_0', '2026-10-11T09:00:00.000Z'],
    ['email_1', '2026-10-12T09:00:00.000Z'],
    ['email_2', '2026-10-14T09:00:00.000Z'],
    ['email_3', '2026-10-17T09:00:00.000Z'],
    ['email_4', '2026-10-19T09:00:00.000Z'],
    ['email_5', '2026-10-21T09:00:00.000Z'],
    ['email_6', '2026-10-22T09:00:00.000Z'],
    ['email_7', '2026-10-24T09:00:00.000Z'],
    ['email_8', '2026-10-26T09:00:00.000Z'],
    ['email_9', '2026-10-28T09:00:00.000Z'],
    ['email_10', '2026-10-30T09:00:00.000Z'],
    ['email_11', '2026-10-31T09:00:00.000Z'],
    ['email_12', '2026-11-02T09:00:00.000Z'],
    ['email_13', '2026-11-04T09:00:00.000Z'],
    ['email_14', '2026-11-09T09:00:00.000Z'],
  ]);
  const stored = await app.inject({
    method: 'GET',
    url: `${API_PREFIX}/automations/${saved.automation.id}/test-runs/${trace.id}`,
  });
  expect(stored.statusCode).toBe(200);
  expect(automationTestRun.parse(stored.json())).toEqual(trace);
  const missingDate = await app.inject({
    method: 'POST',
    url: `${API_PREFIX}/automations/${saved.automation.id}/test-runs`,
    payload: { start: '2026-10-11T09:00:00Z', values: {} },
  });
  expect(missingDate.statusCode).toBe(201);
  expect(automationTestRun.parse(missingDate.json()).steps).toEqual([
    expect.objectContaining({ step: 'has_initial_date', kind: 'branched', branch: 'no' }),
  ]);
  const effects = await database.as('crm_owner', (sql) =>
    sql.query<{ messages: number; enrolments: number }>(
      'select (select count(*)::int from messaging.messages) as messages, (select count(*)::int from automation.enrolments) as enrolments',
    ),
  );
  expect(effects).toEqual([{ messages: 0, enrolments: 0 }]);
});

it('builds the education draft through MCP with a real scoped API key and rejects unauthorized publishing', async () => {
  const bootstrap = await api();
  const issued = await bootstrap.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/api-keys`,
    payload: {
      name: 'Wedding authoring acceptance',
      scopes: ['automations.manage', 'fields.manage'],
    },
  });
  expect(issued.statusCode).toBe(201);
  const key = createdApiKey.parse(issued.json()).key;
  const live = await api(true);
  const address = await live.app.listen({ host: '127.0.0.1', port: 0 });
  const ai = new Client({ name: 'wedding-document-acceptance', version: '1.0.0' });
  await ai.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../../packages/mcp/dist/main.js', import.meta.url))],
      env: {
        CRM_API_URL: `${address}${API_PREFIX}`,
        CRM_API_KEY: key,
        CRM_MCP_ALLOW_PUBLISH: 'true',
      },
      stderr: 'pipe',
    }),
  );
  try {
    const catalog = await ai.callTool({ name: 'crm_getAutomationCatalog', arguments: {} });
    expect(catalog.isError).not.toBe(true);
    const field = await ai.callTool({
      name: 'crm_createField',
      arguments: {
        body: {
          objectKey: 'contact',
          key: 'initial_contact_date',
          label: 'Initial Contact Date',
          description: 'First wedding enquiry instant.',
          valueType: 'datetime',
          currency: null,
          options: [],
          aiFillSources: [],
          aiOverwrite: 'never',
          archived: false,
        },
      },
    });
    expect(field.isError).not.toBe(true);
    const created = await ai.callTool({
      name: 'crm_createAutomation',
      arguments: { body: { document: educationDocument() } },
    });
    expect(created.isError).not.toBe(true);
    const saved = automationDraftSaved.parse(created.structuredContent);
    expect(saved.automation).toMatchObject({ status: 'draft', liveVersion: null });
    const tested = await ai.callTool({
      name: 'crm_createAutomationTestRun',
      arguments: {
        params: { id: saved.automation.id },
        body: {
          start: '2026-10-11T09:00:00Z',
          values: { 'contact.custom.initial_contact_date': '2026-10-11T09:00:00Z' },
          events: [{ event: 'appointment.booked', after: 'P2D' }],
        },
      },
    });
    expect(tested.isError).not.toBe(true);
    const trace = automationTestRun.parse(tested.structuredContent);
    expect(trace).toMatchObject({ status: 'passed', outcome: { kind: 'completed' } });
    expect(trace.steps.filter((step) => step.kind === 'would_send')).toHaveLength(15);
    expect(trace.steps.at(-1)).toMatchObject({ step: 'email_14', at: '2026-11-09T09:00:00.000Z' });
    const refused = await ai.callTool({
      name: 'crm_publishAutomation',
      arguments: {
        params: { id: saved.automation.id },
        body: { baseDraftVersion: saved.automation.draftVersion },
      },
    });
    expect(refused).toMatchObject({ isError: true, structuredContent: { status: 403 } });
    const read = await ai.callTool({
      name: 'crm_getAutomation',
      arguments: { params: { id: saved.automation.id } },
    });
    expect(automationView.parse(read.structuredContent)).toMatchObject({
      status: 'draft',
      liveVersion: null,
    });
  } finally {
    await ai.close();
  }
});
