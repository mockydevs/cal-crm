// Web chat in the Inbox, through the Inbox's own routes on real Postgres: a chat is listed
// as a conversation from someone whose identity nobody proved, it never lands in a
// conversation that already existed, and the composer's reply reaches the visitor who wrote
// and nobody else.
import { randomUUID } from 'node:crypto';

import {
  conversation,
  conversationComposer,
  conversationList,
  conversationThread,
  threadMessage,
  WEBCHAT_LIMITS,
} from '@repo/contracts';
import { toPublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { inboxBusiness, startInbox, type InboxBusiness, type InboxWorld } from '../test/inbox.js';
import { createPublicWebchatHandlers, type PublicWebchatHandlers } from './webchat-public.js';
import { newWidgetKey } from './webchat-token.js';

const ORIGIN = 'https://example.com';

let world: InboxWorld;
let handlers: PublicWebchatHandlers;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
  handlers = createPublicWebchatHandlers(world.db);
});
afterAll(async () => {
  await world.close();
});

const key = () => randomUUID().replaceAll('-', '');
const request = () => ({ requestId: randomUUID() });

/** A widget of the business that is on, as the admin command leaves it. */
async function widgetOf(b: InboxBusiness, name = 'Main site') {
  const publicKey = newWidgetKey();
  const [account] = await b.query<{ id: string }>(
    `insert into messaging.channel_accounts (business_id, channel, name)
     values (app.business_id(), 'webchat', $1) returning id`,
    [name],
  );
  if (account === undefined) throw new Error('No widget account.');
  await b.query(
    `insert into messaging.webchat_widgets (business_id, id, public_key, allowed_origins)
     values (app.business_id(), $1, $2, $3)`,
    [account.id, publicKey, [ORIGIN]],
  );
  const admission = await handlers.admit(publicKey, ORIGIN);
  if (admission === undefined) throw new Error('The widget did not admit its website.');
  return { id: account.id, publicId: toPublicId('channel_account', account.id), admission };
}
type Widget = Awaited<ReturnType<typeof widgetOf>>;

/** A visitor's chat: the session's token and the conversation its first message made. */
async function chatOn(
  b: InboxBusiness,
  widget: Widget,
  visitor: { name?: string; email?: string } = {},
  text = 'Do you deliver on Sundays?',
) {
  const started = await handlers.start(
    widget.admission,
    { email: `${randomUUID()}@example.test`, marketingConsent: false, ...visitor },
    request(),
  );
  if (started.outcome !== 'ok') throw new Error(started.outcome);
  const { token } = started.session;
  const sent = await handlers.send(
    widget.admission,
    token,
    { clientMessageId: randomUUID(), text },
    request(),
  );
  if (sent.outcome !== 'ok') throw new Error(sent.outcome);
  const [row] = await b.query<{ id: string; contact_id: string }>(
    `select c.id, c.contact_id from messaging.conversations c
     join messaging.webchat_sessions s on s.conversation_id = c.id
     order by s.created_at desc, s.id desc limit 1`,
  );
  if (row === undefined) throw new Error('No conversation.');
  const params = { id: toPublicId('conversation', row.id) };
  const visitorReads = async (): Promise<string[]> => {
    const page = await handlers.messages(widget.admission, token, 0);
    if (page.outcome !== 'ok') throw new Error(page.outcome);
    return page.page.messages.map((each) => `${each.from}: ${each.text}`);
  };
  const reply = (changes: Record<string, unknown> = {}) =>
    world.call('sendConversationReply', b.as(), {
      params,
      body: {
        channel: 'webchat',
        accountId: widget.publicId,
        text: 'Yes, until noon.',
        idempotencyKey: key(),
        ...changes,
      },
    });
  return { token, conversationId: row.id, contactId: row.contact_id, params, visitorReads, reply };
}

const refusal = async (work: Promise<unknown>): Promise<unknown> => {
  const failed = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failed).toBeInstanceOf(ValidationError);
  return failed instanceof ValidationError ? failed.issues[0] : undefined;
};

it('lists a chat as a conversation whose writer nobody verified, and an email one as verified by its address', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const chat = await chatOn(b, widget, { name: 'Maya Thompson' });
  const emailed = await b.contact({ firstName: 'Sam' });
  const box = await b.mailbox();
  const mail = await b.receive(emailed, box.id, 'By email');

  const list = conversationList.parse(await world.call('listConversations', b.as()));
  const byId = new Map(list.items.map((each) => [each.id, each]));
  expect(byId.get(chat.params.id)).toMatchObject({
    contact: { name: 'Maya Thompson' },
    unverified: true,
    claimedContact: null,
    needsReply: true,
    unreadCount: 1,
    lastMessage: {
      channel: 'webchat',
      direction: 'inbound',
      preview: 'Do you deliver on Sundays?',
    },
  });
  expect(byId.get(toPublicId('conversation', mail.conversationId))).toMatchObject({
    unverified: false,
    claimedContact: null,
  });
  // The same on the conversation read alone, and under the list's web chat filter.
  expect(
    conversation.parse(await world.call('getConversation', b.as(), { params: chat.params })),
  ).toMatchObject({ unverified: true, claimedContact: null });
  const filtered = conversationList.parse(
    await world.call('listConversations', b.as(), { query: { channel: 'webchat' } }),
  );
  expect(filtered.items.map((each) => each.id)).toEqual([chat.params.id]);
});

it('never puts a visitor into the conversation of the contact whose address they typed, and shows the claim', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const known = await b.contact({
    firstName: 'Maya',
    lastName: 'Thompson',
    email: 'maya@example.test',
  });
  const box = await b.mailbox();
  const earlier = await b.receive(known, box.id, 'My card ends in 4242.');

  const chat = await chatOn(
    b,
    widget,
    { name: 'Maya T', email: 'maya@example.test' },
    'Remind me what card I used?',
  );
  expect(chat.conversationId).not.toBe(earlier.conversationId);
  expect(chat.contactId).not.toBe(known.id);

  const shown = conversation.parse(
    await world.call('getConversation', b.as(), { params: chat.params }),
  );
  expect(shown).toMatchObject({
    contact: { name: 'Maya T' },
    unverified: true,
    claimedContact: { id: known.publicId, name: 'Maya Thompson', trashed: false },
  });
  // The existing contact's conversation holds only what it held, and is not marked.
  const theirs = { id: toPublicId('conversation', earlier.conversationId) };
  expect(
    conversation.parse(await world.call('getConversation', b.as(), { params: theirs })),
  ).toMatchObject({ unverified: false, claimedContact: null, unreadCount: 1 });
  const thread = conversationThread.parse(
    await world.call('listConversationMessages', b.as(), { params: theirs }),
  );
  expect(thread.items.map((each) => each.text)).toEqual(['My card ends in 4242.']);
  // And the visitor's own thread holds only what the visitor wrote.
  const own = conversationThread.parse(
    await world.call('listConversationMessages', b.as(), { params: chat.params }),
  );
  expect(own.items).toMatchObject([
    {
      kind: 'message',
      channel: 'webchat',
      direction: 'inbound',
      text: 'Remind me what card I used?',
      account: { id: widget.publicId, name: 'Main site', address: null },
      author: { kind: 'contact', name: 'Maya T' },
    },
  ]);
  // The claim follows the claimed contact into the trash, and goes when they are purged.
  await b.query('update crm.contacts set deleted_at = now() where id = $1', [known.id]);
  expect(
    conversation.parse(await world.call('getConversation', b.as(), { params: chat.params }))
      .claimedContact,
  ).toMatchObject({ id: known.publicId, trashed: true });
});

it('offers the composer the widget the visitor wrote through, with no address to choose', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  await widgetOf(b, 'Another site');
  const chat = await chatOn(b, widget);
  const composer = conversationComposer.parse(
    await world.call('getConversationComposer', b.as(), { params: chat.params }),
  );
  expect(composer.channels.find((each) => each.channel === 'webchat')).toEqual({
    channel: 'webchat',
    available: true,
    unavailable: null,
    accounts: [{ id: widget.publicId, name: 'Main site', address: null }],
    recipients: [],
  });
  // The visitor wrote through web chat, so the reply starts there.
  expect(composer.suggestedChannel).toBe('webchat');
  // The visitor's contact has no mailbox to be written from here, and no web chat elsewhere.
  const emailed = await b.contact({ firstName: 'Sam' });
  const box = await b.mailbox();
  const mail = await b.receive(emailed, box.id, 'By email');
  const other = conversationComposer.parse(
    await world.call('getConversationComposer', b.as(), {
      params: { id: toPublicId('conversation', mail.conversationId) },
    }),
  );
  expect(other.channels.find((each) => each.channel === 'webchat')).toEqual({
    channel: 'webchat',
    available: false,
    unavailable: {
      code: 'no_recipient',
      message: 'This contact has not written through web chat.',
    },
    accounts: [],
    recipients: [],
  });
  expect(other.suggestedChannel).toBe('email');
});

it("stores a reply where the visitor's chat reads it, at once and exactly once", async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const chat = await chatOn(b, widget);
  const idempotencyKey = key();
  const first = threadMessage.parse(await chat.reply({ idempotencyKey }));
  expect(first).toMatchObject({
    kind: 'message',
    channel: 'webchat',
    direction: 'outbound',
    status: 'sent',
    problem: null,
    held: null,
    text: 'Yes, until noon.',
    account: { id: widget.publicId, address: null },
    author: { kind: 'user', name: 'Dana Brooks', you: true },
    to: [],
  });
  // A double click, or a retry: the same message, and still one.
  expect(threadMessage.parse(await chat.reply({ idempotencyKey }))).toEqual(first);
  expect(await chat.visitorReads()).toEqual([
    'visitor: Do you deliver on Sundays?',
    'team: Yes, until noon.',
  ]);
  // Nothing went to the outbound pipeline: no dispatch row and no delivery job.
  expect(await b.query('select 1 from messaging.outbound_dispatch')).toEqual([]);
  expect(await b.queuedDeliveries()).toBe(0);
  expect(
    conversation.parse(await world.call('getConversation', b.as(), { params: chat.params })),
  ).toMatchObject({
    needsReply: false,
    lastMessage: { channel: 'webchat', direction: 'outbound' },
  });
  // The words are in neither the audit log nor an event.
  const kept = JSON.stringify([await b.events(), await b.audit()]);
  expect(kept).not.toContain('Yes, until noon.');
  expect(kept).toContain('message.submitted');
});

it('reaches only the visitor of that conversation, though another typed the same address', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const first = await chatOn(b, widget, { email: 'shared@example.test' }, 'I am the first.');
  const second = await chatOn(b, widget, { email: 'shared@example.test' }, 'I am the second.');
  expect(second.conversationId).not.toBe(first.conversationId);
  await first.reply({ text: 'For the first only.' });
  await second.reply({ text: 'For the second only.' });
  expect(await first.visitorReads()).toEqual([
    'visitor: I am the first.',
    'team: For the first only.',
  ]);
  expect(await second.visitorReads()).toEqual([
    'visitor: I am the second.',
    'team: For the second only.',
  ]);
});

it('refuses a web chat reply that names an address, another account, or too many words', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const other = await widgetOf(b, 'Another site');
  const box = await b.mailbox();
  const someone = await b.contact({ firstName: 'Sam' });
  const chat = await chatOn(b, widget);
  const elsewhere = await widgetOf(await inboxBusiness(world));

  expect(await refusal(chat.reply({ to: someone.emailIdentity }))).toMatchObject({ path: '/to' });
  expect(await refusal(chat.reply({ subject: 'Hello' }))).toMatchObject({ path: '/subject' });
  for (const accountId of [
    other.publicId,
    box.publicId,
    // A widget that is on, in another business: it reads as one this business doesn't have.
    elsewhere.publicId,
  ])
    expect(await refusal(chat.reply({ accountId }))).toMatchObject({
      path: '/accountId',
      code: 'account_channel_mismatch',
    });
  expect(
    await refusal(chat.reply({ text: 'x'.repeat(WEBCHAT_LIMITS.messageLength + 1) })),
  ).toMatchObject({ path: '/text', code: 'text_too_long' });
  // A conversation nobody chatted in has no chat to answer.
  const mail = await b.receive(someone, box.id, 'By email');
  expect(
    await refusal(
      world.call('sendConversationReply', b.as(), {
        params: { id: toPublicId('conversation', mail.conversationId) },
        body: { channel: 'webchat', accountId: widget.publicId, text: 'Hi', idempotencyKey: key() },
      }),
    ),
  ).toMatchObject({ path: '/channel', code: 'channel_unavailable' });
  // And email still needs one of the contact's own addresses.
  expect(
    await refusal(
      world.call('sendConversationReply', b.as(), {
        params: { id: toPublicId('conversation', mail.conversationId) },
        body: { channel: 'email', accountId: box.publicId, text: 'Hi', idempotencyKey: key() },
      }),
    ),
  ).toMatchObject({ path: '/to' });
  expect(await chat.visitorReads()).toEqual(['visitor: Do you deliver on Sundays?']);
  expect(await b.query("select 1 from messaging.messages where direction = 'outbound'")).toEqual(
    [],
  );
});

it('says the visitor has left, or the widget is off, in the composer and when a reply is tried', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const chat = await chatOn(b, widget);
  const offered = async () =>
    conversationComposer
      .parse(await world.call('getConversationComposer', b.as(), { params: chat.params }))
      .channels.find((each) => each.channel === 'webchat');

  await b.query("update messaging.channel_accounts set status = 'paused' where id = $1", [
    widget.id,
  ]);
  expect(await offered()).toMatchObject({
    available: false,
    unavailable: { code: 'no_account' },
    accounts: [],
  });
  expect(await refusal(chat.reply())).toMatchObject({
    path: '/accountId',
    code: 'account_unavailable',
  });
  await b.query("update messaging.channel_accounts set status = 'active' where id = $1", [
    widget.id,
  ]);

  expect(await handlers.end(widget.admission, chat.token, request())).toEqual({ outcome: 'ok' });
  expect(await offered()).toMatchObject({
    available: false,
    unavailable: {
      code: 'visitor_left',
      message: 'The visitor has left the chat, so a reply would reach nobody.',
    },
  });
  expect(await refusal(chat.reply())).toMatchObject({ path: '/channel', code: 'visitor_left' });
  expect(await b.query("select 1 from messaging.messages where direction = 'outbound'")).toEqual(
    [],
  );
  // The conversation is still the team's to read, and still marked.
  expect(
    conversation.parse(await world.call('getConversation', b.as(), { params: chat.params })),
  ).toMatchObject({ unverified: true });
});

it('refuses a reply to a visitor whose contact is in the trash', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const chat = await chatOn(b, widget);
  await b.query('update crm.contacts set deleted_at = now() where id = $1', [chat.contactId]);
  expect(await refusal(chat.reply())).toMatchObject({ code: 'contact_inactive' });
  expect(await chat.visitorReads()).toEqual(['visitor: Do you deliver on Sundays?']);
});

it('refuses a web chat reply while do not disturb is on for web chat or for every channel, in the composer and when a reply is tried', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const chat = await chatOn(b, widget);
  const offered = async () =>
    conversationComposer
      .parse(await world.call('getConversationComposer', b.as(), { params: chat.params }))
      .channels.find((each) => each.channel === 'webchat');

  await b.query("update crm.contacts set dnd_channels = '{webchat}' where id = $1", [
    chat.contactId,
  ]);
  expect(await offered()).toMatchObject({
    available: false,
    unavailable: {
      code: 'do_not_contact',
      message: 'Do not disturb is on for web chat for this contact.',
    },
  });
  expect(await refusal(chat.reply())).toMatchObject({
    path: '/channel',
    code: 'do_not_contact',
    message: 'Do not disturb is on for web chat for this contact.',
  });

  // Another channel's do not disturb leaves web chat alone.
  await b.query("update crm.contacts set dnd_channels = '{email,sms}' where id = $1", [
    chat.contactId,
  ]);
  expect(await offered()).toMatchObject({ available: true, unavailable: null });

  await b.query(
    "update crm.contacts set dnd_channels = '{}', do_not_contact = true where id = $1",
    [chat.contactId],
  );
  expect(await offered()).toMatchObject({
    available: false,
    unavailable: {
      code: 'do_not_contact',
      message: 'This contact is marked do not contact, so nothing can be sent.',
    },
  });
  expect(await refusal(chat.reply())).toMatchObject({ path: '/channel', code: 'do_not_contact' });
  expect(await chat.visitorReads()).toEqual(['visitor: Do you deliver on Sundays?']);

  await b.query('update crm.contacts set do_not_contact = false where id = $1', [chat.contactId]);
  threadMessage.parse(await chat.reply());
  expect(await chat.visitorReads()).toEqual([
    'visitor: Do you deliver on Sundays?',
    'team: Yes, until noon.',
  ]);
});

it('stores a chat reply beside a change to the contact that holds its row, without a deadlock', async () => {
  const b = await inboxBusiness(world);
  const widget = await widgetOf(b);
  const chat = await chatOn(b, widget);
  let reply: Promise<PromiseSettledResult<unknown>[]> | undefined;
  // A change to the contact as the CRM's commands make it (do not disturb, followers, the
  // contact itself): the contact's row first, FOR NO KEY UPDATE, then its event, whose
  // foreign key takes the business row FOR KEY SHARE. The reply holds the business FOR
  // UPDATE meanwhile, and must not wait for the contact.
  await world.database.withTenant({ ...b.context, correlationId: randomUUID() }, async (held) => {
    await held.query('select id from crm.contacts where id = $1 for no key update', [
      chat.contactId,
    ]);
    const [owner] = await held.query<{ pid: number }>('select pg_backend_pid() as pid');
    const progress = { settled: false };
    reply = Promise.allSettled([chat.reply()]).then((outcome) => {
      progress.settled = true;
      return outcome;
    });
    // The reply has the business now: it has either finished, or waits for this change.
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (progress.settled) break;
      const [row] = await world.database.as('postgres', (sql) =>
        sql.query<{ behind: number }>(
          `select count(*)::int as behind from pg_stat_activity
           where datname = current_database() and $1 = any(pg_blocking_pids(pid))`,
          [owner?.pid ?? 0],
        ),
      );
      if ((row?.behind ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error('The reply neither finished nor waited.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await held.query('select id from tenancy.businesses where id = $1 for key share', [
      b.business.id,
    ]);
  });
  const [outcome] = (await reply) ?? [];
  expect(outcome).toMatchObject({ status: 'fulfilled' });
  expect(await chat.visitorReads()).toEqual([
    'visitor: Do you deliver on Sundays?',
    'team: Yes, until noon.',
  ]);
});
