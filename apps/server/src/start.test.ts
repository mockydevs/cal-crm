import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSecretsKey, parseSecretsPublicKey, SecretsKeyError } from '@repo/module-vault';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { start, type Running } from './start.js';
import { workerTasks } from './worker-tasks.js';

// Nothing listens on port 1, so the database counts as down.
const unreachable = (role: string) => `postgres://${role}@127.0.0.1:1/crm`;

const config: Config = {
  nodeEnv: 'test',
  role: 'app',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  databaseAppUrl: unreachable('crm_app'),
  databaseWorkerUrl: undefined,
  databasePoolSize: 1,
  shutdownTimeoutMs: 2000,
  dashboardDir: undefined,
  devTenantContext: undefined,
  publicUrl: 'https://crm.example.test',
  mail: { smtpUrl: 'smtp://127.0.0.1:1', from: 'crm@bluebird.example' },
  authentication: {
    databaseUrl: unreachable('crm_auth'),
    secret: 'a-test-secret-that-is-at-least-32-characters-long',
  },
  trustProxy: [],
  files: {
    storage: { kind: 'local', directory: mkdtempSync(join(tmpdir(), 'crm-start-files-')) },
    maxBytes: 1024,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  },
  vault: undefined,
};

const running: Running[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((each) => each.stop()));
});

describe('start', () => {
  it('mounts the configured app-only voice relay and fails closed when its worker is down', async () => {
    const app = await start({ ...config, voiceWorkerOrigin: 'http://127.0.0.1:1' }, [], []);
    running.push(app);
    const response = await fetch(
      `${app.address}/webhooks/twilio/voice/${'a'.repeat(43)}/progress`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': 'synthetic',
        },
        body: 'CallStatus=ringing',
      },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses a selected mailbox without vault keys instead of silently using bootstrap SMTP', async () => {
    const starting = start(
      { ...config, systemMailbox: '019a1c2e-7f00-7000-8000-000000000003' },
      [],
      [],
    ).then((app) => {
      running.push(app);
      return app;
    });
    await expect(starting).rejects.toThrow('A selected system mailbox requires vault keys.');
  });
  it('serves the API in the app role, and reports the database as not ready', async () => {
    const app = await start(config, apiRoutes, workerTasks);
    running.push(app);

    expect((await fetch(`${app.address}/health`)).status).toBe(200);
    const ready = await fetch(`${app.address}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'unavailable', failed: ['database', 'realtime'] });
    expect((await fetch(`${app.address}/api/v1/openapi.json`)).status).toBe(200);
  });

  it('mounts public booking with its configured shared limiter and fails closed when storage is down', async () => {
    const app = await start(
      { ...config, publicIntake: { secret: 'public-intake-test-key-with-at-least-32-bytes' } },
      apiRoutes,
      workerTasks,
    );
    running.push(app);
    const token = Buffer.alloc(32, 11).toString('base64url');
    for (const path of [
      '/api/v1/public/book/agency/business/calendar',
      `/api/v1/public/appointments/${token}/slots?date=2026-10-10`,
    ]) {
      const response = await fetch(`${app.address}${path}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        detail: 'Booking is temporarily unavailable. Try again later.',
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('keeps public booking unmounted without the shared limiter secret', async () => {
    const app = await start(config, apiRoutes, workerTasks);
    running.push(app);
    expect((await fetch(`${app.address}/api/v1/public/book/agency/business/calendar`)).status).toBe(
      401,
    );
  });

  it("mounts a document's public address only with the intake secret, and fails closed when storage is down", async () => {
    const token = Buffer.alloc(32, 11).toString('base64url');
    const withSecret = await start(
      { ...config, publicIntake: { secret: 'public-intake-test-key-with-at-least-32-bytes' } },
      apiRoutes,
      workerTasks,
    );
    running.push(withSecret);
    for (const path of [`/d/${token}`, `/d/${token}/pdf`]) {
      const response = await fetch(`${withSecret.address}${path}`);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(await response.text()).toBe(
        'This document is temporarily unavailable. Try again later.',
      );
    }

    // Without the secret the install serves no public page of any kind.
    const without = await start(config, apiRoutes, workerTasks);
    running.push(without);
    const response = await fetch(`${without.address}/d/${token}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-robots-tag')).toBeNull();
    expect(await response.text()).not.toContain(token);
  });

  it('mounts SMS quarantine intake in the app role and refuses unsigned requests before storage', async () => {
    const app = await start(config, apiRoutes, workerTasks);
    running.push(app);
    const response = await fetch(`${app.address}/webhooks/twilio/${'A'.repeat(43)}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Body=hello',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.text()).toBe('');
  });

  // The download route answers without a session; anything else under /api/v1 needs one.
  it('serves downloads by link when files are configured', async () => {
    const app = await start(config, apiRoutes, workerTasks);
    running.push(app);

    const download = await fetch(`${app.address}/api/v1/files/not-a-file/content`);

    expect(download.status).toBe(404);
    expect(await download.json()).toMatchObject({ detail: "There's no such file." });
  });

  it("serves no downloads when files aren't configured", async () => {
    const app = await start(
      { ...config, files: undefined, authentication: undefined },
      apiRoutes,
      workerTasks,
    );
    running.push(app);

    const download = await fetch(`${app.address}/api/v1/files/not-a-file/content`);

    expect(download.status).toBe(401);
  });

  it("refuses to start a role that runs the worker when the job queue can't be reached", async () => {
    for (const role of ['worker', 'all'] as const) {
      await expect(
        start({ ...config, role, databaseWorkerUrl: unreachable('crm_worker') }, [], []),
      ).rejects.toThrow("The worker couldn't start the job queue");
    }
  });

  it("checks the vault's key at start, and refuses one that can't seal", async () => {
    const usable = parseSecretsPublicKey((await newSecretsKey(1)).publicKey);
    const app = await start(
      { ...config, vault: { holds: 'public', publicKey: usable } },
      apiRoutes,
      workerTasks,
    );
    running.push(app);

    const schema = await fetch(`${app.address}/api/v1/openapi.json`);
    expect(await schema.json()).toMatchObject({
      paths: {
        '/mailbox-connection-attempts': { post: { operationId: 'connectMailbox' } },
        '/mailboxes': { get: { operationId: 'listMailboxes' } },
      },
    });

    // The all-zero X25519 public key is a low-order point: nothing sealed with it opens.
    const unusable = { version: 1, publicKey: new Uint8Array(32) };
    await expect(
      start({ ...config, vault: { holds: 'public', publicKey: unusable } }, apiRoutes, workerTasks),
    ).rejects.toThrow(SecretsKeyError);
  });

  it('stops, and then refuses connections', async () => {
    const app = await start(config, [], []);
    await app.stop();
    await expect(fetch(`${app.address}/health`)).rejects.toThrow();
  });
});
