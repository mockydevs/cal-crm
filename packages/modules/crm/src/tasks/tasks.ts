import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation, type Command } from '@repo/commands';
import {
  createTaskInput,
  updateTask,
  updateTaskInput,
  completeTask,
  completeTaskInput,
  deleteTask,
  deleteTaskInput,
  listTaskAssignees,
  type Task,
  type TaskAssigneeList,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  actorKinds,
  toPublicId,
  parsePublicId,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';
import type * as z from 'zod';
import { requireRecord } from '../records/access.js';
import { recordsOf, version, type TaskOptions, type TaskRow } from './rows.js';
import { deleteSeriesFrom, editSeries, recurrencesOf, startSeries } from './series.js';

// What the list, bulk changes and the audit list read from here.
export { recordNames, recordsOf, version, type TaskOptions, type TaskRow } from './rows.js';

const updateInput = updateTaskInput.extend(updateTask.params.shape);
const completionInput = completeTaskInput.extend(completeTask.params.shape);
const deletionInput = deleteTaskInput.extend(deleteTask.params.shape);

/** What a writer must send back to change the task: a digest of everything a change can touch. */
export function revisionOf(row: TaskRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.record_id,
        row.version,
        row.title,
        row.body_text,
        row.due_at,
        row.assignee_user_id,
        row.completed_at,
        row.completed_by_kind,
        row.completed_by_id,
      ]),
    )
    .digest('hex');
}

/** A visible task before caller content is inspected, optionally held for a write. */
export async function requireTask(
  trx: DatabaseTransaction,
  id: string,
  lock = false,
): Promise<TaskRow> {
  const uuid = parsePublicId('task', id);
  if (uuid === undefined) throw new NotFoundError('Task', id);
  let query = trx.selectFrom('crm.tasks').selectAll().select(version).where('id', '=', uuid);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Task', id);
  return row;
}

async function writableTask(trx: DatabaseTransaction, id: string, revision: string) {
  // Record links never change through the task API. Read which record to guard, then
  // take the same registry/entity/task lock order as note writes and trash/purge.
  const observed = await requireTask(trx, id);
  let recordId: string | null = null;
  if (observed.record_id !== null) {
    const record = (await recordsOf(trx, [observed])).get(observed.record_id);
    if (record === undefined) throw new NotFoundError('Task', id);
    await requireRecord(trx, record.id, true);
    recordId = record.id;
  }
  const current = await requireTask(trx, id, true);
  if (revisionOf(current) !== revision)
    throw new ConflictError('This task changed. Refresh it before saving, completing or deleting.');
  return { current, recordId };
}

export async function present(
  trx: DatabaseTransaction,
  invocation: Invocation,
  rows: readonly TaskRow[],
  options: TaskOptions,
): Promise<Task[]> {
  const records = await recordsOf(trx, rows);
  const recurrence = await recurrencesOf(trx, rows);
  const userIds = [
    ...new Set(
      rows.flatMap((row) => (row.assignee_user_id === null ? [] : [row.assignee_user_id])),
    ),
  ];
  const memberships = await options.assignees.memberships(trx, invocation.context, userIds);
  const names = new Map<string, string>();
  for (const kind of actorKinds) {
    const ids = [
      ...new Set([
        ...(kind === 'user' ? userIds : []),
        ...rows.flatMap((row) =>
          row.completed_by_kind === kind && row.completed_by_id !== null
            ? [row.completed_by_id]
            : [],
        ),
      ]),
    ];
    const lookup = options.actorNames[kind];
    if (lookup !== undefined && ids.length > 0)
      for (const [id, name] of await lookup(trx, ids)) names.set(`${kind}:${id}`, name);
  }
  return rows.map((row) => {
    const record = row.record_id === null ? null : records.get(row.record_id);
    if (record === undefined) throw new TypeError('The task record must be visible.');
    const completedKind = actorKinds.find((kind) => kind === row.completed_by_kind);
    if (row.completed_by_kind !== null && completedKind === undefined)
      throw new TypeError('Unknown task completion actor kind.');
    return {
      id: toPublicId('task', row.id),
      record,
      title: row.title,
      description: row.body_text,
      dueAt: row.due_at?.toISOString() ?? null,
      assignee:
        row.assignee_user_id === null
          ? null
          : {
              membershipId: memberships.get(row.assignee_user_id) ?? null,
              name: names.get(`user:${row.assignee_user_id}`) ?? null,
              you:
                invocation.context.actorKind === 'user' &&
                row.assignee_user_id === invocation.context.userId,
            },
      completedAt: row.completed_at?.toISOString() ?? null,
      completedBy:
        completedKind === undefined
          ? null
          : {
              kind: completedKind,
              name:
                row.completed_by_id === null
                  ? null
                  : (names.get(`${completedKind}:${row.completed_by_id}`) ?? null),
              you:
                invocation.context.actorKind === 'user' &&
                completedKind === 'user' &&
                row.completed_by_id === invocation.context.userId,
            },
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      revision: revisionOf(row),
      ...(row.series_id === null ? {} : { recurrence: recurrence(row) }),
    };
  });
}

export function createTaskCommand(options: TaskOptions): Command<typeof createTaskInput, Task> {
  return defineCommand({
    name: 'task.create',
    permission: 'tasks.manage',
    input: createTaskInput,
    audit: ({ recordId, recurrence }) => ({
      recordId,
      ...(recurrence === undefined ? {} : { recurring: true }),
    }),
    async handle(trx, input, command): Promise<Task> {
      const businessId = requireBusiness(command.context);
      if (input.recurrence !== undefined && input.dueAt === null) throw needsDue();
      const record =
        input.recordId === null ? null : await requireRecord(trx, input.recordId, true);
      const assignee = await options.assignees.resolve(trx, command.context, input.assignee);
      const inserted = await trx
        .insertInto('crm.tasks')
        .values({
          business_id: businessId,
          record_id: record?.id ?? null,
          title: input.title,
          body_text: input.description,
          due_at: input.dueAt === null ? null : new Date(input.dueAt),
          assignee_user_id: assignee,
          created_by_kind: command.context.actorKind,
          created_by_id: command.context.actorId ?? null,
        })
        .returningAll()
        .returning(version)
        .executeTakeFirstOrThrow();
      const row =
        input.recurrence === undefined
          ? inserted
          : await startSeries(trx, command, inserted, input.recurrence);
      await command.emit({
        type: 'task.created',
        subject: { kind: 'task', id: row.id },
        records: record === null ? [] : [record.id],
        // Who the task was given to, when it was given to someone: the event is what tells
        // them (notifications).
        payload: {
          recordId: input.recordId,
          ...(assignee === null ? {} : { assignedUserId: assignee }),
        },
      });
      const [saved] = await present(trx, command, [row], options);
      if (saved === undefined) throw new TypeError('The saved task must be present.');
      return saved;
    },
  });
}

export function updateTaskCommand(options: TaskOptions): Command<typeof updateInput, Task> {
  return defineCommand({
    name: 'task.update',
    permission: 'tasks.manage',
    input: updateInput,
    audit: ({ id, applyTo, recurrence }) => ({
      id,
      ...(applyTo === undefined ? {} : { applyTo }),
      ...(recurrence === undefined ? {} : { recurrence: recurrence === null ? 'stop' : 'set' }),
    }),
    async handle(trx, input, command): Promise<Task> {
      requireBusiness(command.context);
      const { current, recordId } = await writableTask(trx, input.id, input.revision);
      const series = input.applyTo === 'series';
      if (series && current.series_id === null) throw notRecurring();
      if (input.recurrence !== undefined && current.series_id !== null && !series)
        throw new ValidationError([
          {
            path: '/recurrence',
            code: 'series_only',
            message: 'Change how a task repeats for the whole series.',
          },
        ]);
      if (input.recurrence !== undefined && input.recurrence !== null && input.dueAt === null)
        throw needsDue();
      const assignee = await options.assignees.resolve(trx, command.context, input.assignee);
      const updated = await trx
        .updateTable('crm.tasks')
        .set({
          title: input.title,
          body_text: input.description,
          due_at: input.dueAt === null ? null : new Date(input.dueAt),
          assignee_user_id: assignee,
        })
        .where('id', '=', current.id)
        .returningAll()
        .returning(version)
        .executeTakeFirstOrThrow();
      let row = updated;
      if (series) await editSeries(trx, command, current, updated, input.recurrence);
      else if (
        current.series_id === null &&
        input.recurrence !== undefined &&
        input.recurrence !== null
      )
        row = await startSeries(trx, command, updated, input.recurrence);
      await command.emit({
        type: 'task.updated',
        subject: { kind: 'task', id: row.id },
        records: row.record_id === null ? [] : [row.record_id],
        // Named only when this edit gave the task to someone else: an edit of the title
        // tells the assignee nothing new.
        payload: {
          recordId,
          ...(assignee === null || assignee === current.assignee_user_id
            ? {}
            : { assignedUserId: assignee }),
        },
      });
      const [saved] = await present(trx, command, [row], options);
      if (saved === undefined) throw new TypeError('The saved task must be present.');
      return saved;
    },
  });
}

export function completeTaskCommand(options: TaskOptions): Command<typeof completionInput, Task> {
  return defineCommand({
    name: 'task.complete',
    permission: 'tasks.manage',
    input: completionInput,
    audit: ({ id, completed }) => ({ id, completed }),
    async handle(trx, input, command): Promise<Task> {
      requireBusiness(command.context);
      const { current, recordId } = await writableTask(trx, input.id, input.revision);
      const row =
        (current.completed_at !== null) === input.completed
          ? current
          : await trx
              .updateTable('crm.tasks')
              .set({
                completed_at: input.completed ? sql<Date>`now()` : null,
                completed_by_kind: input.completed ? command.context.actorKind : null,
                completed_by_id: input.completed ? (command.context.actorId ?? null) : null,
              })
              .where('id', '=', current.id)
              .returningAll()
              .returning(version)
              .executeTakeFirstOrThrow();
      if (row !== current)
        await command.emit({
          type: input.completed ? 'task.completed' : 'task.reopened',
          subject: { kind: 'task', id: row.id },
          records: row.record_id === null ? [] : [row.record_id],
          payload: { recordId },
        });
      const [saved] = await present(trx, command, [row], options);
      if (saved === undefined) throw new TypeError('The saved task must be present.');
      return saved;
    },
  });
}

export const deleteTaskCommand = defineCommand({
  name: 'task.delete',
  permission: 'tasks.manage',
  input: deletionInput,
  audit: ({ id, applyTo }) => ({ id, ...(applyTo === undefined ? {} : { applyTo }) }),
  async handle(trx, input, command): Promise<undefined> {
    requireBusiness(command.context);
    const { current, recordId } = await writableTask(trx, input.id, input.revision);
    if (input.applyTo === 'series') {
      if (current.series_id === null) throw notRecurring();
      await deleteSeriesFrom(trx, command, current);
    }
    await trx.deleteFrom('crm.tasks').where('id', '=', current.id).execute();
    await command.emit({
      type: 'task.deleted',
      subject: { kind: 'task', id: current.id },
      records: current.record_id === null ? [] : [current.record_id],
      payload: { recordId },
    });
    return undefined;
  },
});

const needsDue = () =>
  new ValidationError([
    {
      path: '/dueAt',
      code: 'recurrence_needs_due',
      message: 'Give a recurring task a due date and time.',
    },
  ]);

const notRecurring = () =>
  new ValidationError([
    { path: '/applyTo', code: 'not_recurring', message: 'This task does not repeat.' },
  ]);

/** Membership eligibility stays owned by tenancy; auth supplies safe display names. */
export async function readAssignees(
  trx: DatabaseTransaction,
  invocation: Invocation,
  query: z.output<typeof listTaskAssignees.query>,
  options: TaskOptions,
): Promise<TaskAssigneeList> {
  requireBusiness(invocation.context);
  const page = await options.assignees.read(trx, invocation.context, query.after);
  const lookup = options.actorNames.user;
  const names =
    lookup === undefined || page.items.length === 0
      ? new Map<string, string>()
      : await lookup(trx, [...new Set(page.items.map((item) => item.userId))]);
  return {
    items: page.items.map((item) => ({
      id: item.id,
      name: names.get(item.userId) ?? null,
      you: invocation.context.actorKind === 'user' && item.userId === invocation.context.userId,
    })),
    nextCursor: page.nextCursor,
  };
}
