// The two jobs as the worker runs them: once per event and person however often and however
// many at once, and a task's due time told at that time, if it still holds.
import { randomUUID } from 'node:crypto';

import type { AnyTask, JobRun } from '@repo/commands';
import { withTenant } from '@repo/db';
import { describe, expect, it } from 'vitest';

import { event, place, suite, things, toldIn, type Place } from '../test/fixtures.js';
import {
  fromEventReference,
  notificationTasks,
  notifyOfEvent,
  notifyTaskDue,
  taskDueReference,
} from './index.js';

const s = suite();

function taskNamed(name: string): AnyTask {
  const task = notificationTasks.find((each) => each.name === name);
  if (task === undefined) throw new Error(`No task named ${name}.`);
  return task;
}

/** Runs a job as the worker does: in the job's business, as the system. */
const work = (at: Place, name: string, data: unknown) => {
  const task = taskNamed(name);
  const job: JobRun = {
    invocation: { context: at.system, permissions: 'all' },
    services: s.services,
  };
  return task.run(task.data.parse(data), job);
};

/** How many transactions of this database wait on a lock. Only the superuser sees them. */
const waiting = () =>
  s.database.as('postgres', async (sql) => {
    const [row] = await sql.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    return row?.waiting ?? 0;
  });

/** An event that tells the owner: a conversation of theirs got a message. */
async function messageFor(at: Place): Promise<string> {
  const conversationId = await (await things(s, at)).conversation(at.owner.id);
  return event(s, at, 'message.received', {
    subject: { kind: 'message', id: randomUUID() },
    payload: { conversationId },
  });
}

describe('the worker’s tasks', () => {
  it('are these three, each taking only the id it works from', () => {
    expect(notificationTasks.map((task) => task.name)).toEqual([
      'notifications.from_event',
      'notifications.task_due',
      'notifications.task_reminder',
    ]);
    expect(fromEventReference.name).toBe('notifications.from_event');
    expect(taskDueReference.name).toBe('notifications.task_due');
    expect(fromEventReference.data.safeParse({ eventId: randomUUID(), extra: 1 }).success).toBe(
      false,
    );
    expect(
      taskDueReference.data.safeParse({ taskId: 'task_01h455vb4pex5vsknk084sn02q' }).success,
    ).toBe(false);
  });
});

describe('the job for an event', () => {
  it('tells the person, and run again tells nobody a second time', async () => {
    const at = await place(s);
    const eventId = await messageFor(at);
    await work(at, 'notifications.from_event', { eventId });
    await work(at, 'notifications.from_event', { eventId });
    await work(at, 'notifications.from_event', { eventId });
    expect((await toldIn(s, at)).map((row) => [row.kind, row.user_id, row.source_key])).toEqual([
      ['message.received', at.owner.id, `event:${eventId}`],
    ]);
  });

  it('run by two workers at once tells the person once', async () => {
    const at = await place(s);
    const eventId = await messageFor(at);
    // The first job stops inside its transaction, after writing, until the second is
    // waiting on the database for it; only then does the first commit. So the two truly
    // overlap, and nothing here depends on how long anything takes.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const written = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const first = withTenant(s.db, at.system, async (trx) => {
      const told = await notifyOfEvent(trx, at.system, eventId);
      reached();
      await held;
      return told;
    });
    await written;
    const second = work(at, 'notifications.from_event', { eventId });
    await expect.poll(waiting, { timeout: 10_000, interval: 50 }).toBe(1);
    release();
    expect(await first).toBe(1);
    await second;
    expect((await toldIn(s, at)).map((row) => [row.user_id, row.source_key])).toEqual([
      [at.owner.id, `event:${eventId}`],
    ]);
  });

  it('whose first run failed after writing is told by the second, once', async () => {
    const at = await place(s);
    const eventId = await messageFor(at);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const written = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const first = withTenant(s.db, at.system, async (trx) => {
      await notifyOfEvent(trx, at.system, eventId);
      reached();
      await held;
      throw new Error('the worker died before the job was done');
    });
    await written;
    const second = work(at, 'notifications.from_event', { eventId });
    await expect.poll(waiting, { timeout: 10_000, interval: 50 }).toBe(1);
    release();
    await expect(first).rejects.toThrow('the worker died before the job was done');
    await second;
    expect((await toldIn(s, at)).map((row) => row.user_id)).toEqual([at.owner.id]);
  });

  it('for an event that tells nobody finishes without writing', async () => {
    const at = await place(s);
    await work(at, 'notifications.from_event', { eventId: randomUUID() });
    expect(await toldIn(s, at)).toEqual([]);
  });
});

describe('the job at a task’s due time', () => {
  const due = (at: Place, taskId: string) =>
    withTenant(s.db, at.system, (trx) => notifyTaskDue(trx, at.system, taskId));

  it('tells the assignee the task is due, even one they gave themselves', async () => {
    const at = await place(s);
    const { contactId, task } = await things(s, at);
    const taskId = await task({
      assignee: at.owner.id,
      dueIn: '-1 minute',
      title: 'Send the quote',
    });
    await work(at, 'notifications.task_due', { taskId });
    const [told, ...rest] = await toldIn(s, at);
    expect(rest).toEqual([]);
    expect(told).toMatchObject({
      user_id: at.owner.id,
      kind: 'task.due',
      collapse_key: `task.due:${taskId}`,
      event_id: null,
      actor_kind: 'system',
      actor_id: null,
      subject_kind: 'task',
      subject_id: taskId,
      record_id: contactId,
      title: 'Send the quote',
      body: null,
    });
    expect(told?.source_key).toMatch(new RegExp(`^task\\.due:${taskId}:\\d{4}-\\d\\d-\\d\\dT`));
  });

  it('run again tells nobody a second time, and a new due time is told of once it comes', async () => {
    const at = await place(s);
    const taskId = await (await things(s, at)).task({ assignee: at.owner.id, dueIn: '-2 hours' });
    expect(await due(at, taskId)).toBe(1);
    expect(await due(at, taskId)).toBe(0);
    // Moved to another time that has also come, and read meanwhile: told of again.
    await s.database.withTenant(at.owner.context, (sql) =>
      sql.query('update notifications.notifications set read_at = now() where user_id = $1', [
        at.owner.id,
      ]),
    );
    await s.database.withTenant(at.system, (sql) =>
      sql.query("update crm.tasks set due_at = now() - interval '1 hour' where id = $1", [taskId]),
    );
    expect(await due(at, taskId)).toBe(1);
    expect(await toldIn(s, at)).toHaveLength(2);
  });

  it.each([
    ['is completed', { assignee: 'owner', dueIn: '-1 minute', completed: true }],
    ['has nobody', { assignee: null, dueIn: '-1 minute' }],
    ['has no due time', { assignee: 'owner', dueIn: null }],
    ['was moved later, past now', { assignee: 'owner', dueIn: '1 hour' }],
  ] as const)('tells nobody when the task %s', async (_name, values) => {
    const at = await place(s);
    const taskId = await (
      await things(s, at)
    ).task({
      ...values,
      assignee: values.assignee === null ? null : at.owner.id,
    });
    expect(await due(at, taskId)).toBe(0);
    expect(await toldIn(s, at)).toEqual([]);
  });

  it('tells nobody of a task that is gone, or of another business’s', async () => {
    const at = await place(s);
    const elsewhere = await place(s);
    const theirs = await (
      await things(s, elsewhere)
    ).task({
      assignee: elsewhere.owner.id,
      dueIn: '-1 minute',
    });
    expect(await due(at, randomUUID())).toBe(0);
    expect(await due(at, theirs)).toBe(0);
    expect(await toldIn(s, elsewhere)).toEqual([]);
  });
});
