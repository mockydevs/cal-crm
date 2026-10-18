// How many each automation has enrolled, how many are still going, and how many visits each
// step and each trigger has had, for the live version and for all time. The numbers are
// counters kept by the database beside every run and step; these tests hold them to the
// rows they count, under steps running at once, under a fold, and after a random sequence
// of everything that can happen to a run.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError, toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, waitsADay, type Harness, type Tenant } from '../test/workflows.js';
import { createDeletionCommands } from './deletion.js';
import { readAutomation, readAutomations } from './drafts.js';
import { compactAutomationStats, readAutomationStats, readEnrolledCounts } from './stats.js';

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

// Emits an event the way every command does, through runCommand, onto a record's timeline.
const emitOnRecord = defineCommand({
  name: 'test.event_on_record',
  permission: 'contacts.manage',
  input: z.strictObject({ type: z.string(), recordId: z.uuid(), tagId: z.string().optional() }),
  async handle(_trx, input, command) {
    return command.emit({
      type: input.type,
      subject: { kind: 'test', id: randomUUID() },
      records: [input.recordId],
      payload: { channel: 'email', recordId: input.recordId, tagId: input.tagId ?? null },
    });
  },
});

/** Something happens to a record, and the engine matches it, as the worker would. */
async function happens(
  tenant: Tenant,
  type: string,
  recordId: string,
  tagId?: string,
): Promise<void> {
  const eventId = await runCommand(
    h.services,
    emitOnRecord,
    { type, recordId, ...(tagId === undefined ? {} : { tagId }) },
    all(tenant),
  );
  await h.match(tenant, eventId);
}

const HOUR = 3_600_000;
const T0 = new Date('2031-03-03T09:00:00Z');
const after = (ms: number) => new Date(T0.getTime() + ms);

async function tagOf(tenant: Tenant): Promise<string> {
  const [tag] = await h.database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `insert into crm.tags (business_id, name, created_by_kind) values ($1, $2, 'user') returning id`,
      [tenant.businessId, `Done ${randomUUID()}`],
    ),
  );
  return toPublicId('tag', tag?.id ?? '');
}

/** Ada waits an hour first; everyone waits two hours for a message, then is tagged or not. */
const journey = (tag: string, last: 'tell' | 'last' = 'tell'): AutomationDocumentInput => ({
  name: 'Journey',
  triggers: [
    { id: 'created', type: 'contact.created', config: {} },
    { id: 'tagged', type: 'tag.added', config: { tag } },
  ],
  stopWhen: [{ event: 'appointment.booked' }],
  start: 'is_ada',
  steps: {
    is_ada: {
      type: 'condition',
      label: 'Is it Ada?',
      config: { if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' } },
      next: { yes: 'pause', no: 'hear' },
    },
    pause: { type: 'wait', config: { duration: 'PT1H' }, next: 'hear' },
    hear: {
      type: 'wait.event',
      config: { event: 'message.received', timeout: 'PT2H' },
      next: { received: 'done', timed_out: last },
    },
    done: { type: 'tag.add', config: { tag } },
    ...(last === 'tell'
      ? { tell: { type: 'team.notify' as const, config: { message: 'No reply.' } } }
      : { last: { type: 'wait' as const, config: { duration: 'PT1M' } } }),
  },
});

const zero = { entered: 0, completed: 0, failed: 0, waiting: 0, skipped: 0 };

it('counts total and active enrolled per automation, as the list of automations shows them', async () => {
  const tenant = await h.business();
  const first = await h.publish(tenant);
  const second = await h.publish(tenant, { ...waitsADay, name: 'Second' });
  await h.publish(tenant, {
    ...waitsADay,
    name: 'Quiet',
    triggers: [{ id: 'tagged', type: 'tag.added', config: { tag: await tagOf(tenant) } }],
  });
  const ada = await h.enrol(tenant, 'Ada');
  await h.enrol(tenant, 'Grace');
  expect(ada.enrolments).toHaveLength(2);
  // Ada's run of the first automation goes to its end; her other run, and Grace's, go on.
  const [adaFirst = ''] = ada.enrolments;
  await h.step(tenant, adaFirst, T0);
  await h.step(tenant, adaFirst, after(25 * HOUR));
  await h.step(tenant, adaFirst, after(26 * HOUR));
  expect(await h.run(tenant, adaFirst)).toMatchObject({ status: 'completed' });

  const listed = async () =>
    Object.fromEntries(
      (await withTenant(h.db, tenant, (trx) => readAutomations(trx, {}))).items.map((item) => [
        item.name,
        [item.totalEnrolled, item.activeEnrolled],
      ]),
    );
  const expected = { 'Follow-up': [2, 1], Second: [2, 2], Quiet: [0, 0] };
  expect(await listed()).toEqual(expected);
  expect(await withTenant(h.db, tenant, (trx) => readAutomation(trx, first.id))).toMatchObject({
    totalEnrolled: 2,
    activeEnrolled: 1,
  });
  // Folded into the counters or not, the numbers are the same, and the same as the rows.
  expect(await compactAutomationStats(h.services)).toBeGreaterThan(0);
  expect(await listed()).toEqual(expected);
  expect(await h.differences()).toEqual([]);

  // Another business reads none of it, by the list or by the automation's id.
  const elsewhere = await h.business();
  expect((await withTenant(h.db, elsewhere, (trx) => readAutomations(trx, {}))).items).toEqual([]);
  const theirs = await withTenant(h.db, elsewhere, (trx) =>
    readEnrolledCounts(trx, [first.automationId, second.automationId]),
  );
  expect(theirs(first.automationId)).toEqual({ total: 0, active: 0 });
  await expect(
    withTenant(h.db, elsewhere, (trx) => readAutomationStats(trx, first.id)),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('counts each step and each trigger, for the live version and for all time', async () => {
  const tenant = await h.business();
  const tag = await tagOf(tenant);
  const { id, automationId } = await h.publish(tenant, journey(tag));
  const stats = () => withTenant(h.db, tenant, (trx) => readAutomationStats(trx, id));

  // Nothing has run: every step and trigger of the live version is listed, at nought.
  expect(await stats()).toEqual({
    automationId: id,
    liveVersion: 1,
    runs: {
      allTime: { enrolled: 0, active: 0, completed: 0, exited: 0, failed: 0, cancelled: 0 },
      live: { enrolled: 0, active: 0, completed: 0, exited: 0, failed: 0, cancelled: 0 },
    },
    triggers: ['created', 'tagged'].map((trigger) => ({
      trigger,
      type: trigger === 'created' ? 'contact.created' : 'tag.added',
      inLiveVersion: true,
      allTime: { enrolled: 0 },
      live: { enrolled: 0 },
    })),
    steps: [
      ['done', 'tag.add', null],
      ['hear', 'wait.event', null],
      ['is_ada', 'condition', 'Is it Ada?'],
      ['pause', 'wait', null],
      ['tell', 'team.notify', null],
    ].map(([step, type, label]) => ({
      step,
      type,
      label,
      inLiveVersion: true,
      allTime: zero,
      live: zero,
    })),
  });

  // Ada: the wait, then the message arrives in time, and she is tagged. Completed.
  const ada = await h.enrol(tenant, 'Ada');
  const [adaRun = ''] = ada.enrolments;
  await h.step(tenant, adaRun, T0);
  await h.step(tenant, adaRun, T0);
  await h.step(tenant, adaRun, after(HOUR + 1000));
  await happens(tenant, 'message.received', ada.contactId);
  await h.step(tenant, adaRun, after(HOUR + 2000));
  await h.step(tenant, adaRun, after(HOUR + 3000));
  expect(await h.run(tenant, adaRun)).toMatchObject({ status: 'completed' });

  // Grace: no message comes, and the step after the timeout cannot run. Failed.
  const grace = await h.enrol(tenant, 'Grace');
  const [graceRun = ''] = grace.enrolments;
  await h.step(tenant, graceRun, T0);
  await h.step(tenant, graceRun, T0);
  await h.step(tenant, graceRun, after(2 * HOUR + 1000));
  await h.step(tenant, graceRun, after(2 * HOUR + 2000));
  expect(await h.run(tenant, graceRun)).toMatchObject({
    status: 'failed',
    exit_reason: 'not_implemented',
  });

  // Hedy: books an appointment while waiting for a message. Stopped, mid-wait.
  const hedy = await h.enrol(tenant, 'Hedy');
  const [hedyRun = ''] = hedy.enrolments;
  await h.step(tenant, hedyRun, T0);
  await h.step(tenant, hedyRun, T0);
  await happens(tenant, 'appointment.booked', hedy.contactId);
  expect(await h.run(tenant, hedyRun)).toMatchObject({ status: 'exited' });

  // Joan: enrolled by the other trigger, and still waiting for a message.
  const joan = await h.contact(tenant, 'Joan');
  await happens(tenant, 'tag.assigned', joan.contactId, tag);
  const [joanRow] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      joan.contactId,
    ]),
  );
  const joanRun = joanRow?.id ?? '';
  await h.step(tenant, joanRun, T0);
  await h.step(tenant, joanRun, T0);
  expect(await h.run(tenant, joanRun)).toMatchObject({ status: 'waiting', current_step: 'hear' });

  const afterFour = {
    runs: { enrolled: 4, active: 1, completed: 1, exited: 1, failed: 1, cancelled: 0 },
    steps: {
      done: { ...zero, entered: 1, completed: 1 },
      // Four waits for a message began: two were answered or timed out and went on, one
      // was cut short by the stop, and one is still waiting. A wait and its answer are one
      // visit, though they are two rows.
      hear: { entered: 4, completed: 2, failed: 0, waiting: 1, skipped: 1 },
      is_ada: { ...zero, entered: 4, completed: 4 },
      pause: { ...zero, entered: 1, completed: 1 },
      tell: { ...zero, entered: 1, failed: 1 },
    },
  };
  const first = await stats();
  expect(first.runs).toEqual({ allTime: afterFour.runs, live: afterFour.runs });
  expect(Object.fromEntries(first.steps.map((step) => [step.step, step.allTime]))).toEqual(
    afterFour.steps,
  );
  expect(Object.fromEntries(first.steps.map((step) => [step.step, step.live]))).toEqual(
    afterFour.steps,
  );
  expect(first.triggers.map((each) => [each.trigger, each.allTime.enrolled])).toEqual([
    ['created', 3],
    ['tagged', 1],
  ]);
  expect(await h.differences()).toEqual([]);

  // A second version, without the step that cannot run. One more contact goes into it.
  await h.publish(tenant, journey(tag, 'last'), automationId);
  const kay = await h.enrol(tenant, 'Kay');
  const [kayRun = ''] = kay.enrolments;
  await h.step(tenant, kayRun, T0);
  await h.step(tenant, kayRun, T0);
  const second = await stats();
  expect(second.liveVersion).toBe(2);
  expect(second.runs).toEqual({
    allTime: { ...afterFour.runs, enrolled: 5, active: 2 },
    live: { enrolled: 1, active: 1, completed: 0, exited: 0, failed: 0, cancelled: 0 },
  });
  expect(second.steps).toEqual([
    {
      step: 'done',
      type: 'tag.add',
      label: null,
      inLiveVersion: true,
      allTime: afterFour.steps.done,
      live: zero,
    },
    {
      step: 'hear',
      type: 'wait.event',
      label: null,
      inLiveVersion: true,
      allTime: { ...afterFour.steps.hear, entered: 5, waiting: 2 },
      live: { ...zero, entered: 1, waiting: 1 },
    },
    {
      step: 'is_ada',
      type: 'condition',
      label: 'Is it Ada?',
      inLiveVersion: true,
      allTime: { ...zero, entered: 5, completed: 5 },
      live: { ...zero, entered: 1, completed: 1 },
    },
    { step: 'last', type: 'wait', label: null, inLiveVersion: true, allTime: zero, live: zero },
    {
      step: 'pause',
      type: 'wait',
      label: null,
      inLiveVersion: true,
      allTime: afterFour.steps.pause,
      live: zero,
    },
    // No longer in the live version: its numbers are kept, named as version 1 named it.
    {
      step: 'tell',
      type: 'team.notify',
      label: null,
      inLiveVersion: false,
      allTime: afterFour.steps.tell,
      live: zero,
    },
  ]);
  expect(second.triggers).toEqual([
    {
      trigger: 'created',
      type: 'contact.created',
      inLiveVersion: true,
      allTime: { enrolled: 4 },
      live: { enrolled: 1 },
    },
    {
      trigger: 'tagged',
      type: 'tag.added',
      inLiveVersion: true,
      allTime: { enrolled: 1 },
      live: { enrolled: 0 },
    },
  ]);
  // Folded, every number is as it was.
  await compactAutomationStats(h.services);
  expect(await stats()).toEqual(second);
  expect(await h.differences()).toEqual([]);
});

it('has no live numbers for an automation that was never published', async () => {
  const tenant = await h.business();
  const [draft] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values (app.business_id(), 'Unfinished', '{"name": "Unfinished"}', 'user') returning id`,
    ),
  );
  const id = toPublicId('automation', draft?.id ?? '');
  expect(await withTenant(h.db, tenant, (trx) => readAutomationStats(trx, id))).toEqual({
    automationId: id,
    liveVersion: null,
    runs: {
      allTime: { enrolled: 0, active: 0, completed: 0, exited: 0, failed: 0, cancelled: 0 },
      live: null,
    },
    triggers: [],
    steps: [],
  });
  await expect(
    withTenant(h.db, tenant, (trx) => readAutomationStats(trx, 'the-newsletter')),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('lets steps of one automation write their counts at once: none waits for another, none is lost', async () => {
  const tenant = await h.business();
  const { id } = await h.publish(tenant);
  const runs: string[] = [];
  for (let guest = 1; guest <= 9; guest += 1)
    runs.push((await h.enrol(tenant, `Guest ${String(guest)}`)).enrolments[0] ?? '');
  const [held = '', ...others] = runs;

  // One run's change is written and left uncommitted, as a step in flight leaves it.
  let release = (): void => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  let written = (): void => undefined;
  const isWritten = new Promise<void>((resolve) => {
    written = resolve;
  });
  const holding = h.database.as('crm_owner', async (sql) => {
    await sql.query(
      `update automation.enrolments set status = 'waiting', wake_at = now() where id = $1`,
      [held],
    );
    written();
    await open;
  });
  await isWritten;

  // Eight other runs take their step meanwhile, all at once, and each finishes while that
  // transaction is still open. A fold runs in between and takes what is committed.
  const stats = () => withTenant(h.db, tenant, (trx) => readAutomationStats(trx, id));
  // Whatever is found, the open transaction is let go, so a failure fails this test alone.
  try {
    expect(await Promise.all(others.map((enrolmentId) => h.step(tenant, enrolmentId, T0)))).toEqual(
      others.map(() => 'ran'),
    );
    await compactAutomationStats(h.services);
    const [lockWaits] = await h.database.as('postgres', (sql) =>
      sql.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      ),
    );
    expect(lockWaits).toEqual({ waiting: 0 });
    // What the open transaction wrote is not counted until it commits.
    expect((await stats()).runs.allTime).toMatchObject({ enrolled: 9, active: 9 });
  } finally {
    release();
    await holding;
  }

  const counted = await stats();
  expect(counted.runs.allTime).toMatchObject({ enrolled: 9, active: 9 });
  expect(counted.steps.find((step) => step.step === 'pause')?.allTime).toEqual({
    ...zero,
    entered: 8,
    waiting: 8,
  });
  expect(await h.differences()).toEqual([]);
});

it('folds what is committed while a step is in flight, and counts the step once it commits', async () => {
  const tenant = await h.business();
  const { id, automationId } = await h.publish(tenant);
  const { enrolments } = await h.enrol(tenant);
  const [enrolmentId = ''] = enrolments;
  const unfolded = async () =>
    (
      await h.database.as('crm_owner', (sql) =>
        sql.query<{ rows: number }>(
          'select count(*)::int as rows from automation.stat_deltas where automation_id = $1',
          [automationId],
        ),
      )
    )[0]?.rows;
  expect(await unfolded()).toBeGreaterThan(0);

  let release = (): void => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  let written = (): void => undefined;
  const isWritten = new Promise<void>((resolve) => {
    written = resolve;
  });
  const holding = h.database.as('crm_owner', async (sql) => {
    await sql.query(
      `update automation.enrolments set status = 'completed', finished_at = now() where id = $1`,
      [enrolmentId],
    );
    written();
    await open;
  });
  await isWritten;
  const runs = async () =>
    (await withTenant(h.db, tenant, (trx) => readAutomationStats(trx, id))).runs.allTime;
  try {
    await compactAutomationStats(h.services);
    expect(await unfolded()).toBe(0);
    expect(await runs()).toMatchObject({ enrolled: 1, active: 1, completed: 0 });
  } finally {
    release();
    await holding;
  }
  expect(await runs()).toMatchObject({ enrolled: 1, active: 0, completed: 1 });
  expect(await compactAutomationStats(h.services)).toBeGreaterThan(0);
  expect(await runs()).toMatchObject({ enrolled: 1, active: 0, completed: 1 });
  expect(await h.differences()).toEqual([]);
});

// A small generator with a fixed seed, so the sequence is the same on every machine.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Many database round trips, one after another, and no waiting on time: the bound is for a
// two-core runner that is many times slower than a workstation.
it(
  'keeps every counter equal to the rows through a random sequence of everything that happens to runs',
  { timeout: 300_000 },
  async () => {
    const SEED = 20_261_010;
    const random = seeded(SEED);
    const pick = <T>(items: readonly T[]): T | undefined =>
      items[Math.floor(random() * items.length)];
    const tenant = await h.business();
    const tag = await tagOf(tenant);
    const { id, automationId } = await h.publish(tenant, journey(tag));
    const deletion = createDeletionCommands();
    const names = ['Ada', 'Ada', 'Grace', 'Hedy', 'Joan'];
    const contacts: string[] = [];
    let clock = T0.getTime();
    let deleted = false;

    const live = () =>
      h.database.withTenant(tenant, (sql) =>
        sql.query<{ id: string; wake_at: Date | null }>(
          `select id, wake_at from automation.enrolments
           where status in ('running', 'waiting') order by id`,
        ),
      );
    // What the statistics should say, counted here from the rows, by another road than the
    // database's own reconciliation: visits and outcomes per step, and runs per status.
    const counted = async () => {
      const steps = await h.database.withTenant(tenant, (sql) =>
        sql.query<{
          step: string;
          entered: number;
          completed: number;
          failed: number;
          waiting: number;
          skipped: number;
        }>(
          `select step_key as step,
                  count(*) filter (where not resumes)::int as entered,
                  (count(*) filter (where status = 'succeeded')
                    - count(*) filter (where resumes))::int as completed,
                  count(*) filter (where status = 'failed')::int as failed,
                  count(*) filter (where status = 'waiting')::int as waiting,
                  count(*) filter (where status = 'skipped')::int as skipped
           from automation.step_runs group by step_key`,
        ),
      );
      const [runs] = await h.database.withTenant(tenant, (sql) =>
        sql.query(
          `select count(*)::int as enrolled,
                  count(*) filter (where status in ('running', 'waiting'))::int as active,
                  count(*) filter (where status = 'completed')::int as completed,
                  count(*) filter (where status = 'exited')::int as exited,
                  count(*) filter (where status = 'failed')::int as failed,
                  count(*) filter (where status = 'cancelled')::int as cancelled
           from automation.enrolments`,
        ),
      );
      return {
        runs,
        steps: Object.fromEntries(steps.map(({ step, ...counts }) => [step, counts])),
      };
    };
    const check = async (turn: number) => {
      const said = `seed ${String(SEED)}, turn ${String(turn)}`;
      expect(await h.differences(), said).toEqual([]);
      const stats = await withTenant(h.db, tenant, (trx) => readAutomationStats(trx, id));
      const truth = await counted();
      expect(stats.runs.allTime, said).toEqual(truth.runs);
      expect(
        Object.fromEntries(
          stats.steps
            .filter((step) => step.allTime.entered > 0)
            .map((step) => [step.step, step.allTime]),
        ),
        said,
      ).toEqual(truth.steps);
    };

    // What can happen next, and how likely, while the automation is live and while it is
    // on the Deleted list.
    type Happening =
      | 'enrol'
      | 'step'
      | 'message'
      | 'appointment'
      | 'fold'
      | 'purge'
      | 'publish'
      | 'delete'
      | 'restore';
    const whileLive: readonly (readonly [Happening, number])[] = [
      ['enrol', 24],
      ['step', 40],
      ['message', 10],
      ['appointment', 6],
      ['fold', 7],
      ['purge', 2],
      ['publish', 4],
      ['delete', 2],
    ];
    const whileDeleted: readonly (readonly [Happening, number])[] = [
      ['step', 10],
      ['message', 10],
      ['fold', 20],
      ['purge', 10],
      ['restore', 50],
    ];
    const next = (): Happening => {
      const weights = deleted ? whileDeleted : whileLive;
      let at = random() * weights.reduce((sum, [, weight]) => sum + weight, 0);
      for (const [happening, weight] of weights) {
        at -= weight;
        if (at < 0) return happening;
      }
      return 'step';
    };
    const happened = new Map<Happening, number>();
    const seen = { steps: new Set<string>(), runs: new Set<string>(), resumed: false };
    const look = async () => {
      const rows = await h.database.as('crm_owner', (sql) =>
        sql.query<{ kind: string; status: string; resumes: boolean }>(
          `select 'step' as kind, status, bool_or(resumes) as resumes from automation.step_runs
           where automation_id = $1 group by status
           union all
           select 'run', status, false from automation.enrolments
           where automation_id = $1 group by status`,
          [automationId],
        ),
      );
      for (const row of rows) {
        (row.kind === 'step' ? seen.steps : seen.runs).add(row.status);
        seen.resumed ||= row.resumes;
      }
    };

    const TURNS = 260;
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const happening = next();
      happened.set(happening, (happened.get(happening) ?? 0) + 1);
      if (happening === 'enrol') {
        // Someone new: by their own event, or by a tag for one who was not yet matched.
        if (random() < 0.8) contacts.push((await h.enrol(tenant, pick(names))).contactId);
        else {
          const made = await h.contact(tenant, pick(names));
          contacts.push(made.contactId);
          await happens(tenant, 'tag.assigned', made.contactId, tag);
        }
      } else if (happening === 'step') {
        // A run takes its next step: at its time, or early, which does nothing.
        const run = pick(await live());
        if (run !== undefined) {
          if (random() < 0.85) clock = Math.max(clock, (run.wake_at?.getTime() ?? clock) + 1000);
          await h.step(tenant, run.id, new Date(clock));
        }
      } else if (happening === 'message' || happening === 'appointment') {
        const contact = pick(contacts);
        if (contact !== undefined)
          await happens(
            tenant,
            happening === 'message' ? 'message.received' : 'appointment.booked',
            contact,
          );
      } else if (happening === 'fold') {
        await compactAutomationStats(h.services);
      } else if (happening === 'purge') {
        // A contact is purged, with every run and step of theirs.
        const contact = pick(contacts);
        if (contact !== undefined) {
          await look();
          await h.database.as('crm_owner', (sql) =>
            sql.query('delete from crm.records where id = $1', [contact]),
          );
          contacts.splice(contacts.indexOf(contact), 1);
        }
      } else if (happening === 'publish') {
        // A new version: runs under way stay on theirs, new ones begin on this.
        await h.publish(tenant, journey(tag, random() < 0.5 ? 'tell' : 'last'), automationId);
      } else if (happening === 'delete') {
        await look();
        await runCommand(h.services, deletion.remove, { id }, all(tenant));
        deleted = true;
      } else {
        await runCommand(h.services, deletion.restore, { id }, all(tenant));
        // Resumed, as its owner would after restoring it.
        await h.database.as('crm_owner', (sql) =>
          sql.query(`update automation.automations set status = 'active' where id = $1`, [
            automationId,
          ]),
        );
        deleted = false;
      }
      if (turn % 20 === 0) {
        await look();
        await check(turn);
      }
    }
    await look();
    await check(TURNS);
    // The sequence went through every kind of happening and every kind of ending, so the
    // checks above were not of nothing. Fixed by the seed: the same on every machine.
    expect([...happened.keys()].sort()).toEqual([
      'appointment',
      'delete',
      'enrol',
      'fold',
      'message',
      'publish',
      'purge',
      'restore',
      'step',
    ]);
    expect([...seen.steps].sort()).toEqual(['failed', 'skipped', 'succeeded', 'waiting']);
    expect([...seen.runs].sort()).toEqual(
      expect.arrayContaining(['cancelled', 'completed', 'exited', 'failed', 'waiting']) as unknown,
    );
    expect(seen.resumed).toBe(true);
  },
);
