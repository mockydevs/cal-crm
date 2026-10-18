// One action on many conversations (mark read, mark unread, star, unstar), the star itself
// and the Starred tab. Real Postgres, as crm_app under row-level security.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import {
  bulkConversationsResult,
  conversation,
  conversationList,
  CONVERSATION_BULK_LIMIT,
  type BulkConversationsResult,
  type Conversation,
} from '@repo/contracts';
import { ForbiddenError, toPublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  inboxBusiness,
  receiveWith,
  startInbox,
  type InboxBusiness,
  type InboxWorld,
} from '../test/inbox.js';
import { createInboxRoutes } from './inbox-routes.js';

let world: InboxWorld;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

const bulk = async (me: Invocation, body: unknown): Promise<BulkConversationsResult> =>
  bulkConversationsResult.parse(await world.call('bulkUpdateConversations', me, { body }));
const read = async (me: Invocation, id: string): Promise<Conversation> =>
  conversation.parse(await world.call('getConversation', me, { params: { id } }));
const listed = async (me: Invocation, query: Record<string, string> = {}) =>
  conversationList.parse(await world.call('listConversations', me, { query }));
const outcomes = (result: BulkConversationsResult) =>
  result.results.map((each) => [each.outcome, each.reason?.code ?? null]);

/** A business with a mailbox and this many contacts who each wrote once. */
async function inbox(count: number) {
  const b = await inboxBusiness(world);
  const box = await b.mailbox();
  const threads = [];
  for (let index = 0; index < count; index += 1) {
    const contact = await b.contact({ firstName: `Contact ${String(index)}` });
    const stored = await b.receive(contact, box.id, `Hello from ${String(index)}`);
    threads.push({
      contact,
      id: toPublicId('conversation', stored.conversationId),
      conversationId: stored.conversationId,
      first: toPublicId('message', stored.messageId),
    });
  }
  return { b, box, threads, me: b.as() };
}
const eventTypes = async (b: InboxBusiness) => (await b.events()).map((event) => event.type);

describe('a star', () => {
  it('is set and removed for the whole team, and lists under the Starred tab in the inbox order', async () => {
    const { b, me, threads, box } = await inbox(3);
    const [first, second, third] = threads.map((thread) => thread.id);
    expect((await listed(me)).items.map((item) => item.starred)).toEqual([false, false, false]);

    const starred = await bulk(me, { action: 'star', ids: [first, third] });
    expect(starred).toMatchObject({ action: 'star', done: 2, unchanged: 0, skipped: 0 });
    expect(outcomes(starred)).toEqual([
      ['done', null],
      ['done', null],
    ]);
    // Newest activity first, as the inbox itself is ordered.
    expect((await listed(me, { starred: 'only' })).items.map((item) => item.id)).toEqual([
      third,
      first,
    ]);
    // Someone else on the team sees the same stars: there is one star, not one each.
    const colleague = await world.member(b.business.id, 'Jordan Lee');
    const theirs: Invocation = {
      context: { ...b.context, userId: colleague.userId, actorId: colleague.userId },
      permissions: 'all',
    };
    expect((await listed(theirs, { starred: 'only' })).items.map((item) => item.id)).toEqual([
      third,
      first,
    ]);
    expect((await read(theirs, second ?? '')).starred).toBe(false);

    // A new message moves a starred conversation up, and leaves its star alone.
    await b.receive(threads[0]?.contact ?? { id: '', email: '' }, box.id, 'One more thing');
    expect((await listed(me, { starred: 'only' })).items.map((item) => item.id)).toEqual([
      first,
      third,
    ]);

    await bulk(theirs, { action: 'unstar', ids: [first] });
    expect((await listed(me, { starred: 'only' })).items.map((item) => item.id)).toEqual([third]);
    expect((await read(me, first ?? '')).starred).toBe(false);
  });

  it('combines with the other filters, and pages', async () => {
    const { me, threads } = await inbox(3);
    const ids = threads.map((thread) => thread.id);
    await bulk(me, { action: 'star', ids });
    await bulk(me, {
      action: 'mark_read',
      items: [{ id: ids[0], through: threads[0]?.first }],
    });
    expect(
      (await listed(me, { starred: 'only', unread: 'unread' })).items.map((item) => item.id),
    ).toEqual([ids[2], ids[1]]);
    expect((await listed(me, { starred: 'only', status: 'closed' })).items).toEqual([]);
    await expect(listed(me, { starred: 'yes' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('never changes the revision an assignment or a close is made from', async () => {
    const { me, threads } = await inbox(1);
    const id = threads[0]?.id ?? '';
    const before = await read(me, id);
    await bulk(me, { action: 'star', ids: [id] });
    const after = await read(me, id);
    expect(after.revision).toBe(before.revision);
    // So a close decided before the star still goes through.
    const closed = conversation.parse(
      await world.call('setConversationStatus', me, {
        params: { id },
        body: { status: 'closed', revision: before.revision },
      }),
    );
    expect(closed).toMatchObject({ status: 'closed', starred: true });
  });
});

describe('marking many read and unread', () => {
  it('reads each up to the message the person saw, and no further', async () => {
    const { b, me, threads, box } = await inbox(2);
    const [seen, later] = threads;
    if (seen === undefined || later === undefined) throw new Error('Missing threads.');
    // The list is what the person selects from: it gives each row's newest message.
    const rows = (await listed(me)).items;
    expect(rows.map((row) => row.lastMessage?.id)).toEqual([later.first, seen.first]);
    // A second message arrives in one of them after the list was read.
    await b.receive(later.contact, box.id, 'And another');

    const result = await bulk(me, {
      action: 'mark_read',
      items: rows.map((row) => ({ id: row.id, through: row.lastMessage?.id })),
    });
    expect(result).toMatchObject({ done: 2, unchanged: 0, skipped: 0 });
    expect((await read(me, seen.id)).unreadCount).toBe(0);
    expect((await read(me, later.id)).unreadCount).toBe(1);
  });

  it('marks unread again from the newest message of the contact, and only what has one', async () => {
    const { b, me, threads } = await inbox(2);
    const [answered, quiet] = threads;
    if (answered === undefined || quiet === undefined) throw new Error('Missing threads.');
    // A conversation the contact never wrote in: the team's note is all it holds.
    const silent = await b.contact({ firstName: 'Silent' });
    const [empty] = await b.query<{ id: string }>(
      `insert into messaging.conversations (business_id, contact_id)
       values (app.business_id(), $1) returning id`,
      [silent.id],
    );
    const emptyId = toPublicId('conversation', empty?.id ?? '');
    await bulk(me, {
      action: 'mark_read',
      items: [answered, quiet].map((thread) => ({ id: thread.id, through: thread.first })),
    });
    expect((await read(me, answered.id)).unreadCount).toBe(0);

    const result = await bulk(me, {
      action: 'mark_unread',
      ids: [answered.id, emptyId, quiet.id],
    });
    expect(outcomes(result)).toEqual([
      ['done', null],
      ['skipped', 'nothing_to_mark_unread'],
      ['done', null],
    ]);
    expect(result).toMatchObject({ done: 2, unchanged: 0, skipped: 1 });
    for (const thread of [answered, quiet])
      expect(await read(me, thread.id)).toMatchObject({ unreadCount: 1, needsReply: true });
    expect(await world.call('getInboxSummary', me)).toMatchObject({
      unreadConversations: 2,
      unreadMessages: 2,
    });
  });

  it('refuses a message of another conversation as the place to read up to, and reads the rest', async () => {
    const { me, threads } = await inbox(2);
    const [one, two] = threads;
    if (one === undefined || two === undefined) throw new Error('Missing threads.');
    const result = await bulk(me, {
      action: 'mark_read',
      items: [
        { id: one.id, through: two.first },
        { id: two.id, through: two.first },
      ],
    });
    expect(outcomes(result)).toEqual([
      ['skipped', 'unknown_message'],
      ['done', null],
    ]);
    expect((await read(me, one.id)).unreadCount).toBe(1);
    expect((await read(me, two.id)).unreadCount).toBe(0);
  });
});

describe('a request sent again', () => {
  it.each(['star', 'unstar', 'mark_unread', 'mark_read'] as const)(
    'changes nothing the second time, and writes no second event: %s',
    async (action) => {
      const { b, me, threads } = await inbox(2);
      const ids = threads.map((thread) => thread.id);
      const items = threads.map((thread) => ({ id: thread.id, through: thread.first }));
      // Put the conversations where the action has something to do.
      if (action === 'unstar') await bulk(me, { action: 'star', ids });
      if (action === 'mark_unread') await bulk(me, { action: 'mark_read', items });
      const request = action === 'mark_read' ? { action, items } : { action, ids };

      const first = await bulk(me, request);
      expect(first).toMatchObject({ done: 2, unchanged: 0, skipped: 0 });
      const state = await listed(me, { status: 'all' });
      const events = await eventTypes(b);

      const again = await bulk(me, request);
      expect(again).toMatchObject({ done: 0, unchanged: 2, skipped: 0 });
      expect(outcomes(again)).toEqual([
        ['unchanged', null],
        ['unchanged', null],
      ]);
      expect(await listed(me, { status: 'all' })).toEqual(state);
      expect(await eventTypes(b)).toEqual(events);
    },
  );

  it('writes one event for each conversation it changed, and one audit row without any text', async () => {
    const { b, me, threads } = await inbox(3);
    const ids = threads.map((thread) => thread.id);
    await bulk(me, { action: 'star', ids: [ids[0]] });
    await bulk(me, { action: 'star', ids });
    await bulk(me, {
      action: 'mark_read',
      items: threads.slice(0, 2).map((thread) => ({ id: thread.id, through: thread.first })),
    });
    await bulk(me, { action: 'mark_unread', ids: [ids[0]] });
    await bulk(me, { action: 'unstar', ids: [ids[2]] });
    expect(await eventTypes(b)).toEqual([
      'conversation.starred',
      'conversation.starred',
      'conversation.starred',
      'conversation.read',
      'conversation.read',
      'conversation.marked_unread',
      'conversation.unstarred',
    ]);
    const events = await b.events();
    expect(events.every((event) => event.subject_kind === 'conversation')).toBe(true);
    expect((await b.audit()).filter((row) => row.command === 'conversation.bulk')).toEqual([
      { command: 'conversation.bulk', outcome: 'ok', input: { action: 'star', ids: [ids[0]] } },
      { command: 'conversation.bulk', outcome: 'ok', input: { action: 'star', ids } },
      {
        command: 'conversation.bulk',
        outcome: 'ok',
        input: { action: 'mark_read', ids: ids.slice(0, 2) },
      },
      {
        command: 'conversation.bulk',
        outcome: 'ok',
        input: { action: 'mark_unread', ids: [ids[0]] },
      },
      { command: 'conversation.bulk', outcome: 'ok', input: { action: 'unstar', ids: [ids[2]] } },
    ]);
  });
});

describe('what a request may name', () => {
  it('skips a conversation of another business, or one that does not exist, and tells nothing of it', async () => {
    const mine = await inbox(1);
    const theirs = await inbox(1);
    const own = mine.threads[0]?.id ?? '';
    const foreign = theirs.threads[0];
    if (foreign === undefined) throw new Error('Missing thread.');
    const nowhere = toPublicId('conversation', randomUUID().replace(/^.{15}/, '01890a5d-ac96-7'));

    const result = await bulk(mine.me, { action: 'star', ids: [foreign.id, own, nowhere] });
    expect(outcomes(result)).toEqual([
      ['skipped', 'not_found'],
      ['done', null],
      ['skipped', 'not_found'],
    ]);
    expect(result).toMatchObject({ done: 1, unchanged: 0, skipped: 2 });
    // The same words for both: nothing says the other business's conversation exists.
    expect(result.results[0]?.reason).toEqual(result.results[2]?.reason);
    expect((await read(theirs.me, foreign.id)).starred).toBe(false);
    expect((await read(mine.me, own)).starred).toBe(true);

    // Their message as the place to read up to is no message of mine.
    const marked = await bulk(mine.me, {
      action: 'mark_read',
      items: [
        { id: own, through: foreign.first },
        { id: foreign.id, through: foreign.first },
      ],
    });
    expect(outcomes(marked)).toEqual([
      ['skipped', 'unknown_message'],
      ['skipped', 'not_found'],
    ]);
    expect((await read(theirs.me, foreign.id)).unreadCount).toBe(1);
  });

  it(`takes 1 to ${String(CONVERSATION_BULK_LIMIT)} conversations, each once`, async () => {
    const { me, threads } = await inbox(1);
    const id = threads[0]?.id ?? '';
    const many = (count: number) =>
      Array.from({ length: count }, () =>
        toPublicId('conversation', randomUUID().replace(/^.{15}/, '01890a5d-ac96-7')),
      );
    for (const body of [
      { action: 'star', ids: [] },
      { action: 'star', ids: many(CONVERSATION_BULK_LIMIT + 1) },
      { action: 'star', ids: [id, id] },
      { action: 'mark_read', items: [] },
      { action: 'mark_read', items: [{ id }] },
      { action: 'mark_read', ids: [id] },
      {
        action: 'mark_read',
        items: [
          { id, through: threads[0]?.first },
          { id, through: threads[0]?.first },
        ],
      },
      { action: 'close', ids: [id] },
      { action: 'assign', ids: [id], assignee: 'me' },
      { action: 'delete', ids: [id] },
      { ids: [id] },
    ])
      await expect(bulk(me, body), JSON.stringify(body).slice(0, 80)).rejects.toBeInstanceOf(
        ValidationError,
      );
    expect((await read(me, id)).starred).toBe(false);

    // The most a request may name, all in one step: the one that exists, and 99 that don't.
    const full = await bulk(me, {
      action: 'star',
      ids: [...many(CONVERSATION_BULK_LIMIT - 1), id],
    });
    expect(full).toMatchObject({ done: 1, skipped: CONVERSATION_BULK_LIMIT - 1 });
    expect(full.results.at(-1)).toMatchObject({ id, outcome: 'done' });
  });

  it('is for whoever works conversations: a viewer is refused, and nothing is changed', async () => {
    const { b, threads } = await inbox(1);
    const id = threads[0]?.id ?? '';
    const refused = bulk(b.as(new Set()), { action: 'star', ids: [id] });
    await expect(refused).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refused).rejects.toMatchObject({ permission: 'conversations.manage' });
    expect((await read(b.as(), id)).starred).toBe(false);
    // Someone who replies but does not manage works the inbox too.
    const replier = b.as(new Set(['conversations.reply']));
    expect(await bulk(replier, { action: 'star', ids: [id] })).toMatchObject({ done: 1 });
    expect((await b.audit()).map((row) => [row.command, row.outcome])).toEqual([
      ['conversation.bulk', 'denied'],
      ['conversation.bulk', 'ok'],
    ]);
  });
});

describe('at the same moment as something else', () => {
  it('keeps a message that arrives while many are marked read unread', async () => {
    const { b, me, threads, box } = await inbox(2);
    const [busy, calm] = threads;
    if (busy === undefined || calm === undefined) throw new Error('Missing threads.');
    let marking: Promise<BulkConversationsResult> | undefined;

    // A second message is stored in one conversation and not yet committed ...
    await world.database.withTenant(
      { ...b.context, actorKind: 'system', correlationId: randomUUID() },
      async (sql) => {
        await receiveWith(sql, busy.contact, box.id, 'Arriving right now');
        const [owner] = await sql.query<{ pid: number }>('select pg_backend_pid() as pid');
        // ... when the person marks both as read up to what they saw: the request waits
        // for that conversation, holding nothing the arriving message needs.
        marking = bulk(me, {
          action: 'mark_read',
          items: [busy, calm].map((thread) => ({ id: thread.id, through: thread.first })),
        });
        await world.blockedBy(owner?.pid ?? 0, 1);
      },
    );
    if (marking === undefined) throw new Error('The request never started.');
    expect(await marking).toMatchObject({ done: 2, unchanged: 0, skipped: 0 });

    // Only the message the person saw is read: the one that arrived is still unread.
    expect(await read(me, busy.id)).toMatchObject({ unreadCount: 1, needsReply: true });
    expect((await read(me, calm.id)).unreadCount).toBe(0);
    expect(await world.call('getInboxSummary', me)).toMatchObject({
      unreadConversations: 1,
      unreadMessages: 1,
    });
  });

  it('changes a conversation once when two people star it at the same moment', async () => {
    const { b, me, threads } = await inbox(1);
    const thread = threads[0];
    if (thread === undefined) throw new Error('Missing thread.');
    let both: Promise<BulkConversationsResult>[] = [];

    // Something else holds the conversation, so both requests arrive before either can go on.
    await world.database.withTenant(
      { ...b.context, actorKind: 'system', correlationId: randomUUID() },
      async (sql) => {
        await sql.query('select id from messaging.conversations where id = $1 for update', [
          thread.conversationId,
        ]);
        const [owner] = await sql.query<{ pid: number }>('select pg_backend_pid() as pid');
        both = [0, 1].map(() => bulk(me, { action: 'star', ids: [thread.id] }));
        // Both wait for the row: the second queues behind the first.
        await world.blockedBy(owner?.pid ?? 0, 2);
      },
    );
    const results = await Promise.all(both);

    // Each decided on the conversation as it was once it held it: one starred it, and the
    // other found it starred. Decided on an earlier read, both would have, with two events.
    expect(results.map((result) => result.results[0]?.outcome).sort()).toEqual([
      'done',
      'unchanged',
    ]);
    expect(await eventTypes(b)).toEqual(['conversation.starred']);
    expect((await read(me, thread.id)).starred).toBe(true);
  });

  it('keeps both a star and an assignment made at once, whichever is first', async () => {
    const { b, me, threads } = await inbox(1);
    const id = threads[0]?.id ?? '';
    const colleague = await world.member(b.business.id, 'Jordan Lee');
    const before = await read(me, id);

    // The assignment holds the conversation while it asks who the assignee is.
    const reached = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const gated = createInboxRoutes({
      ...world.options,
      assignees: {
        ...world.options.assignees,
        resolve: async (trx, context, selection) => {
          reached.resolve(undefined);
          await release.promise;
          return world.options.assignees.resolve(trx, context, selection);
        },
      },
    });
    const assigning = world.call(
      'assignConversation',
      me,
      { params: { id }, body: { assignee: colleague.membershipId, revision: before.revision } },
      gated,
    );
    void assigning.catch(reached.reject);
    let starring: Promise<BulkConversationsResult> | undefined;
    try {
      await reached.promise;
      // The star waits for the same row. Another role's waits are hidden from crm_app, so
      // the superuser watches for it.
      starring = bulk(me, { action: 'star', ids: [id] });
      await expect
        .poll(
          async () => {
            const [row] = await world.database.as('postgres', (sql) =>
              sql.query<{ waiting: number }>(
                `select count(*)::int as waiting from pg_stat_activity
                 where datname = current_database() and wait_event_type = 'Lock'`,
              ),
            );
            return row?.waiting ?? 0;
          },
          { timeout: 10_000, interval: 50 },
        )
        .toBe(1);
    } finally {
      release.resolve(undefined);
    }
    const assigned = conversation.parse(await assigning);
    expect(assigned.assignee).toMatchObject({ membershipId: colleague.membershipId });
    expect(await starring).toMatchObject({ done: 1 });

    // Neither overwrote the other.
    const after = await read(me, id);
    expect(after).toMatchObject({
      starred: true,
      assignee: { membershipId: colleague.membershipId },
    });
    // And an assignment decided before a star, made after it, still goes through: the star
    // is not a change the assignment's revision knows.
    await bulk(me, { action: 'unstar', ids: [id] });
    const unassigned = conversation.parse(
      await world.call('assignConversation', me, {
        params: { id },
        body: { assignee: null, revision: after.revision },
      }),
    );
    expect(unassigned).toMatchObject({ assignee: null, starred: false });
  });
});
