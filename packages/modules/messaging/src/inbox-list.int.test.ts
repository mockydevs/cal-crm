// The Inbox list: what "needs reply" and "unread" mean, held against the plain definitions
// in inbox-rules.ts; unread counts under concurrent arrivals; filters, order, stable pages,
// bounded previews and the sidebar's counts. Real Postgres.
import { randomUUID } from 'node:crypto';

import {
  conversation,
  conversationList,
  conversationThread,
  PREVIEW_MAX_LENGTH,
  threadMessage,
} from '@repo/contracts';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { inboxBusiness, receiveWith, startInbox, type InboxWorld } from '../test/inbox.js';
import { needsReply, unreadCount, type StoredMessage } from './inbox-rules.js';

let world: InboxWorld;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

const key = () => randomUUID().replaceAll('-', '');

it('agrees with the definitions of needs reply and unread after every step of a conversation', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact();
  const box = await b.mailbox();
  const first = await b.receive(maya, box.id, 'Hello');
  const params = { id: toPublicId('conversation', first.conversationId) };
  let readThrough = 0;

  const reply = async () =>
    threadMessage.parse(
      await world.call('sendConversationReply', me, {
        params,
        body: {
          channel: 'email',
          accountId: box.publicId,
          to: maya.emailIdentity,
          text: 'Hi',
          idempotencyKey: key(),
        },
      }),
    );
  const uuidOf = (id: string) => parsePublicId('message', id) ?? '';
  /** What the API says, beside what the definitions say of the stored messages. */
  const check = async (step: string, expected: { needsReply: boolean; unread: number }) => {
    const shown = conversation.parse(await world.call('getConversation', me, { params }));
    const stored = await b.query<StoredMessage>(
      'select seq::int as seq, direction, status from messaging.messages where conversation_id = $1',
      [first.conversationId],
    );
    expect(
      { needsReply: shown.needsReply, unread: shown.unreadCount },
      `${step}: the API against the definitions`,
    ).toEqual({ needsReply: needsReply(stored), unread: unreadCount(stored, readThrough) });
    expect({ needsReply: shown.needsReply, unread: shown.unreadCount }, step).toEqual(expected);
  };
  const storedNow = () =>
    b.query<StoredMessage & { id: string }>(
      'select id, seq::int as seq, direction, status from messaging.messages where conversation_id = $1',
      [first.conversationId],
    );
  const readTo = async (messageId: string) => {
    const position = (await storedNow()).find((each) => each.id === messageId)?.seq ?? 0;
    await world.call('markConversationRead', me, {
      params,
      body: { through: toPublicId('message', messageId) },
    });
    readThrough = Math.max(readThrough, position);
  };

  await check('the contact wrote', { needsReply: true, unread: 1 });

  // A note after an inbound message does not clear needs reply, and is never unread.
  await world.call('addConversationNote', me, {
    params,
    body: { text: 'Ask about video.', idempotencyKey: key() },
  });
  await check('a note', { needsReply: true, unread: 1 });

  // A reply on its way clears it.
  const queued = await reply();
  await check('a queued reply', { needsReply: false, unread: 1 });
  // An outbound message that failed does not count as a reply.
  expect(await b.dispatch(uuidOf(queued.id), 'rejected')).toBe(1);
  await check('the reply was rejected', { needsReply: true, unread: 1 });

  // Delivery we can't confirm is not a reply either.
  const uncertain = await reply();
  await check('a second reply queued', { needsReply: false, unread: 1 });
  await b.dispatch(uuidOf(uncertain.id), 'throws');
  await check('its delivery is unknown', { needsReply: true, unread: 1 });

  // A reply that was sent clears it for good, and a later failure doesn't bring it back.
  const sent = await reply();
  await b.dispatch(uuidOf(sent.id), 'accepted');
  await check('a reply was sent', { needsReply: false, unread: 1 });
  const late = await reply();
  await b.dispatch(uuidOf(late.id), 'rejected');
  await check('a later reply failed', { needsReply: false, unread: 1 });

  // A sent reply that bounces was never received.
  await b.query(
    "update messaging.messages set status = 'bounced', error_code = 'hard_bounce' where id = $1",
    [uuidOf(sent.id)],
  );
  await check('the sent reply bounced', { needsReply: true, unread: 1 });

  // Reading is separate from answering, and only covers what was on screen.
  await readTo(first.messageId);
  await check('read through the first message', { needsReply: true, unread: 0 });
  const second = await b.receive(maya, box.id, 'Are you there?');
  const third = await b.receive(maya, box.id, 'Hello?');
  await check('two more arrived', { needsReply: true, unread: 2 });
  await readTo(second.messageId);
  await check('read through the second', { needsReply: true, unread: 1 });
  // Reading never moves back.
  await readTo(first.messageId);
  await check('an older position changes nothing', { needsReply: true, unread: 1 });
  await readTo(third.messageId);
  await check('all read', { needsReply: true, unread: 0 });

  // Closed: nobody is waited on, though the messages still say the contact wrote last.
  const open = conversation.parse(await world.call('getConversation', me, { params }));
  const closed = conversation.parse(
    await world.call('setConversationStatus', me, {
      params,
      body: { status: 'closed', revision: open.revision },
    }),
  );
  expect(closed).toMatchObject({ status: 'closed', needsReply: false });
  expect(needsReply(await storedNow())).toBe(true);
  // A new message reopens it, as inbound.ts does.
  await b.receive(maya, box.id, 'One more thing');
  expect(await world.call('getConversation', me, { params })).toMatchObject({
    status: 'open',
    needsReply: true,
    unreadCount: 1,
  });
});

it('keeps a message that arrives while someone marks read unread', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact();
  const box = await b.mailbox();
  const seen = await b.receive(maya, box.id, 'First');
  const params = { id: toPublicId('conversation', seen.conversationId) };
  let marking: Promise<unknown> | undefined;
  let other: Promise<unknown> | undefined;

  // Two messages arrive: the first is stored but not yet committed ...
  await world.database.withTenant(
    { ...b.context, actorKind: 'system', correlationId: randomUUID() },
    async (sql) => {
      await receiveWith(sql, maya, box.id, 'Second, arriving now');
      const [owner] = await sql.query<{ pid: number }>('select pg_backend_pid() as pid');
      // ... when the person marks what they saw as read: it waits for the conversation ...
      marking = world.call('markConversationRead', me, {
        params,
        body: { through: toPublicId('message', seen.messageId) },
      });
      await world.blockedBy(owner?.pid ?? 0, 1);
      // ... and the second message waits behind the same row.
      other = b.receive(maya, box.id, 'Third, right behind');
      await world.blockedBy(owner?.pid ?? 0, 2);
    },
  );
  if (marking === undefined || other === undefined) throw new Error('The writers never started.');
  // Both settle before asserting, so a failure leaves no transaction behind.
  const settled = await Promise.allSettled([marking, other]);
  expect(settled.map((each) => each.status)).toEqual(['fulfilled', 'fulfilled']);

  // Whichever went first, only the message the person saw is read.
  expect(await world.call('getConversation', me, { params })).toMatchObject({
    unreadCount: 2,
    needsReply: true,
  });
  expect(await world.call('getInboxSummary', me)).toEqual({
    unreadConversations: 1,
    unreadMessages: 2,
    needsReply: 1,
  });
  const stored = await b.query<StoredMessage>(
    'select seq::int as seq, direction, status from messaging.messages where conversation_id = $1',
    [seen.conversationId],
  );
  expect(stored.map((each) => each.seq).sort()).toEqual([1, 2, 3]);
  expect(unreadCount(stored, 1)).toBe(2);
});

it('filters by status, assignment, needs reply, unread, channel and contact', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const box = await b.mailbox();
  const sms = await b.smsAccount();
  const colleague = await world.member(b.business.id, 'Sam Lee');
  const named = async (name: string) => {
    const contact = await b.contact({ firstName: name });
    const stored = await b.receive(contact, box.id, `From ${name}`);
    return { contact, params: { id: toPublicId('conversation', stored.conversationId) }, stored };
  };
  const waiting = await named('Waiting');
  const answered = await named('Answered');
  const mine = await named('Mine');
  const theirs = await named('Theirs');
  const snoozed = await named('Snoozed');
  const closed = await named('Closed');
  const texted = await named('Texted');
  const trashed = await named('Trashed');

  const revisionOf = async (params: { id: string }) =>
    conversation.parse(await world.call('getConversation', me, { params })).revision;
  await world.call('sendConversationReply', me, {
    params: answered.params,
    body: {
      channel: 'email',
      accountId: box.publicId,
      to: answered.contact.emailIdentity,
      text: 'Answered',
      idempotencyKey: key(),
    },
  });
  await world.call('markConversationRead', me, {
    params: answered.params,
    body: { through: toPublicId('message', answered.stored.messageId) },
  });
  await world.call('assignConversation', me, {
    params: mine.params,
    body: { assignee: 'me', revision: await revisionOf(mine.params) },
  });
  await world.call('assignConversation', me, {
    params: theirs.params,
    body: { assignee: colleague.membershipId, revision: await revisionOf(theirs.params) },
  });
  await world.call('setConversationStatus', me, {
    params: snoozed.params,
    body: {
      status: 'snoozed',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      revision: await revisionOf(snoozed.params),
    },
  });
  await world.call('setConversationStatus', me, {
    params: closed.params,
    body: { status: 'closed', revision: await revisionOf(closed.params) },
  });
  // A text message in one conversation, stored as the SMS intake will store it.
  await b.query(
    `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
       direction, status, body_text, author_kind, author_id)
     values (app.business_id(), $1, 'sms', $2, 'inbound', 'received', 'By text', 'contact', $3)`,
    [texted.stored.conversationId, sms.id, texted.contact.id],
  );
  await b.query('update crm.contacts set deleted_at = now() where id = $1', [trashed.contact.id]);

  const names = async (query: Record<string, string>) =>
    conversationList
      .parse(await world.call('listConversations', me, { query }))
      .items.map((item) => item.contact.name)
      .sort();
  const everyone = ['Answered', 'Mine', 'Texted', 'Theirs', 'Waiting'];
  expect(await names({})).toEqual(everyone);
  expect(await names({ status: 'snoozed' })).toEqual(['Snoozed']);
  expect(await names({ status: 'closed' })).toEqual(['Closed']);
  expect(await names({ status: 'all' })).toEqual([...everyone, 'Closed', 'Snoozed'].sort());
  expect(await names({ assignee: 'me' })).toEqual(['Mine']);
  expect(await names({ assignee: colleague.membershipId })).toEqual(['Theirs']);
  expect(await names({ assignee: 'unassigned' })).toEqual(['Answered', 'Texted', 'Waiting']);
  expect(await names({ reply: 'needed' })).toEqual(['Mine', 'Texted', 'Theirs', 'Waiting']);
  // Only an open conversation waits for a reply.
  expect(await names({ reply: 'needed', status: 'all' })).toEqual([
    'Mine',
    'Texted',
    'Theirs',
    'Waiting',
  ]);
  expect(await names({ reply: 'needed', status: 'closed' })).toEqual([]);
  expect(await names({ unread: 'unread' })).toEqual(['Mine', 'Texted', 'Theirs', 'Waiting']);
  expect(await names({ channel: 'sms' })).toEqual(['Texted']);
  expect(await names({ channel: 'webchat' })).toEqual([]);
  expect(await names({ reply: 'needed', assignee: 'me', unread: 'unread' })).toEqual(['Mine']);
  expect(await names({ contactId: waiting.contact.publicId })).toEqual(['Waiting']);
  // A contact in the trash leaves the inbox, and is still found from the contact itself.
  expect(await names({ contactId: trashed.contact.publicId, status: 'all' })).toEqual(['Trashed']);
  expect(
    await world.call('listConversations', me, { query: { contactId: trashed.contact.publicId } }),
  ).toMatchObject({ items: [{ contact: { trashed: true } }] });
  // Someone who isn't a person, such as an API key, has nothing assigned to "me".
  expect(
    await world.call(
      'listConversations',
      { context: { ...b.context, actorKind: 'api_key' }, permissions: 'all' },
      { query: { assignee: 'me' } },
    ),
  ).toMatchObject({ items: [] });

  // The counts cover open conversations of contacts that aren't in the trash:
  // Waiting, Mine, Theirs (1 each) and Texted (2).
  expect(await world.call('getInboxSummary', me)).toEqual({
    unreadConversations: 4,
    unreadMessages: 5,
    needsReply: 4,
  });
});

it('ends a snooze by itself when its time comes', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact({ firstName: 'Maya' });
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'Hello');
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const open = conversation.parse(await world.call('getConversation', me, { params }));
  await world.call('setConversationStatus', me, {
    params,
    body: {
      status: 'snoozed',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      revision: open.revision,
    },
  });
  expect(await world.call('getInboxSummary', me)).toMatchObject({ needsReply: 0 });
  // The hour passes.
  await b.query(
    "update messaging.conversations set snoozed_until = now() - interval '1 second' where id = $1",
    [stored.conversationId],
  );
  expect(await world.call('getConversation', me, { params })).toMatchObject({
    status: 'open',
    snoozedUntil: null,
    needsReply: true,
  });
  expect(await world.call('listConversations', me)).toMatchObject({ items: [{ id: params.id }] });
  expect(await world.call('listConversations', me, { query: { status: 'snoozed' } })).toMatchObject(
    { items: [] },
  );
  expect(await world.call('getInboxSummary', me)).toMatchObject({ needsReply: 1 });
});

it('orders by latest activity and pages without repeating or losing a conversation', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const box = await b.mailbox();
  const start = Date.now() - 3_600_000;
  const stored: { name: string; id: string; contact: { id: string; email: string } }[] = [];
  // 53 conversations, one a second, so the newest is the last stored.
  for (let n = 1; n <= 53; n += 1) {
    const name = `Contact ${String(n).padStart(2, '0')}`;
    const contact = await b.contact({ firstName: name, consent: false });
    const message = await b.receive(contact, box.id, `Message ${String(n)}`, {
      at: new Date(start + n * 1000),
    });
    stored.push({ name, id: toPublicId('conversation', message.conversationId), contact });
  }
  const newestFirst = [...stored].reverse().map((each) => each.id);

  const first = conversationList.parse(await world.call('listConversations', me));
  expect(first.items.map((item) => item.id)).toEqual(newestFirst.slice(0, 50));
  expect(first.nextCursor).not.toBeNull();
  const times = first.items.map((item) => Date.parse(item.lastActivityAt));
  expect(times).toEqual([...times].sort((a, b) => b - a));

  // Before the next page is asked for, a conversation of the first page and one that
  // would have been on the second both get a new message, and move to the top.
  const moved = [stored[52], stored[1]];
  for (const each of moved) {
    if (each === undefined) throw new Error('Fixture conversation missing.');
    await b.receive(each.contact, box.id, 'Again');
  }
  const second = conversationList.parse(
    await world.call('listConversations', me, { query: { after: first.nextCursor ?? '' } }),
  );
  // The rest, without the one that moved up: nothing twice, nothing skipped.
  expect(second.items.map((item) => item.id)).toEqual([stored[2]?.id, stored[0]?.id]);
  expect(second.nextCursor).toBeNull();
  const seen = new Set([...first.items, ...second.items].map((item) => item.id));
  expect(seen.size).toBe(first.items.length + second.items.length);
  // A fresh first page shows the ones that moved, newest first.
  const fresh = conversationList.parse(await world.call('listConversations', me));
  expect(fresh.items.slice(0, 2).map((item) => item.id)).toEqual([stored[1]?.id, stored[52]?.id]);

  // The same position keeps its place under a filter.
  const filtered = conversationList.parse(
    await world.call('listConversations', me, {
      query: { after: first.nextCursor ?? '', reply: 'needed' },
    }),
  );
  expect(filtered.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
});

it('shows a bounded one-line preview of the last message, never of a note', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact();
  const box = await b.mailbox();
  const long = `Hi there,\r\n\r\n\t${'Is June 13 still open? '.repeat(400)}`;
  const stored = await b.receive(maya, box.id, long);
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const shown = conversation.parse(await world.call('getConversation', me, { params }));
  const preview = shown.lastMessage?.preview ?? '';
  expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX_LENGTH);
  expect(preview.length).toBeGreaterThan(PREVIEW_MAX_LENGTH - 10);
  expect(preview).toMatch(/^Hi there, Is June 13 still open\? /);
  expect(preview).not.toMatch(/[\r\n\t]/);
  expect(preview.endsWith('…')).toBe(true);
  // The whole message is still in the thread.
  const thread = conversationThread.parse(
    await world.call('listConversationMessages', me, { params }),
  );
  expect(thread.items[0]).toMatchObject({ kind: 'message', textTruncated: false });

  await world.call('addConversationNote', me, {
    params,
    body: { text: 'Internal: she is price sensitive.', idempotencyKey: key() },
  });
  const afterNote = conversation.parse(await world.call('getConversation', me, { params }));
  expect(afterNote.lastMessage).toEqual(shown.lastMessage);
  expect(JSON.stringify(await world.call('listConversations', me))).not.toContain(
    'price sensitive',
  );

  // An email with no text shows its subject; one with neither shows nothing.
  await b.receive(maya, box.id, '', { subject: 'Photos\r\nattached' });
  expect(await world.call('getConversation', me, { params })).toMatchObject({
    lastMessage: { preview: 'Photos attached', direction: 'inbound' },
  });
  await b.receive(maya, box.id, ' \n ');
  expect(await world.call('getConversation', me, { params })).toMatchObject({
    lastMessage: { preview: '' },
  });
});
