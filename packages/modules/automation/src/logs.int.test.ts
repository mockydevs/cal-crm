// The enrollment history and the execution logs as lists. Both read the engine's own rows
// (automation.enrolments and automation.step_runs): filtered by status, dates, record,
// trigger, step and type, paged from a cursor, and never across businesses. Real Postgres;
// the runs are made by the engine's own commands.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { HISTORY_PAGE_SIZE, readRun, readRuns, readStepRuns } from './history.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

// A tag put on a record, as the CRM's own command tells of it.
const emitTagAssigned = defineCommand({
  name: 'test.tag_assigned',
  permission: 'contacts.manage',
  input: z.strictObject({ recordId: z.uuid(), tagId: z.string() }),
  async handle(_trx, input, command) {
    return command.emit({
      type: 'tag.assigned',
      subject: { kind: 'tag', id: randomUUID() },
      records: [input.recordId],
      payload: { tagId: input.tagId },
    });
  },
});

const HOUR = 3_600_000;
const T0 = new Date('2031-03-03T09:00:00Z');
const after = (ms: number) => new Date(T0.getTime() + ms);

async function tagOf(tenant: Tenant): Promise<{ id: string; publicId: string }> {
  const [tag] = await h.database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `insert into crm.tags (business_id, name, created_by_kind) values ($1, $2, 'user') returning id`,
      [tenant.businessId, `Tag ${randomUUID()}`],
    ),
  );
  const id = tag?.id ?? '';
  return { id, publicId: toPublicId('tag', id) };
}

/** Ada waits an hour and is tagged; anyone else reaches a step that cannot run. */
const sorting = (tag: string): AutomationDocumentInput => ({
  name: 'Sorting',
  triggers: [
    { id: 'created', type: 'contact.created', config: {} },
    { id: 'tagged', type: 'tag.added', config: { tag } },
  ],
  start: 'is_ada',
  steps: {
    is_ada: {
      type: 'condition',
      label: 'Is it Ada?',
      config: { if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' } },
      next: { yes: 'pause', no: 'tell' },
    },
    pause: { type: 'wait', label: 'An hour', config: { duration: 'PT1H' }, next: 'mark' },
    mark: { type: 'tag.add', config: { tag } },
    tell: { type: 'team.notify', config: { message: 'Not Ada.' } },
  },
});

/** When each of these runs is said to have started, as an import or a repair would set it. */
const startedAt = (enrolments: Readonly<Record<string, string>>) =>
  h.database.as('crm_owner', async (sql) => {
    for (const [enrolmentId, at] of Object.entries(enrolments))
      await sql.query('update automation.enrolments set started_at = $2 where id = $1', [
        enrolmentId,
        at,
      ]);
  });

it('lists the enrollment history with each run’s trigger and where it stands, filtered every way', async () => {
  const tenant = await h.business();
  const tag = await tagOf(tenant);
  const { id } = await h.publish(tenant, sorting(tag.publicId));
  const ada = await h.enrol(tenant, 'Ada');
  const grace = await h.enrol(tenant, 'Grace');
  // Joan is enrolled by the other trigger: the tag, put on her.
  const joan = await h.contact(tenant, 'Joan');
  const tagged = await runCommand(
    h.services,
    emitTagAssigned,
    { recordId: joan.contactId, tagId: tag.publicId },
    { context: { ...tenant, correlationId: randomUUID() }, permissions: 'all' },
  );
  expect(await h.match(tenant, tagged)).toMatchObject({ enrolled: 1 });
  const [joanRow] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      joan.contactId,
    ]),
  );
  const [adaRun = ''] = ada.enrolments;
  const [graceRun = ''] = grace.enrolments;
  const joanRun = joanRow?.id ?? '';
  await startedAt({
    [adaRun]: '2031-03-01T10:00:00Z',
    [graceRun]: '2031-03-02T10:00:00Z',
    [joanRun]: '2031-03-03T10:00:00Z',
  });
  // Ada is waiting her hour; Grace has not taken a step; Joan went through and failed.
  await h.step(tenant, adaRun, T0);
  await h.step(tenant, adaRun, T0);
  await h.step(tenant, joanRun, T0);
  await h.step(tenant, joanRun, T0);

  const runId = (enrolmentId: string) => toPublicId('automation_enrolment', enrolmentId);
  const [A, G, J] = [runId(adaRun), runId(graceRun), runId(joanRun)];
  const list = (query: Parameters<typeof readRuns>[2] = {}) =>
    withTenant(h.db, tenant, (trx) => readRuns(trx, id, query));
  const ids = async (query: Parameters<typeof readRuns>[2]) =>
    (await list(query)).items.map((run) => run.id);

  // Newest first by when each started, with everything the tab's columns show.
  expect((await list()).items).toMatchObject([
    {
      id: J,
      status: 'failed',
      exitReason: 'not_implemented',
      startedAt: '2031-03-03T10:00:00.000Z',
      record: { id: joan.contact, name: 'Joan', trashed: false },
      trigger: { id: 'tagged', type: 'tag.added' },
      currentAction: null,
      wakeAt: null,
    },
    {
      id: G,
      status: 'running',
      record: { id: grace.contact, name: 'Grace' },
      trigger: { id: 'created', type: 'contact.created' },
      // Not yet begun: its next step is its first.
      currentAction: { step: 'is_ada', type: 'condition', label: 'Is it Ada?' },
      wakeAt: null,
    },
    {
      id: A,
      status: 'waiting',
      record: { id: ada.contact, name: 'Ada' },
      trigger: { id: 'created', type: 'contact.created' },
      // Waiting at the wait itself, though the step it runs next is the one after.
      currentStep: 'mark',
      currentAction: { step: 'pause', type: 'wait', label: 'An hour' },
      wakeAt: after(HOUR).toISOString(),
    },
  ]);
  // One run read by itself says the same.
  expect(await withTenant(h.db, tenant, (trx) => readRun(trx, A))).toMatchObject({
    trigger: { id: 'created', type: 'contact.created' },
    currentAction: { step: 'pause', type: 'wait', label: 'An hour' },
  });

  expect(await ids({ status: 'waiting' })).toEqual([A]);
  expect(await ids({ status: 'failed' })).toEqual([J]);
  expect(await ids({ status: 'completed' })).toEqual([]);
  // From a moment, that moment included; to a moment, that moment left out.
  expect(await ids({ from: '2031-03-02T10:00:00Z' })).toEqual([J, G]);
  expect(await ids({ to: '2031-03-02T10:00:00Z' })).toEqual([A]);
  expect(await ids({ from: '2031-03-02T00:00:00Z', to: '2031-03-03T00:00:00Z' })).toEqual([G]);
  expect(await ids({ from: '2031-03-02T12:00:00+03:00', to: '2031-03-02T14:00:00+03:00' })).toEqual(
    [G],
  );
  expect(await ids({ record: ada.contact })).toEqual([A]);
  expect(await ids({ trigger: 'tagged' })).toEqual([J]);
  expect(await ids({ trigger: 'created' })).toEqual([G, A]);
  expect(await ids({ trigger: 'webhook' })).toEqual([]);
  expect(await ids({ trigger: 'created', status: 'running' })).toEqual([G]);
  expect(await ids({ record: ada.contact, status: 'failed' })).toEqual([]);

  // Another business reads none of it: not the automation, and not by a record of ours.
  const elsewhere = await h.business();
  await expect(withTenant(h.db, elsewhere, (trx) => readRuns(trx, id, {}))).rejects.toBeInstanceOf(
    NotFoundError,
  );
  const theirs = await h.publish(elsewhere, sorting((await tagOf(elsewhere)).publicId));
  expect(
    await withTenant(h.db, elsewhere, (trx) => readRuns(trx, theirs.id, { record: ada.contact })),
  ).toEqual({ items: [], nextCursor: null });
  expect(await ids({ record: 'someone' })).toEqual([]);
});

it('pages the enrollment history from a cursor, through runs that started at the same moment', async () => {
  const tenant = await h.business();
  const tag = await tagOf(tenant);
  const { id, automationId, versionId } = await h.publish(tenant, sorting(tag.publicId));
  const early = await h.enrol(tenant, 'Ada');
  await startedAt({ [early.enrolments[0] ?? '']: '2031-03-01T10:00:00Z' });
  // More than a page of runs made by one statement, so all started at one moment.
  const extra = HISTORY_PAGE_SIZE + 5;
  await h.database.withTenant(tenant, async (sql) => {
    await sql.query(
      `with record as (
         insert into crm.records (business_id, kind, object_type_id)
         select app.business_id(), 'contact', object_type.id
         from crm.object_types as object_type, generate_series(1, $1::int)
         where object_type.kind = 'contact'
         returning id)
       insert into crm.contacts (business_id, id, first_name, created_by_kind)
       select app.business_id(), id, 'Guest', 'system' from record`,
      [extra],
    );
    await sql.query(
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, reentry_key, current_step,
          trigger_key, correlation_id, started_at)
       select app.business_id(), $1::uuid, $2::uuid, id, id, 'is_ada', 'created', uuidv7(),
              '2031-03-02T10:00:00Z'
       from crm.contacts where first_name = 'Guest'`,
      [automationId, versionId],
    );
  });
  const list = (query: Parameters<typeof readRuns>[2]) =>
    withTenant(h.db, tenant, (trx) => readRuns(trx, id, query));
  const first = await list({});
  expect(first.items).toHaveLength(HISTORY_PAGE_SIZE);
  expect(first.nextCursor).toBe(first.items.at(-1)?.id);
  const rest = await list({ after: first.nextCursor ?? '' });
  // The five left of that moment, then the one from the day before; none seen twice.
  expect(rest.items).toHaveLength(6);
  expect(rest.nextCursor).toBeNull();
  expect(rest.items.at(-1)).toMatchObject({ startedAt: '2031-03-01T10:00:00.000Z' });
  const seen = [...first.items, ...rest.items].map((run) => run.id);
  expect(new Set(seen).size).toBe(extra + 1);
  // Runs that started together keep the order they were made in, newest first.
  expect(first.items.map((run) => run.id)).toEqual(
    first.items
      .map((run) => run.id)
      .toSorted()
      .reverse(),
  );
  // The same when the list is narrowed by something no index is ordered by.
  const running = await list({ status: 'running' });
  expect(running.items.map((run) => run.id)).toEqual(first.items.map((run) => run.id));
  expect(
    (await list({ status: 'running', after: running.nextCursor ?? '' })).items.map((run) => run.id),
  ).toEqual(rest.items.map((run) => run.id));
  // A filter pages the same way.
  const filtered = await list({ from: '2031-03-02T00:00:00Z', after: first.nextCursor ?? '' });
  expect(filtered.items).toHaveLength(5);

  await expect(list({ after: 'the-second-page' })).rejects.toMatchObject({
    issues: [{ path: '/after', code: 'invalid_cursor' }],
  });
  // A run that has since gone, with its record, is no place to continue from.
  const gone = first.items.at(-1)?.id ?? '';
  await h.database.as('crm_owner', (sql) =>
    sql.query(
      'delete from crm.records where id = (select record_id from automation.enrolments where id = $1)',
      [parsePublicId('automation_enrolment', gone)],
    ),
  );
  await expect(list({ after: gone })).rejects.toMatchObject({
    issues: [
      {
        path: '/after',
        code: 'invalid_cursor',
        message: 'That run is no longer there to continue from. Start the list again.',
      },
    ],
  });
});

it('lists the execution logs: every step taken, with its record, its run and what it did', async () => {
  const tenant = await h.business();
  const tag = await tagOf(tenant);
  const { id, automationId } = await h.publish(tenant, sorting(tag.publicId));
  const ada = await h.enrol(tenant, 'Ada');
  const grace = await h.enrol(tenant, 'Grace');
  const [adaRun = ''] = ada.enrolments;
  const [graceRun = ''] = grace.enrolments;
  // Ada: the condition, the wait, the tag. Grace: the condition, then the step that fails.
  await h.step(tenant, adaRun, T0);
  await h.step(tenant, adaRun, T0);
  await h.step(tenant, graceRun, T0);
  await h.step(tenant, graceRun, T0);
  await h.step(tenant, adaRun, after(HOUR + 1000));
  // When each step is said to have begun: an hour apart from the start of today, oldest
  // first, in the order taken. Today, because the table has partitions for these months.
  const taken = await h.database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      'select id from automation.step_runs where automation_id = $1 order by started_at, id',
      [automationId],
    ),
  );
  expect(taken).toHaveLength(5);
  const { day } = await h.database.as('crm_owner', async (sql) => {
    for (const [position, row] of taken.entries())
      await sql.query(
        `update automation.step_runs
         set started_at = date_trunc('day', now()) + make_interval(hours => $2::int)
         where id = $1`,
        [row.id, position],
      );
    return sql.one<{ day: Date }>(`select date_trunc('day', now()) as day`);
  });
  const at = (hours: number) => new Date(day.getTime() + hours * HOUR).toISOString();

  const list = (query: Parameters<typeof readStepRuns>[2] = {}) =>
    withTenant(h.db, tenant, (trx) => readStepRuns(trx, id, query));
  const steps = async (query: Parameters<typeof readStepRuns>[2]) =>
    (await list(query)).items.map((step) => [step.record.name, step.step, step.status]);

  const all = await list();
  expect(all.nextCursor).toBeNull();
  // Newest first. Each row has what the tab's columns show, and what its details open.
  expect(all.items).toMatchObject([
    {
      runId: toPublicId('automation_enrolment', adaRun),
      version: 1,
      step: 'mark',
      type: 'tag.add',
      label: null,
      status: 'succeeded',
      explanation: 'The tag was added.',
      error: null,
      startedAt: at(4),
      record: { id: ada.contact, name: 'Ada', trashed: false },
    },
    {
      runId: toPublicId('automation_enrolment', graceRun),
      step: 'tell',
      type: 'team.notify',
      status: 'failed',
      error: { code: 'not_implemented' },
      input: { config: { message: 'Not Ada.' } },
      startedAt: at(3),
      record: { id: grace.contact, name: 'Grace' },
    },
    {
      step: 'is_ada',
      type: 'condition',
      label: 'Is it Ada?',
      status: 'succeeded',
      branch: 'no',
      input: { values: { 'contact.firstName': 'Grace' } },
      startedAt: at(2),
      record: { name: 'Grace' },
    },
    {
      step: 'pause',
      type: 'wait',
      label: 'An hour',
      // The wait is over: the run went on from it, so it is no longer waiting.
      status: 'succeeded',
      output: { wakeAt: after(HOUR).toISOString() },
      startedAt: at(1),
      record: { name: 'Ada' },
    },
    {
      step: 'is_ada',
      status: 'succeeded',
      branch: 'yes',
      startedAt: at(0),
      record: { name: 'Ada' },
    },
  ]);
  for (const step of all.items) {
    expect(step.id).toMatch(/^astep_/);
    expect(step.finishedAt).toEqual(expect.any(String));
    expect(Object.keys(step.input)).not.toContain('sequence');
  }

  expect(await steps({ status: 'failed' })).toEqual([['Grace', 'tell', 'failed']]);
  expect(await steps({ status: 'waiting' })).toEqual([]);
  expect(await steps({ step: 'is_ada' })).toEqual([
    ['Grace', 'is_ada', 'succeeded'],
    ['Ada', 'is_ada', 'succeeded'],
  ]);
  expect(await steps({ type: 'wait' })).toEqual([['Ada', 'pause', 'succeeded']]);
  expect(await steps({ type: 'email.send' })).toEqual([]);
  expect(await steps({ record: ada.contact })).toEqual([
    ['Ada', 'mark', 'succeeded'],
    ['Ada', 'pause', 'succeeded'],
    ['Ada', 'is_ada', 'succeeded'],
  ]);
  expect(await steps({ record: ada.contact, type: 'condition' })).toEqual([
    ['Ada', 'is_ada', 'succeeded'],
  ]);
  // From a moment, included; to a moment, left out.
  expect(await steps({ from: at(3) })).toEqual([
    ['Ada', 'mark', 'succeeded'],
    ['Grace', 'tell', 'failed'],
  ]);
  expect(await steps({ to: at(1) })).toEqual([['Ada', 'is_ada', 'succeeded']]);
  expect(await steps({ from: at(1), to: at(3) })).toEqual([
    ['Grace', 'is_ada', 'succeeded'],
    ['Ada', 'pause', 'succeeded'],
  ]);
  // From a cursor: what is older than that step.
  expect((await list({ after: all.items[2]?.id ?? '' })).items.map((step) => step.step)).toEqual([
    'pause',
    'is_ada',
  ]);

  // Another business reads none of it.
  const elsewhere = await h.business();
  await expect(
    withTenant(h.db, elsewhere, (trx) => readStepRuns(trx, id, {})),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await steps({ record: 'someone' })).toEqual([]);
  await expect(
    withTenant(h.db, tenant, (trx) => readStepRuns(trx, 'the-newsletter', {})),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('pages the execution logs from a cursor, and takes no cursor that is not a step of this automation', async () => {
  const tenant = await h.business();
  const tag = await tagOf(tenant);
  const { id, automationId } = await h.publish(tenant, sorting(tag.publicId));
  const other = await h.publish(tenant, { ...sorting(tag.publicId), name: 'Other' });
  const { enrolments } = await h.enrol(tenant, 'Grace');
  // Both automations took Grace through two steps.
  for (const enrolmentId of enrolments) {
    await h.step(tenant, enrolmentId, T0);
    await h.step(tenant, enrolmentId, T0);
  }
  const [ours] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where automation_id = $1', [
      automationId,
    ]),
  );
  // More than a page more, written by one statement, so all began at one moment.
  const extra = HISTORY_PAGE_SIZE + 3;
  await h.database.withTenant(tenant, (sql) =>
    sql.query(
      `insert into automation.step_runs (business_id, enrolment_id, step_key, status, input, finished_at)
       select app.business_id(), $1::uuid, 'is_ada', 'succeeded', '{"type": "condition"}', now()
       from generate_series(1, $2::int)`,
      [ours?.id, extra],
    ),
  );
  const list = (query: Parameters<typeof readStepRuns>[2], of = id) =>
    withTenant(h.db, tenant, (trx) => readStepRuns(trx, of, query));
  const first = await list({});
  expect(first.items).toHaveLength(HISTORY_PAGE_SIZE);
  expect(first.nextCursor).toBe(first.items.at(-1)?.id);
  const rest = await list({ after: first.nextCursor ?? '' });
  expect(rest.items).toHaveLength(5);
  expect(rest.nextCursor).toBeNull();
  expect(new Set([...first.items, ...rest.items].map((step) => step.id)).size).toBe(extra + 2);
  // The other automation's steps are its own.
  const theirs = await list({}, other.id);
  expect(theirs.items.map((step) => step.step)).toEqual(['tell', 'is_ada']);

  await expect(list({ after: 'the-second-page' })).rejects.toMatchObject({
    issues: [{ path: '/after', code: 'invalid_cursor' }],
  });
  await expect(list({ after: theirs.items[0]?.id ?? '' })).rejects.toMatchObject({
    issues: [{ path: '/after', code: 'invalid_cursor' }],
  });
});
