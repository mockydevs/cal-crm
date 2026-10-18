// One email to a contact from another module, with a file, on real Postgres and a real SMTP
// server: what is queued and where, what the pipeline refuses, and that the worker delivers
// the message with the file it carries or not at all.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createMailboxConnector } from '@repo/mail';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import {
  mailbox,
  startTlsMailpit,
  testDatabase,
  type TestDatabase,
  type TlsMailpitServer,
} from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  checkContactEmail,
  createSmtpDispatchTask,
  findContactEmail,
  holdContactEmail,
  queueContactEmail,
  queueOutboundMessage,
  type ContactEmailInput,
  type OutboundAttachmentReader,
} from './index.js';

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
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  ({ server: mail, stop: stopMail } = await startTlsMailpit());
});
afterAll(async () => {
  await stopMail?.();
  await db.destroy();
  await database.close();
});

/** The bytes of a file an email carries, as the files service would give them. */
const PDF = Buffer.from('%PDF-1.3\n% a fixture, not a document\n%%EOF\n');

async function fixture(settings: { readonly consent?: boolean } = {}) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const recipient = `maya.${randomUUID()}@example.test`;
  const contact = await database.fixtures.contact(context, { email: recipient });
  const login = {
    host: 'localhost',
    port: mail.smtpPort,
    security: 'tls',
    username: mail.username,
    password: mail.password,
  };
  const ids = await withTenant(db, context, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
      JSON.stringify({
        name: 'Billing',
        email: 'billing@example.test',
        displayName: 'Billing',
        smtp: login,
        imap: { ...login, port: 993 },
      }),
    );
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: business.id, channel: 'email', name: 'Billing' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.mailboxes')
      .values({
        business_id: business.id,
        id: account.id,
        email_address: 'billing@example.test',
        display_name: 'Billing',
        auth_method: 'password',
        smtp_host: login.host,
        smtp_port: login.port,
        smtp_security: 'tls',
        smtp_username: login.username,
        secret_id: secretId,
        // A new mailbox is warmed up slowly; this one sends at once.
        warmup_enabled: false,
      })
      .execute();
    await trx
      .insertInto('messaging.settings')
      .values({ business_id: business.id, quiet_hours_enabled: false })
      .execute();
    if (settings.consent !== false)
      await trx
        .insertInto('messaging.consents')
        .values({
          business_id: business.id,
          contact_id: contact.id,
          channel: 'email',
          purpose: 'transactional',
          status: 'granted',
          source: 'user',
          recorded_by_kind: 'system',
        })
        .execute();
    return { accountId: account.id };
  });
  /** A file of the business, as the files service records one. */
  const file = async (filename = 'INV-0007.pdf'): Promise<string> => {
    const row = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        `insert into files.files
           (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes,
            sha256, uploaded_by_kind)
         values ($1, $2, 'local', uuidv7()::text, $3, 'application/pdf', $4,
                 sha256($5::bytea), 'system') returning id`,
        [agency.id, business.id, filename, PDF.length, PDF],
      ),
    );
    return row.id;
  };
  const email = (changes: Partial<ContactEmailInput> = {}): ContactEmailInput => ({
    contactId: contact.id,
    to: recipient,
    idempotencyKey: `test:${randomUUID()}`,
    subject: 'Invoice INV-0007',
    text: 'Here is invoice INV-0007.',
    attachments: [],
    ...changes,
  });
  const queue = (changes: Partial<ContactEmailInput> = {}) =>
    withTenant(db, context, async (trx) => {
      await holdContactEmail(trx, context);
      return queueContactEmail(trx, context, email(changes));
    });
  const check = (changes: { readonly to?: string; readonly mailboxId?: string } = {}) =>
    withTenant(db, context, (trx) =>
      checkContactEmail(trx, context, { contactId: contact.id, to: recipient, ...changes }),
    );
  const stored = () =>
    database.as('crm_owner', (sql) =>
      sql.query<{
        id: string;
        status: string;
        error_code: string | null;
        purpose: string;
        lane: string;
        contact_id: string;
        to_addresses: string[];
        files: string[];
      }>(
        `select m.id, m.status, m.error_code, d.purpose, d.lane, v.contact_id, m.to_addresses,
                array(select a.file_id::text from messaging.message_attachments a
                      where a.business_id = m.business_id and a.message_id = m.id
                      order by a.id) as files
         from messaging.messages m
         join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
         join messaging.conversations v on v.business_id = m.business_id and v.id = m.conversation_id
         where m.business_id = $1 order by m.id`,
        [business.id],
      ),
    );
  const task = (readAttachment?: OutboundAttachmentReader) =>
    createSmtpDispatchTask(
      vault,
      createMailboxConnector({
        ca: mail.ca,
        allowedPrivateHosts: ['localhost'],
        resolve: () => Promise.resolve([mail.address]),
      }),
      db,
      'https://crm.example.test',
      readAttachment,
    );
  const dispatch = (messageId: string, readAttachment?: OutboundAttachmentReader) =>
    task(readAttachment).run(
      { messageId },
      { invocation: { context, permissions: 'all' }, services },
    );
  return {
    agency,
    business,
    context,
    contact,
    recipient,
    ids,
    file,
    queue,
    check,
    stored,
    dispatch,
  };
}

describe('queueing an email to a contact', () => {
  it('queues a transactional message in the contact’s conversation, with its files', async () => {
    const f = await fixture();
    const fileId = await f.file();
    const queued = await f.queue({ attachments: [toPublicId('file', fileId)] });
    expect(queued).toMatchObject({
      outcome: 'queued',
      to: f.recipient,
      deferred: false,
      repeated: false,
    });
    const [message, ...others] = await f.stored();
    expect(others).toEqual([]);
    expect(message).toMatchObject({
      status: 'queued',
      error_code: null,
      purpose: 'transactional',
      lane: 'transactional',
      contact_id: f.contact.id,
      to_addresses: [f.recipient],
      files: [fileId],
    });
    if (queued.outcome !== 'queued') throw new Error('Not queued.');
    expect(queued.messageId).toBe(toPublicId('message', message?.id ?? ''));
    expect(queued.conversationId).toMatch(/^cvn_/);
  });

  it('finds the email queued under a key before, and queues nothing twice', async () => {
    const f = await fixture();
    const idempotencyKey = `test:${randomUUID()}`;
    const first = await f.queue({ idempotencyKey });
    const found = await withTenant(db, f.context, (trx) =>
      findContactEmail(trx, f.context, idempotencyKey),
    );
    expect(found).toEqual({ ...first, repeated: true });
    // The same request again is the same message.
    expect(await f.queue({ idempotencyKey })).toEqual({ ...first, repeated: true });
    expect(await f.stored()).toHaveLength(1);
    expect(
      await withTenant(db, f.context, (trx) => findContactEmail(trx, f.context, 'never-sent')),
    ).toBeUndefined();
  });

  it('takes the address in any capitals, and only an address that is the contact’s', async () => {
    const f = await fixture();
    expect((await f.queue({ to: f.recipient.toUpperCase() })).outcome).toBe('queued');
    const other = await fixture();
    for (const to of ['someone.else@example.test', other.recipient]) {
      expect(await f.check({ to })).toEqual({ outcome: 'refused', reason: 'not_contacts_address' });
      expect(await f.queue({ to })).toEqual({ outcome: 'refused', reason: 'not_contacts_address' });
    }
    expect(await f.stored()).toHaveLength(1);
  });

  it('sends from the mailbox named, or the first that sends conversations, or refuses', async () => {
    const f = await fixture();
    const other = await fixture();
    expect((await f.queue({ mailboxId: toPublicId('mailbox', f.ids.accountId) })).outcome).toBe(
      'queued',
    );
    for (const mailboxId of [toPublicId('mailbox', other.ids.accountId), 'not-a-mailbox'])
      expect(await f.queue({ mailboxId })).toEqual({ outcome: 'refused', reason: 'no_mailbox' });
    await database.as('crm_owner', (sql) =>
      sql.query('update messaging.mailboxes set use_for_conversations = false where id = $1', [
        f.ids.accountId,
      ]),
    );
    expect(await f.check()).toEqual({ outcome: 'refused', reason: 'no_mailbox' });
    expect(await f.queue()).toEqual({ outcome: 'refused', reason: 'no_mailbox' });
  });

  it('says before queueing what the pipeline would refuse, and refuses it when queued', async () => {
    const f = await fixture({ consent: false });
    expect(await f.check()).toEqual({ outcome: 'refused', reason: 'consent_required' });
    expect(await f.queue()).toEqual({ outcome: 'refused', reason: 'consent_required' });
    // What the pipeline refused is stored as it stores any refusal, for the caller's
    // transaction to keep or undo.
    expect(await f.stored()).toMatchObject([{ status: 'failed', error_code: 'consent_required' }]);

    const g = await fixture();
    expect(await g.check()).toBeUndefined();
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into messaging.suppressions (business_id, channel, address_normalized, reason)
         values ($1, 'email', $2, 'hard_bounce')`,
        [g.business.id, g.recipient],
      ),
    );
    const suppressed = { outcome: 'refused', reason: 'suppressed', detail: 'hard_bounce' };
    expect(await g.check()).toEqual(suppressed);
    expect(await g.queue()).toEqual(suppressed);

    const h = await fixture();
    await database.as('crm_owner', (sql) =>
      sql.query("update crm.contacts set dnd_channels = '{email}' where id = $1", [h.contact.id]),
    );
    const disturbed = { outcome: 'refused', reason: 'do_not_contact', detail: 'channel' };
    expect(await h.check()).toEqual(disturbed);
    expect(await h.queue()).toEqual(disturbed);
    await database.as('crm_owner', (sql) =>
      sql.query(
        "update crm.contacts set dnd_channels = '{}', do_not_contact = true where id = $1",
        [h.contact.id],
      ),
    );
    expect(await h.check()).toEqual({ outcome: 'refused', reason: 'do_not_contact' });
  });

  it("never holds a person's own email for the daily cap, which counts workflow and campaign mail", async () => {
    const f = await fixture();
    await database.as('crm_owner', (sql) =>
      sql.query('update messaging.settings set contact_daily_limit = 1 where business_id = $1', [
        f.business.id,
      ]),
    );
    const first = await f.queue();
    if (first.outcome !== 'queued') throw new Error('Not queued.');
    const [message] = await f.stored();
    await f.dispatch(message?.id ?? '');
    expect(await f.check()).toBeUndefined();
    expect(await f.queue()).toMatchObject({ outcome: 'queued', deferred: false });
  });

  it('refuses a file that is not a file id, and carries files on email only', async () => {
    const f = await fixture();
    await expect(f.queue({ attachments: ['not-a-file'] })).rejects.toThrow(
      'An attachment is named by a file id.',
    );
    const fileId = await f.file();
    await expect(
      withTenant(db, f.context, (trx) =>
        queueOutboundMessage(trx, f.context, {
          identityId: randomUUID(),
          accountId: f.ids.accountId,
          channel: 'sms',
          purpose: 'transactional',
          lane: 'transactional',
          idempotencyKey: randomUUID(),
          text: 'Hello',
          attachments: [fileId],
        }),
      ),
    ).rejects.toThrow('Only an email carries attachments.');
  });
});

describe('delivering an email that carries a file', () => {
  const reader =
    (seen: string[] = []): OutboundAttachmentReader =>
    (_context, fileId) => {
      seen.push(fileId);
      return Promise.resolve({
        filename: 'INV-0007.pdf',
        contentType: 'application/pdf',
        content: PDF,
      });
    };

  it('submits the message with its file attached, once', async () => {
    const f = await fixture();
    const fileId = await f.file();
    await f.queue({ attachments: [toPublicId('file', fileId)] });
    const [message] = await f.stored();
    const seen: string[] = [];
    await f.dispatch(message?.id ?? '', reader(seen));
    await f.dispatch(message?.id ?? '', reader(seen));
    expect(seen).toEqual([fileId]);

    const [caught, ...more] = await mailbox(mail).messagesTo(f.recipient);
    expect(more).toEqual([]);
    expect(caught).toMatchObject({ from: 'billing@example.test', subject: 'Invoice INV-0007' });
    expect(caught?.text).toContain('Here is invoice INV-0007.');
    const raw = await (await fetch(`${mail.apiUrl}/api/v1/message/${caught?.id ?? ''}/raw`)).text();
    expect(raw).toMatch(/Content-Type: application\/pdf; name="?INV-0007\.pdf"?/);
    expect(raw).toMatch(/Content-Disposition: attachment; filename="?INV-0007\.pdf"?/);
    expect(raw).toContain(PDF.toString('base64'));
    // A transactional message carries no unsubscribe header.
    expect(raw).not.toMatch(/^List-Unsubscribe:/im);
    expect(await f.stored()).toMatchObject([{ status: 'sent' }]);
  });

  it('is not sent bare by a worker that cannot read files', async () => {
    const f = await fixture();
    await f.queue({ attachments: [toPublicId('file', await f.file())] });
    const [message] = await f.stored();
    await f.dispatch(message?.id ?? '');
    expect(await f.stored()).toMatchObject([
      { status: 'failed', error_code: 'attachments_unavailable' },
    ]);
    expect(await mailbox(mail).messagesTo(f.recipient)).toEqual([]);
  });

  it('is not sent when its file is gone, or its files are too large to send', async () => {
    const f = await fixture();
    await f.queue({ attachments: [toPublicId('file', await f.file())] });
    const [gone] = await f.stored();
    await f.dispatch(gone?.id ?? '', () => Promise.resolve(undefined));

    const g = await fixture();
    await g.queue({ attachments: [toPublicId('file', await g.file())] });
    const [large] = await g.stored();
    await g.dispatch(large?.id ?? '', () =>
      Promise.resolve({
        filename: 'large.pdf',
        contentType: 'application/pdf',
        content: new Uint8Array(15 * 1024 * 1024 + 1),
      }),
    );
    for (const each of [f, g]) {
      expect(await each.stored()).toMatchObject([
        { status: 'failed', error_code: 'delivery_rejected' },
      ]);
      expect(await mailbox(mail).messagesTo(each.recipient)).toEqual([]);
    }
  });

  it('delivers a message without files as it always did', async () => {
    const f = await fixture();
    await f.queue();
    const [message] = await f.stored();
    await f.dispatch(message?.id ?? '');
    const [caught] = await mailbox(mail).messagesTo(f.recipient);
    const raw = await (await fetch(`${mail.apiUrl}/api/v1/message/${caught?.id ?? ''}/raw`)).text();
    expect(raw).not.toContain('application/pdf');
    expect(await f.stored()).toMatchObject([{ status: 'sent' }]);
  });
});
