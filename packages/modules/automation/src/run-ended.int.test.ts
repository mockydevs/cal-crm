// Starting an automation when a run of another ends, and an automation with no trigger at
// all. Real Postgres, real events, the engine's own match and step commands, and the real
// publish command.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Harness, type Published, type Tenant } from '../test/workflows.js';
import { createLifecycleCommands } from './lifecycle.js';
import { readAutomationSetup } from './setup.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const created = { id: 'created', type: 'contact.created', config: {} } as const;
const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});

/** Waits two days; a reply or a booking ends it. */
const sales = (name: string): AutomationDocumentInput => ({
  name,
  triggers: [created],
  stopWhen: [{ event: 'message.received', from: 'contact' }, { event: 'appointment.booked' }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P2D' } } },
});

const education: AutomationDocumentInput = {
  name: 'Education',
  triggers: [created],
  start: 'lesson',
  steps: { lesson: { type: 'wait', config: { duration: 'P3D' } } },
};

/** Starts when a run of the automations named ends; a wait stands in for what it does. */
const after = (
  name: string,
  config: Record<string, unknown>,
  patch: Partial<AutomationDocumentInput> = {},
): AutomationDocumentInput => ({
  name,
  triggers: [{ id: 'ended', type: 'automation.run_ended', config } as never],
  start: 'tell',
  steps: { tell: { type: 'wait', config: { duration: 'PT1M' } } },
  ...patch,
});

// Something happening to the contact, as messaging and the calendar emit it.
const happen = defineCommand({
  name: 'test.happened',
  permission: 'contacts.manage',
  input: z.strictObject({
    recordId: z.uuid(),
    type: z.enum(['message.received', 'appointment.booked']),
  }),
  async handle(_trx, input, command) {
    return command.emit({
      type: input.type,
      subject: {
        kind: input.type === 'message.received' ? 'message' : 'appointment',
        id: randomUUID(),
      },
      records: [input.recordId],
      payload: input.type === 'message.received' ? { channel: 'email' } : {},
    });
  },
});

const runsIn = (tenant: Tenant, automationId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      id: string;
      record_id: string;
      status: string;
      trigger_key: string | null;
      state: Record<string, unknown>;
    }>(
      `select id, record_id, status, trigger_key, state from automation.enrolments
       where automation_id = $1 order by id`,
      [automationId],
    ),
  );

/** The contact's run in an automation. */
async function runOf(tenant: Tenant, published: Published, contactId: string) {
  const run = (await runsIn(tenant, published.automationId)).find(
    (each) => each.record_id === contactId,
  );
  if (run === undefined) throw new Error(`No run in ${published.id}.`);
  return run;
}

const matched = new Set<string>();
/**
 * Matches every run-ended event not yet matched, oldest first, as the worker's match jobs
 * do, and gives how many runs each started.
 */
async function matchEndings(tenant: Tenant): Promise<number[]> {
  const events = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      `select id from events.events where type like 'automation.run.%' order by recorded_at, id`,
    ),
  );
  const started: number[] = [];
  for (const event of events) {
    if (matched.has(event.id)) continue;
    matched.add(event.id);
    started.push((await h.match(tenant, event.id)).enrolled);
  }
  return started;
}

const matchJobs = (tenant: Tenant) =>
  h.database.as('crm_owner', (sql) =>
    sql.query<{ type: string }>(
      `select e.type from events.events e
       join graphile_worker.jobs j on j.key = 'automation-match:' || e.id::text
       where e.business_id = $1 and e.type like 'automation.run.%' order by e.recorded_at, e.id`,
      [tenant.businessId],
    ),
  );

async function happens(
  tenant: Tenant,
  contactId: string,
  type: 'message.received' | 'appointment.booked',
) {
  const eventId = await runCommand(h.services, happen, { recordId: contactId, type }, all(tenant));
  return h.match(tenant, eventId);
}

/** Two sales sequences and education, and an automation told when a reply ends a sales run. */
async function scene(config: (ids: { dj: string; photo: string }) => Record<string, unknown>) {
  const tenant = await h.business();
  const dj = await h.publish(tenant, sales('DJ sales'));
  const photo = await h.publish(tenant, sales('Photo sales'));
  const lessons = await h.publish(tenant, education);
  const notify = await h.publish(
    tenant,
    after('Sales reply: notify', config({ dj: dj.id, photo: photo.id })),
  );
  const lead = async (firstName: string) => {
    const made = await h.enrol(tenant, firstName);
    for (const run of made.enrolments) await h.step(tenant, run);
    return made;
  };
  return { tenant, dj, photo, lessons, notify, lead };
}

it('starts once when a reply stops two sales runs of one contact, whatever education does', async () => {
  const s = await scene((ids) => ({
    automations: [ids.dj, ids.photo],
    stoppedBy: ['message.received'],
  }));
  const ada = await s.lead('Ada');
  const grace = await s.lead('Grace');

  // The reply stops both sales runs; it starts nothing itself.
  expect(await happens(s.tenant, ada.contactId, 'message.received')).toMatchObject({
    enrolled: 0,
    exited: 2,
  });
  // Each stopped run said so, and the database queued a match for each: the worker needs
  // no help to get from the reply to the notification.
  expect(await matchJobs(s.tenant)).toEqual([
    { type: 'automation.run.stopped' },
    { type: 'automation.run.stopped' },
  ]);
  // The first ending starts the notification; the second finds the contact already in it.
  expect(await matchEndings(s.tenant)).toEqual([1, 0]);
  const told = await runsIn(s.tenant, s.notify.automationId);
  expect(told).toHaveLength(1);
  const stoppedFirst = (await runOf(s.tenant, s.dj, ada.contactId)).id;
  const stoppedSecond = (await runOf(s.tenant, s.photo, ada.contactId)).id;
  expect(told[0]).toMatchObject({
    record_id: ada.contactId,
    status: 'running',
    trigger_key: 'ended',
  });
  // It carries which run's end started it, and that run's automation as its chain.
  const cause = told[0]?.state as { endedRun: { enrolmentId: string }; chain: string[] };
  expect([stoppedFirst, stoppedSecond]).toContain(cause.endedRun.enrolmentId);
  expect([[s.dj.automationId], [s.photo.automationId]]).toContainEqual(cause.chain);
  // Education goes on; the other contact was not replied to and is told of nothing.
  expect(await runOf(s.tenant, s.lessons, ada.contactId)).toMatchObject({ status: 'waiting' });
  expect(await runOf(s.tenant, s.dj, grace.contactId)).toMatchObject({ status: 'waiting' });
  // Run to its end, a later ending of the same contact's still does not start it again:
  // it enrols a contact once.
  await h.step(s.tenant, told[0]?.id ?? '');
  await h.step(s.tenant, told[0]?.id ?? '', new Date(Date.now() + 120_000));
  expect(await matchEndings(s.tenant)).toEqual([0]);
  expect(await runsIn(s.tenant, s.notify.automationId)).toHaveLength(1);
  expect(await h.differences()).toEqual([]);
});

it('does not start when a booking, not a reply, stopped the sales runs', async () => {
  const s = await scene((ids) => ({
    automations: [ids.dj, ids.photo],
    stoppedBy: ['message.received'],
  }));
  const ada = await s.lead('Ada');
  expect(await happens(s.tenant, ada.contactId, 'appointment.booked')).toMatchObject({ exited: 2 });
  expect(await matchEndings(s.tenant)).toEqual([0, 0]);
  expect(await runsIn(s.tenant, s.notify.automationId)).toEqual([]);
});

it('does not start for an automation it does not name', async () => {
  const s = await scene((ids) => ({ automations: [ids.photo], how: ['completed'] }));
  const ada = await s.lead('Ada');
  // Education's run completes; so, later, does the DJ run. Neither is the one named.
  const lesson = await runOf(s.tenant, s.lessons, ada.contactId);
  await h.step(s.tenant, lesson.id, new Date(Date.now() + 4 * 86_400_000));
  expect(await runOf(s.tenant, s.lessons, ada.contactId)).toMatchObject({ status: 'completed' });
  expect(await matchEndings(s.tenant)).toEqual([0]);
  // The photo run completing is.
  const photo = await runOf(s.tenant, s.photo, ada.contactId);
  await h.step(s.tenant, photo.id, new Date(Date.now() + 3 * 86_400_000));
  expect(await matchEndings(s.tenant)).toEqual([1]);
  expect(await runsIn(s.tenant, s.notify.automationId)).toMatchObject([
    { record_id: ada.contactId },
  ]);
});

it('starts when another automation removed the contact, and when a run failed, if asked', async () => {
  const tenant = await h.business();
  const dj = await h.publish(tenant, sales('DJ sales'));
  const broken = await h.publish(tenant, {
    name: 'Broken',
    triggers: [created],
    start: 'tell',
    // No notification service is composed in this harness, so the step fails.
    steps: { tell: { type: 'team.notify', config: { message: 'Hi' } } },
  });
  const remover = await h.publish(tenant, {
    name: 'Consultation booked',
    triggers: [created],
    start: 'clear',
    steps: {
      clear: {
        type: 'automation.remove',
        config: { from: 'automations', automations: [dj.id] },
        next: 'rest',
      },
      rest: { type: 'wait', config: { duration: 'P9D' } },
    },
  });
  const removed = await h.publish(
    tenant,
    after('After removal', { automations: [dj.id], how: ['removed'] }),
  );
  const failed = await h.publish(
    tenant,
    after('After failure', { automations: [broken.id], how: ['failed'] }),
  );
  const stopped = await h.publish(
    tenant,
    after('After a stop', { automations: [dj.id, broken.id], how: ['stopped'] }),
  );
  const made = await h.enrol(tenant);
  await h.step(tenant, (await runOf(tenant, dj, made.contactId)).id);
  await h.step(tenant, (await runOf(tenant, broken, made.contactId)).id);
  await h.step(tenant, (await runOf(tenant, remover, made.contactId)).id);
  expect(await runOf(tenant, dj, made.contactId)).toMatchObject({ status: 'exited' });
  expect(await runOf(tenant, broken, made.contactId)).toMatchObject({ status: 'failed' });

  expect((await matchEndings(tenant)).sort()).toEqual([1, 1]);
  expect(await runsIn(tenant, removed.automationId)).toHaveLength(1);
  expect(await runsIn(tenant, failed.automationId)).toHaveLength(1);
  expect(await runsIn(tenant, stopped.automationId)).toEqual([]);
});

it('never lets two automations start each other round and round, though both allow re-enrolment', async () => {
  const tenant = await h.business();
  const again = { settings: { reEnrollment: 'after_finished' as const } };
  const quick: AutomationDocumentInput['steps'] = {
    tell: {
      type: 'condition',
      config: { if: { field: 'contact.firstName', operator: 'is_set' } },
    },
  };
  // Published without the validator, as two publishes racing each other could leave them.
  const a = await h.publish(tenant, {
    ...sales('A'),
    ...again,
    stopWhen: [],
    steps: quick,
    start: 'tell',
  });
  const b = await h.publish(
    tenant,
    after('B', { automations: [a.id] }, { ...again, steps: quick }),
  );
  await h.publish(
    tenant,
    {
      name: 'A',
      ...again,
      triggers: [
        created,
        { id: 'ended', type: 'automation.run_ended', config: { automations: [b.id] } } as never,
      ],
      start: 'tell',
      steps: quick,
    },
    a.automationId,
  );
  const made = await h.enrol(tenant);
  const first = await runOf(tenant, a, made.contactId);
  await h.step(tenant, first.id);
  // A ended: B starts, carrying A in its chain.
  expect(await matchEndings(tenant)).toEqual([1]);
  const second = await runOf(tenant, b, made.contactId);
  expect(second.state).toMatchObject({ chain: [a.automationId] });
  await h.step(tenant, second.id);
  // B ended: A is in the chain that led here, so it is not started again, and it ends there.
  expect(await matchEndings(tenant)).toEqual([0]);
  expect(await runsIn(tenant, a.automationId)).toHaveLength(1);
  expect(await runsIn(tenant, b.automationId)).toHaveLength(1);
});

const lifecycle = createLifecycleCommands({
  setup: (trx, context) =>
    readAutomationSetup(trx, context, () => Promise.resolve([]), {
      webhookDelivery: false,
      smsDelivery: false,
    }),
});

/** A draft as the API stores one, published through the real publish command. */
async function draft(tenant: Tenant, name: string) {
  const { id } = await withTenant(h.db, tenant, (trx) =>
    trx
      .insertInto('automation.automations')
      .values({
        business_id: tenant.businessId,
        name,
        draft: JSON.stringify({ name }),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  const publicId = toPublicId('automation', id);
  let revision = 1;
  return {
    automationId: id,
    id: publicId,
    async publish(document: AutomationDocumentInput) {
      revision += 1;
      await h.database.withTenant(tenant, (sql) =>
        sql.query(
          `update automation.automations set draft = $2::jsonb, draft_revision = $3 where id = $1`,
          [id, JSON.stringify(document), revision],
        ),
      );
      return runCommand(
        h.services,
        lifecycle.publish,
        { id: publicId, baseDraftVersion: revision, changeSummary: 'Published' },
        all(tenant),
      );
    },
  };
}

const issuesOf = async (attempt: Promise<unknown>) => {
  const error: unknown = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error('It was published.');
  return error.issues.map((issue) => [issue.path, issue.code, issue.message]);
};

it('refuses to publish a trigger on its own runs ending, or one that closes a loop', async () => {
  const tenant = await h.business();
  const a = await draft(tenant, 'A');
  const b = await draft(tenant, 'B');
  expect(await issuesOf(a.publish(after('A', { automations: [a.id] })))).toEqual([
    [
      '/draft/triggers/0/config/automations/0',
      'automation_loop',
      'This automation would start whenever one of its own runs ended.',
    ],
  ]);
  // B after A is published; then A after B would close the loop, and so would A starting B.
  expect((await b.publish(after('B', { automations: ['A'] }))).status).toBe('active');
  expect(await issuesOf(a.publish(after('A', { automations: [b.id] })))).toEqual([
    [
      '/draft/triggers/0/config/automations/0',
      'automation_loop',
      'Starting when "B" ends would loop: A → B → A.',
    ],
  ]);
  // A starting B by a step is no loop: B was going to start after A anyway.
  expect(
    (
      await a.publish({
        ...sales('A'),
        start: 'go',
        steps: { go: { type: 'automation.run', config: { automation: b.id } } },
      })
    ).status,
  ).toBe('active');
});

it('publishes an automation with no trigger, which only another automation starts', async () => {
  const tenant = await h.business();
  const booked = await draft(tenant, 'Consultation booked sequence');
  const published = await booked.publish({
    name: 'Consultation booked sequence',
    triggers: [],
    start: 'prepare',
    steps: { prepare: { type: 'wait', config: { duration: 'P1D' } } },
  });
  expect(published).toMatchObject({ status: 'active', liveVersion: 1 });
  // Nothing subscribes it to any event.
  expect(
    await h.database.withTenant(tenant, (sql) =>
      sql.query('select 1 from automation.trigger_subscriptions where automation_id = $1', [
        booked.automationId,
      ]),
    ),
  ).toEqual([]);
  const master = await h.publish(tenant, {
    name: 'Master rule',
    triggers: [created],
    start: 'go',
    steps: { go: { type: 'automation.run', config: { automation: booked.id } } },
  });
  // A new contact's own event starts the master rule and not the triggerless one.
  const made = await h.enrol(tenant);
  expect(await runsIn(tenant, booked.automationId)).toEqual([]);
  await h.step(tenant, (await runOf(tenant, master, made.contactId)).id);
  expect(await runsIn(tenant, booked.automationId)).toMatchObject([
    { record_id: made.contactId, status: 'running', trigger_key: null },
  ]);
});
