// The contact list's columns beyond the built-in ones: custom fields chosen in Manage
// fields, under their folders, with their values in the rows; columns resized by dragging
// or from the keyboard; and both kept with a smart list and opened again from it.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  contactViewChanges,
  createViewInput,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  savedView,
  type SavedView,
} from '@repo/contracts';
import {
  addView,
  createButton,
  editView,
  expectView,
  openManageFields,
  openView,
  viewName,
} from './lists';
import { inHarbor, signedIn, dana } from './session';

const at = '2026-10-08T12:00:00.000Z';
const viewId = 'view_01m4bd188ff82s0add91b7pz63';
const budget = 'fld_01m4bd188ff82s0add91b7pz63';
const venue = 'fld_01m4bd188ff82s0add91b7pz64';
const retired = 'fld_01m4bd188ff82s0add91b7pz65';
const eventFolder = 'ffld_01m4bd188ff82s0add91b7pz63';

const field = (id: string, key: string, label: string, extra: object) => ({
  id,
  objectKey: 'contact',
  key,
  label,
  description: `What the couple said about ${label.toLowerCase()}.`,
  options: [],
  currency: null,
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
  revision: 'a'.repeat(64),
  ...extra,
});

/** The stand-in API: two contact fields in use and one archived, and one contact. */
async function columnsWorld(
  page: Page,
  items: SavedView[] = [],
): Promise<{ readonly asked: string[]; readonly writes: unknown[] }> {
  const asked: string[] = [];
  const writes: unknown[] = [];
  await signedIn(page, dana);
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({
      json: {
        items: [
          field(budget, 'budget', 'Budget', { valueType: 'money', currency: 'USD' }),
          field(venue, 'venue', 'Venue type', {
            valueType: 'single_choice',
            options: [{ key: 'barn', label: 'Barn', description: '', archived: false }],
            folderId: eventFolder,
          }),
          field(retired, 'retired', 'Old notes', { valueType: 'text', archived: true }),
        ],
        objects: [{ key: 'contact', label: 'Contact' }],
        canManage: true,
      },
    }),
  );
  await page.route('**/api/v1/field-folders**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: eventFolder,
            objectKey: 'contact',
            name: 'Event details',
            system: false,
            position: 1,
            fieldCount: 1,
            createdAt: at,
            revision: 'a'.repeat(64),
          },
        ],
        canManage: true,
      },
    }),
  );
  await page.route(/\/api\/v1\/contacts\?.*|\/api\/v1\/contacts$/, (route) => {
    const fields = new URL(route.request().url()).searchParams.get('fields');
    asked.push(fields ?? '');
    const values: Record<string, string | null> = { [budget]: '4500.00', [venue]: 'barn' };
    return route.fulfill({
      json: {
        canManage: true,
        next: null,
        items: [
          {
            id: 'con_01m4bd188ff82s0add91b7pz63',
            name: 'Maya Thompson',
            email: 'maya@example.com',
            phone: null,
            createdAt: at,
            ...(fields === null
              ? {}
              : {
                  fields: Object.fromEntries(
                    fields.split(',').map((id) => [id, values[id] ?? null]),
                  ),
                }),
          },
        ],
      },
    });
  });
  await page.route('**/api/v1/contacts/count**', (route) =>
    route.fulfill({ json: { count: 1, exact: true } }),
  );
  await page.route(/\/api\/v1\/views(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { canSave: true, items } });
      return;
    }
    const body: unknown = route.request().postDataJSON();
    writes.push(body);
    const created = savedView.parse({
      ...createViewInput.parse(body),
      id: viewId,
      owner: { membershipId: 'mem_01m4bd188ff82s0add91b7pz71', name: 'Dana Brooks', you: true },
      visibility: 'private',
      access: 'owner',
      sharing: { everyone: null, people: [] },
      canChange: true,
      canShare: true,
      canUnshare: false,
      canDelete: true,
      canChangeSharing: true,
      revision: 'a'.repeat(64),
      createdAt: at,
      updatedAt: at,
    });
    items.push(created);
    await route.fulfill({ status: 201, json: created });
  });
  await page.route(/\/api\/v1\/views\/[^/?]+$/, async (route) => {
    const body: unknown = route.request().postDataJSON();
    writes.push(body);
    const view = items[0];
    if (view === undefined) throw new Error('No view to change.');
    items[0] = savedView.parse({
      ...view,
      ...contactViewChanges.parse(body),
      revision: 'b'.repeat(64),
    });
    await route.fulfill({ json: items[0] });
  });
  return { asked, writes };
}

const headers = (page: Page) => page.getByRole('columnheader');
/** The edge at the right of a column's header, a slider of its width. */
const resizer = (page: Page, column: string) =>
  page.getByRole('slider', { name: `Width of the ${column} column`, exact: true });

test('shows custom fields as columns, chosen under their folders, and keeps them with a smart list', async ({
  page,
}) => {
  const { asked, writes } = await columnsWorld(page);
  await page.goto(inHarbor('/contacts'));
  await expect(headers(page)).toHaveText([
    'Contact name',
    'Phone',
    'Email',
    'Business name',
    'Created',
    'Last activity',
    'Tags',
  ]);
  // Without field columns the rows carry no field values.
  expect(asked.every((fields) => fields === '')).toBe(true);

  const fields = await openManageFields(page);
  // The fields in use are offered after the built-in columns, a folder's under its name;
  // an archived field is not.
  const adding = fields.getByRole('region', { name: 'Add fields' });
  await expect(adding.getByRole('checkbox', { name: 'Budget', exact: true })).toBeVisible();
  await expect(adding.getByText('Event details', { exact: true })).toBeVisible();
  await expect(adding.getByRole('checkbox', { name: 'Old notes' })).toHaveCount(0);
  await fields.getByRole('searchbox', { name: 'Search fields' }).fill('venue');
  await expect(adding.getByRole('checkbox')).toHaveCount(1);
  await adding.getByRole('checkbox', { name: 'Venue type', exact: true }).check();
  await fields.getByRole('searchbox', { name: 'Search fields' }).fill('');
  await adding.getByRole('checkbox', { name: 'Budget', exact: true }).check();
  for (const name of ['Business name', 'Created', 'Last activity', 'Tags'])
    await fields.getByRole('checkbox', { name, exact: true }).uncheck();
  const analysis = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(analysis.violations).toEqual([]);
  await fields.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(headers(page)).toHaveText([
    'Contact name',
    'Phone',
    'Email',
    'Venue type',
    'Budget',
  ]);
  // The page asks for the shown fields' values, and shows them as the contact page does.
  await expect.poll(() => asked.at(-1)).toBe(`${venue},${budget}`);
  const row = page.getByRole('row', { name: /Maya Thompson/ });
  await expect(row.getByRole('cell', { name: 'Barn', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: 'USD 4500.00', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '5/10 columns', exact: true })).toBeVisible();

  await addView(page).click();
  await viewName(page).fill('Barn weddings');
  await createButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
  expect(writes).toEqual([
    {
      objectKey: 'contact',
      name: 'Barn weddings',
      state: {},
      // The four the first table had, in their own order, as every saved list sends them.
      columns: ['name', 'email', 'phone'],
      tableColumns: ['name', 'phone', 'email'],
      columnLayout: ['name', 'phone', 'email', venue, budget],
    },
  ]);
  await openView(page, 'All');
  await expect(headers(page)).toHaveCount(7);
  await openView(page, 'Barn weddings');
  await expectView(page, 'Barn weddings');
  await expect(headers(page)).toHaveText([
    'Contact name',
    'Phone',
    'Email',
    'Venue type',
    'Budget',
  ]);
});

test('a smart list naming a field archived since drops that column and still opens', async ({
  page,
}) => {
  const list = savedView.parse({
    id: viewId,
    objectKey: 'contact',
    name: 'Old layout',
    state: {},
    columns: ['name'],
    tableColumns: ['name'],
    columnLayout: ['name', retired, budget],
    owner: { membershipId: 'mem_01m4bd188ff82s0add91b7pz71', name: 'Dana Brooks', you: true },
    visibility: 'private',
    access: 'owner',
    sharing: { everyone: null, people: [] },
    canChange: true,
    canShare: true,
    canUnshare: false,
    canDelete: true,
    canChangeSharing: true,
    revision: 'a'.repeat(64),
    createdAt: at,
    updatedAt: at,
  });
  const { asked } = await columnsWorld(page, [list]);
  await page.goto(inHarbor('/contacts'));
  await openView(page, 'Old layout');
  await expect(headers(page)).toHaveText(['Contact name', 'Budget']);
  await expect.poll(() => asked.at(-1)).toBe(budget);
});

test('resizes columns by dragging and from the keyboard, and keeps the widths with the list', async ({
  page,
}) => {
  const { writes } = await columnsWorld(page);
  await page.goto(inHarbor('/contacts?columns=%5B%22name%22%2C%22email%22%5D'));
  await expect(headers(page)).toHaveText(['Contact name', 'Email']);
  const email = headers(page).filter({ hasText: 'Email' });
  const edge = resizer(page, 'Email');
  // Measured once the header's edge and width menu have arrived, as they shift its layout.
  await expect(edge).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Change the width of the Email column', exact: true }),
  ).toBeVisible();
  const before = (await email.boundingBox())?.width ?? 0;

  // Dragged 100px wider, from a whole pixel inside the edge, so the pointer moves exactly 100.
  const box = await edge.boundingBox();
  if (box === null) throw new Error('The edge must show.');
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 5 });
  await page.mouse.up();
  const dragged = Math.round(before + 100);
  await expect.poll(async () => Math.round((await email.boundingBox())?.width ?? 0)).toBe(dragged);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('widths'))
    .toContain(`"email":${String(dragged)}`);

  // From the keyboard: an arrow moves the edge 16px, with Shift 64px, Home to the narrowest.
  await edge.focus();
  await expect(edge).toHaveAttribute('aria-valuenow', String(dragged));
  await expect(edge).toHaveAttribute('aria-valuemin', String(MIN_COLUMN_WIDTH));
  await expect(edge).toHaveAttribute('aria-valuemax', String(MAX_COLUMN_WIDTH));
  await page.keyboard.press('ArrowLeft');
  await expect(edge).toHaveAttribute('aria-valuenow', String(dragged - 16));
  await page.keyboard.press('Shift+ArrowRight');
  await expect(edge).toHaveAttribute('aria-valuenow', String(dragged + 48));
  await page.keyboard.press('Home');
  await expect(edge).toHaveAttribute('aria-valuenow', String(MIN_COLUMN_WIDTH));
  await expect
    .poll(async () => Math.round((await email.boundingBox())?.width ?? 0))
    .toBe(MIN_COLUMN_WIDTH);
  // How to move the edge is said to a screen reader, not only in a tooltip.
  await expect(edge).toHaveAttribute('aria-keyshortcuts', /Delete/);
  await expect(edge).toHaveAccessibleDescription(/Delete, or a double click, fits the content/);
  // The edge is a target of at least 24px.
  expect((await edge.boundingBox())?.width).toBeGreaterThanOrEqual(24);

  // Without dragging: the column's menu makes it wider and narrower with single clicks.
  const menu = page.getByRole('button', {
    name: 'Change the width of the Email column',
    exact: true,
  });
  await menu.click();
  await page.getByRole('menuitem', { name: 'Wider', exact: true }).click();
  await expect(edge).toHaveAttribute('aria-valuenow', String(MIN_COLUMN_WIDTH + 64));
  await menu.click();
  await page.getByRole('menuitem', { name: 'Narrower', exact: true }).click();
  await expect(edge).toHaveAttribute('aria-valuenow', String(MIN_COLUMN_WIDTH));

  // Kept with a smart list, and opened again at that width after a reload.
  await addView(page).click();
  await viewName(page).fill('Narrow email');
  await createButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
  expect(writes[0]).toMatchObject({
    columnLayout: ['name', 'email'],
    columnWidths: { email: MIN_COLUMN_WIDTH },
  });
  await page.reload();
  await expectView(page, 'Narrow email');
  await expect
    .poll(async () => Math.round((await email.boundingBox())?.width ?? 0))
    .toBe(MIN_COLUMN_WIDTH);

  // A double click puts it back to its content's width: the list is then modified, and
  // saving keeps no width.
  await edge.dblclick();
  await expect.poll(() => new URL(page.url()).searchParams.get('widths')).toBeNull();
  await expect(page.getByText('Modified', { exact: true })).toBeVisible();
  await editView(page);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'View updated.' })).toBeVisible();
  expect(writes[1]).toMatchObject({ columnLayout: ['name', 'email'], columnWidths: null });
});

test('a resized table still fits a 360px screen, scrolling inside its own region', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await columnsWorld(page);
  await page.goto(
    inHarbor(
      `/contacts?columns=${encodeURIComponent(JSON.stringify(['name', 'email', budget]))}&widths=${encodeURIComponent(JSON.stringify({ email: MAX_COLUMN_WIDTH }))}`,
    ),
  );
  await expect(headers(page)).toHaveText(['Contact name', 'Email', 'Budget']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const table = page.getByRole('region', { name: 'Contacts table' });
  expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // Each edge is reachable from the keyboard on a phone too.
  await resizer(page, 'Budget').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => new URL(page.url()).searchParams.get('widths')).toContain(budget);
  const analysis = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(analysis.violations).toEqual([]);
});
