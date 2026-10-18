// Formatted email on real Postgres and a real SMTP conversation (Mailpit over TLS):
// templates that hold cleaned HTML beside their text, the picker's list, the rendered
// preview, and a workflow-lane email leaving as multipart with its own From name, Reply-To,
// Cc, Bcc, a file, the preview line and the marketing footer.
import { createHash, randomUUID } from 'node:crypto';
import {
  allowEveryone,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  messageTemplate,
  messageTemplateList,
  renderedEmailPreview,
  type MessageTemplate,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
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

import {
  composeEmail,
  createSmtpDispatchTask,
  createTemplateCommands,
  createTemplateRoutes,
  queueOutboundMessage,
  readTemplate,
  type OutboundInput,
} from './index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let vault: Vault;
let mail: TlsMailpitServer;
let stopMail: (() => Promise<void>) | undefined;
let routes: readonly ApiRoute[];
const templates = createTemplateCommands();
const PDF = Buffer.from('%PDF-1.4 fixture');

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
  routes = createTemplateRoutes({
    values: () =>
      Promise.resolve({ 'contact.firstName': 'Ada <b>', 'contact.email': 'ada@example.test' }),
    publicUrl: 'https://crm.example.test',
  });
});
afterAll(async () => {
  await stopMail?.();
  await db.destroy();
  await database.close();
});

async function fixture(address: Record<string, string> | null = null) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const context = {
    ...business.context,
    actorKind: 'user' as const,
    actorId: user.id,
    userId: user.id,
    correlationId: randomUUID(),
  };
  const invocation: Invocation = { context, permissions: 'all' };
  const recipient = `recipient.${randomUUID()}@example.test`;
  const contact = await database.fixtures.contact(context, { email: recipient });
  await database.as('postgres', (sql) =>
    sql.query(
      `update tenancy.businesses set name = 'Bluebird Dental', address = $2::jsonb where id = $1`,
      [business.id, address === null ? null : JSON.stringify(address)],
    ),
  );
  const call = async (
    operationId: string,
    request: { params?: unknown; query?: unknown; body?: unknown } = {},
    as: Invocation = invocation,
  ): Promise<unknown> => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`No route for ${operationId}.`);
    const answer = await route.run(
      {
        invocation: as,
        params: request.params ?? {},
        query: request.query ?? {},
        body: request.body,
      },
      services,
    );
    return route.endpoint.response.schema?.parse(answer);
  };
  return { agency, business, context, invocation, recipient, contact, call };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A mailbox that really sends, the contact's consent, and a queue on the workflow lane. */
async function sending(f: Fixture) {
  const login = {
    host: 'localhost',
    port: mail.smtpPort,
    security: 'tls',
    username: mail.username,
    password: mail.password,
  };
  const ids = await withTenant(db, f.context, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: f.agency.id, businessId: f.business.id, purpose: 'mailbox.credentials' },
      JSON.stringify({
        name: 'Fixture',
        email: 'sender@example.test',
        displayName: 'Mailbox Name',
        smtp: login,
        imap: { ...login, port: 993 },
      }),
    );
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: f.business.id, channel: 'email', name: 'Fixture' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.mailboxes')
      .values({
        business_id: f.business.id,
        id: account.id,
        email_address: 'sender@example.test',
        display_name: 'Mailbox Name',
        auth_method: 'password',
        smtp_host: 'localhost',
        smtp_port: mail.smtpPort,
        smtp_security: 'tls',
        smtp_username: mail.username,
        secret_id: secretId,
      })
      .execute();
    await trx
      .insertInto('messaging.settings')
      .values({ business_id: f.business.id, quiet_hours_enabled: false })
      .execute();
    await trx
      .insertInto('messaging.consents')
      .values({
        business_id: f.business.id,
        contact_id: f.contact.id,
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
      .where('contact_id', '=', f.contact.id)
      .executeTakeFirstOrThrow();
    return { identityId: identity.id, accountId: account.id };
  });
  const queue = (patch: Partial<OutboundInput> = {}) =>
    withTenant(db, f.context, (trx) =>
      queueOutboundMessage(trx, f.context, {
        ...ids,
        channel: 'email',
        purpose: 'marketing',
        lane: 'automation',
        idempotencyKey: randomUUID(),
        subject: 'Workflow fixture',
        text: 'Plain body',
        ...patch,
      }),
    );
  const read: string[] = [];
  const task = createSmtpDispatchTask(
    vault,
    createMailboxConnector({
      ca: mail.ca,
      allowedPrivateHosts: ['localhost'],
      resolve: () => Promise.resolve([mail.address]),
    }),
    db,
    'https://crm.example.test',
    (_context, fileId) => {
      read.push(fileId);
      return Promise.resolve({
        filename: 'price-list.pdf',
        contentType: 'application/pdf',
        content: PDF,
      });
    },
  );
  const send = (messageId: string) =>
    task.run({ messageId }, { invocation: f.invocation, services });
  const raw = async (to: string): Promise<string> => {
    const [caught] = await mailbox(mail).messagesTo(to);
    const response = await fetch(`${mail.apiUrl}/api/v1/message/${caught?.id ?? ''}/raw`);
    expect(response.status).toBe(200);
    return (await response.text()).replace(/\r\n/g, '\n');
  };
  const file = async (): Promise<string> => {
    const [row] = await database.as('postgres', (sql) =>
      sql.query<{ id: string }>(
        `insert into files.files
           (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes,
            sha256, uploaded_by_kind)
         values ($1, $2, 'local', uuidv7()::text, 'price-list.pdf', 'application/pdf', $3,
                 sha256($4::bytea), 'system') returning id`,
        [f.agency.id, f.business.id, PDF.length, PDF],
      ),
    );
    if (row === undefined) throw new Error('The file was not stored.');
    return row.id;
  };
  return { ids, queue, send, raw, file, read };
}

const create = (f: Fixture, input: Record<string, unknown>): Promise<MessageTemplate> =>
  runCommand(services, templates.create, input as never, f.invocation);

it('stores a formatted template cleaned, with its text written from it, and leaves a plain one as it was', async () => {
  const f = await fixture();
  const plain = await create(f, {
    name: 'Plain',
    subject: 'Hello',
    body: 'Hi {{contact.firstName}}',
  });
  expect(plain).toMatchObject({
    format: 'text',
    body: 'Hi {{contact.firstName}}',
    content: { format: 'text', text: 'Hi {{contact.firstName}}' },
    preheader: null,
    folder: null,
    preview: 'Hi {{contact.firstName}}',
  });
  const formatted = messageTemplate.parse(
    await create(f, {
      name: 'Formatted',
      subject: 'Welcome {{contact.firstName}}',
      content: {
        format: 'html',
        html:
          '<h1 onclick="steal()">Welcome {{contact.firstName}}</h1><script>alert(1)</script>' +
          '<p style="color:#333333;position:fixed">Read <a href="javascript:alert(1)">this</a> or ' +
          '<a href="https://example.com/guide">the guide</a>.</p><img src="/m/k1/logo.png" alt="Logo">',
      },
      preheader: 'A quick hello',
    }),
  );
  expect(formatted.content).toEqual({
    format: 'html',
    html:
      '<h1>Welcome {{contact.firstName}}</h1><p style="color:#333333">Read <a>this</a> or ' +
      '<a href="https://example.com/guide" target="_blank" rel="noopener noreferrer">the guide</a>.</p>' +
      '<img src="/m/k1/logo.png" alt="Logo">',
    text: 'Welcome {{contact.firstName}}\n\nRead this or the guide (https://example.com/guide).\n\n[Logo]',
  });
  expect(formatted).toMatchObject({
    format: 'html',
    preheader: 'A quick hello',
    body: formatted.content.text,
    mergeFields: ['contact.firstName'],
    preview:
      'Welcome {{contact.firstName}} Read this or the guide (https://example.com/guide). [Logo]',
  });
  // The author's own text part is kept as written.
  const own = await create(f, {
    name: 'Own text',
    subject: 'Hello',
    content: { format: 'html', html: '<p>Formatted</p>', text: 'My own words' },
  });
  expect(own.body).toBe('My own words');
  // A plain template's revision is the hash it had before templates could be formatted.
  const [row] = await database.as('postgres', (sql) =>
    sql.query<{ id: string; version: string }>(
      `select id, extract(epoch from updated_at)::text as version
       from messaging.templates where business_id = $1 and name = 'Plain'`,
      [f.business.id],
    ),
  );
  expect(plain.revision).toBe(
    createHash('sha256')
      .update(
        JSON.stringify([
          row?.id,
          row?.version,
          'Plain',
          'Hello',
          createHash('sha256').update('Hi {{contact.firstName}}').digest('hex'),
          null,
        ]),
      )
      .digest('hex'),
  );
});

it('refuses content given twice, missing, empty, too long, or preview text on plain text', async () => {
  const f = await fixture();
  const refusal = async (input: Record<string, unknown>) => {
    const error: unknown = await create(f, {
      name: `T ${randomUUID()}`,
      subject: 'S',
      ...input,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).issues.map((issue) => `${issue.path} ${issue.code}`);
  };
  expect(await refusal({})).toEqual(['/content content_required']);
  expect(await refusal({ body: 'a', content: { format: 'text', text: 'b' } })).toEqual([
    '/content content_twice',
  ]);
  expect(await refusal({ body: 'a', preheader: 'p' })).toEqual(['/preheader preheader_needs_html']);
  expect(
    await refusal({ content: { format: 'html', html: '<script>x</script><p> </p>' } }),
  ).toEqual(['/content/html empty']);
  expect(
    await refusal({ content: { format: 'html', html: '<img src="https://x.test/a.png">' } }),
  ).toEqual(['/content/text text_required']);
  // Nothing was saved by any of them.
  const list = messageTemplateList.parse(await f.call('listMessageTemplates'));
  expect(list.items).toEqual([]);
});

it('edits a formatted template under its revision, and back to plain text', async () => {
  const f = await fixture();
  const made = await create(f, {
    name: 'Offer',
    subject: 'Offer',
    content: { format: 'html', html: '<p>One</p>' },
    preheader: 'First',
  });
  const edit = (revision: string, input: Record<string, unknown>) =>
    runCommand(
      services,
      templates.update,
      { id: made.id, revision, name: 'Offer', subject: 'Offer', ...input },
      f.invocation,
    );
  const same = await edit(made.revision, {
    content: { format: 'html', html: '<p>One</p>' },
    preheader: 'First',
  });
  expect(same.revision).toBe(made.revision);
  const changed = await edit(made.revision, {
    content: { format: 'html', html: '<p>Two</p>' },
    preheader: 'First',
  });
  expect(changed.revision).not.toBe(made.revision);
  expect(changed.content).toEqual({ format: 'html', html: '<p>Two</p>', text: 'Two' });
  const preheader = await edit(changed.revision, {
    content: { format: 'html', html: '<p>Two</p>' },
  });
  expect(preheader.preheader).toBeNull();
  expect(preheader.revision).not.toBe(changed.revision);
  await expect(edit(made.revision, { body: 'stale' })).rejects.toThrow(/changed after you opened/);
  const plain = await edit(preheader.revision, { body: 'Plain again' });
  expect(plain).toMatchObject({ format: 'text', content: { format: 'text', text: 'Plain again' } });
  expect(
    await withTenant(db, f.context, (trx) => readTemplate(trx, f.invocation, made.id)),
  ).toMatchObject({
    body: 'Plain again',
    format: 'text',
  });
});

it('lists templates for a picker: by name or subject, with folder path, format and a preview, a page at a time', async () => {
  const f = await fixture();
  const other = await fixture();
  const guides = (await f.call('createMessageTemplateFolder', { body: { name: 'Guides' } })) as {
    id: string;
  };
  const pricing = (await f.call('createMessageTemplateFolder', {
    body: { name: 'Pricing', parentId: guides.id },
  })) as { id: string };
  await create(f, {
    name: 'Alpha',
    subject: 'Winter offer',
    body: 'First\n\nsecond   line',
    folderId: pricing.id,
  });
  await create(f, {
    name: 'Bravo offer',
    subject: 'Hello',
    content: { format: 'html', html: '<p>Formatted</p>' },
  });
  await create(f, { name: 'Charlie', subject: 'Nothing', body: 'x'.repeat(400) });
  await create(other, { name: 'Other offer', subject: 'offer', body: 'x' });
  const list = async (query: Record<string, unknown>) =>
    messageTemplateList.parse(await f.call('listMessageTemplates', { query }));
  const found = await list({ q: 'OFFER' });
  expect(
    found.items.map((item) => [item.name, item.format, item.folder?.path ?? null, item.preview]),
  ).toEqual([
    ['Alpha', 'text', ['Guides', 'Pricing'], 'First second line'],
    ['Bravo offer', 'html', null, 'Formatted'],
  ]);
  expect(found.items[0]?.folder).toEqual({
    id: pricing.id,
    name: 'Pricing',
    path: ['Guides', 'Pricing'],
  });
  // A search treats % and _ as the characters they are.
  expect((await list({ q: '%' })).items).toEqual([]);
  const first = await list({ limit: 2 });
  expect(first.items.map((item) => item.name)).toEqual(['Alpha', 'Bravo offer']);
  expect(first.nextCursor).toBe(first.items[1]?.id);
  // Every template that matches, on every page together.
  expect(first.total).toBe(3);
  const second = await list({ limit: 2, after: first.nextCursor });
  expect(second.items.map((item) => item.name)).toEqual(['Charlie']);
  expect(second.nextCursor).toBeNull();
  expect(second.total).toBe(3);
  expect(found.total).toBe(found.items.length);
  expect((await list({ q: '%' })).total).toBe(0);
  // Nobody told this reader what workflows use: it says it cannot tell.
  expect(first.items.map((item) => item.workflowUses)).toEqual([null, null]);
  expect(second.items[0]?.preview).toHaveLength(140);
  expect(second.items[0]?.preview.endsWith('…')).toBe(true);
  expect((await list({ q: 'offer', folder: pricing.id })).items.map((item) => item.name)).toEqual([
    'Alpha',
  ]);
});

it('previews a template for a contact as a workflow would send it, and lists what is unfilled', async () => {
  const f = await fixture({
    line1: '12 High St',
    line2: '',
    city: 'Austin',
    region: 'TX',
    postalCode: '78701',
    country: 'US',
  });
  const template = await create(f, {
    name: 'Welcome',
    subject: 'Welcome {{contact.firstName}}',
    content: {
      format: 'html',
      html: '<p>Hi {{contact.firstName}}, about {{contact.custom.plan}}</p><p><a href="{{trigger_link.book}}">Book</a><img src="/m/k/a.png" alt="A"></p>',
    },
    preheader: 'For {{contact.firstName}}',
  });
  const preview = renderedEmailPreview.parse(
    await f.call('renderEmailPreview', {
      body: { template: template.id, contact: toPublicId('contact', f.contact.id) },
    }),
  );
  expect(preview).toEqual({
    subject: 'Welcome Ada <b>',
    preheader: 'For Ada <b>',
    html:
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">For Ada &lt;b&gt;</div>' +
      '<p>Hi Ada &lt;b&gt;, about {{contact.custom.plan}}</p><p>' +
      '<a href="https://trigger-link.invalid/book" target="_blank" rel="noopener noreferrer">Book</a>' +
      '<img src="https://crm.example.test/m/k/a.png" alt="A"></p>' +
      '<p style="font-size:12px;color:#666666">Bluebird Dental, 12 High St, Austin, TX 78701, US<br>' +
      '<a href="https://unsubscribe.invalid/link" target="_blank" rel="noopener noreferrer">Unsubscribe</a></p>',
    text:
      'Hi Ada <b>, about {{contact.custom.plan}}\n\nBook (https://trigger-link.invalid/book)[A]\n\n--\n' +
      'Bluebird Dental, 12 High St, Austin, TX 78701, US\nUnsubscribe: https://unsubscribe.invalid/link\n',
    mergeFields: ['contact.firstName', 'contact.custom.plan', 'trigger_link.book'],
    missingFields: ['contact.custom.plan'],
    subjectLineBreak: [],
  });
  // Sample values win over the contact's, a step's own subject over the template's, and
  // the footer can be left off.
  const sample = renderedEmailPreview.parse(
    await f.call('renderEmailPreview', {
      body: {
        template: template.id,
        contact: toPublicId('contact', f.contact.id),
        subject: 'Only for {{contact.firstName}}',
        values: { 'contact.firstName': 'Grace\nHopper', 'contact.custom.plan': 'Gold' },
        footer: false,
      },
    }),
  );
  expect(sample).toMatchObject({
    subject: 'Only for Grace Hopper',
    missingFields: [],
    subjectLineBreak: ['contact.firstName'],
  });
  expect(sample.text).toBe(
    'Hi Grace\nHopper, about Gold\n\nBook (https://trigger-link.invalid/book)[A]',
  );
  expect(sample.html).not.toContain('Unsubscribe');
});

it('previews unsaved content, cleaned, and refuses a foreign template or contact', async () => {
  const f = await fixture();
  const other = await fixture();
  const theirs = await create(other, { name: 'Theirs', subject: 'S', body: 'B' });
  const unsaved = renderedEmailPreview.parse(
    await f.call('renderEmailPreview', {
      body: {
        subject: 'Hi {{contact.firstName}}',
        content: { format: 'html', html: '<p onclick="x()">Hello<script>1</script></p>' },
        preheader: 'Peek',
        values: { 'contact.firstName': 'Ada' },
        footer: false,
      },
    }),
  );
  expect(unsaved).toMatchObject({
    subject: 'Hi Ada',
    preheader: 'Peek',
    html: '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Peek</div><p>Hello</p>',
    text: 'Hello',
  });
  const plain = renderedEmailPreview.parse(
    await f.call('renderEmailPreview', {
      body: { subject: 'S', content: { format: 'text', text: 'Body {{contact.email}}' } },
    }),
  );
  // No address on the business profile: the footer is the unsubscribe line alone.
  expect(plain).toMatchObject({
    html: null,
    preheader: null,
    text: 'Body {{contact.email}}\n\n--\nUnsubscribe: https://unsubscribe.invalid/link\n',
    missingFields: ['contact.email'],
  });
  await expect(
    f.call('renderEmailPreview', { body: { template: theirs.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    f.call('renderEmailPreview', {
      body: {
        subject: 'S',
        content: { format: 'text', text: 'B' },
        contact: toPublicId('contact', other.contact.id),
      },
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(f.call('renderEmailPreview', { body: { subject: 'S' } })).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(
    f.call('renderEmailPreview', {
      body: { template: theirs.id, content: { format: 'text', text: 'B' } },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('sends a workflow email as multipart with its From name, Reply-To, Cc, Bcc, a file and the footer', async () => {
  const f = await fixture({
    line1: '12 High St',
    line2: 'Suite 4',
    city: 'Austin',
    region: 'TX',
    postalCode: '78701',
    country: 'US',
  });
  const s = await sending(f);
  const cc = `cc.${randomUUID()}@example.test`;
  const bcc = `bcc.${randomUUID()}@example.test`;
  const fileId = await s.file();
  const messageId = await s.queue({
    text: 'Hello Ada',
    html: '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Peek</div><p>Hello <strong>Ada</strong></p>',
    fromName: 'Dr. Grace',
    replyTo: 'frontdesk@example.test',
    cc: [cc],
    bcc: [bcc],
    attachments: [fileId],
  });
  await s.send(messageId);
  const raw = await s.raw(f.recipient);
  // A header's value with its folded lines joined, as a mail app reads it.
  const header = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*(?:\\n[ \\t].+)*)$`, 'im')
      .exec(raw)?.[1]
      ?.replace(/\n[ \t]+/g, ' ')
      .trim();
  expect(header('From')).toBe('"Dr. Grace" <sender@example.test>');
  expect(header('Reply-To')).toBe('frontdesk@example.test');
  expect(header('To')).toBe(f.recipient);
  // The email with the contact's unsubscribe link is the contact's alone: nobody is copied
  // on it. Cc and Bcc get a copy of their own (the next test).
  expect(header('Cc')).toBeUndefined();
  const [envelope] = await mailbox(mail).messagesTo(f.recipient);
  const accepted = (await (
    await fetch(`${mail.apiUrl}/api/v1/message/${envelope?.id ?? ''}`)
  ).json()) as { Cc?: { Address: string }[]; Bcc?: { Address: string }[] };
  // Every recipient the mail server accepted the message for.
  expect(accepted.Cc ?? []).toEqual([]);
  expect(accepted.Bcc ?? []).toEqual([]);
  expect(header('List-Unsubscribe')).toMatch(
    /^<https:\/\/crm\.example\.test\/unsubscribe\/[A-Za-z0-9_-]{43}>$/,
  );
  expect(header('Content-Type')).toMatch(/^multipart\/mixed;/);
  expect(raw).toMatch(/Content-Type: multipart\/alternative;/);
  expect(raw).toMatch(/Content-Type: text\/plain; charset=utf-8/);
  expect(raw).toMatch(/Content-Type: text\/html; charset=utf-8/);
  expect(raw).toMatch(/Content-Type: application\/pdf; name=price-list\.pdf/);
  expect(raw).toMatch(/Content-Disposition: attachment; filename=price-list\.pdf/);
  expect(s.read).toEqual([fileId]);
  const [caught] = await mailbox(mail).messagesTo(f.recipient);
  const text = (caught?.text ?? '').replace(/\r\n/g, '\n');
  const link = /Unsubscribe: (https:\/\/crm\.example\.test\/unsubscribe\/[A-Za-z0-9_-]{43})\n/.exec(
    text,
  )?.[1];
  expect(link).toBeDefined();
  expect(text).toBe(
    `Hello Ada\n\n--\nBluebird Dental, 12 High St, Suite 4, Austin, TX 78701, US\nUnsubscribe: ${link ?? ''}\n`,
  );
  expect(caught?.html).toBe(
    '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Peek</div><p>Hello <strong>Ada</strong></p>' +
      '<p style="font-size:12px;color:#666666">Bluebird Dental, 12 High St, Suite 4, Austin, TX 78701, US<br>' +
      `<a href="${link ?? ''}">Unsubscribe</a></p>`,
  );
  // What is stored is what was queued: the footer belongs to the mail, not to the message.
  const stored = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages as m')
      .innerJoin('messaging.outbound_dispatch as d', 'd.id', 'm.id')
      .select([
        'm.status',
        'm.body_text',
        'm.cc_addresses',
        'm.bcc_addresses',
        'd.from_name',
        'd.reply_to',
      ])
      .where('m.id', '=', messageId)
      .executeTakeFirstOrThrow(),
  );
  expect(stored).toEqual({
    status: 'sent',
    body_text: 'Hello Ada',
    cc_addresses: [cc],
    bcc_addresses: [bcc],
    from_name: 'Dr. Grace',
    reply_to: 'frontdesk@example.test',
  });
});

it('sends Cc and Bcc a copy of their own, with no unsubscribe link and no unsubscribe header', async () => {
  const f = await fixture({
    line1: '12 High St',
    city: 'Austin',
    region: 'TX',
    postalCode: '78701',
  });
  const s = await sending(f);
  const [first, second] = [`cc1.${randomUUID()}@example.test`, `cc2.${randomUUID()}@example.test`];
  const bcc = `bcc.${randomUUID()}@example.test`;
  // The author placed the link in the body, in both parts.
  await s.send(
    await s.queue({
      text: 'Hello Ada\nStop: {{email.unsubscribe_link}}'.replace(
        '{{email.unsubscribe_link}}',
        'https://unsubscribe.invalid/link',
      ),
      html: '<p>Hello Ada</p><p><a href="https://unsubscribe.invalid/link">Stop these emails</a></p>',
      cc: [first, second],
      bcc: [bcc],
    }),
  );
  const LINK = /https:\/\/crm\.example\.test\/unsubscribe\/[A-Za-z0-9_-]{43}/;
  // The contact's own email: the working link, the header, and nobody copied.
  const own = (await s.raw(f.recipient)).replace(/\n[ \t]+/g, ' ');
  expect(own).toMatch(/^List-Unsubscribe: </m);
  expect(own).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  expect(own).not.toMatch(/^Cc:/m);
  const [ownCaught] = await mailbox(mail).messagesTo(f.recipient);
  expect(ownCaught?.text).toMatch(LINK);

  // One copy for the Cc addresses together, who see each other; the Bcc address rides on
  // it unseen. It is another message: its own id, no List-Unsubscribe, no link anywhere.
  const copies = await mailbox(mail).messagesTo(first);
  expect(copies).toHaveLength(1);
  const copy = await s.raw(first);
  const header = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*(?:\\n[ \\t].+)*)$`, 'im')
      .exec(copy)?.[1]
      ?.replace(/\n[ \t]+/g, ' ')
      .trim();
  expect(header('To')).toBe(first);
  expect(header('Cc')).toBe(second);
  expect(header('Message-ID')).toMatch(/^<crm-outbound-copy\.0\./);
  expect(copy).not.toMatch(/^List-Unsubscribe/im);
  expect(copy).not.toMatch(LINK);
  expect(copy).not.toContain('unsubscribe.invalid');
  const detail = (await (
    await fetch(`${mail.apiUrl}/api/v1/message/${copies[0]?.id ?? ''}`)
  ).json()) as {
    To?: { Address: string }[];
    Cc?: { Address: string }[];
    Bcc?: { Address: string }[];
  };
  expect(detail.To?.map((each) => each.Address)).toEqual([first]);
  expect(detail.Cc?.map((each) => each.Address)).toEqual([second]);
  expect(detail.Bcc?.map((each) => each.Address)).toEqual([bcc]);
  expect((copies[0]?.text ?? '').replace(/\r\n/g, '\n')).toBe(
    `Hello Ada\nStop: [removed from this copy]\n\n--\nBluebird Dental, 12 High St, Austin, TX 78701\nThis is a copy of an email sent to ${f.recipient}. Only their own email has a working unsubscribe link.\n`,
  );
  expect(copies[0]?.html).toBe(
    '<p>Hello Ada</p><p><a href="#">Stop these emails</a></p>' +
      '<p style="font-size:12px;color:#666666">Bluebird Dental, 12 High St, Austin, TX 78701<br>' +
      `This is a copy of an email sent to ${f.recipient}. Only their own email has a working unsubscribe link.</p>`,
  );
  // The contact got one message, and it is not the copy.
  expect(await mailbox(mail).messagesTo(f.recipient)).toHaveLength(1);
});

/** A business profile address, as US law asks every marketing email to show. */
const AUSTIN = {
  line1: '12 High St',
  line2: '',
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
  country: 'US',
};
const AUSTIN_LINE = 'Bluebird Dental, 12 High St, Austin, TX 78701, US';

it('sends each Bcc address a copy alone when nobody is in Cc', async () => {
  const f = await fixture(AUSTIN);
  const s = await sending(f);
  const [one, two] = [`b1.${randomUUID()}@example.test`, `b2.${randomUUID()}@example.test`];
  await s.send(await s.queue({ text: 'Hello', bcc: [one, two] }));
  for (const [index, address] of [one, two].entries()) {
    // A header's folded lines joined, as a mail app reads it.
    const raw = (await s.raw(address)).replace(/\n[ \t]+/g, ' ');
    expect(raw).toMatch(new RegExp(`^To: ${address.replace(/\./g, '\\.')}$`, 'm'));
    expect(raw).toMatch(new RegExp(`^Message-ID: <crm-outbound-copy\\.${String(index)}\\.`, 'm'));
    expect(raw).not.toMatch(/^List-Unsubscribe/im);
    expect(raw).not.toContain('/unsubscribe/');
    expect(raw).not.toContain(index === 0 ? two : one);
  }
  expect(await s.raw(f.recipient)).not.toContain(one);
});

it('sends an older plain-text workflow email as it was, with the unsubscribe line added to the mail', async () => {
  const f = await fixture(AUSTIN);
  const s = await sending(f);
  const key = randomUUID();
  const messageId = await s.queue({ idempotencyKey: key, text: 'Line one\nLine two' });
  // The same request again finds the same message: nothing new is part of what is hashed.
  expect(await s.queue({ idempotencyKey: key, text: 'Line one\nLine two' })).toBe(messageId);
  await s.send(messageId);
  const raw = await s.raw(f.recipient);
  expect(raw).toMatch(/^From: Mailbox Name <sender@example\.test>$/m);
  expect(raw).not.toMatch(/^(?:Reply-To|Cc):/im);
  expect(raw).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
  expect(raw).not.toMatch(/multipart/);
  const [caught] = await mailbox(mail).messagesTo(f.recipient);
  expect(caught?.text.replace(/\r\n/g, '\n')).toMatch(
    new RegExp(
      `^Line one\nLine two\n\n--\n${AUSTIN_LINE}\nUnsubscribe: https://crm\\.example\\.test/unsubscribe/[A-Za-z0-9_-]{43}\n$`,
    ),
  );
  const stored = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages')
      .select(['body_text', 'body_html', 'cc_addresses'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow(),
  );
  expect(stored).toEqual({ body_text: 'Line one\nLine two', body_html: null, cc_addresses: [] });
});

it('leaves a body that places the unsubscribe link itself without a second one, and other lanes without a footer', async () => {
  const f = await fixture(AUSTIN);
  const s = await sending(f);
  const placed = await s.queue({
    text: 'Stop here: https://unsubscribe.invalid/link',
    html: '<p><a href="https://unsubscribe.invalid/link">Stop</a></p>',
  });
  await s.send(placed);
  const [first] = await mailbox(mail).messagesTo(f.recipient);
  // Only the postal address is added: the body shows its own link.
  expect(first?.text.replace(/\r\n/g, '\n')).toMatch(
    new RegExp(
      `^Stop here: https://crm\\.example\\.test/unsubscribe/[A-Za-z0-9_-]{43}\n\n--\n${AUSTIN_LINE}\n$`,
    ),
  );
  expect(first?.html).toMatch(
    new RegExp(
      `^<p><a href="https://crm\\.example\\.test/unsubscribe/[A-Za-z0-9_-]{43}">Stop</a></p><p style="font-size:12px;color:#666666">${AUSTIN_LINE}</p>$`,
    ),
  );
  // An address in Cc or Bcc is only an email's; a text message has none.
  await expect(s.queue({ channel: 'sms', cc: ['a@example.test'] })).rejects.toThrow();
  await expect(s.queue({ cc: ['not an address'] })).rejects.toThrow();
  await expect(s.queue({ fromName: 'Two\nlines' })).rejects.toThrow();
});

it('refuses a workflow marketing email, with a reason, while the business has no postal address', async () => {
  const f = await fixture();
  const s = await sending(f);
  const messageId = await s.queue({ text: 'Sale' });
  await s.send(messageId);
  expect(await mailbox(mail).messagesTo(f.recipient)).toEqual([]);
  expect(
    await withTenant(db, f.context, (trx) =>
      trx
        .selectFrom('messaging.messages')
        .select(['status', 'error_code'])
        .where('id', '=', messageId)
        .executeTakeFirstOrThrow(),
    ),
  ).toEqual({ status: 'failed', error_code: 'postal_address_missing' });
});

it('fills a workflow email in for a contact, with fallbacks, and stops at a field with none', async () => {
  const f = await fixture(AUSTIN);
  const compose = (parts: Parameters<typeof composeEmail>[2]['parts'], marketing = true) =>
    withTenant(db, f.context, (trx) =>
      composeEmail(trx, f.context, {
        contactId: f.contact.id,
        parts,
        values: { 'contact.firstName': '' },
        publicUrl: 'https://crm.example.test',
        marketing,
      }),
    );
  expect(
    await compose({
      subject: 'Hi {{contact.firstName | default: "there"}}',
      text: 'Hello {{contact.firstName | default: "friend"}}',
      html: '<p>Hello {{contact.firstName | default: "friend"}}</p>',
      preheader: 'For {{contact.firstName | default: "you"}}',
    }),
  ).toEqual({
    ok: true,
    subject: 'Hi there',
    text: 'Hello friend',
    html: '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">For you</div><p>Hello friend</p>',
  });
  expect(await compose({ subject: 'S', text: 'Plain', html: null }, false)).toEqual({
    ok: true,
    subject: 'S',
    text: 'Plain',
    html: null,
  });
  expect(await compose({ subject: 'Hi {{contact.firstName}}', text: 'T' })).toEqual({
    ok: false,
    code: 'missing_values',
    fields: ['contact.firstName'],
  });
  expect(await compose({ subject: 'S', text: 'T', html: '<p>{{contact.firstName}}</p>' })).toEqual({
    ok: false,
    code: 'missing_values',
    fields: ['contact.firstName'],
  });
});
