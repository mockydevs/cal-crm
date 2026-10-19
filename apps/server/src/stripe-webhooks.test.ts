import { Writable } from 'node:stream';

import { allowEveryone } from '@repo/commands';
import { connectDatabase } from '@repo/db';
import { pino } from 'pino';
import { afterEach, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { loggerOptions } from './logger.js';
import { buildServer, type Server } from './server.js';
import type { StripeWebhookTransport } from './stripe-webhooks.js';

const config: Config = {
  nodeEnv: 'test',
  role: 'app',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'info',
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
const token = Buffer.alloc(32, 7).toString('base64url');
const body = '{"id":"evt_1","type":"checkout.session.completed","data":{"object":{}}}';
const signature = 't=1792410079,v1=' + 'a'.repeat(64);

const servers: Server[] = [];
const databases: ReturnType<typeof connectDatabase>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function start(accept: StripeWebhookTransport['accept'], serveApi = true) {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  const db = connectDatabase({
    connectionString: config.databaseAppUrl,
    onConnectionError: () => undefined,
  });
  databases.push(db);
  const server = await buildServer({
    config,
    logger: pino(loggerOptions(config), stream),
    serveApi,
    routes: [],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
    stripeWebhooks: { accept },
  });
  servers.push(server);
  return { app: server.app, logs };
}

const post = (headers: Record<string, string> = {}, payload = body) => ({
  method: 'POST' as const,
  url: `/webhooks/stripe/${token}`,
  headers: { 'content-type': 'application/json', 'stripe-signature': signature, ...headers },
  payload,
});

it('keeps the body exactly as Stripe sent it, with the signature header, and answers 200', async () => {
  const accept = vi.fn<StripeWebhookTransport['accept']>().mockResolvedValue('accepted');
  const { app } = await start(accept);
  // Spacing a JSON parser would drop must reach the signature check as it was.
  const spaced = '{ "id" : "evt_1" ,\n "type":"checkout.session.completed" }';
  const response = await app.inject(post({}, spaced));
  expect(response.statusCode).toBe(200);
  const [request] = accept.mock.calls[0] ?? [];
  expect(request?.token).toBe(token);
  expect(request?.signature).toBe(signature);
  expect(Buffer.from(request?.body ?? []).toString()).toBe(spaced);
});

it.each([
  ['unknown', 404],
  ['refused', 400],
  ['over_capacity', 503],
] as const)(
  'answers %s with %i, so Stripe tries again only when it is worth it',
  async (outcome, status) => {
    const { app } = await start(
      vi.fn<StripeWebhookTransport['accept']>().mockResolvedValue(outcome),
    );
    expect((await app.inject(post())).statusCode).toBe(status);
  },
);

it('refuses another kind of body or one too large before anything is kept', async () => {
  const accept = vi.fn<StripeWebhookTransport['accept']>().mockResolvedValue('accepted');
  const { app } = await start(accept);
  expect((await app.inject(post({ 'content-type': 'text/plain' }))).statusCode).toBe(415);
  expect((await app.inject(post({}, `{"x":"${'a'.repeat(262_200)}"}`))).statusCode).toBe(413);
  expect(accept).not.toHaveBeenCalled();
});

it('answers 503 and logs neither the token nor the error when intake fails', async () => {
  const { app, logs } = await start(
    vi.fn<StripeWebhookTransport['accept']>().mockRejectedValue(new Error(`db down ${token}`)),
  );
  expect((await app.inject(post())).statusCode).toBe(503);
  const logged = logs.join('');
  expect(logged).toContain('Stripe intake unavailable');
  expect(logged).not.toContain(token);
  expect(logged).not.toContain('db down');
});

it('mounts nothing for a role that does not serve the API', async () => {
  const accept = vi.fn<StripeWebhookTransport['accept']>().mockResolvedValue('accepted');
  const { app } = await start(accept, false);
  expect((await app.inject(post())).statusCode).toBe(404);
  expect(accept).not.toHaveBeenCalled();
});
