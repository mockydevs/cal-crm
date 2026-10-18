// The columns of the contact table, saved with the view. The view's other rules (privacy,
// sharing, limits) are views.int.test.ts.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import { contactTableColumnKeys, savedView, viewList, type SavedView } from '@repo/contracts';
import { ConflictError, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { lists, type World } from '../../test/lists-boards.js';

let world: World;
beforeAll(async () => {
  world = await lists(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

/** A signed-in person in a new business: only a person saves views. */
async function person(): Promise<Invocation> {
  const business = await world.inBusiness();
  const user = await world.database.fixtures.user({ name: 'Dana Brooks' });
  return {
    ...business,
    context: { ...business.context, actorKind: 'user', actorId: user.id, userId: user.id },
  };
}
const base = {
  name: 'Garden venues',
  state: { q: 'garden' },
  columns: ['name', 'email'],
};
const create = async (invocation: Invocation, body: object) =>
  savedView.parse(
    await world.call('createView', invocation, {
      body: { objectKey: 'contact', ...base, ...body },
    }),
  );
const update = async (invocation: Invocation, view: SavedView, body: object) =>
  savedView.parse(
    await world.call('updateView', invocation, {
      params: { id: view.id },
      body: { ...base, revision: view.revision, ...body },
    }),
  );
const stored = async (invocation: Invocation) =>
  viewList.parse(await world.call('listViews', invocation, { query: { object: 'contact' } })).items;

it('keeps the table columns a view is saved with, in the order given', async () => {
  const me = await person();
  const tableColumns = ['name', 'lastActivity', 'tags', 'company', 'phone'];
  const saved = await create(me, { tableColumns });
  expect(saved).toMatchObject({ tableColumns, columns: base.columns });
  expect(await stored(me)).toEqual([saved]);
  // Every column the table has can be chosen at once.
  const all = await create(me, { name: 'Everything', tableColumns: [...contactTableColumnKeys] });
  expect(all).toMatchObject({ tableColumns: contactTableColumnKeys });
});

it('reads a view saved without them as having none, as views were before', async () => {
  const me = await person();
  const saved = await create(me, {});
  expect(saved).toMatchObject({ tableColumns: null });
  // The stored row is what it was before table columns existed.
  const [row] = await world.database.as('crm_owner', (sql) =>
    sql.query<{ table_columns: unknown; columns: unknown }>(
      'select table_columns, columns from crm.saved_views where business_id = $1',
      [me.context.businessId],
    ),
  );
  expect(row).toEqual({ table_columns: null, columns: base.columns });
});

it('replaces them under the revision, keeps them when a save leaves them out, and clears them on null', async () => {
  const me = await person();
  const saved = await create(me, { tableColumns: ['name', 'tags'] });

  const reordered = await update(me, saved, { tableColumns: ['name', 'lastActivity', 'tags'] });
  expect(reordered.tableColumns).toEqual(['name', 'lastActivity', 'tags']);
  expect(reordered.revision).not.toBe(saved.revision);

  // A screen that does not know table columns saves the view without them: they stay.
  const renamed = await update(me, reordered, { name: 'Venues with gardens' });
  expect(renamed).toMatchObject({
    name: 'Venues with gardens',
    tableColumns: ['name', 'lastActivity', 'tags'],
  });

  const cleared = await update(me, renamed, { tableColumns: null });
  expect(cleared.tableColumns).toBeNull();
  expect(cleared.revision).not.toBe(renamed.revision);
  expect(await stored(me)).toEqual([cleared]);
});

it('refuses a save made from a view someone has since changed, and keeps what they saved', async () => {
  const me = await person();
  const saved = await create(me, { tableColumns: ['name', 'tags'] });
  const first = await update(me, saved, { tableColumns: ['name', 'company'] });
  // Made from the view as it was first read: it would silently undo the other choice.
  await expect(update(me, saved, { tableColumns: ['name', 'phone'] })).rejects.toBeInstanceOf(
    ConflictError,
  );
  // And a change of the columns alone is a change: the revision before it is stale too.
  await expect(update(me, saved, { name: 'Renamed only' })).rejects.toBeInstanceOf(ConflictError);
  expect(await stored(me)).toEqual([first]);
});

it.each([
  ['the name not first', ['tags', 'name']],
  ['no name', ['tags', 'email']],
  ['a column twice', ['name', 'tags', 'tags']],
  ['a column the table does not have', ['name', 'owner']],
  ['no column', []],
  ['something that is not a list', 'name'],
])('refuses %s and stores nothing', async (_what, tableColumns) => {
  const me = await person();
  await expect(create(me, { tableColumns })).rejects.toBeInstanceOf(ValidationError);
  expect(await stored(me)).toEqual([]);
  const saved = await create(me, { tableColumns: ['name', 'tags'] });
  await expect(update(me, saved, { tableColumns })).rejects.toBeInstanceOf(ValidationError);
  expect(await stored(me)).toEqual([saved]);
});

// A deal view has table columns too: its own, never a contact's.
it("is each list's own: a deal view keeps deal columns and its order, and takes none of a contact's", async () => {
  const me = await person();
  const { pipelineId } = await world.pipeline(me, ['New']);
  const deals = {
    objectKey: 'deal',
    name: `Open deals ${randomUUID().slice(0, 8)}`,
    state: { pipelineId, status: 'open' },
    columns: ['name', 'amount'],
  };
  // A contact's column is refused, and so is a deal's column on a contact view.
  await expect(
    world.call('createView', me, { body: { ...deals, tableColumns: ['name', 'lastActivity'] } }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(create(me, { tableColumns: ['name', 'stage'] })).rejects.toBeInstanceOf(
    ValidationError,
  );
  const plain = savedView.parse(await world.call('createView', me, { body: deals }));
  expect(plain.tableColumns).toBeNull();

  const tableColumns = ['name', 'contact', 'value', 'owner', 'created', 'updated', 'source'];
  const state = { ...deals.state, layout: 'table', sort: 'value', direction: 'asc' };
  const change = (view: SavedView, body: object) =>
    world
      .call('updateView', me, {
        params: { id: view.id },
        body: { name: deals.name, state, columns: deals.columns, revision: view.revision, ...body },
      })
      .then((answer) => savedView.parse(answer));
  const saved = await change(plain, { tableColumns });
  expect(saved).toMatchObject({ objectKey: 'deal', tableColumns, state });
  expect(saved.revision).not.toBe(plain.revision);
  // A save that leaves the columns out keeps them; null removes them; a stale save, a
  // column twice and a list that does not start with the name are refused.
  const kept = await change(saved, {});
  expect(kept.tableColumns).toEqual(tableColumns);
  await expect(change(saved, { tableColumns: ['name'] })).rejects.toBeInstanceOf(ConflictError);
  for (const wrong of [['value', 'name'], ['name', 'value', 'value'], []])
    await expect(change(kept, { tableColumns: wrong })).rejects.toBeInstanceOf(ValidationError);
  // An order is one of the list's four, with a direction only beside it, and never
  // together with a custom field's order.
  for (const wrong of [{ sort: 'stage' }, { direction: 'asc' }])
    await expect(
      world.call('updateView', me, {
        params: { id: kept.id },
        body: {
          name: deals.name,
          state: { ...deals.state, ...wrong },
          columns: deals.columns,
          revision: kept.revision,
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  const cleared = await change(kept, { tableColumns: null });
  expect(cleared.tableColumns).toBeNull();
  const listed = viewList.parse(await world.call('listViews', me, { query: { object: 'deal' } }));
  expect(listed.items.find((view) => view.id === saved.id)).toMatchObject({
    tableColumns: null,
    state,
  });
});

it('keeps the columns out of the audit log and the events, as the rest of a view is', async () => {
  const me = await person();
  const saved = await create(me, { tableColumns: ['name', 'tags'] });
  await update(me, saved, { tableColumns: ['name', 'company'] });
  const written = await world.database.as('crm_owner', (sql) =>
    sql.query<{ text: string }>(
      `select input::text as text from audit.commands where business_id = $1
       union all select payload::text from events.events where business_id = $1`,
      [me.context.businessId],
    ),
  );
  expect(written.length).toBeGreaterThan(0);
  for (const { text } of written) expect(text).not.toMatch(/tags|company|tableColumns/);
});
