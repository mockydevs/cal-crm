// Deleting an automation to the Deleted list, restoring it, and the purge after its days.
// What must hold: nothing new starts a deleted automation, every run still going is
// cancelled, no step of it runs afterwards, and restoring brings back the automation and
// none of its cancelled runs. Real Postgres, the engine's own commands, and real events.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import {
  AUTOMATION_DELETED_DAYS,
  type Automation,
  type AutomationDocumentInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ForbiddenError, NotFoundError, toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  runStepCommand,
  startHarness,
  waitsADay,
  type Harness,
  type Tenant,
} from '../test/workflows.js';
import {
  createDeletionCommands,
  purgeDeletedAutomations,
  purgeDeletedCommand,
} from './deletion.js';
import { readAutomation, readAutomations } from './drafts.js';
import { readRecordRuns } from './history.js';
import { createLifecycleCommands } from './lifecycle.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const { remove, restore } = createDeletionCommands();
const lifecycle = createLifecycleCommands({
  setup: () => Promise.reject(new Error('Resuming reads no setup.')),
});

const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});
const DAY = 86_400_000;

/** The match jobs the queue holds for an event, as the events trigger queued them. */
const matchJobs = (eventId: string) =>
  h.database.as('crm_owner', (sql) =>
    sql.query('select 1 from graphile_worker.jobs where key = $1', [`automation-match:${eventId}`]),
  );

const stepCount = async (tenant: Tenant) => (await h.steps(tenant)).length;

it('stops at once: nothing new starts it, every run still going is cancelled, and no step runs after', async () => {
  const tenant = await h.business();
  const { id, automationId } = await h.publish(tenant);
  const waiting = await h.enrol(tenant, 'Ada');
  const running = await h.enrol(tenant, 'Grace');
  // While it is live, a new contact's event is queued for matching.
  expect(await matchJobs(running.eventId)).toHaveLength(1);
  const [atWait = ''] = waiting.enrolments;
  const [atStart = ''] = running.enrolments;
  expect(await h.step(tenant, atWait)).toBe('ran');
  expect(await h.run(tenant, atWait)).toMatchObject({ status: 'waiting', current_step: 'settle' });
  expect(await h.steps(tenant)).toEqual([
    { step_key: 'pause', status: 'waiting', resumes: false, finished: false },
  ]);

  const before = Date.now();
  const deleted = await runCommand(h.services, remove, { id }, all(tenant));
  const after = Date.now();
  expect(deleted).toMatchObject({
    id,
    status: 'archived',
    folderId: null,
    liveVersion: 1,
    totalEnrolled: 2,
    activeEnrolled: 0,
  });
  // Deleted now, by a clock reading on each side, and purged its days later to the instant.
  const deletedAt = new Date(deleted.deletedAt ?? 0).getTime();
  expect(deletedAt).toBeGreaterThanOrEqual(before - 1000);
  expect(deletedAt).toBeLessThanOrEqual(after + 1000);
  expect(new Date(deleted.purgeAt ?? 0).getTime() - deletedAt).toBe(AUTOMATION_DELETED_DAYS * DAY);

  for (const enrolmentId of [atWait, atStart])
    expect(await h.run(tenant, enrolmentId)).toMatchObject({
      status: 'cancelled',
      exit_reason: 'automation_deleted',
      current_step: null,
      wake_at: null,
    });
  // The wait it was in is closed as skipped: it never came to its end.
  expect(await h.steps(tenant)).toEqual([
    { step_key: 'pause', status: 'skipped', resumes: false, finished: true },
  ]);
  expect(await h.events(tenant, 'automation.deleted')).toEqual([
    {
      type: 'automation.deleted',
      subject_id: automationId,
      payload: { was: 'active', cancelledRuns: 2, days: AUTOMATION_DELETED_DAYS },
    },
  ]);

  // The jobs already queued for both runs find nothing to do, however late they run.
  const later = new Date(Date.now() + 3 * DAY);
  expect(await h.step(tenant, atWait, later)).toBe('skipped');
  expect(await h.step(tenant, atStart, later)).toBe('skipped');
  expect(await stepCount(tenant)).toBe(1);

  // A new contact starts nothing, and its event is not even queued for matching.
  const late = await h.contact(tenant, 'Late');
  expect(await matchJobs(late.eventId)).toEqual([]);
  expect(await h.match(tenant, late.eventId)).toMatchObject({ enrolled: 0 });
  expect(
    (await withTenant(h.db, tenant, (trx) => readRecordRuns(trx, late.contact, {}))).items,
  ).toEqual([]);

  // It is on the Deleted list, and on no other.
  const list = (status?: 'archived' | 'active') =>
    withTenant(h.db, tenant, (trx) => readAutomations(trx, { status })).then((page) =>
      page.items.map((item) => item.id),
    );
  expect(await list()).toEqual([]);
  expect(await list('active')).toEqual([]);
  expect(await list('archived')).toEqual([id]);
  expect(await h.differences()).toEqual([]);

  // Deleting it again changes nothing and says nothing more.
  const again = await runCommand(h.services, remove, { id }, all(tenant));
  expect(again.deletedAt).toBe(deleted.deletedAt);
  expect(await h.events(tenant, 'automation.deleted')).toHaveLength(1);
});

it('cancels a run that slipped in as it was deleted, at its first job, before any step', async () => {
  const tenant = await h.business();
  const { id, automationId, versionId } = await h.publish(tenant);
  const { contactId } = await h.contact(tenant);
  await runCommand(h.services, remove, { id }, all(tenant));
  // As a match that read the automation while it was still active leaves it: a run of a
  // deleted automation, with its first job to come.
  const [stray] = await h.database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, reentry_key, current_step, correlation_id)
       values ($1, $2, $3, $4, $4, 'pause', uuidv7()) returning id`,
      [tenant.businessId, automationId, versionId, contactId],
    ),
  );
  const strayId = stray?.id ?? '';
  expect(await h.step(tenant, strayId)).toBe('skipped');
  expect(await h.run(tenant, strayId)).toMatchObject({
    status: 'cancelled',
    exit_reason: 'automation_deleted',
  });
  expect(await stepCount(tenant)).toBe(0);
  expect(await h.differences()).toEqual([]);
});

it('restores not running: paused if it was live, with its cancelled runs still cancelled', async () => {
  const tenant = await h.business();
  const { id, automationId, versionId } = await h.publish(tenant);
  const ada = await h.enrol(tenant, 'Ada');
  const [first = ''] = ada.enrolments;
  await h.step(tenant, first);
  await runCommand(h.services, remove, { id }, all(tenant));
  // One more that slipped in, and whose job never ran.
  const grace = await h.contact(tenant, 'Grace');
  await h.database.as('crm_owner', (sql) =>
    sql.query(
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, reentry_key, current_step, correlation_id)
       values ($1, $2, $3, $4, $4, 'pause', uuidv7())`,
      [tenant.businessId, automationId, versionId, grace.contactId],
    ),
  );

  const restored = await runCommand(h.services, restore, { id }, all(tenant));
  expect(restored).toMatchObject({
    id,
    status: 'paused',
    deletedAt: null,
    purgeAt: null,
    folderId: null,
    liveVersion: 1,
    totalEnrolled: 2,
    activeEnrolled: 0,
  });
  expect(await h.events(tenant, 'automation.restored')).toEqual([
    {
      type: 'automation.restored',
      subject_id: automationId,
      payload: { status: 'paused', cancelledRuns: 1 },
    },
  ]);
  // Nothing half-run comes back: both runs stay cancelled, and their jobs do nothing.
  expect(await h.run(tenant, first)).toMatchObject({ status: 'cancelled' });
  expect(await h.step(tenant, first, new Date(Date.now() + 3 * DAY))).toBe('skipped');
  expect(await h.steps(tenant)).toEqual([
    { step_key: 'pause', status: 'skipped', resumes: false, finished: true },
  ]);

  // Paused, it starts nobody; resumed, it starts the next contact from its first step.
  const whilePaused = await h.enrol(tenant, 'Paused');
  expect(whilePaused.enrolments).toEqual([]);
  expect(await runCommand(h.services, lifecycle.resume, { id }, all(tenant))).toMatchObject({
    status: 'active',
  });
  const afterResume = await h.enrol(tenant, 'Resumed');
  expect(afterResume.enrolments).toHaveLength(1);
  expect(await h.run(tenant, afterResume.enrolments[0] ?? '')).toMatchObject({
    status: 'running',
    current_step: 'pause',
  });

  // Restoring what is not deleted changes nothing and says nothing more.
  await runCommand(h.services, restore, { id }, all(tenant));
  expect(await h.events(tenant, 'automation.restored')).toHaveLength(1);
  expect(await h.differences()).toEqual([]);
});

it('restores an automation that was never published as the draft it was', async () => {
  const tenant = await h.business();
  const [draft] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values (app.business_id(), 'Unfinished', $1::jsonb, 'user') returning id`,
      [JSON.stringify({ name: 'Unfinished', steps: {} })],
    ),
  );
  const id = toPublicId('automation', draft?.id ?? '');
  expect(await runCommand(h.services, remove, { id }, all(tenant))).toMatchObject({
    status: 'archived',
    liveVersion: null,
  });
  expect(await runCommand(h.services, restore, { id }, all(tenant))).toMatchObject({
    status: 'draft',
    draftVersion: 1,
    draft: { name: 'Unfinished', steps: {} },
    deletedAt: null,
  });
});

it('keeps a step that was already running, then cancels the run it left going', async () => {
  const tenant = await h.business();
  const [tag] = await h.database.as('crm_owner', (sql) =>
    sql.query<{ id: string }>(
      `insert into crm.tags (business_id, name, created_by_kind) values ($1, 'VIP', 'user') returning id`,
      [tenant.businessId],
    ),
  );
  const tagId = tag?.id ?? '';
  const document: AutomationDocumentInput = {
    name: 'Tag, then wait',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'mark',
    steps: {
      mark: { type: 'tag.add', config: { tag: toPublicId('tag', tagId) }, next: 'pause' },
      pause: { type: 'wait', config: { duration: 'P1D' } },
    },
  };
  const { id } = await h.publish(tenant, document);
  const { enrolments, contactId } = await h.enrol(tenant);
  const [enrolmentId = ''] = enrolments;

  // The tag's row is held, so the step stops inside its transaction, holding its run,
  // until this lets go. The delete then waits for the run. Both waits are seen in the
  // database before anything is released, so the two truly overlap.
  const lockWaits = () =>
    h.database.as('postgres', async (sql) => {
      const [row] = await sql.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return row?.waiting ?? 0;
    });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = (): void => undefined;
  const tagLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holding = h.database.as('crm_owner', async (sql) => {
    await sql.query('select 1 from crm.tags where id = $1 for update', [tagId]);
    locked();
    await held;
  });
  await tagLocked;
  const stepping = runCommand(
    h.services,
    runStepCommand,
    { enrolmentId, sequence: 0 },
    all(tenant),
  );
  let deleting: Promise<Automation> | undefined;
  // Whatever is found, the tag is let go, so a failure here fails this test alone.
  try {
    await expect.poll(lockWaits, { timeout: 10_000, interval: 50 }).toBe(1);
    deleting = runCommand(h.services, remove, { id }, all(tenant));
    await expect.poll(lockWaits, { timeout: 10_000, interval: 50 }).toBe(2);
  } finally {
    release();
    await holding;
  }
  expect(await stepping).toBe('ran');
  expect(await deleting).toMatchObject({ status: 'archived', activeEnrolled: 0 });

  // The step that had begun is kept whole: its tag is on the contact, its row succeeded.
  expect(
    await h.database.withTenant(tenant, (sql) =>
      sql.query('select record_id from crm.record_tags where record_id = $1', [contactId]),
    ),
  ).toHaveLength(1);
  expect(await h.steps(tenant)).toEqual([
    { step_key: 'mark', status: 'succeeded', resumes: false, finished: true },
  ]);
  // The run it left at its next step was cancelled by the delete, and that step never runs.
  expect(await h.run(tenant, enrolmentId)).toMatchObject({
    status: 'cancelled',
    exit_reason: 'automation_deleted',
  });
  expect(await h.step(tenant, enrolmentId)).toBe('skipped');
  expect(await stepCount(tenant)).toBe(1);
  expect(await h.differences()).toEqual([]);
});

it('removes for good what has been deleted past its days, and nothing sooner', async () => {
  const tenant = await h.business();
  const old = await h.publish(tenant);
  const recent = await h.publish(tenant, { ...waitsADay, name: 'Recent' });
  const ada = await h.enrol(tenant);
  for (const enrolmentId of ada.enrolments) await h.step(tenant, enrolmentId);
  await runCommand(h.services, remove, { id: old.id }, all(tenant));
  await runCommand(h.services, remove, { id: recent.id }, all(tenant));
  const age = (automationId: string, days: number) =>
    h.database.as('crm_owner', (sql) =>
      sql.query(
        `update automation.automations set archived_at = now() - make_interval(days => $2::int)
         where id = $1`,
        [automationId, days],
      ),
    );
  await age(old.automationId, AUTOMATION_DELETED_DAYS + 1);
  await age(recent.automationId, AUTOMATION_DELETED_DAYS - 1);

  // Held by someone restoring it at this moment, it is left for the next run, unwaited.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = (): void => undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holding = h.database.as('crm_owner', async (sql) => {
    await sql.query('select 1 from automation.automations where id = $1 for no key update', [
      old.automationId,
    ]);
    locked();
    await held;
  });
  await isLocked;
  try {
    expect(await purgeDeletedAutomations(h.services)).toBe(0);
  } finally {
    release();
    await holding;
  }

  expect(await purgeDeletedAutomations(h.services)).toBe(1);
  const left = (table: string) =>
    h.database.as('crm_owner', (sql) =>
      sql.query<{ automation_id: string }>(
        `select distinct automation_id from ${table} where business_id = $1`,
        [tenant.businessId],
      ),
    );
  // Its versions, runs, steps and statistics went with it; the other's are all there.
  for (const table of [
    'automation.versions',
    'automation.enrolments',
    'automation.step_runs',
    'automation.trigger_subscriptions',
  ])
    expect(await left(table), table).toEqual([{ automation_id: recent.automationId }]);
  const counters = await h.database.as('crm_owner', (sql) =>
    sql.query<{ automation_id: string }>(
      `select automation_id from automation.stat_counts where business_id = $1
       union select automation_id from automation.stat_deltas where business_id = $1`,
      [tenant.businessId],
    ),
  );
  expect(counters).toEqual([{ automation_id: recent.automationId }]);
  await expect(
    withTenant(h.db, tenant, (trx) => readAutomation(trx, old.id)),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await h.events(tenant, 'automation.purged')).toEqual([
    {
      type: 'automation.purged',
      subject_id: tenant.businessId,
      payload: { automations: 1, days: AUTOMATION_DELETED_DAYS },
    },
  ]);
  // The contact it ran for is untouched, and nothing is left to purge.
  expect(
    (await withTenant(h.db, tenant, (trx) => readRecordRuns(trx, ada.contact, {}))).items,
  ).toHaveLength(1);
  expect(await purgeDeletedAutomations(h.services)).toBe(0);
  expect(await h.differences()).toEqual([]);
});

it('is for those who may publish, in their own business, and the purge for the engine alone', async () => {
  const tenant = await h.business();
  const elsewhere = await h.business();
  const { id } = await h.publish(tenant);
  const only = (...permissions: ('automations.manage' | 'automations.publish')[]) => ({
    context: { ...tenant, correlationId: randomUUID() },
    permissions: new Set(permissions),
  });
  for (const command of [remove, restore]) {
    await expect(
      runCommand(h.services, command, { id }, only('automations.manage')),
    ).rejects.toMatchObject({ name: 'ForbiddenError', permission: 'automations.publish' });
    await expect(runCommand(h.services, command, { id }, all(elsewhere))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      runCommand(h.services, command, { id: 'the-newsletter' }, all(tenant)),
    ).rejects.toBeInstanceOf(NotFoundError);
  }
  expect(await withTenant(h.db, tenant, (trx) => readAutomation(trx, id))).toMatchObject({
    status: 'active',
  });
  expect(await runCommand(h.services, remove, { id }, only('automations.publish'))).toMatchObject({
    status: 'archived',
  });

  const user = await h.database.fixtures.user();
  await expect(
    runCommand(
      h.services,
      purgeDeletedCommand,
      {},
      { context: { ...tenant, actorKind: 'user', actorId: user.id }, permissions: 'all' },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
});
