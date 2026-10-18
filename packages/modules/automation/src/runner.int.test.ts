// Each step runs as a job, a wait sets wake_at and the sweeper
// picks up what's due; an enrolment resumes from its saved step, and no visit of a step
// runs twice. Real Postgres and the real queue functions.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, migrateDatabase, withTenant, type Database } from '@repo/db';
import { ForbiddenError, toPublicId, type TenantContext } from '@repo/kernel';
import { assignRecordTagCommand, createContactCommand, createTagCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import {
  contactValues,
  createRunStepCommand,
  matchEvent,
  publishAutomationVersion,
  scheduleDueEnrolments,
  splitBucket,
} from './index.js';

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

interface Started {
  readonly context: TenantContext;
  readonly enrolmentId: string;
}

/** A business with one published automation, and a contact the automation enrolled. */
async function started(document: AutomationDocumentInput, firstName = 'Ada'): Promise<Started> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  await withTenant(db, context, async (trx) => {
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
  });
  await runCommand(
    services,
    createContactCommand,
    { firstName, emails: [`${randomUUID()}@example.test`] },
    {
      context,
      permissions: 'all',
    },
  );
  const enrolmentId = await withTenant(db, context, async (trx) => {
    const event = await trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow();
    const result = await matchEvent(trx, context, event.id, contactValues);
    const [first] = result.enrolled;
    if (first === undefined) throw new Error('Nothing enrolled.');
    return first.enrolmentId;
  });
  return { context, enrolmentId };
}

const state = (s: Started) =>
  withTenant(db, s.context, (trx) =>
    trx
      .selectFrom('automation.enrolments')
      .select(['status', 'current_step', 'wake_at', 'state', 'exit_reason'])
      .where('id', '=', s.enrolmentId)
      .executeTakeFirstOrThrow(),
  );
const sequenceOf = async (s: Started) => ((await state(s)).state as { sequence: number }).sequence;
// Steps run through the engine's own command, as the worker runs them.
const step = async (s: Started, sequence?: number, now?: Date) =>
  runCommand(
    services,
    runStepCommand,
    {
      enrolmentId: s.enrolmentId,
      sequence: sequence ?? (await sequenceOf(s)),
      ...(now === undefined ? {} : { now: now.toISOString() }),
    },
    { context: s.context, permissions: 'all' },
  );
const stepRuns = (s: Started) =>
  database.withTenant(s.context, (client) =>
    client.query<{ step_key: string; status: string; branch: string | null; explanation: string }>(
      'select step_key, status, branch, explanation from automation.step_runs order by started_at, id',
    ),
  );
const queued = (s: Started) =>
  database.as('crm_owner', (client) =>
    client.query<{ run_at: Date; payload: unknown }>(
      "select run_at from graphile_worker.jobs where key = 'automation-enrolment:' || $1::text",
      [s.enrolmentId],
    ),
  );

const flow = (patch: Partial<AutomationDocumentInput> = {}): AutomationDocumentInput => ({
  name: 'Follow-up',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'is_ada',
  steps: {
    is_ada: {
      type: 'condition',
      config: { if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' } },
      next: { yes: 'pause', no: 'done' },
    },
    pause: { type: 'wait', config: { duration: 'P2D' }, next: 'done' },
    done: { type: 'wait', config: { duration: 'PT1M' } },
  },
  ...patch,
});

it('runs each step as a job, waits by wake_at, records why, and completes', async () => {
  const s = await started(flow());
  expect(await queued(s)).toHaveLength(1);
  expect(await step(s)).toBe('ran');
  expect(await state(s)).toMatchObject({ status: 'running', current_step: 'pause' });
  expect(await step(s)).toBe('ran');
  const waiting = await state(s);
  expect(waiting).toMatchObject({ status: 'waiting', current_step: 'done' });
  // Woken early, it does nothing; once due, it goes on from the saved step.
  expect(await step(s)).toBe('skipped');
  const later = new Date((waiting.wake_at?.getTime() ?? 0) + 1000);
  expect(await step(s, undefined, later)).toBe('ran');
  // Gone on from, the first wait is over at once, while the run waits at the next one.
  expect((await stepRuns(s)).map((run) => [run.step_key, run.status])).toEqual([
    ['is_ada', 'succeeded'],
    ['pause', 'succeeded'],
    ['done', 'waiting'],
  ]);
  expect(await step(s, undefined, new Date(later.getTime() + 120_000))).toBe('ran');
  expect(await state(s)).toMatchObject({ status: 'completed', current_step: null });
  // A wait is waiting only while the run is at it; gone on from, it succeeded.
  expect((await stepRuns(s)).map((run) => [run.step_key, run.status, run.branch])).toEqual([
    ['is_ada', 'succeeded', 'yes'],
    ['pause', 'succeeded', null],
    ['done', 'succeeded', null],
  ]);
  expect((await stepRuns(s))[0]?.explanation).toBe(
    'The condition was true, so the yes branch was taken.',
  );
});

it('never runs one visit of a step twice: stale and concurrent jobs do nothing', async () => {
  const s = await started(flow());
  const sequence = await sequenceOf(s);
  const results = await Promise.all([step(s, sequence), step(s, sequence)]);
  expect(results.sort()).toEqual(['ran', 'skipped']);
  expect(await step(s, sequence)).toBe('skipped');
  expect(await stepRuns(s)).toHaveLength(1);
});

it('runs a step again on a real revisit, such as a loop with a wait in it', async () => {
  const s = await started(
    flow({
      start: 'check',
      steps: {
        check: {
          type: 'condition',
          config: { if: { field: 'contact.custom.done', operator: 'is_set' } },
          next: { yes: 'finish', no: 'later' },
        },
        later: { type: 'wait', config: { duration: 'P1D' }, next: 'check' },
        finish: { type: 'wait', config: { duration: 'PT1M' } },
      },
    }),
  );
  let now = new Date();
  for (let visit = 0; visit < 3; visit++) {
    // The condition, then the wait; then time passes beyond the wake.
    expect(await step(s, undefined, now)).toBe('ran');
    expect(await step(s, undefined, now)).toBe('ran');
    now = new Date(((await state(s)).wake_at?.getTime() ?? now.getTime()) + 1000);
  }
  expect((await stepRuns(s)).filter((run) => run.step_key === 'check')).toHaveLength(3);
});

it('fails safely at an action that is not available yet, doing nothing', async () => {
  // Nothing sends an in-app notification yet, so a step that would is failed, with why.
  const s = await started(
    flow({ start: 'tell', steps: { tell: { type: 'team.notify', config: { message: 'Hi' } } } }),
  );
  expect(await step(s)).toBe('ran');
  expect(await state(s)).toMatchObject({ status: 'failed', exit_reason: 'not_implemented' });
  expect((await stepRuns(s)).map((run) => [run.status, run.explanation])).toEqual([
    ['failed', 'This install has no automation notification service.'],
  ]);
});

it('adds a tag through the CRM command, and fails without writing when the tag is gone', async () => {
  const s = await started(
    flow({ start: 'tag', steps: { tag: { type: 'tag.add', config: { tag: 'placeholder' } } } }),
  );
  const tag = await runCommand(
    services,
    createTagCommand,
    { name: 'VIP' },
    { context: s.context, permissions: 'all' },
  );
  // The published version names the tag by id, as the validator leaves it.
  await database.as('crm_owner', (client) =>
    client.query(
      "update automation.versions set document = jsonb_set(document, '{steps,tag,config,tag}', to_jsonb($1::text))",
      [tag.id],
    ),
  );
  expect(await step(s)).toBe('ran');
  expect(await state(s)).toMatchObject({ status: 'completed' });
  expect(
    await database.withTenant(s.context, (client) =>
      client.query("select type from events.events where type = 'tag.assigned'"),
    ),
  ).toEqual([{ type: 'tag.assigned' }]);

  const missing = await started(
    flow({ start: 'tag', steps: { tag: { type: 'tag.add', config: { tag: tag.id } } } }),
  );
  expect(await step(missing)).toBe('ran');
  expect(await state(missing)).toMatchObject({ status: 'failed' });
  expect(
    await database.withTenant(missing.context, (client) =>
      client.query('select record_id from crm.record_tags'),
    ),
  ).toEqual([]);
});

it('resumes from the saved step after its job is lost and the database is migrated again', async () => {
  const s = await started(flow());
  await step(s);
  await step(s);
  expect(await state(s)).toMatchObject({ status: 'waiting', current_step: 'done' });
  // The worker died mid-wait: its pending job is gone. Then the upgrade migrates the database.
  await database.as('crm_owner', (client) =>
    client.query('select graphile_worker.remove_job($1)', [
      `automation-enrolment:${s.enrolmentId}`,
    ]),
  );
  await migrateDatabase({ connectionString: database.url('crm_owner') });
  await database.as('crm_owner', (client) =>
    client.query(
      "update automation.enrolments set wake_at = now() - interval '1 minute' where id = $1",
      [s.enrolmentId],
    ),
  );
  expect(await queued(s)).toEqual([]);
  expect(await scheduleDueEnrolments(services)).toBeGreaterThan(0);
  expect(await queued(s)).toHaveLength(1);
  expect(await step(s)).toBe('ran');
  expect((await stepRuns(s)).map((run) => run.step_key)).toEqual(['is_ada', 'pause', 'done']);
});

it('lets only the engine run steps, even an actor holding every permission', async () => {
  const s = await started(flow());
  const user = await database.fixtures.user();
  await expect(
    runCommand(
      services,
      runStepCommand,
      { enrolmentId: s.enrolmentId, sequence: await sequenceOf(s) },
      { context: { ...s.context, actorKind: 'user', actorId: user.id }, permissions: 'all' },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await stepRuns(s)).toEqual([]);
});

it('updates a custom contact field through the CRM command, and refuses what it cannot set', async () => {
  const s = await started(
    flow({
      start: 'set',
      steps: {
        set: { type: 'contact.update', config: { fields: { 'contact.custom.guests': 120 } } },
      },
    }),
  );
  await database.withTenant(s.context, (client) =>
    client.query(
      `insert into crm.field_definitions (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), id, 'guests', 'Guests', 'How many guests are coming.', 'number', 'system'
       from crm.object_types where kind = 'contact'`,
    ),
  );
  expect(await step(s)).toBe('ran');
  expect(await state(s)).toMatchObject({ status: 'completed' });
  expect(
    await database.withTenant(s.context, (client) =>
      client.query<{ value_number: string }>('select value_number::text from crm.field_values'),
    ),
  ).toEqual([{ value_number: '120' }]);

  const unknown = await started(
    flow({
      start: 'set',
      steps: {
        set: { type: 'contact.update', config: { fields: { 'contact.custom.budget': 5 } } },
      },
    }),
  );
  expect(await step(unknown)).toBe('ran');
  expect(await state(unknown)).toMatchObject({ status: 'failed', exit_reason: 'unknown_field' });

  const builtIn = await started(
    flow({
      start: 'set',
      steps: {
        // The contact's whole name is made from its parts, so it can't be set.
        set: { type: 'contact.update', config: { fields: { 'contact.name': 'Ada' } } },
      },
    }),
  );
  expect(await step(builtIn)).toBe('ran');
  expect(await state(builtIn)).toMatchObject({
    status: 'failed',
    exit_reason: 'unsupported_field',
  });
});

it("waits until a date in the contact's own time zone when the automation says so, else the business's", async () => {
  const untilTheDay = flow({
    start: 'until',
    settings: { timezone: 'contact' },
    steps: {
      until: {
        type: 'wait.until',
        config: { field: 'contact.custom.event_date', time: '09:00' },
      },
    },
  });
  // The enrolled contact's event is on 10 March 2031; the step waits for 09:00 that day.
  const eventDay = (s: Started) =>
    database.withTenant(s.context, async (client) => {
      const field = await client.one<{ id: string }>(
        `insert into crm.field_definitions
           (business_id, object_type_id, key, label, description, value_type, created_by_kind)
         select app.business_id(), id, 'event_date', 'Event date', 'The day of the event.',
                'date', 'system'
         from crm.object_types where kind = 'contact'
         returning id`,
      );
      await client.query(
        `insert into crm.field_values
           (business_id, record_id, field_id, value_type, value_date, source_kind)
         select app.business_id(), record_id, $1::uuid, 'date', date '2031-03-10', 'system'
         from automation.enrolments`,
        [field.id],
      );
    });

  const inTokyo = await started(untilTheDay);
  await eventDay(inTokyo);
  await database.withTenant(inTokyo.context, (client) =>
    client.query("update crm.contacts set timezone = 'Asia/Tokyo'"),
  );
  expect(await step(inTokyo)).toBe('ran');
  expect(await state(inTokyo)).toMatchObject({
    status: 'waiting',
    wake_at: new Date('2031-03-10T00:00:00.000Z'),
  });

  // A contact with no time zone of their own waits by the business's, which is UTC here.
  const nowhere = await started(untilTheDay);
  await eventDay(nowhere);
  expect(await step(nowhere)).toBe('ran');
  expect(await state(nowhere)).toMatchObject({
    status: 'waiting',
    wake_at: new Date('2031-03-10T09:00:00.000Z'),
  });
});

it('fails a run whose next step is not in its version, instead of stalling', async () => {
  const s = await started(
    flow({
      start: 'first',
      steps: { first: { type: 'wait', config: { duration: 'PT1M' }, next: 'gone' } },
    }),
  );
  expect(await step(s)).toBe('ran');
  const waiting = await state(s);
  expect(waiting).toMatchObject({ status: 'waiting', current_step: 'gone' });
  const later = new Date((waiting.wake_at?.getTime() ?? 0) + 1000);
  expect(await step(s, undefined, later)).toBe('ran');
  expect(await state(s)).toMatchObject({
    status: 'failed',
    current_step: null,
    exit_reason: 'missing_step',
  });
  expect((await stepRuns(s)).map((run) => run.step_key)).toEqual(['first']);
});

it('removes a tag through the CRM command, with its event, and is content when it was not there', async () => {
  const s = await started(
    flow({
      start: 'untag',
      steps: {
        untag: { type: 'tag.remove', config: { tag: 'placeholder' }, next: 'again' },
        again: { type: 'tag.remove', config: { tag: 'placeholder' } },
      },
    }),
  );
  const tag = await runCommand(
    services,
    createTagCommand,
    { name: 'Lead' },
    { context: s.context, permissions: 'all' },
  );
  const [contact] = await database.withTenant(s.context, (client) =>
    client.query<{ id: string }>('select id from crm.contacts'),
  );
  await runCommand(
    services,
    assignRecordTagCommand,
    { id: toPublicId('contact', contact?.id ?? ''), tagId: tag.id },
    { context: s.context, permissions: 'all' },
  );
  // The published version names the tag by id, as the validator leaves it.
  await database.as('crm_owner', (client) =>
    client.query(
      `update automation.versions set document =
         jsonb_set(jsonb_set(document, '{steps,untag,config,tag}', to_jsonb($1::text)),
                   '{steps,again,config,tag}', to_jsonb($1::text))`,
      [tag.id],
    ),
  );
  const tagged = () =>
    database.withTenant(s.context, (client) => client.query('select tag_id from crm.record_tags'));
  expect(await tagged()).toHaveLength(1);
  expect(await step(s)).toBe('ran');
  expect(await tagged()).toEqual([]);
  // The CRM's own event, by the engine: the same record of it as when a person removes one.
  expect(
    await database.withTenant(s.context, (client) =>
      client.query<{ actor_kind: string }>(
        "select actor_kind from events.events where type = 'tag.removed'",
      ),
    ),
  ).toEqual([{ actor_kind: 'system' }]);
  // Removing it again changes nothing and fails nothing.
  expect(await step(s)).toBe('ran');
  expect(await state(s)).toMatchObject({ status: 'completed', exit_reason: null });
  expect((await stepRuns(s)).map((run) => [run.step_key, run.status, run.explanation])).toEqual([
    ['untag', 'succeeded', 'The tag was removed.'],
    ['again', 'succeeded', 'The tag was removed.'],
  ]);
});

it('records which variant a split took and why, and takes the same one when the step is retried', async () => {
  const document = flow({
    start: 'ab',
    steps: {
      ab: {
        type: 'split',
        config: {
          variants: [
            { name: 'short', percent: 50 },
            { name: 'long', percent: 50 },
          ],
        },
        next: { short: 'short_wait', long: 'long_wait' },
      },
      short_wait: { type: 'wait', config: { duration: 'PT1M' } },
      long_wait: { type: 'wait', config: { duration: 'P1D' } },
    },
  });
  const s = await started(document);
  const bucket = splitBucket(s.enrolmentId, 'ab');
  const variant = bucket < 50 ? 'short' : 'long';
  expect(await step(s)).toBe('ran');
  expect(await state(s)).toMatchObject({ status: 'running', current_step: `${variant}_wait` });
  expect(await stepRuns(s)).toEqual([
    {
      step_key: 'ab',
      status: 'succeeded',
      branch: variant,
      explanation: `Bucket ${String(bucket)} of 100 fell in variant ${variant}.`,
    },
  ]);
});
