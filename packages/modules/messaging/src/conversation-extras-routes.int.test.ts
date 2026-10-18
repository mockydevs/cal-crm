// The snippet and trigger link routes as the server runs them: every operation, each answer
// checked against the schema the API documents, and each permission enforced. Real
// Postgres.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  permissions,
  renderedSnippet,
  snippet,
  snippetEndpoints,
  snippetFolder,
  snippetFolderList,
  snippetList,
  triggerLink,
  triggerLinkClickList,
  triggerLinkEndpoints,
  triggerLinkList,
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
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createSnippetRoutes, triggerLinkRoutes } from './conversation-extras-routes.js';
import { openTriggerLink } from './trigger-link-tokens.js';

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
  routes = [
    ...createSnippetRoutes({
      values: () => Promise.resolve({ 'contact.firstName': 'Ada' }),
      publicUrl: 'https://crm.example',
    }),
    ...triggerLinkRoutes,
  ];
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function inBusiness(granted: Invocation['permissions'] = 'all') {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const as = (permissionsOf: Invocation['permissions']): Invocation => ({
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: permissionsOf,
  });
  const contact = await database.fixtures.contact(business.context);
  return { caller: as(granted), as, contactId: toPublicId('contact', contact.id) };
}

/** Calls a route as the server does, and checks the answer against its documented schema. */
async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
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

it('serves every snippet and trigger link operation the contract lists, once each, with its command', () => {
  const listed = [...snippetEndpoints, ...triggerLinkEndpoints];
  expect(routes.map((route) => route.endpoint)).toHaveLength(listed.length);
  expect(new Set(routes.map((route) => route.endpoint))).toEqual(new Set(listed));
  expect(
    routes
      .map((route) => [route.endpoint.operationId, route.command?.name, route.command?.permission])
      .sort(([left = ''], [right = '']) => left.localeCompare(right)),
  ).toEqual([
    ['createSnippet', 'snippet.create', 'templates.manage'],
    ['createSnippetFolder', 'snippet_folder.create', 'templates.manage'],
    ['createTriggerLink', 'trigger_link.create', 'templates.manage'],
    ['deleteSnippet', 'snippet.delete', 'templates.manage'],
    ['deleteSnippetFolder', 'snippet_folder.delete', 'templates.manage'],
    ['deleteTriggerLink', 'trigger_link.delete', 'templates.manage'],
    ['getSnippet', undefined, undefined],
    ['getTriggerLink', undefined, undefined],
    ['listSnippetFolders', undefined, undefined],
    ['listSnippets', undefined, undefined],
    ['listTriggerLinkClicks', undefined, undefined],
    ['listTriggerLinks', undefined, undefined],
    ['moveSnippets', 'snippet.move', 'templates.manage'],
    ['renameSnippetFolder', 'snippet_folder.rename', 'templates.manage'],
    // Filling one in for a contact is part of replying, not of authoring.
    ['renderSnippet', 'snippet.render', 'conversations.reply'],
    ['updateSnippet', 'snippet.update', 'templates.manage'],
    ['updateTriggerLink', 'trigger_link.update', 'templates.manage'],
  ]);
});

it('takes an author from a folder and a snippet through a move, an edit, a render and both deletes', async () => {
  const { caller, contactId } = await inBusiness();
  const folder = snippetFolder.parse(
    await call('createSnippetFolder', caller, { body: { name: 'Follow-ups' } }),
  );
  const created = snippet.parse(
    await call('createSnippet', caller, {
      body: { type: 'text', name: 'Running late', body: 'Hi {{contact.firstName}}' },
    }),
  );
  const moved = await call('moveSnippets', caller, {
    body: { snippetIds: [created.id], folderId: folder.id },
  });
  expect(moved).toMatchObject({ items: [{ id: created.id, folderName: 'Follow-ups' }] });
  const read = snippet.parse(
    await call('getSnippet', caller, { params: { snippetId: created.id } }),
  );
  const saved = snippet.parse(
    await call('updateSnippet', caller, {
      params: { snippetId: created.id },
      body: {
        name: 'Late',
        subject: null,
        body: 'Hello {{contact.firstName}}',
        folderId: folder.id,
        revision: read.revision,
      },
    }),
  );
  expect(saved).toMatchObject({ name: 'Late', folderId: folder.id });
  await expect(
    call('updateSnippet', caller, {
      params: { snippetId: created.id },
      body: { name: 'Stale', subject: null, body: 'x', folderId: null, revision: read.revision },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    renderedSnippet.parse(
      await call('renderSnippet', caller, {
        params: { snippetId: created.id },
        body: { contactId },
      }),
    ),
  ).toEqual({ ok: true, type: 'text', subject: null, body: 'Hello Ada' });
  expect(
    snippetList.parse(await call('listSnippets', caller, { query: { q: 'late', limit: '5' } })),
  ).toMatchObject({ total: 1, canManage: true, items: [{ id: created.id }] });
  const renamed = snippetFolder.parse(
    await call('renameSnippetFolder', caller, {
      params: { folderId: folder.id },
      body: { name: 'Later', revision: folder.revision },
    }),
  );
  expect(snippetFolderList.parse(await call('listSnippetFolders', caller))).toMatchObject({
    items: [{ id: renamed.id, name: 'Later', snippetCount: 1 }],
  });
  await call('deleteSnippetFolder', caller, { params: { folderId: folder.id } });
  await call('deleteSnippet', caller, { params: { snippetId: created.id } });
  await expect(
    call('getSnippet', caller, { params: { snippetId: created.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('takes a link from its making through a click, Analyze, a change and its deletion', async () => {
  const { caller, contactId } = await inBusiness();
  const link = triggerLink.parse(
    await call('createTriggerLink', caller, {
      body: { name: 'Spring offer', url: 'https://harbor.example/offer' },
    }),
  );
  const carrier = snippet.parse(
    await call('createSnippet', caller, {
      body: { type: 'text', name: 'Offer', body: `{{${link.mergeKey}}}` },
    }),
  );
  const rendered = renderedSnippet.parse(
    await call('renderSnippet', caller, { params: { snippetId: carrier.id }, body: { contactId } }),
  );
  const token = rendered.ok ? (rendered.body.split('/').at(-1) ?? '') : '';
  expect(await openTriggerLink(db, token, randomUUID())).toBe('https://harbor.example/offer');
  expect(
    triggerLinkClickList.parse(
      await call('listTriggerLinkClicks', caller, {
        params: { linkId: link.id },
        query: { limit: '5' },
      }),
    ),
  ).toMatchObject({ clicks: 1, contacts: 1, items: [{ contact: { id: contactId } }] });
  expect(
    triggerLinkList.parse(await call('listTriggerLinks', caller, { query: { q: 'spring' } })),
  ).toMatchObject({ total: 1, items: [{ id: link.id, clicks: 1 }] });
  const read = triggerLink.parse(
    await call('getTriggerLink', caller, { params: { linkId: link.id } }),
  );
  const changed = triggerLink.parse(
    await call('updateTriggerLink', caller, {
      params: { linkId: link.id },
      body: { name: 'Summer offer', url: 'https://harbor.example/summer', revision: read.revision },
    }),
  );
  expect(changed).toMatchObject({ name: 'Summer offer', key: 'spring_offer', clicks: 1 });
  await call('deleteTriggerLink', caller, { params: { linkId: link.id } });
  await expect(
    call('getTriggerLink', caller, { params: { linkId: link.id } }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await openTriggerLink(db, token, randomUUID())).toBeUndefined();
});

it('refuses an id of another kind in a path, whatever the body holds', async () => {
  const { caller } = await inBusiness();
  const wrong = toPublicId('template', '01900000-0000-7000-8000-00000000000a');
  for (const [operationId, params] of [
    ['getSnippet', { snippetId: wrong }],
    ['updateSnippet', { snippetId: wrong }],
    ['deleteSnippet', { snippetId: wrong }],
    ['renderSnippet', { snippetId: wrong }],
    ['renameSnippetFolder', { folderId: wrong }],
    ['deleteSnippetFolder', { folderId: wrong }],
    ['getTriggerLink', { linkId: wrong }],
    ['updateTriggerLink', { linkId: wrong }],
    ['deleteTriggerLink', { linkId: wrong }],
    ['listTriggerLinkClicks', { linkId: wrong }],
  ] as const)
    await expect(
      call(operationId, caller, { params, body: {} }),
      operationId,
    ).rejects.toBeInstanceOf(ValidationError);
});

it('lets any member read, and holds every change to its permission', async () => {
  const { as, contactId } = await inBusiness();
  const author = as('all');
  const link = triggerLink.parse(
    await call('createTriggerLink', author, {
      body: { name: 'Offer', url: 'https://harbor.example/' },
    }),
  );
  const saved = snippet.parse(
    await call('createSnippet', author, { body: { type: 'text', name: 'Late', body: 'Hi' } }),
  );
  const folder = snippetFolder.parse(
    await call('createSnippetFolder', author, { body: { name: 'Folder' } }),
  );
  const reader = as(new Set(permissions.filter((each) => each !== 'templates.manage')));
  expect(await call('listSnippets', reader)).toMatchObject({ total: 1, canManage: false });
  expect(await call('listSnippetFolders', reader)).toMatchObject({ canManage: false });
  expect(await call('listTriggerLinks', reader)).toMatchObject({ total: 1, canManage: false });
  await call('getSnippet', reader, { params: { snippetId: saved.id } });
  await call('getTriggerLink', reader, { params: { linkId: link.id } });
  await call('listTriggerLinkClicks', reader, { params: { linkId: link.id } });
  // Whoever may reply fills a snippet in without being able to write one.
  await call('renderSnippet', reader, { params: { snippetId: saved.id }, body: { contactId } });
  const changes: readonly (readonly [string, object])[] = [
    ['createSnippet', { body: { type: 'text', name: 'No', body: 'x' } }],
    [
      'updateSnippet',
      {
        params: { snippetId: saved.id },
        body: { name: 'No', subject: null, body: 'x', folderId: null, revision: saved.revision },
      },
    ],
    ['deleteSnippet', { params: { snippetId: saved.id } }],
    ['moveSnippets', { body: { snippetIds: [saved.id], folderId: null } }],
    ['createSnippetFolder', { body: { name: 'No' } }],
    [
      'renameSnippetFolder',
      { params: { folderId: folder.id }, body: { name: 'No', revision: folder.revision } },
    ],
    ['deleteSnippetFolder', { params: { folderId: folder.id } }],
    ['createTriggerLink', { body: { name: 'No', url: 'https://harbor.example/' } }],
    [
      'updateTriggerLink',
      {
        params: { linkId: link.id },
        body: { name: 'No', url: 'https://harbor.example/', revision: link.revision },
      },
    ],
    ['deleteTriggerLink', { params: { linkId: link.id } }],
  ];
  for (const [operationId, request] of changes)
    await expect(call(operationId, reader, request), operationId).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  const noReply = as(new Set(permissions.filter((each) => each !== 'conversations.reply')));
  await expect(
    call('renderSnippet', noReply, { params: { snippetId: saved.id }, body: { contactId } }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  // Nothing was changed by any of it.
  expect(await call('listSnippets', author)).toMatchObject({ total: 1 });
  expect(await call('listTriggerLinks', author)).toMatchObject({ total: 1 });
  expect(await call('listSnippetFolders', author)).toMatchObject({ items: [{ name: 'Folder' }] });
});

it('refuses every operation outside a business', async () => {
  const { caller } = await inBusiness();
  const { businessId: _left, ...agencyOnly } = caller.context;
  const staff: Invocation = { context: agencyOnly, permissions: 'all' };
  for (const operationId of [
    'listSnippets',
    'getSnippet',
    'listSnippetFolders',
    'listTriggerLinks',
    'getTriggerLink',
    'listTriggerLinkClicks',
  ])
    await expect(
      call(operationId, staff, {
        params: {
          snippetId: toPublicId('snippet', '01900000-0000-7000-8000-00000000000a'),
          linkId: toPublicId('trigger_link', '01900000-0000-7000-8000-00000000000a'),
        },
      }),
      operationId,
    ).rejects.toThrow();
});
