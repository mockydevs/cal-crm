// The first start, on a fresh Compose stack from compose.yml, as an install runs it beside
// an empty external Postgres: migrate bootstraps it through DATABASE_ADMIN_URL, migrates and
// makes the agency, and app prints a setup link that makes the first admin once. Starting
// again changes nothing. Uses SERVER_IMAGE when set (CI's image job); otherwise it builds
// the image from the Dockerfile first.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DockerComposeEnvironment,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const PUBLIC_URL = 'https://crm.example.test';
const project = `crm-first-start-${randomBytes(4).toString('hex')}`;

let image: string;
let stack: StartedDockerComposeEnvironment;
/** The vault's keys, made as install.env.example says: SECRETS_KEYS and SECRETS_PUBLIC_KEY. */
let vaultKeys: Record<string, string>;

/** The install's settings, as install.env would give them. */
const settings = () => ({
  CRM_IMAGE: image,
  AGENCY_NAME: 'Bluebird Digital',
  PUBLIC_URL,
  TEST_POSTGRES_PASSWORD: 'postgrestestonly',
  DATABASE_HOST: 'postgres',
  DATABASE_ADMIN_URL: 'postgres://postgres:postgrestestonly@postgres:5432/postgres',
  CRM_OWNER_PASSWORD: 'ownertestonly',
  CRM_APP_PASSWORD: 'apptestonly',
  CRM_AUTH_PASSWORD: 'authtestonly',
  CRM_WORKER_PASSWORD: 'workertestonly',
  AUTH_SECRET: 'a-test-secret-that-is-at-least-32-characters-long',
  FILES_LINK_SECRET: 'a-files-link-secret-of-32-characters-or-more',
  // Files are never uploaded here, and nothing asks the storage anything at start.
  FILES_S3_ENDPOINT: 'http://files.invalid:9000',
  FILES_S3_BUCKET: 'crm-files',
  FILES_S3_ACCESS_KEY_ID: 'test-only',
  FILES_S3_SECRET_ACCESS_KEY: 'test-only',
  SMTP_URL: 'smtp://127.0.0.1:1',
  MAIL_FROM: 'Bluebird Digital <crm@bluebird.example>',
  TRUST_PROXY: '',
  ...vaultKeys,
});

/** Starts the stack (again), waiting for migrate to finish and app and worker to be healthy. */
const up = () =>
  new DockerComposeEnvironment(repoRoot, [
    'compose.yml',
    'apps/server/test/compose.database.yml',
    'apps/server/test/compose.publish.yml',
  ])
    .withProjectName(project)
    .withEnvironment(settings())
    .withWaitStrategy('postgres-1', Wait.forHealthCheck())
    .withWaitStrategy('migrate-1', Wait.forOneShotStartup())
    .withWaitStrategy('app-1', Wait.forHealthCheck())
    .withWaitStrategy('worker-1', Wait.forHealthCheck())
    .withStartupTimeout(240_000)
    .up();

/** A service's output, since a time when given: a restarted container keeps its old logs. */
const logsOf = async (service: string, since?: Date): Promise<string> => {
  const { stdout, stderr } = await run(
    'docker',
    [
      'logs',
      ...(since === undefined ? [] : ['--since', since.toISOString()]),
      // By Compose's name: the stack knows only running containers, and migrate has exited.
      `${project}-${service}`,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return `${stdout}${stderr}`;
};

function jsonOf(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const logLine = z.looseObject({ setupLink: z.string() });

/** The setup links app printed, from its JSON log lines. */
const setupLinks = (logs: string): string[] =>
  logs.split('\n').flatMap((line) => {
    const parsed = logLine.safeParse(jsonOf(line));
    return parsed.success ? [parsed.data.setupLink] : [];
  });

/** Counts in the install's database, read as Postgres's superuser. */
async function counts(): Promise<Record<string, string>> {
  const result = await stack.getContainer('postgres-1').exec([
    'psql',
    '-U',
    'postgres',
    '-d',
    'crm',
    '-tA',
    '-F',
    '=',
    '-c',
    `select 'agencies', count(*) from tenancy.agencies
       union all select 'roles', count(*) from tenancy.roles
       union all select 'users', count(*) from auth.users
       union all select 'memberships', count(*) from tenancy.memberships
       union all select 'migrations', count(*) from util.applied_migrations`,
  ]);
  expect(result.exitCode, result.output).toBe(0);
  return Object.fromEntries(
    result.output
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
}

/** A request to app, as a page of the install would send it. */
const api = (
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> => {
  const app = stack.getContainer('app-1');
  return fetch(`http://${app.getHost()}:${String(app.getMappedPort(3000))}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL, ...init.headers },
  });
};

beforeAll(async () => {
  image = process.env['SERVER_IMAGE'] ?? 'crm-server:test';
  const build = (...args: string[]) =>
    run('docker', ['build', ...args, repoRoot], { maxBuffer: 64 * 1024 * 1024 });
  if (process.env['SERVER_IMAGE'] === undefined) await build('--tag', image);
  const { stdout } = await run('docker', [
    'run',
    '--rm',
    image,
    'node',
    'dist/vault.js',
    'new-key',
    '1',
  ]);
  vaultKeys = Object.fromEntries(
    [...stdout.matchAll(/^(SECRETS_KEYS|SECRETS_PUBLIC_KEY)=(\S+)$/gm)].map(([, name, value]) => [
      name ?? '',
      value ?? '',
    ]),
  );
  stack = await up();
});

afterAll(async () => {
  await stack.down({ removeVolumes: true });
});

describe('the first start', () => {
  let token = '';

  it('bootstraps, migrates, makes the agency, and prints a setup link', async () => {
    const migrate = await logsOf('migrate-1');
    expect(migrate).toContain('Created the roles and the database on the Postgres server.');
    expect(migrate).toContain('Applied 0001_foundation.sql');
    expect(migrate).toContain('Created the agency Bluebird Digital, with its built-in roles.');
    const links = setupLinks(await logsOf('app-1'));
    expect(links).toHaveLength(1);
    const link = new URL(links[0] ?? '');
    expect(`${link.origin}${link.pathname}`).toBe(`${PUBLIC_URL}/setup`);
    token = link.searchParams.get('token') ?? '';
    expect(await counts()).toMatchObject({ agencies: '1', roles: '7', users: '0' });
  });

  it('makes the first admin from the link, once', async () => {
    const body = (email: string) =>
      JSON.stringify({
        token,
        name: 'Clare Walsh',
        email,
        password: 'correct horse battery staple',
      });

    expect(await (await api(`/api/auth/setup?token=${token}`)).json()).toEqual({ valid: true });
    const created = await api('/api/auth/setup', {
      method: 'POST',
      body: body('clare@bluebird.example'),
    });
    expect(created.status).toBe(200);
    const cookie = created.headers
      .getSetCookie()
      .map((each) => each.split(';')[0] ?? '')
      .join('; ');
    const session = z
      .object({ user: z.looseObject({ email: z.string() }) })
      .parse(await (await api('/api/auth/get-session', { headers: { cookie } })).json());
    expect(session.user.email).toBe('clare@bluebird.example');

    const again = await api('/api/auth/setup', {
      method: 'POST',
      body: body('mallory@example.com'),
    });
    expect(again.status).toBe(403);
    expect(await (await api(`/api/auth/setup?token=${token}`)).json()).toEqual({ valid: false });
  });

  it('changes nothing when the install starts again', async () => {
    const before = await counts();
    await stack.stop();
    const restarted = new Date();

    stack = await up();

    expect(await counts()).toEqual(before);
    const migrate = await logsOf('migrate-1', restarted);
    expect(migrate).not.toContain('Applied ');
    expect(migrate).toContain(
      'The roles and the database are already on the Postgres server; nothing to create.',
    );
    expect(migrate).toContain('The agency is already here; nothing to create.');
    expect(setupLinks(await logsOf('app-1', restarted))).toEqual([]);
  });
});
