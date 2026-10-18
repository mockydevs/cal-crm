import { allowEveryone } from '@repo/commands';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDatabase } from '@repo/db';
import type { SmsWebhookAcceptance, SmsWebhookRequest } from '@repo/module-messaging';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer, type Server } from './server.js';
import type { SmsWebhookTransport } from './sms-webhooks.js';
import { loggerOptions } from './logger.js';

const config: Config = {
  nodeEnv: 'test',
  role: 'app',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  databaseAppUrl: 'postgres://crm_app@127.0.0.1:1/crm',
  databaseWorkerUrl: undefined,
  databasePoolSize: 1,
  shutdownTimeoutMs: 2000,
  dashboardDir: undefined,
  devTenantContext: undefined,
  publicUrl: 'https://crm.example.test',
  mail: undefined,
  authentication: undefined,
  trustProxy: [],
  files: undefined,
  vault: undefined,
};

const running: { server: Server; db: ReturnType<typeof connectDatabase> }[] = [];
afterEach(async () => {
  for (const { server, db } of running.splice(0)) {
    await server.close(2000);
    await db.destroy();
  }
});

async function webhookServer(
  accept: SmsWebhookTransport['accept'],
  logger = pino({ level: 'silent' }),
  serverConfig = config,
) {
  const db = connectDatabase({
    connectionString: config.databaseAppUrl,
    onConnectionError: () => undefined,
  });
  const options = {
    config: serverConfig,
    serveApi: true,
    logger,
    routes: [],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
    smsWebhooks: { accept },
  };
  const server = await buildServer(options);
  running.push({ server, db });
  return server;
}

const token = 'A'.repeat(43);
const inboundUrl = `/webhooks/twilio/${token}/inbound`;
const headers = {
  'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
  'x-twilio-signature': 'B'.repeat(27) + '=',
};

describe('public SMS webhook HTTP boundary', () => {
  it('passes inbound bytes unchanged to durable intake and exposes no stored identifier', async () => {
    const seen: SmsWebhookRequest[] = [];
    const server = await webhookServer((request) => {
      seen.push(request);
      return Promise.resolve({ outcome: 'accepted', webhookId: 'private-row-id' });
    });
    const body = Buffer.from('Body=++hello%20%2B%20world++&From=%2B15551234567&Body=second');
    const response = await server.app.inject({
      method: 'POST',
      url: inboundUrl,
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<Response/>');
    expect(response.headers['content-type']).toMatch(/^text\/xml/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ token, endpoint: { kind: 'inbound' } });
    expect(Buffer.from(seen[0]?.body ?? [])).toEqual(body);
  });

  it('passes the canonical status callback message identifier without trusting the request host', async () => {
    const seen: SmsWebhookRequest[] = [];
    const server = await webhookServer((request) => {
      seen.push(request);
      return Promise.resolve({ outcome: 'accepted', webhookId: 'private-row-id' });
    });
    const messageId = '019a1c2e-7f00-7000-8000-000000000003';
    const response = await server.app.inject({
      method: 'POST',
      url: `/webhooks/twilio/${token}/status?m=${messageId}`,
      headers: { ...headers, host: 'attacker.example', 'x-forwarded-host': 'attacker.example' },
      payload: 'MessageStatus=delivered',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<Response/>');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ token, endpoint: { kind: 'status', messageId } });
  });

  it('fails closed when durable intake fails without exposing the URL, body or exception in logs', async () => {
    const lines: string[] = [];
    const logger = pino(loggerOptions({ logLevel: 'info' }), {
      write(line: string) {
        lines.push(line);
      },
    });
    const server = await webhookServer(() => {
      throw new Error(`database refused private-secret ${token} private-body`);
    }, logger);
    const response = await server.app.inject({
      method: 'POST',
      url: inboundUrl,
      headers,
      payload: 'Body=private-body',
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).not.toMatch(/private-secret|private-body/);
    expect(lines.join('')).not.toMatch(/private-secret|private-body/);
    expect(lines.join('')).not.toContain(token);
  });

  it.each([
    ['unknown', 404],
    ['refused', 400],
    ['over_capacity', 503],
  ] as const)(
    'reports %s without an accepted response or internal identifier',
    async (outcome, status) => {
      const result: SmsWebhookAcceptance = { outcome };
      const server = await webhookServer(() => Promise.resolve(result));
      const response = await server.app.inject({
        method: 'POST',
        url: inboundUrl,
        headers,
        payload: 'Body=hello',
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).toBe('');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    },
  );

  it.each([
    `${inboundUrl}?extra=1`,
    `/webhooks/twilio/${token}/status`,
    `/webhooks/twilio/${token}/status?m=not-a-message`,
    `/webhooks/twilio/${token}/status?m=019a1c2e-7f00-7000-8000-000000000003&extra=1`,
    `/webhooks/twilio/${token}/status?m=019a1c2e-7f00-7000-8000-000000000003&m=019a1c2e-7f00-7000-8000-000000000003`,
    `/webhooks/twilio/${token}/status?%6d=019a1c2e-7f00-7000-8000-000000000003`,
    `/webhooks/twilio/${token}/status?m=%3019a1c2e-7f00-7000-8000-000000000003`,
    `/webhooks/twilio/%41${token.slice(1)}/inbound`,
  ])(
    'stores nothing for a callback URL the signature worker cannot reconstruct: %s',
    async (url) => {
      let calls = 0;
      const server = await webhookServer(() => {
        calls += 1;
        return Promise.resolve({ outcome: 'accepted', webhookId: 'private-row-id' });
      });
      const response = await server.app.inject({
        method: 'POST',
        url,
        headers,
        payload: 'Body=hello',
      });
      expect(response.statusCode).toBe(400);
      expect(calls).toBe(0);
      expect(response.body).not.toContain(token);
    },
  );

  it.each(['application/json', 'text/plain', 'application/x-www-form-urlencoded+json'])(
    'does not admit %s payloads',
    async (contentType) => {
      let calls = 0;
      const server = await webhookServer(() => {
        calls += 1;
        return Promise.resolve({ outcome: 'accepted', webhookId: 'private-row-id' });
      });
      const response = await server.app.inject({
        method: 'POST',
        url: inboundUrl,
        headers: { ...headers, 'content-type': contentType },
        payload: '{}',
      });
      expect(response.statusCode).toBe(415);
      expect(calls).toBe(0);
      expect(response.body).not.toContain(token);
    },
  );

  it('does not serve the dashboard for an unknown webhook URL requesting HTML', async () => {
    const dashboardDir = mkdtempSync(join(tmpdir(), 'crm-sms-http-dashboard-'));
    writeFileSync(join(dashboardDir, 'index.html'), '<h1>Dashboard fallback</h1>');
    const server = await webhookServer(
      () => Promise.resolve({ outcome: 'accepted', webhookId: 'private-row-id' }),
      pino({ level: 'silent' }),
      { ...config, dashboardDir },
    );
    const response = await server.app.inject({
      method: 'GET',
      url: `/webhooks/twilio/${token}/unknown`,
      headers: { accept: 'text/html' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Dashboard fallback');
    expect(response.body).not.toContain(token);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    [65_536, 200, 1],
    [65_537, 413, 0],
  ] as const)(
    'enforces the raw-body limit at %i bytes before durable intake',
    async (size, status, expectedCalls) => {
      const seen: SmsWebhookRequest[] = [];
      const server = await webhookServer((request) => {
        seen.push(request);
        return Promise.resolve({ outcome: 'accepted', webhookId: 'private-row-id' });
      });
      const body = Buffer.alloc(size, 97);
      const response = await server.app.inject({
        method: 'POST',
        url: inboundUrl,
        headers,
        payload: body,
      });
      expect(response.statusCode).toBe(status);
      expect(seen).toHaveLength(expectedCalls);
      if (status === 200) expect(Buffer.from(seen[0]?.body ?? [])).toEqual(body);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(token);
    },
  );

  it.each(['GET', 'HEAD', 'PUT'] as const)(
    'does not admit the unsupported %s method',
    async (method) => {
      let calls = 0;
      const server = await webhookServer(() => {
        calls += 1;
        return Promise.resolve({ outcome: 'accepted', webhookId: 'private-row-id' });
      });
      const response = await server.app.inject({ method, url: inboundUrl, headers });
      expect(response.statusCode).toBe(404);
      expect(calls).toBe(0);
      expect(response.body).not.toContain(token);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );
});
