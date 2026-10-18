// The template routes as the server runs them: every operation, each answer
// checked against the schema the API documents, and each permission enforced. Real Postgres.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  messageTemplate,
  messageTemplateEndpoints,
  messageTemplateFolderEndpoints,
  messageTemplateFolder,
  messageTemplateFolderDetail,
  messageTemplateList,
  messageTemplatePreview,
  permissions,
  type MessageTemplateUse,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, beforeEach, expect, inject, it } from 'vitest';
import { createTemplateRoutes } from './template-routes.js';

const uses: MessageTemplateUse[] = [
  {
    id: toPublicId('automation', '01900000-0000-7000-8000-00000000000a'),
    name: 'Welcome',
    status: 'active',
  },
];
// What the routes are told sends a template; a test that archives one clears it first, as a
// template a workflow sends can't be archived.
let sending: readonly MessageTemplateUse[] = uses;

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
  routes = createTemplateRoutes({
    uses: () => Promise.resolve([...sending]),
    fields: () => Promise.resolve(['contact.firstName']),
  });
});
beforeEach(() => {
  sending = uses;
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function inBusiness(granted: Invocation['permissions'] = 'all'): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return {
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: granted,
  };
}

/** Calls a route as the server does, and checks the answer against its documented schema. */
async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
  from: readonly ApiRoute[] = routes,
): Promise<unknown> {
  const route = from.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`No route for ${operationId}.`);
  const answer = await route.run(
    {
      invocation,
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    services,
  );
  const schema = route.endpoint.response.schema;
  if (schema === undefined) {
    expect(route.endpoint.response.status).toBe(204);
    expect(answer).toBeUndefined();
    return undefined;
  }
  return schema.parse(answer);
}

const guide = {
  name: 'Pricing guide',
  subject: 'Your guide, {{contact.firstName}}',
  body: 'Hi {{contact.firstName}},\nWe cover {{contact.custom.services}}.',
};

it('creates directly in a tenant folder and refuses unavailable destinations without saving content', async () => {
  const caller = await inBusiness();
  const foreign = await inBusiness();
  const folder = messageTemplateFolder.parse(
    await call('createMessageTemplateFolder', caller, { body: { name: 'Guides' } }),
  );
  const template = messageTemplate.parse(
    await call('createMessageTemplate', caller, { body: { ...guide, folderId: folder.id } }),
  );
  expect(
    messageTemplateList
      .parse(await call('listMessageTemplates', caller, { query: { folder: folder.id } }))
      .items.map((item) => item.id),
  ).toEqual([template.id]);
  expect(
    messageTemplateList.parse(
      await call('listMessageTemplates', caller, { query: { folder: 'root' } }),
    ).items,
  ).toEqual([]);
  await expect(
    call('createMessageTemplate', foreign, { body: { ...guide, folderId: folder.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(messageTemplateList.parse(await call('listMessageTemplates', foreign)).items).toEqual([]);
  await call('removeMessageTemplateFolder', caller, {
    params: { id: folder.id },
    body: { revision: folder.revision },
  });
  await expect(
    call('createMessageTemplate', caller, {
      body: { ...guide, name: 'Missing destination', folderId: folder.id },
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(
    messageTemplateList
      .parse(await call('listMessageTemplates', caller))
      .items.map((item) => item.name),
  ).toEqual(['Pricing guide']);
});

it('keeps scoped search pages ordered and complete without including root or sibling assets', async () => {
  const caller = await inBusiness();
  const folder = messageTemplateFolder.parse(
    await call('createMessageTemplateFolder', caller, { body: { name: 'Guides' } }),
  );
  const sibling = messageTemplateFolder.parse(
    await call('createMessageTemplateFolder', caller, { body: { name: 'Other guides' } }),
  );
  const names = Array.from({ length: 53 }, (_, index) => `Guide ${String(index).padStart(3, '0')}`);
  for (const name of [...names].reverse()) {
    const template = messageTemplate.parse(
      await call('createMessageTemplate', caller, {
        body: { name, subject: 'Guide', body: 'Hello.' },
      }),
    );
    await call('moveMessageTemplate', caller, {
      params: { id: template.id },
      body: { revision: template.revision, folderId: folder.id },
    });
  }
  await call('createMessageTemplate', caller, {
    body: { name: 'Guide root', subject: 'Root', body: 'Root only.' },
  });
  const elsewhere = messageTemplate.parse(
    await call('createMessageTemplate', caller, {
      body: { name: 'Guide sibling', subject: 'Sibling', body: 'Sibling only.' },
    }),
  );
  await call('moveMessageTemplate', caller, {
    params: { id: elsewhere.id },
    body: { revision: elsewhere.revision, folderId: sibling.id },
  });
  const first = messageTemplateList.parse(
    await call('listMessageTemplates', caller, { query: { folder: folder.id, q: 'GUIDE' } }),
  );
  expect(first.items.map((item) => item.name)).toEqual(names.slice(0, 50));
  expect(first.nextCursor).toBe(first.items[49]?.id);
  const second = messageTemplateList.parse(
    await call('listMessageTemplates', caller, {
      query: { folder: folder.id, q: 'GUIDE', after: first.nextCursor },
    }),
  );
  expect(second.items.map((item) => item.name)).toEqual(['Guide 050', 'Guide 051', 'Guide 052']);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(53);
  expect(
    messageTemplateList
      .parse(await call('listMessageTemplates', caller, { query: { folder: 'root', q: 'guide' } }))
      .items.map((item) => item.name),
  ).toEqual(['Guide root']);
});

it('serves nested folders and revision-checked placement without losing a workflow template', async () => {
  const caller = await inBusiness();
  const foreign = await inBusiness();
  const parent = messageTemplateFolder.parse(
    await call('createMessageTemplateFolder', caller, {
      body: { name: 'Welcome library' },
    }),
  );
  const child = messageTemplateFolder.parse(
    await call('createMessageTemplateFolder', caller, {
      body: { name: 'Guides', parentId: parent.id },
    }),
  );
  const created = messageTemplate.parse(
    await call('createMessageTemplate', caller, { body: guide }),
  );
  const moved = messageTemplate.parse(
    await call('moveMessageTemplate', caller, {
      params: { id: created.id },
      body: { revision: created.revision, folderId: child.id },
    }),
  );
  expect(moved).toMatchObject({ ...guide, id: created.id, usedBy: uses });
  await expect(
    call('moveMessageTemplate', caller, {
      params: { id: created.id },
      body: { revision: created.revision, folderId: null },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    call('getMessageTemplateFolder', foreign, { params: { id: child.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  const detail = messageTemplateFolderDetail.parse(
    await call('getMessageTemplateFolder', caller, {
      params: { id: child.id },
    }),
  );
  expect(detail.breadcrumbs.map((folder) => folder.name)).toEqual(['Welcome library', 'Guides']);
  expect(detail.folder.templateCount).toBe(1);
  expect(
    messageTemplateList.parse(
      await call('listMessageTemplates', caller, {
        query: { folder: 'root' },
      }),
    ).items,
  ).toEqual([]);
  expect(
    messageTemplateList
      .parse(
        await call('listMessageTemplates', caller, {
          query: { folder: child.id, q: 'PRICING' },
        }),
      )
      .items.map((item) => item.id),
  ).toEqual([created.id]);
  expect(
    messageTemplateList.parse(
      await call('listMessageTemplates', caller, {
        query: { q: '%' },
      }),
    ).items,
  ).toEqual([]);
  expect(
    messageTemplateList.parse(
      await call('listMessageTemplates', caller, {
        query: { q: '_' },
      }),
    ).items,
  ).toEqual([]);
  expect(
    messageTemplateList
      .parse(
        await call('listMessageTemplates', caller, {
          query: { q: 'guide' },
        }),
      )
      .items.map((item) => item.id),
  ).toEqual([created.id]);
  await expect(
    call('listMessageTemplates', foreign, { query: { folder: child.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  const renamed = messageTemplateFolder.parse(
    await call('updateMessageTemplateFolder', caller, {
      params: { id: child.id },
      body: { revision: child.revision, name: 'Requested guides' },
    }),
  );
  await call('removeMessageTemplateFolder', caller, {
    params: { id: child.id },
    body: { revision: renamed.revision },
  });
  expect(
    messageTemplateFolderDetail.parse(
      await call('getMessageTemplateFolder', caller, {
        params: { id: parent.id },
      }),
    ).folder.templateCount,
  ).toBe(1);
  expect(
    messageTemplate.parse(
      await call('getMessageTemplate', caller, {
        params: { id: created.id },
      }),
    ),
  ).toMatchObject({ ...guide, id: created.id, usedBy: uses, archivedAt: null });
});

it('serves every template operation the contract lists, once each, with its command', () => {
  const endpoints = [...messageTemplateEndpoints, ...messageTemplateFolderEndpoints];
  expect(routes.map((route) => route.endpoint)).toHaveLength(endpoints.length);
  expect(new Set(routes.map((route) => route.endpoint))).toEqual(new Set(endpoints));
  expect(
    routes
      .map((route) => [route.endpoint.operationId, route.command?.name, route.command?.permission])
      .sort(([left = ''], [right = '']) => left.localeCompare(right)),
  ).toEqual([
    ['archiveMessageTemplate', 'template.archive', 'templates.manage'],
    ['bulkMessageTemplates', 'template.bulk', 'templates.manage'],
    ['createMessageTemplate', 'template.create', 'templates.manage'],
    ['createMessageTemplateFolder', 'template.create_folder', 'templates.manage'],
    ['deleteMessageTemplate', 'template.delete', 'templates.manage'],
    ['duplicateMessageTemplate', 'template.duplicate', 'templates.manage'],
    ['getMessageTemplate', undefined, undefined],
    ['getMessageTemplateFolder', undefined, undefined],
    ['listMessageTemplateFolders', undefined, undefined],
    ['listMessageTemplates', undefined, undefined],
    ['moveMessageTemplate', 'template.move', 'templates.manage'],
    ['previewMessageTemplate', undefined, undefined],
    ['removeMessageTemplateFolder', 'template.remove_folder', 'templates.manage'],
    ['renderEmailPreview', undefined, undefined],
    ['restoreMessageTemplate', 'template.restore', 'templates.manage'],
    ['updateMessageTemplate', 'template.update', 'templates.manage'],
    ['updateMessageTemplateFolder', 'template.update_folder', 'templates.manage'],
  ]);
});

it('takes an author from a new template through an edit, a stale save, archive and restore', async () => {
  const caller = await inBusiness();
  const created = messageTemplate.parse(
    await call('createMessageTemplate', caller, { body: guide }),
  );
  expect(created).toMatchObject({
    ...guide,
    mergeFields: ['contact.firstName', 'contact.custom.services'],
    archivedAt: null,
    canManage: true,
    usedBy: uses,
    // The reader given here knows the first name only, so the custom field is named.
    unfillableFields: ['contact.custom.services'],
  });
  const params = { id: created.id };
  expect(await call('getMessageTemplate', caller, { params })).toEqual(created);
  expect(messageTemplateList.parse(await call('listMessageTemplates', caller))).toEqual({
    canManage: true,
    items: [
      {
        id: created.id,
        name: created.name,
        subject: created.subject,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        archivedAt: null,
        deletedAt: null,
        revision: created.revision,
        format: 'text',
        preheader: null,
        folder: null,
        preview: 'Hi {{contact.firstName}}, We cover {{contact.custom.services}}.',
        // These routes were given no reader of workflows: the count cannot be told.
        workflowUses: null,
      },
    ],
    nextCursor: null,
    total: 1,
  });

  const edited = messageTemplate.parse(
    await call('updateMessageTemplate', caller, {
      params,
      body: { ...guide, subject: 'Your price list', revision: created.revision },
    }),
  );
  expect(edited.subject).toBe('Your price list');
  expect(edited.mergeFields).toEqual(['contact.firstName', 'contact.custom.services']);
  // The revision read before that edit no longer saves, archives or restores.
  for (const [operationId, body] of [
    ['updateMessageTemplate', { ...guide, revision: created.revision }],
    ['archiveMessageTemplate', { revision: created.revision }],
    ['restoreMessageTemplate', { revision: created.revision }],
  ] as const)
    await expect(call(operationId, caller, { params, body })).rejects.toBeInstanceOf(ConflictError);
  expect(await call('getMessageTemplate', caller, { params })).toEqual(edited);

  // While a workflow sends it, it can't be archived: every send would fail.
  await expect(
    call('archiveMessageTemplate', caller, { params, body: { revision: edited.revision } }),
  ).rejects.toBeInstanceOf(ConflictError);
  sending = [];
  const archived = messageTemplate.parse(
    await call('archiveMessageTemplate', caller, { params, body: { revision: edited.revision } }),
  );
  expect(archived.archivedAt).not.toBeNull();
  expect(archived.usedBy).toEqual([]);
  expect(messageTemplateList.parse(await call('listMessageTemplates', caller)).items).toEqual([]);
  expect(
    messageTemplateList
      .parse(await call('listMessageTemplates', caller, { query: { archived: 'only' } }))
      .items.map((item) => item.id),
  ).toEqual([created.id]);
  await expect(
    call('updateMessageTemplate', caller, {
      params,
      body: { ...guide, subject: 'Edited while archived', revision: archived.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);

  const restored = messageTemplate.parse(
    await call('restoreMessageTemplate', caller, { params, body: { revision: archived.revision } }),
  );
  expect(restored).toMatchObject({ archivedAt: null, subject: 'Your price list' });
  expect(
    messageTemplateList.parse(
      await call('listMessageTemplates', caller, {
        query: { archived: 'include', after: created.id },
      }),
    ).items,
  ).toEqual([]);
});

it('previews unsaved text against sample values, honestly, and saves nothing', async () => {
  const caller = await inBusiness(new Set());
  const body = { subject: guide.subject, body: guide.body };
  expect(
    await call('previewMessageTemplate', caller, {
      body: {
        ...body,
        values: { 'contact.firstName': 'Ada', 'contact.custom.services': ['Video', 'Lighting'] },
      },
    }),
  ).toEqual({
    ok: true,
    subject: 'Your guide, Ada',
    body: 'Hi Ada,\nWe cover Video, Lighting.',
  });
  expect(
    messageTemplatePreview.parse(
      await call('previewMessageTemplate', caller, {
        body: { ...body, values: { 'contact.firstName': 'Ada' } },
      }),
    ),
  ).toEqual({ ok: false, code: 'missing_values', fields: ['contact.custom.services'] });
  expect(await call('previewMessageTemplate', caller, { body })).toEqual({
    ok: false,
    code: 'missing_values',
    fields: ['contact.firstName', 'contact.custom.services'],
  });
  expect(
    await call('previewMessageTemplate', caller, {
      body: { ...body, values: { 'contact.firstName': 'A\nB', 'contact.custom.services': 'x' } },
    }),
  ).toEqual({ ok: false, code: 'subject_line_break', fields: ['contact.firstName'] });
  // Markup in a value or in the text stays the text it is.
  expect(
    await call('previewMessageTemplate', caller, {
      body: {
        subject: 'Hi',
        body: '<b>{{contact.firstName}}</b>',
        values: { 'contact.firstName': '<i>Ada</i>' },
      },
    }),
  ).toEqual({ ok: true, subject: 'Hi', body: '<b><i>Ada</i></b>' });
  for (const refused of [
    { ...body, subject: 'Hi\r\nBcc: x' },
    { ...body, bodyHtml: '<p>Hello</p>' },
    { ...body, values: { nested: { a: 1 } } },
    { subject: 'Hi' },
  ])
    await expect(call('previewMessageTemplate', caller, { body: refused })).rejects.toBeInstanceOf(
      ValidationError,
    );
  expect(messageTemplateList.parse(await call('listMessageTemplates', caller)).items).toEqual([]);
});

it('lets any member read and preview, and refuses every change without templates.manage', async () => {
  const owner = await inBusiness();
  const created = messageTemplate.parse(
    await call('createMessageTemplate', owner, { body: guide }),
  );
  const params = { id: created.id };
  // Every permission but the one that counts, in the same business.
  const viewer: Invocation = {
    ...owner,
    permissions: new Set(permissions.filter((each) => each !== 'templates.manage')),
  };
  expect(await call('getMessageTemplate', viewer, { params })).toEqual({
    ...created,
    canManage: false,
  });
  expect(messageTemplateList.parse(await call('listMessageTemplates', viewer))).toMatchObject({
    canManage: false,
    items: [{ id: created.id }],
  });
  expect(
    await call('previewMessageTemplate', viewer, { body: { subject: 'Hi', body: 'Hello' } }),
  ).toEqual({ ok: true, subject: 'Hi', body: 'Hello' });
  for (const [operationId, request] of [
    ['createMessageTemplate', { body: { ...guide, name: 'Denied' } }],
    ['updateMessageTemplate', { params, body: { ...guide, revision: created.revision } }],
    ['archiveMessageTemplate', { params, body: { revision: created.revision } }],
    ['restoreMessageTemplate', { params, body: { revision: created.revision } }],
    ['deleteMessageTemplate', { params, body: { revision: created.revision } }],
    ['duplicateMessageTemplate', { params, body: {} }],
    ['bulkMessageTemplates', { body: { action: 'archive', ids: [created.id] } }],
  ] as const) {
    await expect(call(operationId, viewer, request)).rejects.toBeInstanceOf(ForbiddenError);
    // Someone who may not change templates learns nothing from the id either.
    await expect(
      call(operationId, viewer, {
        ...request,
        params: { id: toPublicId('template', '01900000-0000-7000-8000-000000000001') },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  }
  expect(await call('getMessageTemplate', owner, { params })).toEqual(created);
  const manager: Invocation = { ...owner, permissions: new Set(['templates.manage']) };
  sending = [];
  expect(
    messageTemplate.parse(
      await call('archiveMessageTemplate', manager, {
        params,
        body: { revision: created.revision },
      }),
    ).archivedAt,
  ).not.toBeNull();
});

it('refuses malformed paths, queries and bodies as validation errors, and foreign ids as not found', async () => {
  const caller = await inBusiness();
  const created = messageTemplate.parse(
    await call('createMessageTemplate', caller, { body: guide }),
  );
  const params = { id: created.id };
  const revision = created.revision;
  for (const [operationId, request] of [
    ['getMessageTemplate', { params: { id: 'con_01h455vb4pex5vsknk084sn02q' } }],
    ['getMessageTemplate', { params: {} }],
    ['updateMessageTemplate', { params: { id: 'nonsense' }, body: { ...guide, revision } }],
    ['updateMessageTemplate', { params, body: guide }],
    ['updateMessageTemplate', { params, body: { ...guide, revision, bodyHtml: '<p>x</p>' } }],
    ['updateMessageTemplate', { params, body: { ...guide, revision, id: 'tmpl_other' } }],
    ['updateMessageTemplate', { params, body: { ...guide, revision, subject: 'A\nB' } }],
    ['archiveMessageTemplate', { params, body: {} }],
    ['archiveMessageTemplate', { params, body: { revision: 'latest' } }],
    ['restoreMessageTemplate', { params, body: { revision, name: 'Other' } }],
    ['deleteMessageTemplate', { params, body: {} }],
    ['deleteMessageTemplate', { params: { id: 'nonsense' }, body: { revision } }],
    ['duplicateMessageTemplate', { params, body: { name: ' ' } }],
    ['duplicateMessageTemplate', { params, body: { revision } }],
    ['duplicateMessageTemplate', { params: { id: 'tfld_01h455vb4pex5vsknk084sn02q' } }],
    ['bulkMessageTemplates', { body: { action: 'archive', ids: [] } }],
    ['bulkMessageTemplates', { body: { action: 'move', ids: [created.id] } }],
    ['bulkMessageTemplates', { body: undefined }],
    ['createMessageTemplate', { body: { ...guide, name: 'Second', channel: 'sms' } }],
    ['createMessageTemplate', { body: { ...guide, name: 'Second', archivedAt: null } }],
    ['createMessageTemplate', { body: undefined }],
    ['listMessageTemplates', { query: { archived: 'yes' } }],
    ['listMessageTemplates', { query: { after: 'task_01h455vb4pex5vsknk084sn02q' } }],
    ['listMessageTemplates', { query: { channel: 'sms' } }],
  ] as const)
    await expect(
      call(operationId, caller, request),
      `${operationId} ${JSON.stringify(request)}`,
    ).rejects.toBeInstanceOf(ValidationError);
  expect(await call('getMessageTemplate', caller, { params })).toEqual(created);

  const elsewhere = await inBusiness();
  for (const [operationId, body] of [
    ['getMessageTemplate', undefined],
    ['updateMessageTemplate', { ...guide, revision }],
    ['archiveMessageTemplate', { revision }],
    ['restoreMessageTemplate', { revision }],
    ['deleteMessageTemplate', { revision }],
    ['duplicateMessageTemplate', {}],
    ['duplicateMessageTemplate', undefined],
  ] as const)
    await expect(call(operationId, elsewhere, { params, body })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  expect(messageTemplateList.parse(await call('listMessageTemplates', elsewhere)).items).toEqual(
    [],
  );
  await expect(
    call('listMessageTemplates', elsewhere, { query: { after: created.id } }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(await call('getMessageTemplate', caller, { params })).toEqual(created);
});

it('answers usedBy and unfillableFields as null when the server was given no readers', async () => {
  const caller = await inBusiness();
  const bare = createTemplateRoutes();
  const created = messageTemplate.parse(
    await call('createMessageTemplate', caller, { body: guide }, bare),
  );
  expect(created.usedBy).toBeNull();
  expect(created.unfillableFields).toBeNull();
  expect(await call('getMessageTemplate', caller, { params: { id: created.id } }, bare)).toEqual(
    created,
  );
});
