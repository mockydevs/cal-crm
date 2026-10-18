// Starting another automation from a step: the child is enrolled by the same rules as an
// event enrols a record, once, on the version published at that moment, and the parent goes
// on at once. Real Postgres, the engine's own commands, and real events.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import {
  runStepCommand,
  startHarness,
  type Harness,
  type Published,
  type Tenant,
} from '../test/workflows.js';
import { readRecordRuns, readRun } from './history.js';
import { createLifecycleCommands } from './lifecycle.js';
import { runStep } from './runner.js';
import { readAutomationSetup } from './setup.js';

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
// A trigger no test fires, so only a parent's step starts the automation.
const unheard = { id: 'tagged', type: 'tag.added', config: { tag: 'never' } } as const;

/** An automation every new contact starts, whose first step starts another automation. */
const parent = (name: string, target: string): AutomationDocumentInput => ({
  name,
  triggers: [created],
  start: 'start_child',
  steps: {
    start_child: { type: 'automation.run', config: { automation: target }, next: 'after' },
    after: { type: 'wait', config: { duration: 'PT1M' } },
  },
});

/** An automation only a parent starts: it waits a day, then ends. */
const child = (patch: Partial<AutomationDocumentInput> = {}): AutomationDocumentInput => ({
  name: 'Pre-consultation',
  triggers: [unheard],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
  ...patch,
});

interface RunRow {
  id: string;
  status: string;
  version_id: string;
  record_id: string;
  trigger_key: string | null;
  trigger_event_id: string | null;
  correlation_id: string;
  state: Record<string, unknown>;
  current_step: string | null;
}

/** The runs of an automation, oldest first. */
const runsOf = (tenant: Tenant, automationId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<RunRow>(
      `select id, status, version_id, record_id, trigger_key, trigger_event_id, correlation_id,
              state, current_step
       from automation.enrolments where automation_id = $1 order by id`,
      [automationId],
    ),
  );

/** The one run a contact has in an automation. */
async function runOf(tenant: Tenant, automationId: string, contactId: string): Promise<RunRow> {
  const found = (await runsOf(tenant, automationId)).filter((run) => run.record_id === contactId);
  if (found.length !== 1 || found[0] === undefined)
    throw new Error(`Expected one run, found ${String(found.length)}.`);
  return found[0];
}

/** What a run's steps recorded, oldest first. */
const stepsOf = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      step_key: string;
      status: string;
      output: Record<string, unknown>;
      explanation: string;
      error: { code: string } | null;
    }>(
      `select step_key, status, output, explanation, error from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

const queuedFor = (enrolmentId: string) =>
  h.database.as('crm_owner', (sql) =>
    sql.query(
      "select 1 from graphile_worker.jobs where key = 'automation-enrolment:' || $1::text",
      [enrolmentId],
    ),
  );

const stepAt = (tenant: Tenant, enrolmentId: string, sequence: number) =>
  runCommand(h.services, runStepCommand, { enrolmentId, sequence }, all(tenant));

const setStatus = (tenant: Tenant, automationId: string, status: 'paused' | 'archived') =>
  h.database.withTenant(tenant, (sql) =>
    sql.query(
      `update automation.automations
       set status = $2, archived_at = case when $2 = 'archived' then now() end where id = $1`,
      [automationId, status],
    ),
  );

/** A business with a child automation and one parent that starts it. */
async function scene(patch: Partial<AutomationDocumentInput> = {}) {
  const tenant = await h.business();
  const target = await h.publish(tenant, child(patch));
  const starter = await h.publish(tenant, parent('Consultation booked', target.id));
  return { tenant, target, starter };
}

it('starts a published, active automation for the same record, and goes on at once', async () => {
  const { tenant, target, starter } = await scene();
  const made = await h.enrol(tenant);
  const from = await runOf(tenant, starter.automationId, made.contactId);
  expect(await runsOf(tenant, target.automationId)).toEqual([]);

  expect(await h.step(tenant, from.id)).toBe('ran');
  const started = await runOf(tenant, target.automationId, made.contactId);
  expect(started).toMatchObject({
    status: 'running',
    version_id: target.versionId,
    record_id: made.contactId,
    current_step: 'pause',
    // No trigger enrolled it; the original trigger's event and correlation carry over.
    trigger_key: null,
    trigger_event_id: made.eventId,
    correlation_id: from.correlation_id,
    state: {
      sequence: 0,
      chain: [starter.automationId],
      startedBy: {
        enrolmentId: from.id,
        automationId: starter.automationId,
        stepKey: 'start_child',
      },
    },
  });
  // The parent never waits for the child: it is at its next step already.
  expect(await h.run(tenant, from.id)).toMatchObject({ status: 'running', current_step: 'after' });
  expect(await stepsOf(tenant, from.id)).toEqual([
    {
      step_key: 'start_child',
      status: 'succeeded',
      output: { outcome: 'started', enrolmentId: toPublicId('automation_enrolment', started.id) },
      explanation: 'Started "Pre-consultation" for this record.',
      error: null,
    },
  ]);
  // The child's first step is queued with the parent's step, and runs as any run's does.
  expect(await queuedFor(started.id)).toHaveLength(1);
  expect(await h.step(tenant, started.id)).toBe('ran');
  expect(await h.run(tenant, started.id)).toMatchObject({ status: 'waiting', sequence: 1 });
  expect(await h.differences()).toEqual([]);
});

it.each(['draft', 'paused', 'archived'] as const)(
  'starts nothing in a %s automation, says so, and still goes on',
  async (status) => {
    const tenant = await h.business();
    const target =
      status === 'draft'
        ? await withTenant(h.db, tenant, async (trx) => {
            const { id } = await trx
              .insertInto('automation.automations')
              .values({
                business_id: tenant.businessId,
                name: 'Pre-consultation',
                draft: JSON.stringify(child()),
                created_by_kind: 'system',
              })
              .returning('id')
              .executeTakeFirstOrThrow();
            return { automationId: id, id: toPublicId('automation', id) };
          })
        : await h.publish(tenant, child());
    if (status !== 'draft') await setStatus(tenant, target.automationId, status);
    const starter = await h.publish(tenant, parent('Consultation booked', target.id));
    const made = await h.enrol(tenant);
    const from = await runOf(tenant, starter.automationId, made.contactId);

    expect(await h.step(tenant, from.id)).toBe('ran');
    expect(await runsOf(tenant, target.automationId)).toEqual([]);
    expect(await h.run(tenant, from.id)).toMatchObject({
      status: 'running',
      current_step: 'after',
    });
    expect(await stepsOf(tenant, from.id)).toEqual([
      {
        step_key: 'start_child',
        status: 'succeeded',
        output: { outcome: 'not_active' },
        explanation:
          status === 'draft'
            ? '"Pre-consultation" is not published, so nothing was started.'
            : status === 'paused'
              ? '"Pre-consultation" is paused, so nothing was started.'
              : '"Pre-consultation" was deleted, so nothing was started.',
        error: null,
      },
    ]);
  },
);

it('never starts a record again in an automation that enrols once, after its run ended', async () => {
  const tenant = await h.business();
  const target = await h.publish(
    tenant,
    child({
      start: 'check',
      steps: {
        check: {
          type: 'condition',
          config: { if: { field: 'contact.firstName', operator: 'is_set' } },
        },
      },
    }),
  );
  const first = await h.publish(tenant, parent('First', target.id));
  const second = await h.publish(tenant, parent('Second', target.id));
  const made = await h.enrol(tenant);
  const one = await runOf(tenant, first.automationId, made.contactId);
  const two = await runOf(tenant, second.automationId, made.contactId);

  await h.step(tenant, one.id);
  const started = await runOf(tenant, target.automationId, made.contactId);
  await h.step(tenant, started.id);
  expect(await h.run(tenant, started.id)).toMatchObject({ status: 'completed' });

  expect(await h.step(tenant, two.id)).toBe('ran');
  expect(await runsOf(tenant, target.automationId)).toHaveLength(1);
  expect((await stepsOf(tenant, two.id))[0]).toMatchObject({
    status: 'succeeded',
    output: { outcome: 'already_went_through' },
    explanation: 'This record already went through "Pre-consultation", which enrols a record once.',
  });
  expect(await h.run(tenant, two.id)).toMatchObject({ status: 'running', current_step: 'after' });
});

it('starts a record again once its last run ended, when the automation allows it', async () => {
  const tenant = await h.business();
  const target = await h.publish(
    tenant,
    child({
      settings: { reEnrollment: 'after_finished' },
      start: 'check',
      steps: {
        check: {
          type: 'condition',
          config: { if: { field: 'contact.firstName', operator: 'is_set' } },
        },
      },
    }),
  );
  const first = await h.publish(tenant, parent('First', target.id));
  const second = await h.publish(tenant, parent('Second', target.id));
  const made = await h.enrol(tenant);
  await h.step(tenant, (await runOf(tenant, first.automationId, made.contactId)).id);
  const [earlier] = await runsOf(tenant, target.automationId);
  await h.step(tenant, earlier?.id ?? '');

  const two = await runOf(tenant, second.automationId, made.contactId);
  await h.step(tenant, two.id);
  const runs = await runsOf(tenant, target.automationId);
  expect(runs.map((run) => run.status)).toEqual(['completed', 'running']);
  expect((await stepsOf(tenant, two.id))[0]?.output).toEqual({
    outcome: 'started',
    enrolmentId: toPublicId('automation_enrolment', runs[1]?.id ?? ''),
  });
});

it.each(['never', 'after_finished'] as const)(
  'starts nothing while the record is still in the automation (re-enrolment %s)',
  async (reEnrollment) => {
    const tenant = await h.business();
    const target = await h.publish(tenant, child({ settings: { reEnrollment } }));
    const first = await h.publish(tenant, parent('First', target.id));
    const second = await h.publish(tenant, parent('Second', target.id));
    const made = await h.enrol(tenant);
    await h.step(tenant, (await runOf(tenant, first.automationId, made.contactId)).id);

    const two = await runOf(tenant, second.automationId, made.contactId);
    expect(await h.step(tenant, two.id)).toBe('ran');
    expect(await runsOf(tenant, target.automationId)).toHaveLength(1);
    expect((await stepsOf(tenant, two.id))[0]).toMatchObject({
      status: 'succeeded',
      output: { outcome: 'already_running' },
      explanation: 'This record is already in "Pre-consultation".',
    });
  },
);

it('starts one run when two parents reach the same child for one record at once', async () => {
  const tenant = await h.business();
  const target = await h.publish(tenant, child());
  const first = await h.publish(tenant, parent('First', target.id));
  const second = await h.publish(tenant, parent('Second', target.id));
  for (let round = 0; round < 5; round += 1) {
    const made = await h.enrol(tenant, `Racer ${String(round)}`);
    const one = await runOf(tenant, first.automationId, made.contactId);
    const two = await runOf(tenant, second.automationId, made.contactId);
    expect(await Promise.all([h.step(tenant, one.id), h.step(tenant, two.id)])).toEqual([
      'ran',
      'ran',
    ]);
    const started = await runOf(tenant, target.automationId, made.contactId);
    const outcomes = [
      (await stepsOf(tenant, one.id))[0]?.output,
      (await stepsOf(tenant, two.id))[0]?.output,
    ];
    expect(outcomes.map((output) => output?.['outcome']).sort()).toEqual([
      'already_running',
      'started',
    ]);
    expect(outcomes.flatMap((output) => output?.['enrolmentId'] ?? [])).toEqual([
      toPublicId('automation_enrolment', started.id),
    ]);
  }
  expect(await h.differences()).toEqual([]);
});

it('starts the child once however often the committed step is replayed', async () => {
  const { tenant, target, starter } = await scene();
  const made = await h.enrol(tenant);
  const from = await runOf(tenant, starter.automationId, made.contactId);
  expect(await Promise.all([stepAt(tenant, from.id, 0), stepAt(tenant, from.id, 0)])).toEqual(
    expect.arrayContaining(['ran', 'skipped']),
  );
  expect(await stepAt(tenant, from.id, 0)).toBe('skipped');
  expect(await runsOf(tenant, target.automationId)).toHaveLength(1);
  expect(await stepsOf(tenant, from.id)).toHaveLength(1);
});

// The step, then a crash before its transaction commits: as when a worker dies mid-step.
const crashAfterStep = defineCommand({
  name: 'test.crash_after_step',
  permission: 'automations.manage',
  input: z.strictObject({ enrolmentId: z.uuid() }),
  async handle(trx, input, command): Promise<never> {
    const ran = await runStep(
      trx,
      command,
      {
        tasks: {
          actorNames: {},
          assignees: {
            resolve: () => Promise.resolve(null),
            read: () => Promise.resolve({ items: [], nextCursor: null }),
            memberships: () => Promise.resolve(new Map<string, string>()),
          },
        },
      },
      input.enrolmentId,
      0,
    );
    const inside = await trx
      .selectFrom('automation.enrolments')
      .select('id')
      .where('state', '@>', JSON.stringify({ startedBy: { enrolmentId: input.enrolmentId } }))
      .execute();
    throw new Error(`crashed after it ${ran} and started ${String(inside.length)}`);
  },
});

it('keeps nothing of a step that rolled back, and starts the child once when it is retried', async () => {
  const { tenant, target, starter } = await scene();
  const made = await h.enrol(tenant);
  const from = await runOf(tenant, starter.automationId, made.contactId);

  // Inside the transaction the child existed; the crash took it away with the step.
  await expect(
    runCommand(h.services, crashAfterStep, { enrolmentId: from.id }, all(tenant)),
  ).rejects.toThrow('crashed after it ran and started 1');
  expect(await runsOf(tenant, target.automationId)).toEqual([]);
  expect(await h.run(tenant, from.id)).toMatchObject({ status: 'running', sequence: 0 });
  expect(await stepsOf(tenant, from.id)).toEqual([]);

  // The retried job is the same job: same enrolment, same sequence.
  expect(await stepAt(tenant, from.id, 0)).toBe('ran');
  expect(await stepAt(tenant, from.id, 0)).toBe('skipped');
  expect(await runsOf(tenant, target.automationId)).toHaveLength(1);
  expect(await h.differences()).toEqual([]);
});

const lifecycle = createLifecycleCommands({
  setup: (trx, context) =>
    readAutomationSetup(trx, context, () => Promise.resolve([]), {
      webhookDelivery: false,
      smsDelivery: false,
    }),
});

/** A draft as the API stores one, and its publication through the real publish command. */
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
      await h.database.withTenant(tenant, (sql) =>
        sql.query(
          `update automation.automations set draft = $2::jsonb, draft_revision = $3 where id = $1`,
          [id, JSON.stringify(document), revision + 1],
        ),
      );
      revision += 1;
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

it('refuses to publish an automation that starts itself', async () => {
  const tenant = await h.business();
  const own = await draft(tenant, 'Round and round');
  expect(await issuesOf(own.publish(parent('Round and round', own.id)))).toEqual([
    [
      '/draft/steps/start_child/config/automation',
      'automation_loop',
      'This automation would start itself.',
    ],
  ]);
  // By name it is the same automation.
  expect(await issuesOf(own.publish(parent('Round and round', 'Round and round')))).toEqual([
    [
      '/draft/steps/start_child/config/automation',
      'automation_loop',
      'This automation would start itself.',
    ],
  ]);
});

it('refuses the publish that would close a loop, whichever side publishes second', async () => {
  const tenant = await h.business();
  const a = await draft(tenant, 'A');
  const b = await draft(tenant, 'B');
  const c = await draft(tenant, 'C');
  // B exists only as a draft so far, so A may start it; then B may start C.
  expect((await a.publish(parent('A', b.id))).status).toBe('active');
  expect((await b.publish(parent('B', c.id))).status).toBe('active');
  // C starting A would close A → B → C → A.
  expect(await issuesOf(c.publish(parent('C', 'A')))).toEqual([
    [
      '/draft/steps/start_child/config/automation',
      'automation_loop',
      'Starting "A" would loop: C → A → B → C.',
    ],
  ]);
  // And B starting A directly would close A → B → A.
  expect(await issuesOf(b.publish(parent('B', a.id)))).toEqual([
    [
      '/draft/steps/start_child/config/automation',
      'automation_loop',
      'Starting "A" would loop: B → A → B.',
    ],
  ]);
  // A start that leads nowhere back is published.
  expect((await c.publish(child({ name: 'C', triggers: [created] }))).liveVersion).toBe(1);
});

it('refuses at run time a loop the documents came to hold after they were published', async () => {
  const tenant = await h.business();
  // Both published without the validator, as two publishes racing each other could leave them.
  const a = await h.publish(tenant, child({ name: 'A', triggers: [created] }));
  const b = await h.publish(tenant, {
    ...parent('B', a.id),
    triggers: [unheard],
  });
  await h.publish(tenant, parent('A', b.id), a.automationId);
  const made = await h.enrol(tenant);
  const first = await runOf(tenant, a.automationId, made.contactId);

  await h.step(tenant, first.id);
  const second = await runOf(tenant, b.automationId, made.contactId);
  expect(second.state).toMatchObject({ chain: [a.automationId] });
  expect(await h.step(tenant, second.id)).toBe('ran');
  // B did not start A again, and said why; A has only the run the contact's event began.
  expect(await runsOf(tenant, a.automationId)).toHaveLength(1);
  expect(await stepsOf(tenant, second.id)).toEqual([
    {
      step_key: 'start_child',
      status: 'succeeded',
      output: { outcome: 'refused_loop' },
      explanation:
        'Starting "A" would loop back to an automation that led here, so it was refused.',
      error: null,
    },
  ]);
  expect(await h.run(tenant, second.id)).toMatchObject({
    status: 'running',
    current_step: 'after',
  });
});

it('refuses at run time an automation that starts itself', async () => {
  const tenant = await h.business();
  const own = await h.publish(tenant, child({ triggers: [created] }));
  await h.publish(tenant, parent('Pre-consultation', own.id), own.automationId);
  const made = await h.enrol(tenant);
  const run = await runOf(tenant, own.automationId, made.contactId);
  expect(await h.step(tenant, run.id)).toBe('ran');
  expect((await stepsOf(tenant, run.id))[0]?.output).toEqual({ outcome: 'refused_loop' });
  expect(await runsOf(tenant, own.automationId)).toHaveLength(1);
});

it('stops a chain of automations starting automations at ten deep', async () => {
  const tenant = await h.business();
  // Published from the far end, so each can name the next: twelve in a row.
  const chain: Published[] = [await h.publish(tenant, child({ name: 'Link 11' }))];
  for (let index = 10; index >= 0; index -= 1) {
    const [next] = chain;
    chain.unshift(
      await h.publish(tenant, {
        ...parent(`Link ${String(index)}`, next?.id ?? ''),
        triggers: [index === 0 ? created : unheard],
      }),
    );
  }
  const made = await h.enrol(tenant);
  for (const link of chain.slice(0, 10))
    await h.step(tenant, (await runOf(tenant, link.automationId, made.contactId)).id);
  // Ten runs, the tenth nine automations below the first; the eleventh was never started.
  const tenth = await runOf(tenant, chain[9]?.automationId ?? '', made.contactId);
  expect(tenth.state['chain']).toEqual(chain.slice(0, 9).map((link) => link.automationId));
  expect((await stepsOf(tenant, tenth.id))[0]).toMatchObject({
    output: { outcome: 'refused_loop' },
    explanation: 'Ten automations in a row have started one another, so "Link 10" was not started.',
  });
  expect(await runsOf(tenant, chain[10]?.automationId ?? '')).toEqual([]);
});

it("fails the step, and starts nothing, when the automation is another business's or gone", async () => {
  const tenant = await h.business();
  const other = await h.business();
  const theirs = await h.publish(other, child());
  const starter = await h.publish(tenant, parent('Consultation booked', theirs.id));
  const made = await h.enrol(tenant);
  const from = await runOf(tenant, starter.automationId, made.contactId);

  expect(await h.step(tenant, from.id)).toBe('ran');
  expect(await h.run(tenant, from.id)).toMatchObject({
    status: 'failed',
    exit_reason: 'unknown_reference',
  });
  expect(await stepsOf(tenant, from.id)).toEqual([
    {
      step_key: 'start_child',
      status: 'failed',
      output: {},
      explanation: `The automation.run step was refused: /config/automation: There's no automation "${theirs.id}".`,
      error: { code: 'unknown_reference' },
    },
  ]);
  expect(await runsOf(other, theirs.automationId)).toEqual([]);
  expect(await runsOf(tenant, theirs.automationId)).toEqual([]);
});

it('fails the step when what it names is not an automation id at all', async () => {
  const tenant = await h.business();
  const starter = await h.publish(tenant, parent('Consultation booked', 'A name never resolved'));
  const made = await h.enrol(tenant);
  const from = await runOf(tenant, starter.automationId, made.contactId);
  await h.step(tenant, from.id);
  expect(await h.run(tenant, from.id)).toMatchObject({
    status: 'failed',
    exit_reason: 'unknown_reference',
  });
});

it('pins the child to the version published when it was started', async () => {
  const { tenant, target, starter } = await scene();
  const early = await h.enrol(tenant, 'Early');
  await h.step(tenant, (await runOf(tenant, starter.automationId, early.contactId)).id);
  const before = await runOf(tenant, target.automationId, early.contactId);

  const republished = await h.publish(
    tenant,
    child({
      start: 'check',
      steps: {
        check: {
          type: 'condition',
          config: { if: { field: 'contact.firstName', operator: 'is_set' } },
        },
      },
    }),
    target.automationId,
  );
  expect(republished.versionId).not.toBe(target.versionId);

  // The run already going stays on the version it began with, and runs that version's step.
  await h.step(tenant, before.id);
  expect(await h.run(tenant, before.id)).toMatchObject({ status: 'waiting' });
  expect((await runOf(tenant, target.automationId, early.contactId)).version_id).toBe(
    target.versionId,
  );
  // A record started afterwards is on the new one.
  const late = await h.enrol(tenant, 'Late');
  await h.step(tenant, (await runOf(tenant, starter.automationId, late.contactId)).id);
  const after = await runOf(tenant, target.automationId, late.contactId);
  expect(after.version_id).toBe(republished.versionId);
  expect(after.current_step).toBe('check');
});

it('shows in the history which run started the child, and what the parent started', async () => {
  const { tenant, target, starter } = await scene();
  const made = await h.enrol(tenant);
  const from = await runOf(tenant, starter.automationId, made.contactId);
  await h.step(tenant, from.id);
  const started = await runOf(tenant, target.automationId, made.contactId);
  const parentRun = toPublicId('automation_enrolment', from.id);
  const childRun = toPublicId('automation_enrolment', started.id);

  const read = await withTenant(h.db, tenant, async (trx) => ({
    parent: await readRun(trx, parentRun),
    child: await readRun(trx, childRun),
    record: await readRecordRuns(trx, made.contact, {}),
  }));
  expect(read.parent.steps).toMatchObject([
    {
      step: 'start_child',
      type: 'automation.run',
      status: 'succeeded',
      output: { outcome: 'started', enrolmentId: childRun },
    },
  ]);
  expect(read.parent.startedBy ?? null).toBeNull();
  expect(read.parent.trigger).toEqual({ id: 'created', type: 'contact.created' });
  expect(read.child).toMatchObject({
    automationId: target.id,
    trigger: null,
    startedBy: { runId: parentRun, automationId: starter.id, step: 'start_child' },
  });
  expect(
    read.record.items.map((run) => [run.automationId, run.startedBy?.runId ?? null]).sort(),
  ).toEqual(
    [
      [starter.id, null],
      [target.id, parentRun],
    ].sort(),
  );
});
