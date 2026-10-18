// The workflow Send email step with formatted content and "Sync edits to template", through
// the engine's own step command and the draft commands, on real Postgres: what is queued,
// what a synced edit writes, what stays independent, the inventory of actions that use a
// template, and one step's statistics.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import {
  automationDocument,
  type AutomationDocumentInput,
  type AutomationSetup,
  type MessageTemplate,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { createTemplateCommands } from '@repo/module-messaging';
import type { Sql } from '@repo/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { createDraftCommands, readAutomation } from './drafts.js';
import { readEmailStepStatistics } from './email-step-statistics.js';
import { createEmailSyncCommands } from './email-sync.js';
import { readTemplateWorkflowActions } from './email-template-actions.js';
import { createEmailTemplateCopyCommand } from './email-template-copy.js';
import { publishAutomationVersion } from './enrolment.js';
import { readTemplateUses } from './template-uses.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const setup = (): Promise<AutomationSetup> =>
  Promise.resolve({
    fields: { contact: [], deal: [] },
    forms: [],
    emailTemplates: [],
    whatsappTemplates: [],
    mailboxes: [],
    phoneNumbers: [],
    calendars: [],
    pipelines: [],
    lostReasons: [],
    tags: [],
    users: [],
    automations: [],
    values: [],
    channels: { email: true, sms: false, whatsapp: false },
    ai: false,
    webhooks: false,
    unavailableSteps: [],
    unavailableTriggers: [],
  });
const templates = createTemplateCommands();
const drafts = createDraftCommands({ setup });
const copy = createEmailTemplateCopyCommand({ setup });
const sync = createEmailSyncCommands({ setup, templates });

type EmailConfig = Extract<
  AutomationDocumentInput['steps'][string],
  { type: 'email.send' }
>['config'];

async function scene() {
  const tenant = await h.business();
  const all = { context: { ...tenant, correlationId: randomUUID() }, permissions: 'all' as const };
  const superuser = <T>(work: (sql: Sql) => Promise<T>): Promise<T> =>
    h.database.as('postgres', work);
  await superuser(async (sql) => {
    await sql.query(
      `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)`,
      [tenant.businessId],
    );
    const [secret] = await sql.query<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [tenant.agencyId, tenant.businessId],
    );
    const [account] = await sql.query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values ($1, 'email', 'Sales', 'active') returning id`,
      [tenant.businessId],
    );
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
         smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
         imap_username, secret_id, use_for_conversations)
       values ($1, $2, 'sales@example.test', 'password', 'mail.example.test', 587, 'starttls',
         'sales@example.test', 'mail.example.test', 993, 'tls', 'sales@example.test', $3, true)`,
      [tenant.businessId, account?.id, secret?.id],
    );
  });
  const consent = (contactId: string, status: 'granted' | 'withdrawn' = 'granted') =>
    superuser((sql) =>
      sql.query(
        `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
         values ($1, $2, 'email', 'marketing', $3, 'user', 'user')`,
        [tenant.businessId, contactId, status],
      ),
    );
  const template = (input: Record<string, unknown>): Promise<MessageTemplate> =>
    runCommand(h.services, templates.create, input as never, all);
  const document = (config: EmailConfig, name = 'Send'): AutomationDocumentInput => ({
    name,
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'send',
    steps: { send: { type: 'email.send', label: 'The email', config } },
  });
  /** A new contact with consent, enrolled and run through the step; the message it queued. */
  const send = async (firstName = 'Ada', withConsent = true) => {
    const made = await h.contact(tenant, firstName);
    if (withConsent) await consent(made.contactId);
    await h.match(tenant, made.eventId);
    const runs = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ id: string }>(
        `select id from automation.enrolments where record_id = $1 order by id`,
        [made.contactId],
      ),
    );
    for (const run of runs) await h.step(tenant, run.id);
    const messages = await h.database.withTenant(tenant, (sql) =>
      sql.query<{
        id: string;
        status: string;
        error_code: string | null;
        subject: string;
        body_text: string;
        body_html: string | null;
        cc_addresses: string[];
        bcc_addresses: string[];
        from_name: string | null;
        reply_to: string | null;
        files: number;
      }>(
        `select m.id, m.status, m.error_code, m.subject, m.body_text, m.body_html, m.cc_addresses,
                m.bcc_addresses, d.from_name, d.reply_to,
                (select count(*)::int from messaging.message_attachments a where a.message_id = m.id) as files
         from messaging.messages m
         join messaging.outbound_dispatch d on d.id = m.id
         join messaging.conversations v on v.id = m.conversation_id
         where v.contact_id = $1 order by m.created_at, m.id`,
        [made.contactId],
      ),
    );
    const steps = await h.database.withTenant(tenant, (sql) =>
      sql.query<{ status: string; code: string | null }>(
        `select r.status, r.error ->> 'code' as code from automation.step_runs r
         join automation.enrolments e on e.id = r.enrolment_id
         where e.record_id = $1 order by r.started_at, r.id`,
        [made.contactId],
      ),
    );
    return { ...made, messages, steps };
  };
  const file = async (bytes = 16): Promise<string> => {
    const [row] = await superuser((sql) =>
      sql.query<{ id: string }>(
        `insert into files.files
           (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes,
            sha256, uploaded_by_kind)
         values ($1, $2, 'local', uuidv7()::text, 'price-list.pdf', 'application/pdf', $3,
                 sha256('x'::bytea), 'system') returning id`,
        [tenant.agencyId, tenant.businessId, bytes],
      ),
    );
    return toPublicId('file', row?.id ?? '');
  };
  return { tenant, all, consent, template, document, send, file, superuser };
}

it('queues formatted content with the step’s From name, Reply-To, Cc, Bcc, preview text and file', async () => {
  const s = await scene();
  const attached = await s.file();
  await s.superuser((sql) =>
    sql.query(
      `insert into messaging.suppressions (business_id, channel, address_normalized, reason)
       values ($1, 'email', 'gone@example.test', 'hard_bounce')`,
      [s.tenant.businessId],
    ),
  );
  await h.publish(
    s.tenant,
    s.document({
      subject: 'Hi {{contact.firstName}}',
      body: 'Text for {{contact.firstName}}',
      html: '<p onclick="x()">Hi <b>{{contact.firstName}}</b><script>alert(1)</script></p><p><a href="{{email.unsubscribe_link}}">Stop</a></p>',
      preheader: 'Peek, {{contact.firstName}}',
      fromName: '{{contact.firstName}}’s dentist',
      replyTo: '{{contact.email}}',
      cc: ['Team@Example.test', 'gone@example.test', '{{contact.email}}'],
      bcc: ['archive@example.test', 'team@example.test'],
      attachments: [attached],
    }),
  );
  const sent = await s.send('Ada <i>');
  expect(sent.steps).toEqual([{ status: 'succeeded', code: null }]);
  const [message] = sent.messages;
  const email = await h.database.withTenant(s.tenant, (sql) =>
    sql.one<{ value: string }>(
      `select value_normalized as value from crm.contact_identities where contact_id = $1 and kind = 'email'`,
      [sent.contactId],
    ),
  );
  expect(message).toMatchObject({
    status: 'queued',
    subject: 'Hi Ada <i>',
    // Queued as written: the footer is added to the mail as it leaves (messaging's tests).
    body_text: 'Text for Ada <i>',
    body_html:
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Peek, Ada &lt;i&gt;</div>' +
      '<p>Hi <b>Ada &lt;i&gt;</b></p><p><a href="https://unsubscribe.invalid/link" target="_blank" rel="noopener noreferrer">Stop</a></p>',
    from_name: 'Ada <i>’s dentist',
    reply_to: email.value,
    // The suppressed address and the contact's own are left out; Bcc never repeats Cc.
    cc_addresses: ['team@example.test'],
    bcc_addresses: ['archive@example.test'],
    files: 1,
  });
});

it('fails the step, and queues nothing, for a missing file, files too large, or an address that is not one', async () => {
  const s = await scene();
  const big = await s.file(16 * 1024 * 1024);
  const cases: [EmailConfig, string][] = [
    [
      { subject: 'S', body: 'B', attachments: [toPublicId('file', s.tenant.agencyId)] },
      'attachment_unavailable',
    ],
    [{ subject: 'S', body: 'B', attachments: [big] }, 'attachments_too_large'],
    [{ subject: 'S', body: 'B', replyTo: '{{contact.firstName}}' }, 'invalid_address'],
    [{ subject: 'S', body: 'B', cc: ['{{contact.custom.missing}}'] }, 'missing_values'],
    [{ subject: 'S', body: 'B', html: '<p>{{contact.custom.missing}}</p>' }, 'missing_values'],
  ];
  for (const [config, code] of cases) {
    const fresh = await scene();
    const target = code === 'attachments_too_large' ? s : fresh;
    await h.publish(target.tenant, target.document(config));
    const sent = await target.send();
    expect([code, sent.steps, sent.messages]).toEqual([code, [{ status: 'failed', code }], []]);
  }
});

it('keeps an older plain-text step’s message exactly as it was written', async () => {
  const s = await scene();
  const template = await s.template({
    name: 'Plain',
    subject: 'Your guide',
    body: 'Hello {{contact.firstName}},\n\nBye.',
  });
  await h.publish(s.tenant, s.document({ template: template.id }));
  const sent = await s.send('Ada');
  expect(sent.messages).toMatchObject([
    {
      subject: 'Your guide',
      body_text: 'Hello Ada,\n\nBye.',
      body_html: null,
      from_name: null,
      reply_to: null,
      cc_addresses: [],
      bcc_addresses: [],
      files: 0,
    },
  ]);
});

it('sends a formatted template through an older reference, with the step’s own subject', async () => {
  const s = await scene();
  const template = await s.template({
    name: 'Formatted',
    subject: 'Template subject',
    content: { format: 'html', html: '<p>Hello <em>{{contact.firstName}}</em></p>' },
    preheader: 'From the template',
  });
  await h.publish(s.tenant, s.document({ template: template.id, subject: 'Step subject' }));
  const sent = await s.send('Ada');
  expect(sent.messages).toMatchObject([
    {
      subject: 'Step subject',
      body_text: 'Hello Ada',
      body_html:
        '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">From the template</div><p>Hello <em>Ada</em></p>',
    },
  ]);
});

async function drafted(s: Awaited<ReturnType<typeof scene>>, config: EmailConfig, name: string) {
  const saved = await runCommand(
    h.services,
    drafts.create,
    { document: s.document(config, name) },
    s.all,
  );
  return saved.automation;
}

const stepConfig = (draft: unknown): unknown =>
  (draft as { steps: { send: { config: unknown } } }).steps.send.config;

it('syncs with a template: on, a library edit reaches every syncing step; an edit through a step writes the template; off, a step is independent', async () => {
  const s = await scene();
  const t1 = await s.template({
    name: 'Wedding details',
    subject: 'Wedding details A',
    content: { format: 'html', html: '<p>Hello {{contact.firstName}}: A</p>' },
  });
  const inline = {
    subject: 'Local subject',
    body: 'Local body',
    fromName: 'Front desk',
    cc: ['team@example.test'],
  };
  const s1 = await drafted(s, inline, 'S1');
  const s2 = await drafted(s, inline, 'S2');
  const c1 = await drafted(s, inline, 'C1');
  // ES02: turning sync on drops the step's own content, keeps its envelope, and leaves the
  // template as it was. A stale revision changes nothing.
  await expect(
    runCommand(
      h.services,
      sync.enable,
      { id: s1.id, baseDraftVersion: 1, step: 'send', template: t1.id, revision: 'a'.repeat(64) },
      s.all,
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  for (const automation of [s1, s2]) {
    const enabled = await runCommand(
      h.services,
      sync.enable,
      {
        id: automation.id,
        baseDraftVersion: 1,
        step: 'send',
        template: t1.id,
        revision: t1.revision,
      },
      s.all,
    );
    expect(stepConfig(enabled.automation.draft)).toEqual({
      mode: 'sync',
      source: { id: t1.id, revision: t1.revision },
      fromName: 'Front desk',
      cc: ['team@example.test'],
    });
  }
  // ES01: a copy keeps its provenance and its own content.
  const copied = await runCommand(
    h.services,
    copy,
    { id: c1.id, baseDraftVersion: 1, step: 'send', template: t1.id, revision: t1.revision },
    s.all,
  );
  expect(stepConfig(copied.automation.draft)).toEqual({
    mode: 'copy',
    source: { id: t1.id, revision: t1.revision },
    subject: 'Wedding details A',
    body: 'Hello {{contact.firstName}}: A',
    html: '<p>Hello {{contact.firstName}}: A</p>',
    fromName: 'Front desk',
    cc: ['team@example.test'],
  });
  const read = (id: string) => withTenant(h.db, s.tenant, (trx) => readAutomation(trx, id));
  const publish = async (id: string) => {
    const automation = await read(id);
    await withTenant(h.db, s.tenant, (trx) =>
      publishAutomationVersion(
        trx,
        s.tenant,
        parsePublicId('automation', id) ?? '',
        automationDocument.parse(automation.draft),
        'v1',
      ),
    );
  };
  for (const automation of [s1, s2, c1]) await publish(automation.id);
  const bySubject = (messages: { subject: string; body_text: string }[]) =>
    messages.map((message) => `${message.subject} | ${message.body_text}`).sort();
  expect(bySubject((await s.send('Ada')).messages)).toEqual([
    'Wedding details A | Hello Ada: A',
    'Wedding details A | Hello Ada: A',
    'Wedding details A | Hello Ada: A',
  ]);
  // ES03: an edit in the library reaches the two that sync, and not the copy.
  const t2 = await runCommand(
    h.services,
    templates.update,
    {
      id: t1.id,
      revision: t1.revision,
      name: t1.name,
      subject: 'Wedding details B',
      content: { format: 'html', html: '<p>Hello {{contact.firstName}}: B</p>' },
    },
    s.all,
  );
  expect(bySubject((await s.send('Bea')).messages)).toEqual([
    'Wedding details A | Hello Bea: A',
    'Wedding details B | Hello Bea: B',
    'Wedding details B | Hello Bea: B',
  ]);
  // ES06: an edit through the step from a stale template revision, or a stale draft,
  // changes neither the template nor the draft.
  const save = (revision: string, baseDraftVersion: number, body: string) =>
    runCommand(
      h.services,
      sync.save,
      {
        id: s1.id,
        baseDraftVersion,
        step: 'send',
        revision,
        subject: `Wedding details ${body}`,
        content: {
          format: 'html',
          html: `<p onclick="x()">Hello {{contact.firstName}}: ${body}</p>`,
        },
        preheader: 'Details inside',
      },
      s.all,
    );
  await expect(save(t1.revision, 2, 'X')).rejects.toBeInstanceOf(ConflictError);
  await expect(save(t2.revision, 1, 'X')).rejects.toBeInstanceOf(ConflictError);
  const before = await withTenant(h.db, s.tenant, (trx) =>
    trx
      .selectFrom('messaging.templates')
      .select(['subject', 'body'])
      .where('name', '=', t1.name)
      .executeTakeFirstOrThrow(),
  );
  expect(before).toEqual({ subject: 'Wedding details B', body: 'Hello {{contact.firstName}}: B' });
  expect((await read(s1.id)).draftVersion).toBe(2);
  // ES04: an edit through S1 writes the template's next revision, cleaned, and S2 sends it.
  const saved = await save(t2.revision, 2, 'C');
  expect(saved.template).toMatchObject({
    id: t1.id,
    subject: 'Wedding details C',
    preheader: 'Details inside',
    content: {
      format: 'html',
      html: '<p>Hello {{contact.firstName}}: C</p>',
      text: 'Hello {{contact.firstName}}: C',
    },
  });
  expect(saved.template.revision).not.toBe(t2.revision);
  expect(saved.saved.automation.draftVersion).toBe(3);
  expect(stepConfig(saved.saved.automation.draft)).toMatchObject({
    mode: 'sync',
    source: { id: t1.id, revision: saved.template.revision },
    fromName: 'Front desk',
  });
  expect(bySubject((await s.send('Cy')).messages)).toEqual([
    'Wedding details A | Hello Cy: A',
    'Wedding details C | Hello Cy: C',
    'Wedding details C | Hello Cy: C',
  ]);
  // A copy cannot be edited as if it synced.
  await expect(
    runCommand(
      h.services,
      sync.save,
      {
        id: c1.id,
        baseDraftVersion: 2,
        step: 'send',
        revision: saved.template.revision,
        subject: 'No',
        content: { format: 'text', text: 'No' },
      },
      s.all,
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  // The inventory tells links from copies, in drafts and in what runs now.
  const inventory = await withTenant(h.db, s.tenant, (trx) =>
    readTemplateWorkflowActions(trx, s.all, t1.id, { limit: 50 }),
  );
  expect(
    inventory.items.map((item) => [
      item.automation.name,
      item.scope,
      item.mode,
      item.label,
      item.current,
    ]),
  ).toEqual([
    ['S1', 'draft', 'sync', 'The email', null],
    ['S1', 'published', 'sync', 'The email', null],
    ['S2', 'draft', 'sync', 'The email', null],
    ['S2', 'published', 'sync', 'The email', null],
    ['C1', 'draft', 'copy', 'The email', false],
    ['C1', 'published', 'copy', 'The email', false],
  ]);
  expect(inventory.nextCursor).toBeNull();
  const page = await withTenant(h.db, s.tenant, (trx) =>
    readTemplateWorkflowActions(trx, s.all, t1.id, { limit: 1 }),
  );
  expect(page.items.map((item) => item.automation.name)).toEqual(['S1', 'S1']);
  expect(page.nextCursor).toBe(s1.id);
  const rest = await withTenant(h.db, s.tenant, (trx) =>
    readTemplateWorkflowActions(trx, s.all, t1.id, { limit: 50, after: s1.id }),
  );
  expect([...new Set(rest.items.map((item) => item.automation.name))]).toEqual(['S2', 'C1']);
  // Archiving names the automations that send the template live: the two that sync.
  const uses = await withTenant(h.db, s.tenant, (trx) => readTemplateUses(trx, s.tenant, t1.id));
  expect(uses.map((use) => use.name)).toEqual(['S1', 'S2']);
  // ES05: turning sync off captures the template as it is; a later edit does not reach it.
  const off = await runCommand(
    h.services,
    copy,
    {
      id: s1.id,
      baseDraftVersion: 3,
      step: 'send',
      template: t1.id,
      revision: saved.template.revision,
    },
    s.all,
  );
  expect(stepConfig(off.automation.draft)).toEqual({
    mode: 'copy',
    source: { id: t1.id, revision: saved.template.revision },
    subject: 'Wedding details C',
    body: 'Hello {{contact.firstName}}: C',
    html: '<p>Hello {{contact.firstName}}: C</p>',
    preheader: 'Details inside',
    fromName: 'Front desk',
    cc: ['team@example.test'],
  });
});

it('fails a syncing step, without falling back, once its template is archived; and refuses to publish one', async () => {
  const s = await scene();
  const template = await s.template({ name: 'Soon gone', subject: 'S', body: 'B' });
  const config = {
    mode: 'sync' as const,
    source: { id: template.id, revision: template.revision },
  };
  await h.publish(s.tenant, s.document(config));
  await runCommand(
    h.services,
    templates.archive,
    { id: template.id, revision: template.revision },
    s.all,
  );
  const sent = await s.send();
  expect([sent.steps, sent.messages]).toEqual([
    [{ status: 'failed', code: 'template_unavailable' }],
    [],
  ]);
  await expect(h.publish(s.tenant, s.document(config, 'Again'))).rejects.toBeInstanceOf(
    ValidationError,
  );
});

it('needs templates.manage to edit a template through a syncing step', async () => {
  const s = await scene();
  const template = await s.template({ name: 'Guarded', subject: 'S', body: 'B' });
  const automation = await drafted(
    s,
    { mode: 'sync', source: { id: template.id, revision: template.revision } },
    'Guarded',
  );
  const services = {
    ...h.services,
    authorize: (_invocation: unknown, command: string) =>
      Promise.resolve(command !== 'template.update'),
  };
  await expect(
    runCommand(
      services,
      sync.save,
      {
        id: automation.id,
        baseDraftVersion: 1,
        step: 'send',
        revision: template.revision,
        subject: 'Changed',
        content: { format: 'text', text: 'Changed' },
      },
      s.all,
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const stored = await withTenant(h.db, s.tenant, (trx) =>
    trx
      .selectFrom('messaging.templates')
      .select('subject')
      .where('name', '=', 'Guarded')
      .executeTakeFirstOrThrow(),
  );
  expect(stored.subject).toBe('S');
});

it('counts what one step sent, skipped and failed, in a date range, and keeps businesses apart', async () => {
  const s = await scene();
  const other = await scene();
  const published = await h.publish(
    s.tenant,
    s.document({ subject: 'Hi', body: 'Hello {{contact.firstName}}' }),
  );
  const theirs = await h.publish(other.tenant, other.document({ subject: 'Hi', body: 'Hello' }));
  const sent = await s.send('Ada');
  const queued = await s.send('Bea');
  const bounced = await s.send('Cy');
  await s.send('Dee', false);
  const unsubscribed = await s.send('Eve');
  await other.send('Zed');
  await s.superuser(async (sql) => {
    await sql.query(
      `update messaging.messages set status = 'sent', sent_at = now() where id = any($1)`,
      [[sent.messages[0]?.id, unsubscribed.messages[0]?.id]],
    );
    await sql.query(`update messaging.messages set status = 'bounced' where id = $1`, [
      bounced.messages[0]?.id,
    ]);
    // Its link was used (the link itself is kept in messaging.unsubscribe_links).
    await sql.query(
      `update messaging.outbound_dispatch set unsubscribe_used_at = now() where id = $1`,
      [unsubscribed.messages[0]?.id],
    );
  });
  expect(queued.messages[0]?.status).toBe('queued');
  const read = (tenant: Tenant, id: string, range = {}) =>
    withTenant(h.db, tenant, (trx) => readEmailStepStatistics(trx, id, 'send', range));
  const counts = await read(s.tenant, published.id);
  expect(counts).toEqual({
    step: 'send',
    from: null,
    to: null,
    total: 5,
    waiting: 1,
    sent: 3,
    delivered: null,
    bounced: 1,
    failed: 0,
    skipped: { total: 1, reasons: [{ reason: 'no_consent', count: 1 }] },
    unsubscribed: 1,
    opened: null,
    clicked: null,
  });
  // Nothing began before today, and everything before tomorrow.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  expect(await read(s.tenant, published.id, { to: yesterday })).toMatchObject({
    total: 0,
    sent: 0,
  });
  expect(await read(s.tenant, published.id, { from: yesterday, to: tomorrow })).toMatchObject({
    total: 5,
    from: yesterday,
    to: tomorrow,
  });
  // Another step of the same automation has none; another business's automation is not found.
  expect(
    await withTenant(h.db, s.tenant, (trx) =>
      readEmailStepStatistics(trx, published.id, 'other', {}),
    ),
  ).toMatchObject({ total: 0 });
  await expect(read(s.tenant, theirs.id)).rejects.toThrow(/automation/i);
  expect(await read(other.tenant, theirs.id)).toMatchObject({ total: 1, waiting: 1 });
});

it('separates delivery failures from policy skips and held messages in the stored step statistics', async () => {
  const s = await scene();
  const published = await h.publish(s.tenant, s.document({ subject: 'Hi', body: 'Hello' }));
  const outcomes = [
    ['sending', null, null],
    ['unknown', 'delivery_unknown', null],
    ['failed', 'delivery_rejected', null],
    ['failed', 'suppressed', 'complaint'],
    ['failed', 'suppressed', null],
    ['failed', 'suppressed', 'manual'],
    ['failed', 'suppressed', 'unsubscribe'],
    ['failed', null, null],
  ] as const;
  for (const [index, [status, code, detail]] of outcomes.entries()) {
    const sent = await s.send(`Contact ${String(index)}`);
    const message = sent.messages[0];
    if (message === undefined) throw new Error('The workflow did not queue its email.');
    // Delivery and policy decisions arrive after the step queued the message.
    await s.superuser((sql) =>
      sql.query(
        'update messaging.messages set status = $2, error_code = $3, error_detail = $4 where id = $1',
        [message.id, status, code, detail],
      ),
    );
  }
  const counts = await withTenant(h.db, s.tenant, (trx) =>
    readEmailStepStatistics(trx, published.id, 'send', {}),
  );
  expect(counts).toMatchObject({
    total: 8,
    waiting: 1,
    sent: 0,
    failed: 3,
    skipped: {
      total: 4,
      reasons: [
        { reason: 'suppressed', count: 2 },
        { reason: 'complained', count: 1 },
        { reason: 'unsubscribed', count: 1 },
      ],
    },
    delivered: null,
    opened: null,
    clicked: null,
  });
});
