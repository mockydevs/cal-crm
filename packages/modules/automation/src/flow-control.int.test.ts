// Flow control through real runs: a condition with several branches, a loop through a Go To
// and the bound a run keeps, and a stop that applies only to a reply to the run's own
// messages. Real Postgres, real sends through the email step, and the engine's own
// commands.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import {
  LOOP_MIN_WAIT_MS,
  MAX_RUN_STEPS,
  MAX_STEP_VISITS,
  type AutomationDocumentInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { readRun } from './history.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const created = { id: 'created', type: 'contact.created', config: {} } as const;
const pause = { type: 'wait', config: { duration: 'PT1M' } } as const;
const named = (name: string) => ({
  field: 'contact.firstName',
  operator: 'equals' as const,
  value: name,
});

const rows = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      step_key: string;
      status: string;
      branch: string | null;
      explanation: string;
      error: { code: string } | null;
    }>(
      `select step_key, status, branch, explanation, error from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

const routing: AutomationDocumentInput = {
  name: 'Route by name',
  triggers: [created],
  start: 'who',
  steps: {
    who: {
      type: 'condition',
      config: {
        branches: [
          { name: 'ada', if: named('Ada') },
          { name: 'grace', if: { any: [named('Grace'), named('Hopper')] } },
          // Holds for everyone with a name, so it is reached only when the first two fail.
          { name: 'anyone', if: { field: 'contact.firstName', operator: 'is_set' } },
        ],
      },
      next: { ada: 'for_ada', grace: 'for_grace', anyone: 'for_anyone', none: 'for_none' },
    },
    for_ada: pause,
    for_grace: pause,
    for_anyone: pause,
    for_none: pause,
  },
};

it.each([
  ['Ada', 'ada', 'for_ada', 'Branch "ada" held (number 1 of 3, tried in order), so it was taken.'],
  [
    'Grace',
    'grace',
    'for_grace',
    'Branch "grace" held (number 2 of 3, tried in order), so it was taken.',
  ],
  [
    'Linus',
    'anyone',
    'for_anyone',
    'Branch "anyone" held (number 3 of 3, tried in order), so it was taken.',
  ],
])('takes the first branch that holds for %s', async (firstName, branch, next, explanation) => {
  const tenant = await h.business();
  await h.publish(tenant, routing);
  const made = await h.enrol(tenant, firstName);
  const [run = ''] = made.enrolments;
  expect(await h.step(tenant, run)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: next });
  expect(await rows(tenant, run)).toEqual([
    { step_key: 'who', status: 'succeeded', branch, explanation, error: null },
  ]);
  // The history keeps what every branch compared, as it was then.
  const read = await withTenant(h.db, tenant, (trx) =>
    readRun(trx, toPublicId('automation_enrolment', run)),
  );
  expect(read.steps[0]).toMatchObject({
    type: 'condition',
    branch,
    input: { values: { 'contact.firstName': firstName } },
  });
});

it('takes none when no branch holds, and ends the path when none leads nowhere', async () => {
  const tenant = await h.business();
  await h.publish(tenant, {
    ...routing,
    steps: {
      who: {
        type: 'condition',
        config: {
          branches: [
            { name: 'ada', if: named('Ada') },
            { name: 'grace', if: named('Grace') },
          ],
        },
        next: { ada: 'for_ada', grace: 'for_ada' },
      },
      for_ada: pause,
    },
  });
  const made = await h.enrol(tenant, 'Linus');
  const [run = ''] = made.enrolments;
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'completed', current_step: null });
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'who',
      status: 'succeeded',
      branch: 'none',
      explanation: 'None of the 2 branches held, so the none branch was taken.',
      error: null,
    },
  ]);
});

it('runs a two-way condition published before named branches existed, as it did', async () => {
  const tenant = await h.business();
  await h.publish(tenant, {
    name: 'Two-way',
    triggers: [created],
    start: 'check',
    steps: {
      // As a version stored at step version 1 holds it.
      check: {
        type: 'condition',
        typeVersion: 1,
        config: { if: named('Ada') },
        next: { yes: 'for_yes', no: 'for_no' },
      },
      for_yes: pause,
      for_no: pause,
    },
  });
  const ada = await h.enrol(tenant, 'Ada');
  const grace = await h.enrol(tenant, 'Grace');
  await h.step(tenant, ada.enrolments[0] ?? '');
  await h.step(tenant, grace.enrolments[0] ?? '');
  expect(await h.run(tenant, ada.enrolments[0] ?? '')).toMatchObject({ current_step: 'for_yes' });
  expect(await h.run(tenant, grace.enrolments[0] ?? '')).toMatchObject({ current_step: 'for_no' });
  expect(await rows(tenant, grace.enrolments[0] ?? '')).toEqual([
    {
      step_key: 'check',
      status: 'succeeded',
      branch: 'no',
      explanation: 'The condition was false, so the no branch was taken.',
      error: null,
    },
  ]);
});

const looping: AutomationDocumentInput = {
  name: 'Nudge for ever',
  triggers: [created],
  start: 'tick',
  steps: {
    tick: { type: 'wait', config: { duration: 'PT1S' }, next: 'again' },
    again: { type: 'goto', config: { target: 'tick' } },
  },
};

it('follows a Go To back, and fails the run at the hundred-and-first visit to a step', async () => {
  const tenant = await h.business();
  await h.publish(tenant, looping);
  const made = await h.enrol(tenant);
  const [run = ''] = made.enrolments;
  const began = Date.now();
  // Each turn: the wait begins, then, two seconds on, the Go To leads back to it. A loop
  // goes round once an hour at most, so each turn is an hour and a minute on.
  const turnMs = LOOP_MIN_WAIT_MS + 60_000;
  let turn = 0;
  for (; turn < MAX_STEP_VISITS; turn += 1) {
    expect(await h.step(tenant, run, new Date(began + turn * turnMs))).toBe('ran');
    expect(await h.step(tenant, run, new Date(began + turn * turnMs + 2000))).toBe('ran');
  }
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'running',
    current_step: 'tick',
    sequence: 2 * MAX_STEP_VISITS,
  });
  const before = await rows(tenant, run);
  expect(before.filter((row) => row.step_key === 'tick')).toHaveLength(MAX_STEP_VISITS);
  expect(before[1]).toEqual({
    step_key: 'again',
    status: 'succeeded',
    branch: null,
    explanation: 'Went to "tick".',
    error: null,
  });

  // The next visit to the wait would be its 101st.
  expect(await h.step(tenant, run, new Date(began + turn * turnMs))).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'failed',
    current_step: null,
    exit_reason: 'step_visit_limit',
  });
  expect((await rows(tenant, run)).at(-1)).toEqual({
    step_key: 'tick',
    status: 'failed',
    branch: null,
    explanation:
      'This step had already run 100 times in this run, the most a run may visit one step, so the run was ended here. A Go To, or a next, leads back to it.',
    error: { code: 'step_visit_limit' },
  });
  expect(await h.events(tenant, 'automation.run.%')).toMatchObject([
    {
      type: 'automation.run.failed',
      subject_id: run,
      payload: { reason: 'step_visit_limit' },
    },
  ]);
  // Nothing of it is queued or runs afterwards, and the counters still add up.
  expect(await h.step(tenant, run, new Date(began + turn * turnMs + 9000))).toBe('skipped');
  expect(await h.differences()).toEqual([]);
}, 120_000);

it('fails a run that has taken as many steps as a run may take', async () => {
  const tenant = await h.business();
  await h.publish(tenant, looping);
  const made = await h.enrol(tenant);
  const [run = ''] = made.enrolments;
  await h.step(tenant, run);
  // A run one step short of the bound, then at it.
  const setSequence = (sequence: number) =>
    h.database.as('postgres', (sql) =>
      sql.query(
        `update automation.enrolments
         set state = jsonb_set(state, '{sequence}', to_jsonb($2::int)) where id = $1`,
        [run, sequence],
      ),
    );
  await setSequence(MAX_RUN_STEPS - 1);
  expect(await h.step(tenant, run, new Date(Date.now() + 5000))).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', sequence: MAX_RUN_STEPS });
  expect(await h.step(tenant, run, new Date(Date.now() + 5000))).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'failed',
    exit_reason: 'run_step_limit',
  });
  expect((await rows(tenant, run)).at(-1)).toEqual({
    step_key: 'tick',
    status: 'failed',
    branch: null,
    explanation:
      'This run had taken 5000 steps, the most a run may take, so it was ended here. A path of the workflow leads back on itself.',
    error: { code: 'run_step_limit' },
  });
});

// --- A stop on a reply to the run's own messages -------------------------------------

const sends = (
  name: string,
  stopWhen: AutomationDocumentInput['stopWhen'],
): AutomationDocumentInput => ({
  name,
  triggers: [created],
  stopWhen,
  start: 'pause',
  steps: {
    pause: { type: 'wait', config: { duration: 'PT1S' }, next: 'send' },
    send: {
      type: 'email.send',
      config: { subject: `From ${name}`, body: 'Hi {{contact.firstName}}.' },
      next: 'after',
    },
    after: { type: 'wait', config: { duration: 'P2D' } },
  },
});
const narrow = [{ event: 'message.received', from: 'contact', repliedTo: 'this_run' }] as const;

const receive = defineCommand({
  name: 'test.message_received',
  permission: 'contacts.manage',
  input: z.strictObject({ recordId: z.uuid(), channel: z.enum(['email', 'sms']) }),
  async handle(_trx, input, command) {
    return command.emit({
      type: 'message.received',
      subject: { kind: 'test', id: randomUUID() },
      records: [input.recordId],
      payload: { channel: input.channel },
    });
  },
});

/** A business that can send email, with two sequences that each stop on a reply to itself. */
async function mailing(second: AutomationDocumentInput['stopWhen'] = [...narrow]) {
  const tenant = await h.business();
  await h.database.as('postgres', async (sql) => {
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
  });
  const dj = await h.publish(tenant, sends('DJ sales', [...narrow]));
  const photo = await h.publish(tenant, sends('Photo sales', second));
  return { tenant, dj, photo };
}

type Mailing = Awaited<ReturnType<typeof mailing>>;

/** A contact who may be emailed, in both sequences, neither of which has written yet. */
async function lead(s: Mailing, firstName = 'Ada') {
  const made = await h.enrol(s.tenant, firstName);
  await h.database.as('postgres', (sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'granted', 'user', 'user')`,
      [s.tenant.businessId, made.contactId],
    ),
  );
  const runs = await h.database.withTenant(s.tenant, (sql) =>
    sql.query<{ id: string; automation_id: string }>(
      'select id, automation_id from automation.enrolments where record_id = $1',
      [made.contactId],
    ),
  );
  const runOf = (automationId: string) =>
    runs.find((run) => run.automation_id === automationId)?.id ?? '';
  const dj = runOf(s.dj.automationId);
  const photo = runOf(s.photo.automationId);
  return {
    ...made,
    dj,
    photo,
    /** Runs the sequence up to and through its email: the message is queued now. */
    send: async (run: string) => {
      await h.step(s.tenant, run);
      await h.step(s.tenant, run, new Date(Date.now() + 5000));
      expect(await h.run(s.tenant, run)).toMatchObject({
        status: 'running',
        current_step: 'after',
      });
    },
  };
}

async function reply(s: Mailing, contactId: string, channel: 'email' | 'sms' = 'email') {
  const eventId = await runCommand(
    h.services,
    receive,
    { recordId: contactId, channel },
    { context: { ...s.tenant, correlationId: randomUUID() }, permissions: 'all' },
  );
  return h.match(s.tenant, eventId);
}

it('stops the run that wrote to the contact, and leaves the one that has not', async () => {
  const s = await mailing();
  const ada = await lead(s);
  // Nothing sent yet: a message from the contact is a reply to neither.
  expect(await reply(s, ada.contactId)).toMatchObject({ exited: 0 });
  expect(await h.run(s.tenant, ada.dj)).toMatchObject({ status: 'running' });

  await ada.send(ada.dj);
  expect(await reply(s, ada.contactId)).toMatchObject({ exited: 1 });
  expect(await h.run(s.tenant, ada.dj)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:message.received',
    current_step: null,
  });
  // Told of as every stop is, so a trigger on "stopped by a reply" still hears it.
  expect(await h.events(s.tenant, 'automation.run.stopped')).toMatchObject([
    { subject_id: ada.dj, payload: { reason: 'stop:message.received' } },
  ]);
  expect(await h.run(s.tenant, ada.photo)).toMatchObject({ status: 'running' });

  // Once the other has written too, the next reply stops it.
  await ada.send(ada.photo);
  expect(await reply(s, ada.contactId)).toMatchObject({ exited: 1 });
  expect(await h.run(s.tenant, ada.photo)).toMatchObject({ status: 'exited' });
});

it('stops every run that has written on the channel, not only the last to write', async () => {
  const s = await mailing();
  const ada = await lead(s);
  await ada.send(ada.dj);
  await ada.send(ada.photo);
  expect(await reply(s, ada.contactId)).toMatchObject({ exited: 2 });
});

it('does not count a reply on another channel, another contact’s message, or a failed one', async () => {
  const s = await mailing();
  const ada = await lead(s, 'Ada');
  const grace = await lead(s, 'Grace');
  await grace.send(grace.dj);
  // Grace was written to; Ada, who writes in, was not.
  expect(await reply(s, ada.contactId)).toMatchObject({ exited: 0 });

  await ada.send(ada.dj);
  // A text answers no email.
  expect(await reply(s, ada.contactId, 'sms')).toMatchObject({ exited: 0 });
  // The email never arrived: nobody replies to that.
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update messaging.messages set status = 'failed', failed_at = now(), error_code = 'smtp_refused'
       where idempotency_key = $1`,
      [`automation:${ada.dj}:send:1`],
    ),
  );
  expect(await reply(s, ada.contactId)).toMatchObject({ exited: 0 });
  expect(await h.run(s.tenant, ada.dj)).toMatchObject({ status: 'running' });
  // Grace's own reply stops her run as it should.
  expect(await reply(s, grace.contactId)).toMatchObject({ exited: 1 });
  expect(await h.run(s.tenant, grace.dj)).toMatchObject({ status: 'exited' });
});

it('leaves the stop without the choice as it was: any message from the contact stops it', async () => {
  const s = await mailing([{ event: 'message.received', from: 'contact' }]);
  const ada = await lead(s);
  // Neither has written: the wide stop ends its run, the narrow one does not.
  expect(await reply(s, ada.contactId)).toMatchObject({ exited: 1 });
  expect(await h.run(s.tenant, ada.photo)).toMatchObject({ status: 'exited' });
  expect(await h.run(s.tenant, ada.dj)).toMatchObject({ status: 'running' });
});

it('does not stop on a message that names no channel: it answers nothing', async () => {
  const s = await mailing();
  const ada = await lead(s);
  await ada.send(ada.dj);
  const unnamed = defineCommand({
    name: 'test.message_without_channel',
    permission: 'contacts.manage',
    input: z.strictObject({ recordId: z.uuid() }),
    async handle(_trx, input, command) {
      return command.emit({
        type: 'message.received',
        subject: { kind: 'test', id: randomUUID() },
        records: [input.recordId],
        payload: {},
      });
    },
  });
  const eventId = await runCommand(
    h.services,
    unnamed,
    { recordId: ada.contactId },
    { context: { ...s.tenant, correlationId: randomUUID() }, permissions: 'all' },
  );
  expect(await h.match(s.tenant, eventId)).toMatchObject({ exited: 0 });
  expect(await h.run(s.tenant, ada.dj)).toMatchObject({ status: 'running' });
});
