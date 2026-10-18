// History (AUTOMATIONS.md section 5): a run shows every step it took, and versions
// and runs are read a page at a time, newest first, from a cursor. Real Postgres, with the
// engine's own command running the steps.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { automationDocument, type AutomationDocumentInput } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError, toPublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { HISTORY_PAGE_SIZE, readRecordRuns, readRun, readRuns, readVersions } from './history.js';
import { createRunStepCommand } from './runner.js';
import { contactValues } from './values.js';

// This automation creates no tasks, so nothing here resolves an assignee.
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

const document: AutomationDocumentInput = {
  name: 'Follow-up',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'pause',
  steps: {
    pause: { type: 'wait', config: { duration: 'P1D' }, next: 'settle' },
    settle: { type: 'wait', config: { duration: 'PT1M' } },
  },
};

type BusinessContext = TenantContext & { readonly businessId: string };

async function newBusiness(): Promise<BusinessContext> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return { ...business.context, businessId: business.id, correlationId: randomUUID() };
}

interface Published {
  readonly context: BusinessContext;
  /** The automation's stored id, and the id the API shows for it. */
  readonly automationId: string;
  readonly id: string;
  readonly versionId: string;
}

/** Publishes an automation once in a business: a new business, unless one is given. */
async function published(
  written: AutomationDocumentInput = document,
  within?: BusinessContext,
): Promise<Published> {
  const context = within ?? (await newBusiness());
  return withTenant(db, context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: context.businessId,
        name: written.name,
        draft: JSON.stringify(written),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { versionId } = await publishAutomationVersion(
      trx,
      context,
      id,
      automationDocument.parse(written),
      'First',
    );
    return { context, automationId: id, id: toPublicId('automation', id), versionId };
  });
}

/**
 * Creates a contact through the CRM's own command, and enrols it from its real event in
 * every automation published in the business. Returns each enrolment, in the order made.
 */
async function enrolAll(
  context: TenantContext,
  contact: { firstName: string; lastName?: string } = { firstName: 'Ada' },
): Promise<{ readonly contactId: string; readonly enrolments: readonly string[] }> {
  await runCommand(
    services,
    createContactCommand,
    { ...contact, emails: [`${randomUUID()}@example.test`] },
    { context, permissions: 'all' },
  );
  return withTenant(db, context, async (trx) => {
    const event = await trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .orderBy('recorded_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const { enrolled } = await matchEvent(trx, context, event.id, contactValues);
    return { contactId: event.subject_id, enrolments: enrolled.map((each) => each.enrolmentId) };
  });
}

async function enrol(context: TenantContext): Promise<string> {
  const [first] = (await enrolAll(context)).enrolments;
  if (first === undefined) throw new Error('Nothing enrolled.');
  return first;
}

const step = (context: TenantContext, enrolmentId: string, sequence: number, now: Date) =>
  runCommand(
    services,
    runStepCommand,
    { enrolmentId, sequence, now: now.toISOString() },
    { context: { ...context, correlationId: randomUUID() }, permissions: 'all' },
  );

it('shows each step a run took, in order, when it next wakes and when it ended', async () => {
  const { context, id } = await published();
  const enrolmentId = await enrol(context);
  const runId = toPublicId('automation_enrolment', enrolmentId);
  const read = () => withTenant(db, context, (trx) => readRun(trx, runId));
  const start = new Date();

  expect(await step(context, enrolmentId, 0, start)).toBe('ran');
  const waiting = await read();
  expect(waiting).toMatchObject({
    id: runId,
    automationId: id,
    version: 1,
    status: 'waiting',
    currentStep: 'settle',
    finishedAt: null,
    steps: [{ step: 'pause', status: 'waiting', branch: null, error: null, attempt: 1 }],
  });
  expect(waiting.steps[0]?.explanation).toMatch(/^Waiting /);
  // The wait is a day long, and the run says when it is over. Until then the step is
  // waiting and not finished, and the run is at the wait, not at the step after it.
  const wakeAt = new Date(waiting.wakeAt ?? 0);
  expect(wakeAt.getTime() - start.getTime()).toBe(86_400_000);
  expect(waiting.steps[0]?.finishedAt).toBeNull();
  expect(waiting.currentAction).toEqual({ step: 'pause', type: 'wait', label: null });
  expect(waiting.trigger).toEqual({ id: 'created', type: 'contact.created' });

  const afterPause = new Date(wakeAt.getTime() + 1000);
  expect(await step(context, enrolmentId, 1, afterPause)).toBe('ran');
  expect(await step(context, enrolmentId, 2, new Date(afterPause.getTime() + 120_000))).toBe('ran');
  const ended = await read();
  expect(ended).toMatchObject({
    status: 'completed',
    currentStep: null,
    wakeAt: null,
    exitReason: null,
  });
  expect(ended.finishedAt).toEqual(expect.any(String));
  // A wait the run went on from is no longer waiting: it succeeded, and says when.
  expect(ended.steps.map((each) => [each.step, each.status])).toEqual([
    ['pause', 'succeeded'],
    ['settle', 'succeeded'],
  ]);
  for (const each of ended.steps) expect(each.finishedAt).toEqual(expect.any(String));
  expect(ended.currentAction).toBeNull();
});

it('continues the list of runs from a cursor, and refuses a cursor that is not a run', async () => {
  const { context, id } = await published();
  const older = toPublicId('automation_enrolment', await enrol(context));
  const newer = toPublicId('automation_enrolment', await enrol(context));
  const runs = (after?: string) =>
    withTenant(db, context, (trx) => readRuns(trx, id, { after })).then((list) => ({
      ids: list.items.map((run) => run.id),
      nextCursor: list.nextCursor,
    }));
  expect(await runs()).toEqual({ ids: [newer, older], nextCursor: null });
  expect(await runs(newer)).toEqual({ ids: [older], nextCursor: null });
  expect(await runs(older)).toEqual({ ids: [], nextCursor: null });
  await expect(runs('the-second-page')).rejects.toMatchObject({
    name: 'ValidationError',
    issues: [{ path: '/after', code: 'invalid_cursor' }],
  });
});

it('reads versions and runs a page at a time, and says where the next page starts', async () => {
  const { context, automationId, id, versionId } = await published();
  const extra = HISTORY_PAGE_SIZE;
  await database.withTenant(context, async (sql) => {
    // Fifty more versions, and one more contact in the automation than a page holds.
    await sql.query(
      `insert into automation.versions
         (business_id, automation_id, version, document, published_by_kind)
       select app.business_id(), $1::uuid, later.version, $2::jsonb, 'system'
       from generate_series(2, $3::int) as later (version)`,
      [automationId, JSON.stringify(document), extra + 1],
    );
    await sql.query(
      `with record as (
         insert into crm.records (business_id, kind, object_type_id)
         select app.business_id(), 'contact', object_type.id
         from crm.object_types as object_type, generate_series(1, $1::int)
         where object_type.kind = 'contact'
         returning id
       )
       insert into crm.contacts (business_id, id, first_name, created_by_kind)
       select app.business_id(), id, 'Guest', 'system' from record`,
      [extra + 1],
    );
    await sql.query(
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, reentry_key, current_step,
          correlation_id)
       select app.business_id(), $1::uuid, $2::uuid, id, id, 'pause', uuidv7() from crm.contacts`,
      [automationId, versionId],
    );
  });

  const versions = (after?: number) =>
    withTenant(db, context, (trx) => readVersions(trx, id, { after }));
  const firstVersions = await versions();
  expect(firstVersions.items.map((version) => version.version)).toEqual(
    Array.from({ length: extra }, (_, position) => extra + 1 - position),
  );
  expect(firstVersions.nextCursor).toBe(2);
  expect(await versions(2)).toMatchObject({
    items: [{ version: 1, changeSummary: 'First' }],
    nextCursor: null,
  });

  const runs = (after?: string) => withTenant(db, context, (trx) => readRuns(trx, id, { after }));
  const firstRuns = await runs();
  expect(firstRuns.items).toHaveLength(extra);
  const last = firstRuns.items.at(-1)?.id;
  expect(firstRuns.nextCursor).toBe(last);
  const rest = await runs(last);
  expect(rest.items).toHaveLength(1);
  expect(rest.nextCursor).toBeNull();
  expect(firstRuns.items.map((run) => run.id)).not.toContain(rest.items[0]?.id);
});

it('finds no automation or run under something that is not an id', async () => {
  const { context } = await published();
  await expect(
    withTenant(db, context, (trx) => readVersions(trx, 'welcome', {})),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    withTenant(db, context, (trx) => readRuns(trx, 'welcome', {})),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(withTenant(db, context, (trx) => readRun(trx, 'latest'))).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

it('shows what each step was given, the branch it took and why', async () => {
  const { context, id } = await published({
    name: 'Sort by name',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'named',
    steps: {
      named: {
        type: 'condition',
        config: {
          if: {
            all: [
              { field: 'contact.firstName', operator: 'equals', value: 'Ada' },
              { not: { field: 'contact.lastName', operator: 'is_set' } },
            ],
          },
        },
        next: { yes: 'pause', no: 'pause' },
      },
      pause: { type: 'wait', config: { duration: 'P1D' } },
    },
  });
  const enrolmentId = await enrol(context);
  const start = new Date();
  expect(await step(context, enrolmentId, 0, start)).toBe('ran');
  expect(await step(context, enrolmentId, 1, start)).toBe('ran');
  const run = await withTenant(db, context, (trx) =>
    readRun(trx, toPublicId('automation_enrolment', enrolmentId)),
  );
  expect(run).toMatchObject({ automationId: id, automationName: 'Sort by name' });
  expect(run.steps).toMatchObject([
    {
      step: 'named',
      type: 'condition',
      status: 'succeeded',
      // Its settings in the version that ran, and each value it compared, as it was then.
      input: {
        config: {
          if: {
            all: [
              { field: 'contact.firstName', operator: 'equals', value: 'Ada' },
              { not: { field: 'contact.lastName', operator: 'is_set' } },
            ],
          },
        },
        values: { 'contact.firstName': 'Ada', 'contact.lastName': null },
      },
      output: {},
      branch: 'yes',
      explanation: 'The condition was true, so the yes branch was taken.',
      error: null,
    },
    {
      step: 'pause',
      type: 'wait',
      status: 'waiting',
      input: { config: { duration: 'P1D' } },
      output: { wakeAt: new Date(start.getTime() + 86_400_000).toISOString() },
      branch: null,
      error: null,
    },
  ]);
  // The engine's own bookkeeping is not part of what the step was given.
  for (const each of run.steps)
    expect(Object.keys(each.input).toSorted()).not.toContain('sequence');
});

it('shows why a step failed, with the code and the reason in words', async () => {
  const { context } = await published({
    name: 'Tell the team',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'tell',
    steps: { tell: { type: 'team.notify', config: { message: 'A new lead came in.' } } },
  });
  const enrolmentId = await enrol(context);
  expect(await step(context, enrolmentId, 0, new Date())).toBe('ran');
  const run = await withTenant(db, context, (trx) =>
    readRun(trx, toPublicId('automation_enrolment', enrolmentId)),
  );
  expect(run).toMatchObject({ status: 'failed', exitReason: 'not_implemented' });
  expect(run.steps).toMatchObject([
    {
      step: 'tell',
      type: 'team.notify',
      status: 'failed',
      input: { config: { message: 'A new lead came in.', to: 'contact_owner' } },
      error: { code: 'not_implemented' },
      explanation: 'This install has no automation notification service.',
    },
  ]);
});

it("lists a record's runs across automations, newest first, each with its automation and record named", async () => {
  const first = await published();
  const second = await published({ ...document, name: 'Second follow-up' }, first.context);
  const { context } = first;
  const ada = await enrolAll(context, { firstName: 'Ada', lastName: 'Lovelace' });
  const grace = await enrolAll(context, { firstName: 'Grace' });
  expect(ada.enrolments).toHaveLength(2);
  const adaId = toPublicId('contact', ada.contactId);

  const list = await withTenant(db, context, (trx) => readRecordRuns(trx, adaId, {}));
  // Enrolment ids are in the order made, so newest first is the reverse.
  expect(list.items.map((run) => run.id)).toEqual(
    [...ada.enrolments].reverse().map((id) => toPublicId('automation_enrolment', id)),
  );
  expect(list.nextCursor).toBeNull();
  expect(new Set(list.items.map((run) => run.automationName))).toEqual(
    new Set(['Follow-up', 'Second follow-up']),
  );
  expect(new Set(list.items.map((run) => run.automationId))).toEqual(
    new Set([first.id, second.id]),
  );
  for (const run of list.items)
    expect(run.record).toEqual({ id: adaId, name: 'Ada Lovelace', trashed: false });
  // Nobody else's runs, and the same paging and filter as an automation's list.
  expect(list.items.map((run) => run.id)).not.toContain(
    toPublicId('automation_enrolment', grace.enrolments[0] ?? ''),
  );
  const [newest, oldest] = list.items;
  expect(
    await withTenant(db, context, (trx) => readRecordRuns(trx, adaId, { after: newest?.id })),
  ).toEqual({ items: [oldest], nextCursor: null });
  expect(
    await withTenant(db, context, (trx) => readRecordRuns(trx, adaId, { status: 'completed' })),
  ).toEqual({ items: [], nextCursor: null });

  // An automation's own list names each run's record too.
  const ofFirst = await withTenant(db, context, (trx) => readRuns(trx, first.id, {}));
  expect(ofFirst.items.map((run) => run.record.name)).toEqual(['Grace', 'Ada Lovelace']);

  // In the trash, the contact still shows what it went through, and says where it is.
  await database.as('postgres', (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [ada.contactId]),
  );
  const trashed = await withTenant(db, context, (trx) => readRecordRuns(trx, adaId, {}));
  expect(trashed.items.map((run) => run.record.trashed)).toEqual([true, true]);
});

it("finds no runs for another business's record, or for something that is not a record", async () => {
  const { context } = await published();
  const ada = await enrolAll(context);
  const elsewhere = await published();
  const adaId = toPublicId('contact', ada.contactId);
  await expect(
    withTenant(db, elsewhere.context, (trx) => readRecordRuns(trx, adaId, {})),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    withTenant(db, context, (trx) => readRecordRuns(trx, 'ada', {})),
  ).rejects.toBeInstanceOf(NotFoundError);
  // A contact that exists but has been through nothing has an empty list, not a 404.
  await database.as('postgres', (sql) => sql.query('delete from automation.enrolments'));
  expect(await withTenant(db, context, (trx) => readRecordRuns(trx, adaId, {}))).toEqual({
    items: [],
    nextCursor: null,
  });
});

it("names a custom object's record in its runs, as any record is named", async () => {
  const { context, id, automationId, versionId } = await published();
  const record = await database.withTenant(context, async (sql) => {
    const object = await sql.one<{ id: string }>(
      `insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                     primary_field_id)
       values (app.business_id(), uuidv7(), 'custom', 'pet', 'Pet', 'Pets', uuidv7())
       returning id`,
    );
    await sql.query(
      `insert into crm.field_definitions (business_id, id, object_type_id, key, label, description,
                                          value_type, folder_id, created_by_kind)
       select app.business_id(), o.primary_field_id, o.id, 'pet_name', 'Pet name', 'Its name.',
              'text', f.id, 'system'
       from crm.object_types o join crm.field_folders f on f.object_type_id = o.id
       where o.id = $1 limit 1`,
      [object.id],
    );
    const made = await sql.one<{ id: string }>(
      `insert into crm.records (business_id, kind, object_type_id)
       values (app.business_id(), 'custom', $1) returning id`,
      [object.id],
    );
    await sql.query(
      `insert into crm.custom_records (business_id, id, object_type_id, title, created_by_kind)
       values (app.business_id(), $1, $2, 'Buddy', 'system')`,
      [made.id, object.id],
    );
    await sql.query(
      `insert into automation.enrolments (business_id, automation_id, version_id, record_id,
                                          correlation_id, reentry_key)
       values (app.business_id(), $1, $2, $3, $4, $5)`,
      [automationId, versionId, made.id, randomUUID(), randomUUID()],
    );
    return toPublicId('custom', made.id);
  });
  const runs = await withTenant(db, context, (trx) => readRecordRuns(trx, record, {}));
  expect(runs.items.map((run) => run.record)).toEqual([
    { id: record, name: 'Buddy', trashed: false },
  ]);
  expect((await withTenant(db, context, (trx) => readRuns(trx, id, {}))).items[0]?.recordId).toBe(
    record,
  );
});
