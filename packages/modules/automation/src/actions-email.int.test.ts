// email.send: the step fills a template for the enrolled contact and queues it through
// messaging's own outbound path, once, and only when messaging's policy allows. Real
// Postgres, the real step command, and no mail server: queued is as far as this goes.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import {
  automationDocument,
  messageTemplateFolder,
  type AutomationDocumentInput,
  type WorkflowEmailSource,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import {
  createDispatchOutboundTask,
  createTemplateCommands,
  createTemplateRoutes,
  queueOutboundMessage,
} from '@repo/module-messaging';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { sendAutomationEmail } from './actions-email.js';
import { matchEvent, publishAutomationVersion } from './enrolment.js';
import { createRunStepCommand } from './runner.js';
import { contactValues } from './values.js';

// These automations create no tasks, so nothing here resolves an assignee.
const runStepCommand = createRunStepCommand({
  tasks: {
    actorNames: {},
    assignees: {
      resolve: () => Promise.resolve(null),
      read: () => Promise.resolve({ items: [], nextCursor: null }),
      memberships: () => Promise.resolve(new Map<string, string>()),
    },
  },
});

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const one = async (sql: Sql, text: string, values: readonly unknown[]): Promise<string> => {
  const [row] = await sql.query<{ id: string }>(text, values);
  if (row === undefined) throw new Error('The insert returns its id.');
  return row.id;
};

interface Scene {
  readonly context: TenantContext & { readonly businessId: string };
  readonly contactId: string;
  readonly email: string;
  /** Adds a working mailbox for conversations, and returns its public id. */
  mailbox(name: string, as?: { status?: string; conversations?: boolean }): Promise<string>;
  /** Adds a template, and returns its public id. */
  template(subject: string, body: string): Promise<string>;
  consent(status: 'granted' | 'withdrawn'): Promise<void>;
  /** Publishes the automation, enrols the contact, and runs its first step. */
  run(
    config:
      | { template: string; mailbox?: string }
      | {
          subject: string;
          body: string;
          mailbox?: string;
          mode?: 'copy';
          source?: WorkflowEmailSource;
        },
    restriction?: {
      channel: 'all' | 'email';
      action: 'enable' | 'disable';
      reason: string;
    },
    beforeStep?: () => Promise<void>,
  ): Promise<{
    status: string;
    exit_reason: string | null;
  }>;
  messages(): Promise<
    {
      id: string;
      status: string;
      error_code: string | null;
      subject: string | null;
      body_text: string;
      to_addresses: string[];
      mailbox: string;
    }[]
  >;
}

/** A business with one contact, Ada, whose quiet hours are off so the time of day never matters. */
async function scene(firstName = 'Ada'): Promise<Scene> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, businessId: business.id, correlationId: randomUUID() };
  const email = `${randomUUID()}@example.test`;
  await runCommand(
    services,
    createContactCommand,
    { firstName, emails: [email] },
    { context, permissions: 'all' },
  );
  const event = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select(['id', 'subject_id'])
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow(),
  );
  const superuser = <T>(work: (sql: Sql) => Promise<T>) => database.as('postgres', work);
  await superuser((sql) =>
    sql.query(
      `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
       on conflict (business_id) do update set quiet_hours_enabled = false`,
      [business.id],
    ),
  );
  return {
    context,
    contactId: event.subject_id,
    email,
    mailbox: (name, as = {}) =>
      superuser(async (sql) => {
        const secret = await one(
          sql,
          `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
           values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
           returning id`,
          [context.agencyId, business.id],
        );
        const id = await one(
          sql,
          `insert into messaging.channel_accounts (business_id, channel, name, status)
           values ($1, 'email', $2, $3) returning id`,
          [business.id, name, as.status ?? 'active'],
        );
        const address = `${randomUUID()}@example.test`;
        await sql.query(
          `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
             smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
             imap_username, secret_id, use_for_conversations)
           values ($1, $2, $3, 'password', 'mail.example.test', 587, 'starttls', $3,
             'mail.example.test', 993, 'tls', $3, $4, $5)`,
          [business.id, id, address, secret, as.conversations ?? true],
        );
        return toPublicId('mailbox', id);
      }),
    template: (subject, body) =>
      superuser(async (sql) =>
        toPublicId(
          'template',
          await one(
            sql,
            `insert into messaging.templates (business_id, name, subject, body, created_by_kind)
             values ($1, $2, $3, $4, 'user') returning id`,
            [business.id, `Template ${randomUUID()}`, subject, body],
          ),
        ),
      ),
    consent: async (status) => {
      await superuser((sql) =>
        sql.query(
          `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
           values ($1, $2, 'email', 'marketing', $3, 'user', 'user')`,
          [business.id, event.subject_id, status],
        ),
      );
    },
    run: async (config, restriction, beforeStep) => {
      const document: AutomationDocumentInput = {
        name: 'Send the guide',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: restriction === undefined ? 'send' : 'restrict',
        steps: {
          ...(restriction === undefined
            ? {}
            : {
                restrict: { type: 'dnd.set' as const, config: restriction, next: 'send' },
              }),
          send: { type: 'email.send', config },
        },
      };
      const enrolmentId = await withTenant(db, context, async (trx) => {
        const { id } = await trx
          .insertInto('automation.automations')
          .values({
            business_id: business.id,
            name: document.name,
            draft: JSON.stringify(document),
            created_by_kind: 'system',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await publishAutomationVersion(trx, context, id, automationDocument.parse(document), 'v1');
        const [first] = (await matchEvent(trx, context, event.id, contactValues)).enrolled;
        if (first === undefined) throw new Error('Nothing enrolled.');
        return first.enrolmentId;
      });
      await beforeStep?.();
      await runCommand(
        services,
        runStepCommand,
        { enrolmentId, sequence: 0 },
        { context, permissions: 'all' },
      );
      if (restriction !== undefined)
        await runCommand(
          services,
          runStepCommand,
          { enrolmentId, sequence: 1 },
          {
            context,
            permissions: 'all',
          },
        );
      return withTenant(db, context, (trx) =>
        trx
          .selectFrom('automation.enrolments')
          .select(['status', 'exit_reason'])
          .where('id', '=', enrolmentId)
          .executeTakeFirstOrThrow(),
      );
    },
    messages: () =>
      database.withTenant(context, (sql) =>
        sql.query(
          `select id, status, error_code, subject, body_text, to_addresses,
                  channel_account_id as mailbox
           from messaging.messages order by created_at, id`,
        ),
      ),
  };
}

it('keeps a published template link through placement, folder rename and removal before queuing', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  const invocation = { context: s.context, permissions: 'all' as const };
  const templates = createTemplateCommands();
  const template = await runCommand(
    services,
    templates.create,
    {
      name: 'Requested guide',
      subject: 'Your requested guide, {{contact.firstName}}',
      body: 'Hello {{contact.firstName}}. Here is the requested guide.',
    },
    invocation,
  );
  const routes = createTemplateRoutes();
  const folderRoute = (operation: string) => {
    const route = routes.find((candidate) => candidate.endpoint.operationId === operation);
    if (route === undefined) throw new Error(`Missing folder route ${operation}.`);
    return route;
  };
  const created = messageTemplateFolder.parse(
    await folderRoute('createMessageTemplateFolder').run(
      {
        invocation,
        params: {},
        query: {},
        body: { name: 'Guides' },
      },
      services,
    ),
  );
  expect(
    await s.run({ template: template.id }, undefined, async () => {
      await runCommand(
        services,
        templates.move,
        {
          id: template.id,
          revision: template.revision,
          folderId: created.id,
        },
        invocation,
      );
      const renamed = messageTemplateFolder.parse(
        await folderRoute('updateMessageTemplateFolder').run(
          {
            invocation,
            params: { id: created.id },
            query: {},
            body: { revision: created.revision, name: 'Requested guides' },
          },
          services,
        ),
      );
      await folderRoute('removeMessageTemplateFolder').run(
        {
          invocation,
          params: { id: renamed.id },
          query: {},
          body: { revision: renamed.revision },
        },
        services,
      );
    }),
  ).toEqual({ status: 'completed', exit_reason: null });
  const messages = await s.messages();
  expect(messages).toHaveLength(1);
  expect(messages).toMatchObject([
    {
      status: 'queued',
      error_code: null,
      subject: 'Your requested guide, Ada',
      body_text: 'Hello Ada. Here is the requested guide.',
      to_addresses: [s.email],
    },
  ]);
  expect(
    await database.withTenant(s.context, (sql) =>
      sql.query('select purpose, lane from messaging.outbound_dispatch'),
    ),
  ).toEqual([{ purpose: 'marketing', lane: 'automation' }]);
});

it.each(['all', 'email'] as const)(
  'a native %s DND step refuses the next email despite consent',
  async (channel) => {
    const s = await scene();
    await s.mailbox('Sales');
    await s.consent('granted');
    const template = await s.template('Hello', 'Hi.');
    expect(
      await s.run(
        { template },
        {
          channel,
          action: 'enable',
          reason: 'Requested by the contact.',
        },
      ),
    ).toEqual({ status: 'failed', exit_reason: 'do_not_contact' });
    expect(await s.messages()).toMatchObject([{ status: 'failed', error_code: 'do_not_contact' }]);
  },
);

it('clearing global DND leaves withdrawn consent blocking the next email', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('withdrawn');
  await database.withTenant(s.context, (sql) =>
    sql.query('update crm.contacts set do_not_contact=true where id=$1', [s.contactId]),
  );
  const template = await s.template('Hello', 'Hi.');
  expect(
    await s.run(
      { template },
      {
        channel: 'all',
        action: 'disable',
        reason: 'Requested by the contact.',
      },
    ),
  ).toEqual({ status: 'failed', exit_reason: 'consent_withdrawn' });
  expect(await s.messages()).toMatchObject([{ status: 'failed', error_code: 'consent_withdrawn' }]);
});

it('dispatches published copy content after the provenance template is archived', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  const templates = createTemplateCommands();
  const invocation = { context: s.context, permissions: 'all' as const };
  const source = await runCommand(
    services,
    templates.create,
    { name: 'Copy source', subject: 'Original {{contact.firstName}}', body: 'Original guide.' },
    invocation,
  );
  expect(
    await s.run(
      {
        mode: 'copy',
        source: { id: source.id, revision: source.revision },
        subject: 'Copied {{contact.firstName}}',
        body: 'Independent guide for {{contact.firstName}}.',
      },
      undefined,
      async () => {
        await runCommand(
          services,
          templates.archive,
          { id: source.id, revision: source.revision },
          invocation,
        );
      },
    ),
  ).toEqual({ status: 'completed', exit_reason: null });
  expect(await s.messages()).toMatchObject([
    {
      status: 'queued',
      error_code: null,
      subject: 'Copied Ada',
      body_text: 'Independent guide for Ada.',
      to_addresses: [s.email],
    },
  ]);
});

it('queues inline email content through the same consent and rendering pipeline', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  expect(
    await s.run({
      subject: 'Your guide, {{contact.firstName}}',
      body: 'Hi {{contact.firstName}}.',
    }),
  ).toEqual({ status: 'completed', exit_reason: null });
  expect(await s.messages()).toMatchObject([
    { status: 'queued', error_code: null, subject: 'Your guide, Ada', body_text: 'Hi Ada.' },
  ]);
  const templates = await database.withTenant(s.context, (sql) =>
    sql.query('select id from messaging.templates'),
  );
  expect(templates).toEqual([]);
  const lanes = await database.withTenant(s.context, (sql) =>
    sql.query<{ purpose: string; lane: string }>(
      'select purpose, lane from messaging.outbound_dispatch',
    ),
  );
  expect(lanes).toEqual([{ purpose: 'marketing', lane: 'automation' }]);
});

it('refuses inline email without consent instead of bypassing messaging policy', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  expect(await s.run({ subject: 'Hello', body: 'Welcome.' })).toEqual({
    status: 'failed',
    exit_reason: 'consent_required',
  });
  expect(await s.messages()).toMatchObject([{ status: 'failed', error_code: 'consent_required' }]);
});

it.each([
  { subject: 'Hello {{contact.lastName}}', body: 'Welcome.' },
  { subject: 'Hello', body: 'Welcome {{contact.lastName}}.' },
])('refuses missing inline merge values without creating a message %#', async (content) => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  expect(await s.run(content)).toEqual({ status: 'failed', exit_reason: 'missing_values' });
  expect(await s.messages()).toEqual([]);
});

it('refuses header injection introduced by an inline subject merge value', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  await database.withTenant(s.context, (sql) =>
    sql.query('update crm.contacts set first_name = $1 where id = $2', [
      'Ada\r\nBcc: injected@example.test',
      s.contactId,
    ]),
  );
  expect(await s.run({ subject: 'Hello {{contact.firstName}}', body: 'Welcome.' })).toEqual({
    status: 'failed',
    exit_reason: 'subject_line_break',
  });
  expect(await s.messages()).toEqual([]);
});

it('queues the template, filled in, to the contact from the only mailbox', async () => {
  const s = await scene();
  const mailbox = await s.mailbox('Sales');
  const template = await s.template(
    'Your guide, {{contact.firstName}}',
    'Hi {{contact.firstName}}.',
  );
  await s.consent('granted');
  expect(await s.run({ template })).toEqual({ status: 'completed', exit_reason: null });
  const messages = await s.messages();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    status: 'queued',
    error_code: null,
    subject: 'Your guide, Ada',
    body_text: 'Hi Ada.',
    to_addresses: [s.email],
  });
  expect(toPublicId('mailbox', messages[0]?.mailbox ?? '')).toBe(mailbox);
  const lanes = await database.withTenant(s.context, (sql) =>
    sql.query<{ purpose: string; lane: string }>(
      'select purpose, lane from messaging.outbound_dispatch',
    ),
  );
  expect(lanes).toEqual([{ purpose: 'marketing', lane: 'automation' }]);
  const [stepRun] = await database.withTenant(s.context, (sql) =>
    sql.query<{ status: string; output: { messageId?: string } }>(
      'select status, output from automation.step_runs',
    ),
  );
  expect(stepRun).toMatchObject({ status: 'succeeded', output: { messageId: messages[0]?.id } });
});

it('dispatches the committed content revision for the enrolled published version', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  expect(
    await s.run({ mode: 'copy', subject: 'Original guide', body: 'Original body' }, undefined, () =>
      database.withTenant(s.context, async (sql) => {
        await sql.query(
          `insert into automation.email_content_revisions
           (business_id,binding_id,revision,mode,subject,body,created_by_kind)
           select business_id,id,2,'copy','Revised guide, {{contact.firstName}}','Revised body','system'
           from automation.email_bindings where step='send'`,
        );
        await sql.query(
          "update automation.email_bindings set current_revision=2 where step='send'",
        );
      }),
    ),
  ).toEqual({ status: 'completed', exit_reason: null });
  expect(await s.messages()).toMatchObject([
    {
      subject: 'Revised guide, Ada',
      body_text: 'Revised body',
      status: 'queued',
      error_code: null,
    },
  ]);
});

it('keeps an enrolled copy on its own version after a newer version is published', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  expect(
    await s.run(
      { mode: 'copy', subject: 'Pinned guide', body: 'Pinned body' },
      undefined,
      async () => {
        const published = await database.withTenant(s.context, (sql) =>
          sql.one<{ automation_id: string; document: unknown }>(
            'select automation_id, document from automation.versions',
          ),
        );
        const original = automationDocument.parse(published.document);
        await withTenant(db, s.context, (trx) =>
          publishAutomationVersion(
            trx,
            s.context,
            published.automation_id,
            automationDocument.parse({
              ...original,
              steps: {
                send: {
                  type: 'email.send',
                  config: { mode: 'copy', subject: 'New live guide', body: 'New live body' },
                },
              },
            }),
            'New live version',
          ),
        );
      },
    ),
  ).toEqual({ status: 'completed', exit_reason: null });
  expect(await s.messages()).toMatchObject([
    { subject: 'Pinned guide', body_text: 'Pinned body', status: 'queued' },
  ]);
  const [run] = await database.withTenant(s.context, (sql) =>
    sql.query<{ output: { emailContent: { binding: string; revision: number } } }>(
      "select output from automation.step_runs where step_key='send'",
    ),
  );
  expect(run?.output.emailContent.revision).toBe(1);
  expect(typeof run?.output.emailContent.binding).toBe('string');
});

it('queues one message per visit, however often the same visit is run', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  const template = await s.template('Hello', 'Hi {{contact.firstName}}.');
  await s.consent('granted');
  const send = (key: string) =>
    withTenant(db, s.context, (trx) =>
      sendAutomationEmail(trx, s.context, {
        contactId: s.contactId,
        template,
        mailbox: undefined,
        idempotencyKey: key,
      }),
    );
  const first = await send('automation:run:send:0');
  expect(first.ok).toBe(true);
  expect(await send('automation:run:send:0')).toEqual(first);
  expect(await s.messages()).toHaveLength(1);
  // A later visit, such as the next pass of a loop, is a new message.
  expect(await send('automation:run:send:1')).not.toEqual(first);
  expect(await s.messages()).toHaveLength(2);
});

it('replays an admitted visit after source edits or archival without changing queued content', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  const template = await s.template('Original guide', 'Original body');
  await s.consent('granted');
  const send = () =>
    withTenant(db, s.context, (trx) =>
      sendAutomationEmail(trx, s.context, {
        contactId: s.contactId,
        template,
        mailbox: undefined,
        idempotencyKey: 'automation:run:send:0',
      }),
    );
  const first = await send();
  expect(first.ok).toBe(true);
  await database.withTenant(s.context, (sql) =>
    sql.query("update messaging.templates set subject='Changed guide', body='Changed body'"),
  );
  expect(await send()).toEqual(first);
  await database.withTenant(s.context, (sql) =>
    sql.query('update messaging.templates set archived_at=now()'),
  );
  expect(await send()).toEqual(first);
  expect(await s.messages()).toMatchObject([
    { subject: 'Original guide', body_text: 'Original body', status: 'queued' },
  ]);
  if (!first.ok) throw new Error('The original visit must queue a message.');
  let deliveries = 0;
  const dispatch = createDispatchOutboundTask({
    deliver(message) {
      deliveries++;
      expect(message.subject).toBe('Original guide');
      expect(message.text).toBe('Original body');
      return Promise.resolve({
        outcome: 'accepted' as const,
        providerId: 'workflow-replay-fixture',
      });
    },
  });
  const job = { invocation: { context: s.context, permissions: 'all' as const }, services };
  await dispatch.run({ messageId: first.messageId }, job);
  expect(await send()).toEqual(first);
  await dispatch.run({ messageId: first.messageId }, job);
  expect(deliveries).toBe(1);
  expect(await s.messages()).toMatchObject([
    { subject: 'Original guide', body_text: 'Original body', status: 'sent' },
  ]);
});

it('refuses replaying another contact’s workflow visit', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  const template = await s.template('Original guide', 'Original body');
  await s.consent('granted');
  const send = (contactId: string) =>
    withTenant(db, s.context, (trx) =>
      sendAutomationEmail(trx, s.context, {
        contactId,
        template,
        mailbox: undefined,
        idempotencyKey: 'automation:run:send:0',
      }),
    );
  expect((await send(s.contactId)).ok).toBe(true);
  await expect(send(randomUUID())).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'This workflow visit already identifies a different message.',
  });
  expect(await s.messages()).toHaveLength(1);
});

it('retains a completed copy visit’s original content revision after its binding advances', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  await s.run({ mode: 'copy', subject: 'Queued guide', body: 'Queued body' });
  const recorded = await database.withTenant(s.context, (sql) =>
    sql.one<{
      enrolment_id: string;
      output: { messageId: string; emailContent: { binding: string; revision: number } };
    }>("select enrolment_id, output from automation.step_runs where step_key='send'"),
  );
  expect(recorded.output.emailContent.revision).toBe(1);
  await database.withTenant(s.context, async (sql) => {
    await sql.query(
      `insert into automation.email_content_revisions
       (business_id,binding_id,revision,mode,subject,body,created_by_kind)
       select business_id,id,2,'copy','Later guide','Later body','system'
       from automation.email_bindings where id=$1`,
      [recorded.output.emailContent.binding],
    );
    await sql.query('update automation.email_bindings set current_revision=2 where id=$1', [
      recorded.output.emailContent.binding,
    ]);
  });
  const replay = await withTenant(db, s.context, (trx) =>
    sendAutomationEmail(trx, s.context, {
      contactId: s.contactId,
      enrolmentId: recorded.enrolment_id,
      stepKey: 'send',
      mode: 'copy',
      subject: 'Ignored input',
      body: 'Ignored body',
      mailbox: undefined,
      idempotencyKey: `automation:${recorded.enrolment_id}:send:0`,
    }),
  );
  expect(replay).toEqual({
    ok: true,
    messageId: recorded.output.messageId,
    explanation: 'The email was queued to send.',
    emailContent: recorded.output.emailContent,
  });
  expect(await s.messages()).toMatchObject([
    { subject: 'Queued guide', body_text: 'Queued body', status: 'queued' },
  ]);
});

it.each([
  { lane: 'reply', purpose: 'marketing' },
  { lane: 'automation', purpose: 'transactional' },
] as const)('rejects a key already admitted for $lane/$purpose', async ({ lane, purpose }) => {
  const s = await scene();
  const mailbox = await s.mailbox('Sales');
  const accountId = parsePublicId('mailbox', mailbox);
  if (accountId === undefined) throw new Error('The fixture returns a mailbox ID.');
  const template = await s.template('Guide', 'Guide body');
  await s.consent('granted');
  await withTenant(db, s.context, async (trx) => {
    const identity = await trx
      .selectFrom('crm.contact_identities')
      .select('id')
      .where('contact_id', '=', s.contactId)
      .where('kind', '=', 'email')
      .executeTakeFirstOrThrow();
    await queueOutboundMessage(trx, s.context, {
      identityId: identity.id,
      accountId,
      channel: 'email',
      lane,
      purpose,
      subject: 'Other admission',
      text: 'Other body',
      idempotencyKey: 'automation:run:send:0',
    });
  });
  await expect(
    withTenant(db, s.context, (trx) =>
      sendAutomationEmail(trx, s.context, {
        contactId: s.contactId,
        template,
        mailbox,
        idempotencyKey: 'automation:run:send:0',
      }),
    ),
  ).rejects.toMatchObject({ name: 'ConflictError' });
  expect(await s.messages()).toMatchObject([
    { subject: 'Other admission', body_text: 'Other body' },
  ]);
});

it('serializes concurrent deliveries of one email visit before resolving content', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  const send = (subject: string) =>
    withTenant(db, s.context, (trx) =>
      sendAutomationEmail(trx, s.context, {
        contactId: s.contactId,
        subject,
        body: 'Visit body',
        mailbox: undefined,
        idempotencyKey: 'automation:run:send:0',
      }),
    );
  const [first, second] = await Promise.all([send('First admission'), send('Retried admission')]);
  expect(first.ok).toBe(true);
  expect(second).toEqual(first);
  expect(await s.messages()).toHaveLength(1);
});

it.each([
  ['no consent', undefined, 'consent_required'],
  ['withdrawn consent', 'withdrawn', 'consent_withdrawn'],
] as const)('fails the step and sends nothing with %s', async (_, consent, code) => {
  const s = await scene();
  await s.mailbox('Sales');
  const template = await s.template('Hello', 'Hi.');
  if (consent !== undefined) await s.consent(consent);
  expect(await s.run({ template })).toEqual({ status: 'failed', exit_reason: code });
  // Messaging keeps its own record of what it refused, and why; nothing is queued to send.
  expect(await s.messages()).toMatchObject([{ status: 'failed', error_code: code }]);
});

it('fails the step, and makes no message, when a merge value is missing', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  const template = await s.template('Hello', 'About your {{contact.custom.event_date}} event.');
  await s.consent('granted');
  expect(await s.run({ template })).toEqual({ status: 'failed', exit_reason: 'missing_values' });
  expect(await s.messages()).toEqual([]);
});

it('needs the step to name a mailbox when more than one could send, and uses the one named', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  const support = await s.mailbox('Support');
  const template = await s.template('Hello', 'Hi.');
  await s.consent('granted');
  expect(await s.run({ template })).toEqual({ status: 'failed', exit_reason: 'mailbox_required' });
  expect(await s.messages()).toEqual([]);

  const named = await scene();
  await named.mailbox('Sales');
  const chosen = await named.mailbox('Support');
  await named.consent('granted');
  expect(
    await named.run({ template: await named.template('Hello', 'Hi.'), mailbox: chosen }),
  ).toEqual({ status: 'completed', exit_reason: null });
  const [message] = await named.messages();
  expect(toPublicId('mailbox', message?.mailbox ?? '')).toBe(chosen);
  expect(chosen).not.toBe(support);
});

it('fails safely without a mailbox, with an archived template, or with another business’s', async () => {
  const none = await scene();
  await none.consent('granted');
  expect(await none.run({ template: await none.template('Hello', 'Hi.') })).toEqual({
    status: 'failed',
    exit_reason: 'mailbox_required',
  });

  const archived = await scene();
  await archived.mailbox('Sales');
  await archived.consent('granted');
  const template = await archived.template('Hello', 'Hi.');
  await database.as('postgres', (sql) =>
    sql.query('update messaging.templates set archived_at = now()'),
  );
  expect(await archived.run({ template })).toEqual({
    status: 'failed',
    exit_reason: 'template_unavailable',
  });

  const other = await scene();
  const theirs = await other.template('Hello', 'Hi.');
  const theirMailbox = await other.mailbox('Theirs');
  const mine = await scene();
  await mine.mailbox('Sales');
  await mine.consent('granted');
  expect(await mine.run({ template: theirs })).toEqual({
    status: 'failed',
    exit_reason: 'template_unavailable',
  });
  const again = await scene();
  await again.consent('granted');
  expect(
    await again.run({ template: await again.template('Hello', 'Hi.'), mailbox: theirMailbox }),
  ).toEqual({ status: 'failed', exit_reason: 'mailbox_unavailable' });
  expect(await again.messages()).toEqual([]);
});

it('sends only from a mailbox that works and is for conversations, named or not', async () => {
  for (const unusable of [{ status: 'failing' }, { status: 'paused' }, { conversations: false }]) {
    const s = await scene();
    const mailbox = await s.mailbox('Unusable', unusable);
    const template = await s.template('Hello', 'Hi.');
    await s.consent('granted');
    // It is not picked as the only mailbox, and naming it does not help.
    expect(await s.run({ template })).toEqual({
      status: 'failed',
      exit_reason: 'mailbox_required',
    });
    const named = await scene();
    const theirs = await named.mailbox('Unusable', unusable);
    await named.consent('granted');
    expect(
      await named.run({ template: await named.template('Hello', 'Hi.'), mailbox: theirs }),
    ).toEqual({ status: 'failed', exit_reason: 'mailbox_unavailable' });
    expect(await s.messages()).toEqual([]);
    expect(await named.messages()).toEqual([]);
    expect(mailbox).not.toBe(theirs);
  }
  // Beside a usable one, the unusable mailbox doesn't make the choice ambiguous.
  const s = await scene();
  const sales = await s.mailbox('Sales');
  await s.mailbox('Campaigns', { conversations: false });
  await s.consent('granted');
  expect(await s.run({ template: await s.template('Hello', 'Hi.') })).toEqual({
    status: 'completed',
    exit_reason: null,
  });
  const [message] = await s.messages();
  expect(toPublicId('mailbox', message?.mailbox ?? '')).toBe(sales);
});

it('fails the step for a contact marked do not contact, even with consent', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  await database.as('postgres', (sql) =>
    sql.query('update crm.contacts set do_not_contact = true where id = $1', [s.contactId]),
  );
  expect(await s.run({ template: await s.template('Hello', 'Hi.') })).toEqual({
    status: 'failed',
    exit_reason: 'do_not_contact',
  });
  expect(await s.messages()).toMatchObject([{ status: 'failed', error_code: 'do_not_contact' }]);
});

it('fails the step for an address that is suppressed, such as one that bounced', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  await database.as('postgres', (sql) =>
    sql.query(
      `insert into messaging.suppressions (business_id, channel, address_normalized, reason)
       values ($1, 'email', $2, 'hard_bounce')`,
      [s.context.businessId, s.email],
    ),
  );
  expect(await s.run({ template: await s.template('Hello', 'Hi.') })).toEqual({
    status: 'failed',
    exit_reason: 'suppressed',
  });
  expect(await s.messages()).toMatchObject([{ status: 'failed', error_code: 'suppressed' }]);
});

it('holds the email during quiet hours instead of sending it, and the step says so', async () => {
  const s = await scene();
  await s.mailbox('Sales');
  await s.consent('granted');
  // Quiet all day in the contact's own time zone: the same start and end.
  await database.as('postgres', async (sql) => {
    await sql.query(
      `update messaging.settings set quiet_hours_enabled = true,
         quiet_hours_start = '21:00', quiet_hours_end = '21:00' where business_id = $1`,
      [s.context.businessId],
    );
    await sql.query("update crm.contacts set timezone = 'Africa/Nairobi' where id = $1", [
      s.contactId,
    ]);
  });
  expect(await s.run({ template: await s.template('Hello', 'Hi.') })).toEqual({
    status: 'completed',
    exit_reason: null,
  });
  const [message] = await database.withTenant(s.context, (sql) =>
    sql.query<{ status: string; error_code: string | null; later: boolean }>(
      'select status, error_code, scheduled_for > now() as later from messaging.messages',
    ),
  );
  // Still queued, not refused: messaging tries it again once the quiet hours are over.
  expect(message).toEqual({ status: 'queued', error_code: 'quiet_hours', later: true });
  const [stepRun] = await database.withTenant(s.context, (sql) =>
    sql.query<{ status: string; explanation: string }>(
      'select status, explanation from automation.step_runs',
    ),
  );
  expect(stepRun).toEqual({
    status: 'succeeded',
    explanation: "The email was queued; it is held until the contact's quiet hours end.",
  });
});
