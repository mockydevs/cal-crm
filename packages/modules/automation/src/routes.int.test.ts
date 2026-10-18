// The automation API's routes as the server runs them (AUTOMATIONS.md section 5): the whole
// flow an AI or the builder follows, with every answer checked against the schema the API
// documents, and each permission enforced. Real Postgres.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  runCommand,
  type ApiRoute,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  automation,
  automationDraftSaved,
  automationExport,
  automationFolder,
  automationFolderList,
  automationRunList,
  automationStats,
  automationStepRunList,
  automationTestRun,
  messageTemplate,
  messageTemplateList,
  rotatedAutomationWebhookSecret,
  syncedWorkflowEmailSaved,
  templateWorkflowActionList,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { createTemplateRoutes } from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { matchEvent } from './enrolment.js';
import { createAutomationRoutes } from './routes.js';
import { createRunStepCommand } from './runner.js';
import { readTemplateUseCounts } from './template-uses.js';
import { contactValues } from './values.js';
import { WEBHOOK_SECRET_PREFIX } from './webhook-signing.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let routes: readonly ApiRoute[];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  routes = createAutomationRoutes({
    users: () => Promise.resolve([]),
    // An install with no vault: the secret is rotated, with real rows, in
    // webhook-signing.int.test.ts.
    webhookDelivery: false,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function inBusiness(
  permissions: Invocation['permissions'] = 'all',
): Promise<Invocation & { tag(name: string): Promise<void> }> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  return {
    context,
    permissions,
    tag: async (name) => {
      await database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.tags (business_id, name, created_by_kind)
           values (app.business_id(), $1, 'user')`,
          [name],
        ),
      );
    },
  };
}

/** Calls a route as the server does, and checks the answer against its documented schema. */
async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
  served: readonly ApiRoute[] = routes,
): Promise<unknown> {
  const route = served.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`No route for ${operationId}.`);
  const answer = await route.run(
    {
      invocation: { context: invocation.context, permissions: invocation.permissions },
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    services,
  );
  const schema = route.endpoint.response.schema;
  if (schema === undefined) {
    // Only an operation that answers 204 documents no body, and then it must send none.
    if (route.endpoint.response.status !== 204)
      throw new Error(`${operationId} documents no response.`);
    expect(answer, operationId).toBeUndefined();
    return undefined;
  }
  return schema.parse(answer);
}

const welcome = {
  name: 'Welcome',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'pause',
  steps: {
    pause: { type: 'wait', config: { duration: 'P1D' }, next: 'tag' },
    tag: { type: 'tag.add', config: { tag: 'VIP' } },
  },
};

it('serves every operation AUTOMATIONS.md lists, once each', () => {
  expect(routes.map((route) => route.endpoint.operationId).sort()).toEqual(
    [
      'continueAutomationRun',
      'copyWorkflowEmailTemplate',
      'createAutomation',
      'createAutomationFolder',
      'createAutomationTestRun',
      'deleteAutomation',
      'deleteAutomationFolder',
      'deleteAutomationWebhookSecret',
      'diffAutomationVersions',
      'enableWorkflowEmailSync',
      'explainAutomationContact',
      'exportAutomation',
      'getAutomation',
      'getAutomationCatalog',
      'getAutomationRun',
      'getAutomationSchema',
      'getAutomationStats',
      'getAutomationTestRun',
      'getAutomationVersion',
      'getAutomationWebhookSigning',
      'getWorkflowEmailStepStatistics',
      'importAutomation',
      'listAutomationFolders',
      'listAutomationRuns',
      'listAutomationStepRuns',
      'listAutomationTriggerEvaluations',
      'listAutomationVersions',
      'listAutomationWebhookSecrets',
      'listAutomations',
      'listRecordAutomationRuns',
      'listTemplateWorkflowActions',
      'moveAutomation',
      'patchAutomationDraft',
      'pauseAutomation',
      'publishAutomation',
      'putAutomationWebhookSecret',
      'replaceAutomationDraft',
      'restoreAutomation',
      'resumeAutomation',
      'retryAutomationRun',
      'rotateAutomationWebhookSecret',
      'saveSyncedWorkflowEmail',
      'updateAutomationFolder',
      'validateAutomation',
    ].sort(),
  );
  const paths = routes.map((route) => `${route.endpoint.method} ${route.endpoint.path}`);
  expect(new Set(paths).size).toBe(paths.length);
});

it('serves sync with a template, the actions that use one, and a step’s statistics', async () => {
  const caller = await inBusiness();
  const other = await inBusiness();
  const template = messageTemplate.parse(
    await call(
      'createMessageTemplate',
      caller,
      {
        body: {
          name: 'Welcome',
          subject: 'Welcome',
          content: { format: 'html', html: '<p>Hi</p>' },
        },
      },
      createTemplateRoutes(),
    ),
  );
  const send = {
    name: 'Send',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'send',
    steps: {
      send: { type: 'email.send', config: { subject: 'Own', body: 'Own', fromName: 'Desk' } },
    },
  };
  const created = automationDraftSaved.parse(
    await call('createAutomation', caller, { body: { document: send } }),
  );
  const params = { id: created.automation.id };
  const enabled = automationDraftSaved.parse(
    await call('enableWorkflowEmailSync', caller, {
      params,
      body: {
        baseDraftVersion: 1,
        step: 'send',
        template: template.id,
        revision: template.revision,
      },
    }),
  );
  expect(enabled.automation.draft['steps']).toEqual({
    send: {
      type: 'email.send',
      config: {
        mode: 'sync',
        source: { id: template.id, revision: template.revision },
        fromName: 'Desk',
      },
    },
  });
  const saved = syncedWorkflowEmailSaved.parse(
    await call('saveSyncedWorkflowEmail', caller, {
      params,
      body: {
        baseDraftVersion: 2,
        step: 'send',
        revision: template.revision,
        subject: 'Welcome back',
        content: { format: 'html', html: '<p>Hi again</p><script>x</script>' },
      },
    }),
  );
  expect(saved.template).toMatchObject({
    subject: 'Welcome back',
    content: { format: 'html', html: '<p>Hi again</p>', text: 'Hi again' },
    // Answered as the template routes answer it: with what sends it and what it cannot fill.
    usedBy: [],
    unfillableFields: [],
  });
  expect(saved.saved.automation.draftVersion).toBe(3);
  const actions = templateWorkflowActionList.parse(
    await call('listTemplateWorkflowActions', caller, { params: { id: template.id } }),
  );
  expect(actions).toEqual({
    items: [
      {
        automation: { id: created.automation.id, name: 'Send', status: 'draft' },
        scope: 'draft',
        version: null,
        step: 'send',
        label: null,
        mode: 'sync',
        sourceRevision: saved.template.revision,
        current: null,
      },
    ],
    nextCursor: null,
  });
  // The list of templates says how many workflows use each, in one question for the page:
  // the same workflows the inventory above lists one template at a time.
  const counted = createTemplateRoutes({ useCounts: readTemplateUseCounts });
  await call(
    'createMessageTemplate',
    caller,
    { body: { name: 'Unused', subject: 'Nothing', body: 'x' } },
    counted,
  );
  const listed = messageTemplateList.parse(await call('listMessageTemplates', caller, {}, counted));
  expect(listed.total).toBe(2);
  expect(listed.items.map((item) => [item.name, item.workflowUses])).toEqual([
    ['Unused', 0],
    ['Welcome', 1],
  ]);
  // A library with nothing in it asks nothing of the workflows.
  expect(
    messageTemplateList.parse(await call('listMessageTemplates', other, {}, counted)),
  ).toMatchObject({ items: [], total: 0 });
  // Another business's templates are counted against its own workflows only.
  await call(
    'createMessageTemplate',
    other,
    { body: { name: 'Welcome', subject: 'Theirs', body: 'x' } },
    counted,
  );
  expect(
    messageTemplateList
      .parse(await call('listMessageTemplates', other, {}, counted))
      .items.map((item) => [item.name, item.workflowUses]),
  ).toEqual([['Welcome', 0]]);
  expect(
    await call('getWorkflowEmailStepStatistics', caller, { params: { ...params, step: 'send' } }),
  ).toMatchObject({
    step: 'send',
    total: 0,
    sent: 0,
    delivered: null,
    opened: null,
    clicked: null,
  });
  // Another business finds neither the template nor the automation.
  await expect(
    call('listTemplateWorkflowActions', other, { params: { id: template.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('getWorkflowEmailStepStatistics', other, { params: { ...params, step: 'send' } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('enableWorkflowEmailSync', other, {
      params,
      body: {
        baseDraftVersion: 3,
        step: 'send',
        template: template.id,
        revision: saved.template.revision,
      },
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  // Malformed requests are validation errors, and a reader may not change a draft.
  await expect(
    call('getWorkflowEmailStepStatistics', caller, {
      params: { ...params, step: 'send' },
      query: { from: 'soon' },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('listTemplateWorkflowActions', caller, {
      params: { id: template.id },
      query: { limit: 0 },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('listTemplateWorkflowActions', caller, {
      params: { id: template.id },
      query: { after: template.id },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    call('enableWorkflowEmailSync', caller, {
      params,
      body: {
        baseDraftVersion: 3,
        step: 'missing',
        template: template.id,
        revision: saved.template.revision,
      },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
});
it('takes a builder from the catalog to a live automation and its export', async () => {
  const caller = await inBusiness();
  await caller.tag('VIP');

  const schema = await call('getAutomationSchema', caller);
  expect(schema).toMatchObject({ type: 'object' });
  const catalog = await call('getAutomationCatalog', caller);
  expect(catalog).toMatchObject({
    formatVersion: 1,
    setup: { tags: [{ name: 'VIP' }], channels: { email: false } },
  });

  // Check first, without saving: a typo comes back at its place, with the fix.
  const typo = {
    ...welcome,
    steps: { ...welcome.steps, tag: { type: 'tag.add', config: { tag: 'VIPP' } } },
  };
  expect(await call('validateAutomation', caller, { body: { document: typo } })).toMatchObject({
    valid: false,
    errors: [
      { path: '/steps/tag/config/tag', code: 'unknown_reference', suggestion: 'Did you mean VIP?' },
    ],
  });

  const created = automationDraftSaved.parse(
    await call('createAutomation', caller, { body: { document: typo } }),
  );
  expect(created.validation.valid).toBe(false);
  const params = { id: created.automation.id };
  await expect(
    call('publishAutomation', caller, { params, body: { baseDraftVersion: 1 } }),
  ).rejects.toBeInstanceOf(ValidationError);

  const patched = automationDraftSaved.parse(
    await call('patchAutomationDraft', caller, {
      params,
      body: {
        baseDraftVersion: 1,
        patch: [{ op: 'replace', path: '/steps/tag/config/tag', value: 'VIP' }],
      },
    }),
  );
  expect(patched).toMatchObject({ automation: { draftVersion: 2 }, validation: { valid: true } });
  await expect(
    call('replaceAutomationDraft', caller, {
      params,
      body: { baseDraftVersion: 1, document: welcome },
    }),
  ).rejects.toBeInstanceOf(ConflictError);

  const run = automationTestRun.parse(
    await call('createAutomationTestRun', caller, {
      params,
      body: { values: { 'contact.firstName': 'Ada' }, start: '2026-10-09T09:00:00Z' },
    }),
  );
  expect(run).toMatchObject({ status: 'passed', outcome: { kind: 'completed' }, draftVersion: 2 });
  expect(run.steps.map((step) => step.kind)).toEqual(['waited', 'would_change']);
  expect(
    await call('getAutomationTestRun', caller, { params: { ...params, runId: run.id } }),
  ).toEqual(run);

  const live = automation.parse(
    await call('publishAutomation', caller, {
      params,
      body: { baseDraftVersion: 2, changeSummary: 'First version' },
    }),
  );
  expect(live).toMatchObject({ status: 'active', liveVersion: 1 });
  expect(await call('listAutomations', caller, { query: { status: 'active' } })).toMatchObject({
    items: [{ id: live.id, liveVersion: 1 }],
    nextCursor: null,
  });
  expect(await call('listAutomations', caller, { query: { status: 'paused' } })).toMatchObject({
    items: [],
  });
  expect(await call('pauseAutomation', caller, { params })).toMatchObject({ status: 'paused' });
  expect(await call('resumeAutomation', caller, { params })).toMatchObject({ status: 'active' });
  expect(await call('listAutomationVersions', caller, { params })).toMatchObject({
    items: [{ version: 1, changeSummary: 'First version' }],
  });
  // Path numbers arrive as text, as they do over HTTP.
  expect(
    await call('getAutomationVersion', caller, { params: { ...params, version: '1' } }),
  ).toMatchObject({ version: 1 });
  expect(
    await call('diffAutomationVersions', caller, { params: { ...params, from: '1', to: '1' } }),
  ).toEqual({ from: 1, to: 1, patch: [] });
  expect(await call('listAutomationRuns', caller, { params })).toEqual({
    items: [],
    nextCursor: null,
  });

  // The live document holds the tag's id; the export names it again, so it can travel.
  const exported = automationExport.parse(
    await call('exportAutomation', caller, { params, query: { source: 'live' } }),
  );
  expect(exported.warnings).toEqual([]);
  expect(exported.document).toMatchObject({ steps: { tag: { config: { tag: 'VIP' } } } });
  expect(live.live?.document).not.toMatchObject({ steps: { tag: { config: { tag: 'VIP' } } } });

  // Elsewhere it arrives as a draft, never live, and says what that business lacks.
  const elsewhere = await inBusiness();
  const imported = automationDraftSaved.parse(
    await call('importAutomation', elsewhere, { body: exported }),
  );
  expect(imported.automation).toMatchObject({
    status: 'draft',
    liveVersion: null,
    name: 'Welcome',
  });
  expect(imported.validation).toMatchObject({
    valid: false,
    errors: [{ path: '/steps/tag/config/tag', code: 'unknown_reference' }],
  });
  await elsewhere.tag('vip');
  expect(
    await call('validateAutomation', elsewhere, { body: { document: imported.automation.draft } }),
  ).toMatchObject({ valid: true });
});

it('lets any member read, and keeps changes, checks and publishing to their permissions', async () => {
  const owner = await inBusiness();
  const { automation: draft } = automationDraftSaved.parse(
    await call('createAutomation', owner, { body: { document: welcome } }),
  );
  const params = { id: draft.id };
  const as = (...permissions: Permission[]): Invocation => ({
    context: { ...owner.context, correlationId: randomUUID() },
    permissions: new Set(permissions),
  });

  const member = as();
  for (const [operationId, request] of [
    ['getAutomationSchema', {}],
    ['getAutomationCatalog', {}],
    ['listAutomations', {}],
    ['getAutomation', { params }],
    ['listAutomationVersions', { params }],
    ['listAutomationRuns', { params }],
    ['listAutomationStepRuns', { params }],
    ['getAutomationStats', { params }],
    ['listAutomationFolders', {}],
    ['exportAutomation', { params }],
    ['getAutomationWebhookSigning', {}],
  ] as const)
    await expect(call(operationId, member, request), operationId).resolves.toBeDefined();
  // A folder to try the folder changes on, made by someone who may.
  const folder = automationFolder.parse(
    await call('createAutomationFolder', owner, { body: { name: 'Leads' } }),
  );
  const folderParams = { id: folder.id };

  const manage = { permission: 'automations.manage' };
  const publish = { permission: 'automations.publish' };
  for (const [operationId, request, needs] of [
    ['createAutomation', { body: { document: welcome } }, manage],
    [
      'importAutomation',
      { body: { format: 'crm.automation', formatVersion: 1, document: welcome } },
      manage,
    ],
    [
      'replaceAutomationDraft',
      { params, body: { baseDraftVersion: 1, document: welcome } },
      manage,
    ],
    [
      'patchAutomationDraft',
      {
        params,
        body: { baseDraftVersion: 1, patch: [{ op: 'test', path: '/name', value: 'Welcome' }] },
      },
      manage,
    ],
    ['validateAutomation', { body: { document: welcome } }, manage],
    ['createAutomationTestRun', { params, body: {} }, manage],
    ['publishAutomation', { params, body: { baseDraftVersion: 1 } }, publish],
    ['pauseAutomation', { params }, publish],
    ['resumeAutomation', { params }, publish],
    ['rotateAutomationWebhookSecret', {}, publish],
    ['createAutomationFolder', { body: { name: 'Mine' } }, manage],
    [
      'updateAutomationFolder',
      { params: folderParams, body: { revision: 1, name: 'Mine' } },
      manage,
    ],
    ['deleteAutomationFolder', { params: folderParams }, manage],
    ['moveAutomation', { params, body: { folderId: folder.id } }, manage],
    ['deleteAutomation', { params }, publish],
    ['restoreAutomation', { params }, publish],
  ] as const) {
    const refused = call(operationId, member, request);
    await expect(refused, operationId).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refused, operationId).rejects.toMatchObject(needs);
  }
  // Managing drafts does not allow deleting an automation, or restoring one.
  await expect(
    call('deleteAutomation', as('automations.manage'), { params }),
  ).rejects.toMatchObject(publish);
  // Each read of the folders says whether its caller may change them.
  expect(await call('listAutomationFolders', member)).toMatchObject({
    canManage: false,
    items: [{ id: folder.id, name: 'Leads' }],
  });
  expect(await call('listAutomationFolders', as('automations.manage'))).toMatchObject({
    canManage: true,
  });
  // Managing drafts does not allow publishing them.
  await expect(
    call('publishAutomation', as('automations.manage'), { params, body: { baseDraftVersion: 1 } }),
  ).rejects.toMatchObject(publish);
  // Nothing a refused caller tried was saved.
  // Each read says what its caller may do, so a screen never offers what would be refused.
  expect(await call('getAutomation', member, { params })).toMatchObject({
    draftVersion: 1,
    status: 'draft',
    canManage: false,
    canPublish: false,
  });
  expect(await call('listAutomations', member)).toMatchObject({
    canManage: false,
    items: [{ id: draft.id }],
  });
  expect(await call('getAutomation', as('automations.manage'), { params })).toMatchObject({
    canManage: true,
    canPublish: false,
  });
  expect(await call('listAutomations', as('automations.manage'))).toMatchObject({
    canManage: true,
  });
  expect(await call('getAutomation', as('automations.publish'), { params })).toMatchObject({
    canManage: false,
    canPublish: true,
  });
  expect(await call('getAutomation', owner, { params })).toMatchObject({
    canManage: true,
    canPublish: true,
  });
});

it('takes a workflow through its list and its tabs: folders, statistics, history, logs, delete and restore', async () => {
  const caller = await inBusiness();
  await caller.tag('VIP');
  const created = automationDraftSaved.parse(
    await call('createAutomation', caller, { body: { document: welcome } }),
  );
  const params = { id: created.automation.id };
  await call('publishAutomation', caller, { params, body: { baseDraftVersion: 1 } });

  // Folders: made, nested, renamed from the revision seen, and listed as one tree.
  const leads = automationFolder.parse(
    await call('createAutomationFolder', caller, { body: { name: 'Leads' } }),
  );
  const warm = automationFolder.parse(
    await call('createAutomationFolder', caller, { body: { name: 'Warm', parentId: leads.id } }),
  );
  const renamed = automationFolder.parse(
    await call('updateAutomationFolder', caller, {
      params: { id: warm.id },
      body: { revision: 1, name: 'Warm leads' },
    }),
  );
  expect(renamed).toMatchObject({ name: 'Warm leads', revision: 2, parentId: leads.id });
  await expect(
    call('updateAutomationFolder', caller, {
      params: { id: warm.id },
      body: { revision: 1, name: 'Lost?' },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  const moved = automation.parse(
    await call('moveAutomation', caller, { params, body: { folderId: warm.id } }),
  );
  expect(moved.folderId).toBe(warm.id);
  expect(automationFolderList.parse(await call('listAutomationFolders', caller))).toMatchObject({
    canManage: true,
    items: [
      { id: leads.id, name: 'Leads', parentId: null, automationCount: 0 },
      { id: warm.id, name: 'Warm leads', parentId: leads.id, automationCount: 1 },
    ],
  });
  expect(
    await call('listAutomations', caller, { query: { folder: warm.id, q: 'welc' } }),
  ).toMatchObject({ items: [{ id: params.id, folderId: warm.id }] });
  expect(await call('listAutomations', caller, { query: { folder: 'root' } })).toMatchObject({
    items: [],
  });

  // A contact goes in, and takes its first step: the wait.
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    { context: caller.context, permissions: 'all' },
  );
  const enrolmentId = await withTenant(db, caller.context, async (trx) => {
    const event = await trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow();
    const [first] = (await matchEvent(trx, caller.context, event.id, contactValues)).enrolled;
    return first?.enrolmentId ?? '';
  });
  await runCommand(
    services,
    createRunStepCommand({
      tasks: {
        actorNames: {},
        assignees: {
          resolve: () => Promise.resolve(null),
          read: () => Promise.resolve({ items: [], nextCursor: null }),
          memberships: () => Promise.resolve(new Map<string, string>()),
        },
      },
    }),
    { enrolmentId, sequence: 0 },
    { context: caller.context, permissions: 'all' },
  );

  // The list counts it; the statistics count it by trigger and by step.
  expect(await call('listAutomations', caller)).toMatchObject({
    items: [{ id: params.id, totalEnrolled: 1, activeEnrolled: 1, deletedAt: null }],
  });
  const waitingAtPause = { entered: 1, completed: 0, failed: 0, waiting: 1, skipped: 0 };
  expect(automationStats.parse(await call('getAutomationStats', caller, { params }))).toMatchObject(
    {
      automationId: params.id,
      liveVersion: 1,
      runs: { allTime: { enrolled: 1, active: 1 }, live: { enrolled: 1, active: 1 } },
      triggers: [
        { trigger: 'created', type: 'contact.created', inLiveVersion: true, live: { enrolled: 1 } },
      ],
      steps: [
        { step: 'pause', type: 'wait', inLiveVersion: true, live: waitingAtPause },
        { step: 'tag', type: 'tag.add', live: { entered: 0 } },
      ],
    },
  );
  // The enrollment history and the execution logs, with their filters as a caller sends them.
  const history = automationRunList.parse(
    await call('listAutomationRuns', caller, {
      params,
      query: { status: 'waiting', trigger: 'created', from: '2020-01-01T00:00:00Z' },
    }),
  );
  expect(history.items).toMatchObject([
    {
      status: 'waiting',
      trigger: { id: 'created', type: 'contact.created' },
      currentAction: { step: 'pause', type: 'wait', label: null },
    },
  ]);
  const record = history.items[0]?.record.id ?? '';
  const logs = automationStepRunList.parse(
    await call('listAutomationStepRuns', caller, {
      params,
      query: { status: 'waiting', step: 'pause', type: 'wait', record },
    }),
  );
  expect(logs.items).toMatchObject([
    { step: 'pause', type: 'wait', status: 'waiting', runId: history.items[0]?.id, version: 1 },
  ]);
  expect(
    await call('listAutomationStepRuns', caller, { params, query: { status: 'failed' } }),
  ).toEqual({ items: [], nextCursor: null });

  // Deleted: on the Deleted list, its run cancelled; restored: paused, at the top level.
  const deleted = automation.parse(await call('deleteAutomation', caller, { params }));
  expect(deleted).toMatchObject({ status: 'archived', folderId: null, activeEnrolled: 0 });
  expect(deleted.deletedAt).toEqual(expect.any(String));
  expect(await call('listAutomations', caller)).toMatchObject({ items: [] });
  expect(await call('listAutomations', caller, { query: { status: 'archived' } })).toMatchObject({
    items: [{ id: params.id, status: 'archived' }],
  });
  expect(
    automationRunList.parse(await call('listAutomationRuns', caller, { params })).items,
  ).toMatchObject([{ status: 'cancelled', exitReason: 'automation_deleted', currentAction: null }]);
  // A deleted automation is not edited, published or tested until it is restored.
  await expect(
    call('createAutomationTestRun', caller, { params, body: {} }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('moveAutomation', caller, { params, body: { folderId: leads.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(automation.parse(await call('restoreAutomation', caller, { params }))).toMatchObject({
    status: 'paused',
    folderId: null,
    deletedAt: null,
    liveVersion: 1,
  });

  // A folder deleted: what was in it is one level up, and the folder is gone.
  expect(
    await call('deleteAutomationFolder', caller, { params: { id: leads.id } }),
  ).toBeUndefined();
  expect(
    automationFolderList.parse(await call('listAutomationFolders', caller)).items,
  ).toMatchObject([{ id: warm.id, name: 'Warm leads', parentId: null, revision: 3 }]);

  // None of it is another business's to read or change.
  const elsewhere = await inBusiness();
  for (const [operationId, request] of [
    ['getAutomationStats', { params }],
    ['listAutomationStepRuns', { params }],
    ['deleteAutomation', { params }],
    ['restoreAutomation', { params }],
    ['moveAutomation', { params, body: { folderId: null } }],
    ['updateAutomationFolder', { params: { id: warm.id }, body: { revision: 3, name: 'Theirs' } }],
    ['deleteAutomationFolder', { params: { id: warm.id } }],
  ] as const)
    await expect(call(operationId, elsewhere, request), operationId).rejects.toBeInstanceOf(
      NotFoundError,
    );
  expect(await call('listAutomationFolders', elsewhere)).toMatchObject({ items: [] });
});

it('says there is no signing secret, and refuses to make one on an install with no vault', async () => {
  const caller = await inBusiness();
  expect(await call('getAutomationWebhookSigning', caller)).toEqual({
    configured: false,
    rotatedAt: null,
  });
  const refused = call('rotateAutomationWebhookSecret', caller);
  await expect(refused).rejects.toBeInstanceOf(ConflictError);
  await expect(refused).rejects.toThrow(/no secrets vault/);
  expect(await call('getAutomationCatalog', caller)).toMatchObject({ setup: { webhooks: false } });
});

it('has no live document to export before a publish, and reads a real run by its id', async () => {
  const caller = await inBusiness();
  await caller.tag('VIP');
  const created = automationDraftSaved.parse(
    await call('createAutomation', caller, { body: { document: welcome } }),
  );
  const params = { id: created.automation.id };
  await expect(
    call('exportAutomation', caller, { params, query: { source: 'live' } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  // The draft exports all the same: it is the default.
  expect(await call('exportAutomation', caller, { params })).toMatchObject({
    document: { name: 'Welcome' },
  });

  await call('publishAutomation', caller, { params, body: { baseDraftVersion: 1 } });
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', emails: [`${randomUUID()}@example.test`] },
    { context: caller.context, permissions: 'all' },
  );
  await withTenant(db, caller.context, async (trx) => {
    const event = await trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'contact.created')
      .executeTakeFirstOrThrow();
    await matchEvent(trx, caller.context, event.id, contactValues);
  });
  const list = automationRunList.parse(await call('listAutomationRuns', caller, { params }));
  const [run] = list.items;
  if (run === undefined || list.items.length !== 1) throw new Error('One run is listed.');
  expect(await call('getAutomationRun', caller, { params: { runId: run.id } })).toMatchObject({
    id: run.id,
    automationId: created.automation.id,
    version: 1,
    status: 'running',
    currentStep: 'pause',
    steps: [],
  });
  // The same run from the contact's side: every automation the record has been through.
  expect(run.record).toMatchObject({ name: 'Ada', trashed: false });
  expect(await call('listRecordAutomationRuns', caller, { params: { id: run.record.id } })).toEqual(
    list,
  );
  // A run is read by its own id alone, and still only inside its business.
  const elsewhere = await inBusiness();
  await expect(
    call('getAutomationRun', elsewhere, { params: { runId: run.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('listRecordAutomationRuns', elsewhere, { params: { id: run.record.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  // Running a run again is for one that failed, and only inside its business.
  await expect(
    call('retryAutomationRun', caller, { params: { runId: run.id } }),
  ).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'Only a run that failed can be run again; this one is running.',
  });
  await expect(
    call('retryAutomationRun', elsewhere, { params: { runId: run.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  // What the automation did for the contact, from its runs and from what the match kept:
  // the run, and no time it did not start. Query strings arrive as text.
  expect(
    await call('explainAutomationContact', caller, { params, query: { contactId: run.record.id } }),
  ).toMatchObject({
    automationId: created.automation.id,
    automationStatus: 'active',
    recordId: run.record.id,
    state: 'has_run',
    runs: 1,
    run: { id: run.id, status: 'running' },
    ended: null,
    evaluations: [],
  });
  expect(
    await call('listAutomationTriggerEvaluations', caller, {
      params,
      query: { contactId: run.record.id, limit: '10' },
    }),
  ).toEqual({ items: [], nextCursor: null });
  await expect(
    call('listAutomationTriggerEvaluations', caller, { params, query: { limit: '0' } }),
  ).rejects.toMatchObject({ name: 'ValidationError' });
  await expect(
    call('explainAutomationContact', caller, { params, query: {} }),
  ).rejects.toMatchObject({ name: 'ValidationError' });
  await expect(
    call('listAutomationTriggerEvaluations', elsewhere, { params }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('explainAutomationContact', elsewhere, { params, query: { contactId: run.record.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  // Continuing a run is for one that waits, and only inside its business.
  await expect(
    call('continueAutomationRun', caller, { params: { runId: run.id }, body: {} }),
  ).rejects.toMatchObject({
    name: 'ConflictError',
    message: 'Only a run that is waiting can be continued; this one is running.',
  });
  await expect(
    call('continueAutomationRun', elsewhere, { params: { runId: run.id }, body: {} }),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('makes a signing secret on an install with a vault, and then offers webhook steps', async () => {
  const sealed = () => sql<Buffer>`decode(repeat('ab', 32), 'hex')`;
  const purposes: string[] = [];
  const vaulted = createAutomationRoutes({
    users: () => Promise.resolve([]),
    signing: {
      // Stands in for the vault: a real vault row, as crm_app writes it.
      vault: {
        async store(trx, owner) {
          purposes.push(owner.purpose);
          const { id } = await trx
            .insertInto('vault.secrets')
            .values({
              agency_id: owner.agencyId,
              business_id: owner.businessId,
              purpose: owner.purpose,
              key_version: 1,
              enc: sealed(),
              ciphertext: sealed(),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          return id;
        },
        replace: () => Promise.reject(new Error('Nothing is replaced here.')),
      },
      // Stands in for tenancy's port: the same row lock, in the caller's own transaction.
      lockBusiness: async (trx, context) => {
        await sql`select id from tenancy.businesses where id = ${context.businessId ?? null} for update`.execute(
          trx,
        );
      },
    },
    webhookDelivery: true,
  });
  const caller = await inBusiness();
  expect(await call('getAutomationCatalog', caller, {}, vaulted)).toMatchObject({
    setup: { webhooks: false },
  });

  const made = rotatedAutomationWebhookSecret.parse(
    await call('rotateAutomationWebhookSecret', caller, {}, vaulted),
  );
  expect(made.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
  expect(purposes).toEqual(['automation.webhook_signing']);
  expect(await call('getAutomationWebhookSigning', caller, {}, vaulted)).toEqual({
    configured: true,
    rotatedAt: made.rotatedAt,
  });
  expect(await call('getAutomationCatalog', caller, {}, vaulted)).toMatchObject({
    setup: { webhooks: true },
  });
  // Without the permission, the vault changes nothing about who may ask.
  await expect(
    call(
      'rotateAutomationWebhookSecret',
      { context: caller.context, permissions: new Set<Permission>() },
      {},
      vaulted,
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(purposes).toHaveLength(1);
});
