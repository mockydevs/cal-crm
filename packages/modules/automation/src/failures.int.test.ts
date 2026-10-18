// Failure handling through real runs: what a step does when it fails, bounded retries of a
// failure that can pass, what a failed run gives the automation its ending starts, and
// running a failed run again by hand. Real Postgres, the CRM's and messaging's own
// commands, and the engine's own step command.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { runStepCommand, startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { bulkWorkflows } from './bulk-enrol.js';
import { readRun } from './history.js';
import { retryRunCommand } from './run-retry.js';
import { runValues } from './run-values.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});
const created = { id: 'created', type: 'contact.created', config: {} } as const;
const pause = { type: 'wait', config: { duration: 'PT1M' } } as const;
const MINUTE = 60_000;

const rows = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      step_key: string;
      status: string;
      resumes: boolean;
      branch: string | null;
      explanation: string;
      error: { code: string } | null;
    }>(
      `select step_key, status, resumes, branch, explanation, error from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

/** Puts a contact in the trash, or takes it out, as the CRM's trash does. */
const trash = (contactId: string, trashed: boolean) =>
  h.database.as('postgres', (sql) =>
    sql.query(`update crm.contacts set deleted_at = $2 where id = $1`, [
      contactId,
      trashed ? new Date() : null,
    ]),
  );

const firstNameOf = async (contactId: string) => {
  const [row] = await h.database.as('postgres', (sql) =>
    sql.query<{ value_text: string }>(
      `select v.value_text from crm.field_values v
       join crm.field_definitions d on d.id = v.field_id
       where v.record_id = $1 and d.key = 'nickname'`,
      [contactId],
    ),
  );
  return row?.value_text;
};

/** The business's nickname field, which the rename step writes, made once. */
const nicknameField = (contactId: string) =>
  h.database.as('postgres', (sql) =>
    sql.query(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select c.business_id, t.id, 'nickname', 'Nickname', 'test', 'text', 'system'
       from crm.contacts c join crm.object_types t on t.business_id = c.business_id and t.kind = 'contact'
       where c.id = $1 and not exists (
         select 1 from crm.field_definitions d where d.business_id = c.business_id and d.key = 'nickname')`,
      [contactId],
    ),
  );

/**
 * Archives the nickname field, or restores it: the CRM refuses a value for an archived
 * field as a conflict, a failure that can pass. (A contact in the trash no longer fails a
 * step: its run ends.)
 */
const block = async (contactId: string, blocked: boolean) => {
  await nicknameField(contactId);
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update crm.field_definitions set archived_at = $2
       where key = 'nickname' and business_id = (select business_id from crm.contacts where id = $1)`,
      [contactId, blocked ? new Date() : null],
    ),
  );
};

/** Gives the contact a nickname, which the CRM refuses (a conflict) while the field is archived. */
const renaming = (
  more: Record<string, unknown> = {},
  settings: AutomationDocumentInput['settings'] = {},
): AutomationDocumentInput => ({
  name: 'Rename',
  triggers: [created],
  settings,
  start: 'rename',
  steps: {
    rename: {
      type: 'contact.update',
      config: { fields: { 'contact.custom.nickname': 'Renamed' } },
      next: 'after',
      ...more,
    } as never,
    after: pause,
    rescue: pause,
  },
});

async function started(tenant: Tenant, document: AutomationDocumentInput) {
  const published = await h.publish(tenant, document);
  const made = await h.enrol(tenant);
  await nicknameField(made.contactId);
  return { ...made, ...published, run: made.enrolments[0] ?? '' };
}

const refusal =
  'The contact.update step was refused: Restore this field before changing its value.';

it('ends the run where a step fails, as before, and says which step in the event', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(tenant, renaming());
  await block(contactId, true);
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'failed', exit_reason: 'conflict' });
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'rename',
      status: 'failed',
      resumes: false,
      branch: null,
      explanation: refusal,
      error: { code: 'conflict' },
    },
  ]);
  expect(await h.events(tenant, 'automation.run.failed')).toMatchObject([
    { subject_id: run, payload: { reason: 'conflict', step: 'rename' } },
  ]);
});

it('goes on to the next step when a step set to continue fails', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(tenant, renaming({ onFailure: 'continue' }));
  await block(contactId, true);
  expect(await h.step(tenant, run)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'running',
    current_step: 'after',
    exit_reason: null,
  });
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'rename',
      status: 'failed',
      resumes: false,
      branch: null,
      explanation: `${refusal} This step is set to go on when it fails, so the run went on to "after".`,
      error: { code: 'conflict' },
    },
  ]);
  // The run did not fail: nothing says it did, and it ends as completed.
  expect(await h.events(tenant, 'automation.run.failed')).toEqual([]);
  await h.step(tenant, run);
  await h.step(tenant, run, new Date(Date.now() + 2 * MINUTE));
  expect(await h.run(tenant, run)).toMatchObject({ status: 'completed' });
});

it('ends the run as completed when a step set to continue fails and has no next', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(tenant, {
    name: 'Last step',
    triggers: [created],
    start: 'rename',
    steps: {
      rename: {
        type: 'contact.update',
        config: { fields: { 'contact.custom.nickname': 'Renamed' } },
        onFailure: 'continue',
      },
    },
  });
  await block(contactId, true);
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'completed', exit_reason: null });
  expect((await rows(tenant, run))[0]?.explanation).toBe(
    `${refusal} This step is set to go on when it fails, and nothing comes after it, so the run ended here.`,
  );
});

it('goes down the failed path when a step names one', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(tenant, renaming({ onFailure: { goTo: 'rescue' } }));
  await block(contactId, true);
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'rescue' });
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'rename',
      status: 'failed',
      resumes: false,
      branch: 'failed',
      explanation: `${refusal} This step is set to go to "rescue" when it fails, so the run went on there.`,
      error: { code: 'conflict' },
    },
  ]);
  const read = await withTenant(h.db, tenant, (trx) =>
    readRun(trx, toPublicId('automation_enrolment', run)),
  );
  expect(read).toMatchObject({ status: 'running' });
  expect(read.steps[0]).toMatchObject({ status: 'failed', branch: 'failed' });
});

it('tries a step again after a conflict, with a doubling wait, and does its work once', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(tenant, renaming({ retry: { times: 3, wait: 'PT1M' } }));
  await block(contactId, true);
  const t0 = new Date('2027-03-01T10:00:00Z');
  expect(await h.step(tenant, run, t0)).toBe('ran');
  const first = new Date(t0.getTime() + MINUTE);
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'waiting',
    current_step: 'rename',
    wake_at: first,
  });
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'rename',
      status: 'waiting',
      resumes: false,
      branch: null,
      explanation: `Try 1 failed (conflict): ${refusal} It will be tried again at ${first.toISOString()} (retry 1 of 3).`,
      error: null,
    },
  ]);
  // A job that comes before the wait is over does nothing.
  expect(await h.step(tenant, run, new Date(first.getTime() - 1000))).toBe('skipped');
  // Still in the trash at the first retry: the next wait is twice as long.
  expect(await h.step(tenant, run, first)).toBe('ran');
  const second = new Date(first.getTime() + 2 * MINUTE);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'waiting', wake_at: second });
  expect(await rows(tenant, run)).toMatchObject([
    {
      status: 'waiting',
      explanation: `Try 2 failed (conflict): ${refusal} It will be tried again at ${second.toISOString()} (retry 2 of 3).`,
    },
  ]);
  await block(contactId, false);
  expect(await h.step(tenant, run, second)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'after' });
  expect(await rows(tenant, run)).toMatchObject([
    { step_key: 'rename', status: 'succeeded', resumes: false },
    {
      step_key: 'rename',
      status: 'succeeded',
      resumes: true,
      explanation: 'The contact fields were updated. It took 3 tries.',
      error: null,
    },
  ]);
  expect(await firstNameOf(contactId)).toBe('Renamed');
  // One change, told of once.
  const updates = await h.database.withTenant(tenant, (sql) =>
    sql.query(
      `select 1 from crm.timeline_entries where event_type = 'field.value_set' and record_id = $1`,
      [contactId],
    ),
  );
  expect(updates).toHaveLength(1);
});

it.each([
  ['stop', undefined, { status: 'failed', exit_reason: 'conflict', current_step: null }, ''],
  [
    'continue',
    'continue',
    { status: 'running', current_step: 'after' },
    ' This step is set to go on when it fails, so the run went on to "after".',
  ],
  [
    'the failed path',
    { goTo: 'rescue' },
    { status: 'running', current_step: 'rescue' },
    ' This step is set to go to "rescue" when it fails, so the run went on there.',
  ],
])('follows %s once the tries are used up', async (_name, onFailure, ends, words) => {
  const tenant = await h.business();
  const { run, contactId } = await started(
    tenant,
    renaming({
      retry: { times: 1, wait: 'PT5M', backoff: 'fixed' },
      ...(onFailure === undefined ? {} : { onFailure }),
    }),
  );
  await block(contactId, true);
  const t0 = new Date('2027-03-01T10:00:00Z');
  await h.step(tenant, run, t0);
  const again = new Date(t0.getTime() + 5 * MINUTE);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'waiting', wake_at: again });
  await h.step(tenant, run, again);
  expect(await h.run(tenant, run)).toMatchObject(ends);
  expect(await rows(tenant, run)).toMatchObject([
    { step_key: 'rename', status: 'succeeded', resumes: false },
    {
      step_key: 'rename',
      status: 'failed',
      resumes: true,
      branch: typeof onFailure === 'object' ? 'failed' : null,
      explanation: `${refusal} It was tried 2 times.${words}`,
      error: { code: 'conflict' },
    },
  ]);
});

it('keeps a fixed wait the same at every retry', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(
    tenant,
    renaming({ retry: { times: 3, backoff: 'fixed' } }),
  );
  await block(contactId, true);
  const t0 = new Date('2027-03-01T10:00:00Z');
  await h.step(tenant, run, t0);
  await h.step(tenant, run, new Date(t0.getTime() + MINUTE));
  // One minute by default, and one minute again.
  expect(await h.run(tenant, run)).toMatchObject({
    wake_at: new Date(t0.getTime() + 2 * MINUTE),
  });
});

it('does not retry a failure that will not pass with time', async () => {
  const tenant = await h.business();
  const { run } = await started(tenant, {
    name: 'Unknown tag',
    triggers: [created],
    start: 'tag',
    steps: {
      tag: {
        type: 'tag.add',
        config: { tag: toPublicId('tag', await newId()) },
        retry: { times: 3 },
      },
    },
  });
  await h.step(tenant, run);
  const failed = await h.run(tenant, run);
  expect(failed.status).toBe('failed');
  expect(await rows(tenant, run)).toMatchObject([{ status: 'failed', resumes: false }]);
  expect((await rows(tenant, run))[0]?.explanation).not.toContain('tried');
});

it('lets a stop condition take a run out of a retry wait', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(tenant, {
    ...renaming({ retry: { times: 3 } }),
    stopWhen: [{ event: 'tag.added' }],
  });
  await block(contactId, true);
  await h.step(tenant, run);
  const eventId = await emitted(tenant, 'tag.assigned', contactId);
  expect(await h.match(tenant, eventId)).toMatchObject({ exited: 1 });
  expect(await h.run(tenant, run)).toMatchObject({ status: 'exited' });
  expect(await rows(tenant, run)).toMatchObject([{ step_key: 'rename', status: 'skipped' }]);
});

/** An id as the database makes them. */
async function newId(): Promise<string> {
  const [row] = await h.database.as('postgres', (sql) =>
    sql.query<{ id: string }>('select uuidv7() as id'),
  );
  return row?.id ?? '';
}

const happen = defineCommand({
  name: 'test.happened',
  permission: 'contacts.manage',
  input: z.strictObject({ type: z.string(), recordId: z.uuid() }),
  handle: (_trx, input, command) =>
    command.emit({
      type: input.type,
      subject: { kind: 'test', id: randomUUID() },
      records: [input.recordId],
      payload: {},
    }),
});

/** An event on the contact's timeline, written as a command's emit writes one. */
const emitted = (tenant: Tenant, type: string, contactId: string): Promise<string> =>
  runCommand(h.services, happen, { type, recordId: contactId }, all(tenant));

/** A business with a mailbox that can send, and the mailbox's ids. */
async function mailing() {
  const tenant = await h.business();
  const mailbox = await h.database.as('postgres', async (sql) => {
    await sql.query(
      `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
       on conflict (business_id) do update set quiet_hours_enabled = false`,
      [tenant.businessId],
    );
    const [secret] = await sql.query<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [tenant.agencyId, tenant.businessId],
    );
    const [account] = await sql.query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values ($1, 'email', 'Sales', 'active') returning id`,
      [tenant.businessId],
    );
    const address = `${randomUUID()}@example.test`;
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
         smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
         imap_username, secret_id, use_for_conversations)
       values ($1, $2, $3, 'password', 'mail.example.test', 587, 'starttls', $3,
         'mail.example.test', 993, 'tls', $3, $4, true)`,
      [tenant.businessId, account?.id, address, secret?.id],
    );
    return account?.id ?? '';
  });
  return { tenant, mailbox };
}

const mailboxStatus = (mailbox: string, status: 'active' | 'paused') =>
  h.database.as('postgres', (sql) =>
    sql.query('update messaging.channel_accounts set status = $2 where id = $1', [mailbox, status]),
  );

const consent = (tenant: Tenant, contactId: string) =>
  h.database.as('postgres', (sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'granted', 'user', 'user')`,
      [tenant.businessId, contactId],
    ),
  );

const messages = (tenant: Tenant) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ status: string; idempotency_key: string; error_code: string | null }>(
      `select status, idempotency_key, error_code from messaging.messages
       where direction = 'outbound' order by created_at, id`,
    ),
  );

const emailing = (
  mailbox: string,
  more: Record<string, unknown> = {},
): AutomationDocumentInput => ({
  name: 'Welcome',
  triggers: [created],
  start: 'send',
  steps: {
    send: {
      type: 'email.send',
      config: {
        subject: 'Welcome',
        body: 'Hi {{contact.firstName}}.',
        mailbox: toPublicId('mailbox', mailbox),
      },
      next: 'after',
      ...more,
    } as never,
    after: pause,
  },
});

it('retries an email whose mailbox is paused, and sends one message under one key', async () => {
  const { tenant, mailbox } = await mailing();
  const { run, contactId } = await started(tenant, emailing(mailbox, { retry: { times: 2 } }));
  await consent(tenant, contactId);
  await mailboxStatus(mailbox, 'paused');
  const t0 = new Date('2027-03-01T10:00:00Z');
  await h.step(tenant, run, t0);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'waiting', current_step: 'send' });
  expect((await rows(tenant, run))[0]?.explanation).toContain('Try 1 failed (mailbox_unavailable)');
  // Nothing was queued by the attempt that failed.
  expect(await messages(tenant)).toEqual([]);
  await mailboxStatus(mailbox, 'active');
  const { sequence: stale } = await h.run(tenant, run);
  await h.step(tenant, run, new Date(t0.getTime() + MINUTE));
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'after' });
  // The key is the first attempt's visit, whichever attempt queued the message.
  expect(await messages(tenant)).toMatchObject([{ idempotency_key: `automation:${run}:send:0` }]);
  // The same job delivered twice does nothing the second time.
  expect(
    await runCommand(
      h.services,
      runStepCommand,
      { enrolmentId: run, sequence: stale, now: new Date(t0.getTime() + MINUTE).toISOString() },
      all(tenant),
    ),
  ).toBe('skipped');
  expect(await messages(tenant)).toHaveLength(1);
});

it('gives the automation a failed run starts the reason, the step and the run', async () => {
  const tenant = await h.business();
  const failing = await h.publish(tenant, renaming());
  const notifier = await h.publish(tenant, {
    name: 'Tell the team',
    triggers: [
      {
        id: 'failed',
        type: 'automation.run_ended',
        config: { automations: [failing.id], how: ['failed'] },
      },
    ],
    start: 'which',
    steps: {
      which: {
        type: 'condition',
        config: {
          branches: [
            {
              name: 'renaming',
              if: {
                all: [
                  { field: 'trigger.reason', operator: 'equals', value: 'conflict' },
                  { field: 'trigger.step', operator: 'equals', value: 'rename' },
                ],
              },
            },
          ],
        },
        next: { renaming: 'told', none: 'other' },
      },
      told: pause,
      other: pause,
    },
  });
  const made = await h.contact(tenant);
  await block(made.contactId, true);
  await h.match(tenant, made.eventId);
  const [first] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where automation_id = $1', [
      failing.automationId,
    ]),
  );
  const run = first?.id ?? '';
  await h.step(tenant, run);
  const [failure] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(`select id from events.events where type = 'automation.run.failed'`),
  );
  expect(await h.match(tenant, failure?.id ?? '')).toMatchObject({ enrolled: 1 });
  const [told] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where automation_id = $1', [
      notifier.automationId,
    ]),
  );
  const values = await withTenant(h.db, tenant, (trx) =>
    runValues(trx, made.contactId, told?.id ?? ''),
  );
  expect(values).toMatchObject({
    'trigger.reason': 'conflict',
    'trigger.step': 'rename',
    'trigger.runId': toPublicId('automation_enrolment', run),
  });
  await h.step(tenant, told?.id ?? '');
  expect(await h.run(tenant, told?.id ?? '')).toMatchObject({ current_step: 'told' });
});

// --- Running a failed run again ---------------------------------------------------------

const retry = (tenant: Tenant, run: string) =>
  runCommand(
    h.services,
    retryRunCommand,
    { runId: toPublicId('automation_enrolment', run) },
    all(tenant),
  );

/** A run that failed at its rename step, whose contact is out of the trash again. */
async function failedRun(tenant: Tenant, document = renaming()) {
  const made = await started(tenant, document);
  await block(made.contactId, true);
  await h.step(tenant, made.run);
  await block(made.contactId, false);
  return made;
}

it('runs a failed run again from the step that failed, on its own version', async () => {
  const tenant = await h.business();
  const { run, contactId } = await failedRun(tenant, {
    ...renaming(),
    stopWhen: [{ event: 'tag.added' }],
  });
  const before = await h.run(tenant, run);
  expect(before).toMatchObject({ status: 'failed', exit_reason: 'conflict' });
  const again = await retry(tenant, run);
  expect(again).toMatchObject({ status: 'running', exitReason: null });
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'running',
    current_step: 'rename',
    exit_reason: null,
    wake_at: null,
    sequence: before.sequence + 1,
  });
  // It listens for its stop conditions again.
  const waits = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ kind: string; event_type: string }>(
      'select kind, event_type from automation.event_waits where enrolment_id = $1',
      [run],
    ),
  );
  expect(waits).toEqual([{ kind: 'stop', event_type: 'tag.assigned' }]);
  expect(await h.events(tenant, 'automation.run.retried')).toMatchObject([
    { subject_id: run, payload: { step: 'rename', retry: 1 } },
  ]);
  expect(await h.step(tenant, run)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'after' });
  expect(await firstNameOf(contactId)).toBe('Renamed');
  // The failed visit stays in the history, before the one that succeeded.
  expect(await rows(tenant, run)).toMatchObject([
    { step_key: 'rename', status: 'failed', error: { code: 'conflict' } },
    { step_key: 'rename', status: 'succeeded' },
  ]);
  // The command is in the audit log, with the run it was for.
  const audits = await h.database.as('postgres', (sql) =>
    sql.query<{ outcome: string; input: Record<string, unknown> }>(
      `select outcome, input from audit.commands
       where command = 'automation.retry_run' and business_id = $1`,
      [tenant.businessId],
    ),
  );
  expect(audits).toEqual([
    { outcome: 'ok', input: { runId: toPublicId('automation_enrolment', run) } },
  ]);
  expect(await h.differences()).toEqual([]);
});

it('lets one of two retries at once through, and refuses the other', async () => {
  const tenant = await h.business();
  const { run } = await failedRun(tenant);
  const both = await Promise.allSettled([retry(tenant, run), retry(tenant, run)]);
  expect(both.map((each) => each.status).sort()).toEqual(['fulfilled', 'rejected']);
  const refused = both.find((each) => each.status === 'rejected');
  expect(refused).toMatchObject({
    reason: {
      name: 'ConflictError',
      message: 'Only a run that failed can be run again; this one is running.',
    },
  });
  expect(await h.events(tenant, 'automation.run.retried')).toHaveLength(1);
  expect((await h.run(tenant, run)).sequence).toBe(2);
});

it('refuses a run that did not fail', async () => {
  const tenant = await h.business();
  const { run } = await started(tenant, renaming());
  await expect(retry(tenant, run)).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'Only a run that failed can be run again; this one is running.',
  });
});

it('refuses when the automation was deleted', async () => {
  const tenant = await h.business();
  const { run, automationId } = await failedRun(tenant);
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update automation.automations set status = 'archived', archived_at = now() where id = $1`,
      [automationId],
    ),
  );
  await expect(retry(tenant, run)).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'The automation was deleted, so its runs cannot be run again.',
  });
  expect(await h.run(tenant, run)).toMatchObject({ status: 'failed' });
});

it('refuses when the automation has been published again since the run began', async () => {
  const tenant = await h.business();
  const { run, automationId } = await failedRun(tenant);
  await h.publish(tenant, renaming({ label: 'Rename, version two' }), automationId);
  await expect(retry(tenant, run)).rejects.toMatchObject({
    name: 'ConflictError',
    message:
      'The automation has been published again since this run began, so the run cannot go on from its failed step. Enrol the contact again instead.',
  });
});

it('refuses when the contact is in the trash, or already back in the automation', async () => {
  const tenant = await h.business();
  const trashed = await failedRun(tenant);
  await trash(trashed.contactId, true);
  await expect(retry(tenant, trashed.run)).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'The contact is in the trash or gone, so the run cannot go on.',
  });

  const second = await h.business();
  const back = await failedRun(second, renaming({}, { reEnrollment: 'after_finished' }));
  // Added to the automation again by a person: a second, live run. (Its own event, matched
  // again, starts nothing: that run already read it.)
  expect(
    await withTenant(h.db, second, (trx) =>
      bulkWorkflows.enrol(trx, all(second), back.automationId, back.contactId),
    ),
  ).toBe('started');
  await expect(retry(second, back.run)).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'The contact is in this automation again already, and is in it once at a time.',
  });
  expect(await h.run(second, back.run)).toMatchObject({ status: 'failed' });
});

it('refuses a run that failed on its loop bound, and one retried five times', async () => {
  const tenant = await h.business();
  const looped = await failedRun(tenant);
  await h.database.as('postgres', (sql) =>
    sql.query(`update automation.enrolments set exit_reason = 'step_visit_limit' where id = $1`, [
      looped.run,
    ]),
  );
  await expect(retry(tenant, looped.run)).rejects.toMatchObject({
    name: 'ConflictError',
    message:
      'This run was ended because a path of the workflow leads back on itself; running it again would end the same way.',
  });

  const worn = await failedRun(tenant);
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update automation.enrolments set state = state || '{"retried": 5}'::jsonb where id = $1`,
      [worn.run],
    ),
  );
  await expect(retry(tenant, worn.run)).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'This run has been run again 5 times, the most a run may be.',
  });
});

it('finds no run of another business, and none for an id that is not one', async () => {
  const tenant = await h.business();
  const other = await h.business();
  const { run } = await failedRun(tenant);
  await expect(retry(other, run)).rejects.toMatchObject({ name: 'NotFoundError' });
  await expect(
    runCommand(h.services, retryRunCommand, { runId: 'not-a-run' }, all(tenant)),
  ).rejects.toMatchObject({ name: 'NotFoundError' });
  expect(await h.run(tenant, run)).toMatchObject({ status: 'failed' });
});

it('needs the permission to manage automations', async () => {
  const tenant = await h.business();
  const { run } = await failedRun(tenant);
  const denied = {
    services: { ...h.services, authorize: () => Promise.resolve(false) },
  };
  await expect(
    runCommand(
      denied.services,
      retryRunCommand,
      { runId: toPublicId('automation_enrolment', run) },
      {
        context: {
          ...tenant,
          actorKind: 'user',
          actorId: randomUUID(),
          correlationId: randomUUID(),
        },
        permissions: new Set(['contacts.manage']),
      },
    ),
  ).rejects.toMatchObject({ name: 'ForbiddenError' });
  expect(await h.run(tenant, run)).toMatchObject({ status: 'failed' });
});

it('sends once when a run that failed on a refused email is run again', async () => {
  const { tenant, mailbox } = await mailing();
  const { run, contactId } = await started(tenant, emailing(mailbox));
  // No consent: messaging refuses the email and keeps the refusal on the message.
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'failed' });
  const [refused] = await messages(tenant);
  expect(refused).toMatchObject({ status: 'failed', idempotency_key: `automation:${run}:send:0` });
  await consent(tenant, contactId);
  await retry(tenant, run);
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'after' });
  const sent = await messages(tenant);
  expect(sent).toHaveLength(2);
  // The refused one was never handed over; the new visit queued one message under its own key.
  expect(sent.filter((each) => each.status !== 'failed')).toMatchObject([
    { idempotency_key: `automation:${run}:send:2` },
  ]);
});
