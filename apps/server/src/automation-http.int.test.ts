// The builder's list/detail/catalog requests through the actual Fastify composition,
// with real migrated Postgres. Direct route.run tests cannot detect a missing mount.
import { allowEveryone } from '@repo/commands';
import {
  automation as automationContract,
  automationDocument,
  automationDraftSaved,
  automationFolder,
  automationFolderList,
  automationList,
  automationRunList,
  automationStats,
  automationStepRunList,
  automationView,
  getAutomationCatalog,
  messageTemplate,
  messageTemplateList,
  PROBLEM_CONTENT_TYPE,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  createSealingVault,
  newSecretsKey,
  parseSecretsPublicKey,
  type SealingVault,
} from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import type { Config, DevTenantContext } from './config.js';
import { buildServer, type Server } from './server.js';

let database: TestDatabase;
let db: Database;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function context(): Promise<Required<DevTenantContext>> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return { agencyId: agency.id, businessId: business.id, userId: user.id };
}

/** How the install is set up, where a test cares: its vault and its public address. */
interface Install {
  readonly vault?: SealingVault;
  readonly publicUrl?: string;
}

async function apiFor(
  signedIn: DevTenantContext | undefined,
  install: Install = {},
): Promise<Server> {
  const config: Config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 2,
    shutdownTimeoutMs: 1000,
    dashboardDir: undefined,
    devTenantContext: signedIn,
    publicUrl: install.publicUrl ?? 'https://crm.example.test',
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault: undefined,
  };
  const server = await buildServer({
    config,
    logger: pino({ level: 'silent' }),
    serveApi: true,
    // As start() hands them over: the vault that seals, and the address people reach.
    routes:
      install.vault === undefined && install.publicUrl === undefined
        ? apiRoutes()
        : apiRoutes(undefined, install.vault, false, config.publicUrl),
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
  });
  servers.push(server);
  return server;
}

const document = {
  name: 'HTTP composition regression',
  triggers: [{ id: 'created', type: 'contact.created', config: {} }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
};

it('serves the empty list with permissions instead of a missing-route 404', async () => {
  const { app } = await apiFor(await context());
  const response = await app.inject('/api/v1/automations');
  expect(response.statusCode).toBe(200);
  expect(automationList.parse(response.json())).toEqual({
    canManage: true,
    items: [],
    nextCursor: null,
  });
});

it('creates, lists and reloads a draft through the real HTTP routes', async () => {
  const { app } = await apiFor(await context());
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/automations',
    payload: { document },
  });
  expect(response.statusCode).toBe(201);
  const saved = automationDraftSaved.parse(response.json());
  expect(saved.validation.valid).toBe(true);
  const list = await app.inject('/api/v1/automations');
  expect(list.statusCode).toBe(200);
  expect(automationList.parse(list.json()).items).toEqual([
    expect.objectContaining({ id: saved.automation.id, name: document.name }),
  ]);
  const detail = await app.inject(`/api/v1/automations/${saved.automation.id}`);
  expect(detail.statusCode).toBe(200);
  expect(automationView.parse(detail.json())).toMatchObject({
    id: saved.automation.id,
    draft: document,
    canManage: true,
    canPublish: true,
  });
});

it('serves the business catalog through composition and migrated references', async () => {
  const { app } = await apiFor(await context());
  const response = await app.inject('/api/v1/automations/catalog');
  expect(response.statusCode).toBe(200);
  const catalog = getAutomationCatalog.response.schema.parse(response.json());
  expect(catalog.triggers.length).toBeGreaterThan(0);
  expect(catalog.steps.length).toBeGreaterThan(0);
  expect(catalog.setup).toMatchObject({
    emailTemplates: [],
    users: [],
    webhooks: false,
  });
});

it('does not list or open another business automation', async () => {
  const owner = await apiFor(await context());
  const created = await owner.app.inject({
    method: 'POST',
    url: '/api/v1/automations',
    payload: { document },
  });
  expect(created.statusCode).toBe(201);
  const saved = automationDraftSaved.parse(created.json());
  const other = await apiFor(await context());
  const list = await other.app.inject('/api/v1/automations');
  expect(list.statusCode).toBe(200);
  expect(automationList.parse(list.json()).items).toEqual([]);
  const detail = await other.app.inject(`/api/v1/automations/${saved.automation.id}`);
  expect(detail.statusCode).toBe(404);
  expect(detail.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
});

it('rejects an invalid list cursor with a problem response', async () => {
  const { app } = await apiFor(await context());
  const response = await app.inject('/api/v1/automations?after=invalid');
  expect(response.statusCode).toBe(422);
  expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
});

it('requires sign-in for the mounted list and catalog', async () => {
  const { app } = await apiFor(undefined);
  for (const path of ['/api/v1/automations', '/api/v1/automations/catalog']) {
    const response = await app.inject(path);
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  }
});

it('offers a template to automations the moment it is written, and withdraws it when archived', async () => {
  const { app } = await apiFor(await context());
  const emailTemplates = async (): Promise<unknown> => {
    const response = await app.inject('/api/v1/automations/catalog');
    expect(response.statusCode).toBe(200);
    return getAutomationCatalog.response.schema.parse(response.json()).setup.emailTemplates;
  };
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/message-templates',
    payload: {
      name: 'Pricing guide',
      subject: 'Your guide, {{contact.firstName}}',
      body: 'Hi {{contact.firstName}}, see {{values.sample_reel_url}}',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const saved = messageTemplate.parse(created.json());
  // The server gave the routes automation's readers: nothing sends it yet, and the
  // account value is named as a field no template send fills in.
  expect(saved.usedBy).toEqual([]);
  expect(saved.unfillableFields).toEqual(['values.sample_reel_url']);
  expect(await emailTemplates()).toEqual([{ id: saved.id, name: 'Pricing guide' }]);

  const renamed = await app.inject({
    method: 'PUT',
    url: `/api/v1/message-templates/${saved.id}`,
    payload: {
      name: 'Price list',
      subject: saved.subject,
      body: 'Hi {{contact.firstName}}',
      revision: saved.revision,
    },
  });
  expect(renamed.statusCode, renamed.body).toBe(200);
  const edited = messageTemplate.parse(renamed.json());
  expect(edited.unfillableFields).toEqual([]);
  // The same id under its new name, which is what a published automation holds.
  expect(await emailTemplates()).toEqual([{ id: saved.id, name: 'Price list' }]);
  // The revision read before that edit no longer saves.
  const stale = await app.inject({
    method: 'POST',
    url: `/api/v1/message-templates/${saved.id}/archive`,
    payload: { revision: saved.revision },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);

  const archived = await app.inject({
    method: 'POST',
    url: `/api/v1/message-templates/${saved.id}/archive`,
    payload: { revision: edited.revision },
  });
  expect(archived.statusCode, archived.body).toBe(200);
  expect(await emailTemplates()).toEqual([]);
  const preview = await app.inject({
    method: 'POST',
    url: '/api/v1/message-templates/preview',
    payload: { subject: 'Hi {{contact.firstName}}', body: 'Hello', values: {} },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json()).toEqual({
    ok: false,
    code: 'missing_values',
    fields: ['contact.firstName'],
  });
});

it('requires sign-in for the mounted template routes, and hides one business from another', async () => {
  const signedOut = await apiFor(undefined);
  expect((await signedOut.app.inject('/api/v1/message-templates')).statusCode).toBe(401);
  const owner = await apiFor(await context());
  const created = await owner.app.inject({
    method: 'POST',
    url: '/api/v1/message-templates',
    payload: { name: 'Private', subject: 'Private subject', body: 'Private body' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const saved = messageTemplate.parse(created.json());
  const other = await apiFor(await context());
  const list = await other.app.inject('/api/v1/message-templates?archived=include');
  expect(list.statusCode).toBe(200);
  expect(messageTemplateList.parse(list.json()).items).toEqual([]);
  const read = await other.app.inject(`/api/v1/message-templates/${saved.id}`);
  expect(read.statusCode).toBe(404);
  expect(read.body).not.toContain('Private');
  const edit = await other.app.inject({
    method: 'PUT',
    url: `/api/v1/message-templates/${saved.id}`,
    payload: { name: 'Taken', subject: 'Taken', body: 'Taken', revision: saved.revision },
  });
  expect(edit.statusCode).toBe(404);
});

it('refuses a save that started from a stale draft with 409, and leaves the newer draft', async () => {
  const { app } = await apiFor(await context());
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/automations',
    payload: { document },
  });
  const { automation } = automationDraftSaved.parse(created.json());
  const save = (name: string, method: 'PUT' | 'PATCH') =>
    app.inject({
      method,
      url: `/api/v1/automations/${automation.id}/draft`,
      payload:
        method === 'PUT'
          ? { baseDraftVersion: 1, document: { ...document, name } }
          : { baseDraftVersion: 1, patch: [{ op: 'replace', path: '/name', value: name }] },
    });
  expect((await save('First writer', 'PUT')).statusCode).toBe(200);
  // Both ways of saving send the version they started from, and both are refused alike.
  for (const method of ['PUT', 'PATCH'] as const) {
    const stale = await save('Second writer', method);
    expect(stale.statusCode, method).toBe(409);
    expect(stale.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    // The answer says which version the draft is at now, so the client can read it again.
    expect(stale.json<{ status: number; detail: string }>()).toMatchObject({
      status: 409,
      detail: expect.stringContaining('The draft is at version 2, not 1') as string,
    });
  }
  const read = await app.inject(`/api/v1/automations/${automation.id}`);
  expect(automationView.parse(read.json())).toMatchObject({
    draftVersion: 2,
    draft: { name: 'First writer' },
  });
});

it('serves the workflow list and tabs over HTTP: folders, delete and restore, statistics, history and logs', async () => {
  const { app } = await apiFor(await context());
  const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });
  const created = await send('POST', '/automations', { document });
  const { automation } = automationDraftSaved.parse(created.json());
  const at = `/automations/${automation.id}`;
  expect((await send('POST', `${at}/publish`, { baseDraftVersion: 1 })).statusCode).toBe(200);

  // Folders: made, renamed from the revision seen, refused from a stale one as a problem.
  const made = await send('POST', '/automation-folders', { name: '  Leads ' });
  expect(made.statusCode, made.body).toBe(201);
  const folder = automationFolder.parse(made.json());
  expect(folder).toMatchObject({ name: 'Leads', parentId: null, revision: 1 });
  const rename = (name: string) =>
    send('PATCH', `/automation-folders/${folder.id}`, { revision: 1, name });
  expect((await rename('New leads')).statusCode).toBe(200);
  const stale = await rename('Lost?');
  expect(stale.statusCode).toBe(409);
  expect(stale.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  expect(stale.json<{ detail: string }>().detail).toContain('revision 2, not 1');
  const filed = await send('PUT', `${at}/folder`, { folderId: folder.id });
  expect(automationContract.parse(filed.json())).toMatchObject({ folderId: folder.id });
  const tree = await app.inject('/api/v1/automation-folders');
  expect(automationFolderList.parse(tree.json())).toMatchObject({
    canManage: true,
    items: [{ id: folder.id, name: 'New leads', automationCount: 1 }],
  });

  // The list, narrowed as its address says: the query arrives as text, as it does here.
  const listed = async (query: string) => {
    const response = await app.inject(`/api/v1/automations${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return automationList.parse(response.json()).items.map((item) => item.id);
  };
  expect(await listed(`?folder=${folder.id}&q=composition`)).toEqual([automation.id]);
  expect(await listed('?folder=root')).toEqual([]);
  expect(await listed('?q=nothing-like-it')).toEqual([]);
  expect((await app.inject('/api/v1/automations?folder=somewhere')).statusCode).toBe(422);

  // The tabs: statistics, the enrollment history and the execution logs, with their filters.
  const stats = await app.inject(`/api/v1${at}/stats`);
  expect(automationStats.parse(stats.json())).toMatchObject({
    automationId: automation.id,
    liveVersion: 1,
    runs: { allTime: { enrolled: 0, active: 0 }, live: { enrolled: 0 } },
    steps: [{ step: 'pause', type: 'wait', inLiveVersion: true }],
  });
  const history = await app.inject(
    `/api/v1${at}/runs?status=waiting&from=2020-01-01T00:00:00Z&to=2099-01-01T00:00:00Z&trigger=created`,
  );
  expect(history.statusCode, history.body).toBe(200);
  expect(automationRunList.parse(history.json())).toEqual({ items: [], nextCursor: null });
  expect((await app.inject(`/api/v1${at}/runs?from=yesterday`)).statusCode).toBe(422);
  const logs = await app.inject(`/api/v1${at}/step-runs?status=failed&step=pause&type=wait`);
  expect(logs.statusCode, logs.body).toBe(200);
  expect(automationStepRunList.parse(logs.json())).toEqual({ items: [], nextCursor: null });
  expect((await app.inject(`/api/v1${at}/step-runs?status=done`)).statusCode).toBe(422);

  // Deleted: off the list, on the Deleted list. Restored: back, paused.
  const deleted = await send('DELETE', at);
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(deleted.json()).toMatchObject({ status: 'archived', folderId: null });
  expect(await listed('')).toEqual([]);
  expect(await listed('?status=archived')).toEqual([automation.id]);
  const restored = await send('POST', `${at}/restore`);
  expect(restored.statusCode, restored.body).toBe(200);
  expect(restored.json()).toMatchObject({ status: 'paused', deletedAt: null, folderId: null });

  // A folder deleted answers with nothing, and is then not there.
  const removed = await send('DELETE', `/automation-folders/${folder.id}`);
  expect(removed.statusCode).toBe(204);
  expect(removed.body).toBe('');
  const again = await send('DELETE', `/automation-folders/${folder.id}`);
  expect(again.statusCode).toBe(404);
  expect(again.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
});

it('keeps the workflow list and tabs to the signed-in and to their own business', async () => {
  const ours = await context();
  const { app } = await apiFor(ours);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/automations',
    payload: { document },
  });
  const { automation } = automationDraftSaved.parse(created.json());
  const made = await app.inject({
    method: 'POST',
    url: '/api/v1/automation-folders',
    payload: { name: 'Ours' },
  });
  const folder = automationFolder.parse(made.json());
  const unsigned = await apiFor(undefined);
  const theirs = await apiFor(await context());
  const reads = [
    '/automation-folders',
    `/automations/${automation.id}/stats`,
    `/automations/${automation.id}/step-runs`,
  ];
  for (const url of reads)
    expect((await unsigned.app.inject(`/api/v1${url}`)).statusCode, url).toBe(401);
  // Another business has no folders of ours, and finds neither our automation nor our folder.
  const elsewhere = await theirs.app.inject('/api/v1/automation-folders');
  expect(automationFolderList.parse(elsewhere.json()).items).toEqual([]);
  for (const [method, url, payload] of [
    ['GET', `/automations/${automation.id}/stats`, undefined],
    ['GET', `/automations/${automation.id}/step-runs`, undefined],
    ['DELETE', `/automations/${automation.id}`, undefined],
    ['POST', `/automations/${automation.id}/restore`, undefined],
    ['PUT', `/automations/${automation.id}/folder`, { folderId: null }],
    ['PATCH', `/automation-folders/${folder.id}`, { revision: 1, name: 'Theirs' }],
    ['DELETE', `/automation-folders/${folder.id}`, undefined],
  ] as const) {
    const response = await theirs.app.inject({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode, `${method} ${url}`).toBe(404);
    expect(response.body).not.toContain('Ours');
  }
  const still = await app.inject('/api/v1/automation-folders');
  expect(automationFolderList.parse(still.json()).items).toMatchObject([
    { id: folder.id, name: 'Ours', revision: 1 },
  ]);
});

it('offers text message steps only where the install can deliver a text and the business has a number', async () => {
  const signedIn = await context();
  const vault = await createSealingVault(parseSecretsPublicKey((await newSecretsKey(1)).publicKey));
  const catalogOf = async (install: Install) => {
    const { app } = await apiFor(signedIn, install);
    const response = await app.inject('/api/v1/automations/catalog');
    expect(response.statusCode).toBe(200);
    const { setup } = getAutomationCatalog.response.schema.parse(response.json());
    return { sms: setup.channels.sms, numbers: setup.phoneNumbers.map((number) => number.name) };
  };
  const delivering = { vault, publicUrl: 'https://crm.example.test' };
  // Nothing to send from yet.
  expect(await catalogOf(delivering)).toEqual({ sms: false, numbers: [] });

  await database.as('postgres', async (sql) => {
    const one = async (text: string, values: readonly unknown[]) => {
      const [row] = await sql.query<{ id: string }>(text, values);
      if (row === undefined) throw new Error('The insert returns its id.');
      return row.id;
    };
    const secret = await one(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'sms.credentials', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [signedIn.agencyId, signedIn.businessId],
    );
    const connection = await one(
      `insert into messaging.provider_connections (agency_id, business_id, provider, label, account_ref, secret_id)
       values ($1, $2, 'twilio', 'Twilio', 'AC00000000000000000000000000000001', $3) returning id`,
      [signedIn.agencyId, signedIn.businessId, secret],
    );
    const id = await one(
      `insert into messaging.channel_accounts (business_id, channel, name)
       values ($1, 'sms', 'Front desk') returning id`,
      [signedIn.businessId],
    );
    await sql.query(
      `insert into messaging.phone_numbers (business_id, id, e164, provider_connection_id, provider_number_ref)
       values ($1, $2, '+15558675310', $3, 'PN0123456789abcdef0123456789abcdef')`,
      [signedIn.businessId, id, connection],
    );
  });
  expect(await catalogOf(delivering)).toEqual({ sms: true, numbers: ['Front desk'] });
  // Twilio reports delivery to a public https address; without one no text can be sent.
  expect(await catalogOf({ vault, publicUrl: 'http://127.0.0.1:3000' })).toEqual({
    sms: false,
    numbers: [],
  });
  // And without a vault there is nowhere to keep the provider's credentials.
  expect(await catalogOf({ publicUrl: 'https://crm.example.test' })).toEqual({
    sms: false,
    numbers: [],
  });

  // With the channel there, a text message step that names the number is saved clean, and
  // the same document is refused where no text can be delivered.
  const textDocument = {
    name: 'Check in by text',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'text',
    steps: {
      text: {
        type: 'sms.send',
        config: { message: 'Hi {{contact.firstName}}', number: 'Front desk' },
        next: 'pause',
      },
      pause: { type: 'wait', config: { duration: 'P1D' } },
    },
  };
  const check = async (install: Install) => {
    const { app } = await apiFor(signedIn, install);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/automations/validate',
      payload: { document: textDocument },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response
      .json<{ errors: { path: string; code: string }[] }>()
      .errors.map((issue) => [issue.path, issue.code]);
  };
  expect(await check(delivering)).toEqual([]);
  expect(await check({ vault, publicUrl: 'http://127.0.0.1:3000' })).toEqual([
    ['/steps/text/config/number', 'unknown_reference'],
    ['/steps/text', 'no_provider'],
  ]);
});

it('refuses to check clean a document whose step or trigger nothing on this install runs', async () => {
  const { app } = await apiFor(await context());
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/automations/validate',
    payload: {
      document: {
        name: 'Daily hand-over',
        triggers: [{ id: 'daily', type: 'schedule', config: { every: 'day', at: '09:00' } }],
        start: 'tell',
        // Starting another automation runs now; the AI steps are what nothing runs yet.
        steps: { tell: { type: 'ai.ask', config: { prompt: 'What did they ask for?' } } },
      },
    },
  });
  expect(response.statusCode).toBe(200);
  const validation = response.json<{ valid: boolean; errors: { path: string; code: string }[] }>();
  expect(validation.valid).toBe(false);
  expect(validation.errors.map((issue) => [issue.path, issue.code])).toEqual([
    ['/triggers/0', 'trigger_unavailable'],
    ['/steps/tell', 'step_unavailable'],
    // And no AI key is set, which the same step is told of.
    ['/steps/tell', 'no_ai_key'],
  ]);
});

it.each([
  { type: 'note.create', config: { text: 'Welcome {{contact.firstName}}' } },
  { type: 'owner.remove', config: {} },
])('creates and publishes native $type through the real HTTP composition', async (native) => {
  const { app } = await apiFor(await context());
  const catalogResponse = await app.inject('/api/v1/automations/catalog');
  expect(catalogResponse.statusCode).toBe(200);
  const catalog = getAutomationCatalog.response.schema.parse(catalogResponse.json());
  expect(catalog.steps).toContainEqual(expect.objectContaining({ type: native.type }));
  expect(catalog.setup.unavailableSteps).not.toContain(native.type);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/automations',
    payload: {
      document: {
        name: 'Native action',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'act',
        steps: { act: native },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const saved = automationDraftSaved.parse(response.json());
  expect(saved.validation).toMatchObject({ valid: true, errors: [] });
  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/automations/${saved.automation.id}/publish`,
    payload: { baseDraftVersion: saved.automation.draftVersion },
  });
  expect(published.statusCode, published.body).toBe(200);
  expect(automationContract.parse(published.json()).status).toBe('active');
  const reloaded = await app.inject(`/api/v1/automations/${saved.automation.id}`);
  expect(reloaded.statusCode).toBe(200);
  const document = automationDocument.parse(automationView.parse(reloaded.json()).draft);
  expect(document.steps['act']).toMatchObject(native);
});

it('offers the composed team notification action and validates its native document over HTTP', async () => {
  const { app } = await apiFor(await context());
  const catalogResponse = await app.inject('/api/v1/automations/catalog');
  expect(catalogResponse.statusCode).toBe(200);
  const catalog = getAutomationCatalog.response.schema.parse(catalogResponse.json());
  expect(catalog.setup.unavailableSteps).not.toContain('team.notify');
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/automations',
    payload: {
      document: {
        name: 'Tell the team',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'tell',
        steps: { tell: { type: 'team.notify', config: { to: 'everyone', message: 'New lead.' } } },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const saved = automationDraftSaved.parse(response.json());
  expect(saved.validation.valid).toBe(true);
  expect(saved.validation.errors).toEqual([]);
  expect(automationDocument.parse(saved.automation.draft).steps['tell']).toMatchObject({
    type: 'team.notify',
    config: { to: 'everyone', message: 'New lead.' },
  });
  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/automations/${saved.automation.id}/publish`,
    payload: { baseDraftVersion: saved.automation.draftVersion },
  });
  expect(published.statusCode, published.body).toBe(200);
  expect(automationContract.parse(published.json())).toMatchObject({ status: 'active' });
  const reloaded = await app.inject(`/api/v1/automations/${saved.automation.id}`);
  expect(reloaded.statusCode).toBe(200);
  expect(automationView.parse(reloaded.json())).toMatchObject({ status: 'active' });
});
