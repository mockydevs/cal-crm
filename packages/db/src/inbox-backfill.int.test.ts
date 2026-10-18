// Migration 0046 over an install that already has conversations: a database is migrated
// up to the migration before it, rows are stored as inbound.ts and outbound.ts stored them
// then, and the runner applies 0046 as it does on an upgrade.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const INBOX = '0046_inbox.sql';

let postgres: Postgres;
let earlier: string;
beforeAll(async () => {
  postgres = await startPostgres({ bootstrapFile });
  // The migrations an install had before the Inbox.
  earlier = await mkdtemp(join(tmpdir(), 'crm-before-inbox-'));
  for (const name of await readdir(migrationsDirectory))
    if (name < INBOX) await cp(join(migrationsDirectory, name), join(earlier, name));
});
afterAll(async () => {
  await postgres.stop();
  await rm(earlier, { recursive: true, force: true });
});

it('numbers the messages stored before it and keeps what the team had read', async () => {
  const database = await postgres.createDatabase();
  const connectionString = postgres.url(database);
  const before = await migrate({ connectionString, directory: earlier });
  expect(before.applied).not.toContain(INBOX);

  // crm_owner, as an import or a repair would write: it is not held to a tenant.
  const owner = new pg.Client({ connectionString });
  await owner.connect();
  try {
    const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
      const { rows } = await owner.query<{ id: string }>(text, [...values]);
      const [row] = rows;
      if (row === undefined) throw new Error(`No row: ${text}`);
      return row.id;
    };
    const agency = await one(
      "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
    );
    const business = await one(
      "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
      [agency],
    );
    const objectType = await one(
      `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
       values ($1, 'contact', 'contact', 'Contact', 'Contacts') returning id`,
      [business],
    );
    const account = await one(
      "insert into messaging.channel_accounts (business_id, channel, name) values ($1, 'email', 'Inbox') returning id",
      [business],
    );
    const conversation = async (unread: number): Promise<string> => {
      const contact = await one(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           values ($1, 'contact', $2) returning id)
         insert into crm.contacts (business_id, id, first_name, created_by_kind)
         select $1, id, 'Maya', 'import' from record returning id`,
        [business, objectType],
      );
      return one(
        `insert into messaging.conversations (business_id, contact_id, unread_count, needs_reply)
         values ($1, $2, $3, $3 > 0) returning id`,
        [business, contact, unread],
      );
    };
    const inbound = (conversationId: string) =>
      one(
        `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
           direction, status, body_text, author_kind)
         values ($1, $2, 'email', $3, 'inbound', 'received', 'Hello', 'contact') returning id`,
        [business, conversationId, account],
      );
    const outbound = (conversationId: string, status: string) =>
      one(
        `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
           direction, status, body_text, idempotency_key, author_kind)
         values ($1, $2, 'email', $3, 'outbound', $4, 'Hi', uuidv7()::text, 'user') returning id`,
        [business, conversationId, account, status],
      );
    // Read and answered; two unread; read, with a reply that failed; and no message at all.
    const read = await conversation(0);
    const readFirst = await inbound(read);
    const readSecond = await outbound(read, 'sent');
    const unread = await conversation(1);
    await inbound(unread);
    await inbound(unread);
    const mixed = await conversation(0);
    await inbound(mixed);
    await outbound(mixed, 'failed');
    const empty = await conversation(0);

    // The upgrade: the runner applies what is new, 0046 among it.
    const upgrade = await migrate({ connectionString });
    expect(upgrade.applied).toContain(INBOX);

    const seqs = await owner.query<{ id: string; seq: string }>(
      'select id, seq from messaging.messages where conversation_id = $1 order by id',
      [read],
    );
    expect(seqs.rows).toEqual([
      { id: readFirst, seq: '1' },
      { id: readSecond, seq: '2' },
    ]);
    const summary = async (id: string) =>
      (
        await owner.query<{
          message_seq: string;
          read_through_seq: string;
          unread_count: number;
          needs_reply: boolean;
        }>(
          `select message_seq, read_through_seq, unread_count, needs_reply
           from messaging.conversations where id = $1`,
          [id],
        )
      ).rows;
    // The old counter said nothing was unread: read through the last message, and answered.
    expect(await summary(read)).toEqual([
      { message_seq: '2', read_through_seq: '2', unread_count: 0, needs_reply: false },
    ]);
    // The old counter said something was unread: every message of the contact is.
    expect(await summary(unread)).toEqual([
      { message_seq: '2', read_through_seq: '0', unread_count: 2, needs_reply: true },
    ]);
    // A reply that failed never answered the contact.
    expect(await summary(mixed)).toEqual([
      { message_seq: '2', read_through_seq: '2', unread_count: 0, needs_reply: true },
    ]);
    expect(await summary(empty)).toEqual([
      { message_seq: '0', read_through_seq: '0', unread_count: 0, needs_reply: false },
    ]);
    // Numbering goes on from where the old rows end.
    const next = await inbound(read);
    expect(
      (await owner.query('select seq from messaging.messages where id = $1', [next])).rows,
    ).toEqual([{ seq: '3' }]);
    expect(await summary(read)).toEqual([
      { message_seq: '3', read_through_seq: '2', unread_count: 1, needs_reply: true },
    ]);
  } finally {
    await owner.end();
  }
});
