// Snippets and their folders against real Postgres: what a save keeps, what the table
// decides when two writers meet, how the list searches and pages, how a snippet is filled
// in for a contact, and that another business sees none of it.
import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  permissions,
  renderedSnippet,
  snippet,
  snippetFolderList,
  snippetList,
  type Permission,
  type Snippet,
  type SnippetFolder,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createRenderSnippetCommand,
  createSnippetCommand,
  createSnippetFolderCommand,
  deleteSnippetCommand,
  deleteSnippetFolderCommand,
  moveSnippetsCommand,
  readSnippet,
  readSnippetFolders,
  readSnippets,
  renameSnippetFolderCommand,
  updateSnippetCommand,
} from './snippets.js';

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

const everythingBut = (...denied: Permission[]): readonly Permission[] =>
  permissions.filter((each) => !denied.includes(each));
const late = {
  type: 'text',
  name: 'Running late',
  body: 'Hi {{contact.firstName}}, running late.',
};
const quote = {
  type: 'email',
  name: 'Quote',
  subject: 'Your quote, {{contact.firstName}}',
  body: 'Hello {{contact.firstName}},\nsee {{custom_values.site}}.',
};

async function fixture(publicUrl: string | undefined = 'https://crm.example') {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const as = (granted: readonly Permission[] | 'all' = 'all'): Invocation => ({
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: granted === 'all' ? 'all' : new Set(granted),
  });
  // What a send would read for the contact: the stand-in for the automation module's reader.
  const values: Record<string, string | null> = { 'contact.firstName': 'Ada' };
  const render = createRenderSnippetCommand({
    values: () => Promise.resolve(values),
    publicUrl,
  });
  const run = <T>(work: (trx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    withTenant(db, as().context, work);
  return {
    business,
    as,
    values,
    create: (input: unknown = late, invocation = as()): Promise<Snippet> =>
      runCommand(services, createSnippetCommand, input, invocation),
    update: (
      saved: Pick<Snippet, 'id' | 'revision' | 'name' | 'subject' | 'body' | 'folderId'>,
      patch: Record<string, unknown> = {},
      invocation = as(),
    ): Promise<Snippet> =>
      runCommand(
        services,
        updateSnippetCommand,
        {
          name: saved.name,
          subject: saved.subject,
          body: saved.body,
          folderId: saved.folderId,
          revision: saved.revision,
          ...patch,
          snippetId: saved.id,
        },
        invocation,
      ),
    remove: (snippetId: string, invocation = as()) =>
      runCommand(services, deleteSnippetCommand, { snippetId }, invocation),
    move: (snippetIds: string[], folderId: string | null, invocation = as()) =>
      runCommand(services, moveSnippetsCommand, { snippetIds, folderId }, invocation),
    folder: (name: string, invocation = as()): Promise<SnippetFolder> =>
      runCommand(services, createSnippetFolderCommand, { name }, invocation),
    rename: (folder: SnippetFolder, name: string, invocation = as()) =>
      runCommand(
        services,
        renameSnippetFolderCommand,
        { folderId: folder.id, name, revision: folder.revision },
        invocation,
      ),
    removeFolder: (folderId: string, invocation = as()) =>
      runCommand(services, deleteSnippetFolderCommand, { folderId }, invocation),
    render: (snippetId: string, contactId: string, invocation = as()) =>
      runCommand(services, render, { snippetId, contactId }, invocation),
    read: (snippetId: string) => run((trx) => readSnippet(trx, as(), snippetId)),
    list: (query: Record<string, unknown> = {}, invocation = as()) =>
      run((trx) =>
        readSnippets(trx, invocation, {
          limit: 20,
          ...query,
        }),
      ),
    folders: (invocation = as()) => run((trx) => readSnippetFolders(trx, invocation)),
    contact: async () =>
      toPublicId('contact', (await database.fixtures.contact(business.context)).id),
    events: (type: string) =>
      database.withTenant(business.context, (sql) =>
        sql.query<{ subject_kind: string; payload: Record<string, unknown> }>(
          `select subject_kind, payload from events.events where type = $1 order by recorded_at, id`,
          [type],
        ),
      ),
    audits: (command: string) =>
      database.withTenant(business.context, (sql) =>
        sql.query<{ outcome: string; input: Record<string, unknown> }>(
          `select outcome, input from audit.commands where command = $1 order by recorded_at, id`,
          [command],
        ),
      ),
    count: (table: string) =>
      database.withTenant(business.context, async (sql) =>
        Number((await sql.one<{ n: string }>(`select count(*) as n from ${table}`)).n),
      ),
  };
}

describe('a snippet', () => {
  it('is saved as written, answers as its contract says, and says which fields it uses', async () => {
    const world = await fixture();
    const text = await world.create();
    const email = await world.create(quote);
    expect(snippet.parse(text)).toMatchObject({
      type: 'text',
      name: 'Running late',
      subject: null,
      body: late.body,
      folderId: null,
      folderName: null,
      mergeFields: ['contact.firstName'],
    });
    expect(email).toMatchObject({
      type: 'email',
      subject: quote.subject,
      mergeFields: ['contact.firstName', 'custom_values.site'],
    });
    expect(await world.read(email.id)).toEqual(email);
    expect(await world.events('snippet.created')).toEqual([
      { subject_kind: 'snippet', payload: { name: 'Running late', type: 'text' } },
      { subject_kind: 'snippet', payload: { name: 'Quote', type: 'email' } },
    ]);
  });

  it('keeps its text out of the audit log', async () => {
    const world = await fixture();
    await world.create(quote);
    const [audit] = await world.audits('snippet.create');
    expect(audit).toEqual({
      outcome: 'ok',
      input: {
        type: 'email',
        name: 'Quote',
        folderId: null,
        hasSubject: true,
        bodyLength: quote.body.length,
      },
    });
  });

  it('has a name no other snippet of the business has, whatever its type or case', async () => {
    const world = await fixture();
    await world.create();
    await expect(world.create({ ...quote, name: ' running LATE ' })).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'taken' }],
    });
    // Another business may use the name.
    const other = await fixture();
    await expect(other.create()).resolves.toMatchObject({ name: 'Running late' });
  });

  it('gives a name to one of two creates made at the same moment', async () => {
    const world = await fixture();
    const results = await Promise.allSettled([world.create(), world.create()]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await world.count('messaging.snippets')).toBe(1);
  });

  it('is saved only from the revision it was read at', async () => {
    const world = await fixture();
    const saved = await world.create();
    const renamed = await world.update(saved, { name: 'Late' });
    expect(renamed.revision).not.toBe(saved.revision);
    await expect(world.update(saved, { body: 'Stale' })).rejects.toBeInstanceOf(ConflictError);
    expect((await world.read(saved.id)).body).toBe(late.body);
    expect(await world.events('snippet.updated')).toEqual([
      {
        subject_kind: 'snippet',
        payload: { name: 'Late', subjectChanged: false, bodyChanged: false },
      },
    ]);
  });

  it('lets one of two saves from the same revision through', async () => {
    const world = await fixture();
    const saved = await world.create();
    const results = await Promise.allSettled([
      world.update(saved, { body: 'First' }),
      world.update(saved, { body: 'Second' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find((result) => result.status === 'rejected');
    expect(lost?.reason).toBeInstanceOf(ConflictError);
  });

  it('keeps its type: a text never gains a subject, an email never loses it', async () => {
    const world = await fixture();
    const text = await world.create();
    const email = await world.create(quote);
    await expect(world.update(text, { subject: 'Hello' })).rejects.toMatchObject({
      issues: [{ path: '/subject', code: 'invalid_for_type' }],
    });
    await expect(world.update(text, { body: 'x'.repeat(1601) })).rejects.toMatchObject({
      issues: [{ path: '/body', code: 'invalid_for_type' }],
    });
    await expect(world.update(email, { subject: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(world.update(email, { body: 'x'.repeat(1601) })).resolves.toMatchObject({
      type: 'email',
    });
  });

  it('is deleted for good, and is then not found', async () => {
    const world = await fixture();
    const saved = await world.create();
    await world.remove(saved.id);
    await expect(world.read(saved.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(world.remove(saved.id)).rejects.toBeInstanceOf(NotFoundError);
    // An id that is not one names nothing, as an id nothing has does.
    await expect(world.read('not-an-id')).rejects.toBeInstanceOf(NotFoundError);
    expect(await world.events('snippet.deleted')).toEqual([
      { subject_kind: 'snippet', payload: { name: 'Running late', type: 'text' } },
    ]);
  });

  it('records who made it and its folder: a person, or nobody when the system did', async () => {
    const world = await fixture();
    await world.folder('By a person');
    await world.create();
    const system = { context: world.business.context, permissions: 'all' as const };
    await world.folder('By the system', system);
    await world.create(quote, system);
    const made = (table: string) =>
      database.withTenant(world.business.context, (sql) =>
        sql.query<{ kind: string; by: boolean }>(
          `select created_by_kind as kind, created_by_id is not null as by
           from ${table} order by created_at, id`,
        ),
      );
    const both = [
      { kind: 'user', by: true },
      { kind: world.business.context.actorKind, by: false },
    ];
    expect(await made('messaging.snippets')).toEqual(both);
    expect(await made('messaging.snippet_folders')).toEqual(both);
  });

  it('stops at 2,000 for one business', async () => {
    const world = await fixture();
    await database.withTenant(world.business.context, (sql) =>
      sql.query(
        `insert into messaging.snippets (business_id, kind, name, body, created_by_kind)
         select app.business_id(), 'text', 'Snippet ' || n, 'Hi', 'user'
         from generate_series(1, 2000) n`,
      ),
    );
    await expect(world.create()).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'limit_reached' }],
    });
    expect((await world.list({ limit: 1 })).total).toBe(2000);
  });

  it('is changed only by someone who may manage templates, and read by any member', async () => {
    const world = await fixture();
    const saved = await world.create();
    const viewer = world.as(everythingBut('templates.manage'));
    await expect(world.create(quote, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(world.update(saved, { name: 'No' }, viewer)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(world.remove(saved.id, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(world.move([saved.id], null, viewer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(world.folder('Mine', viewer)).rejects.toBeInstanceOf(ForbiddenError);
    const list = await world.list({}, viewer);
    expect(list).toMatchObject({ total: 1, canManage: false });
    expect((await world.list()).canManage).toBe(true);
    expect((await world.folders(viewer)).canManage).toBe(false);
    expect(await world.count('messaging.snippets')).toBe(1);
  });

  it('is invisible to another business, by id and in every list', async () => {
    const world = await fixture();
    const other = await fixture();
    const saved = await world.create();
    const folder = await world.folder('Follow-ups');
    await expect(other.read(saved.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.update(saved, { name: 'Theirs' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.remove(saved.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.move([saved.id], null)).rejects.toMatchObject({
      issues: [{ path: '/snippetIds', code: 'invalid_snippet' }],
    });
    await expect(other.create({ ...late, folderId: folder.id })).rejects.toMatchObject({
      issues: [{ path: '/folderId', code: 'invalid_folder' }],
    });
    await expect(other.rename(folder, 'Theirs')).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.removeFolder(folder.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.render(saved.id, await other.contact())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await other.list()).toMatchObject({ items: [], total: 0 });
    expect((await other.folders()).items).toEqual([]);
    expect((await world.read(saved.id)).name).toBe('Running late');
  });
});

describe('the snippet list', () => {
  it('is in name order, a page at a time, with the start of each body on one line', async () => {
    const world = await fixture();
    for (const name of ['delta', 'Alpha', 'charlie', 'Bravo'])
      await world.create({ type: 'text', name, body: `Line one\n  line two of ${name}` });
    const first = snippetList.parse(await world.list({ limit: 3 }));
    expect(first.items.map((item) => item.name)).toEqual(['Alpha', 'Bravo', 'charlie']);
    expect(first.items[0]?.bodyPreview).toBe('Line one line two of Alpha');
    expect(first.total).toBe(4);
    const second = await world.list({ limit: 3, after: first.next });
    expect(second.items.map((item) => item.name)).toEqual(['delta']);
    expect(second.next).toBeNull();
    await expect(world.list({ after: 'not-a-cursor' })).rejects.toMatchObject({
      issues: [{ path: '/after', code: 'invalid_cursor' }],
    });
  });

  it('shows at most 200 characters of a long body', async () => {
    const world = await fixture();
    await world.create({ ...quote, body: 'x'.repeat(500) });
    const [item] = (await world.list()).items;
    expect(item?.bodyPreview).toHaveLength(200);
    expect(item).not.toHaveProperty('body');
  });

  it('finds by any part of the name, subject or body, and takes % and _ as written', async () => {
    const world = await fixture();
    await world.create();
    await world.create(quote);
    await world.create({ type: 'text', name: '100% off', body: 'Free_day' });
    const names = async (query: Record<string, unknown>) =>
      (await world.list(query)).items.map((item) => item.name);
    expect(await names({ q: 'LATE' })).toEqual(['Running late']);
    expect(await names({ q: 'your quote' })).toEqual(['Quote']);
    expect(await names({ q: 'custom_values' })).toEqual(['Quote']);
    expect(await names({ q: '%' })).toEqual(['100% off']);
    expect(await names({ q: 'e_d' })).toEqual(['100% off']);
    expect(await names({ type: 'email' })).toEqual(['Quote']);
    expect(await names({ type: 'text', q: 'off' })).toEqual(['100% off']);
  });
});

describe('snippet folders', () => {
  it('hold snippets, count them, and are listed by name', async () => {
    const world = await fixture();
    const follow = await world.folder('Follow-ups');
    const billing = await world.folder('billing');
    const saved = await world.create({ ...late, folderId: follow.id });
    expect(saved).toMatchObject({ folderId: follow.id, folderName: 'Follow-ups' });
    const listed = snippetFolderList.parse(await world.folders());
    expect(listed.items.map((item) => [item.name, item.snippetCount])).toEqual([
      ['billing', 0],
      ['Follow-ups', 1],
    ]);
    const names = async (folder: string) =>
      (await world.list({ folder })).items.map((item) => item.name);
    await world.create(quote);
    expect(await names(follow.id)).toEqual(['Running late']);
    expect(await names(billing.id)).toEqual([]);
    expect(await names('none')).toEqual(['Quote']);
  });

  it('have a name no other folder has, and are renamed from a revision', async () => {
    const world = await fixture();
    const follow = await world.folder('Follow-ups');
    await expect(world.folder(' follow-UPS ')).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'taken' }],
    });
    const renamed = await world.rename(follow, 'Later');
    expect(renamed.name).toBe('Later');
    // The name it already has changes nothing and reports nothing.
    expect(await world.rename(renamed, 'Later')).toEqual(renamed);
    expect(await world.events('snippet_folder.renamed')).toHaveLength(1);
    await expect(world.rename(follow, 'Stale')).rejects.toBeInstanceOf(ConflictError);
    await world.folder('Billing');
    await expect(world.rename(renamed, 'billing')).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'taken' }],
    });
  });

  it('take snippets in and out together: all move, or none does', async () => {
    const world = await fixture();
    const other = await fixture();
    const folder = await world.folder('Follow-ups');
    const first = await world.create();
    const second = await world.create(quote);
    const theirs = await other.create();
    await expect(world.move([first.id, theirs.id], folder.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await world.read(first.id)).folderId).toBeNull();
    const moved = await world.move([second.id, first.id], folder.id);
    expect(moved.items.map((item) => [item.name, item.folderName])).toEqual([
      ['Quote', 'Follow-ups'],
      ['Running late', 'Follow-ups'],
    ]);
    // Moving what is already there changes nothing and reports nothing.
    await world.move([first.id], folder.id);
    expect(await world.events('snippet.moved')).toHaveLength(1);
    await world.move([first.id], null);
    expect((await world.read(first.id)).folderId).toBeNull();
    await expect(
      world.move([first.id], toPublicId('snippet_folder', randomUUID7())),
    ).rejects.toMatchObject({ issues: [{ path: '/folderId', code: 'invalid_folder' }] });
  });

  it('leave their snippets behind, in no folder, when deleted', async () => {
    const world = await fixture();
    const folder = await world.folder('Follow-ups');
    const saved = await world.create({ ...late, folderId: folder.id });
    await world.removeFolder(folder.id);
    expect(await world.read(saved.id)).toMatchObject({ folderId: null, folderName: null });
    expect((await world.folders()).items).toEqual([]);
    expect(await world.events('snippet_folder.deleted')).toEqual([
      { subject_kind: 'snippet_folder', payload: { name: 'Follow-ups', snippets: 1 } },
    ]);
    // A save that still names the deleted folder is told so.
    await expect(world.update(saved, { folderId: folder.id })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('stop at 100 for one business', async () => {
    const world = await fixture();
    await database.withTenant(world.business.context, (sql) =>
      sql.query(
        `insert into messaging.snippet_folders (business_id, name, created_by_kind)
         select app.business_id(), 'Folder ' || n, 'user' from generate_series(1, 100) n`,
      ),
    );
    await expect(world.folder('One more')).rejects.toMatchObject({
      issues: [{ path: '/name', code: 'limit_reached' }],
    });
  });
});

describe('a snippet filled in for a contact', () => {
  it('reads as a send would: every field filled, the subject only for an email', async () => {
    const world = await fixture();
    const contact = await world.contact();
    const text = await world.create();
    world.values['custom_values.site'] = 'https://harbor.example';
    const email = await world.create(quote);
    expect(renderedSnippet.parse(await world.render(text.id, contact))).toEqual({
      ok: true,
      type: 'text',
      subject: null,
      body: 'Hi Ada, running late.',
    });
    expect(await world.render(email.id, contact)).toEqual({
      ok: true,
      type: 'email',
      subject: 'Your quote, Ada',
      body: 'Hello Ada,\nsee https://harbor.example.',
    });
  });

  it('names the fields with no value instead of leaving a gap', async () => {
    const world = await fixture();
    const email = await world.create(quote);
    expect(await world.render(email.id, await world.contact())).toEqual({
      ok: false,
      code: 'missing_values',
      fields: ['custom_values.site'],
    });
  });

  it('refuses a value that would break the subject onto a second line', async () => {
    const world = await fixture();
    world.values['contact.firstName'] = 'Ada\nBcc: x@example.com';
    world.values['custom_values.site'] = 'x';
    const email = await world.create(quote);
    expect(await world.render(email.id, await world.contact())).toEqual({
      ok: false,
      code: 'subject_line_break',
      fields: ['contact.firstName'],
    });
  });

  it('is for whoever may reply, for a contact of this business that is not in the trash', async () => {
    const world = await fixture();
    const other = await fixture();
    const saved = await world.create();
    const contact = await world.contact();
    await expect(
      world.render(saved.id, contact, world.as(everythingBut('conversations.reply'))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(world.render(saved.id, await other.contact())).rejects.toMatchObject({
      issues: [{ path: '/contactId', code: 'unknown_contact' }],
    });
    await database.withTenant(world.business.context, (sql) =>
      sql.query(`update crm.contacts set deleted_at = now()`),
    );
    await expect(world.render(saved.id, contact)).rejects.toMatchObject({
      issues: [{ path: '/contactId', code: 'unknown_contact' }],
    });
  });
});

/** A UUIDv7 nothing has: the version and variant bits set on a random UUID. */
function randomUUID7(): string {
  const raw = randomUUID().replaceAll('-', '');
  const hex = `${raw.slice(0, 12)}7${raw.slice(13, 16)}8${raw.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
