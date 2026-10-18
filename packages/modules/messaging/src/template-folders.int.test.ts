import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import type { MessageTemplateFolder } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import {
  createTemplateFolderCommands,
  readTemplateFolder,
  readTemplateFolders,
} from './template-folders.js';
import { createTemplateCommands, readTemplate } from './message-templates.js';

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
  const user = await database.fixtures.user();
  const as = (manage = true): Invocation => ({
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: new Set(manage ? (['templates.manage'] as const) : []),
  });
  const commands = createTemplateFolderCommands();
  const create = (name: string, parentId: string | null = null, invocation = as()) =>
    runCommand(services, commands.create, { name, parentId }, invocation);
  const update = (
    folder: MessageTemplateFolder,
    patch: { name?: string; parentId?: string | null },
  ) =>
    runCommand(
      services,
      commands.update,
      { id: folder.id, revision: folder.revision, ...patch },
      as(),
    );
  const remove = (folder: MessageTemplateFolder) =>
    runCommand(services, commands.remove, { id: folder.id, revision: folder.revision }, as());
  const list = (invocation = as()) =>
    withTenant(db, invocation.context, (trx) => readTemplateFolders(trx, invocation));
  const read = (id: string) =>
    withTenant(db, as().context, (trx) => readTemplateFolder(trx, as(), id));
  return { agency, business, as, create, update, remove, list, read };
}

it('creates nested folders, reports direct counts and respects read-only members', async () => {
  const f = await fixture();
  const parent = await f.create('  Welcome  ');
  const child = await f.create('Follow-up', parent.id);
  expect(parent).toMatchObject({ name: 'Welcome', parentId: null, revision: 1, templateCount: 0 });
  expect(child).toMatchObject({
    name: 'Follow-up',
    parentId: parent.id,
    revision: 1,
    templateCount: 0,
  });
  expect((await f.read(child.id)).breadcrumbs.map(({ name }) => name)).toEqual([
    'Welcome',
    'Follow-up',
  ]);
  expect(await f.list(f.as(false))).toMatchObject({ canManage: false, items: [child, parent] });
  await expect(f.create('Forbidden', null, f.as(false))).rejects.toBeInstanceOf(ForbiddenError);
});

it('treats foreign and absent parents alike, keeping other businesses invisible', async () => {
  const first = await fixture();
  const second = await fixture();
  const folder = await first.create('Private');
  await expect(second.create('Child', folder.id)).rejects.toBeInstanceOf(NotFoundError);
  await expect(second.update(folder, { name: 'Steal' })).rejects.toBeInstanceOf(NotFoundError);
  await expect(second.remove(folder)).rejects.toBeInstanceOf(NotFoundError);
  await expect(second.read(folder.id)).rejects.toBeInstanceOf(NotFoundError);
  expect((await second.list()).items).toEqual([]);
  expect((await first.list()).items).toEqual([folder]);
});

it('refuses stale writes and self/descendant moves without changing the tree', async () => {
  const f = await fixture();
  const parent = await f.create('Welcome');
  const child = await f.create('Child', parent.id);
  await expect(f.update(parent, { parentId: parent.id })).rejects.toBeInstanceOf(ValidationError);
  await expect(f.update(parent, { parentId: child.id })).rejects.toBeInstanceOf(ValidationError);
  const renamed = await f.update(parent, { name: 'Guides' });
  expect(renamed).toMatchObject({ id: parent.id, name: 'Guides', revision: 2 });
  await expect(f.update(parent, { name: 'Stale' })).rejects.toBeInstanceOf(ConflictError);
  await expect(f.remove(parent)).rejects.toBeInstanceOf(ConflictError);
  expect((await f.list()).items.map(({ name, parentId }) => ({ name, parentId }))).toEqual([
    { name: 'Child', parentId: parent.id },
    { name: 'Guides', parentId: null },
  ]);
});

it('serializes opposing moves so concurrent writers cannot introduce a cycle', async () => {
  const f = await fixture();
  const first = await f.create('First');
  const second = await f.create('Second');
  const results = await Promise.allSettled([
    f.update(first, { parentId: second.id }),
    f.update(second, { parentId: first.id }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ValidationError);
  const rows = (await f.list()).items;
  expect(rows.filter((row) => row.parentId === null)).toHaveLength(1);
});

it('refuses sibling collisions and removes populated folders without deleting children', async () => {
  const f = await fixture();
  const parent = await f.create('Parent');
  const child = await f.create('Guides', parent.id);
  const collision = await f.create('Guides');
  await expect(f.create(' guides ')).rejects.toBeInstanceOf(ConflictError);
  await expect(f.remove(parent)).rejects.toBeInstanceOf(ConflictError);
  expect((await f.list()).items).toHaveLength(3);
  await f.remove(collision);
  await f.remove(parent);
  expect((await f.list()).items).toEqual([
    expect.objectContaining({ id: child.id, parentId: null, revision: 2 }),
  ]);
});

it('checks the whole moved subtree against the depth limit', async () => {
  const f = await fixture();
  const first = await f.create('One');
  const second = await f.create('Two', first.id);
  const third = await f.create('Three', second.id);
  const fourth = await f.create('Four', third.id);
  const fifth = await f.create('Five', fourth.id);
  await expect(f.create('Six', fifth.id)).rejects.toBeInstanceOf(ValidationError);
  const another = await f.create('Another root');
  await expect(f.update(first, { parentId: another.id })).rejects.toBeInstanceOf(ValidationError);
  expect((await f.list()).items.find((row) => row.id === first.id)?.parentId).toBeNull();
});

it('removes a folder when its child has the same name, since that destination name is freed', async () => {
  const f = await fixture();
  const parent = await f.create('Guides');
  const child = await f.create('Guides', parent.id);
  await f.remove(parent);
  expect((await f.list()).items).toEqual([
    expect.objectContaining({ id: child.id, name: 'Guides', parentId: null }),
  ]);
});

it('uses database name normalization for non-ASCII sibling collisions', async () => {
  const f = await fixture();
  await f.create('İ');
  await expect(f.create('i')).rejects.toBeInstanceOf(ConflictError);
});

it('relocates a removed folder’s templates while preserving identity, content and direct counts', async () => {
  const f = await fixture();
  const parent = await f.create('Welcome');
  const child = await f.create('Guides', parent.id);
  const template = await runCommand(
    services,
    createTemplateCommands().create,
    {
      name: 'Pricing guide',
      subject: 'Your requested guide',
      body: 'The literal requested content.',
    },
    f.as(),
  );
  const templateUuid = parsePublicId('template', template.id);
  if (templateUuid === undefined) throw new Error('Fixture IDs must be valid.');
  const moved = await runCommand(
    services,
    createTemplateCommands().move,
    { id: template.id, revision: template.revision, folderId: child.id },
    f.as(),
  );
  expect(moved).toMatchObject({
    id: template.id,
    name: 'Pricing guide',
    subject: 'Your requested guide',
    body: 'The literal requested content.',
  });
  await expect(
    runCommand(
      services,
      createTemplateCommands().move,
      { id: template.id, revision: template.revision, folderId: null },
      f.as(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect((await f.read(child.id)).folder.templateCount).toBe(1);
  await f.remove(child);
  expect((await f.read(parent.id)).folder.templateCount).toBe(1);
  const invocation = f.as();
  expect(
    await withTenant(db, invocation.context, (trx) =>
      readTemplate(trx, invocation, template.id, {}),
    ),
  ).toMatchObject({
    id: template.id,
    name: 'Pricing guide',
    subject: 'Your requested guide',
    body: 'The literal requested content.',
    archivedAt: null,
  });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query<{ folder_id: string }>('select folder_id from messaging.templates where id = $1', [
        templateUuid,
      ]),
    ),
  ).toEqual([{ folder_id: parsePublicId('template_folder', parent.id) }]);
});

it('serializes a template move against folder removal without losing the template', async () => {
  const f = await fixture();
  const parent = await f.create('Library');
  const child = await f.create('Guides', parent.id);
  const commands = createTemplateCommands();
  const template = await runCommand(
    services,
    commands.create,
    { name: 'Concurrent guide', subject: 'Requested guide', body: 'The guide remains intact.' },
    f.as(),
  );
  const [move, removal] = await Promise.allSettled([
    runCommand(
      services,
      commands.move,
      { id: template.id, revision: template.revision, folderId: child.id },
      f.as(),
    ),
    f.remove(child),
  ]);
  expect(removal.status).toBe('fulfilled');
  if (move.status === 'rejected') expect(move.reason).toBeInstanceOf(NotFoundError);
  const invocation = f.as();
  expect(
    await withTenant(db, invocation.context, (trx) => readTemplate(trx, invocation, template.id)),
  ).toMatchObject({
    id: template.id,
    name: 'Concurrent guide',
    subject: 'Requested guide',
    body: 'The guide remains intact.',
    archivedAt: null,
  });
  expect((await f.list()).items.map((folder) => folder.name)).toEqual(['Library']);
  const placement = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ folder_id: string | null }>(
      'select folder_id from messaging.templates where id = $1',
      [parsePublicId('template', template.id)],
    ),
  );
  expect(placement).toEqual([
    { folder_id: move.status === 'fulfilled' ? parsePublicId('template_folder', parent.id) : null },
  ]);
});

it('refuses foreign placements and read-only template moves without changing content', async () => {
  const f = await fixture();
  const foreign = await fixture();
  const folder = await foreign.create('Private library');
  const commands = createTemplateCommands();
  const template = await runCommand(
    services,
    commands.create,
    { name: 'Welcome note', subject: 'Welcome', body: 'Your requested welcome note.' },
    f.as(),
  );
  const input = { id: template.id, revision: template.revision, folderId: folder.id };
  await expect(runCommand(services, commands.move, input, f.as())).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(runCommand(services, commands.move, input, foreign.as())).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(
    runCommand(services, commands.move, { ...input, folderId: null }, f.as(false)),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const invocation = f.as();
  expect(
    await withTenant(db, invocation.context, (trx) =>
      readTemplate(trx, invocation, template.id, {}),
    ),
  ).toMatchObject({
    id: template.id,
    revision: template.revision,
    subject: 'Welcome',
    body: 'Your requested welcome note.',
  });
});

it('bounds the tree at 500 folders without silently truncating a permitted library', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into messaging.template_folders (business_id, name, created_by_kind)
     select $1, 'Folder ' || number, 'system' from generate_series(1, 500) as number`,
      [f.business.id],
    ),
  );
  expect((await f.list()).items).toHaveLength(500);
  await expect(f.create('Overflow')).rejects.toBeInstanceOf(ConflictError);
  expect((await f.list()).items).toHaveLength(500);
});
