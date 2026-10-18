import { allowEveryone } from '@repo/commands';
import {
  mailboxConnectionAttempt,
  mailboxList,
  mailboxSetup,
  mailboxSendingSettings,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { createMailboxConnector, type MailMessage } from '@repo/mail';
import {
  createMailboxRoutes,
  createVerifyMailboxTask,
  createSendInstallMailTask,
  createCheckMailboxTask,
} from '@repo/module-messaging';
import {
  createSealingVault,
  createVault,
  newSecretsKey,
  parseSecretsKeys,
  parseSecretsPublicKey,
} from '@repo/module-vault';
import {
  startGreenMail,
  testDatabase,
  type GreenMailServer,
  type TestDatabase,
} from '@repo/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { API_PREFIX, buildServer, type Server } from './server.js';
import type { Config } from './config.js';
import { start } from './start.js';
import { EXPIRE_MAILBOX_ATTEMPTS, startWorker, type Worker } from './worker/worker.js';

let database: TestDatabase;
let db: Database;
let server: Server;
let worker: Worker;
let mail: GreenMailServer;
let stopMail: (() => Promise<void>) | undefined;
let businessId: string;
let appConfig: Config;
const delivered: MailMessage[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  businessId = business.id;
  const keys = await newSecretsKey(1);
  const sealer = await createSealingVault(parseSecretsPublicKey(keys.publicKey));
  const vault = await createVault(parseSecretsKeys(keys.secretsKey));
  ({ server: mail, stop: stopMail } = await startGreenMail('localhost.test'));
  const services = { db, authorize: allowEveryone };
  const logger = pino({ level: 'silent' });
  appConfig = {
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
    devTenantContext: { agencyId: agency.id, businessId, userId: user.id },
    publicUrl: 'https://crm.example.test',
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault: { holds: 'public', publicKey: parseSecretsPublicKey(keys.publicKey) },
  };
  server = await buildServer({
    config: appConfig,
    logger,
    serveApi: true,
    routes: createMailboxRoutes(sealer),
    services,
    readinessChecks: {},
  });
  worker = await startWorker({
    connectionString: database.url('crm_worker'),
    services,
    logger,
    shutdownTimeoutMs: 1000,
    mailboxVault: sealer,
    tasks: [
      createCheckMailboxTask(
        vault,
        createMailboxConnector({
          ca: mail.ca,
          allowedPrivateHosts: ['localhost'],
          resolve: () => Promise.resolve([mail.address]),
        }),
        (_name, type) =>
          type === 'MX'
            ? Promise.resolve([{ exchange: 'mail.localhost.test', priority: 10 }])
            : Promise.reject(Object.assign(new Error('No fixture record.'), { code: 'ENODATA' })),
      ),
      createSendInstallMailTask(vault, {
        send: async (login, from, message) => {
          await createMailboxConnector({
            ca: mail.ca,
            allowedPrivateHosts: ['localhost'],
            resolve: () => Promise.resolve([mail.address]),
          }).send(login, from, message);
          delivered.push(message);
        },
      }),
      createVerifyMailboxTask(
        vault,
        createMailboxConnector({
          ca: mail.ca,
          allowedPrivateHosts: ['localhost'],
          resolve: () => Promise.resolve([mail.address]),
        }),
      ),
    ],
  });
});

afterAll(async () => {
  await worker.stop();
  await server.close(1000);
  await stopMail?.();
  await db.destroy();
  await database.close();
});

function input(email: string) {
  const login = {
    host: 'localhost',
    security: 'tls',
    username: mail.username,
    password: mail.password,
  };
  return {
    name: 'Work email',
    email,
    displayName: 'Fixture',
    smtp: { ...login, port: mail.smtpPort },
    imap: { ...login, port: mail.imapPort },
  };
}

it('connects through HTTP and the real job queue, and never returns the credentials', async () => {
  const response = await server.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/mailbox-connection-attempts`,
    payload: input('fixture@localhost.test'),
  });
  expect(response.statusCode, response.body).toBe(201);
  const pending = mailboxConnectionAttempt.parse(response.json());
  expect(pending.status).toBe('pending');
  await expect
    .poll(
      async () => {
        const status = await server.app.inject({
          method: 'GET',
          url: `${API_PREFIX}/mailbox-connection-attempts/${pending.id}`,
        });
        expect(status.statusCode).toBe(200);
        expect(status.body).not.toContain(mail.password);
        return mailboxConnectionAttempt.parse(status.json()).status;
      },
      { timeout: 15_000 },
    )
    .toBe('connected');
  const list = await server.app.inject({ method: 'GET', url: `${API_PREFIX}/mailboxes` });
  expect(list.statusCode).toBe(200);
  expect(mailboxList.parse(list.json()).data).toHaveLength(1);
  expect(list.body).not.toContain(mail.password);
  expect(list.body).not.toContain('secret_id');
  const id = parsePublicId('mailbox_attempt', pending.id);
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query<{ status: string; secret_id: string | null }>(
        'select status, secret_id from messaging.mailbox_connection_attempts where id=$1 and business_id=$2',
        [id, businessId],
      ),
    ),
  ).toEqual([{ status: 'connected', secret_id: null }]);
});

it('runs a requested setup check through HTTP and the real worker queue', async () => {
  const selected = mailboxList.parse(
    (await server.app.inject({ method: 'GET', url: `${API_PREFIX}/mailboxes` })).json(),
  ).data[0];
  if (selected === undefined) throw new Error('Missing checked mailbox.');
  const id = selected.id;
  await expect
    .poll(
      async () =>
        mailboxSetup.parse(
          (
            await server.app.inject({ method: 'GET', url: `${API_PREFIX}/mailboxes/${id}/setup` })
          ).json(),
        ),
      { timeout: 15_000 },
    )
    .toMatchObject({ state: 'finished', trigger: 'connect', score: 12 });
  const response = await server.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/mailboxes/${id}/checks`,
  });
  expect(response.statusCode, response.body).toBe(201);
  expect(mailboxSetup.parse(response.json())).toMatchObject({ state: 'pending' });
  await expect
    .poll(
      async () => {
        const latest = await server.app.inject({
          method: 'GET',
          url: `${API_PREFIX}/mailboxes/${id}/setup`,
        });
        expect(latest.statusCode, latest.body).toBe(200);
        expect(latest.body).not.toContain(mail.password);
        expect(latest.body).not.toContain('secret_id');
        return mailboxSetup.parse(latest.json());
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ state: 'finished', score: 12 });
});

it('reads and saves SMTP limits over HTTP without accepting pause or security overrides', async () => {
  const selected = mailboxList.parse(
    (await server.app.inject({ method: 'GET', url: `${API_PREFIX}/mailboxes` })).json(),
  ).data[0];
  if (selected === undefined) throw new Error('Missing connected mailbox.');
  const url = `${API_PREFIX}/mailboxes/${selected.id}/sending`;
  const current = await server.app.inject({ method: 'GET', url });
  expect(current.statusCode).toBe(200);
  expect(mailboxSendingSettings.parse(current.json())).toMatchObject({
    dailyLimit: 300,
    pacingPerMinute: 5,
    warmupEnabled: true,
    effectiveAutomatedDailyLimit: 50,
  });
  const settings = {
    dailyLimit: 100,
    pacingPerMinute: 2,
    warmupEnabled: false,
    useForConversations: true,
    useForCampaigns: false,
  };
  const saved = await server.app.inject({ method: 'PUT', url, payload: settings });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(mailboxSendingSettings.parse(saved.json())).toMatchObject({
    ...settings,
    effectiveAutomatedDailyLimit: 100,
  });
  expect(saved.body).not.toContain(mail.password);
  const invalid = await server.app.inject({
    method: 'PUT',
    url,
    payload: { ...settings, pausedUntil: null },
  });
  expect(invalid.statusCode).toBe(422);
  expect((await server.app.inject({ method: 'GET', url })).json()).toEqual(saved.json());
});

it('runs the daily mailbox schedule through the real maintenance queue', async () => {
  const selected = mailboxList.parse(
    (await server.app.inject({ method: 'GET', url: `${API_PREFIX}/mailboxes` })).json(),
  ).data[0];
  if (selected === undefined) throw new Error('Missing scheduled mailbox.');
  const id = parsePublicId('mailbox', selected.id);
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update messaging.mailboxes set setup_checked_at=now()-interval '25 hours' where id=$1",
      [id],
    ),
  );
  await database.as('crm_owner', (sql) =>
    sql.query('select graphile_worker.add_job($1)', ['mailboxes.schedule_checks']),
  );
  await expect
    .poll(
      async () =>
        mailboxSetup.parse(
          (
            await server.app.inject({
              method: 'GET',
              url: `${API_PREFIX}/mailboxes/${selected.id}/setup`,
            })
          ).json(),
        ),
      { timeout: 15_000 },
    )
    .toMatchObject({ state: 'finished', trigger: 'scheduled', score: 12 });
});

it('uses the selected mailbox for a real authentication link through the sealed queue and SMTP worker', async () => {
  const list = mailboxList.parse(
    (await server.app.inject({ method: 'GET', url: `${API_PREFIX}/mailboxes` })).json(),
  );
  const selected = list.data[0];
  if (selected === undefined) throw new Error('Missing HTTP-connected mailbox.');
  const mailboxId = parsePublicId('mailbox', selected.id);
  if (mailboxId === undefined) throw new Error('Missing mailbox UUID.');
  await database.fixtures.user({ email: 'fixture@localhost.test' });
  const app = await start(
    {
      ...appConfig,
      devTenantContext: undefined,
      systemMailbox: mailboxId,
      authentication: {
        databaseUrl: database.url('crm_auth'),
        secret: 'a-fixture-authentication-secret-at-least-32-characters',
      },
      mail: undefined,
    },
    [],
    [],
  );
  try {
    const asked = await fetch(`${app.address}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: appConfig.publicUrl },
      body: JSON.stringify({ email: 'fixture@localhost.test', callbackURL: '/' }),
    });
    expect(asked.status).toBe(200);
    await expect.poll(() => delivered.length, { timeout: 15_000 }).toBe(1);
    const link = delivered[0]?.text.match(
      /https:\/\/[^\s]+\/api\/auth\/magic-link\/verify\?[^\s]+/,
    )?.[0];
    if (link === undefined) throw new Error('No sign-in URL delivered.');
    const verified = await fetch(`${app.address}${new URL(link).pathname}${new URL(link).search}`, {
      redirect: 'manual',
    });
    expect(verified.status).toBe(302);
    expect(
      verified.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith('__Secure-crm.session_token=')),
    ).toBe(true);
    await expect
      .poll(() =>
        database.as('crm_owner', (sql) =>
          sql.query<{ count: number }>(
            "select count(*)::int as count from vault.secrets where purpose='mailbox.install_message' and business_id=$1",
            [businessId],
          ),
        ),
      )
      .toEqual([{ count: 0 }]);
  } finally {
    await app.stop();
  }
});

it('runs the scheduled expiry task through the queue and removes abandoned secrets', async () => {
  await worker.stop();
  const response = await server.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/mailbox-connection-attempts`,
    payload: input('expired@localhost.test'),
  });
  expect(response.statusCode).toBe(201);
  const attempt = mailboxConnectionAttempt.parse(response.json());
  const id = parsePublicId('mailbox_attempt', attempt.id);
  await database.as('crm_owner', async (sql) => {
    await sql.query(
      "update messaging.mailbox_connection_attempts set created_at=now()-interval '11 minutes', expires_at=now()-interval '1 minute' where id=$1",
      [id],
    );
    // Leave only the maintenance job, to prove cleanup works without a verification delivery.
    await sql.query(
      "select graphile_worker.complete_jobs(array(select id from graphile_worker.jobs where task_identifier='mailboxes.verify'))",
    );
    await sql.query('select graphile_worker.add_job($1)', [EXPIRE_MAILBOX_ATTEMPTS]);
  });
  const keys = await newSecretsKey(2);
  worker = await startWorker({
    connectionString: database.url('crm_worker'),
    services: { db, authorize: allowEveryone },
    logger: pino({ level: 'silent' }),
    tasks: [],
    shutdownTimeoutMs: 1000,
    mailboxVault: await createSealingVault(parseSecretsPublicKey(keys.publicKey)),
  });
  await expect
    .poll(
      async () => {
        const result = await server.app.inject({
          method: 'GET',
          url: `${API_PREFIX}/mailbox-connection-attempts/${attempt.id}`,
        });
        return mailboxConnectionAttempt.parse(result.json()).status;
      },
      { timeout: 15_000 },
    )
    .toBe('failed');
  const result = await server.app.inject({
    method: 'GET',
    url: `${API_PREFIX}/mailbox-connection-attempts/${attempt.id}`,
  });
  expect(mailboxConnectionAttempt.parse(result.json())).toMatchObject({
    failure: 'expired',
    result: null,
  });
  const pendingSecrets = await database.as('crm_owner', (sql) =>
    sql.query<{ count: number }>(
      'select count(*)::int as count from vault.secrets where business_id=$1',
      [businessId],
    ),
  );
  expect(pendingSecrets).toEqual([{ count: 1 }]);
});
