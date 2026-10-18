// The Task Reminder trigger, in the engine: a task's contact is enrolled a number of days
// before or after the task's due time, on the business's calendar, once per reminder.
// Real Postgres; every moment is a fixed date passed to the sweep.
import type { AutomationDocumentInput } from '@repo/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { sweepTaskReminders } from './task-reminders.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const NEW_YORK = 'America/New_York';
const at = (value: string) => new Date(value);

const reminder = (config: { before?: number; after?: number }): AutomationDocumentInput => ({
  name: 'Task reminder',
  triggers: [{ id: 'due', type: 'task.reminder', config }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
  settings: { reEnrollment: 'after_finished' },
});

async function business(zone: string): Promise<Tenant> {
  const tenant = await h.business();
  await h.database.as('postgres', (sql) =>
    sql.query('update tenancy.businesses set timezone = $2 where id = $1', [
      tenant.businessId,
      zone,
    ]),
  );
  // Other businesses' automations out of the sweep, so its counts are this business's.
  await h.database.as('postgres', (sql) =>
    sql.query('delete from automation.trigger_subscriptions where business_id <> $1', [
      tenant.businessId,
    ]),
  );
  return tenant;
}

async function task(
  tenant: Tenant,
  recordId: string | null,
  dueAt: string | null,
  title = 'Call back',
): Promise<string> {
  const row = await h.database.withTenant(tenant, (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.tasks (business_id, record_id, title, due_at, created_by_kind)
       values (app.business_id(), $1, $2, $3, 'system') returning id`,
      [recordId, title, dueAt],
    ),
  );
  return row.id;
}

const runs = (tenant: Tenant, automationId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ record_id: string; task: string | null; event: string | null }>(
      `select record_id, state ->> 'taskId' as task, trigger_event_id as event
       from automation.enrolments where automation_id = $1 order by started_at, id`,
      [automationId],
    ),
  );

const sweep = (now: string) => sweepTaskReminders(h.services, at(now));

/** Ends every run of the automation, so its contact may go through again. */
const finishRuns = (automationId: string) =>
  h.database.as('postgres', (sql) =>
    sql.query(
      `update automation.enrolments
       set status = 'completed', current_step = null, wake_at = null, finished_at = now()
       where automation_id = $1 and status in ('running', 'waiting')`,
      [automationId],
    ),
  );

it('enrols the contact a day before the due time, on the wall clock across a clock change', async () => {
  const tenant = await business(NEW_YORK);
  const { contactId } = await h.contact(tenant, 'Ada');
  // Due 09:00 EST on 1 November 2026, the day the clocks go back: 14:00 UTC.
  const taskId = await task(tenant, contactId, '2026-11-01T14:00:00Z');
  const { automationId } = await h.publish(tenant, reminder({ before: 1 }));
  // The first look starts the clock.
  expect(await sweep('2026-10-31T12:00:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
  // A day before is 09:00 EDT on 31 October: 13:00 UTC, 25 real hours before.
  expect(await sweep('2026-10-31T12:59:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
  expect(await sweep('2026-10-31T13:00:00Z')).toEqual({ enrolled: 1, late: 0, failed: [] });
  expect(await sweep('2026-10-31T13:01:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
  const [run] = await runs(tenant, automationId);
  expect(run?.record_id).toBe(contactId);
  expect(run?.event).toBeNull();
  expect(run?.task).toMatch(/^task_/);
  expect(taskId).toBeTypeOf('string');
});

it('fires before and after on one trigger, each once, and a completed task still fires', async () => {
  const tenant = await business('UTC');
  const { contactId } = await h.contact(tenant, 'Grace');
  const taskId = await task(tenant, contactId, '2026-10-20T10:00:00Z');
  await h.database.withTenant(tenant, (sql) =>
    sql.query(
      `update crm.tasks set completed_at = now(), completed_by_kind = 'system' where id = $1`,
      [taskId],
    ),
  );
  const { automationId } = await h.publish(tenant, reminder({ before: 2, after: 3 }));
  await sweep('2026-10-17T00:00:00Z');
  expect(await sweep('2026-10-18T10:00:00Z')).toMatchObject({ enrolled: 1 });
  expect(await sweep('2026-10-18T10:00:00Z')).toMatchObject({ enrolled: 0 });
  await finishRuns(automationId);
  expect(await sweep('2026-10-23T09:59:00Z')).toMatchObject({ enrolled: 0 });
  expect(await sweep('2026-10-23T10:00:00Z')).toMatchObject({ enrolled: 1 });
  expect((await runs(tenant, automationId)).length).toBe(2);
});

it('fires again for a task moved to another day, and never for one deleted, undated or not a contact’s', async () => {
  const tenant = await business('UTC');
  const { contactId } = await h.contact(tenant, 'Lin');
  const moved = await task(tenant, contactId, '2026-10-20T10:00:00Z', 'Moved');
  const deleted = await task(tenant, contactId, '2026-10-20T10:00:00Z', 'Deleted');
  await task(tenant, contactId, null, 'Undated');
  await task(tenant, null, '2026-10-20T10:00:00Z', 'Nobody’s');
  const { automationId } = await h.publish(tenant, reminder({ after: 0 }));
  await sweep('2026-10-19T00:00:00Z');
  await h.database.withTenant(tenant, (sql) =>
    sql.query('delete from crm.tasks where id = $1', [deleted]),
  );
  expect(await sweep('2026-10-20T10:00:00Z')).toMatchObject({ enrolled: 1 });
  await h.database.withTenant(tenant, (sql) =>
    sql.query(`update crm.tasks set due_at = '2026-10-21T10:00:00Z' where id = $1`, [moved]),
  );
  await finishRuns(automationId);
  expect(await sweep('2026-10-21T10:00:00Z')).toMatchObject({ enrolled: 1 });
  expect((await runs(tenant, automationId)).length).toBe(2);
});

it('leaves out a contact in the trash and another business’s tasks', async () => {
  const tenant = await business('UTC');
  const other = await h.business();
  const { contactId } = await h.contact(tenant, 'Trashed');
  const theirs = await h.contact(other, 'Elsewhere');
  await task(tenant, contactId, '2026-10-20T10:00:00Z');
  await task(other, theirs.contactId, '2026-10-20T10:00:00Z');
  await h.database.withTenant(tenant, (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [contactId]),
  );
  const { automationId } = await h.publish(tenant, reminder({ before: 0 }));
  await sweep('2026-10-20T00:00:00Z');
  expect(await sweep('2026-10-20T10:00:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
  expect(await runs(tenant, automationId)).toEqual([]);
});

it('lets a paused automation’s reminders pass, and starts from the resume', async () => {
  const tenant = await business('UTC');
  const { contactId } = await h.contact(tenant, 'Paused');
  await task(tenant, contactId, '2026-10-20T10:00:00Z');
  const { automationId } = await h.publish(tenant, reminder({ before: 0 }));
  await sweep('2026-10-19T00:00:00Z');
  await h.database.as('postgres', (sql) =>
    sql.query(`update automation.automations set status = 'paused' where id = $1`, [automationId]),
  );
  expect(await sweep('2026-10-20T10:00:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
  await h.database.as('postgres', (sql) =>
    sql.query(`update automation.automations set status = 'active' where id = $1`, [automationId]),
  );
  expect(await sweep('2026-10-20T10:05:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
  expect(await runs(tenant, automationId)).toEqual([]);
});

it('skips an automation whose version no longer reads, and sweeps the others', async () => {
  const tenant = await business('UTC');
  const { contactId } = await h.contact(tenant, 'Kept');
  await task(tenant, contactId, '2026-10-20T10:00:00Z');
  const broken = await h.publish(tenant, reminder({ before: 0 }));
  const working = await h.publish(tenant, reminder({ before: 0 }));
  await sweep('2026-10-20T09:00:00Z');
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update automation.versions set document = '{"name": 1}'::jsonb
       where id = (select published_version_id from automation.automations where id = $1)`,
      [broken.automationId],
    ),
  );
  const swept = await sweep('2026-10-20T10:00:00Z');
  expect(swept.failed).toEqual([broken.automationId]);
  expect(swept.enrolled).toBe(1);
  expect(await runs(tenant, working.automationId)).toHaveLength(1);
});

it('starts the clock afresh for a trigger removed and added back under the same id', async () => {
  const tenant = await business('UTC');
  const { contactId } = await h.contact(tenant, 'Again');
  await task(tenant, contactId, '2026-10-20T10:00:00Z');
  const { automationId } = await h.publish(tenant, reminder({ before: 0 }));
  await sweep('2026-10-19T00:00:00Z');
  // Removed, then added back, with no sweep between: its old cursor must not come back.
  await h.publish(tenant, { ...reminder({ before: 0 }), triggers: [] }, automationId);
  await h.publish(tenant, reminder({ before: 0 }), automationId);
  expect(await sweep('2026-10-20T11:00:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
  expect(await runs(tenant, automationId)).toEqual([]);
});

it('checks the reminder condition once and never enrols a refused contact after its due time', async () => {
  const tenant = await business('UTC');
  const ada = await h.contact(tenant, 'Ada');
  const grace = await h.contact(tenant, 'Grace');
  await task(tenant, ada.contactId, '2026-10-20T10:00:00Z');
  await task(tenant, grace.contactId, '2026-10-20T10:00:00Z');
  const { automationId } = await h.publish(tenant, {
    ...reminder({ before: 0 }),
    triggers: [
      {
        id: 'due',
        type: 'task.reminder',
        config: { before: 0 },
        if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' },
      },
    ],
  });
  await sweep('2026-10-20T09:00:00Z');
  expect(await sweep('2026-10-20T10:00:00Z')).toEqual({ enrolled: 1, late: 0, failed: [] });
  expect((await runs(tenant, automationId)).map((run) => run.record_id)).toEqual([ada.contactId]);
  await h.database.withTenant(tenant, (sql) =>
    sql.query('update crm.contacts set first_name = $2 where id = $1', [grace.contactId, 'Ada']),
  );
  await finishRuns(automationId);
  expect(await sweep('2026-10-20T10:01:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
  expect(await runs(tenant, automationId)).toHaveLength(1);
});

it('catches up only reminders within the last day after the worker was down', async () => {
  const tenant = await business('UTC');
  const old = await h.contact(tenant, 'Old');
  const recent = await h.contact(tenant, 'Recent');
  await task(tenant, old.contactId, '2026-10-20T10:00:00Z');
  await task(tenant, recent.contactId, '2026-10-21T10:00:00Z');
  const { automationId } = await h.publish(tenant, reminder({ after: 0 }));
  await sweep('2026-10-19T00:00:00Z');
  expect(await sweep('2026-10-22T08:00:00Z')).toEqual({ enrolled: 1, late: 1, failed: [] });
  expect((await runs(tenant, automationId)).map((run) => run.record_id)).toEqual([
    recent.contactId,
  ]);
  expect(await sweep('2026-10-22T08:01:00Z')).toEqual({ enrolled: 0, late: 0, failed: [] });
});

it('enrols a task once when two sweeps reach the same reminder together', async () => {
  const tenant = await business('UTC');
  const { contactId } = await h.contact(tenant, 'Ada');
  await task(tenant, contactId, '2026-10-20T10:00:00Z');
  const { automationId } = await h.publish(tenant, reminder({ before: 0 }));
  await sweep('2026-10-20T09:00:00Z');
  const results = await Promise.all([sweep('2026-10-20T10:00:00Z'), sweep('2026-10-20T10:00:00Z')]);
  expect(results.map((result) => result.enrolled).sort()).toEqual([0, 1]);
  expect(results.flatMap((result) => result.failed)).toEqual([]);
  expect(await runs(tenant, automationId)).toHaveLength(1);
});
