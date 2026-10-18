// email.verify end to end: the step arms and waits, a check job asks email verification to
// check the contact's primary address with no transaction open and records what it found
// under the enrolment's lock, and the step runs again to take it. An excluded address, a
// contact without one, and verification turned off go on at once; a check that has to wait
// is asked again, then given up on. An If / else reads what was found. Real Postgres and
// the real commands; the provider and DNS are stand-ins, so nothing leaves the machine.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import type { VerificationTaskOptions } from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it, vi } from 'vitest';

import { matchEvent, publishAutomationVersion } from './enrolment.js';
import {
  createCheckEmailTask,
  EMAIL_CHECK_MAX_ATTEMPTS,
  EMAIL_CHECK_RECOVERY_MS,
  recordEmailCheckCommand,
} from './email-verify-task.js';
import { createRunStepCommand } from './runner.js';
import { readAutomationSetup } from './setup.js';
import { contactValues } from './values.js';

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

type MailboxOutcome = Awaited<
  ReturnType<NonNullable<VerificationTaskOptions['provider']>['verify']>
>;

// DNS as a stand-in: example.com takes mail; nothing else exists.
const resolve: NonNullable<VerificationTaskOptions['resolve']> = (name, type) =>
  name.toLowerCase().replace(/\.$/, '') === 'example.com' && type === 'MX'
    ? Promise.resolve([{ exchange: 'mail.example.com', priority: 10 }])
    : Promise.reject(Object.assign(new Error(`queryMx ENOTFOUND ${name}`), { code: 'ENOTFOUND' }));
const answer = (status: 'valid' | 'risky' | 'invalid'): MailboxOutcome => ({
  kind: 'result',
  status,
  reasons: [],
  raw: { state: status, reason: null },
  charged: true,
});

interface Enrolment {
  status: string;
  current_step: string | null;
  wake_at: Date | null;
  state: { sequence: number; emailCheck?: { attempt: number; result?: unknown } };
}

/** A business with one contact enrolled in an automation that checks its email, then waits. */
async function scene(options: { email?: string | null; maxAgeDays?: number } = {}) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const system: TenantContext = { ...context, actorKind: 'system' };
  await database.withTenant(context, (client) =>
    client.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled) values (app.business_id(),false)',
    ),
  );
  const document: AutomationDocumentInput = {
    name: 'Check new leads',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'check',
    steps: {
      check: {
        type: 'email.verify',
        config: options.maxAgeDays === undefined ? {} : { maxAgeDays: options.maxAgeDays },
        next: 'pause',
      },
      pause: { type: 'wait', config: { duration: 'P1D' } },
    },
  };
  const email = options.email === undefined ? `${randomUUID()}@example.com` : options.email;
  const { id: publicContactId } = await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: email === null ? [] : [email] },
    { context, permissions: 'all' },
  );
  const { enrolmentId, contactId } = await withTenant(db, context, async (trx) => {
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
    const contact = await trx.selectFrom('crm.contacts').select('id').executeTakeFirstOrThrow();
    return { enrolmentId: first.enrolmentId, contactId: contact.id };
  });
  const verify = vi.fn((): Promise<MailboxOutcome> => Promise.resolve(answer('valid')));
  const provider = {
    name: 'emailable',
    verify,
    account: () => Promise.resolve({ kind: 'ok' as const, availableCredits: 10, testMode: true }),
  };
  const enrolment = async (): Promise<Enrolment> => {
    const [row] = await database.withTenant(context, (client) =>
      client.query<Enrolment>(
        'select status, current_step, wake_at, state from automation.enrolments where id = $1',
        [enrolmentId],
      ),
    );
    if (row === undefined) throw new Error('The enrolment exists.');
    return row;
  };
  const task = createCheckEmailTask({ resolve, provider });
  return {
    context,
    system,
    email,
    publicContactId,
    contactId,
    enrolmentId,
    verify,
    enrolment,
    step: async (now?: Date) =>
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
    check: async (data: { attempt?: number; sequence?: number } = {}) => {
      const current = await enrolment();
      await task.run(
        {
          enrolmentId,
          sequence: data.sequence ?? current.state.sequence,
          attempt: data.attempt ?? current.state.emailCheck?.attempt ?? 0,
        },
        { invocation: { context: system, permissions: 'all' }, services },
      );
    },
    job: async () => {
      const [row] = await database.as('postgres', (client) =>
        client.query<{ data: unknown; run_at: Date; queue_name: string | null }>(
          `select payload -> 'data' as data, run_at,
             (select queue_name from graphile_worker._private_job_queues q where q.id = j.job_queue_id) as queue_name
           from graphile_worker._private_jobs j where key = $1`,
          [`automation-email-check:${enrolmentId}`],
        ),
      );
      return row;
    },
    stepRuns: () =>
      database.withTenant(context, (client) =>
        client.query<{ step_key: string; status: string; output: unknown; explanation: string }>(
          `select step_key, status, output, explanation from automation.step_runs
           where enrolment_id = $1 order by started_at, id`,
          [enrolmentId],
        ),
      ),
  };
}

it('arms, checks the primary address once outside the step, and goes on with the result', async () => {
  const s = await scene();
  expect(await s.step()).toBe('ran');
  // The step waits where it is; nothing was checked inside its transaction.
  expect(s.verify).not.toHaveBeenCalled();
  expect(await s.enrolment()).toMatchObject({
    status: 'waiting',
    current_step: 'check',
    state: { sequence: 1, emailCheck: { attempt: 0 } },
  });
  const job = await s.job();
  expect(job?.data).toEqual({ enrolmentId: s.enrolmentId, sequence: 1, attempt: 0 });
  // In the run's own queue, so it never overlaps a step of the same run.
  expect(job?.queue_name).toBe(`automation-enrolment:${s.enrolmentId}`);

  await s.check();
  expect(s.verify).toHaveBeenCalledTimes(1);
  expect((await s.enrolment()).state.emailCheck?.result).toEqual({
    kind: 'checked',
    reused: false,
    status: 'valid',
    depth: 'mailbox',
  });
  // The same job again is stale: it checks nothing and records nothing.
  await s.check({ attempt: 0 });
  expect(s.verify).toHaveBeenCalledTimes(1);

  expect(await s.step()).toBe('ran');
  expect(await s.enrolment()).toMatchObject({ status: 'running', current_step: 'pause' });
  expect(await s.stepRuns()).toMatchObject([
    { step_key: 'check', status: 'succeeded' },
    {
      step_key: 'check',
      status: 'succeeded',
      output: { status: 'valid', depth: 'mailbox' },
      explanation: 'The address was checked: valid (the mailbox).',
    },
  ]);
  // An If / else after it reads what was found.
  const values = await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId));
  expect(values).toMatchObject({
    'contact.emailVerification': 'valid',
    'contact.emailVerified': true,
  });
});

it('holds no lock on the enrolment, the business or the address while the provider answers', async () => {
  const s = await scene();
  await s.step();
  s.verify.mockImplementationOnce(async () => {
    await withTenant(db, s.context, async (trx) => {
      await sql`select id from automation.enrolments where id = ${s.enrolmentId}::uuid for update nowait`.execute(
        trx,
      );
      await sql`select id from tenancy.businesses where id = ${s.context.businessId}::uuid for update nowait`.execute(
        trx,
      );
      await sql`select id from messaging.email_verifications for update nowait`.execute(trx);
    });
    return answer('risky');
  });
  await s.check();
  expect((await s.enrolment()).state.emailCheck?.result).toMatchObject({ status: 'risky' });
});

it('uses a result recent enough, at no cost', async () => {
  const s = await scene({ maxAgeDays: 30 });
  await database.withTenant(s.context, (client) =>
    client.query(
      "insert into messaging.email_verifications (business_id,address_normalized,status,depth,checked_at) values (app.business_id(),$1,'invalid','mailbox',now()-interval '3 days')",
      [s.email],
    ),
  );
  await s.step();
  await s.check();
  await s.step();
  expect(s.verify).not.toHaveBeenCalled();
  expect((await s.stepRuns()).at(-1)).toMatchObject({
    output: { status: 'invalid', depth: 'mailbox' },
    explanation: 'The address was checked in the last 30 days, so that result was used: invalid.',
  });
  const values = await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId));
  expect(values).toMatchObject({
    'contact.emailVerification': 'invalid',
    'contact.emailVerified': false,
  });
});

it('goes on at once, checking nothing, for an excluded address or a contact without one', async () => {
  const excluded = await scene();
  await database.withTenant(excluded.context, (client) =>
    client.query(
      'insert into messaging.email_verifications (business_id,address_normalized,excluded) values (app.business_id(),$1,true)',
      [excluded.email],
    ),
  );
  await excluded.step();
  expect(await excluded.enrolment()).toMatchObject({ status: 'running', current_step: 'pause' });
  expect(await excluded.job()).toBeUndefined();
  expect(await excluded.stepRuns()).toMatchObject([
    {
      status: 'succeeded',
      output: { status: 'excluded' },
      explanation: 'The address is excluded from email verification, so it was not checked.',
    },
  ]);
  expect(
    await withTenant(db, excluded.context, (trx) => contactValues(trx, excluded.contactId)),
  ).toMatchObject({ 'contact.emailVerification': 'excluded', 'contact.emailVerified': false });

  const none = await scene({ email: null });
  await none.step();
  expect(await none.enrolment()).toMatchObject({ status: 'running', current_step: 'pause' });
  expect(await none.stepRuns()).toMatchObject([
    { output: {}, explanation: 'The contact has no email address, so nothing was checked.' },
  ]);
  expect(
    await withTenant(db, none.context, (trx) => contactValues(trx, none.contactId)),
  ).toMatchObject({ 'contact.emailVerification': null, 'contact.emailVerified': null });
});

it('goes on without a check while verification is off, and the setup says it is off', async () => {
  const s = await scene();
  await database.withTenant(s.context, (client) =>
    client.query('update messaging.settings set email_verification_enabled=false'),
  );
  const setup = await withTenant(db, s.context, (trx) =>
    readAutomationSetup(trx, s.context, () => Promise.resolve([]), {
      smsDelivery: false,
      webhookDelivery: false,
    }),
  );
  expect(setup.emailVerification).toBe(false);
  await s.step();
  expect(await s.stepRuns()).toMatchObject([
    {
      output: { status: 'unchecked' },
      explanation: 'Email verification is off, so the address was not checked.',
    },
  ]);
  expect(s.verify).not.toHaveBeenCalled();
});

it('takes verification turned off after the step armed as off', async () => {
  const s = await scene();
  await s.step();
  await database.withTenant(s.context, (client) =>
    client.query('update messaging.settings set email_verification_enabled=false'),
  );
  await s.check();
  await s.step();
  expect(s.verify).not.toHaveBeenCalled();
  expect((await s.stepRuns()).at(-1)).toMatchObject({
    explanation: 'Email verification is off, so the address was not checked.',
  });
});

it('asks again when the provider asks to wait, then gives up and goes on', async () => {
  const s = await scene();
  await s.step();
  s.verify.mockResolvedValue({
    kind: 'failed',
    problem: 'rate_limited',
    connectionFailing: false,
    retryAfterMs: 20_000,
  });
  const before = Date.now();
  await s.check();
  const waiting = await s.enrolment();
  expect(waiting).toMatchObject({ status: 'waiting', state: { emailCheck: { attempt: 1 } } });
  expect(waiting.state.emailCheck?.result).toBeUndefined();
  const retry = await s.job();
  expect(retry?.data).toEqual({ enrolmentId: s.enrolmentId, sequence: 1, attempt: 1 });
  expect(retry?.run_at.getTime()).toBeGreaterThanOrEqual(before + 15_000);
  expect(waiting.wake_at?.getTime()).toBeGreaterThanOrEqual(before + EMAIL_CHECK_RECOVERY_MS);
  // A stale job of the first attempt records nothing.
  expect(
    await runCommand(
      services,
      recordEmailCheckCommand,
      {
        enrolmentId: s.enrolmentId,
        sequence: 1,
        attempt: 0,
        result: { kind: 'excluded' },
      },
      { context: s.system, permissions: 'all' },
    ),
  ).toBe('stale');
  // Each later attempt still has to wait: the provider's early retry is not due yet.
  for (let attempt = 1; attempt < EMAIL_CHECK_MAX_ATTEMPTS; attempt++) await s.check();
  expect(s.verify).toHaveBeenCalledTimes(1);
  expect((await s.enrolment()).state.emailCheck?.result).toEqual({ kind: 'gave_up' });
  await s.step();
  expect((await s.stepRuns()).at(-1)).toMatchObject({
    output: { status: 'unchecked' },
    explanation:
      'The check could not be made in time, so the run went on with the result there was.',
  });
});

it('queues the check again when woken with nothing recorded', async () => {
  const s = await scene();
  await s.step();
  await database.as('postgres', (client) =>
    client.query('delete from graphile_worker._private_jobs where key = $1', [
      `automation-email-check:${s.enrolmentId}`,
    ]),
  );
  await s.step(new Date(Date.now() + EMAIL_CHECK_RECOVERY_MS + 1000));
  expect(await s.enrolment()).toMatchObject({ status: 'waiting', current_step: 'check' });
  expect((await s.job())?.data).toMatchObject({ attempt: 0 });
});

it('is refused to anyone but the engine', async () => {
  const s = await scene();
  await s.step();
  await expect(
    runCommand(
      services,
      recordEmailCheckCommand,
      { enrolmentId: s.enrolmentId, sequence: 1, attempt: 0, result: { kind: 'excluded' } },
      { context: { ...s.context, actorKind: 'user' }, permissions: 'all' },
    ),
  ).rejects.toThrow('Only the automation engine records email checks.');
});

it('goes on with nothing checked when the address is removed after the step armed', async () => {
  const s = await scene();
  await s.step();
  await database.as('crm_owner', (client) =>
    client.query("delete from crm.contact_identities where contact_id = $1 and kind = 'email'", [
      s.contactId,
    ]),
  );
  await s.check();
  expect(s.verify).not.toHaveBeenCalled();
  expect((await s.enrolment()).state.emailCheck?.result).toEqual({ kind: 'no_email' });
  await s.step();
  expect((await s.stepRuns()).at(-1)).toMatchObject({
    output: {},
    explanation: 'The contact has no email address, so nothing was checked.',
  });
});

it('checks nothing for a job of an earlier visit, or one that is no longer waiting', async () => {
  const s = await scene();
  await s.step();
  // A job of another visit to the step (a sequence that has passed) is stale.
  await s.check({ sequence: 0 });
  expect(s.verify).not.toHaveBeenCalled();
  expect((await s.enrolment()).state.emailCheck?.result).toBeUndefined();
  await database.as('crm_owner', (client) =>
    client.query("update automation.enrolments set status = 'running' where id = $1", [
      s.enrolmentId,
    ]),
  );
  await s.check();
  expect(s.verify).not.toHaveBeenCalled();
});
