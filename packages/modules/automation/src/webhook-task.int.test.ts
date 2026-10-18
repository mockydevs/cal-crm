// webhook.call end to end: the step arms and waits, a delivery job calls out with no
// transaction open and records the result under the enrolment's lock, failures are retried
// on a schedule, a lost job is queued again, and nothing is sent unsigned. Real Postgres
// and the real commands; the network is a stand-in, so nothing leaves the machine.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError, toPublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createDeletionCommands } from './deletion.js';
import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { contactValues } from './values.js';
import { WEBHOOK_MAX_ATTEMPTS, type WebhookCallResult } from './webhook.js';
import {
  createRotateWebhookSecretCommand,
  type SecretOpener,
  type SecretSealer,
} from './webhook-signing.js';
import {
  createCallWebhookTask,
  recordWebhookResultCommand,
  WEBHOOK_RECOVERY_MS,
} from './webhook-task.js';

// These automations create no tasks, so nothing here resolves an assignee.
const runStepCommand = createRunStepCommand({
  tasks: {
    actorNames: {},
    assignees: {
      resolve: () => Promise.resolve(null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map<string, string>()),
    },
  },
});

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

// Stands in for the vault: real rows in vault.secrets, with the plaintext kept here.
function standInVault(): SecretSealer & SecretOpener {
  const plaintexts = new Map<string, string>();
  const sealed = () => sql<Buffer>`decode(repeat('ab', 32), 'hex')`;
  return {
    async store(trx: DatabaseTransaction, owner, plaintext) {
      const { id } = await trx
        .insertInto('vault.secrets')
        .values({
          agency_id: owner.agencyId,
          business_id: owner.businessId,
          purpose: owner.purpose,
          key_version: 1,
          enc: sealed(),
          ciphertext: sealed(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      plaintexts.set(id, plaintext);
      return id;
    },
    replace: (_trx, secretId, plaintext) => {
      plaintexts.set(secretId, plaintext);
      return Promise.resolve();
    },
    read: (_trx, secretId) => {
      const plaintext = plaintexts.get(secretId);
      return plaintext === undefined
        ? Promise.reject(new Error('No such secret.'))
        : Promise.resolve(plaintext);
    },
  };
}

interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
  readonly secret: string;
  readonly deliveryId: string | undefined;
}

interface Scene {
  readonly context: TenantContext;
  readonly enrolmentId: string;
  readonly runId: string;
  /** The secret the business was shown, or undefined when it has none. */
  readonly secret: string | undefined;
  readonly sent: Sent[];
  /** Runs the enrolment's step as the worker would, optionally at a later time. */
  step(now?: Date): Promise<'ran' | 'skipped'>;
  /** Runs one delivery job, with the network answering as given. */
  deliver(answer: WebhookCallResult, data?: { sequence?: number; attempt?: number }): Promise<void>;
  enrolment(): Promise<{
    status: string;
    current_step: string | null;
    exit_reason: string | null;
    wake_at: Date | null;
    state: { sequence: number; webhook?: { attempt: number; result?: unknown; body: string } };
  }>;
  /** The delivery job queued for the enrolment, if any. */
  job(): Promise<{ data: unknown; run_at: Date } | undefined>;
  stepRuns(): Promise<{ step_key: string; status: string; output: unknown }[]>;
}

const ok = (status = 204): WebhookCallResult => ({ ok: true, status, body: '', truncated: false });
const failed = (
  code: 'http_error' | 'timeout' | 'blocked_address',
  retryable: boolean,
  retryAfterMs?: number,
): WebhookCallResult => ({
  ok: false,
  code,
  retryable,
  message: `It answered ${code}.`,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

/** A business with one contact enrolled in an automation that calls a webhook, then waits. */
async function scene(
  options: { secret?: boolean; body?: string; firstName?: string } = {},
): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const vault = standInVault();
  const secret =
    options.secret === false
      ? undefined
      : (
          await runCommand(
            services,
            createRotateWebhookSecretCommand({ vault, lockBusiness: () => Promise.resolve() }),
            {},
            { context, permissions: 'all' },
          )
        ).secret;
  const document: AutomationDocumentInput = {
    name: 'Tell the warehouse',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'tell',
    steps: {
      tell: {
        type: 'webhook.call',
        config: {
          url: 'https://hooks.example.test/crm',
          ...(options.body === undefined ? {} : { body: options.body }),
        },
        next: 'pause',
      },
      pause: { type: 'wait', config: { duration: 'P1D' } },
    },
  };
  await runCommand(
    services,
    createContactCommand,
    { firstName: options.firstName ?? 'Ada', emails: [`${randomUUID()}@example.test`] },
    { context, permissions: 'all' },
  );
  const enrolmentId = await withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
    const event = await trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow();
    const [first] = (await matchEvent(trx, context, event.id, contactValues)).enrolled;
    if (first === undefined) throw new Error('Nothing enrolled.');
    return first.enrolmentId;
  });
  const sent: Sent[] = [];
  const enrolment: Scene['enrolment'] = () =>
    database
      .withTenant(context, (client) =>
        client.query<Awaited<ReturnType<Scene['enrolment']>>>(
          `select status, current_step, exit_reason, wake_at, state
           from automation.enrolments where id = $1`,
          [enrolmentId],
        ),
      )
      .then(([row]) => {
        if (row === undefined) throw new Error('The enrolment exists.');
        return row;
      });
  return {
    context,
    enrolmentId,
    runId: toPublicId('automation_enrolment', enrolmentId),
    secret,
    sent,
    enrolment,
    step: async (now) =>
      runCommand(
        services,
        runStepCommand,
        {
          enrolmentId,
          sequence: (await enrolment()).state.sequence,
          ...(now === undefined ? {} : { now: now.toISOString() }),
        },
        { context, permissions: 'all' },
      ),
    deliver: async (answer, data = {}) => {
      const current = await enrolment();
      const task = createCallWebhookTask({
        vault,
        call: (config, body, callOptions) => {
          sent.push({
            url: config.url,
            method: config.method,
            body,
            secret: callOptions.secret,
            deliveryId: callOptions.deliveryId,
          });
          return Promise.resolve(answer);
        },
      });
      await task.run(
        {
          enrolmentId,
          sequence: data.sequence ?? current.state.sequence,
          attempt: data.attempt ?? current.state.webhook?.attempt ?? 0,
        },
        { invocation: { context, permissions: 'all' }, services },
      );
    },
    job: async () => {
      const [row] = await database.as('postgres', (client) =>
        client.query<{ data: unknown; run_at: Date }>(
          `select payload -> 'data' as data, run_at from graphile_worker._private_jobs
           where key = $1`,
          [`automation-webhook:${enrolmentId}`],
        ),
      );
      return row;
    },
    stepRuns: () =>
      database.withTenant(context, (client) =>
        client.query(
          `select step_key, status, output from automation.step_runs
           where enrolment_id = $1 order by started_at, id`,
          [enrolmentId],
        ),
      ),
  };
}

it('arms, delivers once signed and named, and goes on with the answer', async () => {
  const s = await scene();
  expect(await s.step()).toBe('ran');
  // The step waits where it is; nothing was sent inside its transaction.
  expect(s.sent).toEqual([]);
  expect(await s.enrolment()).toMatchObject({
    status: 'waiting',
    current_step: 'tell',
    state: { sequence: 1, webhook: { attempt: 0 } },
  });
  expect((await s.job())?.data).toEqual({ enrolmentId: s.enrolmentId, sequence: 1, attempt: 0 });

  await s.deliver(ok(202));
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]).toMatchObject({
    url: 'https://hooks.example.test/crm',
    secret: s.secret,
    deliveryId: `${s.runId}:1`,
    body: { event: 'automation.webhook', deliveryId: `${s.runId}:1`, runId: s.runId, step: 'tell' },
  });

  expect(await s.step()).toBe('ran');
  const after = await s.enrolment();
  // On to the next step, which has yet to run.
  expect(after).toMatchObject({ status: 'running', current_step: 'pause' });
  expect(after.state.webhook).toBeUndefined();
  // The row that queued the delivery stopped waiting when the result's row was written.
  expect(await s.stepRuns()).toMatchObject([
    { step_key: 'tell', status: 'succeeded' },
    { step_key: 'tell', status: 'succeeded', output: { status: 202 } },
  ]);
});

it('retries a failure worth retrying, with the same body and delivery id, then goes on', async () => {
  const s = await scene({ body: '{"name": "{{contact.firstName}}"}' });
  await s.step();
  const before = Date.now();
  await s.deliver(failed('http_error', true, 90_000));
  const waiting = await s.enrolment();
  expect(waiting).toMatchObject({
    status: 'waiting',
    current_step: 'tell',
    state: { sequence: 1, webhook: { attempt: 1 } },
  });
  expect(waiting.state.webhook?.result).toBeUndefined();
  const retry = await s.job();
  expect(retry?.data).toEqual({ enrolmentId: s.enrolmentId, sequence: 1, attempt: 1 });
  // Retry-After asked for 90 seconds, longer than the first step of the schedule.
  expect(retry?.run_at.getTime()).toBeGreaterThanOrEqual(before + 90_000);
  // The check on a lost job moves out behind the retry.
  expect(waiting.wake_at?.getTime()).toBeGreaterThanOrEqual(before + 90_000 + WEBHOOK_RECOVERY_MS);

  // The first attempt's job, run again, is stale: it sends nothing and records nothing.
  await s.deliver(ok(), { attempt: 0 });
  expect(s.sent).toHaveLength(1);

  await s.deliver(ok(200));
  expect(s.sent).toHaveLength(2);
  expect(s.sent[1]).toEqual(s.sent[0]);
  expect(s.sent[1]?.body).toEqual({ name: 'Ada' });
  await s.step();
  expect(await s.enrolment()).toMatchObject({ current_step: 'pause' });
});

it('fails the step at once on a failure not worth retrying', async () => {
  const s = await scene();
  await s.step();
  await s.deliver(failed('blocked_address', false));
  // No retry was queued: the only job is still the first attempt's.
  expect((await s.job())?.data).toMatchObject({ attempt: 0 });
  expect((await s.enrolment()).state.webhook).toMatchObject({ attempt: 1 });
  await s.step();
  expect(await s.enrolment()).toMatchObject({
    status: 'failed',
    current_step: null,
    exit_reason: 'blocked_address',
  });
  expect((await s.stepRuns()).at(-1)).toMatchObject({ step_key: 'tell', status: 'failed' });
});

it('retries a timeout with backoff: each retry is queued twice as long after as the last', async () => {
  const s = await scene();
  await s.step();
  const delays: number[] = [];
  for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    const before = Date.now();
    await s.deliver(failed('timeout', true));
    const after = Date.now();
    const retry = await s.job();
    expect(retry?.data).toMatchObject({ attempt });
    const runAt = retry?.run_at.getTime() ?? 0;
    // The queued job's own time, within the moment the attempt took to record.
    const delay = Math.round((runAt - before) / 60_000);
    expect(runAt).toBeGreaterThanOrEqual(before + delay * 60_000 - 1000);
    expect(runAt).toBeLessThanOrEqual(after + delay * 60_000 + 1000);
    delays.push(delay);
  }
  // Minutes after each failed attempt: 1, then doubling.
  expect(delays).toEqual([1, 2, 4, 8, 16]);
});

it('gives up when the attempts are used up', async () => {
  const s = await scene();
  await s.step();
  for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    await s.deliver(failed('timeout', true));
    expect((await s.enrolment()).state.webhook).toMatchObject({ attempt });
  }
  await s.deliver(failed('timeout', true));
  expect(s.sent).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
  expect(new Set(s.sent.map((each) => each.deliveryId)).size).toBe(1);
  await s.step();
  expect(await s.enrolment()).toMatchObject({ status: 'failed', exit_reason: 'timeout' });
});

it('queues the delivery again when its job was lost, and not before the check is due', async () => {
  const s = await scene();
  await s.step();
  const armed = await s.enrolment();
  await database.as('postgres', (client) =>
    client.query('delete from graphile_worker._private_jobs where key = $1', [
      `automation-webhook:${s.enrolmentId}`,
    ]),
  );
  // Too early: the delivery may simply be on its way.
  expect(await s.step(new Date(Date.now() + 1000))).toBe('skipped');
  expect(await s.job()).toBeUndefined();

  const due = new Date((armed.wake_at?.getTime() ?? 0) + 1000);
  expect(await s.step(due)).toBe('ran');
  expect((await s.job())?.data).toEqual({ enrolmentId: s.enrolmentId, sequence: 1, attempt: 0 });
  const after = await s.enrolment();
  expect(after).toMatchObject({ status: 'waiting', current_step: 'tell', state: { sequence: 1 } });
  expect(after.wake_at?.getTime()).toBe(due.getTime() + WEBHOOK_RECOVERY_MS);
  // Still one visit recorded: the check is not a new attempt at the step.
  expect(await s.stepRuns()).toHaveLength(1);
  await s.deliver(ok());
  expect(s.sent).toHaveLength(1);
});

it('never sends unsigned: no secret fails the step, and one removed later stops the delivery', async () => {
  const none = await scene({ secret: false });
  await none.step();
  expect(await none.enrolment()).toMatchObject({
    status: 'failed',
    exit_reason: 'no_webhook_secret',
  });
  expect(await none.job()).toBeUndefined();

  const removed = await scene();
  await removed.step();
  await database.as('postgres', (client) =>
    client.query('delete from automation.webhook_signing where business_id = $1', [
      removed.context.businessId,
    ]),
  );
  await removed.deliver(ok());
  expect(removed.sent).toEqual([]);
  await removed.step();
  expect(await removed.enrolment()).toMatchObject({
    status: 'failed',
    exit_reason: 'no_webhook_secret',
  });
});

it('fails the step, and queues nothing, when its body cannot be built', async () => {
  const missing = await scene({ body: '{"event": "{{contact.custom.event_date}}"}' });
  await missing.step();
  expect(await missing.enrolment()).toMatchObject({
    status: 'failed',
    exit_reason: 'missing_values',
  });
  expect(await missing.job()).toBeUndefined();

  const notJson = await scene({ body: 'name={{contact.firstName}}' });
  await notJson.step();
  expect(await notJson.enrolment()).toMatchObject({
    status: 'failed',
    exit_reason: 'invalid_body',
  });
});

it('lets only the engine record a result, and only for the attempt in flight', async () => {
  const s = await scene();
  await s.step();
  const record = (
    input: { sequence: number; attempt: number },
    context: TenantContext = s.context,
  ) =>
    runCommand(
      services,
      recordWebhookResultCommand,
      { enrolmentId: s.enrolmentId, ...input, result: { ok: true, status: 200 } },
      { context: { ...context, correlationId: randomUUID() }, permissions: 'all' },
    );
  await expect(
    record({ sequence: 1, attempt: 0 }, { ...s.context, actorKind: 'user', actorId: randomUUID() }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await record({ sequence: 0, attempt: 0 })).toBe('stale');
  expect(await record({ sequence: 1, attempt: 3 })).toBe('stale');
  expect((await s.enrolment()).state.webhook?.result).toBeUndefined();
  expect(await record({ sequence: 1, attempt: 0 })).toBe('recorded');
  // A second result for the same attempt changes nothing.
  expect(await record({ sequence: 1, attempt: 0 })).toBe('stale');

  const other = await scene();
  await other.step();
  expect(
    await runCommand(
      services,
      recordWebhookResultCommand,
      { enrolmentId: s.enrolmentId, sequence: 1, attempt: 0, result: { ok: true, status: 200 } },
      { context: { ...other.context, correlationId: randomUUID() }, permissions: 'all' },
    ),
  ).toBe('stale');
});

it('sends nothing for a delivery whose automation was deleted while it was out', async () => {
  const s = await scene();
  expect(await s.step()).toBe('ran');
  expect(await s.job()).toBeDefined();
  const [run] = await database.withTenant(s.context, (client) =>
    client.query<{ automation_id: string }>(
      'select automation_id from automation.enrolments where id = $1',
      [s.enrolmentId],
    ),
  );
  await runCommand(
    services,
    createDeletionCommands().remove,
    { id: toPublicId('automation', run?.automation_id ?? '') },
    { context: s.context, permissions: 'all' },
  );
  // The delivery job, still in the queue, finds its run cancelled and calls nobody.
  await s.deliver(ok());
  expect(s.sent).toEqual([]);
  expect(await s.enrolment()).toMatchObject({
    status: 'cancelled',
    exit_reason: 'automation_deleted',
    current_step: null,
    wake_at: null,
  });
  expect(await s.stepRuns()).toMatchObject([{ step_key: 'tell', status: 'skipped' }]);
  // Nor does the step's own check on the delivery, when it comes due.
  expect(await s.step(new Date(Date.now() + WEBHOOK_RECOVERY_MS + 1000))).toBe('skipped');
  expect(await s.stepRuns()).toHaveLength(1);
});
