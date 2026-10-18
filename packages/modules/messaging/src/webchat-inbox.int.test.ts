// Web chat beside the Inbox. Migration 0046 numbers every message of a conversation in a
// trigger, derives the conversation's unread count and needs-reply flag from its messages,
// and makes a message's change of status reach its conversation. This file proves web
// chat's writers work under those triggers, and keep the lock order they rely on
// (webchat-locks.ts).
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { request, startWebchat, type WebchatWorld } from '../test/webchat.js';

let world: WebchatWorld;
beforeAll(async () => {
  world = await startWebchat(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

it("lets the Inbox's triggers number a chat's messages and derive unread and needs-reply", async () => {
  const f = await world.fixture();
  const token = await world.started(f);
  const summary = () =>
    f.rows<{ message_seq: string; unread_count: number; needs_reply: boolean; status: string }>(
      'select message_seq, unread_count, needs_reply, status from messaging.conversations',
    );
  await world.sent(f, token, 'first');
  expect(await summary()).toEqual([
    { message_seq: '1', unread_count: 1, needs_reply: true, status: 'open' },
  ]);
  const conversationId = await world.conversationOf(f);
  expect(await world.replied(f, conversationId, 'answer')).toMatchObject({ outcome: 'sent' });
  // The reply is the last message that counts, so nothing waits for an answer. Unread is
  // the Inbox's own (it moves when someone reads), so the visitor's message still counts.
  expect(await summary()).toEqual([
    { message_seq: '2', unread_count: 1, needs_reply: false, status: 'open' },
  ]);
  await world.sent(f, token, 'second');
  expect(await summary()).toEqual([
    { message_seq: '3', unread_count: 2, needs_reply: true, status: 'open' },
  ]);
  expect(
    await f.rows('select seq, direction, body_text from messaging.messages order by seq'),
  ).toEqual([
    { seq: '1', direction: 'inbound', body_text: 'first' },
    { seq: '2', direction: 'outbound', body_text: 'answer' },
    { seq: '3', direction: 'inbound', body_text: 'second' },
  ]);
});

it("keeps a session's own numbering apart from the conversation's", async () => {
  const f = await world.fixture();
  const token = await world.started(f, { email: 'maya@example.test' });
  await world.sent(f, token, 'chat one');
  const conversationId = await world.conversationOf(f);
  // Another message of the same conversation that is not this session's: an email, an SMS
  // or a reply to someone else. It takes a place in the conversation and none in the session.
  await f.rows(
    `insert into messaging.messages
       (business_id, conversation_id, channel, channel_account_id, direction, status, body_text, author_kind, idempotency_key)
     values (app.business_id(), $1, 'webchat', $2, 'outbound', 'sent', 'not for this session', 'system', $3)`,
    [conversationId, f.widgetId, randomUUID()],
  );
  await world.sent(f, token, 'chat two');
  const page = await world.read(f, token);
  expect(page.messages.map((each) => [each.seq, each.text])).toEqual([
    [1, 'chat one'],
    [2, 'chat two'],
  ]);
  expect(page).toMatchObject({ cursor: 2, more: false });
  expect(
    await f.rows(
      `select m.seq as conversation_seq, l.seq as session_seq
       from messaging.messages m
       left join messaging.webchat_session_messages l on l.message_id = m.id
       order by m.seq`,
    ),
  ).toEqual([
    { conversation_seq: '1', session_seq: 1 },
    { conversation_seq: '2', session_seq: null },
    { conversation_seq: '3', session_seq: 2 },
  ]);
});

it('never deadlocks with a delivery report: a message waits for the business with free hands', async () => {
  const f = await world.fixture();
  const token = await world.started(f);
  await world.sent(f, token, 'first');
  const conversationId = await world.conversationOf(f);
  const reply = await world.replied(f, conversationId, 'answer');
  if (reply.outcome !== 'sent') throw new Error(reply.outcome);
  const another = await world.started(f);
  // The outbound worker's order: the business FOR UPDATE, then a message, whose change of
  // status reaches the conversation through the Inbox's trigger (0046).
  const worker = await world.open(f.context);
  await worker.query('select 1 from tenancy.businesses where id = $1 for update', [f.business.id]);
  const sending = world.sent(f, token, 'second');
  await world.lockWaits(1);
  const ending = world.handlers.end(f.admission, another, request());
  await world.lockWaits(2);
  // Both wait for the business and hold neither the conversation nor a session, so the
  // worker's own step goes through at once. If either held the conversation, this
  // statement would wait for it while it waits for the worker: a deadlock.
  await worker.query("set local lock_timeout = '2s'");
  await worker.query("update messaging.messages set status = 'delivered' where id = $1", [
    reply.messageId,
  ]);
  await worker.release();
  expect(await sending).toMatchObject({ seq: 3, text: 'second' });
  expect(await ending).toEqual({ outcome: 'ok' });
  expect(await f.rows('select message_seq, needs_reply from messaging.conversations')).toEqual([
    { message_seq: '3', needs_reply: true },
  ]);
});
