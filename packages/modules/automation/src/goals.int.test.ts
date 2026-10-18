// The goal step: when one of its events happens for the contact, the run comes straight to
// the step from wherever it is; a run that reaches the step first goes on anyway, waits
// there or ends. Real Postgres, real events, and the engine's own match and step commands.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { createContactCommand } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { runStepCommand, startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { readRun } from './history.js';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';

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
const booking = { type: 'form.submitted', config: { form: 'frm_booking' } } as const;
const vip = { type: 'tag.added', config: { tag: 'tag_vip' } } as const;

/** Two waits, then the goal step, then a last wait. */
const sequence = (
  otherwise: 'continue' | 'wait' | 'end',
  patch: Partial<AutomationDocumentInput> = {},
): AutomationDocumentInput => ({
  name: 'Sales sequence',
  triggers: [created],
  start: 'pause',
  steps: {
    pause: { type: 'wait', config: { duration: 'P2D' }, next: 'nudge' },
    nudge: { type: 'wait', config: { duration: 'P3D' }, next: 'booked' },
    booked: { type: 'goal', config: { events: [booking, vip], otherwise }, next: 'thanks' },
    thanks: { type: 'wait', config: { duration: 'PT1M' } },
  },
  ...patch,
});

// Something happening to a contact, as the module that owns it emits it.
const happen = defineCommand({
  name: 'test.happened',
  permission: 'contacts.manage',
  input: z.strictObject({
    type: z.string(),
    recordId: z.uuid(),
    payload: z.record(z.string(), z.unknown()),
  }),
  async handle(_trx, input, command) {
    return command.emit({
      type: input.type,
      subject: { kind: 'test', id: randomUUID() },
      records: [input.recordId],
      payload: input.payload,
    });
  },
});

/** The event happens for the contact and is matched as the worker matches it. */
async function event(
  tenant: Tenant,
  type: string,
  recordId: string,
  payload: Record<string, unknown> = {},
) {
  const eventId = await runCommand(h.services, happen, { type, recordId, payload }, all(tenant));
  return { eventId, matched: await h.match(tenant, eventId) };
}
const submits = (tenant: Tenant, recordId: string, formId = 'frm_booking') =>
  event(tenant, 'form.submitted', recordId, { formId });

const goalWaits = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ kind: string; event_type: string; conditions: unknown }>(
      `select kind, event_type, conditions from automation.event_waits
       where enrolment_id = $1 order by kind, event_type`,
      [enrolmentId],
    ),
  );

const rows = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      step_key: string;
      status: string;
      resumes: boolean;
      output: Record<string, unknown>;
      explanation: string;
    }>(
      `select step_key, status, resumes, output, explanation from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

const stateOf = async (tenant: Tenant, enrolmentId: string) => {
  const [row] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ state: Record<string, unknown> }>(
      'select state from automation.enrolments where id = $1',
      [enrolmentId],
    ),
  );
  return row?.state ?? {};
};

const stepAt = (tenant: Tenant, enrolmentId: string, at: number) =>
  runCommand(h.services, runStepCommand, { enrolmentId, sequence: at }, all(tenant));

const later = (days: number) => new Date(Date.now() + days * 86_400_000);

/** A business with the sequence published and one contact in it, no step run yet. */
async function scene(
  otherwise: 'continue' | 'wait' | 'end' = 'continue',
  patch: Partial<AutomationDocumentInput> = {},
) {
  const tenant = await h.business();
  const published = await h.publish(tenant, sequence(otherwise, patch));
  const made = await h.enrol(tenant);
  const [run = ''] = made.enrolments;
  return { tenant, published, ...made, run };
}

it('listens for each of the goal’s events from the start of the run', async () => {
  const s = await scene();
  expect(await goalWaits(s.tenant, s.run)).toEqual([
    { kind: 'goal', event_type: 'form.submitted', conditions: { step: 'booked' } },
    // The CRM calls adding a tag "assigned".
    { kind: 'goal', event_type: 'tag.assigned', conditions: { step: 'booked' } },
  ]);
});

it('moves a run waiting on time straight to the goal step, and goes on from there', async () => {
  const s = await scene();
  expect(await h.step(s.tenant, s.run)).toBe('ran');
  expect(await h.run(s.tenant, s.run)).toMatchObject({
    status: 'waiting',
    current_step: 'nudge',
    sequence: 1,
  });

  const { eventId, matched } = await submits(s.tenant, s.contactId);
  expect(matched).toMatchObject({ enrolled: 0, exited: 0, moved: 1 });
  expect(await h.run(s.tenant, s.run)).toMatchObject({
    status: 'running',
    current_step: 'booked',
    wake_at: null,
    sequence: 2,
  });
  expect(await stateOf(s.tenant, s.run)).toMatchObject({
    goal: { step: 'booked', eventId, eventType: 'form.submitted', from: 'pause' },
  });
  // The rest of the wait never happened, and the goal is listened for no more.
  expect(await rows(s.tenant, s.run)).toMatchObject([{ step_key: 'pause', status: 'skipped' }]);
  expect(await goalWaits(s.tenant, s.run)).toEqual([]);
  // The job queued for the end of the wait is not the current one any more.
  expect(await stepAt(s.tenant, s.run, 1)).toBe('skipped');

  expect(await h.step(s.tenant, s.run)).toBe('ran');
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'running', current_step: 'thanks' });
  expect((await rows(s.tenant, s.run)).at(-1)).toEqual({
    step_key: 'booked',
    status: 'succeeded',
    resumes: false,
    output: { eventId },
    explanation: 'The goal was met (form.submitted), so the run came straight here from "pause".',
  });
  const state = await stateOf(s.tenant, s.run);
  expect(state).toMatchObject({ goalPassed: true, sequence: 3 });
  expect(state).not.toHaveProperty('goal');
  // The run's history tells it the same way.
  const run = await withTenant(h.db, s.tenant, (trx) =>
    readRun(trx, toPublicId('automation_enrolment', s.run)),
  );
  expect(run.steps.map((step) => [step.step, step.type, step.status])).toEqual([
    ['pause', 'wait', 'skipped'],
    ['booked', 'goal', 'succeeded'],
  ]);
  expect(await h.differences()).toEqual([]);
});

it('moves a run that has not run a step yet', async () => {
  const s = await scene();
  const { matched } = await event(s.tenant, 'tag.assigned', s.contactId, { tagId: 'tag_vip' });
  expect(matched).toMatchObject({ moved: 1 });
  expect(await h.run(s.tenant, s.run)).toMatchObject({
    status: 'running',
    current_step: 'booked',
    sequence: 1,
  });
  // The first step's job, queued when the run began, does nothing now.
  expect(await stepAt(s.tenant, s.run, 0)).toBe('skipped');
  expect(await h.step(s.tenant, s.run)).toBe('ran');
  expect((await rows(s.tenant, s.run)).map((row) => [row.step_key, row.explanation])).toEqual([
    ['booked', 'The goal was met (tag.assigned), so the run came straight here from "pause".'],
  ]);
});

it('is met only by an event its filters pass, for this contact, in this business', async () => {
  const s = await scene();
  await h.step(s.tenant, s.run);
  // Another form, and another tag.
  expect((await submits(s.tenant, s.contactId, 'frm_newsletter')).matched).toMatchObject({
    moved: 0,
  });
  expect(
    (await event(s.tenant, 'tag.assigned', s.contactId, { tagId: 'tag_other' })).matched,
  ).toMatchObject({ moved: 0 });
  // Another contact of the business, who is in the sequence too.
  const grace = await h.enrol(s.tenant, 'Grace');
  expect((await submits(s.tenant, grace.contactId)).matched).toMatchObject({ moved: 1 });
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'waiting', current_step: 'nudge' });
  // Another business with the same sequence.
  const other = await scene();
  expect((await submits(other.tenant, other.contactId)).matched).toMatchObject({ moved: 1 });
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'waiting', current_step: 'nudge' });
  expect(await goalWaits(s.tenant, s.run)).toHaveLength(2);
});

it('takes a run out of a wait for an event, which then listens no more', async () => {
  const s = await scene('continue', {
    start: 'reply',
    steps: {
      reply: {
        type: 'wait.event',
        config: { event: 'message.received', timeout: 'P1D' },
        next: { received: 'booked', timed_out: 'booked' },
      },
      booked: { type: 'goal', config: { events: [booking] }, next: 'thanks' },
      thanks: { type: 'wait', config: { duration: 'PT1M' } },
    },
  });
  await h.step(s.tenant, s.run);
  expect(await stateOf(s.tenant, s.run)).toMatchObject({ armed: { step: 'reply' } });
  expect((await submits(s.tenant, s.contactId)).matched).toMatchObject({ moved: 1, woken: 0 });
  const state = await stateOf(s.tenant, s.run);
  expect(state).not.toHaveProperty('armed');
  expect(await goalWaits(s.tenant, s.run)).toEqual([]);
  // The reply it waited for changes nothing now.
  const reply = await event(s.tenant, 'message.received', s.contactId, { channel: 'email' });
  expect(reply.matched).toMatchObject({ moved: 0, woken: 0 });
  await h.step(s.tenant, s.run);
  expect((await rows(s.tenant, s.run)).map((row) => [row.step_key, row.status])).toEqual([
    ['reply', 'skipped'],
    ['booked', 'succeeded'],
  ]);
  expect(await h.differences()).toEqual([]);
});

it('cancels the manual action a moved run was waiting on', async () => {
  const tenant = await h.business();
  await h.publish(tenant, {
    name: 'Call new leads',
    triggers: [created],
    start: 'call',
    steps: {
      call: { type: 'manual.call', config: { notes: 'Ask about the date' }, next: 'booked' },
      booked: { type: 'goal', config: { events: [booking] }, next: 'thanks' },
      thanks: { type: 'wait', config: { duration: 'PT1M' } },
    },
  });
  await runCommand(
    h.services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`], phones: ['+12025550147'] },
    all(tenant),
  );
  const [made] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; subject_id: string }>(
      "select id, subject_id from events.events where type = 'contact.created'",
    ),
  );
  await h.match(tenant, made?.id ?? '');
  const [enrolment] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments'),
  );
  const run = enrolment?.id ?? '';
  expect(await h.step(tenant, run)).toBe('ran');
  const actions = () =>
    h.database.withTenant(tenant, (sql) =>
      sql.query<{ status: string; closed_by_kind: string | null }>(
        'select status, closed_by_kind from automation.manual_actions',
      ),
    );
  expect(await actions()).toEqual([{ status: 'pending', closed_by_kind: null }]);

  expect((await submits(tenant, made?.subject_id ?? '')).matched).toMatchObject({ moved: 1 });
  expect(await actions()).toEqual([{ status: 'cancelled', closed_by_kind: 'system' }]);
  expect(await stateOf(tenant, run)).not.toHaveProperty('manual');
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'thanks' });
});

it('is met once: after the run has been through the step, the event changes nothing', async () => {
  const s = await scene();
  await h.step(s.tenant, s.run);
  await submits(s.tenant, s.contactId);
  await h.step(s.tenant, s.run);
  await h.step(s.tenant, s.run);
  const before = await h.run(s.tenant, s.run);
  expect(before).toMatchObject({ status: 'waiting', current_step: null });
  expect((await submits(s.tenant, s.contactId)).matched).toMatchObject({ moved: 0 });
  expect(await h.run(s.tenant, s.run)).toEqual(before);
});

it('goes on anyway when the run reaches the step first, and stops listening', async () => {
  const s = await scene('continue');
  await h.step(s.tenant, s.run);
  await h.step(s.tenant, s.run, later(3));
  await h.step(s.tenant, s.run, later(7));
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'running', current_step: 'thanks' });
  expect((await rows(s.tenant, s.run)).at(-1)).toMatchObject({
    step_key: 'booked',
    status: 'succeeded',
    output: {},
    explanation: 'Reached before the goal was met; this step is set to go on anyway.',
  });
  expect(await goalWaits(s.tenant, s.run)).toEqual([]);
  expect((await submits(s.tenant, s.contactId)).matched).toMatchObject({ moved: 0 });
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'running', current_step: 'thanks' });
});

it('ends the run at the step when it is set to end', async () => {
  const s = await scene('end');
  await h.step(s.tenant, s.run);
  await h.step(s.tenant, s.run, later(3));
  await h.step(s.tenant, s.run, later(7));
  expect(await h.run(s.tenant, s.run)).toMatchObject({
    status: 'completed',
    current_step: null,
    exit_reason: null,
  });
  expect((await rows(s.tenant, s.run)).at(-1)).toMatchObject({
    step_key: 'booked',
    status: 'succeeded',
    explanation: 'Reached before the goal was met; this step is set to end the run here.',
  });
  expect(await goalWaits(s.tenant, s.run)).toEqual([]);
  expect(await h.events(s.tenant, 'automation.run.%')).toMatchObject([
    { type: 'automation.run.completed', subject_id: s.run },
  ]);
});

it('waits at the step when it is set to wait, and goes on when the goal is met', async () => {
  const s = await scene('wait');
  await h.step(s.tenant, s.run);
  await h.step(s.tenant, s.run, later(3));
  const reached = later(7);
  await h.step(s.tenant, s.run, reached);
  const waiting = await h.run(s.tenant, s.run);
  expect(waiting).toMatchObject({ status: 'waiting', current_step: 'booked', sequence: 3 });
  // A year at most.
  expect(waiting.wake_at?.toISOString().slice(0, 10)).toBe(
    new Date(reached.getTime() + 365 * 86_400_000).toISOString().slice(0, 10),
  );
  expect((await rows(s.tenant, s.run)).at(-1)).toMatchObject({
    step_key: 'booked',
    status: 'waiting',
  });
  expect(await goalWaits(s.tenant, s.run)).toHaveLength(2);
  // Woken early with nothing arrived, it goes on waiting.
  expect(await h.step(s.tenant, s.run, later(8))).toBe('skipped');

  const { eventId, matched } = await submits(s.tenant, s.contactId);
  expect(matched).toMatchObject({ moved: 1 });
  expect(await goalWaits(s.tenant, s.run)).toEqual([]);
  expect(await h.step(s.tenant, s.run, later(8))).toBe('ran');
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'running', current_step: 'thanks' });
  expect((await rows(s.tenant, s.run)).slice(-2)).toEqual([
    expect.objectContaining({ step_key: 'booked', status: 'succeeded', resumes: false }),
    {
      step_key: 'booked',
      status: 'succeeded',
      resumes: true,
      output: { eventId },
      explanation: 'The goal was met while the run waited here, so it went on.',
    },
  ]);
  expect(await h.differences()).toEqual([]);
});

it('ends a run that waited a year at the step without the goal being met', async () => {
  const s = await scene('wait');
  await h.step(s.tenant, s.run);
  await h.step(s.tenant, s.run, later(3));
  await h.step(s.tenant, s.run, later(7));
  expect(await h.step(s.tenant, s.run, later(7 + 366))).toBe('ran');
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'completed', current_step: null });
  expect((await rows(s.tenant, s.run)).at(-1)).toMatchObject({
    step_key: 'booked',
    resumes: true,
    explanation: 'The goal was not met in 365 days of waiting here, so the run ended.',
  });
  expect(await goalWaits(s.tenant, s.run)).toEqual([]);
});

it('stops, and does not move, a run whose stop condition the same event meets', async () => {
  const s = await scene('continue', { stopWhen: [{ event: 'form.submitted' }] });
  await h.step(s.tenant, s.run);
  expect((await submits(s.tenant, s.contactId)).matched).toMatchObject({ exited: 1, moved: 0 });
  expect(await h.run(s.tenant, s.run)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:form.submitted',
    current_step: null,
  });
  expect(await goalWaits(s.tenant, s.run)).toEqual([]);
});

it('hears either outcome of a closed deal, and keeps the outcome it names', async () => {
  const s = await scene('continue', {
    start: 'pause',
    steps: {
      pause: { type: 'wait', config: { duration: 'P2D' }, next: 'won' },
      won: {
        type: 'goal',
        config: { events: [{ type: 'deal.closed', config: { outcome: 'won' } }] },
      },
    },
  });
  expect((await goalWaits(s.tenant, s.run)).map((wait) => wait.event_type)).toEqual([
    'deal.lost',
    'deal.won',
  ]);
  expect((await event(s.tenant, 'deal.lost', s.contactId)).matched).toMatchObject({ moved: 0 });
  expect((await event(s.tenant, 'deal.won', s.contactId)).matched).toMatchObject({ moved: 1 });
  await h.step(s.tenant, s.run);
  // Nothing follows the goal step, so the run is done.
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'completed' });
});

it('listens afresh in a new run of the same contact', async () => {
  const tenant = await h.business();
  const entry = { type: 'form.submitted', config: { form: 'frm_entry' } } as const;
  const published = await h.publish(
    tenant,
    sequence('continue', {
      triggers: [{ id: 'entered', ...entry }],
      settings: { reEnrollment: 'after_finished' },
    }),
  );
  const ada = await h.contact(tenant);
  const runs = () =>
    h.database.withTenant(tenant, (sql) =>
      sql.query<{ id: string; status: string }>(
        'select id, status from automation.enrolments where automation_id = $1 order by id',
        [published.automationId],
      ),
    );
  expect((await submits(tenant, ada.contactId, 'frm_entry')).matched).toMatchObject({
    enrolled: 1,
  });
  const [first] = await runs();
  // The goal is met; the run goes through the step and to its end.
  expect((await submits(tenant, ada.contactId)).matched).toMatchObject({ moved: 1 });
  await h.step(tenant, first?.id ?? '');
  await h.step(tenant, first?.id ?? '');
  await h.step(tenant, first?.id ?? '', later(1));
  expect((await runs()).map((run) => run.status)).toEqual(['completed']);

  expect((await submits(tenant, ada.contactId, 'frm_entry')).matched).toMatchObject({
    enrolled: 1,
  });
  const second = (await runs())[1]?.id ?? '';
  expect(await goalWaits(tenant, second)).toHaveLength(2);
  expect(await stateOf(tenant, second)).not.toHaveProperty('goalPassed');
  expect((await submits(tenant, ada.contactId)).matched).toMatchObject({ moved: 1 });
  expect(await h.run(tenant, second)).toMatchObject({ status: 'running', current_step: 'booked' });
});

it('moves a run that was about to run the goal step anyway, and names no step it came from', async () => {
  const s = await scene('wait', {
    start: 'booked',
    steps: {
      booked: { type: 'goal', config: { events: [booking], otherwise: 'wait' }, next: 'thanks' },
      thanks: { type: 'wait', config: { duration: 'PT1M' } },
    },
  });
  expect((await submits(s.tenant, s.contactId)).matched).toMatchObject({ moved: 1 });
  expect(await stateOf(s.tenant, s.run)).toMatchObject({ goal: { step: 'booked', from: null } });
  await h.step(s.tenant, s.run);
  // Met before it was reached: it does not wait, whatever it is set to.
  expect(await h.run(s.tenant, s.run)).toMatchObject({ status: 'running', current_step: 'thanks' });
  expect((await rows(s.tenant, s.run)).map((row) => row.explanation)).toEqual([
    'The goal was met (form.submitted), so the run came straight here.',
  ]);
});
