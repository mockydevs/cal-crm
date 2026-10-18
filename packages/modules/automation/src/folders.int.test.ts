// Folders for automations. They nest, to a depth; a name is used once in a place; a folder
// is renamed or moved only from the revision its editor saw; deleting one moves what was in
// it up a level and deletes nothing else. Real Postgres, through the command layer.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import {
  AUTOMATION_FOLDER_LIMIT,
  AUTOMATION_FOLDER_MAX_DEPTH,
  type Permission,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ConflictError, NotFoundError } from '@repo/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, waitsADay, type Harness, type Tenant } from '../test/workflows.js';
import { createDeletionCommands } from './deletion.js';
import { readAutomation, readAutomations } from './drafts.js';
import { createFolderCommands, readFolders } from './folders.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const { create, update, remove, moveAutomation } = createFolderCommands();
const deletion = createDeletionCommands();

const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});
const folder = (tenant: Tenant, name: string, parentId: string | null = null) =>
  runCommand(h.services, create, { name, parentId }, all(tenant));
/** The business's folders as a tree of names, each with how many automations are in it. */
const tree = async (tenant: Tenant) => {
  const { items } = await withTenant(h.db, tenant, (trx) => readFolders(trx));
  const nameOf = new Map(items.map((item) => [item.id, item.name]));
  return items.map((item) => [
    item.parentId === null ? null : (nameOf.get(item.parentId) ?? '?'),
    item.name,
    item.automationCount,
  ]);
};
const events = async (tenant: Tenant) =>
  (await h.events(tenant, 'automation.%')).map((event) => [event.type, event.payload]);

it('nests folders by name, files automations in them, and lists the whole tree', async () => {
  const tenant = await h.business();
  const leads = await folder(tenant, '  Leads ');
  expect(leads).toMatchObject({ name: 'Leads', parentId: null, revision: 1, automationCount: 0 });
  const warm = await folder(tenant, 'Warm', leads.id);
  expect(warm.parentId).toBe(leads.id);
  await folder(tenant, 'Archive');

  const { id } = await h.publish(tenant);
  const moved = await runCommand(
    h.services,
    moveAutomation,
    { id, folderId: warm.id },
    all(tenant),
  );
  expect(moved).toMatchObject({ id, folderId: warm.id, status: 'active' });
  // By name, whatever its capitals; a count is of what is directly inside.
  expect(await tree(tenant)).toEqual([
    [null, 'Archive', 0],
    [null, 'Leads', 0],
    ['Leads', 'Warm', 1],
  ]);

  // The list of automations is narrowed to a folder, or to the top level.
  const top = await h.publish(tenant, { ...waitsADay, name: 'At the top' });
  const list = (query: { folder?: string; q?: string }) =>
    withTenant(h.db, tenant, (trx) => readAutomations(trx, query)).then((page) =>
      page.items.map((item) => item.name),
    );
  expect(await list({ folder: warm.id })).toEqual(['Follow-up']);
  expect(await list({ folder: leads.id })).toEqual([]);
  expect(await list({ folder: 'root' })).toEqual(['At the top']);
  expect(await list({})).toEqual(['At the top', 'Follow-up']);
  // A name is looked for everywhere, with % and _ taken as written.
  expect(await list({ q: 'follow' })).toEqual(['Follow-up']);
  expect(await list({ q: 'TOP', folder: warm.id })).toEqual([]);
  expect(await list({ q: '%' })).toEqual([]);
  expect(await list({ folder: 'afol_01h455vb4pex5vsknk084sn02q' })).toEqual([]);

  // Moving it again to where it is says nothing; to the top level, it does.
  await runCommand(h.services, moveAutomation, { id, folderId: warm.id }, all(tenant));
  await runCommand(h.services, moveAutomation, { id, folderId: null }, all(tenant));
  expect(await list({ folder: 'root' })).toEqual(['At the top', 'Follow-up']);
  expect(await events(tenant)).toEqual([
    ['automation.folder_created', {}],
    ['automation.folder_created', {}],
    ['automation.folder_created', {}],
    ['automation.moved', { folderId: warm.id }],
    ['automation.moved', { folderId: null }],
  ]);
  expect(top.id).not.toBe(id);
});

it('keeps one name per place, a depth, and a number of folders', async () => {
  const tenant = await h.business();
  const leads = await folder(tenant, 'Leads');
  await expect(folder(tenant, 'LEADS')).rejects.toBeInstanceOf(ConflictError);
  await expect(folder(tenant, 'leads ')).rejects.toThrow(/already there/);
  // The same name is free inside it.
  let parent = (await folder(tenant, 'Leads', leads.id)).id;
  for (let depth = 3; depth <= AUTOMATION_FOLDER_MAX_DEPTH; depth += 1)
    parent = (await folder(tenant, `Level ${String(depth)}`, parent)).id;
  await expect(folder(tenant, 'One too deep', parent)).rejects.toMatchObject({
    issues: [{ path: '/parentId', code: 'folder_too_deep' }],
  });
  await expect(folder(tenant, 'Nowhere', 'afol_01h455vb4pex5vsknk084sn02q')).rejects.toBeInstanceOf(
    NotFoundError,
  );

  // At the limit no more are made: the tree stays one small answer.
  const crowded = await h.business();
  await h.database.withTenant(crowded, (sql) =>
    sql.query(
      `insert into automation.folders (business_id, name, created_by_kind)
       select app.business_id(), 'Folder ' || n, 'user' from generate_series(1, $1::int) n`,
      [AUTOMATION_FOLDER_LIMIT],
    ),
  );
  await expect(folder(crowded, 'One too many')).rejects.toThrow(/at most 500/);
});

it('renames and moves a folder only from the revision its editor saw', async () => {
  const tenant = await h.business();
  const leads = await folder(tenant, 'Leads');
  const old = await folder(tenant, 'Old');
  const change = (
    id: string,
    input: { revision: number; name?: string; parentId?: string | null },
  ) => runCommand(h.services, update, { id, ...input }, all(tenant));

  const renamed = await change(leads.id, { revision: 1, name: 'New leads' });
  expect(renamed).toMatchObject({ name: 'New leads', revision: 2 });
  // Someone still looking at revision 1 is told, and nothing of theirs is saved.
  const stale = change(leads.id, { revision: 1, name: 'Lost?' });
  await expect(stale).rejects.toBeInstanceOf(ConflictError);
  await expect(stale).rejects.toThrow(/revision 2, not 1/);

  const moved = await change(leads.id, { revision: 2, parentId: old.id });
  expect(moved).toMatchObject({ name: 'New leads', parentId: old.id, revision: 3 });
  // Both at once; and back to the top level.
  expect(await change(leads.id, { revision: 3, name: 'Leads', parentId: null })).toMatchObject({
    name: 'Leads',
    parentId: null,
    revision: 4,
  });
  // Saved as it already is, it keeps its revision and says nothing.
  expect(await change(leads.id, { revision: 4, name: 'Leads', parentId: null })).toMatchObject({
    revision: 4,
  });
  await expect(change(leads.id, { revision: 4 })).rejects.toMatchObject({
    issues: [{ code: 'nothing_to_change' }],
  });
  // A name taken where it is, or where it is going.
  await expect(change(leads.id, { revision: 4, name: 'old' })).rejects.toBeInstanceOf(
    ConflictError,
  );
  await folder(tenant, 'Leads', old.id);
  await expect(change(leads.id, { revision: 4, parentId: old.id })).rejects.toBeInstanceOf(
    ConflictError,
  );
  await expect(
    change(leads.id, { revision: 4, parentId: 'afol_01h455vb4pex5vsknk084sn02q' }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    change('afol_01h455vb4pex5vsknk084sn02q', { revision: 1, name: 'Nothing' }),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await events(tenant)).toEqual([
    ['automation.folder_created', {}],
    ['automation.folder_created', {}],
    ['automation.folder_updated', { renamed: true, moved: false }],
    ['automation.folder_updated', { renamed: false, moved: true }],
    ['automation.folder_updated', { renamed: true, moved: true }],
    ['automation.folder_created', {}],
  ]);
});

it('never puts a folder inside itself, or too deep with what it holds', async () => {
  const tenant = await h.business();
  const a = await folder(tenant, 'A');
  const b = await folder(tenant, 'B', a.id);
  const c = await folder(tenant, 'C', b.id);
  const move = (id: string, revision: number, parentId: string | null) =>
    runCommand(h.services, update, { id, revision, parentId }, all(tenant));
  for (const into of [a.id, b.id, c.id])
    await expect(move(a.id, 1, into)).rejects.toMatchObject({
      issues: [{ path: '/parentId', code: 'folder_inside_itself' }],
    });
  // A chain three deep fits under a folder two deep, and no deeper.
  const x = await folder(tenant, 'X');
  const y = await folder(tenant, 'Y', x.id);
  const z = await folder(tenant, 'Z', y.id);
  expect(AUTOMATION_FOLDER_MAX_DEPTH).toBe(5);
  await expect(move(a.id, 1, z.id)).rejects.toMatchObject({
    issues: [{ path: '/parentId', code: 'folder_too_deep' }],
  });
  expect(await move(a.id, 1, y.id)).toMatchObject({ parentId: y.id, revision: 2 });
});

it('lets exactly one of two moves that would close a loop go through', async () => {
  const tenant = await h.business();
  const a = await folder(tenant, 'A');
  const b = await folder(tenant, 'B');
  // The first move stops inside its transaction, holding the tree, until the second is
  // waiting for the tree in the database; only then does the first commit.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = (): void => undefined;
  const inside = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const first = withTenant(h.db, tenant, async (trx) => {
    const moved = await update.handle(
      trx,
      { id: a.id, revision: 1, parentId: b.id },
      {
        ...all(tenant),
        emit: () => Promise.resolve(randomUUID()),
        enqueue: () => undefined,
      },
    );
    reached();
    await held;
    return moved;
  });
  await inside;
  const second = runCommand(
    h.services,
    update,
    { id: b.id, revision: 1, parentId: a.id },
    all(tenant),
  );
  // Whatever is found, the first move is let go, so a failure here fails this test alone.
  try {
    await expect
      .poll(
        () =>
          h.database.as('postgres', async (sql) => {
            const [row] = await sql.query<{ waiting: number }>(
              `select count(*)::int as waiting from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'`,
            );
            return row?.waiting ?? 0;
          }),
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);
  } finally {
    release();
  }
  const [won, lost] = await Promise.allSettled([first, second]);
  expect(won).toMatchObject({ status: 'fulfilled', value: { parentId: b.id } });
  expect(lost).toMatchObject({ status: 'rejected' });
  expect(lost.status === 'rejected' && lost.reason).toMatchObject({
    issues: [{ code: 'folder_inside_itself' }],
  });
  expect(await tree(tenant)).toEqual([
    ['B', 'A', 0],
    [null, 'B', 0],
  ]);
});

it('deletes a folder by moving what was in it up one level, and nothing else', async () => {
  const tenant = await h.business();
  const leads = await folder(tenant, 'Leads');
  const warm = await folder(tenant, 'Warm', leads.id);
  const hot = await folder(tenant, 'Hot', warm.id);
  // A folder inside it that carries its own name takes its place.
  const twin = await folder(tenant, 'Warm', warm.id);
  const inWarm = await h.publish(tenant);
  const inHot = await h.publish(tenant, { ...waitsADay, name: 'Hot leads' });
  await runCommand(h.services, moveAutomation, { id: inWarm.id, folderId: warm.id }, all(tenant));
  await runCommand(h.services, moveAutomation, { id: inHot.id, folderId: hot.id }, all(tenant));

  await runCommand(h.services, remove, { id: warm.id }, all(tenant));
  expect(await tree(tenant)).toEqual([
    ['Leads', 'Hot', 1],
    [null, 'Leads', 1],
    ['Leads', 'Warm', 0],
  ]);
  // Each automation is where its folder went, or one level up; none was deleted or stopped.
  const at = async (id: string) =>
    (await withTenant(h.db, tenant, (trx) => readAutomation(trx, id))).folderId;
  expect(await at(inWarm.id)).toBe(leads.id);
  expect(await at(inHot.id)).toBe(hot.id);
  expect(
    (await withTenant(h.db, tenant, (trx) => readAutomations(trx, {}))).items.map((item) => [
      item.name,
      item.status,
    ]),
  ).toEqual([
    ['Hot leads', 'active'],
    ['Follow-up', 'active'],
  ]);
  // The folders that moved changed, so each has a new revision; the twin kept its id.
  const { items } = await withTenant(h.db, tenant, (trx) => readFolders(trx));
  expect(items.find((item) => item.id === twin.id)).toMatchObject({
    parentId: leads.id,
    revision: 2,
  });
  expect(items.find((item) => item.id === hot.id)).toMatchObject({
    parentId: leads.id,
    revision: 2,
  });
  expect((await events(tenant)).at(-1)).toEqual([
    'automation.folder_deleted',
    { movedFolders: 2, movedAutomations: 1 },
  ]);

  // A folder inside it that would meet another of its name one level up stops the delete.
  const clash = await folder(tenant, 'Clash');
  await folder(tenant, 'Hot', clash.id);
  await runCommand(
    h.services,
    update,
    { id: clash.id, revision: 1, parentId: leads.id },
    all(tenant),
  );
  await expect(runCommand(h.services, remove, { id: clash.id }, all(tenant))).rejects.toThrow(
    /a folder named “Hot”/,
  );
  await expect(runCommand(h.services, remove, { id: warm.id }, all(tenant))).rejects.toBeInstanceOf(
    NotFoundError,
  );

  // Deleted, an automation is in no folder; restored, it is at the top level.
  await runCommand(h.services, deletion.remove, { id: inHot.id }, all(tenant));
  expect(await at(inHot.id)).toBeNull();
  await expect(
    runCommand(h.services, moveAutomation, { id: inHot.id, folderId: hot.id }, all(tenant)),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await tree(tenant)).toContainEqual(['Leads', 'Hot', 0]);
  await runCommand(h.services, deletion.restore, { id: inHot.id }, all(tenant));
  expect(await at(inHot.id)).toBeNull();
});

it('is for those who may manage automations, in their own business', async () => {
  const tenant = await h.business();
  const elsewhere = await h.business();
  const leads = await folder(tenant, 'Leads');
  const { id } = await h.publish(tenant);
  const member = {
    context: { ...tenant, correlationId: randomUUID() },
    permissions: new Set<Permission>(),
  };
  const refused = { name: 'ForbiddenError', permission: 'automations.manage' };
  await expect(runCommand(h.services, create, { name: 'Mine' }, member)).rejects.toMatchObject(
    refused,
  );
  await expect(
    runCommand(h.services, update, { id: leads.id, revision: 1, name: 'Mine' }, member),
  ).rejects.toMatchObject(refused);
  await expect(runCommand(h.services, remove, { id: leads.id }, member)).rejects.toMatchObject(
    refused,
  );
  await expect(
    runCommand(h.services, moveAutomation, { id, folderId: leads.id }, member),
  ).rejects.toMatchObject(refused);

  // Another business sees none of it, and can neither change it nor file into it.
  expect(await tree(elsewhere)).toEqual([]);
  await expect(
    runCommand(h.services, update, { id: leads.id, revision: 1, name: 'Theirs' }, all(elsewhere)),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    runCommand(h.services, remove, { id: leads.id }, all(elsewhere)),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(folder(elsewhere, 'Inside theirs', leads.id)).rejects.toBeInstanceOf(NotFoundError);
  const theirs = await h.publish(elsewhere);
  await expect(
    runCommand(h.services, moveAutomation, { id: theirs.id, folderId: leads.id }, all(elsewhere)),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    runCommand(h.services, moveAutomation, { id, folderId: null }, all(elsewhere)),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await tree(tenant)).toEqual([[null, 'Leads', 0]]);
});
