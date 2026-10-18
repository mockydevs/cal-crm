// A re-sync creates no duplicates, replies thread correctly,
// and unknown senders become new contacts, against a real TLS IMAP server (GreenMail).
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ForbiddenError, type TenantContext } from '@repo/kernel';
import { createMailboxConnector, parseInboundMessage } from '@repo/mail';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import {
  startGreenMail,
  testDatabase,
  type GreenMailServer,
  type TestDatabase,
} from '@repo/testing';
import { ImapFlow } from 'imapflow';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, inject, it } from 'vitest';

import {
  createDispatchOutboundTask,
  createSyncMailboxTask,
  ingestInboundCommand,
  queueOutboundMessage,
  scheduleMailboxSyncs,
} from './index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let vault: Vault;
let server: GreenMailServer;
let stopMail: (() => Promise<void>) | undefined;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  ({ server, stop: stopMail } = await startGreenMail());
});
afterAll(async () => {
  await stopMail?.();
  await db.destroy();
  await database.close();
});

async function withImap<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: server.address,
    port: server.imapPort,
    secure: true,
    servername: 'localhost',
    tls: { ca: server.ca, rejectUnauthorized: true },
    auth: { user: server.username, pass: server.password },
    logger: false,
    disableAutoIdle: true,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    client.close();
  }
}

beforeEach(async () => {
  await withImap(async (client) => {
    await client.mailboxOpen('INBOX');
    await client.messageDelete('1:*', { uid: true });
  });
});

async function append(...sources: string[]): Promise<void> {
  await withImap(async (client) => {
    for (const source of sources)
      expect(await client.append('INBOX', Buffer.from(source))).not.toBe(false);
  });
}

const reader = () =>
  createMailboxConnector({
    ca: server.ca,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([server.address]),
    timeoutMs: 30_000,
  });

interface Fixture {
  readonly context: TenantContext;
  readonly mailboxId: string;
  sync(): Promise<void>;
  rows<T extends object>(query: string, values?: readonly unknown[]): Promise<T[]>;
}

async function fixture(): Promise<Fixture> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const login = {
    host: 'localhost',
    port: server.imapPort,
    security: 'tls',
    username: server.username,
    password: server.password,
  };
  const input = {
    name: 'Inbox',
    email: 'inbox@example.test',
    displayName: 'Inbox',
    smtp: { ...login, port: server.smtpPort },
    imap: login,
  };
  const mailboxId = await withTenant(db, context, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
      JSON.stringify(input),
    );
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: business.id, channel: 'email', name: input.name })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.mailboxes')
      .values({
        business_id: business.id,
        id: account.id,
        email_address: input.email,
        auth_method: 'password',
        smtp_host: 'localhost',
        smtp_port: server.smtpPort,
        smtp_security: 'tls',
        smtp_username: server.username,
        imap_host: 'localhost',
        imap_port: server.imapPort,
        imap_security: 'tls',
        imap_username: server.username,
        secret_id: secretId,
      })
      .execute();
    return account.id;
  });
  const task = createSyncMailboxTask(vault, reader());
  const sync = () =>
    task.run(
      { mailboxId },
      {
        invocation: { context: { ...context, correlationId: randomUUID() }, permissions: 'all' },
        services,
      },
    );
  // The first sync only marks where the inbox ends: mail before connection isn't read.
  await sync();
  return {
    context,
    mailboxId,
    sync,
    rows: <T extends object>(query: string, values: readonly unknown[] = []) =>
      database.withTenant(context, (client) => client.query<T>(query, values)),
  };
}

const message = (headers: Record<string, string>, body = 'Hello.') =>
  [
    ...Object.entries({ To: 'inbox@example.test', Subject: 'Hello', ...headers }).map(
      ([key, value]) => `${key}: ${value}`,
    ),
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');

const id = () => `<${randomUUID()}@sender.example.test>`;

it('turns unknown senders into contacts, stores their mail once, and leaves it unread on the server', async () => {
  const f = await fixture();
  const known = await database.fixtures.contact(f.context, { email: 'known@example.test' });
  await append(
    message(
      { From: '"Ada Lovelace" <Ada@Example.test>', 'Message-ID': id() },
      'First private body',
    ),
    message({ From: 'known@example.test', 'Message-ID': id() }),
    message({ From: 'ada@example.test' }, 'No Message-ID here'),
  );
  await f.sync();

  const contacts = await f.rows<{
    contact_id: string;
    first_name: string | null;
    last_name: string | null;
  }>(
    `select i.contact_id, c.first_name, c.last_name from crm.contact_identities i
     join crm.contacts c on c.id = i.contact_id where i.value_normalized = 'ada@example.test'`,
  );
  expect(contacts).toEqual([
    { contact_id: expect.any(String) as string, first_name: 'Ada', last_name: 'Lovelace' },
  ]);
  const ada = contacts[0]?.contact_id;
  const stored = await f.rows<{ author_id: string; body_text: string; contact_id: string }>(
    `select m.author_id, m.body_text, c.contact_id from messaging.messages m
     join messaging.conversations c on c.id = m.conversation_id order by m.body_text`,
  );
  expect(stored).toEqual([
    { author_id: ada, body_text: 'First private body', contact_id: ada },
    { author_id: known.id, body_text: 'Hello.', contact_id: known.id },
    { author_id: ada, body_text: 'No Message-ID here', contact_id: ada },
  ]);
  expect(
    await f.rows(
      'select unread_count, needs_reply, status from messaging.conversations where contact_id = $1',
      [ada],
    ),
  ).toEqual([{ unread_count: 2, needs_reply: true, status: 'open' }]);
  expect(await f.rows('select outcome from messaging.mailbox_inbound_uids order by uid')).toEqual([
    { outcome: 'stored' },
    { outcome: 'stored' },
    { outcome: 'stored' },
  ]);
  // No consent is granted for anyone who writes in.
  expect(await f.rows('select id from messaging.consents')).toEqual([]);
  // The audit keeps identifiers only: no addresses, headers or bodies.
  const audits = await database.as('crm_owner', (client) =>
    client.query<{ input: unknown }>(
      "select input from audit.commands where business_id = $1 and command = 'mailbox.ingest_inbound'",
      [f.context.businessId],
    ),
  );
  // The baseline sync at connection, then the one that read the mail.
  expect(audits).toHaveLength(2);
  expect(JSON.stringify(audits)).not.toMatch(/ada@|private body|Lovelace/i);
  const seen = await withImap(async (client) => {
    await client.mailboxOpen('INBOX', { readOnly: true });
    return (await client.fetchAll('1:*', { flags: true })).map((each) => [...(each.flags ?? [])]);
  });
  expect(seen.flat()).not.toContain('\\Seen');
});

it('says of a contact it makes that it came from mail', async () => {
  const f = await fixture();
  await append(message({ From: 'new.sender@example.test', 'Message-ID': id() }));
  await f.sync();
  expect(await f.rows('select created_by_kind, created_source from crm.contacts')).toEqual([
    { created_by_kind: 'system', created_source: 'email' },
  ]);
  expect(
    await f.rows(
      "select payload->>'channel' as channel from events.events where type='message.received'",
    ),
  ).toEqual([{ channel: 'email' }]);
});

it('files mail from a contact’s additional address under that contact, and makes no new one', async () => {
  const f = await fixture();
  const known = await database.fixtures.contact(f.context, { email: 'first@example.test' });
  // A second address that is not the primary one, as the contact page adds it.
  await f.rows(
    `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
     values (app.business_id(), $1, 'email', 'second@example.test', 'second@example.test')`,
    [known.id],
  );
  await append(
    message({ From: 'SECOND@Example.test', 'Message-ID': id() }, 'From my other address'),
  );
  await f.sync();

  expect(
    await f.rows(
      `select c.contact_id, m.from_address, m.author_id from messaging.messages m
       join messaging.conversations c on c.id = m.conversation_id`,
    ),
  ).toEqual([{ contact_id: known.id, from_address: 'second@example.test', author_id: known.id }]);
  expect(await f.rows('select id from crm.contacts')).toHaveLength(1);
  expect(await f.rows('select id from crm.contact_identities')).toHaveLength(2);
});

it('creates no duplicates on a re-sync, a rewound cursor, or a UIDVALIDITY reset', async () => {
  const f = await fixture();
  await append(
    message({ From: 'b@example.test', 'Message-ID': id() }),
    message({ From: 'b@example.test' }, 'No id'),
  );
  await f.sync();
  await f.sync();
  const count = () => f.rows('select count(*)::int as n from messaging.messages');
  expect(await count()).toEqual([{ n: 2 }]);

  await database.as('crm_owner', (client) =>
    client.query('update messaging.mailboxes set imap_last_uid = 0 where id = $1', [f.mailboxId]),
  );
  await f.sync();
  expect(await count()).toEqual([{ n: 2 }]);

  // Pretend the earlier reads were under another UIDVALIDITY: the server's own now looks new.
  await database.as('crm_owner', async (client) => {
    await client.query('update messaging.mailbox_inbound_uids set uid_validity = uid_validity + 1');
    await client.query(
      'update messaging.mailboxes set imap_uid_validity = imap_uid_validity + 1, imap_last_uid = 2 where id = $1',
      [f.mailboxId],
    );
  });
  await f.sync();
  expect(await count()).toEqual([{ n: 2 }]);
  expect(
    await f.rows(
      'select outcome from messaging.mailbox_inbound_uids where uid_validity = (select imap_uid_validity from messaging.mailboxes) order by uid',
    ),
  ).toEqual([{ outcome: 'duplicate' }, { outcome: 'duplicate' }]);
});

it('threads replies to the stored message they answer, within the sender’s own conversation only', async () => {
  const f = await fixture();
  const contact = await database.fixtures.contact(f.context, { email: 'grace@example.test' });
  const outbound = await withTenant(db, f.context, async (trx) => {
    const conversation = await trx
      .insertInto('messaging.conversations')
      .values({ business_id: f.context.businessId ?? '', contact_id: contact.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    return trx
      .insertInto('messaging.messages')
      .values({
        business_id: f.context.businessId ?? '',
        conversation_id: conversation.id,
        channel: 'email',
        channel_account_id: f.mailboxId,
        direction: 'outbound',
        status: 'sent',
        subject: 'Proposal',
        idempotency_key: randomUUID(),
        author_kind: 'user',
      })
      .returning(['id', 'conversation_id'])
      .executeTakeFirstOrThrow();
  });
  const ourId = `<crm-outbound.${outbound.id}@crm.invalid>`;
  const firstReply = id();
  await append(
    message({
      From: 'grace@example.test',
      'Message-ID': firstReply,
      'In-Reply-To': ourId,
      References: ourId,
    }),
    message({
      From: 'grace@example.test',
      'Message-ID': id(),
      'In-Reply-To': firstReply,
      References: `${ourId} ${firstReply}`,
    }),
    // Someone else quoting Grace's thread stays in their own conversation, unparented.
    message({
      From: 'mallory@example.test',
      'Message-ID': id(),
      'In-Reply-To': ourId,
      References: ourId,
    }),
  );
  await f.sync();
  const rows = await f.rows<{
    from_address: string;
    parent_message_id: string | null;
    conversation_id: string;
  }>(
    `select from_address, parent_message_id, conversation_id from messaging.messages
     where direction = 'inbound' order by created_at, id`,
  );
  const [first, second, other] = rows;
  expect(first).toMatchObject({
    parent_message_id: outbound.id,
    conversation_id: outbound.conversation_id,
  });
  expect(second).toMatchObject({ conversation_id: outbound.conversation_id });
  const [stored] = await f.rows<{ id: string }>(
    'select id from messaging.messages where email_message_id = $1',
    [firstReply],
  );
  expect(second?.parent_message_id).toBe(stored?.id);
  expect(other).toMatchObject({ from_address: 'mallory@example.test', parent_message_id: null });
  expect(other?.conversation_id).not.toBe(outbound.conversation_id);
});

it('files a reply from the plain form of a tagged address with the contact we wrote to', async () => {
  const f = await fixture();
  // Two contacts whose addresses reach one mailbox: ada herself, and a sign-up with a tag.
  const plain = await database.fixtures.contact(f.context, { email: 'ada@example.test' });
  const tagged = await database.fixtures.contact(f.context, { email: 'ada+shop@example.test' });
  const outbound = await withTenant(db, f.context, async (trx) => {
    const conversation = await trx
      .insertInto('messaging.conversations')
      .values({ business_id: f.context.businessId ?? '', contact_id: tagged.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    return trx
      .insertInto('messaging.messages')
      .values({
        business_id: f.context.businessId ?? '',
        conversation_id: conversation.id,
        channel: 'email',
        channel_account_id: f.mailboxId,
        direction: 'outbound',
        status: 'sent',
        subject: 'Your order',
        to_addresses: ['ada+shop@example.test'],
        idempotency_key: randomUUID(),
        author_kind: 'user',
      })
      .returning(['id', 'conversation_id'])
      .executeTakeFirstOrThrow();
  });
  const ourId = `<crm-outbound.${outbound.id}@crm.invalid>`;
  await append(
    // Her mail program answers from the plain address.
    message({
      From: 'Ada@Example.test',
      'Message-ID': id(),
      'In-Reply-To': ourId,
      References: ourId,
    }),
    // Mail of hers that answers nothing of ours stays with the plain contact.
    message({ From: 'ada@example.test', 'Message-ID': id() }),
    // A different mailbox quoting the thread is not her: its own conversation, unparented.
    message({
      From: 'adam@example.test',
      'Message-ID': id(),
      'In-Reply-To': ourId,
      References: ourId,
    }),
  );
  await f.sync();
  const rows = await f.rows<{
    from_address: string;
    parent_message_id: string | null;
    conversation_id: string;
    author_id: string;
  }>(
    `select from_address, parent_message_id, conversation_id, author_id from messaging.messages
     where direction = 'inbound' order by created_at, id`,
  );
  const [reply, fresh, other] = rows;
  expect(reply).toMatchObject({
    from_address: 'ada@example.test',
    parent_message_id: outbound.id,
    conversation_id: outbound.conversation_id,
    author_id: tagged.id,
  });
  expect(fresh).toMatchObject({ parent_message_id: null, author_id: plain.id });
  expect(fresh?.conversation_id).not.toBe(outbound.conversation_id);
  expect(other).toMatchObject({ from_address: 'adam@example.test', parent_message_id: null });
  expect(other?.conversation_id).not.toBe(outbound.conversation_id);
});

it('records mail it won’t store without creating contacts, and keeps reading after it', async () => {
  const f = await fixture();
  const ourMessage = await withTenant(db, f.context, async (trx) => {
    const contact = await database.fixtures.contact(f.context, { email: 'someone@example.test' });
    const conversation = await trx
      .insertInto('messaging.conversations')
      .values({ business_id: f.context.businessId ?? '', contact_id: contact.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    return trx
      .insertInto('messaging.messages')
      .values({
        business_id: f.context.businessId ?? '',
        conversation_id: conversation.id,
        channel: 'email',
        channel_account_id: f.mailboxId,
        direction: 'outbound',
        status: 'sent',
        idempotency_key: randomUUID(),
        author_kind: 'user',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  });
  const attachments = Array.from(
    { length: 101 },
    (_, i) =>
      `--m\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="f${String(i)}"\r\n\r\nx`,
  ).join('\r\n');
  await append(
    message({
      From: 'inbox@example.test',
      'Message-ID': `<crm-outbound.${ourMessage.id}@crm.invalid>`,
    }),
    message({ From: 'inbox@example.test', 'Message-ID': id() }),
    message({ From: 'a@example.test, b@example.test', 'Message-ID': id() }),
    [
      'From: Mail Delivery System <mailer-daemon@example.test>',
      `Message-ID: ${id()}`,
      'Content-Type: multipart/report; report-type=delivery-status; boundary="r"',
      '',
      '--r',
      'Content-Type: message/delivery-status',
      '',
      'Final-Recipient: rfc822; gone@example.test',
      'Action: failed',
      'Status: 5.1.1',
      '--r--',
      '',
    ].join('\r\n'),
    [
      'From: big@example.test',
      `Message-ID: ${id()}`,
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      attachments,
      '--m--',
      '',
    ].join('\r\n'),
    message({
      From: 'Robot <noreply@example.test>',
      'Message-ID': id(),
      'Auto-Submitted': 'auto-generated',
    }),
  );
  await f.sync();
  expect(
    await f.rows<{ outcome: string; reason: string | null }>(
      'select outcome, reason from messaging.mailbox_inbound_uids order by uid',
    ),
  ).toEqual([
    { outcome: 'own_message', reason: null },
    { outcome: 'sender_is_mailbox', reason: null },
    { outcome: 'sender_unresolved', reason: null },
    { outcome: 'delivery_report', reason: null },
    { outcome: 'refused', reason: 'too_many_attachments' },
    { outcome: 'stored', reason: null },
  ]);
  expect(
    await f.rows(
      "select value_normalized from crm.contact_identities where kind = 'email' order by 1",
    ),
  ).toEqual([
    { value_normalized: 'noreply@example.test' },
    { value_normalized: 'someone@example.test' },
  ]);
  expect(
    await f.rows("select automated from messaging.messages where direction = 'inbound'"),
  ).toEqual([{ automated: true }]);
});

it('applies one of two overlapping runs, and creates each sender once', async () => {
  const f = await fixture();
  await append(
    message({ From: 'c@example.test', 'Message-ID': id() }),
    message({ From: 'c@example.test', 'Message-ID': id() }),
  );
  await Promise.all([f.sync(), f.sync()]);
  expect(await f.rows('select count(*)::int as n from messaging.messages')).toEqual([{ n: 2 }]);
  expect(
    await f.rows(
      "select count(*)::int as n from crm.contact_identities where value_normalized = 'c@example.test'",
    ),
  ).toEqual([{ n: 1 }]);
});

it('reads nothing for an inactive mailbox or another business, and only the system may ingest', async () => {
  const f = await fixture();
  const other = await fixture();
  await append(message({ From: 'd@example.test', 'Message-ID': id() }));
  // A job naming another business's mailbox finds nothing in its own tenant.
  await createSyncMailboxTask(vault, reader()).run(
    { mailboxId: f.mailboxId },
    { invocation: { context: other.context, permissions: 'all' }, services },
  );
  await withTenant(db, f.context, (trx) =>
    trx
      .updateTable('messaging.channel_accounts')
      .set({ status: 'paused' })
      .where('id', '=', f.mailboxId)
      .execute(),
  );
  await f.sync();
  expect(await f.rows('select id from messaging.messages')).toEqual([]);
  expect(await other.rows('select id from messaging.messages')).toEqual([]);

  await expect(
    runCommand(
      services,
      ingestInboundCommand,
      {
        mailboxId: f.mailboxId,
        expected: null,
        credentials: { secretId: randomUUID(), sha256: '0'.repeat(64) },
        next: { uidValidity: '1', lastUid: 0 },
        startedAt: null,
        items: [],
      },
      {
        context: { ...f.context, actorKind: 'user', actorId: (await database.fixtures.user()).id },
        permissions: 'all',
      },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

it('queues each due mailbox once', async () => {
  const f = await fixture();
  await database.as('crm_owner', (client) =>
    client.query('update messaging.mailboxes set last_synced_at = null where id = $1', [
      f.mailboxId,
    ]),
  );
  expect(await scheduleMailboxSyncs(services)).toBeGreaterThan(0);
  await scheduleMailboxSyncs(services);
  const jobs = await database.as('crm_owner', (client) =>
    client.query<{ n: number }>(
      "select count(*)::int as n from graphile_worker.jobs where key = 'mailbox-sync:' || $1::text",
      [f.mailboxId],
    ),
  );
  expect(jobs).toEqual([{ n: 1 }]);
});

it('changes nothing when the credentials are replaced or swapped while the inbox is read', async () => {
  const f = await fixture();
  await append(message({ From: 'e@example.test', 'Message-ID': id() }));
  const changeDuringRead = (change: () => Promise<void>) => {
    const inner = reader();
    return {
      async readInbox(...args: Parameters<typeof inner.readInbox>) {
        const result = await inner.readInbox(...args);
        await change();
        return result;
      },
    };
  };
  const secretOf = async () =>
    (
      await withTenant(db, f.context, (trx) =>
        trx
          .selectFrom('messaging.mailboxes')
          .select('secret_id')
          .where('id', '=', f.mailboxId)
          .executeTakeFirstOrThrow(),
      )
    ).secret_id;
  const run = (change: () => Promise<void>) =>
    createSyncMailboxTask(vault, changeDuringRead(change)).run(
      { mailboxId: f.mailboxId },
      { invocation: { context: f.context, permissions: 'all' }, services },
    );
  const credentials = JSON.stringify({
    name: 'Inbox',
    email: 'inbox@example.test',
    displayName: 'Inbox',
    smtp: {
      host: 'localhost',
      port: server.smtpPort,
      security: 'tls',
      username: server.username,
      password: server.password,
    },
    imap: {
      host: 'localhost',
      port: server.imapPort,
      security: 'tls',
      username: server.username,
      password: server.password,
    },
  });

  const original = await secretOf();
  await run(() => withTenant(db, f.context, (trx) => vault.replace(trx, original, credentials)));
  expect(await f.rows('select uid from messaging.mailbox_inbound_uids')).toEqual([]);

  await run(() =>
    withTenant(db, f.context, async (trx) => {
      const swapped = await vault.store(
        trx,
        {
          agencyId: f.context.agencyId,
          businessId: f.context.businessId ?? '',
          purpose: 'mailbox.credentials',
        },
        credentials,
      );
      await trx
        .updateTable('messaging.mailboxes')
        .set({ secret_id: swapped })
        .where('id', '=', f.mailboxId)
        .execute();
    }),
  );
  expect(await f.rows('select uid from messaging.mailbox_inbound_uids')).toEqual([]);
  expect(await f.rows('select id from messaging.messages')).toEqual([]);

  // The next run reads with the current credentials and records the mail.
  await f.sync();
  expect(await f.rows('select outcome from messaging.mailbox_inbound_uids')).toEqual([
    { outcome: 'stored' },
  ]);
});

it('never moves the cursor back for a run that read from a position since passed', async () => {
  const f = await fixture();
  const credentials = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.mailboxes as mailbox')
      .innerJoin('vault.secrets as secret', 'secret.id', 'mailbox.secret_id')
      .select([
        'mailbox.secret_id as secretId',
        sql<string>`encode(sha256(secret.enc || secret.ciphertext), 'hex')`.as('sha256'),
      ])
      .where('mailbox.id', '=', f.mailboxId)
      .executeTakeFirstOrThrow(),
  );
  const [start] = await f.rows<{ imap_uid_validity: string; imap_last_uid: string }>(
    'select imap_uid_validity, imap_last_uid from messaging.mailboxes',
  );
  if (start === undefined) throw new Error('Missing baseline.');
  const expected = { uidValidity: start.imap_uid_validity, lastUid: Number(start.imap_last_uid) };
  // Both runs read from the same position; the second finishes after the first moved on.
  const ingest = (ahead: number) =>
    runCommand(
      services,
      ingestInboundCommand,
      {
        mailboxId: f.mailboxId,
        expected,
        credentials,
        next: { uidValidity: expected.uidValidity, lastUid: expected.lastUid + ahead },
        startedAt: null,
        items: [],
      },
      { context: f.context, permissions: 'all' },
    );
  expect(await ingest(5)).toEqual({ applied: true, stored: 0 });
  expect(await ingest(1)).toEqual({ applied: false, stored: 0 });
  expect(await f.rows('select imap_uid_validity, imap_last_uid from messaging.mailboxes')).toEqual([
    { imap_uid_validity: expected.uidValidity, imap_last_uid: String(expected.lastUid + 5) },
  ]);
});

/** As if the server's UIDVALIDITY changed since the baseline: it sends everything again. */
async function resetUids(mailboxId: string): Promise<void> {
  await database.as('crm_owner', (client) =>
    client.query(
      'update messaging.mailboxes set imap_uid_validity = imap_uid_validity + 1, inbound_uid_validity = imap_uid_validity + 1 where id = $1',
      [mailboxId],
    ),
  );
}

// Fixed moments for the reset tests, so they give the same answer at any time of day.
// GreenMail returns a receipt time in the 12:00 to 12:59 UTC hour twelve hours early (a
// message appended at 12:30 comes back as 00:30; every other hour is exact), so a test that
// appends "now" fails for that hour each day. Neither moment is in that hour.
const SYNC_BEGAN = new Date('2026-03-01T06:00:00Z');
const AFTER_SYNC_BEGAN = new Date('2026-03-01T06:00:50Z');

/** Sets when the mailbox's sync began, as its first read recorded it. */
async function syncBegan(mailboxId: string, at: Date, savedLater = false): Promise<void> {
  await database.as('crm_owner', (client) =>
    client.query(
      `update messaging.mailboxes
       set inbound_started_at = $2, created_at = case when $3 then now() + interval '1 hour' else created_at end
       where id = $1`,
      [mailboxId, at, savedLater],
    ),
  );
}

async function appendDated(source: string, receivedAt: Date): Promise<void> {
  await withImap(async (client) => {
    expect(await client.append('INBOX', Buffer.from(source), [], receivedAt)).not.toBe(false);
  });
}

it('reads only mail received after sync began when a UIDVALIDITY reset resends the inbox', async () => {
  const f = await fixture();
  // The mailbox row was saved later than sync began, as after a slow connection.
  await syncBegan(f.mailboxId, SYNC_BEGAN, true);
  await appendDated(
    message({ From: 'old@example.test', 'Message-ID': id() }),
    new Date('2020-01-01T00:00:00Z'),
  );
  await appendDated(message({ From: 'new@example.test', 'Message-ID': id() }), AFTER_SYNC_BEGAN);
  // The server's UIDs reset before the next read, so it sends everything again.
  await resetUids(f.mailboxId);
  await f.sync();
  expect(
    await f.rows(
      'select outcome from messaging.mailbox_inbound_uids where uid_validity = (select imap_uid_validity from messaging.mailboxes) order by uid',
    ),
  ).toEqual([{ outcome: 'before_connection' }, { outcome: 'stored' }]);
  expect(await f.rows('select from_address from messaging.messages')).toEqual([
    { from_address: 'new@example.test' },
  ]);
  expect(
    await f.rows(
      "select id from crm.contact_identities where value_normalized = 'old@example.test'",
    ),
  ).toEqual([]);
});

it('refuses mail without a receipt date when a UIDVALIDITY reset resends it', async () => {
  const f = await fixture();
  const credentials = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.mailboxes as mailbox')
      .innerJoin('vault.secrets as secret', 'secret.id', 'mailbox.secret_id')
      .select([
        'mailbox.secret_id as secretId',
        'mailbox.imap_uid_validity as uidValidity',
        'mailbox.imap_last_uid as lastUid',
        sql<string>`encode(sha256(secret.enc || secret.ciphertext), 'hex')`.as('sha256'),
      ])
      .where('mailbox.id', '=', f.mailboxId)
      .executeTakeFirstOrThrow(),
  );
  const parsed = await parseInboundMessage(
    Buffer.from(message({ From: 'undated@example.test', 'Message-ID': id() })),
  );
  if (parsed.outcome !== 'parsed') throw new Error('Fixture did not parse.');
  const expected = {
    uidValidity: credentials.uidValidity ?? '',
    lastUid: Number(credentials.lastUid),
  };
  expect(
    await runCommand(
      services,
      ingestInboundCommand,
      {
        mailboxId: f.mailboxId,
        expected,
        credentials: { secretId: credentials.secretId, sha256: credentials.sha256 },
        next: { uidValidity: String(Number(expected.uidValidity) + 1), lastUid: 1 },
        startedAt: null,
        items: [{ uid: 1, outcome: 'parsed', message: parsed.message, receivedAt: null }],
      },
      { context: f.context, permissions: 'all' },
    ),
  ).toEqual({ applied: true, stored: 0 });
  expect(await f.rows('select outcome, reason from messaging.mailbox_inbound_uids')).toEqual([
    { outcome: 'refused', reason: 'received_date_unavailable' },
  ]);
});

it('starts a mailbox connected before baselines at its first read, without its history', async () => {
  const f = await fixture();
  await append(message({ From: 'history@example.test', 'Message-ID': id() }));
  await database.as('crm_owner', (client) =>
    client.query(
      'update messaging.mailboxes set imap_uid_validity = null, imap_last_uid = null, inbound_started_at = null where id = $1',
      [f.mailboxId],
    ),
  );
  const before = new Date();
  await f.sync();
  const [row] = await f.rows<{ inbound_started_at: Date; imap_uid_validity: string | null }>(
    'select inbound_started_at, imap_uid_validity from messaging.mailboxes',
  );
  expect(row?.imap_uid_validity).not.toBeNull();
  expect(row?.inbound_started_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  expect(await f.rows('select id from messaging.messages')).toEqual([]);
  await append(message({ From: 'fresh@example.test', 'Message-ID': id() }));
  await f.sync();
  expect(await f.rows('select from_address from messaging.messages')).toEqual([
    { from_address: 'fresh@example.test' },
  ]);
});

/**
 * Waits until a session in this database is blocked by the owner's transaction, for at most
 * 10 seconds. Process IDs and pg_blocking_pids are visible to every role; wait events and
 * query text of other roles are not (PostgreSQL 18, monitoring statistics).
 */
async function blockedBy(ownerPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await database.as('crm_owner', (client) =>
      client.query<{ n: number }>(
        'select count(*)::int as n from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid))',
        [ownerPid],
      ),
    );
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Fixture timeout: no session waited for the row lock within 10 seconds.');
}

it('stores nothing when the channel is switched off while a batch is read', async () => {
  const f = await fixture();
  await append(message({ From: 'late@example.test', 'Message-ID': id() }));
  let syncing: Promise<void> | undefined;
  try {
    await database.as('crm_owner', async (client) => {
      // The deactivation is in progress, not yet committed, when the batch is written.
      await client.query("update messaging.channel_accounts set status = 'paused' where id = $1", [
        f.mailboxId,
      ]);
      const [owner] = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      syncing = f.sync();
      await blockedBy(owner?.pid ?? 0);
    });
  } finally {
    // Never leave a started sync writing after the test.
    await syncing?.catch(() => undefined);
  }
  await syncing;
  expect(await f.rows('select uid from messaging.mailbox_inbound_uids')).toEqual([]);
  expect(await f.rows('select id from messaging.messages')).toEqual([]);
});

it('keeps history out across every batch after a reset, not just the first', async () => {
  const f = await fixture();
  for (let i = 0; i < 21; i++)
    await appendDated(
      message({ From: `history${String(i)}@example.test`, 'Message-ID': id() }),
      new Date('2020-01-01T00:00:00Z'),
    );
  await syncBegan(f.mailboxId, SYNC_BEGAN);
  await appendDated(message({ From: 'today@example.test', 'Message-ID': id() }), AFTER_SYNC_BEGAN);
  await resetUids(f.mailboxId);
  // The reader pages 20 sources at a time; each run reads one page.
  for (let run = 0; run < 3; run++) await f.sync();
  expect(
    await f.rows<{ outcome: string; n: number }>(
      'select outcome, count(*)::int as n from messaging.mailbox_inbound_uids group by outcome order by outcome',
    ),
  ).toEqual([
    { outcome: 'before_connection', n: 21 },
    { outcome: 'stored', n: 1 },
  ]);
  expect(await f.rows('select from_address from messaging.messages')).toEqual([
    { from_address: 'today@example.test' },
  ]);
  expect(
    await f.rows("select id from crm.contact_identities where value_normalized like 'history%'"),
  ).toEqual([]);
});

it('suppresses an address when the delivery report for mail this mailbox sent comes back', async () => {
  const f = await fixture();
  const contact = await database.fixtures.contact(f.context, { email: 'nobody@example.com' });
  // A message really sent from this mailbox to that contact.
  const identityId = await database.withTenant(f.context, async (client) => {
    await client.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled,contact_daily_limit) values (app.business_id(),false,1000)',
    );
    await client.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,'email','transactional','granted','user','system')",
      [contact.id],
    );
    const [identity] = await client.query<{ id: string }>(
      'select id from crm.contact_identities where contact_id=$1',
      [contact.id],
    );
    if (identity === undefined) throw new Error('The contact has an email identity.');
    return identity.id;
  });
  const sentId = await withTenant(db, f.context, (trx) =>
    queueOutboundMessage(trx, f.context, {
      identityId,
      accountId: f.mailboxId,
      channel: 'email',
      purpose: 'transactional',
      lane: 'transactional',
      idempotencyKey: randomUUID(),
      subject: 'Your order',
      text: 'Thank you for your order.',
    }),
  );
  await createDispatchOutboundTask({
    deliver: () => Promise.resolve({ outcome: 'accepted', providerId: randomUUID() }),
  }).run(
    { messageId: sentId },
    { invocation: { context: f.context, permissions: 'all' }, services },
  );

  // The report as a mail server writes it, naming our own Message-ID for that message.
  const fixtureSource = await readFile(
    new URL('../../../adapters/mail/src/fixtures/dsn/failed-user-unknown.eml', import.meta.url),
    'utf8',
  );
  const report = (messageId: string) =>
    fixtureSource
      .replaceAll(/\r?\n/g, '\r\n')
      .replace('0199c0de-0000-7000-8000-000000000001', messageId);
  // One for the real message, and a forged one for a message that was never sent.
  await append(report(sentId), report(randomUUID()));
  await f.sync();

  expect(
    await f.rows('select status, error_code, error_detail from messaging.messages where id = $1', [
      sentId,
    ]),
  ).toEqual([{ status: 'bounced', error_code: 'hard_bounce', error_detail: '5.1.1' }]);
  expect(
    await f.rows(
      'select address_normalized, reason, source_message_id from messaging.suppressions',
    ),
  ).toEqual([
    { address_normalized: 'nobody@example.com', reason: 'hard_bounce', source_message_id: sentId },
  ]);
  // Both reports are accounted for by UID, and neither became a conversation message.
  expect(await f.rows('select outcome from messaging.mailbox_inbound_uids order by uid')).toEqual([
    { outcome: 'delivery_report' },
    { outcome: 'delivery_report' },
  ]);
  expect(await f.rows("select id from messaging.messages where direction = 'inbound'")).toEqual([]);

  // Reading again changes nothing.
  await f.sync();
  expect(await f.rows('select id from messaging.suppressions')).toHaveLength(1);
  expect(await f.rows("select id from events.events where type = 'message.bounced'")).toHaveLength(
    1,
  );
});

/** A plain message from an address, with extra header lines, as a mail server stores it. */
const plainFrom = (from: string, extra: readonly string[] = [], body = 'Hello there.') =>
  [
    `From: <${from}>`,
    'To: <inbox@example.test>',
    'Subject: Hello',
    'Date: Wed, 14 Oct 2026 09:30:00 +0000',
    `Message-ID: <${randomUUID()}@example.org>`,
    ...extra,
    '',
    body,
    '',
  ].join('\r\n');

it("keeps mail whose From the receiving server says was forged out of the real contact's conversation", async () => {
  const f = await fixture();
  const contact = await database.fixtures.contact(f.context, { email: 'customer@example.com' });
  await append(
    plainFrom(
      'customer@example.com',
      [
        'Authentication-Results: mx.example.test; spf=fail smtp.mailfrom=customer@example.com; dmarc=fail (p=reject) header.from=example.com',
      ],
      'Our bank details have changed.',
    ),
    plainFrom('customer@example.com', [
      'Authentication-Results: mx.example.test; spf=pass smtp.mailfrom=customer@example.com; dmarc=pass header.from=example.com',
    ]),
  );
  await f.sync();
  expect(await f.rows('select outcome from messaging.mailbox_inbound_uids order by uid')).toEqual([
    { outcome: 'sender_unauthenticated' },
    { outcome: 'stored' },
  ]);
  // Only the genuine message is filed under the contact, and only it started anything.
  expect(
    await f.rows(
      "select v.contact_id, m.body_text from messaging.messages m join messaging.conversations v on v.id = m.conversation_id where m.direction = 'inbound'",
    ),
  ).toEqual([{ contact_id: contact.id, body_text: 'Hello there.' }]);
  expect(await f.rows("select id from events.events where type = 'message.received'")).toHaveLength(
    1,
  );
});

it('files an automatic answer without starting "message received" workflows (RFC 3834)', async () => {
  const f = await fixture();
  await append(
    plainFrom('away@example.org', ['Auto-Submitted: auto-replied'], 'I am out of the office.'),
  );
  await f.sync();
  expect(
    await f.rows("select automated from messaging.messages where direction = 'inbound'"),
  ).toEqual([{ automated: true }]);
  expect(
    await f.rows("select type from events.events where type like 'message.%' order by id"),
  ).toEqual([{ type: 'message.auto_reply_received' }]);
});

it('suppresses the recipient when a feedback loop reports a complaint about mail this mailbox sent (RFC 5965)', async () => {
  const f = await fixture();
  const contact = await database.fixtures.contact(f.context, { email: 'complainer@example.com' });
  const identityId = await database.withTenant(f.context, async (client) => {
    await client.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled,contact_daily_limit) values (app.business_id(),false,1000)',
    );
    await client.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,'email','transactional','granted','user','system')",
      [contact.id],
    );
    const [identity] = await client.query<{ id: string }>(
      'select id from crm.contact_identities where contact_id=$1',
      [contact.id],
    );
    if (identity === undefined) throw new Error('The contact has an email identity.');
    return identity.id;
  });
  const sentId = await withTenant(db, f.context, (trx) =>
    queueOutboundMessage(trx, f.context, {
      identityId,
      accountId: f.mailboxId,
      channel: 'email',
      purpose: 'transactional',
      lane: 'transactional',
      idempotencyKey: randomUUID(),
      subject: 'News',
      text: 'News.',
    }),
  );
  await createDispatchOutboundTask({
    deliver: () => Promise.resolve({ outcome: 'accepted', providerId: randomUUID() }),
  }).run(
    { messageId: sentId },
    { invocation: { context: f.context, permissions: 'all' }, services },
  );
  const arf = (messageId: string) =>
    [
      'From: <staff@feedback.example>',
      'To: <inbox@example.test>',
      'Subject: FW: News',
      `Message-ID: <${randomUUID()}@feedback.example>`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=feedback-report; boundary="arf"',
      '',
      '--arf',
      'Content-Type: text/plain',
      '',
      'This is an email abuse report.',
      '',
      '--arf',
      'Content-Type: message/feedback-report',
      '',
      'Feedback-Type: abuse',
      'Version: 1',
      '',
      '--arf',
      'Content-Type: text/rfc822-headers',
      '',
      'From: <inbox@example.test>',
      'To: <complainer@example.com>',
      `Message-ID: <crm-outbound.${messageId}@crm.invalid>`,
      'Subject: News',
      '',
      '--arf--',
      '',
    ].join('\r\n');
  // One about the real message, a forged one about a message never sent, and one that
  // cannot be read (no Feedback-Type), which is still never filed as a conversation.
  await append(arf(sentId), arf(randomUUID()), arf(sentId).replace('Feedback-Type: abuse\r\n', ''));
  await f.sync();
  expect(
    await f.rows(
      'select address_normalized, reason, source_message_id from messaging.suppressions',
    ),
  ).toEqual([
    {
      address_normalized: 'complainer@example.com',
      reason: 'complaint',
      source_message_id: sentId,
    },
  ]);
  expect(await f.rows('select outcome from messaging.mailbox_inbound_uids order by uid')).toEqual([
    { outcome: 'complaint_report' },
    { outcome: 'complaint_report' },
    { outcome: 'complaint_report' },
  ]);
  expect(await f.rows("select id from messaging.messages where direction = 'inbound'")).toEqual([]);
});
