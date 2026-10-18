// Inbound email's database side: one outcome per inbox UID, stored bytes deduplicated per
// mailbox, proven reply parents, and the per-mailbox sync queue.
import { createHash, randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

const digest = (text: string) => createHash('sha256').update(text).digest();

/** A business with one active mailbox; the secret's bytes exercise foreign keys only. */
async function mailboxBusiness(): Promise<{ context: TenantContext; mailboxId: string }> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const mailboxId = await database.withTenant(context, async (sql) => {
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values (app.agency_id(), app.business_id(), 'mailbox.credentials', 1,
               decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')) returning id`,
    );
    const channel = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id, channel, name) values (app.business_id(), 'email', 'Inbox') returning id",
    );
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host, smtp_port,
         smtp_security, smtp_username, imap_host, imap_port,
         imap_security, imap_username, secret_id)
       values (app.business_id(), $1, 'inbox@example.test', 'password', 'smtp.example.test', 465, 'tls',
         'inbox@example.test', 'imap.example.test', 993, 'tls',
         'inbox@example.test', $2)`,
      [channel.id, secret.id],
    );
    return channel.id;
  });
  return { context, mailboxId };
}

interface Outcome {
  readonly outcome: string;
  readonly reason?: string;
  readonly source?: Buffer;
}

const record = (sql: Sql, mailboxId: string, uid: number, values: Outcome) =>
  sql.query(
    `insert into messaging.mailbox_inbound_uids (business_id, mailbox_id, uid_validity, uid, outcome, reason, source_sha256)
     values (app.business_id(), $1, 7, $2, $3, $4, $5)`,
    [mailboxId, uid, values.outcome, values.reason ?? null, values.source ?? null],
  );

it("isolates UID outcomes and refuses another business's mailbox", async () => {
  const first = await mailboxBusiness();
  const second = await mailboxBusiness();
  await database.withTenant(first.context, (sql) =>
    record(sql, first.mailboxId, 1, { outcome: 'stored', source: digest('one') }),
  );
  expect(
    await database.withTenant(second.context, (sql) =>
      sql.query('select uid from messaging.mailbox_inbound_uids'),
    ),
  ).toEqual([]);
  await expect(
    database.withTenant(second.context, (sql) =>
      record(sql, first.mailboxId, 2, { outcome: 'stored', source: digest('two') }),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

it('keeps one outcome per UID, stores the same bytes once per mailbox, and checks each outcome', async () => {
  const { context, mailboxId } = await mailboxBusiness();
  const other = await database.withTenant(context, async (sql) => {
    const channel = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id, channel, name) values (app.business_id(), 'email', 'Second') returning id",
    );
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host, smtp_port,
         smtp_security, smtp_username, secret_id)
       select business_id, $1, 'second@example.test', auth_method, smtp_host, smtp_port, smtp_security,
         smtp_username, secret_id from messaging.mailboxes where id = $2`,
      [channel.id, mailboxId],
    );
    return channel.id;
  });
  const same = digest('the same bytes');
  await database.withTenant(context, (sql) =>
    record(sql, mailboxId, 1, { outcome: 'stored', source: same }),
  );
  const rejects = async (work: (sql: Sql) => Promise<unknown>, code: string) =>
    expect(database.withTenant(context, work)).rejects.toMatchObject({ code });

  await rejects(
    (sql) => record(sql, mailboxId, 1, { outcome: 'duplicate', source: same }),
    '23505',
  );
  // A UIDVALIDITY reset reads the same bytes under a new UID: stored again is refused.
  await rejects((sql) => record(sql, mailboxId, 2, { outcome: 'stored', source: same }), '23505');
  await rejects((sql) => record(sql, mailboxId, 3, { outcome: 'refused' }), '23514');
  await rejects(
    (sql) => record(sql, mailboxId, 4, { outcome: 'stored', reason: 'malformed', source: same }),
    '23514',
  );
  await rejects((sql) => record(sql, mailboxId, 5, { outcome: 'sender_unresolved' }), '23514');
  await rejects((sql) => record(sql, mailboxId, 6, { outcome: 'ignored', source: same }), '23514');
  await rejects(
    (sql) =>
      sql.query(
        `insert into messaging.mailbox_inbound_uids (business_id, mailbox_id, uid_validity, uid, outcome, source_sha256)
         values (app.business_id(), $1, 0, 1, 'stored', $2)`,
        [mailboxId, digest('zero validity')],
      ),
    '23514',
  );

  await database.withTenant(context, async (sql) => {
    await record(sql, mailboxId, 2, { outcome: 'duplicate', source: same });
    await record(sql, mailboxId, 3, { outcome: 'refused', reason: 'message_too_large' });
    await record(sql, mailboxId, 4, { outcome: 'delivery_report', source: digest('report') });
    await record(sql, other, 1, { outcome: 'stored', source: same });
  });
  expect(
    await database.withTenant(context, (sql) =>
      sql.query(
        'select mailbox_id, uid, outcome from messaging.mailbox_inbound_uids order by mailbox_id = $1 desc, uid',
        [mailboxId],
      ),
    ),
  ).toEqual([
    { mailbox_id: mailboxId, uid: '1', outcome: 'stored' },
    { mailbox_id: mailboxId, uid: '2', outcome: 'duplicate' },
    { mailbox_id: mailboxId, uid: '3', outcome: 'refused' },
    { mailbox_id: mailboxId, uid: '4', outcome: 'delivery_report' },
    { mailbox_id: other, uid: '1', outcome: 'stored' },
  ]);
  // Outcomes are append-only for the app.
  await rejects(
    (sql) => sql.query("update messaging.mailbox_inbound_uids set outcome = 'refused'"),
    '42501',
  );
});

it('links a reply to a stored parent in the same business only, and never to itself', async () => {
  const { context, mailboxId } = await mailboxBusiness();
  const contact = await database.fixtures.contact(context, { email: 'sender@example.test' });
  const insertMessage = (
    sql: Sql,
    parent: string | null,
    owner: { contactId: string; mailboxId: string } = { contactId: contact.id, mailboxId },
  ) =>
    sql.one<{ id: string }>(
      `with conversation as (
         insert into messaging.conversations (business_id, contact_id) values (app.business_id(), $1)
         on conflict (business_id, contact_id) do update set contact_id = excluded.contact_id returning id)
       insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status,
         author_kind, author_id, body_text, parent_message_id, automated)
       select app.business_id(), id, 'email', $2, 'inbound', 'received', 'contact', $1, 'Hello', $3, $4
       from conversation returning id`,
      [owner.contactId, owner.mailboxId, parent, parent !== null],
    );
  const parent = await database.withTenant(context, (sql) => insertMessage(sql, null));
  const reply = await database.withTenant(context, (sql) => insertMessage(sql, parent.id));
  expect(
    await database.withTenant(context, (sql) =>
      sql.one('select parent_message_id, automated from messaging.messages where id = $1', [
        reply.id,
      ]),
    ),
  ).toEqual({ parent_message_id: parent.id, automated: true });
  await expect(
    database.withTenant(context, (sql) =>
      sql.query('update messaging.messages set parent_message_id = id where id = $1', [parent.id]),
    ),
  ).rejects.toMatchObject({ code: '23514' });

  // Another business can't name this business's message as its reply's parent.
  const foreign = await mailboxBusiness();
  const foreignContact = await database.fixtures.contact(foreign.context, {
    email: 'x@example.test',
  });
  await expect(
    database.withTenant(foreign.context, (sql) =>
      insertMessage(sql, parent.id, { contactId: foreignContact.id, mailboxId: foreign.mailboxId }),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

it('lists due mailboxes and queues one sync per mailbox from its own tenant only', async () => {
  const first = await mailboxBusiness();
  const second = await mailboxBusiness();
  const due = await database.as('crm_app', (sql) =>
    sql.query<{ mailbox_id: string }>('select mailbox_id from private.due_mailbox_syncs(1000)'),
  );
  expect(due.map((row) => row.mailbox_id)).toEqual(
    expect.arrayContaining([first.mailboxId, second.mailboxId]),
  );

  await database.withTenant(first.context, async (sql) => {
    await sql.query('update messaging.mailboxes set last_synced_at = now() where id = $1', [
      first.mailboxId,
    ]);
  });
  const after = await database.as('crm_app', (sql) =>
    sql.query<{ mailbox_id: string }>('select mailbox_id from private.due_mailbox_syncs(1000)'),
  );
  expect(after.map((row) => row.mailbox_id)).not.toContain(first.mailboxId);

  await expect(
    database.withTenant(second.context, (sql) =>
      sql.query('select private.enqueue_mailbox_sync($1)', [first.mailboxId]),
    ),
  ).rejects.toThrow('mailbox is not available in this context');
  await database.withTenant(first.context, async (sql) => {
    await sql.query('select private.enqueue_mailbox_sync($1)', [first.mailboxId]);
    await sql.query('select private.enqueue_mailbox_sync($1)', [first.mailboxId]);
  });
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query(
        "select queue_name from graphile_worker.jobs where key = 'mailbox-sync:' || $1::text",
        [first.mailboxId],
      ),
    ),
  ).toEqual([{ queue_name: `mailbox-sync:${first.mailboxId}` }]);
  const received = (await database.runJobs(['mailboxes.sync'])).filter(
    ({ payload }) =>
      typeof payload === 'object' &&
      payload !== null &&
      'correlationId' in payload &&
      payload.correlationId === first.context.correlationId,
  );
  expect(received).toHaveLength(1);
  expect(received).toMatchObject([
    {
      task: 'mailboxes.sync',
      payload: { businessId: first.context.businessId, data: { mailboxId: first.mailboxId } },
    },
  ]);
});

it('schedules every due mailbox even when earlier enqueued reads never succeed', async () => {
  const mailboxes = [await mailboxBusiness(), await mailboxBusiness(), await mailboxBusiness()];
  await database.as('crm_owner', (sql) =>
    sql.query('update messaging.mailboxes set last_synced_at = now() where id <> all($1::uuid[])', [
      mailboxes.map((mailbox) => mailbox.mailboxId),
    ]),
  );
  const visited: string[] = [];
  for (let round = 0; round < 3; round += 1) {
    const due = await database.as('crm_app', (sql) =>
      sql.one<{ mailbox_id: string }>('select mailbox_id from private.due_mailbox_syncs(1)'),
    );
    expect(visited).not.toContain(due.mailbox_id);
    const mailbox = mailboxes.find((candidate) => candidate.mailboxId === due.mailbox_id);
    if (mailbox === undefined)
      throw new Error('Discovery returned a mailbox outside this fixture.');
    await database.withTenant(mailbox.context, (sql) =>
      sql.query('select private.enqueue_mailbox_sync($1)', [mailbox.mailboxId]),
    );
    visited.push(mailbox.mailboxId);
  }
  expect(new Set(visited)).toEqual(new Set(mailboxes.map((mailbox) => mailbox.mailboxId)));
  // No sync task ran: progress in discovery cannot depend on a successful read.
  for (const mailbox of mailboxes) {
    const row = await database.withTenant(mailbox.context, (sql) =>
      sql.one<{ last_synced_at: Date | null }>(
        'select last_synced_at from messaging.mailboxes where id = $1',
        [mailbox.mailboxId],
      ),
    );
    expect(row.last_synced_at).toBeNull();
  }
});

// Migration 0075. The schedule ticks every two minutes and a read ends some seconds after
// the tick that queued it, so at the next tick its mailbox was read a little under two
// minutes ago. It must be due then, or it is read at every other tick.
it('calls a mailbox due again at the tick after the one that read it', async () => {
  const { context, mailboxId } = await mailboxBusiness();
  const dueAfter = async (sinceRead: string): Promise<boolean> => {
    await database.withTenant(context, (sql) =>
      sql.query(
        'update messaging.mailboxes set last_synced_at = now() - $2::interval where id = $1',
        [mailboxId, sinceRead],
      ),
    );
    const due = await database.as('crm_app', (sql) =>
      sql.query<{ mailbox_id: string }>('select mailbox_id from private.due_mailbox_syncs(1000)'),
    );
    return due.some((row) => row.mailbox_id === mailboxId);
  };
  // Read just now, by hand or by the tick still running: not again at once.
  expect(await dueAfter('5 seconds')).toBe(false);
  // A read that ended 2 s, or 45 s, after the tick before this one.
  expect(await dueAfter('118 seconds')).toBe(true);
  expect(await dueAfter('75 seconds')).toBe(true);

  // Replacing the function kept who may call it, and what it runs as.
  const [shape] = await database.as('crm_owner', (sql) =>
    sql.query<{ definer: boolean; config: string[]; app: boolean; anyone: boolean }>(
      `select prosecdef as definer, proconfig as config,
              has_function_privilege('crm_app', oid, 'execute') as app,
              has_function_privilege('public', oid, 'execute') as anyone
       from pg_proc where oid = 'private.due_mailbox_syncs(integer)'::regprocedure`,
    ),
  );
  expect(shape).toEqual({ definer: true, config: ['search_path=""'], app: true, anyone: false });
});

/** Waits until a session in this database is blocked by the given backend, for at most 10 s. */
async function blockedBy(ownerPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await database.as('crm_owner', (sql) =>
      sql.query<{ n: number }>(
        'select count(*)::int as n from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid))',
        [ownerPid],
      ),
    );
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Fixture timeout: no session waited for the mailbox lock within 10 seconds.');
}

it('queues a sync while an ingest holds the mailbox, in one lock order, without deadlock', async () => {
  const { context, mailboxId } = await mailboxBusiness();
  // A waiting keyed job already exists, as after an earlier tick.
  await database.withTenant(context, (sql) =>
    sql.query('select private.enqueue_mailbox_sync($1)', [mailboxId]),
  );
  // Settled from the moment it starts, so its failure is always handled.
  let scheduled: Promise<PromiseSettledResult<unknown>[]> | undefined;
  const ingest = database.withTenant(context, async (sql) => {
    // The ingest command locks its mailbox first ...
    await sql.query('select id from messaging.mailboxes where id = $1 for update', [mailboxId]);
    const [owner] = await sql.query<{ pid: number }>('select pg_backend_pid() as pid');
    // ... while the scheduler queues the same mailbox in its own transaction ...
    scheduled = Promise.allSettled([
      database.withTenant({ ...context, correlationId: randomUUID() }, (other) =>
        other.query('select private.enqueue_mailbox_sync($1)', [mailboxId]),
      ),
    ]);
    await blockedBy(owner?.pid ?? 0);
    // ... and then queues its own continuation.
    await sql.query('select private.enqueue_mailbox_sync($1)', [mailboxId]);
  });
  // Both settle before asserting, so a failure leaves no transaction behind.
  const [ingested] = await Promise.allSettled([ingest]);
  if (scheduled === undefined) throw new Error('The scheduler never started.');
  const [schedulerResult] = await scheduled;
  const outcome = (result: PromiseSettledResult<unknown> | undefined) =>
    result?.status === 'fulfilled' ? 'ok' : String(result?.reason);
  expect([outcome(ingested), outcome(schedulerResult)]).toEqual(['ok', 'ok']);
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query(
        "select count(*)::int as n from graphile_worker.jobs where key = 'mailbox-sync:' || $1::text",
        [mailboxId],
      ),
    ),
  ).toEqual([{ n: 1 }]);
});
