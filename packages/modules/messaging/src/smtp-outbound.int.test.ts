import { randomUUID } from 'node:crypto';
import { allowEveryone, requireBusiness, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { createMailboxConnector } from '@repo/mail';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import {
  mailbox,
  startTlsMailpit,
  testDatabase,
  type TestDatabase,
  type TlsMailpitServer,
} from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { createSmtpDispatchTask, queueOutboundMessage, type OutboundInput } from './index.js';
import { readMailboxSendingSettings, updateMailboxSendingCommand } from './index.js';
import { NotFoundError, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

let database: TestDatabase;
let db: Database;
let services: Services;
let vault: Vault;
let mail: TlsMailpitServer;
let stopMail: (() => Promise<void>) | undefined;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  const keys = await newSecretsKey(1);
  vault = await createVault(parseSecretsKeys(keys.secretsKey));
  ({ server: mail, stop: stopMail } = await startTlsMailpit());
});
afterAll(async () => {
  await stopMail?.();
  await db.destroy();
  await database.close();
});

async function fixture(postal = true) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  // Marketing email is sent only with the business's postal address.
  if (postal)
    await database.as('postgres', (sql) =>
      sql.query(`update tenancy.businesses set address = $1::jsonb where id = $2`, [
        JSON.stringify({
          line1: '12 High St',
          city: 'Austin',
          region: 'TX',
          postalCode: '78701',
          country: 'US',
        }),
        business.id,
      ]),
    );
  const recipient = `recipient.${randomUUID()}@example.test`;
  const contact = await database.fixtures.contact(context, { email: recipient });
  const input = {
    name: 'SMTP fixture',
    email: 'sender@example.test',
    displayName: 'Sender',
    smtp: {
      host: 'localhost',
      port: mail.smtpPort,
      security: 'tls',
      username: mail.username,
      password: mail.password,
    },
    imap: {
      host: 'localhost',
      port: 993,
      security: 'tls',
      username: mail.username,
      password: mail.password,
    },
  };
  const ids = await withTenant(db, context, async (trx) => {
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
        display_name: input.displayName,
        auth_method: 'password',
        smtp_host: input.smtp.host,
        smtp_port: input.smtp.port,
        smtp_security: 'tls',
        smtp_username: input.smtp.username,
        secret_id: secretId,
        use_for_campaigns: true,
      })
      .execute();
    await trx
      .insertInto('messaging.settings')
      .values({ business_id: business.id, quiet_hours_enabled: false })
      .execute();
    await trx
      .insertInto('messaging.consents')
      .values({
        business_id: business.id,
        contact_id: contact.id,
        channel: 'email',
        purpose: 'marketing',
        status: 'granted',
        source: 'user',
        recorded_by_kind: 'system',
      })
      .execute();
    const identity = await trx
      .selectFrom('crm.contact_identities')
      .select('id')
      .where('contact_id', '=', contact.id)
      .executeTakeFirstOrThrow();
    return { identityId: identity.id, accountId: account.id };
  });
  const invocation = { context, permissions: 'all' as const };
  const queue = (patch: Partial<OutboundInput> = {}) =>
    withTenant(db, context, (trx) =>
      queueOutboundMessage(trx, context, {
        ...ids,
        channel: 'email',
        purpose: 'marketing',
        lane: 'campaign',
        idempotencyKey: randomUUID(),
        subject: 'Outbound fixture',
        text: 'Plain body',
        html: '<p>HTML body</p>',
        ...patch,
      }),
    );
  const task = () =>
    createSmtpDispatchTask(
      vault,
      createMailboxConnector({
        ca: mail.ca,
        allowedPrivateHosts: ['localhost'],
        resolve: () => Promise.resolve([mail.address]),
      }),
      db,
      'https://crm.example.test',
    );
  return { context, invocation, recipient, ids, queue, task };
}

it('submits once over strict authenticated TLS and records SMTP acceptance', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  await f.task().run({ messageId }, { invocation: f.invocation, services });
  await f.task().run({ messageId }, { invocation: f.invocation, services });
  const delivered = await mailbox(mail).messagesTo(f.recipient);
  const captured = delivered[0];
  expect(captured).toBeDefined();
  const rawResponse = await fetch(`${mail.apiUrl}/api/v1/message/${captured?.id ?? ''}/raw`);
  expect(rawResponse.status).toBe(200);
  const raw = (await rawResponse.text()).replace(/\r?\n[ \t]+/g, ' ');
  const links = Array.from(raw.matchAll(/^List-Unsubscribe: (.+)$/gim), (match) => match[1]);
  expect(links).toHaveLength(1);
  expect(links[0]?.trim()).toMatch(
    /^<https:\/\/crm\.example\.test\/unsubscribe\/[A-Za-z0-9_-]{43}>$/,
  );
  const oneClick = Array.from(raw.matchAll(/^List-Unsubscribe-Post: (.+)$/gim), (match) =>
    match[1]?.trim(),
  );
  expect(oneClick).toEqual(['List-Unsubscribe=One-Click']);
  expect(delivered).toMatchObject([
    {
      from: 'sender@example.test',
      subject: 'Outbound fixture',
      text: 'Plain body',
      html: '<p>HTML body</p>',
    },
  ]);
  const state = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages')
      .select(['status', 'provider_message_id'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow(),
  );
  expect(state).toEqual({
    status: 'sent',
    provider_message_id: `<crm-outbound.${messageId}@crm.invalid>`,
  });
});

it('omits unsubscribe headers from transactional email and refuses marketing before reservation on an HTTP public URL', async () => {
  const f = await fixture();
  await withTenant(db, f.context, (trx) =>
    trx
      .insertInto('messaging.consents')
      .values({
        business_id: requireBusiness(f.context),
        contact_id: sql<string>`(select contact_id from crm.contact_identities where id=${f.ids.identityId}::uuid)`,
        channel: 'email',
        purpose: 'transactional',
        status: 'granted',
        source: 'user',
        recorded_by_kind: 'system',
      })
      .execute(),
  );
  const transactionalId = await f.queue({ purpose: 'transactional', lane: 'transactional' });
  const task = createSmtpDispatchTask(
    vault,
    createMailboxConnector({
      ca: mail.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([mail.address]),
    }),
    db,
    'http://crm.example.test',
  );
  await task.run({ messageId: transactionalId }, { invocation: f.invocation, services });
  const delivered = await mailbox(mail).messagesTo(f.recipient);
  expect(delivered).toHaveLength(1);
  const response = await fetch(`${mail.apiUrl}/api/v1/message/${delivered[0]?.id ?? ''}/raw`);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toMatch(/^List-Unsubscribe(?:-Post)?:/im);
  const marketingId = await f.queue();
  await task.run({ messageId: marketingId }, { invocation: f.invocation, services });
  const journal = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.outbound_dispatch as d')
      .innerJoin('messaging.messages as m', 'm.id', 'd.id')
      .select(['m.status', 'm.error_code', 'd.reserved_at'])
      .where('d.id', '=', marketingId)
      .executeTakeFirstOrThrow(),
  );
  expect(journal).toEqual({
    status: 'failed',
    error_code: 'unsubscribe_unavailable',
    reserved_at: null,
  });
  expect(
    await withTenant(db, f.context, (trx) =>
      trx.selectFrom('messaging.unsubscribe_links').select('digest').execute(),
    ),
  ).toEqual([]);
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(1);
});

it('saves explicit limits through the authorized command, preserving a provider pause and isolating foreign settings', async () => {
  const f = await fixture();
  const other = await fixture();
  const id = toPublicId('mailbox', f.ids.accountId);
  const settings = {
    dailyLimit: 80,
    pacingPerMinute: 3,
    warmupEnabled: false,
    useForConversations: true,
    useForCampaigns: false,
  };
  const saved = await runCommand(
    services,
    updateMailboxSendingCommand,
    { id, settings },
    f.invocation,
  );
  expect(saved).toMatchObject({ ...settings, effectiveAutomatedDailyLimit: 80, pausedUntil: null });
  expect(await withTenant(db, f.context, (trx) => readMailboxSendingSettings(trx, id))).toEqual(
    saved,
  );
  await expect(
    runCommand(services, updateMailboxSendingCommand, { id, settings }, other.invocation),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    withTenant(db, other.context, (trx) => readMailboxSendingSettings(trx, id)),
  ).rejects.toBeInstanceOf(NotFoundError);
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "update messaging.mailboxes set sending_paused_until=now()+interval '15 minutes',sending_pause_reason='provider_temporary'",
    ),
  );
  const stillHeld = await runCommand(
    services,
    updateMailboxSendingCommand,
    { id, settings: { ...settings, warmupEnabled: true } },
    f.invocation,
  );
  expect(stillHeld).toMatchObject({
    effectiveAutomatedDailyLimit: 50,
    pauseReason: 'provider_temporary',
  });
  expect(stillHeld.pausedUntil).not.toBeNull();
});

it('atomically admits only one concurrent message at a mailbox daily cap and leaves the other unreserved', async () => {
  const f = await fixture();
  await withTenant(db, f.context, (trx) =>
    trx
      .updateTable('messaging.mailboxes')
      .set({ daily_limit: 1 })
      .where('id', '=', f.ids.accountId)
      .execute(),
  );
  const ids = await Promise.all([f.queue(), f.queue()]);
  await Promise.all(
    ids.map((messageId) => f.task().run({ messageId }, { invocation: f.invocation, services })),
  );
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(1);
  const states = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages as m')
      .innerJoin('messaging.outbound_dispatch as d', 'd.id', 'm.id')
      .select(['m.id', 'm.status', 'm.error_code', 'm.scheduled_for', 'd.reserved_at'])
      .orderBy('d.reserved_at')
      .execute(),
  );
  expect(states).toMatchObject([
    { status: 'sent' },
    { status: 'queued', error_code: 'mailbox_daily_limit', reserved_at: null },
  ]);
  expect(states[1]?.scheduled_for?.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  const sent = states[0];
  const queued = states[1];
  if (sent === undefined || queued === undefined) throw new Error('Missing budget states.');
  await database.withTenant(f.context, async (sql) => {
    await sql.query(
      "update messaging.outbound_dispatch set reserved_at=now()-interval '25 hours' where id=$1",
      [sent.id],
    );
    await sql.query(
      "update messaging.messages set scheduled_for=now()-interval '1 second' where id=$1",
      [queued.id],
    );
  });
  await f.task().run({ messageId: queued.id }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(2);
});

it('paces successive submissions without claiming a send and resumes after the reservation window', async () => {
  const f = await fixture();
  const first = await f.queue();
  const second = await f.queue();
  await f.task().run({ messageId: first }, { invocation: f.invocation, services });
  await f.task().run({ messageId: second }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(1);
  const held = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages')
      .select(['status', 'error_code'])
      .where('id', '=', second)
      .executeTakeFirstOrThrow(),
  );
  expect(held).toEqual({ status: 'queued', error_code: 'mailbox_pacing' });
  await database.withTenant(f.context, async (sql) => {
    await sql.query(
      "update messaging.outbound_dispatch set reserved_at=now()-interval '1 minute' where id=$1",
      [first],
    );
    await sql.query(
      "update messaging.messages set scheduled_for=now()-interval '1 second' where id=$1",
      [second],
    );
  });
  await f.task().run({ messageId: second }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(2);
});

it('holds only the refused mailbox after a provider temporary refusal, leaving other mailboxes active', async () => {
  const f = await fixture();
  const otherAccount = await database.withTenant(f.context, async (sql) => {
    const channel = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values(app.business_id(),'email','Other sender') returning id",
    );
    await sql.query(
      "insert into messaging.mailboxes (business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id,use_for_campaigns) select business_id,$1,'other@example.test',auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id,true from messaging.mailboxes where id=$2",
      [channel.id, f.ids.accountId],
    );
    return channel.id;
  });
  let attempts = 0;
  const limited = createSmtpDispatchTask(
    vault,
    {
      submit: () => {
        attempts += 1;
        return Promise.resolve({ outcome: 'rejected', temporary: true } as const);
      },
    },
    db,
    'https://crm.example.test',
  );
  const first = await f.queue();
  const second = await f.queue();
  await limited.run({ messageId: first }, { invocation: f.invocation, services });
  await limited.run({ messageId: second }, { invocation: f.invocation, services });
  expect(attempts).toBe(1);
  const held = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages')
      .select(['status', 'error_code'])
      .where('id', '=', second)
      .executeTakeFirstOrThrow(),
  );
  expect(held).toEqual({ status: 'queued', error_code: 'provider_temporary' });
  const channel = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.channel_accounts')
      .select('status')
      .where('id', '=', f.ids.accountId)
      .executeTakeFirstOrThrow(),
  );
  expect(channel.status).toBe('active');
  const another = await f.queue({ accountId: otherAccount });
  await f.task().run({ messageId: another }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toMatchObject([
    { from: 'other@example.test' },
  ]);
});

it('enforces the first-day automated allowance while permitting a reply, then honors disabling warmup', async () => {
  const f = await fixture();
  await database.withTenant(f.context, (sql) =>
    sql.query("update messaging.mailboxes set warmup_started_at=now()-interval '18 hours'"),
  );
  await withTenant(db, f.context, (trx) =>
    trx.updateTable('messaging.settings').set({ contact_daily_limit: 1000 }).execute(),
  );
  for (let count = 0; count < 50; count += 1) await f.queue();
  await database.withTenant(f.context, async (sql) => {
    await sql.query(
      "update messaging.outbound_dispatch set reserved_at=now()-interval '1 minute',finished_at=now()-interval '1 minute'",
    );
    await sql.query(
      "update messaging.messages set status='sent',sent_at=now()-interval '1 minute'",
    );
  });
  const heldId = await f.queue();
  await f.task().run({ messageId: heldId }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(0);
  const held = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages')
      .select(['status', 'error_code'])
      .where('id', '=', heldId)
      .executeTakeFirstOrThrow(),
  );
  expect(held).toEqual({ status: 'queued', error_code: 'mailbox_warmup_limit' });
  const schedule = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages')
      .select('scheduled_for')
      .where('id', '=', heldId)
      .executeTakeFirstOrThrow(),
  );
  expect(schedule.scheduled_for?.getTime()).toBeGreaterThan(Date.now() + 5.9 * 3_600_000);
  expect(schedule.scheduled_for?.getTime()).toBeLessThan(Date.now() + 6.1 * 3_600_000);
  const replyId = await f.queue({ lane: 'reply', html: undefined, subject: undefined });
  await f.task().run({ messageId: replyId }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(1);
  await database.withTenant(f.context, async (sql) => {
    await sql.query('update messaging.mailboxes set warmup_enabled=false');
    await sql.query(
      "update messaging.outbound_dispatch set reserved_at=now()-interval '1 minute' where id=$1",
      [replyId],
    );
    await sql.query(
      "update messaging.messages set scheduled_for=now()-interval '1 second' where id=$1",
      [heldId],
    );
  });
  await f.task().run({ messageId: heldId }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(2);
});

it('refuses mailbox-use mismatches and foreign mailbox jobs without SMTP access', async () => {
  const f = await fixture();
  const foreign = await fixture();
  await withTenant(db, f.context, (trx) =>
    trx
      .updateTable('messaging.mailboxes')
      .set({ use_for_campaigns: false, use_for_conversations: false })
      .execute(),
  );
  for (const lane of ['campaign', 'reply'] as const) {
    const messageId = await f.queue({ lane });
    await f.task().run({ messageId }, { invocation: foreign.invocation, services });
    await f.task().run({ messageId }, { invocation: f.invocation, services });
    const state = await withTenant(db, f.context, (trx) =>
      trx
        .selectFrom('messaging.messages')
        .select(['status', 'error_code'])
        .where('id', '=', messageId)
        .executeTakeFirstOrThrow(),
    );
    expect(state).toEqual({ status: 'failed', error_code: 'mailbox_use_disabled' });
  }
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(0);
});

it('refuses an email account without a mailbox and an unsupported SMS account before submission', async () => {
  const f = await fixture();
  const ids = await database.withTenant(f.context, async (sql) => {
    const email = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values(app.business_id(),'email','Missing mailbox') returning id",
    );
    const sms = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values(app.business_id(),'sms','SMS') returning id",
    );
    const phone = await sql.one<{ id: string }>(
      "insert into crm.contact_identities(business_id,contact_id,kind,value,value_normalized) select business_id,contact_id,'phone','+254700000001','+254700000001' from crm.contact_identities where id=$1 returning id",
      [f.ids.identityId],
    );
    await sql.query(
      "insert into messaging.consents(business_id,contact_id,channel,purpose,status,source,recorded_by_kind) select business_id,contact_id,'sms','marketing','granted','user','system' from crm.contact_identities where id=$1",
      [phone.id],
    );
    return { email, sms, phone };
  });
  const emailId = await f.queue({ accountId: ids.email.id });
  const smsId = await f.queue({ accountId: ids.sms.id, identityId: ids.phone.id, channel: 'sms' });
  for (const messageId of [emailId, smsId])
    await f.task().run({ messageId }, { invocation: f.invocation, services });
  const states = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages')
      .select(['status', 'error_code'])
      .orderBy('created_at')
      .execute(),
  );
  expect(states).toEqual([
    { status: 'failed', error_code: 'mailbox_unavailable' },
    { status: 'failed', error_code: 'unsupported_channel' },
  ]);
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(0);
});

it.each(['unknown', 'permanent'] as const)(
  'never retries an %s SMTP result or pauses an unrelated mailbox',
  async (outcome) => {
    const f = await fixture();
    let attempts = 0;
    const sender = createSmtpDispatchTask(
      vault,
      {
        submit: () => {
          attempts += 1;
          return Promise.resolve(
            outcome === 'unknown'
              ? ({ outcome: 'unknown' } as const)
              : ({ outcome: 'rejected', temporary: false } as const),
          );
        },
      },
      db,
      'https://crm.example.test',
    );
    const messageId = await f.queue();
    await sender.run({ messageId }, { invocation: f.invocation, services });
    await sender.run({ messageId }, { invocation: f.invocation, services });
    expect(attempts).toBe(1);
    const row = await withTenant(db, f.context, (trx) =>
      trx
        .selectFrom('messaging.mailboxes')
        .select('sending_paused_until')
        .executeTakeFirstOrThrow(),
    );
    expect(row.sending_paused_until).toBeNull();
  },
);

it('refuses marketing email while the business profile has no postal address, and sends transactional mail', async () => {
  const f = await fixture(false);
  const marketing = await f.queue();
  await f.task().run({ messageId: marketing }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toEqual([]);
  await database.withTenant(f.context, (sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       select app.business_id(), contact_id, 'email', 'transactional', 'granted', 'user', 'system'
       from crm.contact_identities where value_normalized = $1`,
      [f.recipient],
    ),
  );
  const transactional = await f.queue({ purpose: 'transactional', lane: 'transactional' });
  await f.task().run({ messageId: transactional }, { invocation: f.invocation, services });
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(1);
  expect(
    await withTenant(db, f.context, (trx) =>
      trx
        .selectFrom('messaging.messages')
        .select(['id', 'status', 'error_code'])
        .where('id', 'in', [marketing, transactional])
        .orderBy('created_at')
        .execute(),
    ),
  ).toEqual([
    { id: marketing, status: 'failed', error_code: 'postal_address_missing' },
    { id: transactional, status: 'sent', error_code: null },
  ]);
});
