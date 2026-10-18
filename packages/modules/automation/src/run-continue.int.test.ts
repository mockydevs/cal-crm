// Continuing a waiting run now, on real Postgres with the engine's own step command: a wait
// for a time wakes, a wait with branches takes the branch named, every other kind of
// waiting is refused, and the scheduler waking the same run at the same moment moves it on
// once.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { runStepCommand, startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { readRun } from './history.js';
import { createContinueRunCommand } from './run-continue.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const continueRun = createContinueRunCommand({
  actorNames: {
    user: (_trx, ids) => Promise.resolve(new Map(ids.map((id) => [id, 'Jane Doe']))),
  },
});
const unnamed = createContinueRunCommand();

/** A person of the business, acting with every permission. */
async function person(tenant: Tenant) {
  const user = await h.database.fixtures.user();
  return {
    context: {
      ...tenant,
      actorKind: 'user' as const,
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all' as const,
  };
}

const created = { id: 'created', type: 'contact.created', config: {} } as const;
const DAY = 86_400_000;
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const workflow = (steps: AutomationDocumentInput['steps'], start: string) =>
  ({ name: 'Waits', triggers: [created], start, steps }) satisfies AutomationDocumentInput;

/** A contact enrolled in the business's one automation and run until it waits or ends. */
async function waiting(tenant: Tenant, document: AutomationDocumentInput) {
  await h.publish(tenant, document);
  const enrolled = await h.enrol(tenant);
  const [enrolmentId] = enrolled.enrolments;
  if (enrolmentId === undefined) throw new Error('Nothing enrolled.');
  for (let visit = 0; visit < 10; visit++) {
    if ((await h.run(tenant, enrolmentId)).status !== 'running') break;
    await h.step(tenant, enrolmentId);
  }
  return { ...enrolled, enrolmentId, runId: toPublicId('automation_enrolment', enrolmentId) };
}

const rows = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      step_key: string;
      status: string;
      branch: string | null;
      explanation: string;
      output: Record<string, unknown>;
    }>(
      `select step_key, status, branch, explanation, output from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

const note = (text: string, next?: string) =>
  ({ type: 'note.create', config: { text }, ...(next === undefined ? {} : { next }) }) as const;

it('wakes a run from a wait for a time, and its history says who continued it', async () => {
  const tenant = await h.business();
  const jane = await person(tenant);
  const run = await waiting(
    tenant,
    workflow(
      {
        pause: { type: 'wait', config: { duration: 'P3D' }, next: 'after' },
        after: note('Three days later'),
      },
      'pause',
    ),
  );
  const before = await withTenant(h.db, tenant, (trx) => readRun(trx, run.runId));
  expect(before).toMatchObject({
    status: 'waiting',
    revision: '1',
    continuable: { branches: [] },
    currentAction: { step: 'pause', type: 'wait' },
  });
  // A wait for a time has no branch to name.
  await expect(
    runCommand(h.services, continueRun, { runId: run.runId, branch: 'timed_out' }, jane),
  ).rejects.toMatchObject({ name: 'ValidationError', issues: [{ code: 'no_branches' }] });

  const continued = await runCommand(
    h.services,
    continueRun,
    { runId: run.runId, revision: before.revision },
    jane,
  );
  expect(continued.status).toBe('waiting');
  expect(new Date(continued.wakeAt ?? 0).getTime()).toBeLessThanOrEqual(Date.now());
  expect(continued.steps[0]?.explanation).toMatch(
    /^Waiting 3 days, until .+\. Continued by Jane Doe at .+, before the wait was over\.$/,
  );
  expect(continued.steps[0]?.output).toMatchObject({ continuedBy: 'Jane Doe' });

  // The step job the command queued runs now, three days early.
  expect(await h.step(tenant, run.enrolmentId)).toBe('ran');
  expect((await h.run(tenant, run.enrolmentId)).status).toBe('completed');
  expect((await rows(tenant, run.enrolmentId)).map((row) => [row.step_key, row.status])).toEqual([
    ['pause', 'succeeded'],
    ['after', 'succeeded'],
  ]);
  expect(await h.events(tenant, 'automation.run.continued')).toMatchObject([
    { subject_id: run.enrolmentId, payload: { step: 'pause' } },
  ]);
  // The audit log names the person, the run and that no branch was chosen.
  const [audit] = await h.database.as('postgres', (sql) =>
    sql.query<{ actor_id: string; input: unknown }>(
      `select actor_id, input from audit.commands
       where business_id = $1 and command = 'automation.continue_run' and outcome = 'ok'`,
      [tenant.businessId],
    ),
  );
  expect(audit).toMatchObject({
    actor_id: jane.context.actorId,
    input: { runId: run.runId, branch: null },
  });
  // It is over: there is nothing left to continue.
  await expect(
    runCommand(h.services, continueRun, { runId: run.runId }, jane),
  ).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'Only a run that is waiting can be continued; this one is completed.',
  });
});

it('wakes a run from a wait until a date, whatever its resume window', async () => {
  const tenant = await h.business();
  // A window open only on the day after tomorrow: closed now, whenever now is.
  const closed = {
    days: [WEEKDAYS[new Date(Date.now() + 2 * DAY).getUTCDay()] ?? 'monday'],
    start: '09:00',
    end: '10:00',
  };
  const run = await waiting(
    tenant,
    workflow(
      {
        until: {
          type: 'wait.until',
          config: { at: new Date(Date.now() + 30 * DAY).toISOString(), resumeWindow: closed },
          next: 'after',
        },
        after: note('On the day'),
      },
      'until',
    ),
  );
  await runCommand(h.services, unnamed, { runId: run.runId }, await person(tenant));
  await h.step(tenant, run.enrolmentId);
  expect((await h.run(tenant, run.enrolmentId)).status).toBe('completed');
  // Without a lookup of names, the history says what kind of actor continued it.
  expect((await rows(tenant, run.enrolmentId))[0]?.explanation).toContain(
    'Continued by a team member at ',
  );
});

it('takes the branch named out of a wait for an event, and asks for one', async () => {
  const tenant = await h.business();
  const jane = await person(tenant);
  const document = workflow(
    {
      reply: {
        type: 'wait.event',
        config: { event: 'message.received', timeout: 'P7D' },
        next: { received: 'thanks', timed_out: 'nudge' },
      },
      thanks: note('They replied'),
      nudge: note('No reply'),
    },
    'reply',
  );
  const run = await waiting(tenant, document);
  expect(await withTenant(h.db, tenant, (trx) => readRun(trx, run.runId))).toMatchObject({
    status: 'waiting',
    continuable: { branches: ['received', 'timed_out'] },
  });
  await expect(
    runCommand(h.services, continueRun, { runId: run.runId }, jane),
  ).rejects.toMatchObject({
    name: 'ValidationError',
    issues: [
      {
        path: '/branch',
        code: 'required',
        message: 'Say which branch the run takes: received, timed_out.',
      },
    ],
  });
  await expect(
    runCommand(h.services, continueRun, { runId: run.runId, branch: 'met' }, jane),
  ).rejects.toMatchObject({ name: 'ValidationError', issues: [{ code: 'unknown_branch' }] });
  // Nothing of a refused attempt is kept.
  expect((await h.run(tenant, run.enrolmentId)).wake_at?.getTime()).toBeGreaterThan(
    Date.now() + 6 * DAY,
  );

  await runCommand(h.services, continueRun, { runId: run.runId, branch: 'timed_out' }, jane);
  // It listens for the reply no more.
  expect(
    await h.database.withTenant(tenant, (sql) =>
      sql.query(`select 1 from automation.event_waits where enrolment_id = $1 and kind = 'event'`, [
        run.enrolmentId,
      ]),
    ),
  ).toEqual([]);
  await h.step(tenant, run.enrolmentId);
  await h.step(tenant, run.enrolmentId);
  expect((await h.run(tenant, run.enrolmentId)).status).toBe('completed');
  expect(
    (await rows(tenant, run.enrolmentId)).map((row) => [
      row.step_key,
      row.status,
      row.branch,
      row.explanation,
    ]),
  ).toEqual([
    ['reply', 'succeeded', null, expect.stringContaining('Waiting for message.received until')],
    [
      'reply',
      'succeeded',
      'timed_out',
      'Continued by Jane Doe: the timed_out branch was taken before the wait was over.',
    ],
    ['nudge', 'succeeded', null, 'The note was created.'],
  ]);
  expect((await rows(tenant, run.enrolmentId))[1]?.output).toMatchObject({
    continuedBy: 'Jane Doe',
  });
  expect(await h.events(tenant, 'automation.run.continued')).toMatchObject([
    { payload: { step: 'reply', branch: 'timed_out' } },
  ]);

  // The other branch, for another contact of the same automation.
  const other = await h.enrol(tenant);
  const [second] = other.enrolments;
  if (second === undefined) throw new Error('Nothing enrolled.');
  await h.step(tenant, second);
  await runCommand(
    h.services,
    continueRun,
    { runId: toPublicId('automation_enrolment', second), branch: 'received' },
    jane,
  );
  await h.step(tenant, second);
  await h.step(tenant, second);
  expect((await rows(tenant, second)).map((row) => row.step_key)).toEqual([
    'reply',
    'reply',
    'thanks',
  ]);
});

it('takes the branch named out of a wait for a condition, though its resume window is closed', async () => {
  const tenant = await h.business();
  const closed = {
    days: [WEEKDAYS[new Date(Date.now() + 2 * DAY).getUTCDay()] ?? 'monday'],
    start: '09:00',
    end: '10:00',
  };
  const run = await waiting(
    tenant,
    workflow(
      {
        named: {
          type: 'wait.condition',
          config: {
            if: { field: 'contact.lastName', operator: 'is_set' },
            timeout: 'P7D',
            resumeWindow: closed,
          },
          next: { met: 'known', timed_out: 'unknown' },
        },
        known: note('We know their name'),
        unknown: note('Still no name'),
      },
      'named',
    ),
  );
  await runCommand(
    h.services,
    continueRun,
    { runId: run.runId, branch: 'met' },
    await person(tenant),
  );
  await h.step(tenant, run.enrolmentId);
  await h.step(tenant, run.enrolmentId);
  expect((await h.run(tenant, run.enrolmentId)).status).toBe('completed');
  expect((await rows(tenant, run.enrolmentId)).map((row) => [row.step_key, row.branch])).toEqual([
    ['named', null],
    ['named', 'met'],
    ['known', null],
  ]);
});

it('refuses a run that is not in a wait a person can end, and a run that has moved on', async () => {
  const tenant = await h.business();
  const jane = await person(tenant);
  // A step waiting to be tried again: the CRM refuses a value for an archived field.
  await h.publish(
    tenant,
    workflow(
      {
        rename: {
          type: 'contact.update',
          config: { fields: { 'contact.custom.nickname': 'Grace' } },
          retry: { times: 2, wait: 'PT10M' },
        },
      },
      'rename',
    ),
  );
  const enrolled = await h.enrol(tenant);
  const [retrying] = enrolled.enrolments;
  if (retrying === undefined) throw new Error('Nothing enrolled.');
  await h.database.as('postgres', (sql) =>
    sql.query(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, created_by_kind, archived_at)
       select c.business_id, t.id, 'nickname', 'Nickname', 'test', 'text', 'system', now()
       from crm.contacts c join crm.object_types t on t.business_id = c.business_id and t.kind = 'contact'
       where c.id = $1`,
      [enrolled.contactId],
    ),
  );
  await h.step(tenant, retrying);
  const retryingId = toPublicId('automation_enrolment', retrying);
  expect(await withTenant(h.db, tenant, (trx) => readRun(trx, retryingId))).toMatchObject({
    status: 'waiting',
    continuable: null,
  });
  await expect(
    runCommand(h.services, continueRun, { runId: retryingId }, jane),
  ).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'This run is waiting to try a step again, not waiting in a wait step.',
  });

  // A goal step that waits goes on when its goal is met.
  const goalTenant = await h.business();
  const goal = await waiting(
    goalTenant,
    workflow(
      {
        booked: {
          type: 'goal',
          config: { events: [{ type: 'appointment.booked', config: {} }], otherwise: 'wait' },
        },
      },
      'booked',
    ),
  );
  await expect(
    runCommand(h.services, continueRun, { runId: goal.runId }, await person(goalTenant)),
  ).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'This run is waiting at its goal step, which goes on when the goal is met.',
  });

  // A run that is running, a revision that has passed, and another business's run.
  const moving = await h.business();
  const mover = await person(moving);
  await h.publish(
    moving,
    workflow({ pause: { type: 'wait', config: { duration: 'PT1H' } } }, 'pause'),
  );
  const started = await h.enrol(moving);
  const [fresh] = started.enrolments;
  if (fresh === undefined) throw new Error('Nothing enrolled.');
  const runId = toPublicId('automation_enrolment', fresh);
  await expect(runCommand(h.services, continueRun, { runId }, mover)).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'Only a run that is waiting can be continued; this one is running.',
  });
  await h.step(moving, fresh);
  await expect(
    runCommand(h.services, continueRun, { runId, revision: '0' }, mover),
  ).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'This run has moved on since it was read. Read it again before continuing it.',
  });
  await expect(runCommand(h.services, continueRun, { runId }, jane)).rejects.toMatchObject({
    name: 'NotFoundError',
  });
  await expect(
    runCommand(h.services, continueRun, { runId: 'run_nothing' }, mover),
  ).rejects.toMatchObject({ name: 'NotFoundError' });
  expect(await h.events(moving, 'automation.run.continued')).toEqual([]);
  // With the revision it has now, it is continued.
  await runCommand(h.services, continueRun, { runId, revision: '1' }, mover);
  await h.step(moving, fresh);
  expect((await h.run(moving, fresh)).status).toBe('completed');
});

it('moves a run on once when its timer fires at the moment it is continued', async () => {
  const tenant = await h.business();
  const jane = await person(tenant);
  await h.publish(
    tenant,
    workflow(
      {
        pause: { type: 'wait', config: { duration: 'PT1M' }, next: 'after' },
        after: note('Once only', 'rest'),
        rest: { type: 'wait', config: { duration: 'P1D' } },
      },
      'pause',
    ),
  );
  const runs: { enrolmentId: string; runId: string }[] = [];
  for (let index = 0; index < 8; index++) {
    const enrolled = await h.enrol(tenant, `Lead ${String(index)}`);
    const enrolmentId = enrolled.enrolments[0] ?? '';
    await h.step(tenant, enrolmentId);
    runs.push({ enrolmentId, runId: toPublicId('automation_enrolment', enrolmentId) });
  }
  const later = new Date(Date.now() + 2 * 60_000).toISOString();
  // For each run, the timer's own job and a person's continue, started together.
  const outcomes = await Promise.all(
    runs.map(async (run) => {
      const [timer, continued] = await Promise.allSettled([
        runCommand(
          h.services,
          runStepCommand,
          { enrolmentId: run.enrolmentId, sequence: 1, now: later },
          { context: { ...tenant, correlationId: randomUUID() }, permissions: 'all' as const },
        ),
        runCommand(h.services, continueRun, { runId: run.runId, revision: '1' }, jane),
      ]);
      return { timer, continued };
    }),
  );
  for (const [index, run] of runs.entries()) {
    const outcome = outcomes[index];
    // The timer's job ran its step whoever came first; a continue that came second found
    // the run moved on, and one that came first only woke a run the job then moved.
    expect(outcome?.timer).toEqual({ status: 'fulfilled', value: 'ran' });
    if (outcome?.continued.status === 'rejected')
      expect(outcome.continued.reason).toMatchObject({ name: 'ConflictError' });
    // Whatever is left queued runs: nothing of it repeats a step.
    for (let visit = 0; visit < 4; visit++) {
      if ((await h.run(tenant, run.enrolmentId)).status !== 'running') break;
      await h.step(tenant, run.enrolmentId);
    }
    expect((await rows(tenant, run.enrolmentId)).map((row) => row.step_key)).toEqual([
      'pause',
      'after',
      'rest',
    ]);
  }
  const notes = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ notes: number }>('select count(*)::int as notes from crm.notes'),
  );
  expect(notes).toEqual([{ notes: runs.length }]);
});

it('says what a run waits for when it is not a wait a person ends', async () => {
  const tenant = await h.business();
  const jane = await person(tenant);
  // A run as the engine leaves one that waits at each kind of step: the waiting row names
  // the step, and the step's type says what the run waits for.
  const run = await waiting(
    tenant,
    workflow(
      {
        pause: { type: 'wait', config: { duration: 'P1D' }, next: 'call' },
        call: { type: 'manual.call', config: {}, next: 'hook' },
        hook: { type: 'webhook.call', config: { url: 'https://example.com/hook' }, next: 'mail' },
        mail: { type: 'email.send', config: { subject: 'Hello', body: 'Hello' }, next: 'text' },
        text: { type: 'sms.send', config: { message: 'Hello' }, next: 'tagged' },
        tagged: { type: 'tag.add', config: { tag: 'VIP' } },
      },
      'pause',
    ),
  );
  const waitsAt = (step: string) =>
    h.database.as('postgres', (sql) =>
      sql.query(
        `update automation.step_runs set step_key = $2 where enrolment_id = $1 and status = 'waiting'`,
        [run.enrolmentId, step],
      ),
    );
  for (const [step, words] of [
    [
      'call',
      'This run is waiting for a person to complete a manual action. Complete or skip it in Manual Actions instead.',
    ],
    ['hook', 'This run is waiting for a webhook to be delivered, which has its own attempts.'],
    [
      'mail',
      'This run is holding a message until it may be sent (the sending window, or a retry), not waiting in a wait step.',
    ],
    [
      'text',
      'This run is holding a message until it may be sent (the sending window, or a retry), not waiting in a wait step.',
    ],
    ['tagged', 'This run is waiting to try a step again, not waiting in a wait step.'],
    ['gone', 'This run is not waiting at a step that can be continued.'],
  ] as const) {
    await waitsAt(step);
    await expect(
      runCommand(h.services, continueRun, { runId: run.runId }, jane),
      step,
    ).rejects.toMatchObject({ name: 'ConflictError', message: words });
  }
  // A wait with branches whose run keeps nothing of the wait cannot be given a branch.
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update automation.versions set document = jsonb_set(document, '{steps,pause}',
         '{"type": "wait.event", "config": {"event": "message.received", "timeout": "P1D"}}')
       where id = (select version_id from automation.enrolments where id = $1)`,
      [run.enrolmentId],
    ),
  );
  await waitsAt('pause');
  await expect(
    runCommand(h.services, continueRun, { runId: run.runId, branch: 'received' }, jane),
  ).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'This run is not waiting at a step that can be continued.',
  });
  expect(await h.events(tenant, 'automation.run.continued')).toEqual([]);
});

it('lets a branch the wait had decided, and held for its window, go at once', async () => {
  const tenant = await h.business();
  // A window open only on the day after tomorrow: closed now, whenever now is.
  const closed = {
    days: [WEEKDAYS[new Date(Date.now() + 2 * DAY).getUTCDay()] ?? 'monday'],
    start: '09:00',
    end: '10:00',
  };
  const run = await waiting(
    tenant,
    workflow(
      {
        named: {
          type: 'wait.condition',
          // It holds on arrival, and the closed window holds the decision back.
          config: {
            if: { field: 'contact.firstName', operator: 'is_set' },
            timeout: 'P7D',
            resumeWindow: closed,
          },
          next: { met: 'known', timed_out: 'unknown' },
        },
        known: note('We know their name'),
        unknown: note('Still no name'),
      },
      'named',
    ),
  );
  expect((await h.run(tenant, run.enrolmentId)).status).toBe('waiting');
  // No branch is named: the one the wait decided is the one it takes.
  await runCommand(h.services, continueRun, { runId: run.runId }, await person(tenant));
  await h.step(tenant, run.enrolmentId);
  await h.step(tenant, run.enrolmentId);
  expect((await h.run(tenant, run.enrolmentId)).status).toBe('completed');
  expect((await rows(tenant, run.enrolmentId)).map((row) => [row.step_key, row.branch])).toEqual([
    ['named', null],
    ['named', 'met'],
    ['known', null],
  ]);
});
