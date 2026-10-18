// The Task Reminder trigger: a task for the contact comes due, a number of days before its
// due time or after it. The days fall on the business's calendar and keep the task's time of
// day, so "1 day before" a task due at 09:00 is 09:00 the day before across a clock change.
//
// Like a date trigger it hears no event. The worker's minute sweep asks, for every automation
// with such a trigger, which tasks' reminder times came round since it last looked (the
// trigger's cursor), and enrols each task's contact in a transaction of its own, with a
// firing row that says it was done: a sweep that died half way, or two at once, enrol for a
// task once. A task's firing is keyed by the day its reminder fell on, so a task moved to
// another day fires again, as its new due time asks, and a task deleted first never fires.
import { randomUUID } from 'node:crypto';

import type { Services } from '@repo/commands';
import {
  automationDocument,
  evaluateCondition,
  type AutomationDocument,
  type AutomationTrigger,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';

import { DATE_TRIGGER_CATCH_UP_MS } from './date-triggers.js';
import { enrol, lockRecordRuns } from './enrolment.js';
import { contactValues } from './values.js';

const DAY = 86_400_000;
// A day either side of the stretch covers any clock change between a due time and the
// reminder that falls days from it.
const MARGIN_DAYS = 2;

type ReminderTrigger = Extract<AutomationTrigger, { type: 'task.reminder' }>;

const isReminderTrigger = (trigger: AutomationTrigger): trigger is ReminderTrigger =>
  trigger.type === 'task.reminder';

/** A task whose reminder came round, the contact it is for, and the day it fell on. */
interface Firing {
  readonly triggerId: string;
  readonly taskId: string;
  readonly contactId: string;
  readonly occurrence: string;
}

/**
 * The tasks of contacts whose due time, moved by `days` on the business's calendar (minus
 * before, plus after), lies after `after` and no later than `through`.
 */
async function firingsOf(
  trx: DatabaseTransaction,
  triggerId: string,
  days: number,
  timeZone: string,
  after: Date,
  through: Date,
): Promise<Firing[]> {
  const from = new Date(after.getTime() - (days + MARGIN_DAYS) * DAY);
  const to = new Date(through.getTime() - days * DAY + MARGIN_DAYS * DAY);
  const { rows } = await sql<{ id: string; record_id: string; occurrence: string }>`
    select task.id, task.record_id, to_char(task.fires_at at time zone ${timeZone}, 'YYYY-MM-DD') as occurrence
    from (
      select t.id, t.record_id,
        ((t.due_at at time zone ${timeZone}) + make_interval(days => ${days})) at time zone ${timeZone} as fires_at
      from crm.tasks t
      where t.due_at >= ${new Date(Math.min(from.getTime(), to.getTime()))}
        and t.due_at <= ${new Date(Math.max(from.getTime(), to.getTime()))}
        and t.record_id is not null
    ) task
    join crm.contacts contact on contact.id = task.record_id and contact.deleted_at is null
    where task.fires_at > ${after} and task.fires_at <= ${through}
    order by task.id
  `.execute(trx);
  return rows.map((row) => ({
    triggerId,
    taskId: row.id,
    contactId: row.record_id,
    occurrence: row.occurrence,
  }));
}

interface Planned {
  readonly versionId: string;
  readonly document: AutomationDocument;
  readonly swept: readonly string[];
  readonly firings: readonly Firing[];
  readonly late: number;
}

async function moveCursors(
  trx: DatabaseTransaction,
  automationId: string,
  triggerIds: readonly string[],
  now: Date,
): Promise<void> {
  if (triggerIds.length === 0) return;
  await sql`
    update automation.trigger_cursors
    set swept_through = greatest(swept_through, ${now})
    where automation_id = ${automationId} and trigger_id = any(${triggerIds}::text[])
  `.execute(trx);
}

// What one automation's Task Reminder triggers have to fire now. A trigger seen for the
// first time starts its clock now; a paused automation's reminders pass unfired.
async function plan(
  trx: DatabaseTransaction,
  businessId: string,
  automationId: string,
  now: Date,
): Promise<Planned | undefined> {
  const { rows } = await sql<{
    status: string;
    version_id: string;
    document: unknown;
    timezone: string;
  }>`
    select automation.status, version.id as version_id, version.document, business.timezone
    from automation.automations automation
    join automation.versions version on version.id = automation.published_version_id
    join tenancy.businesses business on business.id = automation.business_id
    where automation.id = ${automationId} and automation.status in ('active', 'paused')
  `.execute(trx);
  const [automation] = rows;
  if (automation === undefined) return undefined;
  const document = automationDocument.parse(automation.document);
  const triggers = document.triggers.filter(isReminderTrigger);
  const ids = triggers.map((trigger) => trigger.id);
  // A trigger the published version no longer has keeps no cursor.
  await sql`
    delete from automation.trigger_cursors
    where automation_id = ${automationId}
      and not (trigger_id = any(${document.triggers.map((trigger) => trigger.id)}::text[]))
  `.execute(trx);
  const kept = await sql<{ trigger_id: string; swept_through: Date }>`
    select trigger_id, swept_through from automation.trigger_cursors
    where automation_id = ${automationId} and trigger_id = any(${ids}::text[])
  `.execute(trx);
  const cursors = new Map(kept.rows.map((row) => [row.trigger_id, row.swept_through]));
  for (const trigger of triggers.filter((each) => !cursors.has(each.id)))
    await sql`
      insert into automation.trigger_cursors (business_id, automation_id, trigger_id, swept_through)
      values (${businessId}, ${automationId}, ${trigger.id}, ${now})
      on conflict do nothing
    `.execute(trx);
  const known = triggers.filter((trigger) => cursors.has(trigger.id));
  if (automation.status === 'paused') {
    await moveCursors(trx, automationId, ids, now);
    return undefined;
  }
  const firings: Firing[] = [];
  let late = 0;
  for (const trigger of known) {
    const cursor = cursors.get(trigger.id) ?? now;
    const earliest = now.getTime() - DATE_TRIGGER_CATCH_UP_MS;
    if (cursor.getTime() < earliest) late += 1;
    const after = new Date(Math.max(cursor.getTime(), earliest));
    const { before, after: daysAfter } = trigger.config;
    if (before !== undefined)
      firings.push(...(await firingsOf(trx, trigger.id, -before, automation.timezone, after, now)));
    if (daysAfter !== undefined)
      firings.push(
        ...(await firingsOf(trx, trigger.id, daysAfter, automation.timezone, after, now)),
      );
  }
  return {
    versionId: automation.version_id,
    document,
    swept: known.map((trigger) => trigger.id),
    firings,
    late,
  };
}

/**
 * One task's firing, in its own transaction: the contact's runs held still, the firing
 * written unless it is there already, then the trigger's condition and the enrolment by the
 * rules every enrolment keeps. True when a run was started.
 */
async function fire(
  trx: DatabaseTransaction,
  context: TenantContext,
  automationId: string,
  planned: Planned,
  firing: Firing,
  now: Date,
): Promise<boolean> {
  const businessId = context.businessId;
  if (businessId === undefined) return false;
  await lockRecordRuns(trx, firing.contactId);
  const current = await sql`
    select 1 from automation.automations
    where id = ${automationId} and status = 'active' and published_version_id = ${planned.versionId}
  `.execute(trx);
  if (current.rows.length === 0) return false;
  // Deleted since the sweep looked: a deleted task does not fire.
  const exists = await sql`select 1 from crm.tasks where id = ${firing.taskId}`.execute(trx);
  if (exists.rows.length === 0) return false;
  // A firing's record is the task here; its occurrence the day the reminder fell on.
  const written = await sql`
    insert into automation.trigger_firings
      (business_id, automation_id, trigger_id, record_id, occurrence, fired_at)
    values (${businessId}, ${automationId}, ${firing.triggerId}, ${firing.taskId},
      ${firing.occurrence}::date, ${now})
    on conflict do nothing
    returning 1
  `.execute(trx);
  if (written.rows.length === 0) return false;
  const trigger = planned.document.triggers.find((each) => each.id === firing.triggerId);
  if (trigger === undefined) return false;
  if (
    trigger.if !== undefined &&
    !evaluateCondition(trigger.if, await contactValues(trx, firing.contactId), now)
  )
    return false;
  const result = await enrol(
    trx,
    businessId,
    automationId,
    planned.versionId,
    firing.contactId,
    planned.document,
    {
      eventId: null,
      correlationId: context.correlationId,
      triggerId: trigger.id,
      state: { triggerId: trigger.id, taskId: toPublicId('task', firing.taskId) },
    },
  );
  return result.outcome === 'started';
}

// Firings are needed only while their stretch of time can be swept again.
const FIRINGS_KEPT_MS = 2 * DAY;

async function finish(
  trx: DatabaseTransaction,
  automationId: string,
  planned: Planned,
  now: Date,
): Promise<void> {
  await moveCursors(trx, automationId, planned.swept, now);
  if (planned.firings.length > 0)
    await sql`
      delete from automation.trigger_firings
      where automation_id = ${automationId}
        and fired_at < ${new Date(now.getTime() - FIRINGS_KEPT_MS)}
    `.execute(trx);
}

/** What a sweep of Task Reminder triggers did. */
export interface TaskReminderSweep {
  /** Runs started. */
  readonly enrolled: number;
  /** Triggers that had gone unswept for longer than a firing may be late. */
  readonly late: number;
  /**
   * Automations that could not be swept (a version that no longer reads, say): each is
   * skipped, and the others are swept all the same. The worker logs them.
   */
  readonly failed: readonly string[];
}

const PAGE = 200;

/**
 * The worker's sweep of Task Reminder triggers: every automation with one, each in its own
 * business as the system. `now` is there for tests, which move time.
 */
export async function sweepTaskReminders(
  services: Services,
  now: Date = new Date(),
): Promise<TaskReminderSweep> {
  let enrolled = 0;
  let late = 0;
  const failed: string[] = [];
  let after: string | null = null;
  for (;;) {
    const { rows } = await sql<{ agency_id: string; business_id: string; automation_id: string }>`
      select * from private.automations_with_task_reminders(${after}::uuid, ${PAGE})
    `.execute(services.db);
    for (const row of rows) {
      try {
        const inBusiness = (): TenantContext => ({
          agencyId: row.agency_id,
          businessId: row.business_id,
          actorKind: 'system',
          correlationId: randomUUID(),
        });
        const planned = await withTenant(services.db, inBusiness(), (trx) =>
          plan(trx, row.business_id, row.automation_id, now),
        );
        if (planned === undefined) continue;
        late += planned.late;
        for (const firing of planned.firings) {
          const context = inBusiness();
          if (
            await withTenant(services.db, context, (trx) =>
              fire(trx, context, row.automation_id, planned, firing, now),
            )
          )
            enrolled += 1;
        }
        await withTenant(services.db, inBusiness(), (trx) =>
          finish(trx, row.automation_id, planned, now),
        );
      } catch {
        failed.push(row.automation_id);
      }
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAGE) return { enrolled, late, failed };
    after = last.automation_id;
  }
}
