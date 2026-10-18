import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { mailboxConnectionAttempt, mailboxDiscovery, mailboxList } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ForbiddenError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { createMailboxConnector } from '@repo/mail';
import {
  createSealingVault,
  createVault,
  newSecretsKey,
  parseSecretsKeys,
  parseSecretsPublicKey,
  type SealingVault,
  type Vault,
} from '@repo/module-vault';
import {
  startGreenMail,
  testDatabase,
  type GreenMailServer,
  type TestDatabase,
} from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import {
  createConnectMailboxCommand,
  createVerifyMailboxTask,
  readMailboxConnectionAttempt,
  createMailboxRoutes,
  expireMailboxAttempts,
  createQueuedInstallMailer,
  createSendInstallMailTask,
  expireInstallMessages,
  requestMailboxCheckCommand,
  readMailboxSetup,
  createCheckMailboxTask,
  scheduleMailboxChecks,
  readMailboxAlerts,
} from './index.js';
import { checkMailboxReference } from './check-runs.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let app: SealingVault;
let worker: Vault;
let mail: GreenMailServer;
let stopMail: (() => Promise<void>) | undefined;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  const made = await newSecretsKey(1);
  app = await createSealingVault(parseSecretsPublicKey(made.publicKey));
  worker = await createVault(parseSecretsKeys(made.secretsKey));
  ({ server: mail, stop: stopMail } = await startGreenMail('localhost.test'));
});
afterAll(async () => {
  await stopMail?.();
  await db.destroy();
  await database.close();
});

async function invocation(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return { context: { ...business.context, correlationId: randomUUID() }, permissions: 'all' };
}

function settings() {
  const login = {
    host: 'localhost',
    security: 'tls' as const,
    username: mail.username,
    password: mail.password,
  };
  return {
    name: 'Work',
    email: 'fixture@localhost.test',
    displayName: 'Fixture',
    smtp: { ...login, port: mail.smtpPort },
    imap: { ...login, port: mail.imapPort },
  };
}

function task() {
  return createVerifyMailboxTask(
    worker,
    createMailboxConnector({
      ca: mail.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([mail.address]),
    }),
  );
}

async function connectedInstallMailbox() {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  await task().run({ attemptId }, { invocation: actor, services });
  const connected = await withTenant(db, actor.context, (trx) =>
    readMailboxConnectionAttempt(trx, attempt.id),
  );
  if (connected.status !== 'connected') throw new Error('Missing connected mailbox.');
  const mailboxId = parsePublicId('mailbox', connected.mailboxId);
  if (mailboxId === undefined) throw new Error('Missing mailbox UUID.');
  const check = createCheckMailboxTask(
    worker,
    createMailboxConnector({
      ca: mail.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([mail.address]),
    }),
    () => Promise.reject(Object.assign(new Error('No fixture record.'), { code: 'ENODATA' })),
  );
  await check.run(check.data.parse(await queuedMailboxCheck()), { invocation: actor, services });
  return { actor, mailboxId, mailer: createQueuedInstallMailer(services, app, { mailboxId }) };
}

async function queuedInstallMessage() {
  const jobs = await database.runJobs(['mailboxes.send_install']);
  const payload = jobs[0]?.payload;
  if (typeof payload !== 'object' || payload === null || !('data' in payload))
    throw new Error('Missing delivery envelope.');
  return payload.data;
}

async function queuedMailboxCheck() {
  const jobs = await database.runJobs(['mailboxes.check']);
  expect(jobs).toHaveLength(1);
  const payload = jobs[0]?.payload;
  if (typeof payload !== 'object' || payload === null || !('data' in payload))
    throw new Error('Missing check envelope.');
  return payload.data;
}

it('queues the first setup check atomically after connecting a mailbox', async () => {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  await task().run({ attemptId }, { invocation: actor, services });
  const connected = await withTenant(db, actor.context, (trx) =>
    readMailboxConnectionAttempt(trx, attempt.id),
  );
  if (connected.status !== 'connected') throw new Error('Missing connected mailbox.');
  expect(
    await withTenant(db, actor.context, (trx) => readMailboxSetup(trx, connected.mailboxId)),
  ).toMatchObject({ state: 'pending', trigger: 'connect' });
  const data = await queuedMailboxCheck();
  expect(JSON.stringify(data)).not.toContain(mail.password);
  expect(JSON.stringify(data)).not.toContain(settings().email);
});

it('schedules due checks once and recovers an abandoned pending job without creating another run', async () => {
  const { actor, mailboxId } = await connectedInstallMailbox();
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update messaging.mailboxes set setup_checked_at=now()-interval '25 hours' where id=$1",
      [mailboxId],
    ),
  );
  const identifiers = await database.as('crm_app', (sql) =>
    sql.query('select * from private.due_mailbox_checks(1)'),
  );
  expect(identifiers).toEqual([
    {
      agency_id: actor.context.agencyId,
      business_id: actor.context.businessId,
      mailbox_id: mailboxId,
    },
  ]);
  await expect(
    database.as('crm_auth', (sql) => sql.query('select * from private.due_mailbox_checks(1)')),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.as('crm_worker', (sql) => sql.query('select * from private.due_mailbox_checks(1)')),
  ).rejects.toMatchObject({ code: '42501' });
  const scheduled = await Promise.all([
    scheduleMailboxChecks(services),
    scheduleMailboxChecks(services),
  ]);
  expect(scheduled.reduce((total, count) => total + count, 0)).toBe(1);
  const first = await queuedMailboxCheck();
  const checkForScope = createCheckMailboxTask(worker, {
    probe: () => {
      throw new Error('Scope check must not send.');
    },
  });
  const firstId = checkForScope.data.parse(first).runId;
  const foreign = await invocation();
  await expect(
    database.withTenant(foreign.context, (sql) =>
      sql.query('select private.enqueue_mailbox_check($1::uuid)', [firstId]),
    ),
  ).rejects.toThrow('mailbox check is not available in this context');
  expect(await scheduleMailboxChecks(services)).toBe(0);
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update messaging.mailbox_check_runs set queued_at=now()-interval '11 minutes' where mailbox_id=$1",
      [mailboxId],
    ),
  );
  const recovered = await Promise.all([
    scheduleMailboxChecks(services),
    scheduleMailboxChecks(services),
  ]);
  expect(recovered.reduce((total, count) => total + count, 0)).toBe(1);
  expect(await queuedMailboxCheck()).toEqual(first);
  const check = createCheckMailboxTask(
    worker,
    { probe: () => Promise.reject(new Error('private vendor fixture error')) },
    () => Promise.reject(Object.assign(new Error('No record'), { code: 'ENODATA' })),
  );
  await check.run(check.data.parse(first), { invocation: actor, services });
  expect(await scheduleMailboxChecks(services)).toBe(0);
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update messaging.mailboxes set setup_checked_at=now()-interval '25 hours' where id=$1",
      [mailboxId],
    ),
  );
  expect(await scheduleMailboxChecks(services)).toBe(1);
  await queuedMailboxCheck();
});

it('shows a passing-to-failing check on Today and clears it after verified recovery', async () => {
  const { actor, mailboxId } = await connectedInstallMailbox();
  const id = toPublicId('mailbox', mailboxId);
  let mxWorks = true;
  let mxUnknown = false;
  const check = createCheckMailboxTask(
    worker,
    createMailboxConnector({
      ca: mail.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([mail.address]),
    }),
    (_name, type) => {
      if (type === 'MX' && mxUnknown)
        return Promise.reject(
          Object.assign(new Error('Temporary fixture failure.'), { code: 'ETIMEOUT' }),
        );
      if (type === 'MX' && mxWorks)
        return Promise.resolve([{ exchange: 'mail.localhost.test', priority: 10 }]);
      return Promise.reject(Object.assign(new Error('No fixture record.'), { code: 'ENODATA' }));
    },
  );
  async function run() {
    await runCommand(services, requestMailboxCheckCommand, { id }, actor);
    await check.run(check.data.parse(await queuedMailboxCheck()), { invocation: actor, services });
  }
  await run();
  expect(await withTenant(db, actor.context, readMailboxAlerts)).toEqual({
    data: [],
    hasMore: false,
  });
  mxWorks = false;
  await run();
  const alerts = await withTenant(db, actor.context, readMailboxAlerts);
  expect(alerts).toMatchObject({
    data: [{ mailboxId: id, name: 'Work', checkKey: 'mx' }],
    hasMore: false,
  });
  const foreign = await invocation();
  expect(await withTenant(db, foreign.context, readMailboxAlerts)).toEqual({
    data: [],
    hasMore: false,
  });
  expect(
    await route('getMailboxSetupAlerts').run(
      {
        invocation: foreign,
        params: {},
        query: {},
        body: undefined,
      },
      services,
    ),
  ).toEqual({ data: [], hasMore: false });
  mxUnknown = true;
  await run();
  expect(await withTenant(db, actor.context, readMailboxAlerts)).toEqual(alerts);
  mxUnknown = false;
  mxWorks = true;
  await run();
  expect(await withTenant(db, actor.context, readMailboxAlerts)).toEqual({
    data: [],
    hasMore: false,
  });
});

it('queues a manual setup check using identifiers only and exposes its pending state after reload', async () => {
  const { actor, mailboxId } = await connectedInstallMailbox();
  const id = toPublicId('mailbox', mailboxId);
  const pending = await runCommand(services, requestMailboxCheckCommand, { id }, actor);
  expect(pending).toMatchObject({ mailboxId: id, state: 'pending', score: null, checks: [] });
  expect(await withTenant(db, actor.context, (trx) => readMailboxSetup(trx, id))).toEqual(pending);
  const jobs = await database.runJobs(['mailboxes.check']);
  expect(jobs).toHaveLength(1);
  const payload = jobs[0]?.payload;
  if (typeof payload !== 'object' || payload === null || !('data' in payload))
    throw new Error('Missing check envelope.');
  const reference = checkMailboxReference.data.parse(payload.data);
  expect(payload.data).toEqual(reference);
  expect(typeof reference.runId).toBe('string');
  expect(JSON.stringify(payload)).not.toContain(mail.password);
  expect(JSON.stringify(payload)).not.toContain(settings().email);
});

it('starts and reloads a check through permission-checked API routes', async () => {
  const { actor, mailboxId } = await connectedInstallMailbox();
  const id = toPublicId('mailbox', mailboxId);
  const request = { invocation: actor, params: { id }, query: {}, body: undefined };
  const pending = await route('requestMailboxCheck').run(request, services);
  expect(pending).toMatchObject({ mailboxId: id, state: 'pending' });
  expect(await route('getMailboxSetup').run(request, services)).toEqual(pending);
  expect(await route('getMailboxSetupAlerts').run(request, services)).toEqual({
    data: [],
    hasMore: false,
  });
  await queuedMailboxCheck();
  const denied = { ...request, invocation: { ...actor, permissions: new Set<never>() } };
  await expect(route('requestMailboxCheck').run(denied, services)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(route('getMailboxSetup').run(denied, services)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(route('getMailboxSetupAlerts').run(denied, services)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
});

it('finishes a self-check with safe evidence and preserves unknown public-hop checks', async () => {
  const { actor, mailboxId } = await connectedInstallMailbox();
  const id = toPublicId('mailbox', mailboxId);
  await runCommand(services, requestMailboxCheckCommand, { id }, actor);
  const jobs = await database.runJobs(['mailboxes.check']);
  const payload = jobs[0]?.payload;
  if (typeof payload !== 'object' || payload === null || !('data' in payload))
    throw new Error('Missing check envelope.');
  const check = createCheckMailboxTask(
    worker,
    createMailboxConnector({
      ca: mail.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([mail.address]),
    }),
    (_name, type) => {
      if (type === 'MX')
        return Promise.resolve([{ exchange: 'mail.localhost.test', priority: 10 }]);
      return Promise.reject(Object.assign(new Error('No fixture record.'), { code: 'ENODATA' }));
    },
  );
  await check.run(check.data.parse(payload.data), { invocation: actor, services });
  const finished = await withTenant(db, actor.context, (trx) => readMailboxSetup(trx, id));
  expect(finished).toMatchObject({ state: 'finished', score: 12, method: 'self' });
  expect(finished?.checks).toHaveLength(10);
  expect(finished?.checks).toContainEqual(
    expect.objectContaining({ key: 'connection', status: 'pass' }),
  );
  expect(finished?.checks).toContainEqual(
    expect.objectContaining({ key: 'encryption', status: 'could_not_check', pointsAwarded: 0 }),
  );
  expect(finished?.checks).toContainEqual(
    expect.objectContaining({ key: 'reverse_dns', status: 'could_not_check', pointsAwarded: 0 }),
  );
  expect(finished?.checks).toContainEqual(
    expect.objectContaining({ key: 'blocklists', status: 'could_not_check', pointsAwarded: 0 }),
  );
  expect(JSON.stringify(finished)).not.toContain(mail.password);
  expect(JSON.stringify(finished)).not.toContain('RFC822');
  expect(finished?.checks.find((check) => check.key === 'dmarc')?.fix).toMatchObject({
    kind: 'record',
    type: 'TXT',
    name: '_dmarc.localhost.test',
  });
  const repeated = createCheckMailboxTask(worker, {
    probe: () => {
      throw new Error('A completed run must not send another self-test.');
    },
  });
  await repeated.run(repeated.data.parse(payload.data), { invocation: actor, services });
  expect(await withTenant(db, actor.context, (trx) => readMailboxSetup(trx, id))).toEqual(finished);
});

it('isolates setup reads and requests, and serializes overlapping check requests', async () => {
  const { actor, mailboxId } = await connectedInstallMailbox();
  const id = toPublicId('mailbox', mailboxId);
  const foreign = await invocation();
  // A mailbox that predates setup checks has no history until its first request.
  await database.as('crm_owner', (sql) =>
    sql.query('delete from messaging.mailbox_check_runs where mailbox_id=$1', [mailboxId]),
  );
  expect(await withTenant(db, actor.context, (trx) => readMailboxSetup(trx, id))).toBeNull();
  await expect(
    withTenant(db, foreign.context, (trx) => readMailboxSetup(trx, id)),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    withTenant(db, actor.context, (trx) => readMailboxSetup(trx, 'invalid')),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    runCommand(services, requestMailboxCheckCommand, { id }, foreign),
  ).rejects.toBeInstanceOf(NotFoundError);
  const foreignRequest = { invocation: foreign, params: { id }, query: {}, body: undefined };
  await expect(route('getMailboxSetup').run(foreignRequest, services)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(route('requestMailboxCheck').run(foreignRequest, services)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  const requests = await Promise.allSettled([
    runCommand(services, requestMailboxCheckCommand, { id }, actor),
    runCommand(services, requestMailboxCheckCommand, { id }, actor),
  ]);
  expect(requests.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
  expect(requests.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
  const data = await queuedMailboxCheck();
  const task = createCheckMailboxTask(worker, {
    probe: () => {
      throw new Error('A foreign run must never read credentials or send.');
    },
  });
  await task.run(task.data.parse(data), { invocation: foreign, services });
  expect(await withTenant(db, actor.context, (trx) => readMailboxSetup(trx, id))).toMatchObject({
    state: 'pending',
  });
});

it.each(['channel', 'business'] as const)(
  'refuses check requests for an inactive %s',
  async (disabled) => {
    const { actor, mailboxId } = await connectedInstallMailbox();
    await database.as('crm_owner', (sql) =>
      disabled === 'business'
        ? sql.query("update tenancy.businesses set status='suspended' where id=$1", [
            actor.context.businessId,
          ])
        : sql.query(
            "update messaging.channel_accounts set status='disconnected' where id=$1 and business_id=$2",
            [mailboxId, actor.context.businessId],
          ),
    );
    await expect(
      runCommand(
        services,
        requestMailboxCheckCommand,
        { id: toPublicId('mailbox', mailboxId) },
        actor,
      ),
    ).rejects.toMatchObject({ name: 'ConflictError' });
    expect(await database.runJobs(['mailboxes.check'])).toEqual([]);
  },
);

it('finishes unreadable credentials safely without sending or exposing a parser excerpt', async () => {
  const { actor, mailboxId } = await connectedInstallMailbox();
  const id = toPublicId('mailbox', mailboxId);
  await runCommand(services, requestMailboxCheckCommand, { id }, actor);
  const data = await queuedMailboxCheck();
  await withTenant(db, actor.context, async (trx) => {
    const row = await trx
      .selectFrom('messaging.mailboxes')
      .select('secret_id')
      .where('id', '=', mailboxId)
      .executeTakeFirstOrThrow();
    await app.replace(trx, row.secret_id, 'sensitive-fixture-credential');
  });
  const task = createCheckMailboxTask(worker, {
    probe: () => {
      throw new Error('Unreadable credentials must not be sent.');
    },
  });
  await task.run(task.data.parse(data), { invocation: actor, services });
  const result = await withTenant(db, actor.context, (trx) => readMailboxSetup(trx, id));
  expect(result).toMatchObject({ state: 'finished', score: 0 });
  expect(result?.checks).toContainEqual(
    expect.objectContaining({
      key: 'connection',
      status: 'fail',
      reason: 'credentials_unavailable',
    }),
  );
  expect(JSON.stringify(result)).not.toContain('sensitive-fixture-credential');
});

it('refuses an unavailable install sender without queuing a sign-in link', async () => {
  const mailer = createQueuedInstallMailer(services, app, { mailboxId: randomUUID() });
  await expect(
    mailer.send({ to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' }),
  ).rejects.toThrow('The selected install mailbox is not available.');
  expect(await database.runJobs(['mailboxes.send_install'])).toEqual([]);
});

it('keeps a failed delivery sealed for retry and hides transport errors and sign-in links', async () => {
  const { actor, mailer } = await connectedInstallMailbox();
  const message = { to: 'person@example.test', subject: 'Sign in', text: 'secret-token-fixture' };
  await mailer.send(message);
  const data = await queuedInstallMessage();
  const failed = createSendInstallMailTask(worker, {
    send: () => Promise.reject(new Error('provider leaked secret-token-fixture')),
  });
  await expect(
    failed.run(failed.data.parse(data), { invocation: actor, services }),
  ).rejects.toThrow(/^Install mail delivery failed; the queued message will retry\.$/);
  const sent: unknown[] = [];
  const retry = createSendInstallMailTask(worker, {
    send: (_login, _from, mail) => {
      sent.push(mail);
      return Promise.resolve();
    },
  });
  const foreign = await invocation();
  await retry.run(retry.data.parse(data), { invocation: foreign, services });
  expect(sent).toEqual([]);
  await retry.run(retry.data.parse(data), { invocation: actor, services });
  expect(sent).toEqual([message]);
});

it('redacts malformed mailbox credentials while retaining install mail for a repair and retry', async () => {
  const { actor, mailboxId, mailer } = await connectedInstallMailbox();
  await mailer.send({ to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' });
  const deliver = createSendInstallMailTask(worker, { send: () => Promise.resolve() });
  const data = deliver.data.parse(await queuedInstallMessage());
  const secretId = await withTenant(db, actor.context, async (trx) => {
    const mailbox = await trx
      .selectFrom('messaging.mailboxes')
      .select('secret_id')
      .where('id', '=', mailboxId)
      .executeTakeFirstOrThrow();
    await app.replace(trx, mailbox.secret_id, 'sensitive-fixture-credential');
    return mailbox.secret_id;
  });
  await expect(deliver.run(data, { invocation: actor, services })).rejects.toThrow(
    /^Install mail credentials are unavailable; the queued message will retry\.$/,
  );
  await withTenant(db, actor.context, (trx) =>
    app.replace(trx, secretId, JSON.stringify(settings())),
  );
  await deliver.run(data, { invocation: actor, services });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').where('id', '=', data.messageId).execute(),
    ),
  ).toEqual([]);
});

it.each(['not JSON', '{"mailboxId":"invalid"}'])(
  'discards a malformed sealed install message (%s)',
  async (invalid) => {
    const { actor, mailer } = await connectedInstallMailbox();
    await mailer.send({ to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' });
    const deliver = createSendInstallMailTask(worker, {
      send: () => {
        throw new Error('Must not send malformed content.');
      },
    });
    const data = deliver.data.parse(await queuedInstallMessage());
    await withTenant(db, actor.context, (trx) => app.replace(trx, data.messageId, invalid));
    await deliver.run(data, { invocation: actor, services });
    expect(
      await withTenant(db, actor.context, (trx) =>
        trx.selectFrom('vault.secrets').select('id').where('id', '=', data.messageId).execute(),
      ),
    ).toEqual([]);
  },
);

it('discards an unreadable install message without exposing its ciphertext', async () => {
  const { actor, mailer } = await connectedInstallMailbox();
  await mailer.send({ to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' });
  const otherKey = await newSecretsKey(2);
  const otherWorker = await createVault(parseSecretsKeys(otherKey.secretsKey));
  const deliver = createSendInstallMailTask(otherWorker, {
    send: () => {
      throw new Error('Must not send unreadable content.');
    },
  });
  const data = deliver.data.parse(await queuedInstallMessage());
  await deliver.run(data, { invocation: actor, services });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').where('id', '=', data.messageId).execute(),
    ),
  ).toEqual([]);
});

it.each(['channel', 'business'] as const)(
  'does not deliver queued authentication mail after its %s is suspended',
  async (disabled) => {
    const { actor, mailboxId, mailer } = await connectedInstallMailbox();
    await mailer.send({ to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' });
    const deliver = createSendInstallMailTask(worker, {
      send: () => {
        throw new Error('Must not send from a suspended sender.');
      },
    });
    const data = deliver.data.parse(await queuedInstallMessage());
    await database.as('crm_owner', (sql) =>
      disabled === 'business'
        ? sql.query("update tenancy.businesses set status='suspended' where id=$1", [
            actor.context.businessId,
          ])
        : sql.query(
            "update messaging.channel_accounts set status='disconnected' where id=$1 and business_id=$2",
            [mailboxId, actor.context.businessId],
          ),
    );
    await deliver.run(data, { invocation: actor, services });
    expect(
      await withTenant(db, actor.context, (trx) =>
        trx.selectFrom('vault.secrets').select('id').where('id', '=', data.messageId).execute(),
      ),
    ).toEqual([]);
    await expect(
      mailer.send({ to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' }),
    ).rejects.toThrow('The selected install mailbox is not available.');
  },
);

it('cleans expired install links exactly once when maintenance overlaps', async () => {
  const { actor, mailer } = await connectedInstallMailbox();
  await mailer.send({ to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' });
  await queuedInstallMessage();
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update vault.secrets set created_at=now()-interval '11 minutes' where purpose='mailbox.install_message' and business_id=$1",
      [actor.context.businessId],
    ),
  );
  const removed = await Promise.all([
    expireInstallMessages(services, app),
    expireInstallMessages(services, app),
  ]);
  expect(removed.reduce((sum, value) => sum + value, 0)).toBe(1);
});

it('expires queued sign-in links using the same database clock as maintenance', async () => {
  const { actor, mailer } = await connectedInstallMailbox();
  await mailer.send({ to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' });
  const data = await queuedInstallMessage();
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update vault.secrets set created_at=now()-interval '11 minutes' where purpose='mailbox.install_message' and business_id=$1",
      [actor.context.businessId],
    ),
  );
  const sent: unknown[] = [];
  const deliver = createSendInstallMailTask(worker, {
    send: (_login, _from, message) => {
      sent.push(message);
      return Promise.resolve();
    },
  });
  await deliver.run(deliver.data.parse(data), { invocation: actor, services });
  expect(sent).toEqual([]);
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx
        .selectFrom('vault.secrets')
        .select('id')
        .where('purpose', '=', 'mailbox.install_message')
        .execute(),
    ),
  ).toEqual([]);
});

it('seals install sign-in links, queues only an ID, and removes the message after worker delivery', async () => {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  await task().run({ attemptId }, { invocation: actor, services });
  const connected = await withTenant(db, actor.context, (trx) =>
    readMailboxConnectionAttempt(trx, attempt.id),
  );
  if (connected.status !== 'connected' || actor.context.businessId === undefined)
    throw new Error('Missing connected mailbox.');
  const mailboxId = parsePublicId('mailbox', connected.mailboxId);
  if (mailboxId === undefined) throw new Error('Missing mailbox UUID.');
  const message = {
    to: 'person@example.test',
    subject: 'Your sign-in link',
    text: 'Secret fixture link https://crm.example.test/token-fixture',
    html: '<a href="https://crm.example.test/token-fixture">Sign in</a>',
  };
  const mailer = createQueuedInstallMailer(services, app, { mailboxId });
  await mailer.send(message);
  mailer.close();
  const jobs = await database.runJobs(['mailboxes.send_install']);
  expect(jobs).toHaveLength(1);
  expect(JSON.stringify(jobs)).not.toContain('token-fixture');
  expect(JSON.stringify(jobs)).not.toContain(message.to);
  const payload = jobs[0]?.payload;
  if (typeof payload !== 'object' || payload === null || !('data' in payload))
    throw new Error('Missing delivery envelope.');
  const sent: unknown[] = [];
  const deliver = createSendInstallMailTask(worker, {
    send: (login, from, mail) => {
      expect(login.password).toBe(settings().smtp.password);
      sent.push({ from, mail });
      return Promise.resolve();
    },
  });
  const data = deliver.data.parse(payload.data);
  await deliver.run(data, { invocation: actor, services });
  await deliver.run(data, { invocation: actor, services });
  expect(sent).toEqual([
    { from: { address: settings().email, name: settings().displayName }, mail: message },
  ]);
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx
        .selectFrom('vault.secrets')
        .select('id')
        .where('purpose', '=', 'mailbox.install_message')
        .execute(),
    ),
  ).toEqual([]);
  await mailer.send(message);
  const abandoned = await database.runJobs(['mailboxes.send_install']);
  const abandonedPayload = abandoned[0]?.payload;
  if (
    typeof abandonedPayload !== 'object' ||
    abandonedPayload === null ||
    !('data' in abandonedPayload)
  )
    throw new Error('Missing delivery envelope.');
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update vault.secrets set created_at=now()-interval '11 minutes' where purpose='mailbox.install_message' and business_id=$1",
      [actor.context.businessId],
    ),
  );
  expect(await expireInstallMessages(services, app)).toBe(1);
  expect(await expireInstallMessages(services, app)).toBe(0);
  await deliver.run(deliver.data.parse(abandonedPayload.data), { invocation: actor, services });
  expect(sent).toHaveLength(1);
});

function route(operationId: string) {
  const found = createMailboxRoutes(app, {
    resolveSrv: () => Promise.resolve([]),
    resolveMx: () => Promise.resolve([]),
  }).find((candidate) => candidate.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`Missing route ${operationId}.`);
  return found;
}

it('exposes discovery, connect, pending status and the connected list through permission-checked routes', async () => {
  const actor = await invocation();
  const request = { invocation: actor, params: {}, query: {}, body: settings() };
  const discovery = mailboxDiscovery.parse(
    await route('discoverMailboxServers').run(
      { ...request, body: { email: 'person@gmail.com' } },
      services,
    ),
  );
  expect(discovery.smtp?.host).toBe('smtp.gmail.com');
  const pending = mailboxConnectionAttempt.parse(
    await route('connectMailbox').run(request, services),
  );
  expect(
    mailboxConnectionAttempt.parse(
      await route('getMailboxConnectionAttempt').run(
        { ...request, params: { id: pending.id } },
        services,
      ),
    ).status,
  ).toBe('pending');
  expect(mailboxList.parse(await route('listMailboxes').run(request, services)).data).toEqual([]);
  const attemptId = parsePublicId('mailbox_attempt', pending.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  await task().run({ attemptId }, { invocation: actor, services });
  const mailboxes = mailboxList.parse(await route('listMailboxes').run(request, services));
  expect(mailboxes.data).toHaveLength(1);
  expect(mailboxes.data[0]).toMatchObject({
    email: settings().email,
    name: 'Work',
    smtp: { host: 'localhost', port: mail.smtpPort },
  });
  expect(JSON.stringify(mailboxes)).not.toContain(mail.password);
  const other = await invocation();
  expect(
    mailboxList.parse(await route('listMailboxes').run({ ...request, invocation: other }, services))
      .data,
  ).toEqual([]);
  await expect(
    route('getMailboxConnectionAttempt').run(
      { ...request, invocation: other, params: { id: pending.id } },
      services,
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it.each(['discoverMailboxServers', 'listMailboxes', 'getMailboxConnectionAttempt'])(
  'refuses %s for a role without mailbox management',
  async (operationId) => {
    const actor = { ...(await invocation()), permissions: new Set<never>() };
    await expect(
      route(operationId).run({ invocation: actor, params: {}, query: {}, body: {} }, services),
    ).rejects.toBeInstanceOf(ForbiddenError);
  },
);

it('expires stale credentials across tenants without touching a current attempt, and is repeatable', async () => {
  const expiredActor = await invocation();
  const currentActor = await invocation();
  const expired = await runCommand(
    services,
    createConnectMailboxCommand(app),
    settings(),
    expiredActor,
  );
  const current = await runCommand(
    services,
    createConnectMailboxCommand(app),
    settings(),
    currentActor,
  );
  const expiredId = parsePublicId('mailbox_attempt', expired.id);
  if (expiredId === undefined) throw new Error('Missing attempt UUID.');
  await database.withTenant(expiredActor.context, (sql) =>
    sql.query(
      `
    update messaging.mailbox_connection_attempts set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where id = $1`,
      [expiredId],
    ),
  );
  const expiredCounts = await Promise.all([
    expireMailboxAttempts(services, app),
    expireMailboxAttempts(services, app),
  ]);
  expect(expiredCounts.reduce((sum, count) => sum + count, 0)).toBe(1);
  expect(await expireMailboxAttempts(services, app)).toBe(0);
  expect(
    await withTenant(db, expiredActor.context, (trx) =>
      readMailboxConnectionAttempt(trx, expired.id),
    ),
  ).toMatchObject({ status: 'failed', failure: 'expired' });
  expect(
    await withTenant(db, currentActor.context, (trx) =>
      readMailboxConnectionAttempt(trx, current.id),
    ),
  ).toMatchObject({ status: 'pending' });
  expect(
    await withTenant(db, currentActor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').execute(),
    ),
  ).toHaveLength(1);
});

it('lets a new request replace an expired pending attempt and clears the old secret', async () => {
  const actor = await invocation();
  const first = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const firstId = parsePublicId('mailbox_attempt', first.id);
  if (firstId === undefined) throw new Error('Missing attempt UUID.');
  await database.withTenant(actor.context, (sql) =>
    sql.query(
      `
    update messaging.mailbox_connection_attempts set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where id = $1`,
      [firstId],
    ),
  );
  const next = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  expect(next.status).toBe('pending');
  expect(next.id).not.toBe(first.id);
  expect(
    await withTenant(db, actor.context, (trx) => readMailboxConnectionAttempt(trx, first.id)),
  ).toMatchObject({ status: 'failed', failure: 'expired' });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').execute(),
    ),
  ).toHaveLength(1);
});

it('refuses ungranted commands without storing credentials, and redacts the denied audit', async () => {
  const actor = { ...(await invocation()), permissions: new Set<never>() };
  await expect(
    runCommand(services, createConnectMailboxCommand(app), settings(), actor),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').execute(),
    ),
  ).toEqual([]);
  const audit = await withTenant(db, actor.context, (trx) =>
    trx.selectFrom('audit.commands').select(['input', 'outcome']).execute(),
  );
  expect(audit[0]?.outcome).toBe('denied');
  expect(JSON.stringify(audit)).not.toContain(mail.password);
  expect(JSON.stringify(audit)).not.toContain('username');
});

it('hides another business’s attempt and refuses duplicate pending tests without storing another secret', async () => {
  const actor = await invocation();
  const foreign = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  await expect(
    withTenant(db, foreign.context, (trx) => readMailboxConnectionAttempt(trx, attempt.id)),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    runCommand(services, createConnectMailboxCommand(app), settings(), actor),
  ).rejects.toMatchObject({ name: 'ConflictError' });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').execute(),
    ),
  ).toHaveLength(1);
});

it('does not connect an expired attempt and removes its pending credentials', async () => {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  await database.withTenant(actor.context, (sql) =>
    sql.query(
      `
    update messaging.mailbox_connection_attempts set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where id = $1`,
      [attemptId],
    ),
  );
  await task().run({ attemptId }, { invocation: actor, services });
  expect(
    await withTenant(db, actor.context, (trx) => readMailboxConnectionAttempt(trx, attempt.id)),
  ).toMatchObject({ status: 'failed', failure: 'expired', result: null });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').execute(),
    ),
  ).toEqual([]);
});

it('never saves a mailbox without its inbox baseline, and connects on retry', async () => {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  const connector = createMailboxConnector({
    ca: mail.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([mail.address]),
  });
  let failures = 1;
  const flaky = createVerifyMailboxTask(worker, {
    verify: (input) => connector.verify(input),
    readInbox: (login, cursor) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('Inbox unavailable.'));
      }
      return connector.readInbox(login, cursor);
    },
  });
  await expect(flaky.run({ attemptId }, { invocation: actor, services })).rejects.toThrow(
    'Inbox unavailable.',
  );
  expect(
    await withTenant(db, actor.context, (trx) => readMailboxConnectionAttempt(trx, attempt.id)),
  ).toMatchObject({ status: 'pending' });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('messaging.mailboxes').select('id').execute(),
    ),
  ).toEqual([]);

  const before = new Date();
  await flaky.run({ attemptId }, { invocation: actor, services });
  expect(
    await withTenant(db, actor.context, (trx) => readMailboxConnectionAttempt(trx, attempt.id)),
  ).toMatchObject({ status: 'connected' });
  const [saved] = await withTenant(db, actor.context, (trx) =>
    trx
      .selectFrom('messaging.mailboxes')
      .select(['imap_uid_validity', 'imap_last_uid', 'inbound_started_at', 'created_at'])
      .execute(),
  );
  expect(saved?.imap_uid_validity).toMatch(/^[1-9]\d*$/);
  expect(saved?.imap_last_uid).toMatch(/^\d+$/);
  // Taken before the baseline was read, so before the mailbox was saved.
  expect(saved?.inbound_started_at?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  expect(saved?.inbound_started_at?.getTime()).toBeLessThanOrEqual(
    saved?.created_at.getTime() ?? 0,
  );
});

it('rechecks expiry after network verification before creating a mailbox', async () => {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  const connector = createMailboxConnector({
    ca: mail.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([mail.address]),
  });
  const delayed = createVerifyMailboxTask(worker, {
    verify: async (input) => {
      const result = await connector.verify(input);
      await database.withTenant(actor.context, (sql) =>
        sql.query(
          "update messaging.mailbox_connection_attempts set created_at=now()-interval '11 minutes', expires_at=now()-interval '1 minute' where id=$1",
          [attemptId],
        ),
      );
      return result;
    },
    readInbox: (login, cursor) => connector.readInbox(login, cursor),
  });
  await delayed.run({ attemptId }, { invocation: actor, services });
  expect(
    await withTenant(db, actor.context, (trx) => readMailboxConnectionAttempt(trx, attempt.id)),
  ).toMatchObject({ status: 'failed', failure: 'expired' });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('messaging.mailboxes').select('id').execute(),
    ),
  ).toEqual([]);
});

it('reports unreadable credential envelopes safely and cleans them', async () => {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  await withTenant(db, actor.context, async (trx) => {
    const row = await trx
      .selectFrom('messaging.mailbox_connection_attempts')
      .select('secret_id')
      .where('id', '=', attemptId)
      .executeTakeFirstOrThrow();
    if (row.secret_id === null) throw new Error('Missing pending credentials.');
    await app.replace(trx, row.secret_id, 'not JSON, fixture only');
  });
  await task().run({ attemptId }, { invocation: actor, services });
  expect(
    await withTenant(db, actor.context, (trx) => readMailboxConnectionAttempt(trx, attempt.id)),
  ).toMatchObject({ status: 'failed', failure: 'credentials_unreadable', result: null });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').execute(),
    ),
  ).toEqual([]);
});

it('creates one mailbox when two deliveries of the same job overlap', async () => {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  const job = { invocation: actor, services };
  await Promise.all([task().run({ attemptId }, job), task().run({ attemptId }, job)]);
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('messaging.mailboxes').select('id').execute(),
    ),
  ).toHaveLength(1);
  await expect(
    runCommand(services, createConnectMailboxCommand(app), settings(), actor),
  ).rejects.toMatchObject({ name: 'ConflictError' });
});

it('queues only an attempt ID, seals credentials, and creates no mailbox until both real sign-ins pass', async () => {
  const actor = await invocation();
  const attempt = await runCommand(services, createConnectMailboxCommand(app), settings(), actor);
  expect(attempt.status).toBe('pending');
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('messaging.mailboxes').select('id').execute(),
    ),
  ).toEqual([]);
  const jobs = await database.runJobs(['mailboxes.verify']);
  expect(
    jobs.filter(
      ({ payload }) =>
        typeof payload === 'object' &&
        payload !== null &&
        'agencyId' in payload &&
        payload.agencyId === actor.context.agencyId,
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(jobs)).not.toContain(mail.password);
  expect(JSON.stringify(jobs)).not.toContain(mail.username);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  const job = {
    invocation: { ...actor, context: { ...actor.context, actorKind: 'system' as const } },
    services,
  };
  await task().run({ attemptId }, job);
  const connected = await withTenant(db, actor.context, (trx) =>
    readMailboxConnectionAttempt(trx, attempt.id),
  );
  expect(connected.status).toBe('connected');
  expect(JSON.stringify(connected)).not.toContain(mail.password);
  await task().run({ attemptId }, job);
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('messaging.mailboxes').select('id').execute(),
    ),
  ).toHaveLength(1);
  const audit = await withTenant(db, actor.context, (trx) =>
    trx.selectFrom('audit.commands').select('input').execute(),
  );
  expect(JSON.stringify(audit)).not.toContain(mail.password);
  expect(JSON.stringify(audit)).not.toContain('username');
});

it('cleans the pending secret and creates no mailbox when only SMTP authentication succeeds', async () => {
  const actor = await invocation();
  const input = settings();
  input.imap.password = 'wrong-fixture-password';
  const attempt = await runCommand(services, createConnectMailboxCommand(app), input, actor);
  const attemptId = parsePublicId('mailbox_attempt', attempt.id);
  if (attemptId === undefined) throw new Error('Missing attempt UUID.');
  await task().run({ attemptId }, { invocation: actor, services });
  const failed = await withTenant(db, actor.context, (trx) =>
    readMailboxConnectionAttempt(trx, attempt.id),
  );
  expect(failed).toMatchObject({
    status: 'failed',
    failure: 'connection_failed',
    result: { smtp: { status: 'pass' }, imap: { code: 'authentication' } },
  });
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('messaging.mailboxes').select('id').execute(),
    ),
  ).toEqual([]);
  expect(
    await withTenant(db, actor.context, (trx) =>
      trx.selectFrom('vault.secrets').select('id').execute(),
    ),
  ).toEqual([]);
});
