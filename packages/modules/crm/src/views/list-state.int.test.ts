// What a saved contact view (a smart list) keeps of the list beside what it always did: the
// Filters panel's conditions, the direction of its order, and the table's layout with
// custom fields. The view's other rules are views.int.test.ts and
// table-columns.int.test.ts.
import type { Invocation } from '@repo/commands';
import {
  MAX_COLUMN_WIDTH,
  MAX_CONTACT_LAYOUT_COLUMNS,
  MIN_COLUMN_WIDTH,
  savedView,
  viewList,
  type SavedView,
} from '@repo/contracts';
import { ConflictError, toPublicId, ValidationError } from '@repo/kernel';
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
const base = { name: 'Garden venues', state: {}, columns: ['name', 'email'] };
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

const fieldA = toPublicId('field', '01890a5d-ac96-774b-bcce-b302099a8057');
const fieldB = toPublicId('field', '01890a5d-ac96-774b-bcce-b302099a8058');
const filter = {
  match: 'any',
  groups: [
    {
      match: 'all',
      conditions: [
        { field: 'created', operator: 'in_last', days: 30 },
        { field: 'type', operator: 'any_of', values: ['lead'] },
      ],
    },
    { match: 'all', conditions: [{ field: fieldA, operator: 'is_empty' }] },
  ],
};

it('keeps the filter and the direction a list is saved with, exactly as given', async () => {
  const me = await person();
  const saved = await create(me, {
    state: { q: 'garden', sort: 'name', direction: 'desc', filter },
  });
  expect(saved.state).toEqual({ q: 'garden', sort: 'name', direction: 'desc', filter });
  expect(await stored(me)).toEqual([saved]);

  // Replaced under the revision, like the rest of the state; left out, it is gone, because
  // a view's state is replaced whole.
  const narrowed = await update(me, saved, {
    state: { filter: { match: 'all', groups: [filter.groups[0]] } },
  });
  expect(narrowed.state).toEqual({ filter: { match: 'all', groups: [filter.groups[0]] } });
  expect(narrowed.revision).not.toBe(saved.revision);
  await expect(update(me, saved, { state: {} })).rejects.toBeInstanceOf(ConflictError);
  expect((await update(me, narrowed, { state: { q: 'x' } })).state).toEqual({ q: 'x' });
});

it('refuses a filter that is not one, and stores nothing', async () => {
  const me = await person();
  for (const state of [
    { filter: { match: 'all', groups: [] } },
    {
      filter: {
        match: 'all',
        groups: [{ match: 'all', conditions: [{ field: 'shoeSize', operator: 'is', value: '9' }] }],
      },
    },
    { direction: 'sideways' },
  ])
    await expect(create(me, { state })).rejects.toBeInstanceOf(ValidationError);
  expect(await stored(me)).toEqual([]);
});

it('keeps the table’s layout with custom fields, in the order given, beside the built-in columns', async () => {
  const me = await person();
  const columnLayout = ['name', fieldA, 'email', 'tags', fieldB];
  const saved = await create(me, { tableColumns: ['name', 'email', 'tags'], columnLayout });
  expect(saved).toMatchObject({ tableColumns: ['name', 'email', 'tags'], columnLayout });

  // A screen that does not know the layout saves the view without it: it stays.
  const renamed = await update(me, saved, { name: 'Venues with gardens' });
  expect(renamed).toMatchObject({ name: 'Venues with gardens', columnLayout });

  const reordered = await update(me, renamed, { columnLayout: ['name', fieldB, fieldA] });
  expect(reordered.columnLayout).toEqual(['name', fieldB, fieldA]);
  expect(reordered.revision).not.toBe(renamed.revision);
  // Made from the view as it was read before: refused, and the newer layout is kept.
  await expect(update(me, renamed, { columnLayout: ['name'] })).rejects.toBeInstanceOf(
    ConflictError,
  );

  const cleared = await update(me, reordered, { columnLayout: null });
  expect(cleared.columnLayout).toBeNull();
  expect(await stored(me)).toEqual([cleared]);
});

it('reads a view saved without a layout as having none, at the revision it always had', async () => {
  const me = await person();
  const plain = await create(me, {});
  expect(plain.columnLayout).toBeNull();
  const [row] = await world.database.as('crm_owner', (sql) =>
    sql.query<{ column_layout: unknown }>(
      'select column_layout from crm.saved_views where business_id = $1',
      [me.context.businessId],
    ),
  );
  expect(row).toEqual({ column_layout: null });
});

it('refuses a layout without the name first, with a column twice, or too long', async () => {
  const me = await person();
  const many = [
    'name',
    ...Array.from({ length: MAX_CONTACT_LAYOUT_COLUMNS }, (_, n) =>
      toPublicId('field', `01890a5d-ac96-774b-bcce-b302099a81${String(n + 10)}`),
    ),
  ];
  for (const columnLayout of [
    [fieldA, 'name'],
    ['name', fieldA, fieldA],
    [],
    ['name', 'shoeSize'],
    many,
  ])
    await expect(create(me, { columnLayout })).rejects.toBeInstanceOf(ValidationError);
  expect(
    (await create(me, { columnLayout: many.slice(0, MAX_CONTACT_LAYOUT_COLUMNS) })).columnLayout,
  ).toHaveLength(MAX_CONTACT_LAYOUT_COLUMNS);
});

it('belongs to contact views only', async () => {
  const me = await person();
  await expect(
    world.call('createView', me, {
      body: {
        objectKey: 'deal',
        name: 'Deals',
        state: {},
        columns: ['name'],
        columnLayout: ['name'],
      },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('keeps the widths its columns were dragged to, replaced under the revision, and clears them', async () => {
  const me = await person();
  const columnWidths = { name: 280, [fieldA]: 160 };
  const saved = await create(me, { columnLayout: ['name', fieldA], columnWidths });
  expect(saved.objectKey === 'contact' ? saved.columnWidths : undefined).toEqual(columnWidths);
  expect(await stored(me)).toEqual([saved]);

  // Left out, a change keeps them; given, they replace the old ones whole.
  const renamed = await update(me, saved, { name: 'Venues, wider' });
  expect(renamed).toMatchObject({ columnWidths });
  expect(renamed.revision).not.toBe(saved.revision);
  const resized = await update(me, renamed, { columnWidths: { name: MIN_COLUMN_WIDTH } });
  expect(resized).toMatchObject({ columnWidths: { name: MIN_COLUMN_WIDTH } });
  await expect(update(me, renamed, { columnWidths: { name: 300 } })).rejects.toBeInstanceOf(
    ConflictError,
  );
  const cleared = await update(me, resized, { columnWidths: null });
  expect(cleared).toMatchObject({ columnWidths: null });
  expect(await create(me, {})).toMatchObject({ columnWidths: null });
});

it('refuses a width too narrow, too wide or fractional, an unknown column, or too many', async () => {
  const me = await person();
  const many = Object.fromEntries(
    Array.from({ length: MAX_CONTACT_LAYOUT_COLUMNS + 1 }, (_, n) => [
      toPublicId('field', `01890a5d-ac96-774b-bcce-b302099a82${String(n + 10)}`),
      120,
    ]),
  );
  for (const columnWidths of [
    { name: MIN_COLUMN_WIDTH - 1 },
    { name: MAX_COLUMN_WIDTH + 1 },
    { name: 120.5 },
    { shoeSize: 120 },
    many,
  ])
    await expect(create(me, { columnWidths })).rejects.toBeInstanceOf(ValidationError);
  expect(await stored(me)).toEqual([]);
  await expect(
    world.call('createView', me, {
      body: { objectKey: 'deal', name: 'Deals', state: {}, columns: ['name'], columnWidths: {} },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
});
