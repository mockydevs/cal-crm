// One change applied to many tasks at once. Against a migrated Postgres as crm_app under
// row-level security, through the routes the server registers.
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { bulkTasksResult, task, taskList, type BulkTasksResult, type Task } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, team, type Team } from '../../test/contact-details.js';
import { taskRoutes } from './routes.js';
import type { TaskOptions } from './tasks.js';

let database: TestDatabase;
let db: Database;
let services: Services;

/** Runs inside the command, each time it asks which membership a stored assignee has now. */
const hook: { beforeMemberships: () => Promise<void> } = {
  beforeMemberships: () => Promise.resolve(),
};
const lookups = detailOptions();
const options: TaskOptions = {
  actorNames: lookups.actorNames,
  assignees: {
    resolve: lookups.assignees.resolve,
    memberships: async (trx, context, userIds) => {
      await hook.beforeMemberships();
      return lookups.assignees.memberships(trx, context, userIds);
    },
    read: () => Promise.resolve({ items: [], nextCursor: null }),
  },
};
const routes = taskRoutes(options);

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

async function call(
  operationId: string,
  invocation: Invocation,
  request: { id?: string; body?: unknown; query?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.id === undefined ? {} : { id: request.id },
      body: request.body,
      query: request.query ?? {},
    },
    services,
  );
}
const make = async (invocation: Invocation, title: string, more: object = {}): Promise<Task> =>
  task.parse(await call('createTask', invocation, { body: { title, ...more } }));
const bulk = async (invocation: Invocation, body: object): Promise<BulkTasksResult> =>
  bulkTasksResult.parse(await call('bulkUpdateTasks', invocation, { body }));
const all = async (invocation: Invocation): Promise<Task[]> =>
  taskList.parse(await call('listTasks', invocation, { query: { status: 'all' } })).items;
const one = async (invocation: Invocation, id: string): Promise<Task> => {
  const found = (await all(invocation)).find((each) => each.id === id);
  if (found === undefined) throw new Error(`Task ${id} is not listed.`);
  return found;
};
const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
const outcomes = (result: BulkTasksResult) => result.results.map((each) => each.outcome);
const done = (id: string) => ({ id, outcome: 'done', reason: null });
const unchanged = (id: string) => ({ id, outcome: 'unchanged', reason: null });

interface StoredEvent {
  type: string;
  subject: string;
  payload: unknown;
  records: string[];
}
/** The business's task events with the records whose timeline each is on, oldest first. */
const events = (t: Team): Promise<StoredEvent[]> =>
  database.as('crm_owner', (sql) =>
    sql.query<StoredEvent>(
      `select e.type, e.subject_id as subject, e.payload,
              coalesce((select array_agg(l.record_id::text order by l.record_id)
                        from crm.timeline_entries l where l.event_id = e.id), '{}') as records
       from events.events e
       where e.business_id = $1 and e.type like 'task.%' and e.type <> 'task.created'
       order by e.recorded_at, e.id`,
      [t.businessId],
    ),
  );
const audits = (t: Team, command: string) =>
  database.as('crm_owner', (sql) =>
    sql.query<{ outcome: string; input: unknown; events: number }>(
      `select outcome, input, cardinality(event_ids) as events from audit.commands
       where business_id = $1 and command = $2 order by recorded_at, id`,
      [t.businessId, command],
    ),
  );
const contactOf = async (t: Team, firstName: string) =>
  toPublicId('contact', (await database.fixtures.contact(t.context, { firstName })).id);
const uuidOf = (id: string) => parsePublicId('task', id) ?? '';
/** What an event looks like once the task it is about is left out: the rest must be equal. */
const shape = (event: StoredEvent | undefined) =>
  event === undefined ? undefined : { type: event.type, payload: event.payload };

describe('a bulk action on tasks', () => {
  it('completes and reopens each task that is not already so, with the events one change makes', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const recordId = await contactOf(t, 'Maya');
    const first = await make(dana.as(), 'One', { recordId });
    const second = await make(dana.as(), 'Two');
    const third = await make(dana.as(), 'Three');
    // One task completed the ordinary way: what a bulk completion must look like.
    const single = task.parse(
      await call('completeTask', dana.as(), {
        id: third.id,
        body: { completed: true, revision: third.revision },
      }),
    );

    const result = await bulk(dana.as(), {
      action: 'complete',
      ids: [second.id, third.id, first.id],
    });
    expect(result).toEqual({
      action: 'complete',
      results: [done(second.id), unchanged(third.id), done(first.id)],
      done: 2,
      unchanged: 1,
      skipped: 0,
    });
    for (const each of [first, second, third]) {
      const now = await one(dana.as(), each.id);
      expect(now.completedAt).not.toBeNull();
      expect(now.completedBy).toEqual({ kind: 'user', name: 'Dana Brooks', you: true });
    }
    // Left alone means left alone: the task completed before is exactly as it was.
    expect(await one(dana.as(), third.id)).toEqual(single);

    const completed = await events(t);
    const byTask = (id: string) => completed.filter((each) => each.subject === uuidOf(id));
    expect(completed.map((each) => each.type)).toEqual([
      'task.completed',
      'task.completed',
      'task.completed',
    ]);
    const ordinary = byTask(third.id)[0];
    expect(shape(byTask(second.id)[0])).toEqual(shape(ordinary));
    expect(byTask(second.id)[0]?.records).toEqual([]);
    // A task of a contact is on the contact's timeline, as the single change puts it.
    expect(byTask(first.id)[0]).toMatchObject({
      type: 'task.completed',
      payload: { recordId },
      records: [parsePublicId('contact', recordId)],
    });

    // The same request again changes nothing and writes no event.
    const again = await bulk(dana.as(), {
      action: 'complete',
      ids: [second.id, third.id, first.id],
    });
    expect(again).toMatchObject({ done: 0, unchanged: 3, skipped: 0 });
    expect(await events(t)).toHaveLength(3);

    const reopened = await bulk(dana.as(), { action: 'reopen', ids: [first.id, second.id] });
    expect(outcomes(reopened)).toEqual(['done', 'done']);
    expect((await one(dana.as(), first.id)).completedAt).toBeNull();
    expect((await one(dana.as(), first.id)).completedBy).toBeNull();
    expect((await one(dana.as(), third.id)).completedAt).not.toBeNull();
    expect((await events(t)).slice(3).map((each) => each.type)).toEqual([
      'task.reopened',
      'task.reopened',
    ]);

    // One audit row for each request, holding the action and the tasks and every event.
    expect(await audits(t, 'task.bulk')).toEqual([
      {
        outcome: 'ok',
        input: { action: 'complete', ids: [second.id, third.id, first.id] },
        events: 2,
      },
      {
        outcome: 'ok',
        input: { action: 'complete', ids: [second.id, third.id, first.id] },
        events: 0,
      },
      { outcome: 'ok', input: { action: 'reopen', ids: [first.id, second.id] }, events: 2 },
    ]);
  });

  it('assigns to a member, to me or to nobody, and tells only a new assignee', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const lee = await t.member('Lee Park');
    const due = '2026-11-02T09:30:00.000Z';
    const first = await make(dana.as(), 'One', { dueAt: due, description: 'Bring the plan.' });
    const second = await make(dana.as(), 'Two', { assignee: lee.membershipId });
    const third = await make(dana.as(), 'Three', { assignee: 'me' });

    const result = await bulk(dana.as(), {
      action: 'assign',
      ids: [first.id, second.id, third.id],
      assignee: lee.membershipId,
    });
    expect(result.results).toEqual([done(first.id), unchanged(second.id), done(third.id)]);
    for (const each of [first, second, third])
      expect((await one(dana.as(), each.id)).assignee).toEqual({
        membershipId: lee.membershipId,
        name: 'Lee Park',
        you: false,
      });
    // Nothing else of the task moves with its assignee.
    expect(await one(dana.as(), first.id)).toMatchObject({
      title: 'One',
      description: 'Bring the plan.',
      dueAt: due,
      completedAt: null,
    });
    expect((await events(t)).map((each) => [each.type, each.subject, each.payload])).toEqual([
      ['task.updated', uuidOf(first.id), { recordId: null, assignedUserId: lee.userId }],
      ['task.updated', uuidOf(third.id), { recordId: null, assignedUserId: lee.userId }],
    ]);

    const mine = await bulk(dana.as(), { action: 'assign', ids: [first.id], assignee: 'me' });
    expect(mine.results).toEqual([done(first.id)]);
    expect((await one(dana.as(), first.id)).assignee).toMatchObject({
      name: 'Dana Brooks',
      you: true,
    });

    const nobody = await bulk(dana.as(), {
      action: 'assign',
      ids: [first.id, second.id],
      assignee: null,
    });
    expect(outcomes(nobody)).toEqual(['done', 'done']);
    expect((await one(dana.as(), first.id)).assignee).toBeNull();
    expect((await one(dana.as(), second.id)).assignee).toBeNull();
    // Taking a task from someone names nobody: there is no one new to tell.
    expect((await events(t)).slice(3).map((each) => each.payload)).toEqual([
      { recordId: null },
      { recordId: null },
    ]);
    expect(
      outcomes(await bulk(dana.as(), { action: 'assign', ids: [first.id], assignee: null })),
    ).toEqual(['unchanged']);
  });

  it('refuses the whole request for an assignee who is not on the team', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const gone = await t.member('Sam Reyes');
    await t.remove(gone);
    const first = await make(dana.as(), 'One');
    const refused = await failure(
      bulk(dana.as(), { action: 'assign', ids: [first.id], assignee: gone.membershipId }),
    );
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).issues).toMatchObject([
      { path: '/assignee', code: 'unavailable_assignee' },
    ]);
    expect((await one(dana.as(), first.id)).assignee).toBeNull();
    expect(await events(t)).toEqual([]);
    expect(await audits(t, 'task.bulk')).toMatchObject([{ outcome: 'invalid', events: 0 }]);
  });

  it('sets or clears the due date and keeps each assignee', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const lee = await t.member('Lee Park');
    const due = '2026-11-02T09:30:00.000Z';
    const first = await make(dana.as(), 'One', { assignee: lee.membershipId });
    const second = await make(dana.as(), 'Two', { dueAt: due });
    const third = await make(dana.as(), 'Three');

    const result = await bulk(dana.as(), {
      action: 'set_due',
      ids: [first.id, second.id, third.id],
      // The same moment as `due`, written with another offset.
      dueAt: '2026-11-02T12:30:00+03:00',
    });
    expect(result.results).toEqual([done(first.id), unchanged(second.id), done(third.id)]);
    for (const each of [first, second, third])
      expect((await one(dana.as(), each.id)).dueAt).toBe(due);
    expect((await one(dana.as(), first.id)).assignee).toMatchObject({ name: 'Lee Park' });
    expect((await one(dana.as(), third.id)).assignee).toBeNull();
    // A new date tells the assignee nothing new: no assignedUserId, as in the task's form.
    expect((await events(t)).map((each) => [each.type, each.subject, each.payload])).toEqual([
      ['task.updated', uuidOf(first.id), { recordId: null }],
      ['task.updated', uuidOf(third.id), { recordId: null }],
    ]);

    const cleared = await bulk(dana.as(), {
      action: 'set_due',
      ids: [first.id, second.id],
      dueAt: null,
    });
    expect(outcomes(cleared)).toEqual(['done', 'done']);
    expect((await one(dana.as(), first.id)).dueAt).toBeNull();
    expect(
      outcomes(await bulk(dana.as(), { action: 'set_due', ids: [first.id], dueAt: null })),
    ).toEqual(['unchanged']);
  });

  it('deletes for good, as deleting one task does', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const recordId = await contactOf(t, 'Maya');
    const first = await make(dana.as(), 'One', { recordId });
    const second = await make(dana.as(), 'Two');
    const kept = await make(dana.as(), 'Kept');

    const result = await bulk(dana.as(), { action: 'delete', ids: [first.id, second.id] });
    expect(result).toMatchObject({ done: 2, unchanged: 0, skipped: 0 });
    expect((await all(dana.as())).map((each) => each.id)).toEqual([kept.id]);
    expect(
      (await events(t)).map((each) => [each.type, each.subject, each.payload, each.records]),
    ).toEqual([
      ['task.deleted', uuidOf(first.id), { recordId }, [parsePublicId('contact', recordId)]],
      ['task.deleted', uuidOf(second.id), { recordId: null }, []],
    ]);
    // Asked again, they are no longer there to delete.
    const again = await bulk(dana.as(), { action: 'delete', ids: [first.id, second.id] });
    expect(again.results.map((each) => [each.outcome, each.reason?.code])).toEqual([
      ['skipped', 'not_found'],
      ['skipped', 'not_found'],
    ]);
  });

  it('skips what the single command would refuse, with its reason, and changes the rest', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const leaving = await t.member('Sam Reyes');
    const elsewhere = await team(database);
    const stranger = await elsewhere.member('Other Business');
    const theirs = await make(stranger.as(), 'Theirs');
    const trashedContact = await contactOf(t, 'Maya');
    const ofTrashed = await make(dana.as(), 'Of a trashed contact', { recordId: trashedContact });
    const ofLeaver = await make(dana.as(), 'Of someone who left', {
      assignee: leaving.membershipId,
    });
    const plain = await make(dana.as(), 'Plain');
    await database.as('crm_owner', (sql) =>
      sql.query('update crm.contacts set deleted_at = now() where id = $1', [
        parsePublicId('contact', trashedContact),
      ]),
    );
    await t.remove(leaving);
    const unknown = toPublicId('task', '01890a5d-ac96-774b-bcce-000000000001');

    const result = await bulk(dana.as(), {
      action: 'set_due',
      ids: [unknown, plain.id, theirs.id, ofTrashed.id, ofLeaver.id],
      dueAt: '2026-11-02T09:30:00Z',
    });
    expect(result.results.map((each) => [each.id, each.outcome, each.reason?.code])).toEqual([
      [unknown, 'skipped', 'not_found'],
      [plain.id, 'done', undefined],
      [theirs.id, 'skipped', 'not_found'],
      [ofTrashed.id, 'skipped', 'record_in_trash'],
      [ofLeaver.id, 'skipped', 'assignee_unavailable'],
    ]);
    expect(result).toMatchObject({ done: 1, unchanged: 0, skipped: 4 });
    for (const each of result.results)
      expect(each.reason === null || each.reason.message.length > 0).toBe(true);
    expect((await one(dana.as(), ofLeaver.id)).dueAt).toBeNull();
    expect((await one(stranger.as(), theirs.id)).dueAt).toBeNull();
    expect(await events(elsewhere)).toEqual([]);
    expect((await events(t)).map((each) => each.subject)).toEqual([uuidOf(plain.id)]);

    // The other actions leave a task of a trashed record alone too; someone who left the
    // team is no bar to completing their task, as it is none for the single command.
    for (const action of ['complete', 'delete'] as const) {
      const refused = await bulk(dana.as(), { action, ids: [ofTrashed.id] });
      expect(refused.results[0]?.reason?.code).toBe('record_in_trash');
    }
    expect(outcomes(await bulk(dana.as(), { action: 'complete', ids: [ofLeaver.id] }))).toEqual([
      'done',
    ]);
  });

  it('skips a task that changes or goes while the request runs, and undoes everything on a fault', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const lee = await t.member('Lee Park');
    const edited = await make(dana.as(), 'Edited meanwhile', { assignee: lee.membershipId });
    const deleted = await make(dana.as(), 'Deleted meanwhile', { assignee: lee.membershipId });
    const plain = await make(dana.as(), 'Plain');
    const ids = [edited.id, deleted.id, plain.id];
    const dueAt = '2026-11-02T09:30:00Z';
    // Each assigned task asks for its assignee's membership after its revision is read and
    // before its command runs: the moment someone else gets in.
    let asked = 0;
    hook.beforeMemberships = async () => {
      asked += 1;
      if (asked > 2) return;
      await database.as('crm_owner', (sql) =>
        sql.query(
          asked === 1
            ? "update crm.tasks set title = 'Edited by someone else' where id = $1"
            : 'delete from crm.tasks where id = $1',
          [uuidOf(asked === 1 ? edited.id : deleted.id)],
        ),
      );
    };
    try {
      // Tasks are taken in the order of their ids, which is the order they were made in.
      const result = await bulk(dana.as(), { action: 'set_due', ids, dueAt });
      expect(result.results.map((each) => [each.outcome, each.reason?.code])).toEqual([
        ['skipped', 'changed'],
        ['skipped', 'not_found'],
        ['done', undefined],
      ]);
      expect(await one(dana.as(), edited.id)).toMatchObject({
        title: 'Edited by someone else',
        dueAt: null,
      });
      expect((await one(dana.as(), plain.id)).dueAt).toBe('2026-11-02T09:30:00.000Z');

      // A fault is no refusal: the request fails as a whole and nothing of it is kept.
      const before = (await events(t)).length;
      hook.beforeMemberships = () => Promise.reject(new Error('The lookup broke.'));
      const fault = await failure(
        bulk(dana.as(), { action: 'set_due', ids: [plain.id, edited.id], dueAt: null }),
      );
      expect(fault).toEqual(new Error('The lookup broke.'));
      hook.beforeMemberships = () => Promise.resolve();
      expect((await one(dana.as(), plain.id)).dueAt).toBe('2026-11-02T09:30:00.000Z');
      expect(await events(t)).toHaveLength(before);
      expect((await audits(t, 'task.bulk')).map((each) => each.outcome)).toEqual(['ok', 'failed']);
    } finally {
      hook.beforeMemberships = () => Promise.resolve();
    }
  });

  it('needs tasks.manage and a business, and takes only what the contract allows', async () => {
    const t = await team(database);
    const dana = await t.member('Dana Brooks');
    const first = await make(dana.as(), 'One');
    const body = { action: 'complete', ids: [first.id] };
    const viewer = await failure(bulk(dana.as(new Set(['contacts.manage'])), body));
    expect(viewer).toBeInstanceOf(ForbiddenError);
    expect((viewer as ForbiddenError).permission).toBe('tasks.manage');
    expect((await one(dana.as(), first.id)).completedAt).toBeNull();
    for (const wrong of [
      { action: 'complete', ids: [] },
      { action: 'complete', ids: [first.id, first.id] },
      { action: 'archive', ids: [first.id] },
      { action: 'assign', ids: [first.id] },
    ])
      expect(await failure(bulk(dana.as(), wrong)), JSON.stringify(wrong)).toBeInstanceOf(
        ValidationError,
      );
    expect(outcomes(await bulk(dana.as(new Set(['tasks.manage'])), body))).toEqual(['done']);
  });
});
