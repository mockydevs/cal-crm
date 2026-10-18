// Recurring tasks: a series makes each of its tasks at its scheduled time, as GoHighLevel's
// do, not when the task before it is completed. The first task is the one the series was
// made from; each next one is made as long before its due time as that one was due after
// the series began, at most one step of the rule, and is due on the series' rule
// (tasks-recurrence.ts in contracts). Times are the database's clock.
//
// One job per series waits for the next time (migration 0121 keeps it in step with
// next_run_at). Making a task holds the series row, writes the task under a unique
// (series, occurrence) and moves next_occurrence in the same transaction, so a job that
// runs twice, or two at once, make each task once.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type AnyTask,
  type Command,
  type CommandContext,
  type TaskReference,
} from '@repo/commands';
import {
  DUE_TOO_OLD,
  lastOccurrenceBy,
  occurrenceDue,
  occurrenceWithinEnd,
  recurrenceDueTooOld,
  recurrencePeriod,
  taskFrequencies,
  type TaskRecurrence,
  type TaskRecurrenceInput,
  type TaskSchedule,
  zonedDay,
  zonedParts,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError, ValidationError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { recordsOf, version, type TaskOptions, type TaskRow } from './rows.js';

/** A series as it is kept, with its last day as written (YYYY-MM-DD). */
interface SeriesRow {
  readonly id: string;
  readonly record_id: string | null;
  readonly title: string;
  readonly body_text: string;
  readonly assignee_user_id: string | null;
  readonly frequency: string;
  readonly every: number;
  readonly anchor_due_at: Date;
  readonly anchor_occurrence: number;
  readonly time_zone: string;
  readonly lead_seconds: number;
  readonly ends_on: string | null;
  readonly max_occurrences: number | null;
  readonly create_if_overdue: boolean;
  readonly next_occurrence: number;
  readonly next_run_at: Date | null;
  readonly created_count: number;
}

const COLUMNS = sql`id, record_id, title, body_text, assignee_user_id, frequency, every,
  anchor_due_at, anchor_occurrence, time_zone, lead_seconds,
  to_char(ends_on, 'YYYY-MM-DD') as ends_on, max_occurrences, create_if_overdue,
  next_occurrence, next_run_at, created_count`;

/** The database's clock, which every write of the transaction is stamped with. */
async function databaseNow(trx: DatabaseTransaction): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`select now() as now`.execute(trx);
  const [row] = rows;
  if (row === undefined) throw new TypeError('The database must tell the time.');
  return row.now;
}

const frequencyOf = (value: string): TaskSchedule['frequency'] => {
  const frequency = taskFrequencies.find((each) => each === value);
  if (frequency === undefined) throw new TypeError('Unknown task frequency.');
  return frequency;
};

const scheduleOf = (series: SeriesRow): TaskSchedule => ({
  frequency: frequencyOf(series.frequency),
  every: series.every,
  anchorDueAt: series.anchor_due_at,
  anchorOccurrence: series.anchor_occurrence,
  timeZone: series.time_zone,
});

/** When the series makes occurrence n, and when that task is due; nothing once it has ended. */
function nextOf(
  series: SeriesRow,
  occurrence: number,
): { readonly dueAt: Date; readonly runAt: Date } | undefined {
  const dueAt = occurrenceDue(scheduleOf(series), occurrence);
  if (
    dueAt === undefined ||
    !occurrenceWithinEnd(dueAt, series.time_zone, {
      endsOn: series.ends_on,
      maxOccurrences: series.max_occurrences,
      occurrence,
    })
  )
    return undefined;
  return { dueAt, runAt: new Date(dueAt.getTime() - series.lead_seconds * 1000) };
}

async function readSeries(
  trx: DatabaseTransaction,
  ids: readonly string[],
  lock = false,
): Promise<Map<string, SeriesRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<SeriesRow>`
    select ${COLUMNS} from crm.task_series where id = any(${[...ids]}::uuid[])
    ${lock ? sql`for update` : sql``}
  `.execute(trx);
  return new Map(rows.map((row) => [row.id, row]));
}

/** Moves the series on to occurrence n, or ends it when its rule has no task left to make. */
async function moveTo(
  trx: DatabaseTransaction,
  series: SeriesRow,
  occurrence: number,
  createdCount: number,
): Promise<void> {
  const next = nextOf(series, occurrence);
  await sql`
    update crm.task_series
    set next_occurrence = ${occurrence}, created_count = ${createdCount},
      next_run_at = ${next?.runAt ?? null},
      ended_at = ${next === undefined ? sql`coalesce(ended_at, now())` : null}
    where id = ${series.id}
  `.execute(trx);
}

async function businessTimeZone(trx: DatabaseTransaction, businessId: string): Promise<string> {
  const { rows } = await sql<{ timezone: string }>`
    select timezone from tenancy.businesses where id = ${businessId}
  `.execute(trx);
  const [business] = rows;
  if (business === undefined) throw new TypeError('The business must be visible.');
  return business.timezone;
}

const endsOf = (
  recurrence: TaskRecurrenceInput,
): { readonly endsOn: string | null; readonly maxOccurrences: number | null } => ({
  endsOn: recurrence.ends.type === 'on' ? recurrence.ends.date : null,
  maxOccurrences: recurrence.ends.type === 'after' ? recurrence.ends.occurrences : null,
});

/**
 * A rule needs a due date to run from, at most one step of the rule in the past, and a last
 * day on or after it.
 */
function checkRule(
  recurrence: Pick<TaskRecurrenceInput, 'frequency' | 'every' | 'ends'>,
  dueAt: Date | null,
  timeZone: string,
  now: Date,
): Date {
  if (dueAt === null)
    throw new ValidationError([
      {
        path: '/dueAt',
        code: 'recurrence_needs_due',
        message: 'Give a recurring task a due date and time.',
      },
    ]);
  if (recurrenceDueTooOld(dueAt.toISOString(), recurrence, now.getTime()))
    throw new ValidationError([{ path: '/dueAt', code: 'due_too_old', message: DUE_TOO_OLD }]);
  if (recurrence.ends.type === 'on') {
    const first = zonedParts(dueAt, timeZone)?.date;
    if (first !== undefined && recurrence.ends.date < first)
      throw new ValidationError([
        {
          path: '/recurrence/ends/date',
          code: 'ends_before_due',
          message: 'End the series on or after the first due date.',
        },
      ]);
  }
  return dueAt;
}

/**
 * How long before its due time each task of a series is made: as long as the first is due
 * after now, never more than one step of the rule, so no two of a series wait at once.
 */
const leadOf = (rule: TaskRecurrenceInput, dueAt: Date, now: Date): number =>
  Math.max(
    0,
    Math.min(
      Math.floor(recurrencePeriod(rule).shortest / 1000),
      Math.round((dueAt.getTime() - now.getTime()) / 1000),
    ),
  );

/**
 * Makes the task the first of a new series: the task is occurrence 0, and the series makes
 * each next one its lead before it is due.
 */
export async function startSeries(
  trx: DatabaseTransaction,
  command: CommandContext,
  task: TaskRow,
  recurrence: TaskRecurrenceInput,
): Promise<TaskRow> {
  const businessId = requireBusiness(command.context);
  const timeZone = await businessTimeZone(trx, businessId);
  const now = await databaseNow(trx);
  const dueAt = checkRule(recurrence, task.due_at, timeZone, now);
  const lead = leadOf(recurrence, dueAt, now);
  const { endsOn, maxOccurrences } = endsOf(recurrence);
  const { rows } = await sql<SeriesRow>`
    insert into crm.task_series (business_id, record_id, title, body_text, assignee_user_id,
      frequency, every, anchor_due_at, anchor_occurrence, time_zone, lead_seconds, ends_on,
      max_occurrences, create_if_overdue, next_occurrence, created_count, next_run_at, ended_at,
      created_by_kind, created_by_id)
    values (${businessId}, ${task.record_id}, ${task.title}, ${task.body_text},
      ${task.assignee_user_id}, ${recurrence.frequency}, ${recurrence.every}, ${dueAt}, 0,
      ${timeZone}, ${lead}, ${endsOn}::date, ${maxOccurrences}, ${recurrence.createIfOverdue},
      1, 1, null, now(), ${command.context.actorKind}, ${command.context.actorId ?? null})
    returning ${COLUMNS}
  `.execute(trx);
  const [series] = rows;
  if (series === undefined) throw new TypeError('The series must be saved.');
  await moveTo(trx, series, 1, 1);
  return trx
    .updateTable('crm.tasks')
    .set({ series_id: series.id, occurrence: 0 })
    .where('id', '=', task.id)
    .returningAll()
    .returning(version)
    .executeTakeFirstOrThrow();
}

/**
 * An edit of the whole series from one of its tasks: the series and its later open tasks
 * take the title, description and assignee. When the rule or this task's due time changed,
 * the rule runs on from this task (the anchor moves to it) and the later open tasks already
 * made are dated anew by it; otherwise the schedule stays where it was, so a month's task
 * kept on the 28th of February is back on the 31st in March. null stops the series, keeping
 * its tasks; an edit without a rule leaves a stopped series stopped.
 */
export async function editSeries(
  trx: DatabaseTransaction,
  command: CommandContext,
  before: TaskRow,
  task: TaskRow,
  recurrence: TaskRecurrenceInput | null | undefined,
): Promise<void> {
  const businessId = requireBusiness(command.context);
  if (task.series_id === null || task.occurrence === null) return;
  const series = (await readSeries(trx, [task.series_id], true)).get(task.series_id);
  if (series === undefined) throw new TypeError('The series must be visible.');
  await sql`
    update crm.task_series
    set title = ${task.title}, body_text = ${task.body_text}, assignee_user_id = ${task.assignee_user_id}
    where id = ${series.id}
  `.execute(trx);
  const later = await trx
    .selectFrom('crm.tasks')
    .select(['id', 'record_id', 'assignee_user_id', 'occurrence', 'due_at'])
    .where('series_id', '=', series.id)
    .where('occurrence', '>', task.occurrence)
    .where('completed_at', 'is', null)
    .orderBy('occurrence')
    .forUpdate()
    .execute();
  for (const row of later) {
    await trx
      .updateTable('crm.tasks')
      .set({
        title: task.title,
        body_text: task.body_text,
        assignee_user_id: task.assignee_user_id,
      })
      .where('id', '=', row.id)
      .execute();
    // As a single edit says it: the assignee is named only when this gave the task to them.
    await command.emit({
      type: 'task.updated',
      subject: { kind: 'task', id: row.id },
      records: row.record_id === null ? [] : [row.record_id],
      payload: {
        recordId: await publicRecordId(trx, row.record_id),
        ...(task.assignee_user_id === null || row.assignee_user_id === task.assignee_user_id
          ? {}
          : { assignedUserId: task.assignee_user_id }),
      },
    });
  }
  if (recurrence === null) {
    await sql`
      update crm.task_series set next_run_at = null, ended_at = coalesce(ended_at, now())
      where id = ${series.id}
    `.execute(trx);
    return;
  }
  const ended = series.next_run_at === null;
  if (ended && recurrence === undefined) return;
  const ends = recurrence === undefined ? undefined : endsOf(recurrence);
  const ruleMoved =
    recurrence !== undefined &&
    (recurrence.frequency !== series.frequency || recurrence.every !== series.every);
  const endChanged =
    recurrence !== undefined &&
    ends !== undefined &&
    (ends.endsOn !== series.ends_on ||
      ends.maxOccurrences !== series.max_occurrences ||
      recurrence.createIfOverdue !== series.create_if_overdue);
  const dueMoved = before.due_at?.getTime() !== task.due_at?.getTime();
  // A stopped series given a rule starts again from this task.
  const anchorMoves = ruleMoved || dueMoved || ended;
  if (!anchorMoves && !endChanged) return;
  const now = await databaseNow(trx);
  const rule = recurrence ?? {
    frequency: frequencyOf(series.frequency),
    every: series.every,
    ends: { type: 'never' as const },
  };
  const timeZone =
    recurrence === undefined ? series.time_zone : await businessTimeZone(trx, businessId);
  const dueAt = anchorMoves ? checkRule(rule, task.due_at, timeZone, now) : series.anchor_due_at;
  const { rows } = await sql<SeriesRow>`
    update crm.task_series
    set anchor_due_at = ${dueAt},
      anchor_occurrence = ${anchorMoves ? task.occurrence : series.anchor_occurrence},
      time_zone = ${anchorMoves ? timeZone : series.time_zone}
      ${
        recurrence === undefined || ends === undefined
          ? sql``
          : sql`, frequency = ${recurrence.frequency}, every = ${recurrence.every},
              ends_on = ${ends.endsOn}::date, max_occurrences = ${ends.maxOccurrences},
              create_if_overdue = ${recurrence.createIfOverdue}`
      }
    where id = ${series.id}
    returning ${COLUMNS}
  `.execute(trx);
  const [edited] = rows;
  if (edited === undefined) throw new TypeError('The series must be saved.');
  if (!anchorMoves) {
    await moveTo(trx, edited, edited.next_occurrence, edited.created_count);
    return;
  }
  // The later open tasks already made are dated by the rule as it is now, in their order; one
  // the rule no longer reaches goes.
  for (const row of later) {
    const next = nextOf(edited, row.occurrence ?? 0);
    if (next === undefined) {
      await trx.deleteFrom('crm.tasks').where('id', '=', row.id).execute();
      await command.emit({
        type: 'task.deleted',
        subject: { kind: 'task', id: row.id },
        records: row.record_id === null ? [] : [row.record_id],
        payload: { recordId: await publicRecordId(trx, row.record_id) },
      });
    } else if (next.dueAt.getTime() !== row.due_at?.getTime()) {
      await trx
        .updateTable('crm.tasks')
        .set({ due_at: next.dueAt })
        .where('id', '=', row.id)
        .execute();
      await command.emit({
        type: 'task.updated',
        subject: { kind: 'task', id: row.id },
        records: row.record_id === null ? [] : [row.record_id],
        payload: { recordId: await publicRecordId(trx, row.record_id) },
      });
    }
  }
  const { rows: last } = await sql<{ occurrence: number }>`
    select coalesce(max(occurrence), 0) as occurrence from crm.tasks where series_id = ${series.id}
  `.execute(trx);
  const next = Math.max(task.occurrence, last[0]?.occurrence ?? 0) + 1;
  await moveTo(trx, edited, next, edited.created_count);
}

async function publicRecordId(
  trx: DatabaseTransaction,
  recordId: string | null,
): Promise<string | null> {
  if (recordId === null) return null;
  return (await recordsOf(trx, [{ record_id: recordId }])).get(recordId)?.id ?? null;
}

/**
 * Ends a task's series from it on: the series' later open tasks are deleted and it makes no
 * more. Its completed tasks stay; the task itself is the caller's to delete.
 */
export async function deleteSeriesFrom(
  trx: DatabaseTransaction,
  command: CommandContext,
  task: TaskRow,
): Promise<void> {
  if (task.series_id === null || task.occurrence === null) return;
  await readSeries(trx, [task.series_id], true);
  await sql`
    update crm.task_series set next_run_at = null, ended_at = coalesce(ended_at, now())
    where id = ${task.series_id}
  `.execute(trx);
  const removed = await trx
    .deleteFrom('crm.tasks')
    .where('series_id', '=', task.series_id)
    .where('occurrence', '>', task.occurrence)
    .where('completed_at', 'is', null)
    .returning(['id', 'record_id'])
    .execute();
  for (const row of removed)
    await command.emit({
      type: 'task.deleted',
      subject: { kind: 'task', id: row.id },
      records: row.record_id === null ? [] : [row.record_id],
      payload: { recordId: await publicRecordId(trx, row.record_id) },
    });
}

/** How each task of a series repeats, for the tasks a list or a save shows. */
export async function recurrencesOf(
  trx: DatabaseTransaction,
  rows: readonly Pick<TaskRow, 'series_id' | 'occurrence'>[],
): Promise<(row: Pick<TaskRow, 'series_id' | 'occurrence'>) => TaskRecurrence | undefined> {
  const series = await readSeries(trx, [
    ...new Set(rows.flatMap((row) => (row.series_id === null ? [] : [row.series_id]))),
  ]);
  return (row) => {
    if (row.series_id === null || row.occurrence === null) return undefined;
    const kept = series.get(row.series_id);
    if (kept === undefined) return undefined;
    const active = kept.next_run_at !== null;
    return {
      frequency: frequencyOf(kept.frequency),
      every: kept.every,
      ends:
        kept.ends_on !== null
          ? { type: 'on', date: kept.ends_on }
          : kept.max_occurrences !== null
            ? { type: 'after', occurrences: kept.max_occurrences }
            : { type: 'never' },
      createIfOverdue: kept.create_if_overdue,
      occurrence: row.occurrence,
      active,
      nextDueAt: active
        ? (occurrenceDue(scheduleOf(kept), kept.next_occurrence)?.toISOString() ?? null)
        : null,
    };
  };
}

export const createOccurrenceReference = {
  name: 'tasks.create_occurrence',
  data: z.strictObject({ seriesId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

/**
 * Makes the series' task that is due to be made, if it still is, and moves the series on.
 * A task already overdue when a later one is due to be made is passed over, so a worker that
 * was down makes the newest, not a backlog. With create_if_overdue off, no task is made
 * while the one before it is open and overdue. A series whose record is in the trash makes
 * none until it is restored. Only the worker runs it.
 */
export function createOccurrenceCommand(
  options: TaskOptions,
): Command<typeof createOccurrenceReference.data, { readonly created: boolean }> {
  return defineCommand({
    name: 'task.create_occurrence',
    permission: 'tasks.manage',
    input: createOccurrenceReference.data,
    async handle(trx, input, command): Promise<{ readonly created: boolean }> {
      if (command.context.actorKind !== 'system')
        throw new ForbiddenError('Only the worker makes the tasks of a series.');
      const businessId = requireBusiness(command.context);
      const series = (await readSeries(trx, [input.seriesId], true)).get(input.seriesId);
      if (series?.next_run_at === undefined || series.next_run_at === null)
        return { created: false };
      const now = await databaseNow(trx);
      // Woken early by a job that outlived a change: wait again for the time kept.
      if (series.next_run_at.getTime() > now.getTime()) {
        await moveTo(trx, series, series.next_occurrence, series.created_count);
        return { created: false };
      }
      // A task of the series that is not due yet waits first: none is made until it is due.
      const { rows: waiting } = await sql<{ due_at: Date }>`
        select min(due_at) as due_at from crm.tasks
        where series_id = ${series.id} and completed_at is null and due_at > ${now}
        having min(due_at) is not null
      `.execute(trx);
      const pending = waiting[0]?.due_at;
      if (pending !== undefined) {
        await sql`
          update crm.task_series set next_run_at = ${pending} where id = ${series.id}
        `.execute(trx);
        return { created: false };
      }
      // The newest occurrence whose time to be made has come, worked out in one step: a task
      // already overdue when a later one is due to be made is passed over, so a worker that
      // was down makes the newest, not a backlog. Never past the series' end.
      const schedule = scheduleOf(series);
      let occurrence = Math.max(
        series.next_occurrence,
        lastOccurrenceBy(schedule, new Date(now.getTime() + series.lead_seconds * 1000)),
      );
      if (series.max_occurrences !== null)
        occurrence = Math.min(occurrence, series.max_occurrences - 1);
      const lastDay =
        series.ends_on === null ? undefined : zonedDay(series.ends_on, series.time_zone);
      if (lastDay !== undefined)
        occurrence = Math.min(
          occurrence,
          lastOccurrenceBy(schedule, new Date(lastDay.end.getTime() - 1)),
        );
      occurrence = Math.max(occurrence, series.next_occurrence);
      const slot = nextOf(series, occurrence);
      if (slot === undefined) {
        await moveTo(trx, series, occurrence, series.created_count);
        return { created: false };
      }
      const made = await makeTask(
        trx,
        command,
        options,
        businessId,
        series,
        occurrence,
        slot.dueAt,
      );
      await moveTo(trx, series, occurrence + 1, series.created_count + (made ? 1 : 0));
      return { created: made };
    },
  });
}

async function makeTask(
  trx: DatabaseTransaction,
  command: CommandContext,
  options: TaskOptions,
  businessId: string,
  series: SeriesRow,
  occurrence: number,
  dueAt: Date,
): Promise<boolean> {
  if (!series.create_if_overdue) {
    const { rows } = await sql`
      select 1 from crm.tasks
      where series_id = ${series.id} and occurrence < ${occurrence}
        and completed_at is null and due_at <= now()
      limit 1
    `.execute(trx);
    if (rows.length > 0) return false;
  }
  if (series.record_id !== null) {
    const { rows } = await sql<{ trashed: boolean }>`
      select coalesce(c.deleted_at, co.deleted_at, d.deleted_at, cr.deleted_at) is not null
        as trashed
      from crm.records r
      left join crm.contacts c on c.id = r.id
      left join crm.companies co on co.id = r.id
      left join crm.deals d on d.id = r.id
      left join crm.custom_records cr on cr.id = r.id
      where r.id = ${series.record_id}
    `.execute(trx);
    if (rows[0]?.trashed !== false) return false;
  }
  // Someone no longer on the team is given no new task: it is made unassigned.
  const assignee =
    series.assignee_user_id === null
      ? null
      : (await options.assignees.memberships(trx, command.context, [series.assignee_user_id])).has(
            series.assignee_user_id,
          )
        ? series.assignee_user_id
        : null;
  const { rows } = await sql<{ id: string }>`
    insert into crm.tasks (business_id, record_id, title, body_text, due_at, assignee_user_id,
      series_id, occurrence, created_by_kind, created_by_id)
    values (${businessId}, ${series.record_id}, ${series.title}, ${series.body_text}, ${dueAt},
      ${assignee}, ${series.id}, ${occurrence}, 'system', null)
    on conflict (business_id, series_id, occurrence) where series_id is not null do nothing
    returning id
  `.execute(trx);
  const [task] = rows;
  if (task === undefined) return false;
  await command.emit({
    type: 'task.created',
    subject: { kind: 'task', id: task.id },
    records: series.record_id === null ? [] : [series.record_id],
    payload: {
      recordId: await publicRecordId(trx, series.record_id),
      ...(assignee === null ? {} : { assignedUserId: assignee }),
    },
  });
  return true;
}

/** The series job, for the worker to run: each in its business, as the system. */
export function createTaskSeriesTasks(options: TaskOptions): readonly AnyTask[] {
  const command = createOccurrenceCommand(options);
  return [
    defineTask({
      ...createOccurrenceReference,
      async run(data, job) {
        await runCommand(job.services, command, data, { ...job.invocation, permissions: 'all' });
      },
    }),
  ];
}
