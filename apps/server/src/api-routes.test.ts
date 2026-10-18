import { allowEveryone } from '@repo/commands';
import {
  endpoints,
  getContactConsent,
  getMessagingSettings,
  notificationEndpoints,
  recordContactConsent,
  rotateAutomationWebhookSecret,
  updateMessagingSettings,
} from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { pino } from 'pino';
import { expect, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { buildServer } from './server.js';

const config: Config = {
  nodeEnv: 'test',
  role: 'app',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  databaseAppUrl: 'postgres://crm_app@127.0.0.1:1/crm',
  databaseWorkerUrl: undefined,
  databasePoolSize: 1,
  shutdownTimeoutMs: 1000,
  dashboardDir: undefined,
  devTenantContext: undefined,
  publicUrl: 'https://crm.example.test',
  authentication: undefined,
  mail: undefined,
  trustProxy: [],
  files: undefined,
  vault: undefined,
};

it('serves the automation schema through registered routes and refuses unsigned requests', async () => {
  const db = connectDatabase({
    connectionString: config.databaseAppUrl,
    onConnectionError: () => undefined,
  });
  const servers = [];
  try {
    for (const signedIn of [false, true]) {
      const server = await buildServer({
        config: {
          ...config,
          devTenantContext: signedIn
            ? {
                agencyId: '01890a5d-ac96-774b-bcce-b302099a8057',
                businessId: '01890a5d-ac96-774b-bcce-b302099a8058',
                userId: '01890a5d-ac96-774b-bcce-b302099a8059',
              }
            : undefined,
        },
        logger: pino({ level: 'silent' }),
        serveApi: true,
        routes: apiRoutes(),
        services: { db, authorize: allowEveryone },
        readinessChecks: {},
      });
      servers.push(server);
      const response = await server.app.inject('/api/v1/automations/schema');
      expect(response.statusCode).toBe(signedIn ? 200 : 401);
      if (signedIn) {
        const schema: unknown = response.json();
        expect(schema).toMatchObject({ type: 'object' });
        expect(schema).toHaveProperty('properties.steps');
      }
    }
  } finally {
    await Promise.all(servers.map((server) => server.close(1000)));
    await db.destroy();
  }
});

it('publishes every registered automation operation exactly once in the API reference', () => {
  const routes = apiRoutes().filter(({ endpoint }) => endpoint.group === 'Automations');
  // The 22 of the automation API, a record's runs, and the nine of the workflow list and tabs, plus
  // independent template-copy authoring, running a failed run again, and continuing
  // a waiting run, the trigger evaluations and what an automation did for one contact. And
  // sync with a template (on, and an edit through the step) and a step's email statistics;
  // the actions that use a template are served under the template. And the webhook secrets
  // a step's headers send: list, store, delete.
  expect(routes).toHaveLength(43);
  const copies = routes.filter(
    ({ endpoint }) => endpoint.operationId === 'copyWorkflowEmailTemplate',
  );
  expect(copies).toHaveLength(1);
  expect(copies[0]).toMatchObject({
    endpoint: { method: 'post', path: '/automations/{id}/draft/email-template-copy' },
    command: { name: 'automation.copy_email_template', permission: 'automations.manage' },
  });
  for (const { endpoint } of routes) {
    expect(endpoints.filter((described) => described.operationId === endpoint.operationId)).toEqual(
      [endpoint],
    );
  }
  const paths = apiRoutes().map(({ endpoint }) => `${endpoint.method} ${endpoint.path}`);
  expect(new Set(paths).size).toBe(paths.length);
});

it('registers the consent and messaging settings routes once with their public contracts', () => {
  const expected = [
    getContactConsent,
    recordContactConsent,
    getMessagingSettings,
    updateMessagingSettings,
  ];
  const routes = apiRoutes().filter(({ endpoint }) => endpoint.group === 'Consent');
  expect(routes.map(({ endpoint }) => endpoint)).toEqual(expected);
  for (const endpoint of expected) {
    expect(endpoints.filter((described) => described.operationId === endpoint.operationId)).toEqual(
      [endpoint],
    );
  }
});

it('serves the bell’s six endpoints once each, and none of them through a command', () => {
  const routes = apiRoutes().filter(({ endpoint }) => endpoint.group === 'Notifications');
  expect(routes.map(({ endpoint }) => endpoint)).toEqual([...notificationEndpoints]);
  // Your own notifications and preferences need no permission: a route with a command would
  // be refused for a role that lacks its permission.
  expect(routes.filter(({ command }) => command !== undefined)).toEqual([]);
});

it('prevents caching and referrer propagation of a returned signing secret', async () => {
  const db = connectDatabase({
    connectionString: config.databaseAppUrl,
    onConnectionError: () => undefined,
  });
  const server = await buildServer({
    config: {
      ...config,
      devTenantContext: {
        agencyId: '01890a5d-ac96-774b-bcce-b302099a8057',
        businessId: '01890a5d-ac96-774b-bcce-b302099a8058',
        userId: '01890a5d-ac96-774b-bcce-b302099a8059',
      },
    },
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes: [
      {
        endpoint: rotateAutomationWebhookSecret,
        run: () =>
          Promise.resolve({
            secret: 'synthetic-once-only-secret',
            rotatedAt: '2026-10-09T00:00:00Z',
          }),
      },
    ],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
  });
  try {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/automations/webhook-signing/rotate',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('secret', 'synthetic-once-only-secret');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  } finally {
    await server.close(1000);
    await db.destroy();
  }
});
