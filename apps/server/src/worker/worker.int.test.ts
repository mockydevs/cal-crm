// The worker against a migrated Postgres: a committed job runs once, in the business that
// added it; a rolled-back one never runs; failures are retried later.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  defineTask,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { eventChain } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import {
  createConnectMailboxCommand,
  createQueuedInstallMailer,
  VOICE_SIGNING_KEY,
} from '@repo/module-messaging';
import { createVault, newSecretsKey, parseSecretsKeys } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { apiRoutes } from '../api-routes.js';
import {
  EXPIRE_MAILBOX_ATTEMPTS,
  MAINTAIN_AI,
  MAINTAIN_PARTITIONS,
  MAINTAIN_VOICE,
  PURGE_TRASH,
  SCHEDULE_CAMPAIGNS,
  SCHEDULE_GOOGLE,
  SCHEDULE_INTEGRATIONS,
  startWorker,
  type Worker,
} from './worker.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const workers: Worker[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

// What each run of the tasks below saw.
const runs: { note: string; context: TenantContext }[] = [];
// The priority the queue gave each run of test.noted, as the task was handed it.
const priorities: { note: string; priority: number | undefined }[] = [];

const noted = defineTask({
  name: 'test.noted',
  data: z.strictObject({ note: z.string() }),
  run(data, job) {
    runs.push({ note: data.note, context: job.invocation.context });
    priorities.push({ note: data.note, priority: job.job?.priority });
    return Promise.resolve();
  },
});

const failing = defineTask({
  name: 'test.failing',
  data: z.strictObject({}),
  run: () => Promise.reject(new Error('the task failed')),
});

// A job that never finishes, as when a call hangs.
const waiting = defineTask({
  name: 'test.waiting',
  data: z.strictObject({ note: z.string() }),
  run(data, job) {
    runs.push({ note: data.note, context: job.invocation.context });
    return new Promise(() => undefined);
  },
});

// Adds a job for one of the tasks, and can fail after adding it. It runs at the agency or
// in a business, so its permission is one that applies in both.
const addJob = defineCommand({
  name: 'test.add_job',
  permission: 'files.upload',
  input: z.strictObject({
    task: z.enum(['noted', 'failing', 'waiting']),
    note: z.string().default(''),
    fail: z.boolean().default(false),
  }),
  handle(_trx, input, command) {
    if (input.task === 'noted') command.enqueue(noted, { note: input.note });
    if (input.task === 'failing') command.enqueue(failing, {});
    if (input.task === 'waiting') command.enqueue(waiting, { note: input.note });
    return input.fail ? Promise.reject(new Error('the command failed')) : Promise.resolve(null);
  },
});

// A command a job runs: it notes that it followed, as the job's own event.
const followUp = defineCommand({
  name: 'test.follow_up',
  permission: 'tags.manage',
  input: z.strictObject({}),
  async handle(_trx, _input, command) {
    return command.emit({
      type: 'agency.followed_up',
      subject: { kind: 'agency', id: command.context.agencyId },
    });
  },
});

// Runs followUp, as a consumer of an event does.
const following = defineTask({
  name: 'test.following',
  data: z.strictObject({}),
  async run(_data, job) {
    await runCommand(job.services, followUp, {}, job.invocation);
  },
});

// Emits an event, and adds a job that follows it.
const startChain = defineCommand({
  name: 'test.start_chain',
  permission: 'tags.manage',
  input: z.strictObject({}),
  async handle(_trx, _input, command) {
    const started = await command.emit({
      type: 'agency.chain_started',
      subject: { kind: 'agency', id: command.context.agencyId },
    });
    command.enqueue(following, {});
    return started;
  },
});

// A line of the worker's log, as pino writes it.
const logLine = z.looseObject({
  level: z.number(),
  msg: z.string(),
  err: z.looseObject({ message: z.string() }).optional(),
});
type LogLine = z.infer<typeof logLine>;

async function startedWorker(shutdownTimeoutMs = 1000, log: LogLine[] = []): Promise<Worker> {
  const worker = await startWorker({
    connectionString: database.url('crm_worker'),
    services,
    tasks: [noted, failing, waiting, following],
    logger: pino(
      { level: 'debug' },
      {
        write: (line: string) => {
          log.push(logLine.parse(JSON.parse(line)));
        },
      },
    ),
    shutdownTimeoutMs,
  });
  workers.push(worker);
  return worker;
}

/** A user in a new business, with a correlation id of its own. */
async function userInBusiness(name?: string): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user(name === undefined ? {} : { name });
  return {
    context: {
      ...business.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
}

/** Polls until the check returns a value, or fails after a while. */
async function eventually<T>(check: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const queued = (task: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ attempts: number; last_error: string | null; later: boolean }>(
      `select attempts, last_error, run_at > now() as later
       from graphile_worker.jobs where task_identifier = $1`,
      [task],
    ),
  );

async function maintain(task: string): Promise<void> {
  await database.as('crm_owner', (sql) => sql.query('select graphile_worker.add_job($1)', [task]));
  await eventually(async () => ((await queued(task)).length === 0 ? true : undefined));
}

const ranWith = (note: string) => runs.filter((run) => run.note === note);

describe('the worker', () => {
  it('schedules inbox sync through the real queue in the mailbox tenant, with identifiers only', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const [mailbox] = await database.withTenant(business.context, (client) =>
      client.query<{ id: string }>(
        `with secret as (
           insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
           values ($1, $2, 'mailbox.credentials', 1, decode(repeat('01',32),'hex'),
                   decode(repeat('ab',32),'hex')) returning id
         ), account as (
           insert into messaging.channel_accounts (business_id, channel, name)
           values ($2, 'email', 'Inbox schedule fixture') returning id
         )
         insert into messaging.mailboxes
           (business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,
            smtp_username,imap_host,imap_port,imap_security,imap_username,secret_id)
         select $2,account.id,'inbox@example.test','password','mail.example.test',465,'tls',
                'inbox@example.test','mail.example.test',993,'tls','inbox@example.test',secret.id
         from account,secret returning id`,
        [agency.id, business.id],
      ),
    );
    if (mailbox === undefined) throw new Error('No mailbox fixture.');
    const synchronized: { data: unknown; context: TenantContext }[] = [];
    const sync = defineTask({
      name: 'mailboxes.sync',
      data: z.strictObject({ mailboxId: z.uuid() }),
      run(data, job) {
        synchronized.push({ data, context: job.invocation.context });
        return Promise.resolve();
      },
    });
    const worker = await startWorker({
      connectionString: database.url('crm_worker'),
      services,
      tasks: [sync],
      logger: pino({ level: 'silent' }),
      shutdownTimeoutMs: 1000,
    });
    workers.push(worker);
    // Exercise the same registered task the cron enqueues, without waiting for a minute boundary.
    await database.as('crm_owner', (client) =>
      client.query('select graphile_worker.add_job($1)', ['mailboxes.schedule_syncs']),
    );
    await eventually(() => (synchronized.length > 0 ? true : undefined));
    expect(synchronized[0]?.context.correlationId).toMatch(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    );
    expect(synchronized).toEqual([
      {
        data: { mailboxId: mailbox.id },
        context: {
          agencyId: agency.id,
          businessId: business.id,
          actorKind: 'system',
          correlationId: synchronized[0]?.context.correlationId,
        },
      },
    ]);
    expect(await queued('mailboxes.schedule_syncs')).toEqual([]);
  });

  it("queues a due Google Calendar reading in the member's business, and sweeps campaigns", async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const member = await database.fixtures.user();
    const [connection] = await database.withTenant(business.context, (client) =>
      client.query<{ id: string }>(
        `with secret as (
           insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
           values ($1, $2, 'calendar.google.refresh_token', 1, decode(repeat('01',32),'hex'),
                   decode(repeat('ab',32),'hex')) returning id
         )
         insert into calendar.google_connections
           (business_id, user_id, status, google_sub, google_email, secret_id, next_refresh_at)
         select $2, $3, 'connected', 'sub-1', 'member@example.test', secret.id,
                now() - interval '1 minute'
         from secret returning id`,
        [agency.id, business.id, member.id],
      ),
    );
    if (connection === undefined) throw new Error('No Google connection fixture.');
    const refreshed: { data: unknown; context: TenantContext }[] = [];
    const refresh = defineTask({
      name: 'calendar.google.refresh_busy',
      data: z.strictObject({ connectionId: z.uuid(), readCalendars: z.boolean() }),
      run(data, job) {
        refreshed.push({ data, context: job.invocation.context });
        return Promise.resolve();
      },
    });
    // The campaign sweep is registered only beside the task that sends a campaign.
    const campaigns = defineTask({
      name: 'campaigns.run',
      data: z.unknown(),
      run: () => Promise.resolve(),
    });
    workers.push(
      await startWorker({
        connectionString: database.url('crm_worker'),
        services,
        tasks: [refresh, campaigns],
        logger: pino({ level: 'silent' }),
        shutdownTimeoutMs: 1000,
      }),
    );
    // As the one-minute schedules do, without waiting for a minute boundary.
    await database.as('crm_owner', (client) =>
      client.query('select graphile_worker.add_job($1), graphile_worker.add_job($2)', [
        SCHEDULE_GOOGLE,
        SCHEDULE_CAMPAIGNS,
      ]),
    );
    await eventually(() => (refreshed.length > 0 ? true : undefined));
    expect(refreshed).toEqual([
      {
        data: { connectionId: connection.id, readCalendars: false },
        context: expect.objectContaining({
          agencyId: agency.id,
          businessId: business.id,
          actorKind: 'system',
        }) as TenantContext,
      },
    ]);
    await eventually(async () =>
      (await queued(SCHEDULE_CAMPAIGNS)).length === 0 &&
      (await queued(SCHEDULE_GOOGLE)).length === 0
        ? true
        : undefined,
    );
  });

  it('queues a due integration check in its business, and clears an attempt past its time', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const member = await database.fixtures.user();
    const [connection] = await database.withTenant(business.context, (client) =>
      client.query<{ id: string }>(
        `with secret as (
           insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
           values ($1, $2, 'integrations.standin.credentials', 1, decode(repeat('01',32),'hex'),
                   decode(repeat('ab',32),'hex')) returning id
         )
         insert into integrations.connections
           (business_id, provider, account_ref, account_label, status, secret_id, next_check_at)
         select $2, 'standin', 'acct-1', 'Workspace', 'connected', secret.id,
                now() - interval '1 minute'
         from secret returning id`,
        [agency.id, business.id],
      ),
    );
    if (connection === undefined) throw new Error('No integration fixture.');
    await database.withTenant(business.context, (client) =>
      client.query(
        `insert into integrations.connect_attempts (business_id, provider, user_id, state_digest, expires_at)
         values ($1, 'standin', $2, sha256('worker-schedule'::bytea), now() - interval '2 hours')`,
        [business.id, member.id],
      ),
    );
    const checked: unknown[] = [];
    const check = defineTask({
      name: 'integrations.check',
      data: z.strictObject({ connectionId: z.uuid() }),
      run(data) {
        checked.push(data);
        return Promise.resolve();
      },
    });
    workers.push(
      await startWorker({
        connectionString: database.url('crm_worker'),
        services,
        tasks: [check],
        logger: pino({ level: 'silent' }),
        shutdownTimeoutMs: 1000,
      }),
    );
    await database.as('crm_owner', (client) =>
      client.query('select graphile_worker.add_job($1)', [SCHEDULE_INTEGRATIONS]),
    );
    await eventually(() => (checked.length > 0 ? true : undefined));
    expect(checked).toEqual([{ connectionId: connection.id }]);
    await eventually(async () =>
      (await queued(SCHEDULE_INTEGRATIONS)).length === 0 ? true : undefined,
    );
    const left = await database.as('crm_owner', (client) =>
      client.query('select 1 from integrations.connect_attempts where business_id = $1', [
        business.id,
      ]),
    );
    expect(left).toEqual([]);
  });

  it('runs a committed job once, in the business that added it, as the system', async () => {
    await startedWorker();
    const invocation = await userInBusiness();

    await runCommand(services, addJob, { task: 'noted', note: 'once' }, invocation);

    await eventually(async () =>
      ranWith('once').length > 0 && (await queued('test.noted')).length === 0 ? true : undefined,
    );
    const { agencyId, businessId, correlationId } = invocation.context;
    expect(ranWith('once')).toEqual([
      { note: 'once', context: { agencyId, businessId, actorKind: 'system', correlationId } },
    ]);
  });

  it('hands a task the priority its job has in the queue, so a task that queues itself keeps it', async () => {
    const invocation = await userInBusiness();
    await runCommand(services, addJob, { task: 'noted', note: 'prioritized' }, invocation);
    // The queue's own record, given a place behind priority 0 as a bulk job is.
    const moved = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>(
        `update graphile_worker._private_jobs as job set priority = 7
         from graphile_worker._private_tasks as task
         where task.id = job.task_id and task.identifier = 'test.noted' and job.locked_at is null
         returning job.id`,
      ),
    );
    expect(moved).toHaveLength(1);

    await startedWorker();

    const seen = await eventually(() => priorities.find((run) => run.note === 'prioritized'));
    expect(seen.priority).toBe(7);
  });

  it("passes the job's cause on, so the events of a command it runs point at it", async () => {
    await startedWorker();
    const invocation = await userInBusiness();

    const started = await runCommand(services, startChain, {}, invocation);

    const followed = await eventually(async () => {
      const [event] = await database.as('crm_owner', (sql) =>
        sql.query<{ causation_id: string; correlation_id: string; actor_kind: string }>(
          `select causation_id, correlation_id, actor_kind from events.events
           where type = 'agency.followed_up' and correlation_id = $1`,
          [invocation.context.correlationId],
        ),
      );
      return event;
    });
    expect(followed).toEqual({
      causation_id: started,
      correlation_id: invocation.context.correlationId,
      actor_kind: 'system',
    });
  });

  it('lets "Why?" follow a job\'s work back to the person who started it', async () => {
    await startedWorker();
    const invocation = await userInBusiness('Dana Brooks');
    const started = await runCommand(services, startChain, {}, invocation);
    const followed = await eventually(async () => {
      const [event] = await database.as('crm_owner', (sql) =>
        sql.query<{ id: string }>(
          `select id from events.events where type = 'agency.followed_up' and correlation_id = $1`,
          [invocation.context.correlationId],
        ),
      );
      return event?.id;
    });
    const explain = apiRoutes().find((route) => route.endpoint.operationId === 'explainEvent');

    const chain = eventChain.parse(
      await explain?.run(
        { invocation, params: { id: toPublicId('event', followed) }, query: {}, body: undefined },
        services,
      ),
    );

    expect(chain).toMatchObject({
      reachesOrigin: true,
      items: [
        {
          id: toPublicId('event', started),
          type: 'agency.chain_started',
          actor: { kind: 'user', name: 'Dana Brooks', you: true },
          causedBy: null,
        },
        {
          id: toPublicId('event', followed),
          type: 'agency.followed_up',
          actor: { kind: 'system', name: null, you: false },
          causedBy: toPublicId('event', started),
        },
      ],
    });
  });

  it('never runs a job whose command rolled back', async () => {
    await startedWorker();
    const invocation = await userInBusiness();

    await expect(
      runCommand(services, addJob, { task: 'noted', note: 'never', fail: true }, invocation),
    ).rejects.toThrow('the command failed');
    await runCommand(services, addJob, { task: 'noted', note: 'after' }, invocation);

    // One job at a time, oldest first: had the first job been written, it would have run.
    await eventually(() => (ranWith('after').length > 0 ? true : undefined));
    expect(ranWith('never')).toEqual([]);
    expect(await queued('test.noted')).toEqual([]);
  });

  it('keeps a failed job, to try it again later', async () => {
    await startedWorker();

    await runCommand(services, addJob, { task: 'failing' }, await userInBusiness());

    // An attempt counts from when the job is taken; the error is recorded when it fails.
    const [job] = await eventually(async () => {
      const jobs = await queued('test.failing');
      return jobs[0]?.last_error === null ? undefined : jobs;
    });
    expect(job?.attempts).toBe(1);
    expect(job?.last_error).toContain('the task failed');
    expect(job?.later).toBe(true);
  });

  it('keeps the monthly partitions three months ahead', async () => {
    await startedWorker();
    const partition = await database.as('crm_owner', (sql) =>
      sql.one<{ name: string }>(
        `select 'events.events_p' || to_char(date_trunc('month', now() at time zone 'UTC')
                + interval '3 months', 'YYYY_MM') as name`,
      ),
    );
    await database.as('crm_owner', (sql) => sql.query(`drop table ${partition.name}`));

    // As the daily schedule does.
    await database.as('crm_owner', (sql) =>
      sql.query('select graphile_worker.add_job($1)', [MAINTAIN_PARTITIONS]),
    );

    await eventually(async () => {
      const [found] = await database.as('crm_owner', (sql) =>
        sql.query<{ exists: boolean }>('select to_regclass($1) is not null as exists', [
          partition.name,
        ]),
      );
      return found?.exists === true ? true : undefined;
    });
  });

  it("purges what's been in a business's trash past its retention days", async () => {
    await startedWorker();
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const expired = await database.fixtures.contact(business.context);
    const recent = await database.fixtures.contact(business.context);
    await database.withTenant(business.context, (sql) =>
      sql.query(
        `update crm.contacts set deleted_at = now() - case id when $1 then interval '31 days'
           else interval '29 days' end where id in ($1, $2)`,
        [expired.id, recent.id],
      ),
    );

    // As the daily schedule does.
    await database.as('crm_owner', (sql) =>
      sql.query('select graphile_worker.add_job($1)', [PURGE_TRASH]),
    );

    const left = await eventually(async () => {
      const rows = await database.as('crm_owner', (sql) =>
        sql.query<{ id: string }>('select id from crm.records where id in ($1, $2)', [
          expired.id,
          recent.id,
        ]),
      );
      return rows.length === 1 ? rows : undefined;
    });
    expect(left).toEqual([{ id: recent.id }]);
  });

  it('clears expired calling tokens through the worker and retains current grants', async () => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const user = await database.fixtures.user();
    const vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
    const activeToken = 'current-worker-fixture-token';
    const ids = await withTenant(db, business.context, async (trx) => {
      const credentials = await vault.store(
        trx,
        { agencyId: agency.id, businessId: business.id, purpose: 'sms.twilio.credentials' },
        JSON.stringify({ accountSid: `AC${'0'.repeat(32)}`, authToken: 'worker-fixture' }),
      );
      const connection = await trx
        .insertInto('messaging.provider_connections')
        .values({
          agency_id: agency.id,
          business_id: business.id,
          provider: 'twilio',
          label: 'Calling cleanup fixture',
          account_ref: `AC${'0'.repeat(32)}`,
          secret_id: credentials,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const signingKey = await vault.store(
        trx,
        { agencyId: agency.id, businessId: business.id, purpose: VOICE_SIGNING_KEY },
        JSON.stringify({ sid: `SK${'0'.repeat(32)}`, secret: 'worker-fixture', type: 'standard' }),
      );
      await trx
        .insertInto('messaging.voice_setups')
        .values({
          business_id: business.id,
          connection_id: connection.id,
          status: 'ready',
          key_sid: `SK${'0'.repeat(32)}`,
          secret_id: signingKey,
          finished_at: new Date(),
        })
        .execute();
      const base = {
        business_id: business.id,
        connection_id: connection.id,
        user_id: user.id,
      };
      const issued = {
        ...base,
        status: 'issued',
        requested_at: new Date(Date.now() - 600_000),
        expires_at: new Date(Date.now() - 480_000),
        issued_at: new Date(Date.now() - 540_000),
      };
      const expired = await trx
        .insertInto('messaging.voice_grants')
        .values({
          ...issued,
          token: 'expired-worker-fixture-token',
          token_expires_at: new Date(Date.now() - 60_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const active = await trx
        .insertInto('messaging.voice_grants')
        .values({ ...issued, token: activeToken, token_expires_at: new Date(Date.now() + 300_000) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.voice_grants')
        .values({
          ...base,
          requested_at: new Date(Date.now() - 172_800_000),
          expires_at: new Date(Date.now() - 172_680_000),
        })
        .execute();
      return { expired: expired.id, active: active.id };
    });
    const log: LogLine[] = [];
    await startedWorker(1000, log);
    const grants = () =>
      database.withTenant(business.context, (sql) =>
        sql.query<{ id: string; token: string | null }>(
          'select id,token from messaging.voice_grants order by id',
        ),
      );
    await maintain(MAINTAIN_VOICE);
    const rows = await eventually(async () => {
      const rows = await grants();
      return rows.length === 2 && rows.find((row) => row.id === ids.expired)?.token === null
        ? rows
        : undefined;
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: ids.expired, token: null },
        { id: ids.active, token: activeToken },
      ]),
    );
    await eventually(() => log.find((line) => line.msg === 'cleared expired calling tokens'));
    await maintain(MAINTAIN_VOICE);
    expect(await grants()).toEqual(rows);
    expect(log.filter((line) => line.msg === 'cleared expired calling tokens')).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain(activeToken);
  });

  it('clears AI request logs past the days their business keeps them, and keeps the spend', async () => {
    const log: LogLine[] = [];
    await startedWorker(1000, log);
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const call = (expires: string) =>
      database.withTenant(business.context, (sql) =>
        sql.one<{ id: string }>(
          `insert into ai.requests (business_id, job, provider, model, key_source, status,
                                    cost_estimate, actor_kind, finished_at, log, log_expires_at)
           values (app.business_id(), 'replies', 'anthropic', 'claude-sonnet-5-5', 'own', 'ok',
                   0.0054, 'ai_agent', now(), '{"request": {"system": "What was said."}}',
                   now() + $1::interval)
           returning id`,
          [expires],
        ),
      );
    const expired = await call('-1 hour');
    const kept = await call('29 days');

    // As the hourly schedule does.
    await maintain(MAINTAIN_AI);

    const requests = () =>
      database.withTenant(business.context, (sql) =>
        sql.query<{ id: string; logged: boolean; cost_estimate: string }>(
          'select id, log is not null as logged, cost_estimate from ai.requests order by id',
        ),
      );
    const rows = await eventually(async () => {
      const found = await requests();
      return found.some((row) => !row.logged) ? found : undefined;
    });
    expect(rows).toEqual([
      { id: expired.id, logged: false, cost_estimate: '0.005400' },
      { id: kept.id, logged: true, cost_estimate: '0.005400' },
    ]);
    await maintain(MAINTAIN_AI);
    expect(await requests()).toEqual(rows);
    expect(log.filter((line) => line.msg === 'cleared expired AI request logs')).toHaveLength(1);
  });

  it('removes sign-in mail and mailbox credentials left waiting past ten minutes, and keeps what is newer', async () => {
    const vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
    const invocation = await userInBusiness();
    const { agencyId, businessId } = invocation.context;
    if (businessId === undefined) throw new Error('No business fixture.');
    // The mailbox the install sends its sign-in links from.
    const [mailbox] = await database.withTenant(invocation.context, (client) =>
      client.query<{ id: string }>(
        `with secret as (
           insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
           values ($1, $2, 'mailbox.credentials', 1, decode(repeat('01',32),'hex'),
                   decode(repeat('ab',32),'hex')) returning id
         ), account as (
           insert into messaging.channel_accounts (business_id, channel, name)
           values ($2, 'email', 'Install sender fixture') returning id
         )
         insert into messaging.mailboxes
           (business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,
            smtp_username,imap_host,imap_port,imap_security,imap_username,secret_id)
         select $2,account.id,'install@example.test','password','mail.example.test',465,'tls',
                'install@example.test','mail.example.test',993,'tls','install@example.test',secret.id
         from account,secret returning id`,
        [agencyId, businessId],
      ),
    );
    if (mailbox === undefined) throw new Error('No mailbox fixture.');
    const secrets = (purpose: string) =>
      database.withTenant(invocation.context, (client) =>
        client.query<{ id: string }>(
          'select id from vault.secrets where purpose = $1 order by created_at, id',
          [purpose],
        ),
      );
    const age = (table: string, id: string | undefined, extra = '') =>
      database.as('crm_owner', (client) =>
        client.query(
          `update ${table} set created_at = now() - interval '11 minutes'${extra} where id = $1`,
          [id],
        ),
      );
    // Two sign-in links nobody delivered: no worker ran their delivery. One is eleven
    // minutes old.
    const mailer = createQueuedInstallMailer(services, vault, { mailboxId: mailbox.id });
    const link = { to: 'person@example.test', subject: 'Sign in', text: 'Fixture link' };
    await mailer.send(link);
    const [abandoned] = await secrets('mailbox.install_message');
    await age('vault.secrets', abandoned?.id);
    await mailer.send(link);
    const waiting = (await secrets('mailbox.install_message')).filter(
      (secret) => secret.id !== abandoned?.id,
    );
    expect(abandoned).toBeDefined();
    expect(waiting).toHaveLength(1);
    // Two mailboxes being connected, whose logins nobody verified. One ran out of time.
    const connect = (email: string) =>
      runCommand(
        services,
        createConnectMailboxCommand(vault),
        {
          name: 'Work',
          email,
          displayName: 'Fixture',
          smtp: {
            host: 'mail.example.test',
            port: 465,
            security: 'tls',
            username: email,
            password: 'fixture-password',
          },
          imap: {
            host: 'mail.example.test',
            port: 993,
            security: 'tls',
            username: email,
            password: 'fixture-password',
          },
        },
        invocation,
      );
    const attempts = () =>
      database.withTenant(invocation.context, (client) =>
        client.query<{
          id: string;
          status: string;
          failure: string | null;
          secret_id: string | null;
        }>(
          `select id, status, failure_code as failure, secret_id
           from messaging.mailbox_connection_attempts order by created_at, id`,
        ),
      );
    const expiredId = parsePublicId('mailbox_attempt', (await connect('late@example.test')).id);
    const expiredLogin = (await attempts())[0]?.secret_id ?? undefined;
    if (expiredId === undefined || expiredLogin === undefined)
      throw new Error('No pending attempt fixture.');
    await age(
      'messaging.mailbox_connection_attempts',
      expiredId,
      ", expires_at = now() - interval '1 minute'",
    );
    const pendingId = parsePublicId('mailbox_attempt', (await connect('new@example.test')).id);
    const log: LogLine[] = [];
    const worker = await startWorker({
      connectionString: database.url('crm_worker'),
      services,
      tasks: [],
      mailboxVault: vault,
      logger: pino(
        { level: 'debug' },
        {
          write: (line: string) => {
            log.push(logLine.parse(JSON.parse(line)));
          },
        },
      ),
      shutdownTimeoutMs: 1000,
    });
    workers.push(worker);

    // As the five-minute schedule does.
    await database.as('crm_owner', (sql) =>
      sql.query('select graphile_worker.add_job($1)', [EXPIRE_MAILBOX_ATTEMPTS]),
    );

    await eventually(() => log.find((each) => each.msg === 'removed expired install messages'));
    expect(await queued(EXPIRE_MAILBOX_ATTEMPTS)).toEqual([]);
    expect(await secrets('mailbox.install_message')).toEqual(waiting);
    expect(log.filter((each) => each.msg === 'removed expired install messages')).toMatchObject([
      { level: 30, expiredMessages: 1 },
    ]);
    const [, pendingAttempt] = await attempts();
    expect(await attempts()).toEqual([
      { id: expiredId, status: 'failed', failure: 'expired', secret_id: null },
      { id: pendingId, status: 'pending', failure: null, secret_id: pendingAttempt?.secret_id },
    ]);
    expect(pendingAttempt?.secret_id).toEqual(expect.any(String));
    // The mailbox's own login and the login still being verified stay; the expired one went.
    const logins = (await secrets('mailbox.credentials')).map((secret) => secret.id);
    expect(logins).toHaveLength(2);
    expect(logins).toContain(pendingAttempt?.secret_id);
    expect(logins).not.toContain(expiredLogin);
    expect(log.filter((each) => each.msg === 'removed expired mailbox credentials')).toMatchObject([
      { level: 30, expired: 1 },
    ]);
    const keptAttempts = await attempts();
    await maintain(EXPIRE_MAILBOX_ATTEMPTS);
    expect(await attempts()).toEqual(keptAttempts);
    expect((await secrets('mailbox.credentials')).map((secret) => secret.id)).toEqual(logins);
    expect(await secrets('mailbox.install_message')).toEqual(waiting);
    expect(log.filter((each) => each.msg === 'removed expired mailbox credentials')).toHaveLength(
      1,
    );
    expect(log.filter((each) => each.msg === 'removed expired install messages')).toHaveLength(1);
  });

  it('stops by the deadline, failing a job still running so that it runs again', async () => {
    const worker = await startedWorker(500);
    await runCommand(services, addJob, { task: 'waiting', note: 'slow' }, await userInBusiness());
    await eventually(() => (ranWith('slow').length > 0 ? true : undefined));

    const began = Date.now();
    await worker.stop();

    const stoppedIn = Date.now() - began;
    const [job, ...others] = await queued('test.waiting');
    // The job never finishes. Take it out of the queue, or a later test's worker would take
    // its retry and hang on it.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `select graphile_worker.complete_jobs(array(
           select id from graphile_worker.jobs where task_identifier = 'test.waiting'))`,
      ),
    );
    expect(stoppedIn).toBeLessThan(3000);
    expect(others).toEqual([]);
    expect(job?.attempts).toBe(1);
    expect(job?.last_error).toContain('the shutdown deadline passed');
    expect(job?.later).toBe(true);
  });

  it('ends by itself when a newer release migrates the queue', async () => {
    const worker = await startedWorker();
    let ended = false;
    void worker.ended.then(() => {
      ended = true;
    });

    // Sent until heard: the worker starts listening a moment after it starts.
    await eventually(async () => {
      if (!ended) {
        await database.as('crm_owner', (sql) =>
          sql.query(
            `select pg_notify('worker:migrate', '{"migrationNumber": 999, "breaking": true}')`,
          ),
        );
      }
      return ended ? true : undefined;
    });
    // Graphile Worker sets this so that a process that does nothing else exits; this one
    // carries on.
    process.exitCode = undefined;
  });
});

describe('the worker, when things go wrong', () => {
  it('refuses readiness when initial task registration fails, then starts after access is restored', async () => {
    await database.as('crm_owner', (sql) =>
      sql.query('revoke select, insert on graphile_worker._private_tasks from crm_worker'),
    );
    try {
      await expect(startedWorker()).rejects.toThrow(
        "The worker couldn't start the job queue; is the database up and migrated?",
      );
    } finally {
      await database.as('crm_owner', (sql) =>
        sql.query('grant select, insert on graphile_worker._private_tasks to crm_worker'),
      );
    }
    await startedWorker();
    await runCommand(
      services,
      addJob,
      { task: 'noted', note: 'restored startup' },
      await userInBusiness(),
    );
    await eventually(() => (ranWith('restored startup').length > 0 ? true : undefined));
  });
  it("refuses to start when it can't reach the queue", async () => {
    await expect(
      startWorker({
        connectionString: 'postgres://crm_worker@127.0.0.1:1/crm',
        services,
        tasks: [],
        logger: pino({ level: 'silent' }),
        shutdownTimeoutMs: 1000,
      }),
    ).rejects.toThrow("The worker couldn't start the job queue; is the database up and migrated?");
  });

  it('logs a failed job with its error', async () => {
    const log: LogLine[] = [];
    await startedWorker(1000, log);

    await runCommand(services, addJob, { task: 'failing' }, await userInBusiness());

    const line = await eventually(() => log.find((each) => each.msg.startsWith('Failed task')));
    expect(line).toMatchObject({ level: 50, err: { message: 'the task failed' } });
  });

  it('logs each queue connection that drops, and keeps working', async () => {
    const log: LogLine[] = [];
    await startedWorker(1000, log);

    await database.as('postgres', (sql) =>
      sql.query(
        `select pg_terminate_backend(pid, 5000) from pg_stat_activity
         where usename = 'crm_worker' and datname = current_database()`,
      ),
    );

    await eventually(() => log.find((each) => each.msg === 'job queue connection failed'));
    await runCommand(
      services,
      addJob,
      { task: 'noted', note: 'still working' },
      await userInBusiness(),
    );
    // CI once timed out here, and 34 local runs, 18 of them under load, couldn't repeat
    // it. If it happens again, the failure says what the worker did and where the job is.
    await eventually(() => (ranWith('still working').length > 0 ? true : undefined)).catch(
      async (error: unknown) => {
        const job = await queued('test.noted');
        throw new Error(
          `The job didn't run. The worker logged ${JSON.stringify(log.map((line) => line.msg))}; the job: ${JSON.stringify(job)}`,
          { cause: error },
        );
      },
    );
  });

  it('runs agency-level work with no business in its context', async () => {
    await startedWorker();
    const { context } = await userInBusiness();
    const { businessId: _none, ...agencyStaff } = context;

    await runCommand(
      services,
      addJob,
      { task: 'noted', note: 'agency' },
      { context: agencyStaff, permissions: 'all' },
    );

    await eventually(() => (ranWith('agency').length > 0 ? true : undefined));
    expect(ranWith('agency')[0]?.context).toEqual({
      agencyId: context.agencyId,
      actorKind: 'system',
      correlationId: context.correlationId,
    });
  });

  it('runs a job a newer release queued, with fields it does not know (1A review A8)', async () => {
    await startedWorker();
    const { context } = await userInBusiness();

    // As a newer app would queue it during a deploy, while this worker still runs.
    await database.as('crm_owner', (sql) =>
      sql.query('select graphile_worker.add_job($1, $2::json)', [
        noted.name,
        JSON.stringify({
          agencyId: context.agencyId,
          businessId: context.businessId,
          correlationId: context.correlationId,
          causationId: null,
          traceId: 'from-a-newer-release',
          data: { note: 'newer' },
        }),
      ]),
    );

    await eventually(() => (ranWith('newer').length > 0 ? true : undefined));
  });
});
