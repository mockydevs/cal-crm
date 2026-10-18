// The Inbox's database side (migration 0046): message numbers given under the
// conversation's lock, an unread count and a needs-reply flag no writer can get wrong,
// notes that can't be delivered, and a refetch hint for every stored or changed message.
// What the migration does to rows stored before it is in inbox-backfill.int.test.ts.
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

interface Business {
  readonly context: TenantContext;
  readonly mailboxId: string;
  readonly contactId: string;
  readonly identityId: string;
}

let database: TestDatabase;

async function businessWithMailbox(): Promise<Business> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(context, { email: 'maya@example.test' });
  return database.withTenant(context, async (sql) => {
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values (app.agency_id(), app.business_id(), 'mailbox.credentials', 1,
               decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')) returning id`,
    );
    const channel = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id, channel, name) values (app.business_id(), 'email', 'Inbox') returning id",
    );
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
         smtp_port, smtp_security, smtp_username, secret_id)
       values (app.business_id(), $1, 'inbox@example.test', 'password', 'smtp.example.test', 465,
         'tls', 'inbox@example.test', $2)`,
      [channel.id, secret.id],
    );
    const identity = await sql.one<{ id: string }>(
      'select id from crm.contact_identities where contact_id = $1',
      [contact.id],
    );
    return { context, mailboxId: channel.id, contactId: contact.id, identityId: identity.id };
  });
}

const anotherContact = (b: Business) =>
  database.fixtures.contact(b.context, { email: `${randomUUID().slice(0, 8)}@example.test` });

const conversation = async (sql: Sql, contactId: string, unread = 0): Promise<string> =>
  (
    await sql.one<{ id: string }>(
      `insert into messaging.conversations (business_id, contact_id, unread_count)
       values (app.business_id(), $1, $2) returning id`,
      [contactId, unread],
    )
  ).id;

const inbound = async (sql: Sql, b: Business, conversationId: string): Promise<string> =>
  (
    await sql.one<{ id: string }>(
      `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
         direction, status, body_text, author_kind)
       values (app.business_id(), $1, 'email', $2, 'inbound', 'received', 'Hello', 'contact')
       returning id`,
      [conversationId, b.mailboxId],
    )
  ).id;

const outbound = async (
  sql: Sql,
  b: Business,
  conversationId: string,
  status = 'queued',
): Promise<string> =>
  (
    await sql.one<{ id: string }>(
      `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
         direction, status, body_text, idempotency_key, author_kind)
       values (app.business_id(), $1, 'email', $2, 'outbound', $3, 'Hi', $4, 'user')
       returning id`,
      [conversationId, b.mailboxId, status, randomUUID()],
    )
  ).id;

const note = async (sql: Sql, conversationId: string): Promise<string> =>
  (
    await sql.one<{ id: string }>(
      `insert into messaging.messages (business_id, conversation_id, channel, direction, status,
         body_text, author_kind)
       values (app.business_id(), $1, 'note', 'internal', 'note', 'Call her back', 'user')
       returning id`,
      [conversationId],
    )
  ).id;

interface Summary {
  message_seq: string;
  read_through_seq: string;
  unread_count: number;
  needs_reply: boolean;
}
const summary = (b: Business, conversationId: string) =>
  database.withTenant(b.context, (sql) =>
    sql.one<Summary>(
      `select message_seq, read_through_seq, unread_count, needs_reply
       from messaging.conversations where id = $1`,
      [conversationId],
    ),
  );

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

it('numbers each new message in its conversation, whatever the writer asks for', async () => {
  const b = await businessWithMailbox();
  const other = await anotherContact(b);
  const rows = await database.withTenant(b.context, async (sql) => {
    const first = await conversation(sql, b.contactId);
    const second = await conversation(sql, other.id);
    await inbound(sql, b, first);
    await inbound(sql, b, second);
    await note(sql, first);
    await sql.query(
      `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
         direction, status, body_text, author_kind, seq)
       values (app.business_id(), $1, 'email', $2, 'inbound', 'received', 'Forged', 'contact', 999)`,
      [first, b.mailboxId],
    );
    return sql.query<{ conversation_id: string; seq: string }>(
      'select conversation_id, seq from messaging.messages order by conversation_id, seq',
    );
  });
  const byConversation = Map.groupBy(rows, (row) => row.conversation_id);
  expect([...byConversation.values()].map((each) => each.map((row) => row.seq)).sort()).toEqual([
    ['1'],
    ['1', '2', '3'],
  ]);
});

it('gives numbers in the order writers hold the conversation, not the order they began', async () => {
  const b = await businessWithMailbox();
  const conversationId = await database.withTenant(b.context, (sql) =>
    conversation(sql, b.contactId),
  );
  let second: Promise<string> | undefined;
  const first = await database.withTenant(b.context, async (sql) => {
    const id = await inbound(sql, b, conversationId);
    const [owner] = await sql.query<{ pid: number }>('select pg_backend_pid() as pid');
    // Started while the first is uncommitted: it waits for the conversation's row.
    second = database.withTenant({ ...b.context, correlationId: randomUUID() }, (other) =>
      inbound(other, b, conversationId),
    );
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await database.as('postgres', (admin) =>
        admin.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and $1 = any(pg_blocking_pids(pid))`,
          [owner?.pid ?? 0],
        ),
      );
      if ((row?.n ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error('The second writer never waited on the lock.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return id;
  });
  if (second === undefined) throw new Error('The second writer never started.');
  const later = await second;
  expect(
    await database.withTenant(b.context, (sql) =>
      sql.query('select id, seq from messaging.messages order by seq'),
    ),
  ).toEqual([
    { id: first, seq: '1' },
    { id: later, seq: '2' },
  ]);
  expect(await summary(b, conversationId)).toMatchObject({ message_seq: '2', unread_count: 2 });
});

it('derives unread and needs reply from the messages, and ignores what a writer sets', async () => {
  const b = await businessWithMailbox();
  const id = await database.withTenant(b.context, (sql) => conversation(sql, b.contactId));
  const step = (work: (sql: Sql) => Promise<unknown>) => database.withTenant(b.context, work);
  expect(await summary(b, id)).toMatchObject({ unread_count: 0, needs_reply: false });

  await step((sql) => inbound(sql, b, id));
  expect(await summary(b, id)).toMatchObject({ unread_count: 1, needs_reply: true });

  // A writer's own arithmetic, as inbound.ts does it, changes nothing.
  await step((sql) =>
    sql.query(
      'update messaging.conversations set unread_count = unread_count + 1, needs_reply = true where id = $1',
      [id],
    ),
  );
  expect(await summary(b, id)).toMatchObject({ unread_count: 1, needs_reply: true });
  await step((sql) =>
    sql.query(
      'update messaging.conversations set unread_count = 0, needs_reply = false where id = $1',
      [id],
    ),
  );
  expect(await summary(b, id)).toMatchObject({ unread_count: 1, needs_reply: true });

  // A note is the team's own: the contact still waits, and nothing more is unread.
  await step((sql) => note(sql, id));
  expect(await summary(b, id)).toMatchObject({ unread_count: 1, needs_reply: true });

  // A queued reply answers; when it then fails, the contact waits again.
  const reply = await step((sql) => outbound(sql, b, id));
  expect(await summary(b, id)).toMatchObject({ unread_count: 1, needs_reply: false });
  for (const [status, waiting] of [
    ['sending', false],
    ['sent', false],
    ['failed', true],
    ['bounced', true],
    ['unknown', true],
    ['delivered', false],
  ] as const) {
    await step((sql) =>
      sql.query('update messaging.messages set status = $2 where id = $1', [reply, status]),
    );
    expect(await summary(b, id), status).toMatchObject({ unread_count: 1, needs_reply: waiting });
  }

  // Read through the first message: a later one from the contact is unread again.
  await step((sql) =>
    sql.query('update messaging.conversations set read_through_seq = 1 where id = $1', [id]),
  );
  expect(await summary(b, id)).toMatchObject({ unread_count: 0, needs_reply: false });
  await step((sql) => inbound(sql, b, id));
  expect(await summary(b, id)).toMatchObject({ unread_count: 1, needs_reply: true });
});

it('moves the conversation to the time of its latest message, but not for a note', async () => {
  const b = await businessWithMailbox();
  const id = await database.withTenant(b.context, (sql) => conversation(sql, b.contactId));
  const lastMessageAt = async () =>
    (
      await database.withTenant(b.context, (sql) =>
        sql.one<{ at: Date | null }>(
          'select last_message_at as at from messaging.conversations where id = $1',
          [id],
        ),
      )
    ).at;
  expect(await lastMessageAt()).toBeNull();
  await database.withTenant(b.context, (sql) => note(sql, id));
  expect(await lastMessageAt()).toBeNull();
  const sent = await database.withTenant(b.context, async (sql) => {
    const messageId = await outbound(sql, b, id);
    return sql.one<{ created_at: Date }>(
      'select created_at from messaging.messages where id = $1',
      [messageId],
    );
  });
  expect(await lastMessageAt()).toEqual(sent.created_at);
});

it('refuses a read position outside the conversation', async () => {
  const b = await businessWithMailbox();
  const id = await database.withTenant(b.context, async (sql) => {
    const created = await conversation(sql, b.contactId);
    await inbound(sql, b, created);
    return created;
  });
  for (const position of [2, -1])
    await expect(
      database.withTenant(b.context, (sql) =>
        sql.query('update messaging.conversations set read_through_seq = $2 where id = $1', [
          id,
          position,
        ]),
      ),
      String(position),
    ).rejects.toMatchObject({ code: '23514' });
});

it('gives a note nothing a delivery needs', async () => {
  const b = await businessWithMailbox();
  const id = await database.withTenant(b.context, (sql) => conversation(sql, b.contactId));
  const refused = async (columns: string, values: string, parameters: readonly unknown[] = []) =>
    expect(
      database.withTenant(b.context, (sql) =>
        sql.query(
          `insert into messaging.messages (business_id, conversation_id, channel, direction,
             body_text, author_kind, ${columns})
           values (app.business_id(), $1, 'note', 'internal', 'Private', 'user', ${values})`,
          [id, ...parameters],
        ),
      ),
      columns,
    ).rejects.toMatchObject({ code: '23514' });
  // Every status a delivery uses is refused for a note, 'queued' above all.
  for (const status of ['queued', 'sending', 'sent', 'delivered', 'failed', 'unknown'])
    await refused('status', '$2', [status]);
  await refused('status, channel_account_id', "'note', $2", [b.mailboxId]);
  await refused('status, to_addresses', "'note', $2", [['maya@example.test']]);
  await refused('status, cc_addresses', "'note', $2", [['maya@example.test']]);
  await refused('status, bcc_addresses', "'note', $2", [['maya@example.test']]);
  await refused('status, scheduled_for', "'note', now()");
  await refused('status, subject', "'note', 'Hello'");
  await refused('status, body_html', "'note', '<p>Hello</p>'");
  // A retry key is all a note may carry besides its words: it leads nowhere by itself.
  await database.withTenant(b.context, (sql) =>
    sql.query(
      `insert into messaging.messages (business_id, conversation_id, channel, direction, status,
         body_text, author_kind, idempotency_key)
       values (app.business_id(), $1, 'note', 'internal', 'note', 'Private', 'user', $2)`,
      [id, `inbox-note:${randomUUID()}`],
    ),
  );
  // And nothing that isn't a note can call itself one.
  await expect(
    database.withTenant(b.context, (sql) =>
      sql.query(
        `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
           direction, status, body_text, idempotency_key, author_kind)
         values (app.business_id(), $1, 'email', $2, 'outbound', 'note', 'Hi', $3, 'user')`,
        [id, b.mailboxId, randomUUID()],
      ),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

it('never lets a note, or a message from the contact, into the outbound pipeline', async () => {
  const b = await businessWithMailbox();
  const ids = await database.withTenant(b.context, async (sql) => {
    const id = await conversation(sql, b.contactId);
    return {
      note: await note(sql, id),
      inbound: await inbound(sql, b, id),
      outbound: await outbound(sql, b, id),
    };
  });
  const dispatch = (messageId: string) =>
    database.withTenant(b.context, (sql) =>
      sql.query(
        `insert into messaging.outbound_dispatch (business_id, id, identity_id, purpose, lane, request_hash)
         values (app.business_id(), $1, $2, 'transactional', 'reply', repeat('a', 64))`,
        [messageId, b.identityId],
      ),
    );
  // No dispatch row: the foreign key needs an outbound message.
  await expect(dispatch(ids.note)).rejects.toMatchObject({ code: '23503' });
  await expect(dispatch(ids.inbound)).rejects.toMatchObject({ code: '23503' });
  await expect(
    database.withTenant(b.context, (sql) =>
      sql.query(
        `insert into messaging.outbound_dispatch
           (business_id, id, identity_id, purpose, lane, request_hash, direction)
         values (app.business_id(), $1, $2, 'transactional', 'reply', repeat('a', 64), 'internal')`,
        [ids.note, b.identityId],
      ),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  // No job: the queue function takes only a queued outbound message with a dispatch row.
  for (const id of [ids.note, ids.inbound])
    await expect(
      database.withTenant(b.context, (sql) =>
        sql.query('select private.enqueue_outbound($1)', [id]),
      ),
    ).rejects.toThrow(/outbound message is not available/);
  // A message with a dispatch row can't be turned into anything else.
  await dispatch(ids.outbound);
  await expect(
    database.withTenant(b.context, (sql) =>
      sql.query(
        `update messaging.messages set direction = 'inbound', status = 'received' where id = $1`,
        [ids.outbound],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
  expect(await database.runJobs(['messaging.dispatch'])).toEqual([]);
});

it('tells the business to refetch when a message is stored or its status changes', async () => {
  const b = await businessWithMailbox();
  const listener = new pg.Client({ connectionString: database.url('crm_app') });
  const heard: string[] = [];
  listener.on('notification', (notification) => {
    if (notification.channel === 'crm_business_changed') heard.push(notification.payload ?? '');
  });
  await listener.connect();
  try {
    await listener.query('listen crm_business_changed');
    // Notifications arrive in commit order, so once a marker sent afterwards is heard,
    // everything the work caused has been heard too.
    const settled = async (): Promise<string[]> => {
      const marker = randomUUID();
      await database.as('postgres', (sql) =>
        sql.query("select pg_notify('crm_business_changed', $1)", [marker]),
      );
      await expect.poll(() => heard, { timeout: 10_000 }).toContain(marker);
      return [...new Set(heard.splice(0))].filter((payload) => payload !== marker);
    };
    const heardFrom = async (work: (sql: Sql) => Promise<unknown>) => {
      await database.withTenant(b.context, work);
      return settled();
    };
    const businessId = b.context.businessId;
    let conversationId = '';
    let messageId = '';
    expect(
      await heardFrom(async (sql) => {
        conversationId = await conversation(sql, b.contactId);
      }),
    ).toEqual([]);
    expect(
      await heardFrom(async (sql) => {
        messageId = await outbound(sql, b, conversationId);
      }),
    ).toEqual([businessId]);
    // The worker's dispatch changes a status outside any command.
    expect(
      await heardFrom((sql) =>
        sql.query("update messaging.messages set status = 'sent' where id = $1", [messageId]),
      ),
    ).toEqual([businessId]);
    expect(await heardFrom((sql) => note(sql, conversationId))).toEqual([businessId]);
    // Nothing is said when nothing a dashboard shows changed, or when the change rolls back.
    expect(
      await heardFrom((sql) =>
        sql.query("update messaging.messages set error_detail = 'x' where id = $1", [messageId]),
      ),
    ).toEqual([]);
    await expect(
      database.withTenant(b.context, async (sql) => {
        await inbound(sql, b, conversationId);
        throw new Error('Rollback fixture');
      }),
    ).rejects.toThrow('Rollback fixture');
    expect(await settled()).toEqual([]);
  } finally {
    await listener.end();
  }
});

it("keeps another business's conversations and messages out of reach", async () => {
  const ours = await businessWithMailbox();
  const theirs = await businessWithMailbox();
  const theirConversation = await database.withTenant(theirs.context, async (sql) => {
    const id = await conversation(sql, theirs.contactId);
    await inbound(sql, theirs, id);
    return id;
  });
  // A message can't be stored in a conversation the writer can't see.
  await expect(
    database.withTenant(ours.context, (sql) => inbound(sql, ours, theirConversation)),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    database.withTenant(ours.context, (sql) => note(sql, theirConversation)),
  ).rejects.toMatchObject({ code: '23503' });
  expect(
    await database.withTenant(ours.context, (sql) =>
      sql.query(
        'update messaging.conversations set read_through_seq = 1 where id = $1 returning id',
        [theirConversation],
      ),
    ),
  ).toEqual([]);
  expect(await summary(theirs, theirConversation)).toEqual({
    message_seq: '1',
    read_through_seq: '0',
    unread_count: 1,
    needs_reply: true,
  });
});
