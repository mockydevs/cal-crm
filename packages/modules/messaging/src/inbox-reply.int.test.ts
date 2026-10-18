// The composer and internal notes: the sending account must match the channel, a reply goes
// through the outbound pipeline exactly once and its real outcome is returned, and a note
// never reaches the contact by any path. Real Postgres.
import { randomUUID } from 'node:crypto';

import {
  conversation,
  conversationComposer,
  conversationList,
  conversationThread,
  threadMessage,
  threadNote,
} from '@repo/contracts';
import { ConflictError, parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { inboxBusiness, startInbox, type InboxWorld } from '../test/inbox.js';
import { createInboxRoutes } from './inbox-routes.js';
import { createDispatchOutboundTask } from './outbound.js';

let world: InboxWorld;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

const key = () => randomUUID().replaceAll('-', '');

/** A business with a contact who wrote in, and what a reply to them needs. */
async function conversationWith(values: { phone?: string; consent?: boolean } = {}) {
  const b = await inboxBusiness(world);
  const maya = await b.contact({ firstName: 'Maya', ...values });
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'Is June 13 still open?');
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const body = (changes: Record<string, unknown> = {}) => ({
    channel: 'email',
    accountId: box.publicId,
    to: maya.emailIdentity,
    text: 'Hi Maya, June 13 is open.',
    idempotencyKey: key(),
    ...changes,
  });
  const messages = () =>
    b.query<{
      id: string;
      channel: string;
      direction: string;
      status: string;
      error_code: string | null;
      idempotency_key: string | null;
      priority: number;
    }>(
      `select id, channel, direction, status, error_code, idempotency_key, priority
       from messaging.messages where direction <> 'inbound' order by seq`,
    );
  const send = (changes: Record<string, unknown> = {}) =>
    world.call('sendConversationReply', b.as(), { params, body: body(changes) });
  return { b, maya, box, stored, params, body, messages, send };
}

it('refuses a reply whose account, channel and recipient do not belong together', async () => {
  const f = await conversationWith({ phone: '+254700000001' });
  const sms = await f.b.smsAccount();
  const paused = await f.b.mailbox({ status: 'paused' });
  const campaigns = await f.b.mailbox({ forConversations: false });
  const someoneElse = await f.b.contact({ firstName: 'Daniel' });
  const refused = async (changes: Record<string, unknown>, path: string, code: string) => {
    const attempt = f.send(changes);
    await expect(attempt, code).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt, code).rejects.toMatchObject({ issues: [{ path, code }] });
  };
  // The sending account must be of the chosen channel ...
  await refused({ accountId: sms.publicId }, '/accountId', 'account_channel_mismatch');
  // ... connected and active ...
  await refused({ accountId: paused.publicId }, '/accountId', 'account_unavailable');
  // ... and a mailbox the business uses for conversations.
  await refused({ accountId: campaigns.publicId }, '/accountId', 'account_not_for_conversations');
  // The recipient must be this conversation's contact, at an address of this channel.
  await refused({ to: someoneElse.emailIdentity }, '/to', 'recipient_not_in_conversation');
  await refused({ to: f.maya.phoneIdentity }, '/to', 'recipient_channel_mismatch');
  // Only email has a subject, and a subject has one line.
  await expect(f.send({ channel: 'sms', subject: 'Hello' })).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(f.send({ subject: 'Hello\r\nBcc: someone@example.test' })).rejects.toBeInstanceOf(
    ValidationError,
  );
  // None of it stored a message, queued a delivery or recorded an event.
  expect(await f.messages()).toEqual([]);
  expect(await f.b.queuedDeliveries()).toBe(0);
  expect(await f.b.events()).toEqual([]);
  expect(await world.call('getConversation', f.b.as(), { params: f.params })).toMatchObject({
    needsReply: true,
  });
});

it('sends a text message only where the install can deliver one and the number can send', async () => {
  const f = await conversationWith({ phone: '+254700000002' });
  const sms = await f.b.smsAccount();
  const textReply = { channel: 'sms', accountId: sms.publicId, to: f.maya.phoneIdentity };
  // A connected number exists, and still this install has nothing that delivers a text.
  const attempt = f.send(textReply);
  await expect(attempt).rejects.toBeInstanceOf(ValidationError);
  await expect(attempt).rejects.toMatchObject({
    issues: [
      {
        path: '/channel',
        code: 'channel_unavailable',
        message: "Text messages can't be sent: this install isn't set up to deliver them.",
      },
    ],
  });
  expect(await f.messages()).toEqual([]);
  expect(await world.call('getConversationComposer', f.b.as(), { params: f.params })).toMatchObject(
    {
      channels: [
        { channel: 'email', available: true },
        { channel: 'sms', available: false, unavailable: { code: 'channel_unavailable' } },
        // Nobody chatted in this conversation.
        { channel: 'webchat', available: false, unavailable: { code: 'no_recipient' } },
      ],
    },
  );

  // Where the install delivers text messages, the same request is the pipeline's.
  const withSms = createInboxRoutes({ ...world.options, smsAvailable: true });
  // A number with nothing registered behind it, and one whose provider is not connected,
  // are not offered and are refused when asked for anyway.
  const bare = await f.b.smsAccount({ registered: false });
  const failing = await f.b.smsAccount({ connection: 'failing' });
  for (const account of [bare, failing])
    await expect(
      world.call(
        'sendConversationReply',
        f.b.as(),
        { params: f.params, body: f.body({ ...textReply, accountId: account.publicId }) },
        withSms,
      ),
      account.publicId,
    ).rejects.toMatchObject({ issues: [{ path: '/accountId', code: 'account_unavailable' }] });
  // A text message has its own length.
  await expect(
    world.call(
      'sendConversationReply',
      f.b.as(),
      { params: f.params, body: f.body({ ...textReply, text: 'x'.repeat(1601) }) },
      withSms,
    ),
  ).rejects.toMatchObject({ issues: [{ path: '/text', code: 'text_too_long' }] });
  expect(await f.messages()).toEqual([]);
  expect(
    await world.call('getConversationComposer', f.b.as(), { params: f.params }, withSms),
  ).toMatchObject({
    channels: [
      { channel: 'email' },
      {
        channel: 'sms',
        available: true,
        accounts: [{ id: sms.publicId, name: 'Front desk line', address: sms.e164 }],
        recipients: [{ id: f.maya.phoneIdentity, address: '+254700000002' }],
      },
      { channel: 'webchat', available: false },
    ],
  });
  expect(
    await world.call(
      'sendConversationReply',
      f.b.as(),
      { params: f.params, body: f.body(textReply) },
      withSms,
    ),
  ).toMatchObject({ kind: 'message', channel: 'sms', status: 'queued', to: ['+254700000002'] });
  // The account must still match: a mailbox can't send a text.
  await expect(
    world.call(
      'sendConversationReply',
      f.b.as(),
      { params: f.params, body: f.body({ ...textReply, accountId: f.box.publicId }) },
      withSms,
    ),
  ).rejects.toMatchObject({ issues: [{ path: '/accountId', code: 'account_channel_mismatch' }] });
});

it('sends a reply through the pipeline as a transactional message in the reply lane', async () => {
  const f = await conversationWith();
  const sent = threadMessage.parse(await f.send({ subject: 'Re: June 13' }));
  const messageId = parsePublicId('message', sent.id) ?? '';
  expect(await f.messages()).toMatchObject([
    { id: messageId, channel: 'email', direction: 'outbound', status: 'queued', priority: 0 },
  ]);
  expect(
    await f.b.query(
      `select purpose, lane, direction, reserved_at from messaging.outbound_dispatch where id = $1`,
      [messageId],
    ),
  ).toEqual([
    { purpose: 'transactional', lane: 'reply', direction: 'outbound', reserved_at: null },
  ]);
  expect(await f.b.queuedDeliveries()).toBe(1);
  expect(await f.b.events()).toMatchObject([
    { type: 'message.submitted', subject_kind: 'message', payload: { status: 'queued' } },
  ]);
});

it("puts a person's email signature under their reply when they have it switched on, and nowhere else", async () => {
  const f = await conversationWith({ phone: '+13055550101' });
  const sender = f.b.as().context;
  const signature = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Dana Brooks', marks: [{ type: 'bold' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'Harbor Lights Events' },
        ],
      },
    ],
  };
  const keep = (enabled: boolean, document: unknown = signature) =>
    f.b.query(
      `insert into tenancy.user_profiles (agency_id, user_id, first_name, signature, signature_enabled)
       values ($1, $2, 'Dana', $3::jsonb, $4)
       on conflict (agency_id, user_id) do update
         set signature = excluded.signature, signature_enabled = excluded.signature_enabled`,
      [sender.agencyId, sender.userId, JSON.stringify(document), enabled],
    );
  const bodies = async () =>
    (
      await f.b.query<{ body_text: string }>(
        `select body_text from messaging.messages where direction = 'outbound' order by seq`,
      )
    ).map((row) => row.body_text);

  // Kept but switched off: the words as written.
  await keep(false);
  await f.send();
  // Switched on: the usual delimiter, then the signature as text.
  await keep(true);
  const signed = threadMessage.parse(await f.send({ text: 'June 13 is yours.' }));
  // Submitted again with the same key after the signature changed: the message already there.
  await keep(true, {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Changed' }] }],
  });
  const retryKey = key();
  await f.send({ text: 'Once.', idempotencyKey: retryKey });
  await f.send({ text: 'Once.', idempotencyKey: retryKey });
  expect(await bodies()).toEqual([
    'Hi Maya, June 13 is open.',
    'June 13 is yours.\n\n-- \nDana Brooks\nHarbor Lights Events',
    'Once.\n\n-- \nChanged',
  ]);
  expect(signed.text).toBe('June 13 is yours.\n\n-- \nDana Brooks\nHarbor Lights Events');
});

it('never sends twice for one idempotency key, on a retry or a double click', async () => {
  const f = await conversationWith();
  const again = f.body();
  const call = () =>
    world.call('sendConversationReply', f.b.as(), { params: f.params, body: again });
  const first = threadMessage.parse(await call());
  const retry = threadMessage.parse(await call());
  expect(retry.id).toBe(first.id);
  expect(await f.messages()).toHaveLength(1);
  expect(await f.b.queuedDeliveries()).toBe(1);
  expect((await f.b.events()).map((event) => event.type)).toEqual(['message.submitted']);
  // The client's key is kept apart from every other sender's keys.
  expect((await f.messages())[0]?.idempotency_key).toBe(
    `inbox-reply:${f.stored.conversationId}:${again.idempotencyKey}`,
  );

  // The same key with other words is a different message: refused, not sent.
  await expect(
    world.call('sendConversationReply', f.b.as(), {
      params: f.params,
      body: { ...again, text: 'Something else entirely.' },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await f.messages()).toHaveLength(1);

  // A retry is answered even when the account has since been paused: it sends nothing new.
  await f.b.query("update messaging.channel_accounts set status = 'paused' where id = $1", [
    f.box.id,
  ]);
  expect(threadMessage.parse(await call()).id).toBe(first.id);
  await expect(f.send()).rejects.toMatchObject({ issues: [{ code: 'account_unavailable' }] });
  expect(await f.messages()).toHaveLength(1);
  expect(await f.b.queuedDeliveries()).toBe(1);
  // Delivered once, however often the job runs.
  await f.b.query("update messaging.channel_accounts set status = 'active' where id = $1", [
    f.box.id,
  ]);
  const messageId = parsePublicId('message', first.id) ?? '';
  expect(await f.b.dispatch(messageId)).toBe(1);
  expect(await f.b.dispatch(messageId)).toBe(0);
});

it('stores one message when the same reply is submitted twice at the same moment', async () => {
  const f = await conversationWith();
  const again = f.body();
  let submits: Promise<PromiseSettledResult<unknown>[]> | undefined;
  // The pipeline serializes a business's sends on its row. While it is held, both submits
  // of the double click are waiting on it: neither has looked for the other's message.
  await world.database.withTenant({ ...f.b.context, correlationId: randomUUID() }, async (sql) => {
    await sql.query('select id from tenancy.businesses where id = $1 for update', [
      f.b.business.id,
    ]);
    const [owner] = await sql.query<{ pid: number }>('select pg_backend_pid() as pid');
    submits = Promise.allSettled(
      [1, 2].map(() =>
        world.call('sendConversationReply', f.b.as(), { params: f.params, body: again }),
      ),
    );
    await world.blockedBy(owner?.pid ?? 0, 2);
  });
  if (submits === undefined) throw new Error('The submits never started.');
  const settled = await submits;
  expect(settled.map((each) => each.status)).toEqual(['fulfilled', 'fulfilled']);
  const ids = settled.map((each) =>
    each.status === 'fulfilled' ? threadMessage.parse(each.value).id : '',
  );
  expect(new Set(ids).size).toBe(1);
  expect(await f.messages()).toHaveLength(1);
  expect(await f.b.queuedDeliveries()).toBe(1);
  expect(await f.b.query('select count(*)::int as n from messaging.outbound_dispatch')).toEqual([
    { n: 1 },
  ]);
  expect((await f.b.events()).map((event) => event.type)).toEqual(['message.submitted']);
});

it('reports what the pipeline refused or held, and never hides it', async () => {
  // The contact wrote in from this very address: answering needs no recorded consent, and
  // the answer is queued.
  const answered = await conversationWith({ consent: false });
  expect(threadMessage.parse(await answered.send())).toMatchObject({ status: 'queued' });
  expect(await answered.b.queuedDeliveries()).toBe(1);
  // They wrote from another address: answering this one still needs consent, so the
  // pipeline refuses, and the answer says so in plain words.
  const without = await conversationWith({ consent: false });
  await without.b.query(
    "update messaging.messages set from_address = 'someone-else@example.test' where direction = 'inbound'",
  );
  const refused = threadMessage.parse(await without.send());
  expect(refused).toMatchObject({
    status: 'failed',
    problem: {
      code: 'consent_required',
      message: "Not sent: this contact hasn't agreed to receive messages on this channel.",
    },
    held: null,
  });
  expect(await without.b.queuedDeliveries()).toBe(0);
  // A refused reply is in the thread, and the contact is still waiting.
  expect(
    await world.call('getConversation', without.b.as(), { params: without.params }),
  ).toMatchObject({ needsReply: true });
  expect(
    conversationThread.parse(
      await world.call('listConversationMessages', without.b.as(), { params: without.params }),
    ).items[0],
  ).toMatchObject({ kind: 'message', status: 'failed', problem: { code: 'consent_required' } });

  // A blocked address.
  const blocked = await conversationWith();
  await blocked.b.query(
    `insert into messaging.suppressions (business_id, channel, address_normalized, reason)
     values (app.business_id(), 'email', $1, 'hard_bounce')`,
    [blocked.maya.email],
  );
  expect(await blocked.send()).toMatchObject({
    status: 'failed',
    problem: {
      code: 'suppressed',
      message: 'Not sent: an earlier message to this address bounced, so it is blocked.',
    },
  });

  // Do not contact.
  const dnc = await conversationWith();
  await dnc.b.query('update crm.contacts set do_not_contact = true where id = $1', [dnc.maya.id]);
  expect(await dnc.send()).toMatchObject({ status: 'failed', problem: { code: 'do_not_contact' } });

  // Quiet hours all day where the contact is: held, with the reason and the next try.
  const quiet = await conversationWith();
  await quiet.b.query(
    `update messaging.settings set quiet_hours_enabled = true,
       quiet_hours_start = '00:00', quiet_hours_end = '00:00'`,
  );
  await quiet.b.query("update crm.contacts set timezone = 'Africa/Nairobi' where id = $1", [
    quiet.maya.id,
  ]);
  const held = threadMessage.parse(await quiet.send());
  expect(held).toMatchObject({
    status: 'queued',
    problem: null,
    held: {
      code: 'quiet_hours',
      message: 'Waiting: it is quiet hours where this contact is. It will be sent when they end.',
    },
  });
  expect(Date.parse(held.held?.until ?? '')).toBeGreaterThan(Date.now());
  // Held is on its way: the team has answered.
  expect(await world.call('getConversation', quiet.b.as(), { params: quiet.params })).toMatchObject(
    { needsReply: false },
  );
  expect(await quiet.b.queuedDeliveries()).toBe(1);

  // Quiet hours are on and the contact has no time zone: refused, and it says what to do.
  const nowhere = await conversationWith();
  // Neither the contact nor the business has a zone quiet hours can be kept by.
  await nowhere.b.query(
    "update tenancy.businesses set timezone = 'Nowhere/Zone' where id = app.business_id()",
  );
  await nowhere.b.query('update messaging.settings set quiet_hours_enabled = true');
  expect(await nowhere.send()).toMatchObject({
    status: 'failed',
    problem: { code: 'timing_unknown' },
  });

  // A contact in the trash is refused before anything is stored.
  const trashed = await conversationWith();
  await trashed.b.query('update crm.contacts set deleted_at = now() where id = $1', [
    trashed.maya.id,
  ]);
  await expect(trashed.send()).rejects.toMatchObject({ issues: [{ code: 'contact_inactive' }] });
  expect(await trashed.messages()).toEqual([]);
});

it('shows what delivery did to a reply', async () => {
  const f = await conversationWith();
  const statusOf = async (delivery: 'accepted' | 'rejected' | 'throws') => {
    const reply = threadMessage.parse(await f.send());
    await f.b.dispatch(parsePublicId('message', reply.id) ?? '', delivery);
    const thread = conversationThread.parse(
      await world.call('listConversationMessages', f.b.as(), { params: f.params }),
    );
    const shown = thread.items.find((item) => item.id === reply.id);
    return shown?.kind === 'message' ? shown : undefined;
  };
  expect(await statusOf('accepted')).toMatchObject({ status: 'sent', problem: null });
  expect((await statusOf('accepted'))?.sentAt).not.toBeNull();
  expect(await statusOf('rejected')).toMatchObject({
    status: 'failed',
    problem: {
      code: 'delivery_rejected',
      message: "Not sent: the sending account's server refused the message.",
    },
  });
  expect(await statusOf('throws')).toMatchObject({
    status: 'unknown',
    problem: { code: 'delivery_unknown' },
  });
});

it('stores one note for one retry key, on a retry or a double click', async () => {
  const f = await conversationWith();
  const me = f.b.as();
  const body = { text: 'Call her back after 4.', idempotencyKey: key() };
  const add = () => world.call('addConversationNote', me, { params: f.params, body });
  const first = threadNote.parse(await add());
  expect(threadNote.parse(await add()).id).toBe(first.id);
  const notes = () =>
    f.b.query<{ id: string; idempotency_key: string | null }>(
      "select id, idempotency_key from messaging.messages where channel = 'note'",
    );
  expect(await notes()).toEqual([
    {
      id: parsePublicId('message', first.id),
      idempotency_key: `inbox-note:${f.stored.conversationId}:${body.idempotencyKey}`,
    },
  ]);
  expect((await f.b.events()).map((event) => event.type)).toEqual(['conversation.note_added']);
  // The same key with other words is another note: refused, not stored over the first.
  await expect(
    world.call('addConversationNote', me, {
      params: f.params,
      body: { ...body, text: 'Something else.' },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  // Still one note.
  expect(await f.messages()).toHaveLength(1);

  // A double click: both requests wait behind the business, then one stores the note.
  const again = { text: 'Second note.', idempotencyKey: key() };
  let submits: Promise<PromiseSettledResult<unknown>[]> | undefined;
  await world.database.withTenant({ ...f.b.context, correlationId: randomUUID() }, async (sql) => {
    await sql.query('select id from tenancy.businesses where id = $1 for update', [
      f.b.business.id,
    ]);
    const [owner] = await sql.query<{ pid: number }>('select pg_backend_pid() as pid');
    submits = Promise.allSettled(
      [1, 2].map(() => world.call('addConversationNote', me, { params: f.params, body: again })),
    );
    await world.blockedBy(owner?.pid ?? 0, 2);
  });
  if (submits === undefined) throw new Error('The submits never started.');
  const settled = await submits;
  expect(settled.map((each) => each.status)).toEqual(['fulfilled', 'fulfilled']);
  const ids = settled.map((each) =>
    each.status === 'fulfilled' ? threadNote.parse(each.value).id : '',
  );
  expect(new Set(ids).size).toBe(1);
  expect(await notes()).toHaveLength(2);
  expect((await f.b.events()).map((event) => event.type)).toEqual([
    'conversation.note_added',
    'conversation.note_added',
  ]);
  expect(await f.b.queuedDeliveries()).toBe(0);
});

it('never lets an internal note reach the contact', async () => {
  const f = await conversationWith();
  const me = f.b.as();
  const note = threadNote.parse(
    await world.call('addConversationNote', me, {
      params: f.params,
      body: {
        text: 'Do not offer a discount: she already agreed the price.',
        idempotencyKey: key(),
      },
    }),
  );
  const noteId = parsePublicId('message', note.id) ?? '';

  // As stored, it has nothing a delivery could use.
  expect(
    await f.b.query(
      `select channel, direction, status, channel_account_id, to_addresses, cc_addresses,
         bcc_addresses, scheduled_for, provider_message_id, email_message_id
       from messaging.messages where id = $1`,
      [noteId],
    ),
  ).toEqual([
    {
      channel: 'note',
      direction: 'internal',
      status: 'note',
      channel_account_id: null,
      to_addresses: [],
      cc_addresses: [],
      bcc_addresses: [],
      scheduled_for: null,
      provider_message_id: null,
      email_message_id: null,
    },
  ]);
  expect(
    await f.b.query('select id from messaging.outbound_dispatch where id = $1', [noteId]),
  ).toEqual([]);
  expect(await f.b.queuedDeliveries()).toBe(0);

  // Asked to deliver the note anyway, the worker's task calls no provider.
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver: () => {
      deliveries += 1;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'must-not-happen' });
    },
  });
  await task.run(
    { messageId: noteId },
    {
      invocation: {
        context: { ...f.b.context, actorKind: 'system', correlationId: randomUUID() },
        permissions: 'all',
      },
      services: world.services,
    },
  );
  expect(deliveries).toBe(0);
  // The queue refuses it, and it can be given no dispatch row.
  await expect(f.b.query('select private.enqueue_outbound($1)', [noteId])).rejects.toThrow(
    /outbound message is not available/,
  );
  const [identity] = await f.b.query<{ id: string }>(
    'select id from crm.contact_identities where contact_id = $1',
    [f.maya.id],
  );
  await expect(
    f.b.query(
      `insert into messaging.outbound_dispatch (business_id, id, identity_id, purpose, lane, request_hash)
       values (app.business_id(), $1, $2, 'transactional', 'reply', repeat('a', 64))`,
      [noteId, identity?.id],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  expect(await f.b.query('select status from messaging.messages where id = $1', [noteId])).toEqual([
    { status: 'note' },
  ]);

  // A real reply after it carries the reply's words only.
  const reply = threadMessage.parse(await f.send({ text: 'Hi Maya, June 13 is open.' }));
  const delivered: string[] = [];
  const sender = createDispatchOutboundTask({
    deliver: (message) => {
      delivered.push(JSON.stringify(message));
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  await sender.run(
    { messageId: parsePublicId('message', reply.id) ?? '' },
    {
      invocation: {
        context: { ...f.b.context, actorKind: 'system', correlationId: randomUUID() },
        permissions: 'all',
      },
      services: world.services,
    },
  );
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain('June 13 is open');
  expect(delivered[0]).not.toContain('discount');

  // In the thread it is typed as a note, with no delivery fields at all.
  const thread = conversationThread.parse(
    await world.call('listConversationMessages', me, { params: f.params }),
  );
  const shown = thread.items.find((item) => item.id === note.id);
  expect(shown).toMatchObject({ kind: 'note', author: { kind: 'user', you: true } });
  expect(Object.keys(shown ?? {}).sort()).toEqual(['author', 'createdAt', 'id', 'kind', 'text']);
  // It is no one's last message, and it stays out of the log and the events.
  expect(
    JSON.stringify(conversationList.parse(await world.call('listConversations', me))),
  ).not.toContain('discount');
  expect(JSON.stringify([await f.b.events(), await f.b.audit()])).not.toContain('discount');
  // The composer's subject comes from email, never from a note.
  expect(await world.call('getConversationComposer', me, { params: f.params })).toMatchObject({
    suggestedSubject: null,
  });
  // The conversation itself is unchanged by the note: not read, not answered by it.
  expect(
    conversation.parse(await world.call('getConversation', me, { params: f.params })),
  ).toMatchObject({ unreadCount: 1, needsReply: false });
});

it('starts the composer on the channel the contact last wrote on, when a reply can go that way', async () => {
  const f = await conversationWith({ phone: '+254700000031' });
  const sms = await f.b.smsAccount();
  const withSms = createInboxRoutes({ ...world.options, smsAvailable: true });
  const suggested = async (among = withSms) =>
    conversationComposer.parse(
      await world.call('getConversationComposer', f.b.as(), { params: f.params }, among),
    ).suggestedChannel;
  /** A message from the contact on a channel, received this long after now. */
  const wrote = (channel: 'email' | 'sms', accountId: string, after: string) =>
    f.b.query(
      `insert into messaging.messages
         (business_id, conversation_id, channel, channel_account_id, direction, status,
          body_text, from_address, author_kind, author_id, created_at)
       values (app.business_id(), $1, $2, $3, 'inbound', 'received', 'Hello', $4, 'contact', $5, now() + $6::interval)`,
      [
        f.stored.conversationId,
        channel,
        accountId,
        channel === 'email' ? f.maya.email : '+254700000031',
        f.maya.id,
        after,
      ],
    );

  // She wrote by email, and email can send.
  expect(await suggested()).toBe('email');
  // Then by text: the reply starts there, though she has an email address too.
  await wrote('sms', sms.id, '1 hour');
  expect(await suggested()).toBe('sms');
  // What the team writes, and its notes, change nothing: it is her last message that counts.
  await f.send();
  await world.call('addConversationNote', f.b.as(), {
    params: f.params,
    body: { text: 'Call her after lunch.', idempotencyKey: key() },
  });
  expect(await suggested()).toBe('sms');
  // On an install that can't deliver a text, the reply starts on what can send.
  expect(await suggested(world.routes)).toBe('email');
  // So does it when her number can no longer send.
  await f.b.query("update messaging.channel_accounts set status = 'paused' where id = $1", [
    sms.id,
  ]);
  expect(await suggested()).toBe('email');
  await f.b.query("update messaging.channel_accounts set status = 'active' where id = $1", [
    sms.id,
  ]);
  // She writes by email again, later still.
  await wrote('email', f.box.id, '2 hours');
  expect(await suggested()).toBe('email');
  // With nothing that can send at all, there is nothing to suggest.
  await f.b.query("update messaging.channel_accounts set status = 'paused'");
  expect(await suggested()).toBeNull();
});
