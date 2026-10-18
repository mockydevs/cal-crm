// The Inbox thread: every channel's messages and the team's notes in one order, paged
// backwards, as plain text with attachment details and no HTML. Real Postgres.
import { randomUUID } from 'node:crypto';

import {
  conversationThread,
  MESSAGE_TEXT_MAX_LENGTH,
  THREAD_PAGE_SIZE,
  type ThreadItem,
} from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { inboxBusiness, startInbox, type InboxWorld } from '../test/inbox.js';

let world: InboxWorld;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

const key = () => randomUUID().replaceAll('-', '');

it('shows messages of every channel and notes in one order, newest first', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact({ firstName: 'Maya', lastName: 'Thompson' });
  const box = await b.mailbox({ address: 'hello@harborlights.test' });
  const sms = await b.smsAccount();
  const colleague = await world.member(b.business.id, 'Sam Lee');
  const start = Date.now() - 600_000;
  const email = await b.receive(maya, box.id, 'By email', {
    subject: 'Hello',
    at: new Date(start),
  });
  const params = { id: toPublicId('conversation', email.conversationId) };
  // A text message and a web chat message, stored as their intakes will store them.
  const other = async (channel: string, accountId: string, text: string, seconds: number) =>
    (
      await b.query<{ id: string }>(
        `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
           direction, status, body_text, author_kind, author_id, created_at)
         values (app.business_id(), $1, $2, $3, 'inbound', 'received', $4, 'contact', $5, $6)
         returning id`,
        [email.conversationId, channel, accountId, text, maya.id, new Date(start + seconds * 1000)],
      )
    )[0]?.id ?? '';
  const text = await other('sms', sms.id, 'By text', 60);
  const [widget] = await b.query<{ id: string }>(
    `insert into messaging.channel_accounts (business_id, channel, name)
     values (app.business_id(), 'webchat', 'Website chat') returning id`,
  );
  const chat = await other('webchat', widget?.id ?? '', 'By chat', 120);
  // A colleague's note, and an automated answer that replies to the first email.
  const theirs = {
    context: { ...b.context, userId: colleague.userId, actorId: colleague.userId },
    permissions: 'all' as const,
  };
  await world.call('addConversationNote', theirs, {
    params,
    body: { text: 'I called her.', idempotencyKey: key() },
  });
  const [automatic] = await b.query<{ id: string }>(
    `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
       direction, status, subject, body_text, body_html, from_address, to_addresses, cc_addresses,
       automated, parent_message_id, author_kind, author_id)
     values (app.business_id(), $1, 'email', $2, 'inbound', 'received', 'Out of office',
       'Back on Monday.', '<p>Back on <script>alert(1)</script>Monday.</p>', $3, $4, $5, true, $6,
       'contact', $7)
     returning id`,
    [
      email.conversationId,
      box.id,
      maya.email,
      ['hello@harborlights.test'],
      ['partner@example.test'],
      email.messageId,
      maya.id,
    ],
  );

  const answer = await world.call('listConversationMessages', me, { params });
  const thread = conversationThread.parse(answer);
  expect(thread.items).toMatchObject([
    {
      kind: 'message',
      id: toPublicId('message', automatic?.id ?? ''),
      channel: 'email',
      direction: 'inbound',
      subject: 'Out of office',
      text: 'Back on Monday.',
      automated: true,
      from: maya.email,
      to: ['hello@harborlights.test'],
      cc: ['partner@example.test'],
      replyTo: toPublicId('message', email.messageId),
      author: { kind: 'contact', name: 'Maya Thompson', you: false },
    },
    { kind: 'note', text: 'I called her.', author: { kind: 'user', name: 'Sam Lee', you: false } },
    {
      kind: 'message',
      id: toPublicId('message', chat),
      channel: 'webchat',
      account: { name: 'Website chat', address: null },
      text: 'By chat',
    },
    {
      kind: 'message',
      id: toPublicId('message', text),
      channel: 'sms',
      account: { id: sms.publicId, name: 'Front desk line' },
      text: 'By text',
    },
    {
      kind: 'message',
      id: toPublicId('message', email.messageId),
      channel: 'email',
      account: { id: box.publicId, address: 'hello@harborlights.test' },
      subject: 'Hello',
      text: 'By email',
      automated: false,
      replyTo: null,
    },
  ]);
  // The colleague sees their own note as theirs.
  expect(
    conversationThread.parse(await world.call('listConversationMessages', theirs, { params }))
      .items[1],
  ).toMatchObject({ kind: 'note', author: { you: true } });

  // Text only: the stored HTML of a message from outside never leaves the API.
  const sent = JSON.stringify(answer);
  expect(sent).not.toContain('<script>');
  expect(sent).not.toContain('<p>');
  for (const item of thread.items)
    expect(Object.keys(item).filter((name) => /html/i.test(name))).toEqual([]);
});

it('pages backwards through a long thread without repeating or losing a message', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact();
  const box = await b.mailbox();
  const start = Date.now() - 3_600_000;
  const first = await b.receive(maya, box.id, 'Message 1', { at: new Date(start) });
  const params = { id: toPublicId('conversation', first.conversationId) };
  const total = THREAD_PAGE_SIZE * 2 + 7;
  // Several messages share a timestamp, so the order must also hold within one instant.
  await b.query(
    `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
       direction, status, body_text, author_kind, author_id, created_at)
     select app.business_id(), $1, 'email', $2, 'inbound', 'received', 'Message ' || n,
       'contact', $3, $4::timestamptz + (n / 3) * interval '1 second'
     from generate_series(2, $5::int) as n`,
    [first.conversationId, box.id, maya.id, new Date(start), total],
  );
  const stored = await b.query<{ id: string }>(
    'select id from messaging.messages where conversation_id = $1 order by created_at desc, id desc',
    [first.conversationId],
  );
  expect(stored).toHaveLength(total);

  const pages: ThreadItem[][] = [];
  let before: string | null = null;
  do {
    const page = conversationThread.parse(
      await world.call('listConversationMessages', me, {
        params,
        query: before === null ? {} : { before },
      }),
    );
    pages.push(page.items);
    before = page.nextCursor;
  } while (before !== null && pages.length < 10);
  expect(pages.map((page) => page.length)).toEqual([THREAD_PAGE_SIZE, THREAD_PAGE_SIZE, 7]);
  expect(pages.flat().map((item) => item.id)).toEqual(
    stored.map((row) => toPublicId('message', row.id)),
  );

  // A message that arrives while someone reads back does not shift the older pages.
  const cursor = conversationThread.parse(
    await world.call('listConversationMessages', me, { params }),
  ).nextCursor;
  await b.receive(maya, box.id, 'Just arrived');
  const older = conversationThread.parse(
    await world.call('listConversationMessages', me, { params, query: { before: cursor ?? '' } }),
  );
  expect(older.items.map((item) => item.id)).toEqual(pages[1]?.map((item) => item.id));
});

it('cuts a very long message at the documented bound and says so', async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact();
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'x'.repeat(MESSAGE_TEXT_MAX_LENGTH + 500));
  const exact = await b.receive(maya, box.id, 'y'.repeat(MESSAGE_TEXT_MAX_LENGTH));
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const thread = conversationThread.parse(
    await world.call('listConversationMessages', me, { params }),
  );
  const shown = (id: string) => {
    const item = thread.items.find((each) => each.id === toPublicId('message', id));
    return item?.kind === 'message' ? item : undefined;
  };
  expect(shown(stored.messageId)?.text).toHaveLength(MESSAGE_TEXT_MAX_LENGTH);
  expect(shown(stored.messageId)?.textTruncated).toBe(true);
  expect(shown(exact.messageId)?.text).toHaveLength(MESSAGE_TEXT_MAX_LENGTH);
  expect(shown(exact.messageId)?.textTruncated).toBe(false);
});

it("lists a message's attachments by name, type and size, without their contents", async () => {
  const b = await inboxBusiness(world);
  const me = b.as();
  const maya = await b.contact();
  const box = await b.mailbox();
  const stored = await b.receive(maya, box.id, 'Photos attached');
  const params = { id: toPublicId('conversation', stored.conversationId) };
  const file = async (name: string, type: string, size: number, deleted = false) =>
    (
      await b.query<{ id: string }>(
        `insert into files.files (agency_id, business_id, storage, storage_key, filename,
           content_type, size_bytes, sha256, uploaded_by_kind, deleted_at)
         values (app.agency_id(), app.business_id(), 'local', $1, $2, $3, $4,
           sha256(convert_to($1, 'UTF8')), 'contact', case when $5 then now() end)
         returning id`,
        [`inbox/${randomUUID()}`, name, type, size, deleted],
      )
    )[0]?.id ?? '';
  const attach = (fileId: string, contentId: string | null) =>
    b.query(
      `insert into messaging.message_attachments (business_id, message_id, file_id, content_id)
       values (app.business_id(), $1, $2, $3)`,
      [stored.messageId, fileId, contentId],
    );
  const venue = await file('venue.pdf', 'application/pdf', 48_213);
  const logo = await file('logo.png', 'image/png', 912);
  const removed = await file('old.txt', 'text/plain', 5, true);
  await attach(venue, null);
  await attach(logo, 'logo@harborlights');
  await attach(removed, null);

  const thread = conversationThread.parse(
    await world.call('listConversationMessages', me, { params }),
  );
  expect(thread.items).toMatchObject([
    {
      kind: 'message',
      attachments: [
        {
          id: toPublicId('file', venue),
          name: 'venue.pdf',
          contentType: 'application/pdf',
          sizeBytes: 48_213,
          inline: false,
        },
        {
          id: toPublicId('file', logo),
          name: 'logo.png',
          contentType: 'image/png',
          sizeBytes: 912,
          inline: true,
        },
      ],
    },
  ]);
  // Where a file is kept is the files module's to give out, with its own checks.
  expect(JSON.stringify(thread)).not.toContain('inbox/');
});
