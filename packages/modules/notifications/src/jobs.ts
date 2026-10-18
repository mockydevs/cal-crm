// The worker's two notification jobs. The database queues both, in the transaction that
// wrote the event (migration 0056): one for each event of a listed type, and one at the due
// time of each task that is open and assigned.
//
// A job can run more than once, and two workers can run the same one at once: what it
// writes is keyed by its source, so a second run adds nothing (deliver.ts).
import { defineTask, type AnyTask, type TaskReference } from '@repo/commands';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { actorKinds, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { deliver } from './deliver.js';
import { dueSource, eventSource, reminderSource } from './rules.js';
import { SOURCES } from './sources.js';

export const fromEventReference = {
  name: 'notifications.from_event',
  data: z.strictObject({ eventId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

export const taskDueReference = {
  name: 'notifications.task_due',
  data: z.strictObject({ taskId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

export const taskReminderReference = {
  name: 'notifications.task_reminder',
  data: z.strictObject({ taskId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/**
 * Tells the right people of one stored event, and gives how many were told. The event is
 * read where the job runs: its business, or the agency for an event about the agency as a
 * whole. One of another place, or of a type nobody is told of, tells nobody.
 */
export async function notifyOfEvent(
  trx: DatabaseTransaction,
  context: TenantContext,
  eventId: string,
): Promise<number> {
  const { businessId } = context;
  const stored = await trx
    .selectFrom('events.events')
    .select(['id', 'type', 'actor_kind', 'actor_id', 'subject_id', 'payload'])
    .where('id', '=', eventId)
    .where('agency_id', '=', context.agencyId)
    .where((eb) =>
      businessId === undefined ? eb('business_id', 'is', null) : eb('business_id', '=', businessId),
    )
    .executeTakeFirst();
  if (stored === undefined) return 0;
  const source = SOURCES[stored.type];
  const actorKind = actorKinds.find((kind) => kind === stored.actor_kind);
  if (source === undefined || actorKind === undefined) return 0;
  const planned = await source(trx, context, {
    id: stored.id,
    type: stored.type,
    actorKind,
    actorId: stored.actor_id,
    subjectId: stored.subject_id,
    payload: stored.payload,
  });
  let told = 0;
  for (const notice of planned) {
    const written = await deliver(trx, context, {
      ...notice,
      sourceKey: eventSource(stored.id),
      eventId: stored.id,
      cause: { kind: actorKind, id: stored.actor_id },
    });
    told += written.length;
  }
  return told;
}

/**
 * Tells a task's assignee that it is due, if it still is: open, assigned and at or past
 * its due time by the database's clock. A job that outlived a change (the task was
 * completed, given back, or moved later) tells nobody; a task moved later has a job of its
 * own at the new time. Gives how many were told: one or none.
 */
export async function notifyTaskDue(
  trx: DatabaseTransaction,
  context: TenantContext,
  taskId: string,
): Promise<number> {
  const task = await trx
    .selectFrom('crm.tasks')
    .select(['id', 'title', 'record_id', 'assignee_user_id', 'due_at'])
    .where('id', '=', taskId)
    .where('completed_at', 'is', null)
    .where('assignee_user_id', 'is not', null)
    .where('due_at', '<=', sql<Date>`now()`)
    // What the conditions above leave: a task with a due time and someone it is assigned to.
    .$narrowType<{ assignee_user_id: string; due_at: Date }>()
    .executeTakeFirst();
  if (task === undefined) return 0;
  const written = await deliver(trx, context, {
    kind: 'task.due',
    recipients: [task.assignee_user_id],
    // A task due again at another time is told of again; the same time, once.
    sourceKey: dueSource(task.id, task.due_at),
    collapseKey: `task.due:${task.id}`,
    // Nobody caused a due time to arrive, so the assignee is told even of their own task.
    cause: { kind: 'system', id: null },
    subject: { kind: 'task', id: task.id },
    recordId: task.record_id,
    title: task.title,
  });
  return written.length;
}

/**
 * Reminds a task's assignee that it is due soon, if it still is: open, assigned, due later,
 * and within the time before it they chose (migration 0121 queues the job then). A job that
 * outlived a change tells nobody; a task moved has a job of its own at its new time. Gives
 * how many were told: one or none.
 */
export async function notifyTaskReminder(
  trx: DatabaseTransaction,
  context: TenantContext,
  taskId: string,
): Promise<number> {
  const task = await trx
    .selectFrom('crm.tasks as task')
    .innerJoin('notifications.preferences as preference', (join) =>
      join
        .onRef('preference.business_id', '=', 'task.business_id')
        .onRef('preference.user_id', '=', 'task.assignee_user_id')
        .on('preference.kind', '=', 'task.reminder'),
    )
    .select(['task.id', 'task.title', 'task.record_id', 'task.assignee_user_id', 'task.due_at'])
    .where('task.id', '=', taskId)
    .where('task.completed_at', 'is', null)
    .where('task.due_at', '>', sql<Date>`now()`)
    .where('preference.in_app', '=', true)
    .where(sql<boolean>`task.due_at - make_interval(mins => preference.remind_minutes) <= now()`)
    // What the conditions above leave: a task with a due time and someone it is assigned to.
    .$narrowType<{ assignee_user_id: string; due_at: Date }>()
    .executeTakeFirst();
  if (task === undefined) return 0;
  const written = await deliver(trx, context, {
    kind: 'task.reminder',
    recipients: [task.assignee_user_id],
    // A task moved to another due time is reminded of again; the same time, once.
    sourceKey: reminderSource(task.id, task.due_at),
    collapseKey: `task.reminder:${task.id}`,
    cause: { kind: 'system', id: null },
    subject: { kind: 'task', id: task.id },
    recordId: task.record_id,
    title: task.title,
  });
  return written.length;
}

/** The notification jobs, for the worker to run. Each in the job's business, as the system. */
export const notificationTasks: readonly AnyTask[] = [
  defineTask({
    ...fromEventReference,
    async run(data, { invocation, services }) {
      await withTenant(services.db, invocation.context, (trx) =>
        notifyOfEvent(trx, invocation.context, data.eventId),
      );
    },
  }),
  defineTask({
    ...taskDueReference,
    async run(data, { invocation, services }) {
      await withTenant(services.db, invocation.context, (trx) =>
        notifyTaskDue(trx, invocation.context, data.taskId),
      );
    },
  }),
  defineTask({
    ...taskReminderReference,
    async run(data, { invocation, services }) {
      await withTenant(services.db, invocation.context, (trx) =>
        notifyTaskReminder(trx, invocation.context, data.taskId),
      );
    },
  }),
];
