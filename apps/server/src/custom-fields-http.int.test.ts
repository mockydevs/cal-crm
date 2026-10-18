// Settings → Custom Fields and Custom Values through the actual Fastify composition, with a
// real migrated Postgres. Direct route.run tests cannot detect a missing mount, and only
// here do templates and the automation validator meet the fields and custom values through
// the readers the server really hands them.
import { allowEveryone } from '@repo/commands';
import {
  customField,
  customFieldList,
  customValue,
  customValueFolder,
  customValueList,
  automationDraftSaved,
  fieldDefinition,
  fieldDeletion,
  fieldFolder,
  fieldFolderList,
  getAutomationCatalog,
  messageTemplate,
  mergeToken,
  problem,
  PROBLEM_CONTENT_TYPE,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Api = (
  method: Method,
  path: string,
  payload?: object,
) => Promise<{ status: number; body: string; json: unknown; type: string }>;

/** The API as someone signed in to a business of their own calls it. */
async function api(): Promise<Api> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const signedIn: Required<DevTenantContext> = {
    agencyId: agency.id,
    businessId: business.id,
    userId: user.id,
  };
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
    publicUrl: 'https://crm.example.test',
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
    routes: apiRoutes(),
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
  });
  servers.push(server);
  return async (method, path, payload) => {
    const response = await server.app.inject({
      method,
      url: `/api/v1${path}`,
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body,
      json: response.body === '' ? undefined : response.json<unknown>(),
      // The media type, without its charset.
      type: String(response.headers['content-type']).split(';')[0] ?? '',
    };
  };
}

const newField = {
  objectKey: 'contact',
  key: 'select_your_fence_type',
  label: 'Select your fence type',
  description: 'The fence they asked about.',
  valueType: 'text',
  options: [],
  currency: null,
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
};

describe('Settings → Custom Fields', () => {
  it('serves folders, fields in them and the paged list, each answer as its contract says', async () => {
    const call = await api();
    const made = await call('POST', '/field-folders', {
      objectKey: 'contact',
      name: 'Fence quote',
    });
    expect(made.status, made.body).toBe(201);
    const folder = fieldFolder.parse(made.json);

    const created = await call('POST', '/fields', {
      ...newField,
      folderId: folder.id,
      placeholder: 'Wood, vinyl or chain link',
    });
    expect(created.status, created.body).toBe(201);
    const field = fieldDefinition.parse(created.json);
    expect(field).toMatchObject({
      folderId: folder.id,
      placeholder: 'Wood, vinyl or chain link',
      mergeKey: 'contact.select_your_fence_type',
      source: 'user',
    });
    const other = await call('POST', '/fields', {
      ...newField,
      objectKey: 'deal',
      key: 'quote_total',
      label: 'Quote total',
    });
    expect(other.status, other.body).toBe(201);

    const first = await call('GET', '/custom-fields?limit=1');
    expect(first.status, first.body).toBe(200);
    const page = customFieldList.parse(first.json);
    expect(page).toMatchObject({ total: 2, canManage: true });
    expect(page.items.map((each) => each.mergeKey)).toEqual(['opportunity.quote_total']);
    expect(page.objects).toEqual([
      { key: 'company', label: 'Company', fields: 0, folders: 1 },
      { key: 'contact', label: 'Contact', fields: 1, folders: 2 },
      { key: 'deal', label: 'Deal', fields: 1, folders: 1 },
    ]);
    const second = await call('GET', `/custom-fields?limit=1&after=${page.next ?? ''}`);
    const rest = customFieldList.parse(second.json);
    expect(rest.next).toBeNull();
    expect(rest.items.map((each) => customField.parse(each))).toMatchObject([
      { id: field.id, folderName: 'Fence quote', mergeKey: 'contact.select_your_fence_type' },
    ]);
    const filtered = await call('GET', `/custom-fields?folderId=${folder.id}&q=FENCE`);
    expect(customFieldList.parse(filtered.json).items.map((each) => each.id)).toEqual([field.id]);

    const folders = await call('GET', '/field-folders?objectKey=contact');
    expect(
      fieldFolderList.parse(folders.json).items.map((each) => [each.name, each.fieldCount]),
    ).toEqual([
      ['Additional Info', 0],
      ['Fence quote', 1],
    ]);
    // The older read still answers, with the same field.
    const all = await call('GET', '/fields');
    expect(all.status).toBe(200);
    expect((all.json as { items: unknown[] }).items).toContainEqual(field);
  });

  it('renames, reorders, fills and deletes a folder, with a problem document for each refusal', async () => {
    const call = await api();
    const folder = fieldFolder.parse(
      (await call('POST', '/field-folders', { objectKey: 'contact', name: 'Fence quote' })).json,
    );
    const field = fieldDefinition.parse((await call('POST', '/fields', newField)).json);
    const renamed = await call('PUT', `/field-folders/${folder.id}`, {
      name: 'Fence',
      revision: folder.revision,
    });
    expect(renamed.status, renamed.body).toBe(200);
    const stale = await call('PUT', `/field-folders/${folder.id}`, {
      name: 'Late',
      revision: folder.revision,
    });
    expect([stale.status, stale.type]).toEqual([409, PROBLEM_CONTENT_TYPE]);

    const moved = await call('POST', `/field-folders/${folder.id}/fields`, {
      fieldIds: [field.id],
    });
    expect(moved.status, moved.body).toBe(200);
    expect(fieldFolder.parse(moved.json).fieldCount).toBe(1);

    const system = fieldFolderList
      .parse((await call('GET', '/field-folders?objectKey=contact')).json)
      .items.find((each) => each.system);
    const reordered = await call('PUT', '/field-folders/order', {
      objectKey: 'contact',
      folderIds: [folder.id, system?.id],
    });
    expect(reordered.status, reordered.body).toBe(200);
    expect(fieldFolderList.parse(reordered.json).items.map((each) => each.name)).toEqual([
      'Fence',
      'Additional Info',
    ]);
    // The order endpoint is its own path, not a folder named "order".
    const short = await call('PUT', '/field-folders/order', {
      objectKey: 'contact',
      folderIds: [folder.id],
    });
    expect([short.status, short.type]).toEqual([409, PROBLEM_CONTENT_TYPE]);

    const refused = await call('DELETE', `/field-folders/${system?.id ?? ''}`);
    expect(refused.status).toBe(422);
    expect(problem.parse(refused.json).errors).toMatchObject([
      { path: '/folderId', code: 'system_folder' },
    ]);
    const deleted = await call('DELETE', `/field-folders/${folder.id}`);
    expect([deleted.status, deleted.body]).toEqual([204, '']);
    const gone = await call('DELETE', `/field-folders/${folder.id}`);
    expect([gone.status, gone.type]).toEqual([404, PROBLEM_CONTENT_TYPE]);
    const after = customFieldList.parse((await call('GET', '/custom-fields')).json);
    expect(after.items).toMatchObject([{ id: field.id, folderId: system?.id }]);

    const badQuery = await call('GET', '/custom-fields?limit=0');
    expect(badQuery.status).toBe(422);
    expect(problem.parse(badQuery.json).errors).toMatchObject([{ path: '/limit' }]);
  });
});

describe('Settings → Custom Values', () => {
  it('serves values and folders: create, read, save, move and delete', async () => {
    const call = await api();
    const folderMade = await call('POST', '/custom-value-folders', { name: 'Links' });
    expect(folderMade.status, folderMade.body).toBe(201);
    const folder = customValueFolder.parse(folderMade.json);
    const made = await call('POST', '/custom-values', { name: 'Hours of operation' });
    expect(made.status, made.body).toBe(201);
    const value = customValue.parse(made.json);
    expect(value).toMatchObject({
      key: 'hours_of_operation',
      mergeKey: 'custom_values.hours_of_operation',
      value: '',
      folderId: null,
    });
    const saved = await call('PUT', `/custom-values/${value.id}`, {
      name: 'Opening hours',
      value: 'Mon to Fri, 9 to 5',
      folderId: folder.id,
      revision: value.revision,
    });
    expect(saved.status, saved.body).toBe(200);
    expect(customValue.parse(saved.json)).toMatchObject({
      key: 'hours_of_operation',
      name: 'Opening hours',
      folderName: 'Links',
    });
    const stale = await call('PUT', `/custom-values/${value.id}`, {
      name: 'Late',
      value: '',
      folderId: null,
      revision: value.revision,
    });
    expect([stale.status, stale.type]).toEqual([409, PROBLEM_CONTENT_TYPE]);

    const listed = await call('GET', `/custom-values?folder=${folder.id}&q=fri`);
    expect(listed.status, listed.body).toBe(200);
    expect(customValueList.parse(listed.json)).toMatchObject({
      total: 1,
      next: null,
      canManage: true,
      items: [{ id: value.id, value: 'Mon to Fri, 9 to 5' }],
    });
    const moved = await call('POST', '/custom-values/move', {
      valueIds: [value.id],
      folderId: null,
    });
    expect(moved.status, moved.body).toBe(200);
    expect((await call('DELETE', `/custom-value-folders/${folder.id}`)).status).toBe(204);
    expect((await call('GET', '/custom-value-folders')).json).toEqual({
      items: [],
      canManage: true,
      next: null,
      total: 0,
    });
    expect((await call('DELETE', `/custom-values/${value.id}`)).status).toBe(204);
    const gone = await call('DELETE', `/custom-values/${value.id}`);
    expect([gone.status, gone.type]).toEqual([404, PROBLEM_CONTENT_TYPE]);
    const badCursor = await call('GET', '/custom-values?after=nonsense');
    expect(badCursor.status).toBe(422);
    expect(problem.parse(badCursor.json).errors).toMatchObject([
      { path: '/after', code: 'invalid_cursor' },
    ]);
  });
});

describe('templates and automations, as this server composes them', () => {
  it('tell a template exactly which of its merge keys no send can fill in, as fields and values change', async () => {
    const call = await api();
    const field = fieldDefinition.parse((await call('POST', '/fields', newField)).json);
    for (const [objectKey, key] of [
      ['deal', 'quote_total'],
      ['company', 'city'],
    ])
      expect(
        (await call('POST', '/fields', { ...newField, objectKey, key, label: key })).status,
      ).toBe(201);
    const reel = customValue.parse(
      (
        await call('POST', '/custom-values', {
          name: 'Sample reel URL',
          value: 'https://x.example',
        })
      ).json,
    );
    const keys = [
      field.mergeKey ?? '',
      'contact.custom.select_your_fence_type',
      reel.mergeKey,
      'values.sample_reel_url',
      'opportunity.quote_total',
      'business.city',
    ];
    const created = await call('POST', '/message-templates', {
      name: 'Fence quote',
      subject: 'Your quote, {{contact.firstName}}',
      body: keys.map(mergeToken).join(' '),
    });
    expect(created.status, created.body).toBe(201);
    const template = messageTemplate.parse(created.json);
    expect(template.mergeFields).toEqual(['contact.firstName', ...keys]);
    // A deal's and a company's fields have merge keys, and nothing fills them in yet.
    expect(template.unfillableFields).toEqual(['opportunity.quote_total', 'business.city']);

    // Renamed, both still fill in: the keys did not move.
    await call('PUT', `/fields/${field.id}`, {
      label: 'Fence type',
      description: field.description,
      options: [],
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
      revision: field.revision,
    });
    const renamed = customValue.parse(
      (
        await call('PUT', `/custom-values/${reel.id}`, {
          name: 'Show reel',
          value: reel.value,
          folderId: null,
          revision: reel.revision,
        })
      ).json,
    );
    expect(renamed).toMatchObject({ name: 'Show reel', mergeKey: reel.mergeKey });
    const read = async () =>
      messageTemplate.parse((await call('GET', `/message-templates/${template.id}`)).json)
        .unfillableFields;
    expect(await read()).toEqual(['opportunity.quote_total', 'business.city']);

    // Emptied, the value has nothing to send; deleted, it isn't there at all.
    const emptied = await call('PUT', `/custom-values/${reel.id}`, {
      name: renamed.name,
      value: '',
      folderId: null,
      revision: renamed.revision,
    });
    expect(emptied.status, emptied.body).toBe(200);
    expect(await read()).toEqual([
      'custom_values.sample_reel_url',
      'values.sample_reel_url',
      'opportunity.quote_total',
      'business.city',
    ]);
    expect((await call('DELETE', `/custom-values/${reel.id}`)).status).toBe(204);
    expect(await read()).toEqual([
      'custom_values.sample_reel_url',
      'values.sample_reel_url',
      'opportunity.quote_total',
      'business.city',
    ]);
  });

  it('let the AUTOMATIONS.md step be saved once its custom value exists, and name the key until then', async () => {
    const call = await api();
    const document = {
      name: 'New lead follow-up',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'send_reel',
      steps: {
        send_reel: {
          type: 'sms.send',
          config: { message: 'Here’s our video sample reel: {{values.sample_reel_url}}' },
        },
      },
    };
    const mergeErrors = async (): Promise<string[]> => {
      const response = await call('POST', '/automations/validate', { document });
      expect(response.status, response.body).toBe(200);
      return (response.json as { errors: { code: string; message: string }[] }).errors
        .filter((issue) => issue.code === 'unknown_merge_field')
        .map((issue) => issue.message);
    };
    const customValues = async (): Promise<readonly string[]> =>
      getAutomationCatalog.response.schema.parse((await call('GET', '/automations/catalog')).json)
        .setup.values;
    expect(await customValues()).toEqual([]);
    expect(await mergeErrors()).toEqual(['values.sample_reel_url is not a custom value.']);
    await call('POST', '/custom-values', {
      name: 'Sample reel URL',
      value: 'https://harborlights.example/reel',
    });
    expect(await customValues()).toEqual(['sample_reel_url']);
    expect(await mergeErrors()).toEqual([]);
  });
  it('name what deleting a field would lose, and tell the truth about it everywhere once it is gone', async () => {
    const call = await api();
    const field = fieldDefinition.parse((await call('POST', '/fields', newField)).json);
    const kept = fieldDefinition.parse(
      (await call('POST', '/fields', { ...newField, key: 'gate_width', label: 'Gate width' })).json,
    );
    const template = messageTemplate.parse(
      (
        await call('POST', '/message-templates', {
          name: 'Fence quote',
          subject: 'Your {{ contact.select_your_fence_type }} fence',
          body: 'Gate: {{contact.gate_width}}',
        })
      ).json,
    );
    // Uses the other field only: it is not named.
    await call('POST', '/message-templates', {
      name: 'Gate only',
      subject: 'Your gate',
      body: '{{contact.gate_width}}',
    });
    const document = {
      name: 'Fence follow-up',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'say',
      steps: {
        say: {
          type: 'sms.send',
          config: { message: 'About your {{contact.select_your_fence_type}} fence' },
        },
      },
    };
    const mergeErrors = async (): Promise<string[]> => {
      const response = await call('POST', '/automations/validate', { document });
      expect(response.status, response.body).toBe(200);
      return (response.json as { errors: { code: string; message: string }[] }).errors
        .filter((issue) => issue.code === 'unknown_merge_field')
        .map((issue) => issue.message);
    };
    expect(await mergeErrors()).toEqual([]);
    const drafted = await call('POST', '/automations', { document });
    expect(drafted.status, drafted.body).toBe(201);
    const { automation } = automationDraftSaved.parse(drafted.json);

    const read = await call('GET', `/fields/${field.id}/deletion`);
    expect(read.status, read.body).toBe(200);
    const deletion = fieldDeletion.parse(read.json);
    expect(deletion).toMatchObject({
      field: { id: field.id, key: field.key, mergeKey: 'contact.select_your_fence_type' },
      values: 0,
      templates: [{ id: template.id, name: 'Fence quote' }],
      automations: [{ id: automation.id, name: 'Fence follow-up' }],
      canDelete: true,
    });
    const unfillable = async (): Promise<readonly string[] | null> =>
      messageTemplate.parse((await call('GET', `/message-templates/${template.id}`)).json)
        .unfillableFields;
    expect(await unfillable()).toEqual([]);

    // A confirmation nobody was given deletes nothing.
    const guessed = await call('POST', `/fields/${field.id}/delete`, {
      confirmation: 'a'.repeat(64),
    });
    expect(guessed.status, guessed.body).toBe(409);
    expect(guessed.type).toBe(PROBLEM_CONTENT_TYPE);
    expect(await unfillable()).toEqual([]);

    const deleted = await call('POST', `/fields/${field.id}/delete`, {
      confirmation: deletion.confirmation,
    });
    expect(deleted.status, deleted.body).toBe(204);

    // The template names the key as one no send can fill in; the other field still fills in.
    expect(await unfillable()).toEqual(['contact.select_your_fence_type']);
    // The validator no longer knows it, and says so for the step that uses it.
    expect(await mergeErrors()).toEqual([
      expect.stringContaining('contact.select_your_fence_type'),
    ]);
    // It is in no list, and its deletion can't be read again.
    const listed = customFieldList.parse(
      (await call('GET', '/custom-fields?archived=include')).json,
    );
    expect(listed.items.map((each) => each.id)).toEqual([kept.id]);
    const gone = await call('GET', `/fields/${field.id}/deletion`);
    expect(gone.status).toBe(404);
    expect(problem.parse(gone.json).status).toBe(404);
  });
});
