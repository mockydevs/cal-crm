// Runs the built server as a process, the way the container does: node --import
// ./dist/instrumentation.js dist/main.js.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDatabase } from '@repo/testing';
import { afterEach, describe, expect, inject, it } from 'vitest';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const children: ChildProcess[] = [];

// What the app role needs to sign people in, keep files and seal secrets; nothing here
// connects to it.
const signIn = {
  PUBLIC_URL: 'http://127.0.0.1',
  DATABASE_AUTH_URL: 'postgres://crm_auth@127.0.0.1:1/crm',
  AUTH_SECRET: 'a-test-secret-that-is-at-least-32-characters-long',
  SMTP_URL: 'smtp://127.0.0.1:1',
  MAIL_FROM: 'crm@bluebird.example',
  FILES_DIR: join(tmpdir(), 'crm-process-files'),
  FILES_LINK_SECRET: 'a-files-link-secret-of-32-characters-or-more',
  SECRETS_PUBLIC_KEY: '1:public-t-e6gRqjLUQ4UM7RYCMR4JA7W9P_LWS0JxazOyop7GE',
};

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

interface Started {
  readonly child: ChildProcess;
  readonly output: () => string;
}

function run(env: Record<string, string>): Started {
  let output = '';
  const child = spawn(
    process.execPath,
    ['--import', './dist/instrumentation.js', 'dist/main.js'],
    // Only what the test sets, so nothing from the developer's environment leaks in.
    { cwd: serverRoot, env: { PATH: process.env['PATH'] ?? '', ...env } },
  );
  children.push(child);
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { child, output: () => output };
}

/**
 * How long a wait may hang before the test gives up on it. Not how long anything takes: a
 * process that cannot go on exits, and that ends the wait at once, with what it wrote. Only
 * a process that neither does what is waited for nor exits is left to this.
 */
const HANG_MS = 120_000;

/**
 * Waits for what the process is to do: over when it has done it, or when the process has
 * gone without doing it. How fast the machine is does not come into it.
 */
async function eventually(
  { child, output }: Started,
  what: string,
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  const hung = Date.now() + HANG_MS;
  while (!(await check())) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`The process exited before ${what}:\n${output()}`);
    if (Date.now() > hung)
      throw new Error(
        `The process neither exited nor, in ${String(HANG_MS / 1000)} seconds, got to where ${what}:\n${output()}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const reachable = (url: string) => () =>
  fetch(url).then(
    () => true,
    () => false,
  );

describe('the server process', () => {
  it('refuses to start with an invalid configuration, naming every problem', async () => {
    const { child, output } = run({ ROLE: 'web', PORT: '99999' });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    expect(code).toBe(1);
    expect(output()).toContain("The server's configuration is invalid:");
    for (const variable of ['ROLE', 'PORT', 'DATABASE_APP_URL']) {
      expect(output()).toContain(`  ${variable}: `);
    }
  });

  it(
    'logs JSON, and sends no telemetry when none is configured',
    async () => {
      const port = await freePort();
      const started = run({
        ROLE: 'app',
        PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_APP_URL: 'postgres://crm_app@127.0.0.1:1/crm',
        ...signIn,
      });
      const { output } = started;
      await eventually(
        started,
        'it answered /health',
        reachable(`http://127.0.0.1:${String(port)}/health`),
      );

      const firstLine = output().split('\n')[0] ?? '';
      expect(JSON.parse(firstLine)).toMatchObject({ level: 30 });
      expect(output()).not.toContain('trace_id');
    },
    HANG_MS + 60_000,
  );

  it(
    'traces requests, database calls and log lines when an exporter is configured',
    async () => {
      const port = await freePort();
      const started = run({
        ROLE: 'app',
        PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_APP_URL: 'postgres://crm_app@127.0.0.1:1/crm',
        ...signIn,
        OTEL_TRACES_EXPORTER: 'console',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_BSP_SCHEDULE_DELAY: '100',
        LOG_LEVEL: 'debug',
        OTEL_LOG_LEVEL: 'debug',
      });
      const { output } = started;
      const base = `http://127.0.0.1:${String(port)}`;
      await eventually(started, 'it answered /health', reachable(`${base}/health`));
      await fetch(`${base}/ready`);

      // Spans arrive in batches: the database span ends before the request's span does.
      const expected = ["name: 'pg.connect'", "name: 'GET /ready'", "name: '@fastify/otel'"];
      await eventually(started, 'it wrote the spans of GET /ready', () =>
        expected.every((span) => output().includes(span)),
      );
      expect(output()).toMatch(/"trace_id":"[0-9a-f]{32}"/);
      const capability = 'sentinel-capability-' + 'x'.repeat(24);
      const before = output();
      await fetch(`${base}/unsubscribe/${capability}`);
      await fetch(`${base}/unsubscribe/${capability}/extra`);
      // The later ordinary request's span flushes the preceding public requests too.
      await fetch(`${base}/health?after-optout`);
      await eventually(started, 'it wrote the span of the request after the opt-out', () =>
        output().slice(before.length).includes('after-optout'),
      );
      expect(output().slice(before.length)).not.toContain(capability);
    },
    3 * HANG_MS + 60_000,
  );
});

describe('the worker process', () => {
  it(
    'exits when its worker stops by itself, so that it is restarted',
    async () => {
      const database = await testDatabase(inject('databaseServer'));
      try {
        const port = await freePort();
        const started = run({
          ROLE: 'worker',
          PORT: String(port),
          HOST: '127.0.0.1',
          DATABASE_APP_URL: database.url('crm_app'),
          DATABASE_WORKER_URL: database.url('crm_worker'),
          PUBLIC_URL: 'http://127.0.0.1',
          SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
        });
        const { child, output } = started;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        await eventually(
          started,
          'it answered /health',
          reachable(`http://127.0.0.1:${String(port)}/health`),
        );

        // As when a newer release migrates the queue. Sent until heard: the worker starts
        // listening a moment after it starts. Here the exit is what is waited for, so only a
        // worker that never hears it is left to the bound.
        const deaf = Date.now() + HANG_MS;
        while (child.exitCode === null) {
          if (Date.now() > deaf)
            throw new Error(
              `The worker did not stop in ${String(HANG_MS / 1000)} seconds of being told the queue was migrated:\n${output()}`,
            );
          await database.as('crm_owner', (sql) =>
            sql.query(
              `select pg_notify('worker:migrate', '{"migrationNumber": 999, "breaking": true}')`,
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(await exited).toBe(1);
        expect(output()).toContain('the worker stopped by itself');
      } finally {
        await database.close();
      }
    },
    2 * HANG_MS + 60_000,
  );
});
