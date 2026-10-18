// A test run's trace matches what a real run would do. One
// draft is run both ways for the same contact: dry, by the test-run command, with time
// fast-forwarded and events simulated; and for real, by the engine's own step command at the
// same moments, with the same events happening through the CRM's own commands. The steps
// taken, in order, when, the branch each took and why must be the same, and so must the end.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import {
  addDuration,
  automationDocument,
  automationStepTypes,
  type AutomationDocumentInput,
  type AutomationTestRun,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { assignRecordTagCommand, createContactCommand, crmRoutes } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { testRunCommand } from './test-runs.js';
import { contactValues } from './values.js';

// These fixture contacts have no owner; any tasks stay unassigned.
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

const START = new Date('2031-03-01T09:00:00Z');

it('dry and real DND steps refuse a too-short rendered reason without changing restrictions', async () => {
  const s = await scene(() => ({
    name: 'DND reason parity',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'restrict',
    steps: {
      restrict: {
        type: 'dnd.set',
        config: { channel: 'sms', action: 'enable', reason: '{{contact.firstName}}' },
      },
    },
  }));
  const restrictions = () =>
    withTenant(db, s.context, (trx) =>
      trx
        .selectFrom('crm.contacts')
        .select(['do_not_contact', 'dnd_channels'])
        .where('id', '=', s.contactId)
        .executeTakeFirstOrThrow(),
    );
  const before = await restrictions();
  const run = await testRun(s, []);
  expect(run.outcome).toEqual({ kind: 'failed', step: 'restrict', error: 'too_small' });
  expect(run.steps).toEqual([]);
  expect(await restrictions()).toEqual(before);
  const actual = await real(s, []);
  expect(actual.end).toBe('failed: too_small');
  expect(actual.steps).toEqual([]);
  expect(actual).toEqual(dry(run));
  expect(await restrictions()).toEqual(before);
});

it('dry and real contact updates refuse built-in phone before an unknown custom field', async () => {
  const s = await scene(() => ({
    name: 'First refusal parity',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'change',
    steps: {
      change: {
        type: 'contact.update',
        config: { fields: { 'contact.custom.missing': 'new', 'contact.phone': '+254' } },
      },
    },
  }));
  const before = await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId));
  const run = await testRun(s, []);
  expect(run.outcome).toEqual({ kind: 'failed', step: 'change', error: 'phone_invalid' });
  expect(run.steps).toEqual([]);
  expect(await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId))).toEqual(before);
  const actual = await real(s, []);
  expect(actual.end).toBe('failed: phone_invalid');
  expect(actual.steps).toEqual([]);
  expect(actual).toEqual(dry(run));
  expect(await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId))).toEqual(before);
});

it.each([
  { type: 'email', value: ' GRACE@EXAMPLE.TEST ', expected: 'grace@example.test' },
  { type: 'number', value: 12.5, expected: 12.5 },
  { type: 'datetime', value: '2031-03-01T12:00:00+03:00', expected: '2031-03-01T09:00:00.000Z' },
  { type: 'phone', value: '+254 712 345678', expected: '+254712345678' },
  { type: 'boolean', value: false, expected: false },
  { type: 'single_choice', value: 'active', expected: 'active' },
] as const)(
  'custom $type changes take the same literal dry and real route',
  async ({ type, value, expected }) => {
    const s = await scene((tags) => ({
      name: 'Custom field parity',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'change',
      steps: {
        change: {
          type: 'contact.update',
          config: { fields: { 'contact.custom.preference': value } },
          next: 'check',
        },
        check: {
          type: 'condition',
          config: {
            if: {
              field: 'contact.custom.preference',
              operator: type === 'single_choice' ? 'includes' : 'equals',
              value: expected,
            },
          },
          next: { yes: 'matched', no: 'stale' },
        },
        matched: { type: 'tag.add', config: { tag: tags.thanked } },
        stale: { type: 'tag.add', config: { tag: tags.nudged } },
      },
    }));
    const createField = crmRoutes.find((route) => route.endpoint.operationId === 'createField');
    if (createField === undefined) throw new Error('Missing createField route.');
    await createField.run(
      {
        invocation: { context: s.context, permissions: 'all' },
        params: {},
        query: {},
        body: {
          objectKey: 'contact',
          key: 'preference',
          label: 'Preference',
          description: 'Sanitized parity field.',
          valueType: type,
          currency: null,
          options:
            type === 'single_choice'
              ? [{ key: 'active', label: 'Active', description: '', archived: false }]
              : [],
          aiFillSources: [],
          aiOverwrite: 'never',
          archived: false,
        },
      },
      services,
    );
    const before = await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId));
    const trace = dry(await testRun(s, []));
    expect(trace.end).toBe('completed');
    expect(trace.steps.map((step) => step.step)).toEqual(['change', 'check', 'matched']);
    expect(trace.steps[1]).toMatchObject({ branch: 'yes' });
    expect(await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId))).toEqual(
      before,
    );
    const actual = await real(s, []);
    expect(actual.end).toBe('completed');
    expect(actual.steps.map((step) => step.step)).toEqual(['change', 'check', 'matched']);
    expect(actual.steps[1]).toMatchObject({ branch: 'yes' });
    expect(actual).toEqual(trace);
    const stored = await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId));
    expect(stored['contact.custom.preference']).toEqual(
      type === 'single_choice' ? ['active'] : expected,
    );
  },
);
const after = (duration: string): Date => {
  const moment = addDuration(START, duration);
  if (moment === undefined) throw new Error(`${duration} is not a duration.`);
  return moment;
};

/** One step as both kinds of run can be compared: what was taken, when, and why. */
type Taken =
  | { step: string; at: string; action: true }
  | { step: string; at: string; branch: string | null; explanation: string };

interface Ran {
  readonly steps: readonly Taken[];
  readonly end: string;
}

const isAction = (type: string): boolean => {
  const group = Object.entries(automationStepTypes).find(([name]) => name === type)?.[1].group;
  return group !== 'timing' && group !== 'logic';
};

/** A test run's trace, in the shape both are compared in. */
function dry(run: AutomationTestRun): Ran {
  const outcome = run.outcome;
  if (outcome === null) throw new Error('The test run has no outcome.');
  return {
    steps: run.steps.map((each) =>
      each.kind === 'would_send' || each.kind === 'would_change'
        ? { step: each.step, at: each.at, action: true as const }
        : {
            step: each.step,
            at: each.at,
            branch: each.branch ?? null,
            explanation: each.explanation,
          },
    ),
    end:
      outcome.kind === 'completed'
        ? 'completed'
        : outcome.kind === 'stopped'
          ? `stopped by ${outcome.event}`
          : outcome.kind === 'failed'
            ? `failed: ${outcome.error}`
            : 'limit',
  };
}

interface Scene {
  readonly context: TenantContext & { readonly businessId: string };
  readonly automationId: string;
  readonly contactId: string;
  readonly contact: string;
  /** A tag of the business, by its public id. */
  readonly tags: Readonly<Record<'vip' | 'thanked' | 'nudged' | 'replied', string>>;
}

/** A business with its tags and one contact, Ada, in New York. */
async function scene(
  write: (tags: Scene['tags']) => AutomationDocumentInput,
  firstName = 'Ada',
): Promise<Scene & { readonly document: AutomationDocumentInput }> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, businessId: business.id, correlationId: randomUUID() };
  const tag = async (name: string) => {
    const [row] = await database.as('postgres', (sql) =>
      sql.query<{ id: string }>(
        `insert into crm.tags (business_id, name, created_by_kind) values ($1, $2, 'user') returning id`,
        [business.id, name],
      ),
    );
    if (row === undefined) throw new Error('The tag was not made.');
    return toPublicId('tag', row.id);
  };
  const tags = {
    vip: await tag('VIP'),
    thanked: await tag('Thanked'),
    nudged: await tag('Nudged'),
    replied: await tag('Replied'),
  };
  const document = write(tags);
  const contact = await runCommand(
    services,
    createContactCommand,
    { firstName, emails: [`${randomUUID()}@example.test`] },
    { context, permissions: 'all' },
  );
  const automationId = await withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'user',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  });
  const [row] = await database.withTenant(context, (sql) =>
    sql.query<{ id: string }>('select id from crm.contacts'),
  );
  if (row === undefined) throw new Error('The contact was not made.');
  return { context, automationId, contactId: row.id, contact: contact.id, tags, document };
}

/** Something that happens to the contact while the automation runs, in both kinds of run. */
interface Happening {
  /** How long after the start. */
  readonly after: string;
  /** The event as a test run names it. */
  readonly event: string;
  /** The same thing done for real, through the CRM's own command. */
  readonly really: (s: Scene) => Promise<unknown>;
}

const tagged = (afterStart: string, which: keyof Scene['tags']): Happening => ({
  after: afterStart,
  event: 'tag.added',
  really: (s) =>
    runCommand(
      services,
      assignRecordTagCommand,
      { id: s.contact, tagId: s.tags[which] },
      { context: { ...s.context, correlationId: randomUUID() }, permissions: 'all' },
    ),
});

const testRun = (s: Scene, happenings: readonly Happening[]): Promise<AutomationTestRun> =>
  runCommand(
    services,
    testRunCommand,
    {
      id: toPublicId('automation', s.automationId),
      contactId: s.contact,
      start: START.toISOString(),
      events: happenings.map(({ event, after: afterStart }) => ({ event, after: afterStart })),
    },
    { context: s.context, permissions: 'all' },
  );

/**
 * The same draft, published and run for real. Each step runs through the engine's command
 * at the moment the clock has reached; between steps every new event is matched, as the
 * worker's match job does; and a wait ends at its wake time or when something happens.
 */
async function real(
  s: Scene & { readonly document: AutomationDocumentInput },
  happenings: readonly Happening[],
): Promise<Ran> {
  const seen = new Set<string>();
  const matchNewEvents = async (enrol: boolean): Promise<string | undefined> => {
    const events = await withTenant(db, s.context, (trx) =>
      trx.selectFrom('events.events').select('id').orderBy('id').execute(),
    );
    let enrolled: string | undefined;
    for (const { id } of events) {
      if (seen.has(id)) continue;
      seen.add(id);
      const result = await withTenant(db, s.context, (trx) =>
        matchEvent(trx, s.context, id, contactValues),
      );
      enrolled ??= result.enrolled[0]?.enrolmentId;
    }
    if (enrol && enrolled === undefined) throw new Error('Nothing enrolled.');
    return enrolled;
  };
  await withTenant(db, s.context, (trx) =>
    publishAutomationVersion(
      trx,
      s.context,
      s.automationId,
      automationDocument.parse(s.document),
      'v1',
    ),
  );
  // The contact's own contact.created event starts it.
  const enrolmentId = (await matchNewEvents(true)) ?? '';
  const read = () =>
    withTenant(db, s.context, (trx) =>
      trx
        .selectFrom('automation.enrolments')
        .select(['status', 'wake_at', 'state', 'exit_reason'])
        .where('id', '=', enrolmentId)
        .executeTakeFirstOrThrow(),
    );
  const pending = happenings
    .map((each) => ({ ...each, at: after(each.after) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const ranAt: Date[] = [];
  const stepCount = async () => {
    const [row] = await database.withTenant(s.context, (sql) =>
      sql.query<{ count: number }>('select count(*)::int as count from automation.step_runs'),
    );
    return row?.count ?? 0;
  };
  let now = START;
  for (let turns = 0; turns < 50; turns += 1) {
    const enrolment = await read();
    if (!['running', 'waiting'].includes(enrolment.status)) break;
    if (enrolment.status === 'waiting' && enrolment.wake_at !== null && enrolment.wake_at > now) {
      const [next] = pending;
      if (next !== undefined && next.at <= enrolment.wake_at) {
        pending.shift();
        now = next.at;
        await next.really(s);
        await matchNewEvents(false);
      } else now = enrolment.wake_at;
    }
    const current = await read();
    if (!['running', 'waiting'].includes(current.status)) break;
    const result = await runCommand(
      services,
      runStepCommand,
      {
        enrolmentId,
        sequence: (current.state as { sequence?: number }).sequence ?? 0,
        now: now.toISOString(),
      },
      { context: { ...s.context, correlationId: randomUUID() }, permissions: 'all' },
    );
    // A run whose path ended on a wait is finished by one more job, which takes no step.
    if (result === 'ran' && (await stepCount()) > ranAt.length) ranAt.push(now);
    await matchNewEvents(false);
  }
  const ended = await read();
  const stepRuns = await database.withTenant(s.context, (sql) =>
    sql.query<{
      step_key: string;
      status: string;
      branch: string | null;
      explanation: string;
      input: { type: string };
    }>(
      'select step_key, status, branch, explanation, input from automation.step_runs order by started_at, id',
    ),
  );
  expect(stepRuns).toHaveLength(ranAt.length);
  // A step that failed is how the run ended, which a test run reports as its outcome.
  const failedAt = stepRuns.findIndex((run) => run.status === 'failed');
  expect(failedAt === -1 || failedAt === stepRuns.length - 1).toBe(true);
  return {
    steps: stepRuns
      .filter((run) => run.status !== 'failed')
      .map((run, position) => {
        const at = (ranAt[position] ?? START).toISOString();
        if (!isAction(run.input.type))
          return { step: run.step_key, at, branch: run.branch, explanation: run.explanation };
        // An action is only described by a test run; for real it must have been done.
        expect(run.status, run.explanation).toBe('succeeded');
        return { step: run.step_key, at, action: true as const };
      }),
    end:
      ended.status === 'completed'
        ? 'completed'
        : ended.status === 'exited'
          ? `stopped by ${(ended.exit_reason ?? '').replace(/^stop:/, '')}`
          : `${ended.status}: ${ended.exit_reason ?? ''}`,
  };
}

const followUp = (tags: Scene['tags']): AutomationDocumentInput => ({
  name: 'Follow up',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'is_ada',
  steps: {
    is_ada: {
      type: 'condition',
      config: { if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' } },
      next: { yes: 'mark_vip', no: 'pause' },
    },
    mark_vip: { type: 'tag.add', config: { tag: tags.vip }, next: 'pause' },
    pause: { type: 'wait', config: { duration: 'P2D' }, next: 'hear_back' },
    hear_back: {
      type: 'wait.event',
      config: { event: 'tag.added', timeout: 'P1D' },
      next: { received: 'thank', timed_out: 'nudge' },
    },
    thank: { type: 'tag.add', config: { tag: tags.thanked } },
    nudge: { type: 'tag.add', config: { tag: tags.nudged }, next: 'last_pause' },
    last_pause: { type: 'wait', config: { duration: 'PT6H' } },
  },
});

it.each([
  ['nothing happens, so the wait for an event times out', 'Ada', [], 'nudge'],
  [
    'the awaited event arrives in time, so the received branch is taken',
    'Ada',
    [tagged('P2DT6H', 'replied')],
    'thank',
  ],
  [
    'the event comes before the wait for it began, so it does not count',
    'Ada',
    [tagged('P1D', 'replied')],
    'nudge',
  ],
  ['the condition is false, so the other branch is taken', 'Grace', [], 'nudge'],
] as const)(
  'a test run and a real run take the same steps when %s',
  async (_, firstName, happenings, reaches) => {
    const s = await scene(followUp, firstName);
    const trace = dry(await testRun(s, happenings));
    expect(await real(s, happenings)).toEqual(trace);
    // Not a vacuous match: the run went where this case says, and waited on the way.
    expect(trace.end).toBe('completed');
    expect(trace.steps.map((each) => each.step)).toContain(reaches);
    expect(trace.steps.filter((each) => each.step === 'hear_back')).toHaveLength(2);
  },
);

it('a test run and a real run stop at the same point when a stop event comes mid-wait', async () => {
  const s = await scene((tags) => ({
    name: 'Until tagged',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    stopWhen: [{ event: 'tag.added' }],
    start: 'pause',
    steps: {
      pause: { type: 'wait', config: { duration: 'P2D' }, next: 'mark' },
      mark: { type: 'tag.add', config: { tag: tags.vip } },
    },
  }));
  const happenings = [tagged('P1D', 'replied')];
  const trace = dry(await testRun(s, happenings));
  expect(trace).toMatchObject({ end: 'stopped by tag.added', steps: [{ step: 'pause' }] });
  expect(await real(s, happenings)).toEqual(trace);
});

it("a test run on a contact uses the contact's own time zone when the automation says so, as a real run does", async () => {
  const s = await scene(() => ({
    name: 'On the day',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'until_the_day',
    steps: {
      until_the_day: {
        type: 'wait.until',
        config: { field: 'contact.custom.event_date', time: '09:00', direction: 'before' },
      },
    },
    settings: { timezone: 'contact' },
  }));
  await database.withTenant(s.context, async (sql) => {
    const field = await sql.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), id, 'event_date', 'Event date', 'The day of the event.',
              'date', 'system'
       from crm.object_types where kind = 'contact'
       returning id`,
    );
    await sql.query(
      `insert into crm.field_values
         (business_id, record_id, field_id, value_type, value_date, source_kind)
       values (app.business_id(), $2::uuid, $1::uuid, 'date', date '2031-03-10', 'system')`,
      [field.id, s.contactId],
    );
    await sql.query("update crm.contacts set timezone = 'Asia/Tokyo' where id = $1", [s.contactId]);
  });
  const trace = dry(await testRun(s, []));
  // 09:00 on the day in Tokyo, which is midnight UTC: not 09:00 in the business's zone.
  expect(trace.steps).toMatchObject([
    { step: 'until_the_day', explanation: 'Waiting until 2031-03-10T00:00:00.000Z.' },
    {
      step: 'until_the_day',
      explanation: 'The time came (2031-03-10T00:00:00.000Z), so it went on.',
    },
  ]);
  expect(await real(s, [])).toEqual(trace);
});

it('a test run fails where a real run would, at a step the engine cannot run', async () => {
  const s = await scene((tags) => ({
    name: 'Tag, then ask the AI',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'mark',
    steps: {
      mark: { type: 'tag.add', config: { tag: tags.vip }, next: 'tell' },
      tell: { type: 'ai.ask', config: { prompt: 'What did they ask for?' } },
    },
  }));
  const run = await testRun(s, []);
  expect(run.status).toBe('failed');
  expect(run.outcome).toEqual({ kind: 'failed', step: 'tell', error: 'not_implemented' });
  const trace = dry(run);
  expect(trace).toEqual({
    steps: [{ step: 'mark', at: START.toISOString(), action: true }],
    end: 'failed: not_implemented',
  });
  expect(await real(s, [])).toEqual(trace);
});

it.each([
  { fields: { 'contact.firstName': ' Grace ' }, field: 'contact.firstName', value: 'Grace' },
  { fields: { 'contact.lastName': ' Hopper ' }, field: 'contact.name', value: 'Ada Hopper' },
  {
    fields: { 'contact.phone': '+254 712 345678' },
    field: 'contact.phone',
    value: '+254712345678',
  },
  {
    fields: { 'contact.email': ' GRACE@Example.test ' },
    field: 'contact.email',
    value: 'grace@example.test',
  },
])(
  'a simulated contact change takes the same literal downstream route as the real engine %#',
  async ({ fields, field, value }) => {
    const s = await scene((tags) => ({
      name: 'Change then route',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'change',
      steps: {
        change: { type: 'contact.update', config: { fields }, next: 'check' },
        check: {
          type: 'condition',
          config: { if: { field, operator: 'equals', value } },
          next: { yes: 'matched', no: 'stale' },
        },
        matched: { type: 'tag.add', config: { tag: tags.vip } },
        stale: { type: 'tag.add', config: { tag: tags.nudged } },
      },
    }));
    const before = await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId));
    const trace = dry(await testRun(s, []));
    expect(trace.end).toBe('completed');
    expect(trace.steps.map((step) => step.step)).toEqual(['change', 'check', 'matched']);
    expect(trace.steps[1]).toMatchObject({ branch: 'yes' });
    expect(await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId))).toEqual(
      before,
    );
    const actual = await real(s, []);
    expect(actual.end).toBe('completed');
    expect(actual.steps.map((step) => step.step)).toEqual(['change', 'check', 'matched']);
    expect(actual.steps[1]).toMatchObject({ branch: 'yes' });
    expect(actual).toEqual(trace);
  },
);

it('simulated tag additions and removals drive the same real condition route', async () => {
  const s = await scene((tags) => ({
    name: 'Tag then remove',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'add',
    steps: {
      add: { type: 'tag.add', config: { tag: tags.vip }, next: 'remove' },
      remove: { type: 'tag.remove', config: { tag: tags.vip }, next: 'check' },
      check: {
        type: 'condition',
        config: { if: { field: 'contact.tags', operator: 'excludes', value: 'VIP' } },
        next: { yes: 'matched', no: 'stale' },
      },
      matched: { type: 'tag.add', config: { tag: tags.thanked } },
      stale: { type: 'tag.add', config: { tag: tags.nudged } },
    },
  }));
  const trace = dry(await testRun(s, []));
  expect(trace.steps.map((step) => step.step)).toEqual(['add', 'remove', 'check', 'matched']);
  expect(
    (await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId)))['contact.tags'],
  ).toEqual([]);
  const actual = await real(s, []);
  expect(actual.steps.map((step) => step.step)).toEqual(['add', 'remove', 'check', 'matched']);
  expect(actual).toEqual(trace);
  expect(
    (await withTenant(db, s.context, (trx) => contactValues(trx, s.contactId)))['contact.tags'],
  ).toEqual(['Thanked']);
});

it('simulated note and task outputs support the same native follow-up route as real outputs', async () => {
  const s = await scene(() => ({
    name: 'Native output chain',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'note',
    steps: {
      note: { type: 'note.create', config: { text: 'Call {{contact.firstName}}.' }, next: 'task' },
      task: {
        type: 'task.create',
        config: { title: 'Review {{steps.note.noteId}}' },
        next: 'followup',
      },
      followup: { type: 'note.create', config: { text: 'Follow task {{steps.task.taskId}}.' } },
    },
  }));
  const counts = () =>
    database.withTenant(s.context, (sql) =>
      sql.query<{ notes: number; tasks: number }>(
        'select (select count(*)::int from crm.notes) as notes, (select count(*)::int from crm.tasks) as tasks',
      ),
    );
  expect(await counts()).toEqual([{ notes: 0, tasks: 0 }]);
  const simulated = await testRun(s, []);
  expect(simulated.steps).toMatchObject([
    { step: 'note', simulated: true, output: { noteId: 'simulated:note:note:1' } },
    { step: 'task', simulated: true, output: { taskId: 'simulated:task:task:2' } },
    { step: 'followup', simulated: true, output: { noteId: 'simulated:note:followup:3' } },
  ]);
  const trace = dry(simulated);
  expect(trace.end).toBe('completed');
  expect(trace.steps.map((step) => step.step)).toEqual(['note', 'task', 'followup']);
  expect(await counts()).toEqual([{ notes: 0, tasks: 0 }]);
  const actual = await real(s, []);
  expect(actual.end).toBe('completed');
  expect(actual.steps.map((step) => step.step)).toEqual(['note', 'task', 'followup']);
  expect(actual).toEqual(trace);
  expect(await counts()).toEqual([{ notes: 2, tasks: 1 }]);
});
