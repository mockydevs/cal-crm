// Removing a record from automations by a step: the runs it names end as exited with who
// removed them, listen for nothing more, and no step of theirs runs afterwards; every other
// run, and every other contact, is left exactly as it was. Real Postgres, the engine's own
// commands, and real events.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  runStepCommand,
  startHarness,
  type Harness,
  type Published,
  type Tenant,
} from '../test/workflows.js';
import { readAutomationStats } from './stats.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const DAY = 86_400_000;
const created = { id: 'created', type: 'contact.created', config: {} } as const;
const unheard = { id: 'tagged', type: 'tag.added', config: { tag: 'never' } } as const;

type RemoveConfig =
  | { from: 'current' }
  | { from: 'automations'; automations: string[] }
  | { from: 'all_others'; except?: string[] }
  | { from: 'all'; except?: string[] };

/** Waits two days at its first step: a sales sequence between two messages. */
const sales = (name: string): AutomationDocumentInput => ({
  name,
  triggers: [created],
  start: 'pause',
  steps: {
    pause: { type: 'wait', config: { duration: 'P2D' }, next: 'settle' },
    settle: { type: 'wait', config: { duration: 'PT1M' } },
  },
});

/** Waits for a reply for a week, and stops when the contact is tagged. */
const listening: AutomationDocumentInput = {
  name: 'Photo and video sales',
  triggers: [created],
  stopWhen: [{ event: 'tag.added' }],
  start: 'reply',
  steps: {
    reply: {
      type: 'wait.event',
      config: { event: 'message.received', timeout: 'P7D' },
      next: { received: 'settle', timed_out: 'settle' },
    },
    settle: { type: 'wait', config: { duration: 'PT1M' } },
  },
};

const education: AutomationDocumentInput = {
  name: 'Education',
  triggers: [created],
  start: 'lesson',
  steps: {
    lesson: { type: 'wait', config: { duration: 'P3D' }, next: 'next_lesson' },
    next_lesson: { type: 'wait', config: { duration: 'P3D' } },
  },
};

/** Removes, then goes on to a short wait: what it reaches shows whether it went on. */
const remover = (name: string, config: RemoveConfig): AutomationDocumentInput => ({
  name,
  triggers: [created],
  start: 'clear',
  steps: {
    clear: { type: 'automation.remove', config, next: 'after' },
    after: { type: 'wait', config: { duration: 'PT1M' } },
  },
});

interface RunRow {
  id: string;
  automation_id: string;
  status: string;
  exit_reason: string | null;
  current_step: string | null;
  wake_at: Date | null;
  finished: boolean;
}

/** A contact's run in each automation, by the automation's stored id. */
async function runsFor(tenant: Tenant, contactId: string): Promise<Map<string, RunRow>> {
  const rows = await h.database.withTenant(tenant, (sql) =>
    sql.query<RunRow>(
      `select id, automation_id, status, exit_reason, current_step, wake_at,
              finished_at is not null as finished
       from automation.enrolments where record_id = $1 order by id`,
      [contactId],
    ),
  );
  return new Map(rows.map((row) => [row.automation_id, row]));
}

const stepsOf = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ step_key: string; status: string; output: Record<string, unknown> }>(
      `select step_key, status, output from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

const waitsOf = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ kind: string }>(
      'select kind from automation.event_waits where enrolment_id = $1 order by kind',
      [enrolmentId],
    ),
  );

const stopped = async (tenant: Tenant) =>
  (await h.events(tenant, 'automation.run.stopped')).map((event) => [
    event.subject_id,
    event.payload,
  ]);

/**
 * A business with two sales sequences, an education sequence and a remover, and a contact
 * in all four: the three sequences each waiting at their first step, the remover not yet run.
 */
async function scene(config: (ids: Record<'dj' | 'photo' | 'education', string>) => RemoveConfig) {
  const tenant = await h.business();
  const dj = await h.publish(tenant, sales('DJ sales'));
  const photo = await h.publish(tenant, listening);
  const lessons = await h.publish(tenant, education);
  const booked = await h.publish(
    tenant,
    remover('Consultation booked', config({ dj: dj.id, photo: photo.id, education: lessons.id })),
  );
  const enter = async (firstName: string) => {
    const made = await h.enrol(tenant, firstName);
    const runs = await runsFor(tenant, made.contactId);
    const of = (published: Published): RunRow => {
      const run = runs.get(published.automationId);
      if (run === undefined) throw new Error(`No run in ${published.id}.`);
      return run;
    };
    for (const each of [dj, photo, lessons]) expect(await h.step(tenant, of(each).id)).toBe('ran');
    return { ...made, dj: of(dj), photo: of(photo), education: of(lessons), booked: of(booked) };
  };
  const now = async (contactId: string) => {
    const runs = await runsFor(tenant, contactId);
    const of = (published: Published): RunRow => {
      const run = runs.get(published.automationId);
      if (run === undefined) throw new Error(`No run in ${published.id}.`);
      return run;
    };
    return { dj: of(dj), photo: of(photo), education: of(lessons), booked: of(booked) };
  };
  return { tenant, dj, photo, lessons, booked, enter, now, reason: `removed:${booked.id}` };
}

const exited = (reason: string) => ({
  status: 'exited',
  exit_reason: reason,
  current_step: null,
  wake_at: null,
  finished: true,
});

it('removes the record from the automations it names, and from no other', async () => {
  const s = await scene((ids) => ({ from: 'automations', automations: [ids.dj] }));
  const ada = await s.enter('Ada');
  const grace = await s.enter('Grace');
  const before = await s.now(ada.contactId);
  const others = await s.now(grace.contactId);
  expect(before.dj).toMatchObject({ status: 'waiting', current_step: 'settle' });

  expect(await h.step(s.tenant, ada.booked.id)).toBe('ran');
  const after = await s.now(ada.contactId);
  expect(after.dj).toMatchObject(exited(s.reason));
  // The wait it was in never came to its end, and the statistics count it so.
  expect(await stepsOf(s.tenant, ada.dj.id)).toEqual([
    { step_key: 'pause', status: 'skipped', output: expect.any(Object) as unknown },
  ]);
  // The other sequences are exactly as they were, to the wake time.
  expect(after.photo).toEqual(before.photo);
  expect(after.education).toEqual(before.education);
  // The remover says how many it removed, and goes on.
  expect(await stepsOf(s.tenant, ada.booked.id)).toEqual([
    { step_key: 'clear', status: 'succeeded', output: { removed: 1 } },
  ]);
  expect(after.booked).toMatchObject({ status: 'running', current_step: 'after' });
  // Once, on the contact's timeline, as a stop condition tells of a run it ended.
  expect(await stopped(s.tenant)).toEqual([
    [ada.dj.id, { automationId: s.dj.id, reason: s.reason }],
  ]);
  // Another contact in the same automations is untouched.
  expect(await s.now(grace.contactId)).toEqual(others);
  expect(await h.differences()).toEqual([]);
});

it('removes from every other automation but the ones it excepts, leaving their waits unchanged', async () => {
  const s = await scene((ids) => ({ from: 'all_others', except: [ids.education] }));
  const ada = await s.enter('Ada');
  const before = await s.now(ada.contactId);
  // The listening sequence holds a wait for the reply and one for its stop condition.
  expect(await waitsOf(s.tenant, ada.photo.id)).toEqual([{ kind: 'event' }, { kind: 'stop' }]);

  expect(await h.step(s.tenant, ada.booked.id)).toBe('ran');
  const after = await s.now(ada.contactId);
  expect(after.dj).toMatchObject(exited(s.reason));
  expect(after.photo).toMatchObject(exited(s.reason));
  expect(await waitsOf(s.tenant, ada.photo.id)).toEqual([]);
  expect(await stepsOf(s.tenant, ada.photo.id)).toMatchObject([
    { step_key: 'reply', status: 'skipped' },
  ]);
  // Education is still running, and wakes when it was going to.
  expect(after.education).toEqual(before.education);
  expect(before.education).toMatchObject({ status: 'waiting', current_step: 'next_lesson' });
  expect(before.education.wake_at).toBeInstanceOf(Date);
  // The remover itself is not one of "the others".
  expect(after.booked).toMatchObject({ status: 'running', current_step: 'after' });
  expect((await stepsOf(s.tenant, ada.booked.id))[0]?.output).toEqual({ removed: 2 });
  expect((await stopped(s.tenant)).map(([run]) => run).sort()).toEqual(
    [ada.dj.id, ada.photo.id].sort(),
  );

  // Education goes on as if nothing happened: its wake runs its next step.
  const wake = new Date((before.education.wake_at?.getTime() ?? 0) + 1000);
  expect(await h.step(s.tenant, ada.education.id, wake)).toBe('ran');
  expect((await s.now(ada.contactId)).education).toMatchObject({ status: 'waiting' });
  expect(await h.differences()).toEqual([]);
});

it('removes from every other automation when nothing is excepted', async () => {
  const s = await scene(() => ({ from: 'all_others' }));
  const ada = await s.enter('Ada');
  await h.step(s.tenant, ada.booked.id);
  const after = await s.now(ada.contactId);
  expect([after.dj.status, after.photo.status, after.education.status]).toEqual([
    'exited',
    'exited',
    'exited',
  ]);
  expect(after.booked).toMatchObject({ status: 'running', current_step: 'after' });
  expect((await stepsOf(s.tenant, ada.booked.id))[0]?.output).toEqual({ removed: 3 });
});

it('removes from all automations, its own run too, and no later step of it runs', async () => {
  const s = await scene((ids) => ({ from: 'all', except: [ids.education] }));
  const ada = await s.enter('Ada');
  const before = await s.now(ada.contactId);

  expect(await h.step(s.tenant, ada.booked.id)).toBe('ran');
  const after = await s.now(ada.contactId);
  expect(after.dj).toMatchObject(exited(s.reason));
  expect(after.photo).toMatchObject(exited(s.reason));
  expect(after.booked).toMatchObject(exited(s.reason));
  expect(after.education).toEqual(before.education);
  // The step that removed is on record as done; the step after it never ran.
  expect(await stepsOf(s.tenant, ada.booked.id)).toEqual([
    { step_key: 'clear', status: 'succeeded', output: { removed: 3 } },
  ]);
  expect(await h.run(s.tenant, ada.booked.id)).toMatchObject({ sequence: 1 });
  expect(await h.step(s.tenant, ada.booked.id)).toBe('skipped');
  expect(await stepsOf(s.tenant, ada.booked.id)).toHaveLength(1);
  expect((await stopped(s.tenant)).map(([run]) => run).sort()).toEqual(
    [ada.dj.id, ada.photo.id, ada.booked.id].sort(),
  );
  expect(await h.events(s.tenant, 'automation.run.completed')).toEqual([]);
  expect(await h.differences()).toEqual([]);
});

it('keeps its own run when all are removed but its own automation is excepted', async () => {
  const tenant = await h.business();
  const dj = await h.publish(tenant, sales('DJ sales'));
  // Its own id is known only once it exists, so its first version removes nothing by name.
  const own = await h.publish(tenant, remover('Consultation booked', { from: 'current' }));
  await h.publish(
    tenant,
    remover('Consultation booked', { from: 'all', except: [own.id] }),
    own.automationId,
  );
  const made = await h.enrol(tenant);
  const runs = await runsFor(tenant, made.contactId);
  await h.step(tenant, runs.get(own.automationId)?.id ?? '');
  const after = await runsFor(tenant, made.contactId);
  expect(after.get(dj.automationId)).toMatchObject({ status: 'exited' });
  expect(after.get(own.automationId)).toMatchObject({ status: 'running', current_step: 'after' });
});

it('removes only its own run from the current automation', async () => {
  const s = await scene(() => ({ from: 'current' }));
  const ada = await s.enter('Ada');
  const before = await s.now(ada.contactId);

  expect(await h.step(s.tenant, ada.booked.id)).toBe('ran');
  const after = await s.now(ada.contactId);
  expect(after.booked).toMatchObject(exited(s.reason));
  expect(after.dj).toEqual(before.dj);
  expect(after.photo).toEqual(before.photo);
  expect(after.education).toEqual(before.education);
  expect(await stepsOf(s.tenant, ada.booked.id)).toEqual([
    { step_key: 'clear', status: 'succeeded', output: { removed: 1 } },
  ]);
  expect(await stopped(s.tenant)).toEqual([
    [ada.booked.id, { automationId: s.booked.id, reason: s.reason }],
  ]);
  expect(await h.step(s.tenant, ada.booked.id)).toBe('skipped');
});

it('ends its own run when the automations it names include its own', async () => {
  const tenant = await h.business();
  const own = await h.publish(tenant, remover('Consultation booked', { from: 'current' }));
  await h.publish(
    tenant,
    remover('Consultation booked', { from: 'automations', automations: [own.id] }),
    own.automationId,
  );
  const made = await h.enrol(tenant);
  const [run = ''] = made.enrolments;
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'exited',
    exit_reason: `removed:${own.id}`,
  });
});

it('removes nothing, and goes on, when the record is in none of the automations named', async () => {
  const tenant = await h.business();
  const elsewhere = await h.publish(tenant, { ...sales('DJ sales'), triggers: [unheard] });
  const own = await h.publish(
    tenant,
    remover('Consultation booked', { from: 'automations', automations: [elsewhere.id] }),
  );
  const made = await h.enrol(tenant);
  const run = (await runsFor(tenant, made.contactId)).get(own.automationId)?.id ?? '';
  expect(await h.step(tenant, run)).toBe('ran');
  expect(await stepsOf(tenant, run)).toEqual([
    { step_key: 'clear', status: 'succeeded', output: { removed: 0 } },
  ]);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'after' });
  expect(await stopped(tenant)).toEqual([]);
  // The trace says why nothing was removed, for whoever reads the run.
  const [said] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ explanation: string }>(
      'select explanation from automation.step_runs where enrolment_id = $1',
      [run],
    ),
  );
  expect(said?.explanation).toBe(
    'Removed nothing: no run of the chosen automations was still going for this record.',
  );
});

it('says why when it removed nothing from every other automation', async () => {
  const tenant = await h.business();
  const own = await h.publish(tenant, remover('Consultation booked', { from: 'all_others' }));
  const made = await h.enrol(tenant);
  const run = (await runsFor(tenant, made.contactId)).get(own.automationId)?.id ?? '';
  await h.step(tenant, run);
  const [said] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ explanation: string; output: unknown }>(
      'select explanation, output from automation.step_runs where enrolment_id = $1',
      [run],
    ),
  );
  expect(said).toEqual({
    output: { removed: 0 },
    explanation: 'Removed nothing: no run of another automation was still going for this record.',
  });
});

it('closes the manual action a removed run was waiting on', async () => {
  const tenant = await h.business();
  const calls = await h.publish(tenant, {
    name: 'Call new leads',
    triggers: [created],
    start: 'call',
    steps: {
      call: { type: 'manual.call', config: { notes: 'Ask about the date' }, next: 'after' },
      after: { type: 'wait', config: { duration: 'PT1M' } },
    },
  });
  const own = await h.publish(tenant, remover('Consultation booked', { from: 'all_others' }));
  // A contact with a number to call, enrolled by its own event as every contact here is.
  await runCommand(
    h.services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`], phones: ['+12025550147'] },
    { context: { ...tenant, correlationId: randomUUID() }, permissions: 'all' },
  );
  const [event] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; subject_id: string }>(
      "select id, subject_id from events.events where type = 'contact.created'",
    ),
  );
  await h.match(tenant, event?.id ?? '');
  const runs = await runsFor(tenant, event?.subject_id ?? '');
  const calling = runs.get(calls.automationId)?.id ?? '';
  expect(await h.step(tenant, calling)).toBe('ran');
  const actions = () =>
    h.database.withTenant(tenant, (sql) =>
      sql.query<{ status: string }>('select status from automation.manual_actions'),
    );
  expect(await actions()).toEqual([{ status: 'pending' }]);

  await h.step(tenant, runs.get(own.automationId)?.id ?? '');
  expect(await h.run(tenant, calling)).toMatchObject({
    status: 'exited',
    exit_reason: `removed:${own.id}`,
  });
  expect(await actions()).toEqual([{ status: 'cancelled' }]);
  expect(await stepsOf(tenant, calling)).toMatchObject([{ step_key: 'call', status: 'skipped' }]);
  expect(await h.differences()).toEqual([]);
});

it('leaves a queued job of a removed run with nothing to do, however late it runs', async () => {
  const s = await scene((ids) => ({ from: 'automations', automations: [ids.dj, ids.photo] }));
  const ada = await s.enter('Ada');
  const jobs = (enrolmentId: string) =>
    h.database.as('crm_owner', (sql) =>
      sql.query(
        "select 1 from graphile_worker.jobs where key = 'automation-enrolment:' || $1::text",
        [enrolmentId],
      ),
    );
  // Its wake is queued, and stays queued: removing a run does not reach into the queue.
  expect(await jobs(ada.dj.id)).toHaveLength(1);
  await h.step(s.tenant, ada.booked.id);
  const count = (await h.steps(s.tenant)).length;

  const later = new Date(Date.now() + 30 * DAY);
  expect(await h.step(s.tenant, ada.dj.id, later)).toBe('skipped');
  expect(await h.step(s.tenant, ada.photo.id, later)).toBe('skipped');
  expect(
    await runCommand(
      h.services,
      runStepCommand,
      { enrolmentId: ada.dj.id, sequence: 1, now: later.toISOString() },
      { context: { ...s.tenant, correlationId: randomUUID() }, permissions: 'all' },
    ),
  ).toBe('skipped');
  expect((await h.steps(s.tenant)).length).toBe(count);
  expect((await s.now(ada.contactId)).dj).toMatchObject(exited(s.reason));
});

it('ends a run for good when its wake and its removal come at the same moment', async () => {
  const s = await scene((ids) => ({ from: 'automations', automations: [ids.dj] }));
  for (let round = 0; round < 6; round += 1) {
    const racer = await s.enter(`Racer ${String(round)}`);
    const wake = new Date((await s.now(racer.contactId)).dj.wake_at?.getTime() ?? 0);
    const [woke, removed] = await Promise.all([
      h.step(s.tenant, racer.dj.id, new Date(wake.getTime() + 1000)),
      h.step(s.tenant, racer.booked.id),
    ]);
    // Whichever came first, the remover ran and the sales run is over.
    expect(removed).toBe('ran');
    expect(['ran', 'skipped']).toContain(woke);
    const after = await s.now(racer.contactId);
    expect(after.dj).toMatchObject(exited(s.reason));
    expect((await stepsOf(s.tenant, racer.booked.id))[0]?.output).toEqual({ removed: 1 });
    // Nothing of it runs afterwards.
    expect(await h.step(s.tenant, racer.dj.id, new Date(wake.getTime() + 30 * DAY))).toBe(
      'skipped',
    );
  }
  expect(await h.differences()).toEqual([]);
});

it('lets one of two runs that remove each other win, without either failing', async () => {
  const tenant = await h.business();
  const first = await h.publish(tenant, remover('First', { from: 'all_others' }));
  const second = await h.publish(tenant, remover('Second', { from: 'all_others' }));
  const bystander = await h.publish(tenant, education);
  for (let round = 0; round < 8; round += 1) {
    const made = await h.enrol(tenant, `Racer ${String(round)}`);
    const runs = await runsFor(tenant, made.contactId);
    const one = runs.get(first.automationId)?.id ?? '';
    const two = runs.get(second.automationId)?.id ?? '';
    // Neither is ended by a deadlock: both jobs return, and exactly one of them ran.
    const results = await Promise.all([h.step(tenant, one), h.step(tenant, two)]);
    expect([...results].sort()).toEqual(['ran', 'skipped']);
    const after = await runsFor(tenant, made.contactId);
    const winner = results[0] === 'ran' ? first : second;
    const loser = results[0] === 'ran' ? second : first;
    expect(after.get(winner.automationId)).toMatchObject({
      status: 'running',
      current_step: 'after',
    });
    expect(after.get(loser.automationId)).toMatchObject(exited(`removed:${winner.id}`));
    expect(after.get(bystander.automationId)).toMatchObject(exited(`removed:${winner.id}`));
  }
  expect(await h.differences()).toEqual([]);
});

it('removes a run of a paused automation, which would otherwise have gone on', async () => {
  const s = await scene((ids) => ({ from: 'automations', automations: [ids.dj] }));
  const ada = await s.enter('Ada');
  await h.database.withTenant(s.tenant, (sql) =>
    sql.query("update automation.automations set status = 'paused' where id = $1", [
      s.dj.automationId,
    ]),
  );
  await h.step(s.tenant, ada.booked.id);
  expect((await s.now(ada.contactId)).dj).toMatchObject(exited(s.reason));
});

it('keeps the statistics true: a removed run counts as exited, its wait as skipped', async () => {
  const s = await scene((ids) => ({ from: 'all', except: [ids.education] }));
  const ada = await s.enter('Ada');
  await s.enter('Grace');
  await h.step(s.tenant, ada.booked.id);
  const stats = await withTenant(h.db, s.tenant, async (trx) => ({
    dj: await readAutomationStats(trx, s.dj.id),
    booked: await readAutomationStats(trx, s.booked.id),
  }));
  expect(stats.dj.runs.allTime).toMatchObject({ enrolled: 2, exited: 1, active: 1 });
  expect(stats.dj.steps.find((step) => step.step === 'pause')?.allTime).toMatchObject({
    skipped: 1,
    waiting: 1,
  });
  expect(stats.booked.runs.allTime).toMatchObject({ enrolled: 2, exited: 1, active: 1 });
  expect(await h.differences()).toEqual([]);
});

it('fails the step when it names something that is not an automation id', async () => {
  const tenant = await h.business();
  const own = await h.publish(
    tenant,
    remover('Consultation booked', { from: 'automations', automations: ['Never resolved'] }),
  );
  const made = await h.enrol(tenant);
  const run = (await runsFor(tenant, made.contactId)).get(own.automationId)?.id ?? '';
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'failed',
    exit_reason: 'unknown_reference',
  });
});

it('runs the consultation booking: sales end, pre-consultation starts, education carries on', async () => {
  const tenant = await h.business();
  const dj = await h.publish(tenant, sales('DJ sales'));
  const photo = await h.publish(tenant, listening);
  const combined = await h.publish(tenant, sales('Combined sales'));
  const lessons = await h.publish(tenant, education);
  const pre = await h.publish(tenant, {
    name: 'Pre-consultation',
    triggers: [unheard],
    start: 'prepare',
    steps: { prepare: { type: 'wait', config: { duration: 'P1D' } } },
  });
  const booked = await h.publish(tenant, {
    name: 'Consultation booked',
    triggers: [created],
    start: 'end_sales',
    steps: {
      end_sales: {
        type: 'automation.remove',
        config: { from: 'all_others', except: [lessons.id] },
        next: 'start_pre',
      },
      start_pre: { type: 'automation.run', config: { automation: pre.id }, next: 'after' },
      after: { type: 'wait', config: { duration: 'PT1M' } },
    },
  });
  const made = await h.enrol(tenant);
  const runs = await runsFor(tenant, made.contactId);
  const run = (published: Published) => runs.get(published.automationId)?.id ?? '';
  for (const each of [dj, photo, combined, lessons]) await h.step(tenant, run(each));
  const lessonBefore = (await runsFor(tenant, made.contactId)).get(lessons.automationId);

  expect(await h.step(tenant, run(booked))).toBe('ran');
  expect(await h.step(tenant, run(booked))).toBe('ran');
  const after = await runsFor(tenant, made.contactId);
  const reason = `removed:${booked.id}`;
  for (const each of [dj, photo, combined])
    expect(after.get(each.automationId)).toMatchObject(exited(reason));
  expect(after.get(lessons.automationId)).toEqual(lessonBefore);
  expect(lessonBefore?.wake_at).toBeInstanceOf(Date);
  const started = after.get(pre.automationId);
  expect(started).toMatchObject({ status: 'running', current_step: 'prepare' });
  expect(await stepsOf(tenant, run(booked))).toEqual([
    { step_key: 'end_sales', status: 'succeeded', output: { removed: 3 } },
    {
      step_key: 'start_pre',
      status: 'succeeded',
      output: {
        outcome: 'started',
        enrolmentId: toPublicId('automation_enrolment', started?.id ?? ''),
      },
    },
  ]);
  expect(after.get(booked.automationId)).toMatchObject({
    status: 'running',
    current_step: 'after',
  });
  expect(await h.differences()).toEqual([]);
});
