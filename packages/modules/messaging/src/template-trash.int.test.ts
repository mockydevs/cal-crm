// Deleting templates to their trash, restoring them, duplicating them, changing many at
// once, and the list's filters, sorts and the folder panel's counts: as the server runs
// the routes, each answer checked against the schema the API documents. Real Postgres.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  bulkMessageTemplatesResult,
  messageTemplate,
  messageTemplateFolder,
  messageTemplateFolderList,
  messageTemplateList,
  type MessageTemplate,
  type MessageTemplateUse,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, beforeEach, expect, inject, it } from 'vitest';
import { createTemplateRoutes } from './template-routes.js';

// What sends each template, and how many workflows use it, by the template's public id: set
// by each test, as automations would answer.
const usesOf = new Map<string, MessageTemplateUse[]>();
const countsOf = new Map<string, number>();

let database: TestDatabase;
let db: Database;
let services: Services;
let routes: readonly ApiRoute[];
// A server that can't tell what sends a template or how many workflows use one.
let unaware: readonly ApiRoute[];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  routes = createTemplateRoutes({
    uses: (_trx, _context, id) => Promise.resolve(usesOf.get(id) ?? []),
    useCounts: (_trx, _context, templates) =>
      Promise.resolve(new Map(templates.map(({ id }) => [id, countsOf.get(id) ?? 0]))),
  });
  unaware = createTemplateRoutes();
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});
beforeEach(() => {
  usesOf.clear();
  countsOf.clear();
});

async function inBusiness(): Promise<Invocation> {
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
    permissions: 'all',
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
  if (schema === undefined) throw new Error(`${operationId} answers nothing.`);
  return schema.parse(answer);
}

const guide = { name: 'Pricing guide', subject: 'Your guide', body: 'Hello there.' };

const create = async (
  invocation: Invocation,
  body: Record<string, unknown> = {},
): Promise<MessageTemplate> =>
  messageTemplate.parse(
    await call('createMessageTemplate', invocation, { body: { ...guide, ...body } }),
  );
const get = async (invocation: Invocation, id: string): Promise<MessageTemplate> =>
  messageTemplate.parse(await call('getMessageTemplate', invocation, { params: { id } }));
const change = async (
  operationId:
    | 'deleteMessageTemplate'
    | 'restoreMessageTemplate'
    | 'archiveMessageTemplate'
    | 'duplicateMessageTemplate',
  invocation: Invocation,
  template: Pick<MessageTemplate, 'id' | 'revision'>,
  from: readonly ApiRoute[] = routes,
): Promise<MessageTemplate> =>
  messageTemplate.parse(
    await call(
      operationId,
      invocation,
      {
        params: { id: template.id },
        body: operationId === 'duplicateMessageTemplate' ? {} : { revision: template.revision },
      },
      from,
    ),
  );
const list = async (invocation: Invocation, query: Record<string, unknown> = {}) =>
  messageTemplateList.parse(await call('listMessageTemplates', invocation, { query }));
const listed = async (invocation: Invocation, query: Record<string, unknown> = {}) =>
  (await list(invocation, query)).items.map((item) => item.name);
const bulk = async (invocation: Invocation, body: Record<string, unknown>) =>
  bulkMessageTemplatesResult.parse(await call('bulkMessageTemplates', invocation, { body }));
const counts = async (invocation: Invocation) =>
  messageTemplateFolderList.parse(await call('listMessageTemplateFolders', invocation)).counts;

const events = (invocation: Invocation, type: string) =>
  database.withTenant(invocation.context, (sql) =>
    sql.query<{ subject_id: string; payload: unknown }>(
      `select subject_id, payload from events.events where type = $1 order by recorded_at, id`,
      [type],
    ),
  );
const audits = (invocation: Invocation, command: string) =>
  database.withTenant(invocation.context, (sql) =>
    sql.query<{ outcome: string; input: unknown }>(
      `select outcome, input from audit.commands where command = $1 order by recorded_at, id`,
      [command],
    ),
  );
const uuidOf = (template: Pick<MessageTemplate, 'id'>): string => {
  const uuid = parsePublicId('template', template.id);
  if (uuid === undefined) throw new Error(`Not a template id: ${template.id}`);
  return uuid;
};
const rejection = async (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => {
      throw new Error('Expected a refusal.');
    },
    (error: unknown) => error,
  );
const issuesOf = async (attempt: Promise<unknown>) => {
  const error = await rejection(attempt);
  if (!(error instanceof ValidationError))
    throw new Error(`Not a validation error: ${String(error)}`);
  return error.issues.map(({ path, code }) => ({ path, code }));
};
const workflow = (name: string, index: number): MessageTemplateUse => ({
  id: toPublicId('automation', `01900000-0000-7000-8000-0000000000${String(10 + index)}`),
  name,
  status: 'active',
});

it('deletes a template to the trash: out of every other list, its name free, still readable, and restored live', async () => {
  const caller = await inBusiness();
  const created = await create(caller, { name: 'Welcome' });
  expect(created.deletedAt).toBeNull();

  const deleted = await change('deleteMessageTemplate', caller, created);
  expect(deleted.deletedAt).not.toBeNull();
  // A template in the trash is archived too, from the same moment.
  expect(deleted.archivedAt).toBe(deleted.deletedAt);
  expect(deleted.revision).not.toBe(created.revision);
  expect(await events(caller, 'template.deleted')).toEqual([
    { subject_id: uuidOf(created), payload: { name: 'Welcome' } },
  ]);
  expect(await audits(caller, 'template.delete')).toEqual([
    { outcome: 'ok', input: { id: created.id, revision: created.revision } },
  ]);

  // Only the trash lists it; reading it by id still works, for the trash to show it.
  expect(await listed(caller)).toEqual([]);
  expect(await listed(caller, { archived: 'only' })).toEqual([]);
  expect(await listed(caller, { archived: 'include' })).toEqual([]);
  expect(await list(caller, { deleted: 'only' })).toMatchObject({
    items: [{ id: created.id, deletedAt: deleted.deletedAt }],
    total: 1,
  });
  expect(await get(caller, created.id)).toEqual(deleted);

  // Deleting it again changes nothing; a stale revision is still a conflict.
  expect(await change('deleteMessageTemplate', caller, deleted)).toEqual(deleted);
  expect(await events(caller, 'template.deleted')).toHaveLength(1);
  await expect(change('deleteMessageTemplate', caller, created)).rejects.toBeInstanceOf(
    ConflictError,
  );

  // In the trash it can't be edited or moved; archiving it changes nothing.
  for (const [operationId, body] of [
    ['updateMessageTemplate', { ...guide, revision: deleted.revision }],
    ['moveMessageTemplate', { revision: deleted.revision, folderId: null }],
  ] as const) {
    const error = await rejection(call(operationId, caller, { params: { id: created.id }, body }));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ message: 'This template is in the trash. Restore it first.' });
  }
  expect(await change('archiveMessageTemplate', caller, deleted)).toEqual(deleted);

  // Its name is free while it is in the trash, and it comes back only when it still is.
  const namesake = await create(caller, { name: ' WELCOME ' });
  expect(
    await issuesOf(
      call('restoreMessageTemplate', caller, {
        params: { id: created.id },
        body: { revision: deleted.revision },
      }),
    ),
  ).toEqual([{ path: '', code: 'taken' }]);
  await change('archiveMessageTemplate', caller, namesake);
  const restored = await change('restoreMessageTemplate', caller, deleted);
  expect(restored).toMatchObject({ archivedAt: null, deletedAt: null, name: 'Welcome' });
  expect(await listed(caller)).toEqual(['Welcome']);
  expect(await listed(caller, { deleted: 'only' })).toEqual([]);
  expect((await events(caller, 'template.restored')).map((event) => event.payload)).toEqual([
    { name: 'Welcome', from: 'trash' },
  ]);

  // An archived template restores as before, and says so.
  const archived = await change('archiveMessageTemplate', caller, restored);
  await change('restoreMessageTemplate', caller, archived);
  expect((await events(caller, 'template.restored')).map((event) => event.payload)).toEqual([
    { name: 'Welcome', from: 'trash' },
    { name: 'Welcome', from: 'archived' },
  ]);
});

it('keeps when an archived template was archived when it is deleted', async () => {
  const caller = await inBusiness();
  const archived = await change('archiveMessageTemplate', caller, await create(caller));
  const deleted = await change('deleteMessageTemplate', caller, archived);
  expect(deleted.archivedAt).toBe(archived.archivedAt);
  expect(deleted.deletedAt).not.toBeNull();
  expect(deleted.deletedAt).not.toBe(archived.archivedAt);
  expect(await listed(caller, { archived: 'only' })).toEqual([]);
  expect(await listed(caller, { deleted: 'only' })).toEqual(['Pricing guide']);
});

it('refuses to delete a template a published workflow sends, and names those workflows', async () => {
  const caller = await inBusiness();
  const template = await create(caller);
  const refusal = async (names: readonly string[]) => {
    usesOf.set(template.id, names.map(workflow));
    const error = await rejection(change('deleteMessageTemplate', caller, template));
    expect(error).toBeInstanceOf(ConflictError);
    return error instanceof Error ? error.message : '';
  };
  expect(await refusal(['Welcome series'])).toBe(
    '"Welcome series" sends this template. Take it out of its Send email step, then delete it.',
  );
  expect(await refusal(['Welcome series', 'Follow-up'])).toBe(
    '"Welcome series" and "Follow-up" send this template. Take it out of their Send email step, then delete it.',
  );
  expect(await refusal(['A', 'B', 'C'])).toBe(
    '"A", "B" and "C" send this template. Take it out of their Send email step, then delete it.',
  );
  expect(await refusal(['A', 'B', 'C', 'D', 'E'])).toBe(
    '"A", "B", "C" and 2 more send this template. Take it out of their Send email step, then delete it.',
  );
  expect(await get(caller, template.id)).toMatchObject({ deletedAt: null, archivedAt: null });
  expect(await events(caller, 'template.deleted')).toEqual([]);
  expect((await audits(caller, 'template.delete')).map((audit) => audit.outcome)).toEqual([
    'failed',
    'failed',
    'failed',
    'failed',
  ]);

  // Once nothing sends it, it goes; a server that can't tell what sends it lets it go too.
  usesOf.clear();
  expect((await change('deleteMessageTemplate', caller, template)).deletedAt).not.toBeNull();
  const other = await create(caller, { name: 'Other' });
  usesOf.set(other.id, [workflow('Welcome series', 0)]);
  expect((await change('deleteMessageTemplate', caller, other, unaware)).deletedAt).not.toBeNull();
});

it('refuses to delete a template that runs still in progress will send, and says so', async () => {
  const caller = await inBusiness();
  const template = await create(caller);
  const refusal = async (uses: readonly MessageTemplateUse[]) => {
    usesOf.set(template.id, [...uses]);
    const error = await rejection(change('deleteMessageTemplate', caller, template));
    expect(error).toBeInstanceOf(ConflictError);
    return error instanceof Error ? error.message : '';
  };
  const running = (name: string, index: number): MessageTemplateUse => ({
    ...workflow(name, index),
    runsInProgress: true,
  });
  expect(await refusal([running('Old drip', 0)])).toBe(
    'Runs still in progress in "Old drip" send this template. Delete it once they finish.',
  );
  expect(await refusal([running('Old drip', 0), running('Win back', 1)])).toBe(
    'Runs still in progress in "Old drip" and "Win back" send this template. Delete it once they finish.',
  );
  expect(await refusal([workflow('Welcome series', 0), running('Old drip', 1)])).toBe(
    '"Welcome series" sends this template. Take it out of its Send email step, then delete it. Runs still in progress in "Old drip" send it too: delete it once they finish.',
  );
  expect(await get(caller, template.id)).toMatchObject({ deletedAt: null, archivedAt: null });
  // In bulk, the same reason for that template.
  expect(await bulk(caller, { action: 'delete', ids: [template.id] })).toMatchObject({
    results: [
      {
        id: template.id,
        outcome: 'skipped',
        reason: {
          code: 'in_use',
          message:
            '"Welcome series" sends this template. Take it out of its Send email step, then delete it. Runs still in progress in "Old drip" send it too: delete it once they finish.',
        },
      },
    ],
  });
});

it('refuses to archive a template a workflow sends or runs still in progress will, alone or in bulk', async () => {
  const caller = await inBusiness();
  const template = await create(caller);
  const other = await create(caller, { name: 'Other' });
  const refusal = async (uses: readonly MessageTemplateUse[]) => {
    usesOf.set(template.id, [...uses]);
    const error = await rejection(change('archiveMessageTemplate', caller, template));
    expect(error).toBeInstanceOf(ConflictError);
    return error instanceof Error ? error.message : '';
  };
  const running = (name: string, index: number): MessageTemplateUse => ({
    ...workflow(name, index),
    runsInProgress: true,
  });
  expect(await refusal([workflow('Welcome series', 0)])).toBe(
    '"Welcome series" sends this template. Take it out of its Send email step, then archive it.',
  );
  expect(await refusal([running('Old drip', 0)])).toBe(
    'Runs still in progress in "Old drip" send this template. Archive it once they finish.',
  );
  expect(await refusal([workflow('Welcome series', 0), running('Old drip', 1)])).toBe(
    '"Welcome series" sends this template. Take it out of its Send email step, then archive it. Runs still in progress in "Old drip" send it too: archive it once they finish.',
  );
  expect(await get(caller, template.id)).toMatchObject({ archivedAt: null });
  expect(await events(caller, 'template.archived')).toEqual([]);

  // In bulk, the one in use stays with its reason; the other is archived.
  expect(await bulk(caller, { action: 'archive', ids: [template.id, other.id] })).toEqual({
    action: 'archive',
    results: [
      {
        id: template.id,
        outcome: 'skipped',
        reason: {
          code: 'in_use',
          message:
            '"Welcome series" sends this template. Take it out of its Send email step, then archive it. Runs still in progress in "Old drip" send it too: archive it once they finish.',
        },
      },
      { id: other.id, outcome: 'done', reason: null },
    ],
    done: 1,
    unchanged: 0,
    skipped: 1,
  });

  // Once nothing sends it, it archives; a server that can't tell lets it go too.
  usesOf.clear();
  expect((await change('archiveMessageTemplate', caller, template)).archivedAt).not.toBeNull();
  const third = await create(caller, { name: 'Third' });
  usesOf.set(third.id, [workflow('Welcome series', 0)]);
  expect(
    (await change('archiveMessageTemplate', caller, third, unaware)).archivedAt,
  ).not.toBeNull();
});

it('duplicates a template: the same content in the same folder, live, under a free name', async () => {
  const caller = await inBusiness();
  const folder = messageTemplateFolder.parse(
    await call('createMessageTemplateFolder', caller, { body: { name: 'Guides' } }),
  );
  const source = await create(caller, {
    name: 'Guide',
    subject: 'Your guide, {{contact.firstName}}',
    body: undefined,
    content: { format: 'html', html: '<p>Hi <b>there</b></p>', text: 'Hi there' },
    preheader: 'A peek inside',
    folderId: folder.id,
  });
  const copy = await change('duplicateMessageTemplate', caller, source);
  expect(copy.id).not.toBe(source.id);
  expect(copy).toMatchObject({
    name: 'Copy of Guide',
    subject: source.subject,
    body: source.body,
    content: source.content,
    preheader: 'A peek inside',
    folder: source.folder,
    format: 'html',
    archivedAt: null,
    deletedAt: null,
  });
  expect(await events(caller, 'template.created')).toContainEqual({
    subject_id: uuidOf(copy),
    payload: { name: 'Copy of Guide', channel: 'email', duplicateOf: uuidOf(source) },
  });
  expect(await audits(caller, 'template.duplicate')).toEqual([
    { outcome: 'ok', input: { id: source.id } },
  ]);
  // The name of a copy is never one that is taken, ignoring case.
  expect((await change('duplicateMessageTemplate', caller, source)).name).toBe('Copy of Guide (2)');
  await create(caller, { name: 'copy of guide (3)' });
  expect((await change('duplicateMessageTemplate', caller, source)).name).toBe('Copy of Guide (4)');
  // A name given is used, unless it is taken.
  const named = messageTemplate.parse(
    await call('duplicateMessageTemplate', caller, {
      params: { id: source.id },
      body: { name: '  Fresh guide ' },
    }),
  );
  expect(named.name).toBe('Fresh guide');
  expect(
    await issuesOf(
      call('duplicateMessageTemplate', caller, {
        params: { id: source.id },
        body: { name: 'guide' },
      }),
    ),
  ).toEqual([{ path: '/name', code: 'taken' }]);
  expect(await listed(caller, { folder: folder.id })).toEqual([
    'Copy of Guide',
    'Copy of Guide (2)',
    'Copy of Guide (4)',
    'Fresh guide',
    'Guide',
  ]);

  // The longest name still fits: the original is shortened, never the number.
  const long = await create(caller, { name: `${'n'.repeat(119)}x` });
  const first = await change('duplicateMessageTemplate', caller, long);
  const second = await change('duplicateMessageTemplate', caller, long);
  expect(first.name).toBe(`Copy of ${'n'.repeat(112)}`);
  expect(second.name).toBe(`Copy of ${'n'.repeat(108)} (2)`);
  expect(second.name).toHaveLength(120);

  // An archived template can be copied, live; one in the trash can't until restored.
  const archived = await change(
    'archiveMessageTemplate',
    caller,
    await create(caller, { name: 'Old' }),
  );
  expect(await change('duplicateMessageTemplate', caller, archived)).toMatchObject({
    name: 'Copy of Old',
    archivedAt: null,
  });
  const trashed = await change(
    'deleteMessageTemplate',
    caller,
    await create(caller, { name: 'Gone' }),
  );
  const error = await rejection(change('duplicateMessageTemplate', caller, trashed));
  expect(error).toBeInstanceOf(ConflictError);
  expect(error).toMatchObject({
    message: 'This template is in the trash. Restore it before duplicating it.',
  });
});

it('gives copies made at the same moment different names', async () => {
  const caller = await inBusiness();
  const source = await create(caller, { name: 'Twice' });
  const copies = await Promise.all(
    Array.from({ length: 4 }, () => change('duplicateMessageTemplate', caller, source)),
  );
  expect(copies.map((copy) => copy.name).sort()).toEqual([
    'Copy of Twice',
    'Copy of Twice (2)',
    'Copy of Twice (3)',
    'Copy of Twice (4)',
  ]);
});

it('changes many templates at once: each named once, in the order named, skipping what it cannot', async () => {
  const caller = await inBusiness();
  const folder = messageTemplateFolder.parse(
    await call('createMessageTemplateFolder', caller, { body: { name: 'Guides' } }),
  );
  const [one, two, three, four] = await Promise.all(
    ['One', 'Two', 'Three', 'Four'].map((name) => create(caller, { name })),
  );
  if (one === undefined || two === undefined || three === undefined || four === undefined)
    throw new Error('Expected four templates.');
  const missing = toPublicId('template', '01900000-0000-7000-8000-0000000000ff');
  const row = (
    template: Pick<MessageTemplate, 'id'> | string,
    outcome: 'done' | 'unchanged' | 'skipped',
    code?: string,
  ) => ({
    id: typeof template === 'string' ? template : template.id,
    outcome,
    reason: code === undefined ? null : { code, message: expect.any(String) as string },
  });

  expect(
    await bulk(caller, { action: 'move', ids: [two.id, one.id], folderId: folder.id }),
  ).toEqual({
    action: 'move',
    results: [row(two, 'done'), row(one, 'done')],
    done: 2,
    unchanged: 0,
    skipped: 0,
  });
  expect(await listed(caller, { folder: folder.id })).toEqual(['One', 'Two']);
  expect(
    await bulk(caller, { action: 'move', ids: [one.id, missing], folderId: folder.id }),
  ).toEqual({
    action: 'move',
    results: [row(one, 'unchanged'), row(missing, 'skipped', 'not_found')],
    done: 0,
    unchanged: 1,
    skipped: 1,
  });
  expect((await events(caller, 'template.moved')).map((event) => event.subject_id)).toEqual([
    uuidOf(two),
    uuidOf(one),
  ]);

  expect(await bulk(caller, { action: 'archive', ids: [one.id, three.id] })).toMatchObject({
    results: [row(one, 'done'), row(three, 'done')],
    done: 2,
  });
  expect((await bulk(caller, { action: 'archive', ids: [one.id] })).results).toEqual([
    row(one, 'unchanged'),
  ]);
  expect(await events(caller, 'template.archived')).toHaveLength(2);

  // A template a published workflow sends stays, with the reason naming the workflow.
  usesOf.set(two.id, [workflow('Welcome series', 0)]);
  const deleted = await bulk(caller, { action: 'delete', ids: [one.id, two.id, four.id, missing] });
  expect(deleted).toEqual({
    action: 'delete',
    results: [
      row(one, 'done'),
      row(two, 'skipped', 'in_use'),
      row(four, 'done'),
      row(missing, 'skipped', 'not_found'),
    ],
    done: 2,
    unchanged: 0,
    skipped: 2,
  });
  expect(deleted.results[1]?.reason?.message).toBe(
    '"Welcome series" sends this template. Take it out of its Send email step, then delete it.',
  );
  expect((await events(caller, 'template.deleted')).map((event) => event.payload)).toEqual([
    { name: 'One' },
    { name: 'Four' },
  ]);
  expect(await listed(caller, { deleted: 'only' })).toEqual(['Four', 'One']);
  expect((await bulk(caller, { action: 'delete', ids: [four.id] })).results).toEqual([
    row(four, 'unchanged'),
  ]);

  // In the trash, a template is neither moved nor archived.
  for (const body of [
    { action: 'move', ids: [four.id], folderId: null },
    { action: 'archive', ids: [four.id] },
  ])
    expect((await bulk(caller, body)).results).toEqual([row(four, 'skipped', 'in_trash')]);

  // A restore whose name a live template has is skipped; the others come back live.
  await create(caller, { name: 'one' });
  expect(
    await bulk(caller, { action: 'restore', ids: [one.id, four.id, three.id, two.id] }),
  ).toEqual({
    action: 'restore',
    results: [
      row(one, 'skipped', 'name_taken'),
      row(four, 'done'),
      row(three, 'done'),
      row(two, 'unchanged'),
    ],
    done: 2,
    unchanged: 1,
    skipped: 1,
  });
  expect((await events(caller, 'template.restored')).map((event) => event.payload)).toEqual([
    { name: 'Four', from: 'trash' },
    { name: 'Three', from: 'archived' },
  ]);
  expect(await listed(caller)).toEqual(['Four', 'one', 'Three', 'Two']);
  expect(await audits(caller, 'template.bulk')).toHaveLength(9);

  // A folder that isn't there stops the whole request.
  await expect(
    bulk(caller, {
      action: 'move',
      ids: [three.id],
      folderId: toPublicId('template_folder', '01900000-0000-7000-8000-0000000000ff'),
    }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    call('bulkMessageTemplates', caller, {
      body: {
        action: 'archive',
        ids: Array.from({ length: 101 }, (_, index) =>
          toPublicId('template', `01900000-0000-7000-8000-000000000${String(100 + index)}`),
        ),
      },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('restores two templates of the same name from the trash only one at a time', async () => {
  const caller = await inBusiness();
  const first = await change(
    'deleteMessageTemplate',
    caller,
    await create(caller, { name: 'Twin' }),
  );
  const second = await change(
    'deleteMessageTemplate',
    caller,
    await create(caller, { name: 'Twin' }),
  );
  expect((await bulk(caller, { action: 'restore', ids: [second.id, first.id] })).results).toEqual([
    { id: second.id, outcome: 'done', reason: null },
    {
      id: first.id,
      outcome: 'skipped',
      reason: {
        code: 'name_taken',
        message:
          'A template is already named "Twin". Rename or archive that one, then restore this template.',
      },
    },
  ]);
});

it('sorts by name, last update or use, filters by format and use, and pages through each in order', async () => {
  const caller = await inBusiness();
  const names = ['Delta', 'alpha', 'Echo', 'charlie', 'Bravo', 'foxtrot', 'Golf'];
  const made = new Map<string, MessageTemplate>();
  for (const [index, name] of names.entries())
    made.set(
      name,
      await create(
        caller,
        index % 3 === 0
          ? { name, body: undefined, content: { format: 'html', html: `<p>${name}</p>` } }
          : { name },
      ),
    );
  const id = (name: string): string => made.get(name)?.id ?? '';
  for (const [name, uses] of [
    ['Delta', 2],
    ['Echo', 5],
    ['Bravo', 2],
    ['Golf', 1],
  ] as const)
    countsOf.set(id(name), uses);
  // Edited last, so it is the most recently changed.
  const charlie = made.get('charlie');
  if (charlie === undefined) throw new Error('Expected charlie.');
  await call('updateMessageTemplate', caller, {
    params: { id: charlie.id },
    body: { name: 'charlie', subject: 'Edited', body: 'Edited.', revision: charlie.revision },
  });

  // Every page of two, read with the one before's cursor, in the order of the sort.
  // The total is the same on every page: all that match.
  const pages = async (query: Record<string, unknown>) => {
    const seen: string[] = [];
    const totals = new Set<number | undefined>();
    let after: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const answer = await list(caller, {
        ...query,
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
      totals.add(answer.total);
      seen.push(...answer.items.map((item) => item.name));
      if (answer.nextCursor === null) return { seen, total: [...totals] };
      after = answer.nextCursor;
    }
    throw new Error('Too many pages.');
  };
  expect(await pages({})).toEqual({
    seen: ['alpha', 'Bravo', 'charlie', 'Delta', 'Echo', 'foxtrot', 'Golf'],
    total: [7],
  });
  expect(await pages({ sort: 'updated' })).toEqual({
    seen: ['charlie', 'Golf', 'foxtrot', 'Bravo', 'Echo', 'alpha', 'Delta'],
    total: [7],
  });
  expect(await pages({ sort: 'uses' })).toEqual({
    seen: ['Echo', 'Bravo', 'Delta', 'Golf', 'alpha', 'charlie', 'foxtrot'],
    total: [7],
  });
  expect(await pages({ used: 'yes' })).toEqual({
    seen: ['Bravo', 'Delta', 'Echo', 'Golf'],
    total: [4],
  });
  expect(await pages({ used: 'no', sort: 'updated' })).toEqual({
    seen: ['charlie', 'foxtrot', 'alpha'],
    total: [3],
  });
  // charlie was formatted until its edit gave it plain text.
  expect(await pages({ format: 'html' })).toEqual({ seen: ['Delta', 'Golf'], total: [2] });
  expect(await pages({ format: 'text', used: 'yes', sort: 'uses' })).toEqual({
    seen: ['Echo', 'Bravo'],
    total: [2],
  });
  // Each item says how many workflows use it, whichever way the list is read.
  for (const sort of ['name', 'updated', 'uses'])
    expect(
      Object.fromEntries(
        (await list(caller, { sort })).items.map((item) => [item.name, item.workflowUses]),
      ),
    ).toEqual({ alpha: 0, Bravo: 2, charlie: 0, Delta: 2, Echo: 5, foxtrot: 0, Golf: 1 });

  // A template archived since its page was read still marks the place to go on from.
  const first = await list(caller, { sort: 'uses', limit: 2 });
  expect(first.items.map((item) => item.name)).toEqual(['Echo', 'Bravo']);
  const bravo = await get(caller, id('Bravo'));
  await change('archiveMessageTemplate', caller, bravo);
  expect(await listed(caller, { sort: 'uses', limit: 2, after: first.nextCursor })).toEqual([
    'Delta',
    'Golf',
  ]);
  const second = await list(caller, { sort: 'updated', limit: 1 });
  await change('archiveMessageTemplate', caller, await get(caller, id('charlie')));
  expect(second.items.map((item) => item.name)).toEqual(['charlie']);
  expect(await listed(caller, { sort: 'updated', limit: 2, after: second.nextCursor })).toEqual([
    'Golf',
    'foxtrot',
  ]);

  // The trash reads in each order too.
  for (const name of ['alpha', 'Golf'])
    await change('deleteMessageTemplate', caller, await get(caller, id(name)));
  expect(await listed(caller, { deleted: 'only' })).toEqual(['alpha', 'Golf']);
  expect(await listed(caller, { deleted: 'only', sort: 'updated' })).toEqual(['Golf', 'alpha']);
  expect(await listed(caller, { deleted: 'only', sort: 'uses' })).toEqual(['Golf', 'alpha']);
  expect(await listed(caller, { deleted: 'only', archived: 'only' })).toEqual(['alpha', 'Golf']);
  expect(await listed(caller, { archived: 'include', used: 'no' })).toEqual(['charlie', 'foxtrot']);
});

it('refuses to sort or filter by use when the server cannot tell what uses a template', async () => {
  const caller = await inBusiness();
  for (const [query, path] of [
    [{ sort: 'uses' }, '/sort'],
    [{ used: 'yes' }, '/used'],
    [{ used: 'no', sort: 'name' }, '/used'],
  ] as const)
    expect(
      await issuesOf(call('listMessageTemplates', caller, { query }, unaware)),
      JSON.stringify(query),
    ).toEqual([{ path, code: 'uses_unknown' }]);
  expect(
    messageTemplateList.parse(
      await call('listMessageTemplates', caller, { query: { sort: 'updated' } }, unaware),
    ).items,
  ).toEqual([]);
});

it('counts each view of the library for the folder panel', async () => {
  const caller = await inBusiness();
  const folder = messageTemplateFolder.parse(
    await call('createMessageTemplateFolder', caller, { body: { name: 'Guides' } }),
  );
  expect(await counts(caller)).toEqual({ all: 0, unfiled: 0, archived: 0, deleted: 0 });
  const filed = await create(caller, { name: 'Filed', folderId: folder.id });
  await create(caller, { name: 'Loose' });
  await change('archiveMessageTemplate', caller, await create(caller, { name: 'Archived' }));
  await change('deleteMessageTemplate', caller, await create(caller, { name: 'Gone' }));
  await change(
    'deleteMessageTemplate',
    caller,
    await create(caller, { name: 'Gone filed', folderId: folder.id }),
  );
  expect(await counts(caller)).toEqual({ all: 2, unfiled: 1, archived: 1, deleted: 2 });
  const folders = messageTemplateFolderList.parse(await call('listMessageTemplateFolders', caller));
  expect(folders.items).toMatchObject([{ id: folder.id, templateCount: 1 }]);
  await change('deleteMessageTemplate', caller, filed);
  expect(await counts(caller)).toEqual({ all: 1, unfiled: 1, archived: 1, deleted: 3 });
  // Another business counts its own, and has none.
  expect(await counts(await inBusiness())).toEqual({
    all: 0,
    unfiled: 0,
    archived: 0,
    deleted: 0,
  });
});

it("keeps another business out: it can't delete, restore, duplicate or change ours in bulk", async () => {
  const ours = await inBusiness();
  const theirs = await inBusiness();
  const live = await create(ours, { name: 'Live' });
  const trashed = await change('deleteMessageTemplate', ours, await create(ours, { name: 'Gone' }));
  for (const [operationId, template] of [
    ['deleteMessageTemplate', live],
    ['restoreMessageTemplate', trashed],
    ['duplicateMessageTemplate', live],
  ] as const)
    await expect(change(operationId, theirs, template)).rejects.toBeInstanceOf(NotFoundError);
  for (const action of ['archive', 'delete', 'restore'])
    expect(await bulk(theirs, { action, ids: [live.id, trashed.id] })).toMatchObject({
      results: [
        { id: live.id, outcome: 'skipped', reason: { code: 'not_found' } },
        { id: trashed.id, outcome: 'skipped', reason: { code: 'not_found' } },
      ],
      skipped: 2,
    });
  expect(await listed(theirs, { deleted: 'only' })).toEqual([]);
  expect(await get(ours, live.id)).toMatchObject({ archivedAt: null, deletedAt: null });
  expect(await get(ours, trashed.id)).toEqual(trashed);
  expect(await listed(ours)).toEqual(['Live']);
});
