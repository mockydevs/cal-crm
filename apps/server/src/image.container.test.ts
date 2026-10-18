// The image, run the way Coolify runs it: each role against Postgres, health and readiness,
// and a clean stop on SIGTERM. Uses SERVER_IMAGE when set (CI's image job); otherwise it
// builds the Dockerfile first.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const docker = async (...args: string[]): Promise<string> =>
  (await run('docker', args)).stdout.trim();
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
// Read from the source tree: CI's image job builds the image, not the workspace packages.
const bootstrapFile = join(repoRoot, 'packages/db/bootstrap/0001_roles_and_database.sql');
const PASSWORD = 'test-only';
const url = (role: string) => `postgres://${role}:${PASSWORD}@db:5432/crm`;

let image: string;
let network: StartedNetwork;
/**
 * The vault's keys, made by the image's own command as a new install makes them (production
 * refuses .env.example's): what it printed for SECRETS_KEYS and SECRETS_PUBLIC_KEY.
 */
let newKey: string;
let keys: { secretsKey: string; publicKey: string };
let database: StartedTestContainer;

beforeAll(async () => {
  image = process.env['SERVER_IMAGE'] ?? 'crm-server:test';
  if (process.env['SERVER_IMAGE'] === undefined) {
    await run('docker', ['build', '--tag', image, repoRoot], { maxBuffer: 64 * 1024 * 1024 });
  }
  ({ stdout: newKey } = await run('docker', [
    'run',
    '--rm',
    image,
    'node',
    'dist/vault.js',
    'new-key',
    '1',
  ]));
  const printed = (name: string) => new RegExp(`^${name}=(\\S+)$`, 'm').exec(newKey)?.[1] ?? '';
  keys = { secretsKey: printed('SECRETS_KEYS'), publicKey: printed('SECRETS_PUBLIC_KEY') };
  network = await new Network().start();
  database = await new GenericContainer('pgvector/pgvector:pg18')
    .withNetwork(network)
    .withNetworkAliases('db')
    .withEnvironment({ POSTGRES_PASSWORD: PASSWORD })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  // The install bootstrap, then the migrations, run from the image as a deploy runs them.
  await database.copyContentToContainer([
    { content: await readFile(bootstrapFile), target: '/tmp/bootstrap.sql' },
  ]);
  const bootstrap = await database.exec([
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    ...['owner', 'app', 'auth', 'worker'].flatMap((role) => ['-v', `${role}_password=${PASSWORD}`]),
    '-U',
    'postgres',
    '-f',
    '/tmp/bootstrap.sql',
  ]);
  expect(bootstrap.exitCode, bootstrap.output).toBe(0);
  const migrate = await new GenericContainer(image)
    .withNetwork(network)
    .withEnvironment({ DATABASE_OWNER_URL: url('crm_owner') })
    .withCommand(['node', 'node_modules/@repo/db/dist/bin.js'])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start();
  await migrate.stop();
});

afterAll(async () => {
  await database.stop();
  await network.stop();
});

function server(role: string): Promise<StartedTestContainer> {
  return new GenericContainer(image)
    .withNetwork(network)
    .withEnvironment({
      ROLE: role,
      // The image runs in production, where the public address must be HTTPS.
      PUBLIC_URL: 'https://crm.example.test',
      DATABASE_APP_URL: url('crm_app'),
      ...(role === 'app'
        ? { SECRETS_PUBLIC_KEY: keys.publicKey }
        : { DATABASE_WORKER_URL: url('crm_worker'), SECRETS_KEYS: keys.secretsKey }),
      ...(role === 'worker'
        ? {}
        : {
            DATABASE_AUTH_URL: url('crm_auth'),
            AUTH_SECRET: 'a-test-secret-that-is-at-least-32-characters-long',
            SMTP_URL: 'smtp://127.0.0.1:1',
            MAIL_FROM: 'crm@bluebird.example',
            FILES_DIR: '/tmp/crm-files',
            FILES_LINK_SECRET: 'a-files-link-secret-of-32-characters-or-more',
          }),
    })
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forHttp('/health', 3000))
    .start();
}

const baseUrl = (container: StartedTestContainer): string =>
  `http://${container.getHost()}:${String(container.getMappedPort(3000))}`;

describe('the image', () => {
  it('serves the API and the dashboard in the app role', async () => {
    const app = await server('app');
    const base = baseUrl(app);

    expect(await (await fetch(`${base}/ready`)).json()).toEqual({ status: 'ready' });
    expect((await fetch(`${base}/api/v1/openapi.json`)).status).toBe(200);
    const page = await fetch(`${base}/inbox`, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    // Not signed in: the API refuses to act for anyone.
    expect((await fetch(`${base}/api/v1/tags`, { method: 'POST', body: '{}' })).status).toBe(401);
    await app.stop();
  });

  it('serves only health and readiness in the worker role', async () => {
    const worker = await server('worker');
    const base = baseUrl(worker);

    expect(await (await fetch(`${base}/ready`)).json()).toEqual({ status: 'ready' });
    expect((await fetch(`${base}/api/v1/openapi.json`)).status).toBe(404);
    await worker.stop();
  });

  it('runs as a non-root user, with tini passing signals on', async () => {
    const app = await server('app');
    const { output } = await app.exec(['ps', '-o', 'pid,user,args']);
    const pid1 = output.split('\n').find((line) => line.trim().startsWith('1 '));
    expect(pid1).toMatch(/^\s*1 node\s+\/sbin\/tini -- node /);
    await app.stop();
  });

  it('finishes a request in flight on SIGTERM, then exits cleanly', async () => {
    const app = await server('app');
    const base = baseUrl(app);

    // With Postgres paused, /ready waits on it: a request in flight.
    await docker('pause', database.getId());
    const inFlight = fetch(`${base}/ready`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const began = Date.now();
    const stopped = docker('stop', app.getId());
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await expect(
        fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }),
      ).rejects.toThrow();
    } finally {
      await docker('unpause', database.getId());
      // Even a failed assertion must let the request and Docker stop finish.
      await Promise.all([inFlight, stopped]);
    }

    expect((await inFlight).status).toBe(200);
    await stopped;
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(await docker('inspect', app.getId(), '--format', '{{.State.ExitCode}}')).toBe('0');
  });

  it("makes the vault's keys, as a new install does before its first start", () => {
    expect(newKey).toMatch(/^SECRETS_KEYS=1:private-[\w-]{43}$/m);
    expect(newKey).toMatch(/^SECRETS_PUBLIC_KEY=1:public-[\w-]{43}$/m);
  });

  it('refuses to start with an invalid configuration, naming every problem', async () => {
    const result = await run('docker', ['run', '--rm', '-e', 'ROLE=web', image]).then(
      () => ({ code: 0, stderr: '' }),
      (error: unknown) => error as { code: number; stderr: string },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The server's configuration is invalid:");
    expect(result.stderr).toContain('  ROLE: ');
    expect(result.stderr).toContain('  DATABASE_APP_URL: ');
  });
});
