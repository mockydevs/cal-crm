// Reminders before a task is due: each person chooses how long before a task assigned to
// them is due they are reminded. The database keeps one job per task at that time, moved
// with the task and the choice; the job reminds them once, in the app, if it still holds.
import { randomUUID } from 'node:crypto';

import { withTenant } from '@repo/db';
import { describe, expect, it } from 'vitest';

import { place, suite, things, toldIn, type Person, type Place } from '../test/fixtures.js';
import { notifyTaskReminder, readPreferences, savePreferences } from './index.js';

const s = suite();

const choose = (person: Person, remindMinutes: number | null, inApp = true) =>
  withTenant(s.db, person.context, (trx) =>
    savePreferences(trx, person.invocation, {
      items: [{ kind: 'task.reminder', inApp, remindMinutes }],
    }),
  );

const remind = (at: Place, taskId: string) =>
  withTenant(s.db, at.system, (trx) => notifyTaskReminder(trx, at.system, taskId));

/** The waiting reminder job of a task: how long before now it is due to run, in minutes. */
const job = async (taskId: string): Promise<number | undefined> => {
  const rows = await s.database.as('crm_owner', (sql) =>
    sql.query<{ minutes: number }>(
      `select round(extract(epoch from j.run_at - now()) / 60)::int as minutes
       from graphile_worker.jobs j
       where j.task_identifier = 'notifications.task_reminder'
         and j.key = 'notify-task-reminder:' || $1::text`,
      [taskId],
    ),
  );
  return rows[0]?.minutes;
};

describe('the reminder time', () => {
  it('is none until chosen, is read back, and stays when only the switch is sent', async () => {
    const at = await place(s);
    const read = () =>
      withTenant(s.db, at.owner.context, (trx) => readPreferences(trx, at.owner.invocation));
    const reminderOf = async () =>
      (await read()).items.find((item) => item.kind === 'task.reminder');
    expect(await reminderOf()).toEqual({ kind: 'task.reminder', inApp: true, remindMinutes: null });
    await choose(at.owner, 90);
    expect(await reminderOf()).toEqual({ kind: 'task.reminder', inApp: true, remindMinutes: 90 });
    await withTenant(s.db, at.owner.context, (trx) =>
      savePreferences(trx, at.owner.invocation, {
        items: [{ kind: 'task.reminder', inApp: false }],
      }),
    );
    expect(await reminderOf()).toEqual({ kind: 'task.reminder', inApp: false, remindMinutes: 90 });
  });

  it('is one person’s own: another’s choice reminds them of nothing', async () => {
    const at = await place(s);
    const member = await at.join('member');
    await choose(member, 60);
    const taskId = await (await things(s, at)).task({ assignee: at.owner.id, dueIn: '30 minutes' });
    expect(await job(taskId)).toBeUndefined();
    expect(await remind(at, taskId)).toBe(0);
  });
});

describe('the reminder job', () => {
  it('is queued at the chosen time before the task is due, and moves with the task', async () => {
    const at = await place(s);
    await choose(at.owner, 60);
    const { task } = await things(s, at);
    const taskId = await task({ assignee: at.owner.id, dueIn: '3 hours' });
    expect(await job(taskId)).toBe(120);
    await s.database.withTenant(at.system, (sql) =>
      sql.query("update crm.tasks set due_at = now() + interval '5 hours' where id = $1", [taskId]),
    );
    expect(await job(taskId)).toBe(240);
    // Within the time already: reminded now.
    await s.database.withTenant(at.system, (sql) =>
      sql.query("update crm.tasks set due_at = now() + interval '20 minutes' where id = $1", [
        taskId,
      ]),
    );
    expect(await job(taskId)).toBe(0);
    await s.database.withTenant(at.system, (sql) =>
      sql.query(
        "update crm.tasks set completed_at = now(), completed_by_kind = 'system' where id = $1",
        [taskId],
      ),
    );
    expect(await job(taskId)).toBeUndefined();
  });

  it('follows a change of the person’s choice for their open tasks due later', async () => {
    const at = await place(s);
    const { task } = await things(s, at);
    const later = await task({ assignee: at.owner.id, dueIn: '2 days' });
    const done = await task({ assignee: at.owner.id, dueIn: '2 days', completed: true });
    expect(await job(later)).toBeUndefined();
    await choose(at.owner, 24 * 60);
    expect(await job(later)).toBe(24 * 60);
    expect(await job(done)).toBeUndefined();
    await choose(at.owner, 24 * 60, false);
    expect(await job(later)).toBeUndefined();
    await choose(at.owner, 30);
    expect(await job(later)).toBe(2 * 24 * 60 - 30);
    await choose(at.owner, null);
    expect(await job(later)).toBeUndefined();
  });

  it('reminds the assignee once, and again for a new due time', async () => {
    const at = await place(s);
    await choose(at.owner, 30);
    const { contactId, task } = await things(s, at);
    const taskId = await task({ assignee: at.owner.id, dueIn: '10 minutes', title: 'Call back' });
    expect(await remind(at, taskId)).toBe(1);
    expect(await remind(at, taskId)).toBe(0);
    const [told] = await toldIn(s, at);
    expect(told).toMatchObject({
      user_id: at.owner.id,
      kind: 'task.reminder',
      collapse_key: `task.reminder:${taskId}`,
      actor_kind: 'system',
      subject_kind: 'task',
      subject_id: taskId,
      record_id: contactId,
      title: 'Call back',
    });
    await s.database.withTenant(at.owner.context, (sql) =>
      sql.query('update notifications.notifications set read_at = now() where user_id = $1', [
        at.owner.id,
      ]),
    );
    await s.database.withTenant(at.system, (sql) =>
      sql.query("update crm.tasks set due_at = now() + interval '20 minutes' where id = $1", [
        taskId,
      ]),
    );
    expect(await remind(at, taskId)).toBe(1);
  });

  it.each([
    ['nobody chose a time', { minutes: null, dueIn: '10 minutes' }],
    ['the reminder is switched off', { minutes: 30, inApp: false, dueIn: '10 minutes' }],
    ['its time has not come', { minutes: 30, dueIn: '2 hours' }],
    ['it is due already', { minutes: 30, dueIn: '-1 minute' }],
    ['it is completed', { minutes: 30, dueIn: '10 minutes', completed: true }],
    ['it has nobody', { minutes: 30, dueIn: '10 minutes', nobody: true }],
  ] as const)('tells nobody when %s', async (_name, values) => {
    const at = await place(s);
    await choose(at.owner, values.minutes, 'inApp' in values ? values.inApp : true);
    const taskId = await (
      await things(s, at)
    ).task({
      assignee: 'nobody' in values ? null : at.owner.id,
      dueIn: values.dueIn,
      completed: 'completed' in values,
    });
    expect(await remind(at, taskId)).toBe(0);
    expect(await toldIn(s, at)).toEqual([]);
  });

  it('tells nobody of a task that is gone, or of another business’s', async () => {
    const at = await place(s);
    const elsewhere = await place(s);
    await choose(elsewhere.owner, 30);
    const theirs = await (
      await things(s, elsewhere)
    ).task({ assignee: elsewhere.owner.id, dueIn: '10 minutes' });
    expect(await remind(at, randomUUID())).toBe(0);
    expect(await remind(at, theirs)).toBe(0);
    expect(await toldIn(s, elsewhere)).toEqual([]);
  });
});

describe('a save of the preferences', () => {
  /** How often the task's reminder job was queued again: Graphile Worker counts each. */
  const queued = async (taskId: string): Promise<number | undefined> => {
    const rows = await s.database.as('crm_owner', (sql) =>
      sql.query<{ revision: number }>(
        `select p.revision from graphile_worker._private_jobs p
         where p.key = 'notify-task-reminder:' || $1::text`,
        [taskId],
      ),
    );
    return rows[0]?.revision;
  };

  it('moves no reminder when it changes neither the switch nor the time', async () => {
    const at = await place(s);
    await choose(at.owner, 60);
    const taskId = await (await things(s, at)).task({ assignee: at.owner.id, dueIn: '1 day' });
    const before = await queued(taskId);
    expect(before).toBeDefined();
    await choose(at.owner, 60);
    expect(await queued(taskId)).toBe(before);
    await withTenant(s.db, at.owner.context, (trx) =>
      savePreferences(trx, at.owner.invocation, {
        items: [{ kind: 'task.due', inApp: false }],
      }),
    );
    expect(await queued(taskId)).toBe(before);
    await choose(at.owner, 30);
    expect(await queued(taskId)).toBe((before ?? 0) + 1);
  });
});
