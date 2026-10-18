import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import { automationDraftSaved, messageTemplate } from '@repo/contracts';
import { createTemplateCommands, createTemplateRoutes, readTemplate } from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { createDraftCommands, readAutomation } from './drafts.js';
import { createEmailTemplateCopyCommand } from './email-template-copy.js';
import { createAutomationRoutes } from './routes.js';

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

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const invocation = {
    context: { ...business.context, correlationId: randomUUID() },
    permissions: 'all' as const,
  };
  const setup = () =>
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
      channels: { email: false, sms: false, whatsapp: false },
      ai: false,
      webhooks: false,
      unavailableSteps: [],
      unavailableTriggers: [],
    });
  const drafts = createDraftCommands({ setup });
  const templates = createTemplateCommands();
  const template = await runCommand(
    services,
    templates.create,
    { name: 'Welcome', subject: 'Your guide', body: 'Hello {{contact.firstName}}' },
    invocation,
  );
  const draft = await runCommand(
    services,
    drafts.create,
    {
      document: {
        name: 'Welcome workflow',
        steps: {
          email: {
            type: 'email.send',
            label: 'First welcome',
            next: 'later',
            config: { template: template.id },
          },
          later: { type: 'wait', config: { duration: 'PT1M' } },
        },
      },
    },
    invocation,
  );
  const copy = createEmailTemplateCopyCommand({ setup });
  const input = {
    id: draft.automation.id,
    baseDraftVersion: 1,
    step: 'email',
    template: template.id,
    revision: template.revision,
  };
  return { invocation, template, templates, draft, copy, input };
}

it('copies literal content through the canonical draft command and isolates later library edits', async () => {
  const f = await fixture();
  const saved = await runCommand(services, f.copy, f.input, f.invocation);
  expect(saved.automation.draftVersion).toBe(2);
  expect(saved.automation.draft['steps']).toEqual({
    email: {
      type: 'email.send',
      label: 'First welcome',
      next: 'later',
      config: {
        mode: 'copy',
        source: { id: f.template.id, revision: f.template.revision },
        subject: 'Your guide',
        body: 'Hello {{contact.firstName}}',
      },
    },
    later: { type: 'wait', config: { duration: 'PT1M' } },
  });
  await runCommand(
    services,
    f.templates.update,
    {
      id: f.template.id,
      revision: f.template.revision,
      name: 'Welcome',
      subject: 'Changed library',
      body: 'Changed body',
    },
    f.invocation,
  );
  const read = await withTenant(db, f.invocation.context, (trx) => readAutomation(trx, f.input.id));
  expect(read.draft).toEqual(saved.automation.draft);
});

it('saves a distinct library template through the API without altering the original or copied action', async () => {
  const f = await fixture();
  const copied = await runCommand(services, f.copy, f.input, f.invocation);
  const create = createTemplateRoutes().find(
    (route) => route.endpoint.operationId === 'createMessageTemplate',
  );
  if (create === undefined) throw new Error('Canonical template create route is required.');
  const created = messageTemplate.parse(
    await create.run(
      {
        invocation: f.invocation,
        params: {},
        query: {},
        body: {
          name: 'Workflow variation',
          subject: 'Edited guide',
          body: 'Independent variation.',
        },
      },
      services,
    ),
  );
  expect(created.id).not.toBe(f.template.id);
  expect(created).toMatchObject({
    name: 'Workflow variation',
    subject: 'Edited guide',
    body: 'Independent variation.',
  });
  const source = await withTenant(db, f.invocation.context, (trx) =>
    readTemplate(trx, f.invocation, f.template.id),
  );
  expect(source).toMatchObject({
    name: 'Welcome',
    subject: 'Your guide',
    body: 'Hello {{contact.firstName}}',
    revision: f.template.revision,
  });
  const workflow = await withTenant(db, f.invocation.context, (trx) =>
    readAutomation(trx, f.input.id),
  );
  expect(workflow.draftVersion).toBe(2);
  expect(workflow.draft).toEqual(copied.automation.draft);
});

it('rejects a stale source revision without saving a draft', async () => {
  const f = await fixture();
  await expect(
    runCommand(services, f.copy, { ...f.input, revision: '0'.repeat(64) }, f.invocation),
  ).rejects.toBeInstanceOf(ConflictError);
  const read = await withTenant(db, f.invocation.context, (trx) => readAutomation(trx, f.input.id));
  expect(read.draftVersion).toBe(1);
  expect(read.draft).toEqual(f.draft.automation.draft);
});

it('copies into a new pending action and saves other unsaved edits in the same draft revision', async () => {
  const f = await fixture();
  const pending = {
    name: 'Pending title',
    description: 'Pending description',
    steps: {
      fresh: { type: 'email.send', label: 'New action', config: { mailbox: 'Chosen mailbox' } },
    },
  };
  const saved = await runCommand(
    services,
    f.copy,
    { ...f.input, step: 'fresh', document: pending },
    f.invocation,
  );
  expect(saved.automation.draftVersion).toBe(2);
  expect(saved.automation.draft).toEqual({
    name: 'Pending title',
    description: 'Pending description',
    steps: {
      fresh: {
        type: 'email.send',
        label: 'New action',
        config: {
          mailbox: 'Chosen mailbox',
          mode: 'copy',
          source: { id: f.template.id, revision: f.template.revision },
          subject: 'Your guide',
          body: 'Hello {{contact.firstName}}',
        },
      },
    },
  });
});

it('rejects a stale draft version and an absent action without saving', async () => {
  const f = await fixture();
  await expect(
    runCommand(services, f.copy, { ...f.input, baseDraftVersion: 2 }, f.invocation),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    runCommand(services, f.copy, { ...f.input, step: 'missing' }, f.invocation),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('cannot copy another business’s template', async () => {
  const own = await fixture();
  const other = await fixture();
  await expect(
    runCommand(
      services,
      own.copy,
      { ...own.input, template: other.template.id, revision: other.template.revision },
      own.invocation,
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('refuses an archived template without changing the workflow', async () => {
  const f = await fixture();
  const archived = await runCommand(
    services,
    f.templates.archive,
    { id: f.template.id, revision: f.template.revision },
    f.invocation,
  );
  await expect(
    runCommand(services, f.copy, { ...f.input, revision: archived.revision }, f.invocation),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('serves the copy endpoint with the documented draft response and enforces permission', async () => {
  const f = await fixture();
  const route = createAutomationRoutes({
    users: () => Promise.resolve([]),
    webhookDelivery: false,
  }).find((route) => route.endpoint.operationId === 'copyWorkflowEmailTemplate');
  if (route === undefined) throw new Error('Copy endpoint is missing.');
  const { id, ...body } = f.input;
  const request = { invocation: f.invocation, params: { id }, query: {}, body };
  await expect(
    route.run({ ...request, invocation: { ...f.invocation, permissions: new Set() } }, services),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const unchanged = await withTenant(db, f.invocation.context, (trx) => readAutomation(trx, id));
  expect(unchanged.draftVersion).toBe(1);
  const answer = automationDraftSaved.parse(await route.run(request, services));
  expect(answer.automation.draftVersion).toBe(2);
  expect(answer.automation.draft['steps']).toEqual({
    email: {
      type: 'email.send',
      label: 'First welcome',
      next: 'later',
      config: {
        mode: 'copy',
        source: { id: f.template.id, revision: f.template.revision },
        subject: 'Your guide',
        body: 'Hello {{contact.firstName}}',
      },
    },
    later: { type: 'wait', config: { duration: 'PT1M' } },
  });
});
