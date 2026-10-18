import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { reachesRightGutter } from './lists';
import { choose, expectChoice } from './select';
import { inHarbor, signedIn } from './session';
import { fakeFieldsApi, fieldOf, folderOf, systemFolders } from './settings-fixtures';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const fieldsTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Fields table', exact: true }).getByRole('table');
const fieldRow = (page: Page, name: string): Locator =>
  fieldsTable(page).getByRole('row').filter({ hasText: name });
const panel = (page: Page, name = 'Create custom field'): Locator =>
  page.getByRole('dialog', { name, exact: true });
const notice = (page: Page): Locator => page.getByRole('main').locator('p.sr-only[role="status"]');
const range = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('status');

const eventFolder = folderOf(3, 'Event details', 'contact');
const seededFolders = () => [
  folderOf(1, 'Additional Info', 'contact', true),
  folderOf(2, 'Additional Info', 'deal', true),
  { ...eventFolder },
];

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`creates a field in a folder, shows and copies its key, edits, moves, archives and restores it at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeFieldsApi(page, {
      folders: seededFolders(),
      fields: [
        fieldOf(1, 'Budget', { valueType: 'money', currency: 'KES' }),
        fieldOf(2, 'Quote total', { objectKey: 'deal', valueType: 'number' }),
      ],
    });
    await page.goto(inHarbor('/settings/custom-fields'));
    await expect(page.getByRole('heading', { level: 1, name: 'Custom Fields' })).toBeVisible();
    await expect(page).toHaveTitle('Custom Fields · Harbor Lights Events');

    // The object cards and the switch count what the server counted.
    const cards = page.getByRole('group', { name: 'Object', exact: true });
    await expect(cards.getByRole('button')).toHaveText([
      'All2 fields',
      'Contact1 field',
      'Opportunity1 field',
    ]);
    await expect(cards.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const views = page.getByRole('group', { name: 'Fields or folders', exact: true });
    await expect(views.getByRole('button')).toHaveText(['Fields 2', 'Folders 3']);
    await expect(fieldRow(page, 'Quote total')).toContainText('{{opportunity.quote_total}}');
    await expect(fieldRow(page, 'Budget')).toContainText('Monetary');
    await expect(fieldRow(page, 'Budget')).toContainText('Additional Info');

    await page.getByRole('button', { name: 'Create field', exact: true }).click();
    const creating = panel(page);
    await expect(creating).toBeVisible();
    const create = creating.getByRole('button', { name: 'Create custom field', exact: true });
    await expect(create).toBeDisabled();
    await creating.getByLabel('Field name', { exact: true }).fill('Guest count');
    // The key follows the name, and the panel shows the merge key it gives.
    await expect(creating.getByLabel('Key', { exact: true })).toHaveValue('guest_count');
    await expect(creating.getByText('{{contact.guest_count}}', { exact: true })).toBeVisible();
    await choose(creating.getByLabel('Field type', { exact: true }), 'number');
    await choose(creating.getByLabel('Folder name', { exact: true }), eventFolder.id);
    await creating.getByLabel('Placeholder text', { exact: true }).fill('How many are coming?');
    // The live preview is the field as it will appear.
    await expect(creating.getByLabel('Preview of Guest count', { exact: true })).toHaveAttribute(
      'placeholder',
      'How many are coming?',
    );
    // Everything the server requires, before the button is on.
    await expect(create).toBeDisabled();
    await creating
      .getByLabel('What it means', { exact: true })
      .fill('The latest expected number of guests.');
    await creating.getByLabel('Conversations', { exact: true }).check();
    await expect(create).toBeEnabled();
    await expectNoAccessibilityViolations(page);
    await create.click();
    await expect(notice(page)).toHaveText('Field created.');
    await expect(creating).toBeHidden();
    expect(api.fields.at(-1)).toMatchObject({
      key: 'guest_count',
      objectKey: 'contact',
      valueType: 'number',
      folderId: eventFolder.id,
      placeholder: 'How many are coming?',
      aiFillSources: ['conversations'],
    });

    const row = fieldRow(page, 'Guest count');
    await expect(row).toContainText('Number');
    await expect(row).toContainText('Event details');
    await expect(row).toContainText('{{contact.guest_count}}');
    await row.getByRole('button', { name: 'Copy {{contact.guest_count}}', exact: true }).click();
    await expect(notice(page)).toHaveText('Copied {{contact.guest_count}}');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '{{contact.guest_count}}',
    );

    await row.getByRole('button', { name: 'Edit Guest count', exact: true }).click();
    const editing = panel(page, 'Edit custom field');
    await expect(editing.getByLabel('Key', { exact: true })).toBeDisabled();
    await expect(editing.getByLabel('Key', { exact: true })).toHaveValue('guest_count');
    await expect(editing.getByLabel('Conversations', { exact: true })).toBeChecked();
    await editing.getByLabel('Field name', { exact: true }).fill('Attendees');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Field saved.');
    await expect(fieldRow(page, 'Attendees')).toContainText('{{contact.guest_count}}');
    // The keyboard is back on the row's button.
    await expect(
      fieldRow(page, 'Attendees').getByRole('button', { name: 'Edit Attendees', exact: true }),
    ).toBeFocused();

    await fieldRow(page, 'Attendees')
      .getByRole('button', { name: 'Move Attendees to a folder', exact: true })
      .click();
    const moving = page.getByRole('dialog', { name: 'Move to folder', exact: true });
    await expectChoice(moving.getByLabel('Folder', { exact: true }), eventFolder.id);
    await expect(moving.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
    await choose(moving.getByLabel('Folder', { exact: true }), systemFolders.contact);
    await moving.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(notice(page)).toHaveText('Field moved.');
    await expect(fieldRow(page, 'Attendees')).toContainText('Additional Info');

    // A field is archived, never deleted, and the page says so.
    await fieldRow(page, 'Attendees')
      .getByRole('button', { name: 'Archive Attendees', exact: true })
      .click();
    const archiving = page.getByRole('dialog', { name: 'Archive Attendees?', exact: true });
    await expect(archiving).toContainText('A field is archived, not deleted');
    await expectNoAccessibilityViolations(page);
    await archiving.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(notice(page)).toHaveText('Field archived.');
    await expect(fieldRow(page, 'Attendees')).toHaveCount(0);
    await expect(cards.getByRole('button', { name: 'Contact' })).toContainText('1 field');

    await choose(page.getByLabel('Status', { exact: true }), 'only');
    await expect(fieldRow(page, 'Attendees')).toContainText('Archived');
    await expect(fieldRow(page, 'Budget')).toHaveCount(0);
    await fieldRow(page, 'Attendees')
      .getByRole('button', { name: 'Restore Attendees', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Restore Attendees?', exact: true })
      .getByRole('button', { name: 'Restore', exact: true })
      .click();
    await expect(notice(page)).toHaveText('Field restored.');
    await choose(page.getByLabel('Status', { exact: true }), 'exclude');
    await expect(fieldRow(page, 'Attendees')).toBeVisible();
    expect(api.fields.at(-1)).toMatchObject({ key: 'guest_count', archived: false });

    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 360)
      for (const button of await fieldRow(page, 'Attendees').getByRole('button').all())
        expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('custom-fields.png'), fullPage: true });
  });
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('asks before unsaved changes to a field are lost', async ({ page }) => {
    await fakeFieldsApi(page);
    await page.goto(inHarbor('/settings/custom-fields'));
    const opener = page.getByRole('button', { name: 'Create field', exact: true });
    await opener.click();
    const creating = panel(page);
    // Nothing typed: it closes without asking.
    await creating.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(creating).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await creating.getByLabel('Field name', { exact: true }).fill('Venue');
    await page.keyboard.press('Escape');
    const asking = page.getByRole('dialog', { name: 'You have unsaved changes', exact: true });
    await expect(asking.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
    await expectNoAccessibilityViolations(page);
    await asking.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(creating.getByLabel('Field name', { exact: true })).toHaveValue('Venue');
    await creating.getByRole('button', { name: 'Close', exact: true }).click();
    await asking.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(creating).toBeHidden();
    await expect(asking).toBeHidden();
  });

  test('builds a dropdown with its choices, and a money field with its currency', async ({
    page,
  }) => {
    const api = await fakeFieldsApi(page);
    await page.goto(inHarbor('/settings/custom-fields'));
    await page.getByRole('button', { name: 'Create field', exact: true }).click();
    const creating = panel(page);
    const create = creating.getByRole('button', { name: 'Create custom field', exact: true });
    await creating.getByLabel('Field name', { exact: true }).fill('Fence type');
    await creating.getByLabel('What it means', { exact: true }).fill('The fence they asked for.');
    await choose(creating.getByLabel('Add to object', { exact: true }), 'deal');
    await expect(creating.getByText('{{opportunity.fence_type}}', { exact: true })).toBeVisible();
    await choose(creating.getByLabel('Field type', { exact: true }), 'single_choice');
    // A dropdown needs a named choice.
    await expect(create).toBeDisabled();
    await creating.getByRole('button', { name: 'Add choice', exact: true }).click();
    await expect(create).toBeDisabled();
    await creating.getByLabel('Choice name', { exact: true }).fill('Vinyl');
    await expect(creating.getByRole('listitem').filter({ hasText: 'Vinyl' })).toBeVisible();
    await expect(create).toBeEnabled();
    // Money needs its currency instead.
    await choose(creating.getByLabel('Field type', { exact: true }), 'money');
    await expect(create).toBeDisabled();
    await creating.getByLabel('Currency', { exact: true }).fill('kes');
    await expect(creating.getByLabel('Currency', { exact: true })).toHaveValue('KES');
    await choose(creating.getByLabel('Field type', { exact: true }), 'single_choice');
    // A key of one's own is kept when the name changes.
    await creating.getByLabel('Key', { exact: true }).fill('fence_kind');
    await creating.getByLabel('Field name', { exact: true }).fill('Fence style');
    await expect(creating.getByLabel('Key', { exact: true })).toHaveValue('fence_kind');
    await create.click();
    await expect(notice(page)).toHaveText('Field created.');
    expect(api.fields.at(-1)).toMatchObject({
      key: 'fence_kind',
      label: 'Fence style',
      objectKey: 'deal',
      valueType: 'single_choice',
      currency: null,
      folderId: systemFolders.deal,
    });
    expect(api.fields.at(-1)?.options).toMatchObject([{ label: 'Vinyl', archived: false }]);
    await expect(fieldRow(page, 'Fence style')).toContainText('Dropdown (single)');
  });

  test("shows the server's refusal under the field it names, and reloads a stale field", async ({
    page,
  }) => {
    const api = await fakeFieldsApi(page, { fields: [fieldOf(1, 'Budget')] });
    await page.goto(inHarbor('/settings/custom-fields'));
    await fieldRow(page, 'Budget')
      .getByRole('button', { name: 'Edit Budget', exact: true })
      .click();
    const editing = panel(page, 'Edit custom field');
    await editing.getByLabel('Field name', { exact: true }).fill('Budget (mine)');
    api.staleNext = true;
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(editing.getByRole('alert')).toContainText('Someone else changed this field.');
    await editing.getByRole('button', { name: 'Reload saved version', exact: true }).click();
    await expect(editing.getByLabel('Field name', { exact: true })).toHaveValue('Budget (theirs)');
    await editing.getByLabel('Field name', { exact: true }).fill('Budget (ours)');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Field saved.');
    expect(api.fields[0]?.label).toBe('Budget (ours)');

    // A key that is taken comes back from the server against the Key field.
    await page.route('**/api/v1/fields', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 422,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Unprocessable Content',
              status: 422,
              errors: [
                {
                  path: '/key',
                  code: 'taken',
                  message: 'A field of this object already has this key.',
                },
              ],
            },
          })
        : route.fallback(),
    );
    await page.getByRole('button', { name: 'Create field', exact: true }).click();
    const creating = panel(page);
    await creating.getByLabel('Field name', { exact: true }).fill('Budget');
    await creating.getByLabel('What it means', { exact: true }).fill('What they can spend.');
    await creating.getByRole('button', { name: 'Create custom field', exact: true }).click();
    await expect(
      creating.getByText('A field of this object already has this key.', { exact: true }),
    ).toBeVisible();
    await expect(creating).toBeVisible();
  });

  test('filters, searches, sorts and pages the list on the server', async ({ page }) => {
    const fields = Array.from({ length: 25 }, (_, at) =>
      fieldOf(at + 1, `Field ${String(at + 1).padStart(2, '0')}`, {
        valueType: at < 3 ? 'number' : 'text',
        source: at === 0 ? 'import' : 'user',
        objectKey: at < 5 ? 'deal' : 'contact',
      }),
    );
    const api = await fakeFieldsApi(page, { fields });
    await page.goto(inHarbor('/settings/custom-fields'));
    // Newest first, twenty to a page.
    await expect(range(page)).toHaveText('1 - 20 of 25');
    await expect(fieldsTable(page).getByRole('row')).toHaveCount(21);
    await expect(fieldsTable(page).getByRole('row').nth(1)).toContainText('Field 25');
    const created = fieldsTable(page).getByRole('columnheader', { name: 'Created' });
    await expect(created).toHaveAttribute('aria-sort', 'descending');
    const previous = page.getByRole('button', { name: 'Previous page', exact: true });
    const next = page.getByRole('button', { name: 'Next page', exact: true });
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(range(page)).toHaveText('21 - 25 of 25');
    await expect(fieldsTable(page).getByRole('row').nth(1)).toContainText('Field 05');
    await expect(next).toBeDisabled();
    expect(api.listed.at(-1)?.get('after')).toBe(fields[5]?.id);
    await previous.click();
    await expect(range(page)).toHaveText('1 - 20 of 25');

    await choose(page.getByLabel('Fields per page', { exact: true }), '10');
    await expect(range(page)).toHaveText('1 - 10 of 25');
    expect(api.listed.at(-1)?.get('limit')).toBe('10');
    await next.click();
    await next.click();
    await expect(range(page)).toHaveText('21 - 25 of 25');

    // Oldest first starts again from the first page.
    await created.getByRole('button').click();
    await expect(created).toHaveAttribute('aria-sort', 'ascending');
    await expect(range(page)).toHaveText('1 - 10 of 25');
    await expect(fieldsTable(page).getByRole('row').nth(1)).toContainText('Field 01');
    expect(api.listed.at(-1)?.get('sort')).toBe('created_asc');

    await choose(page.getByLabel('Field type', { exact: true }), 'number');
    await expect(range(page)).toHaveText('1 - 3 of 3');
    expect(api.listed.at(-1)?.get('valueType')).toBe('number');
    await choose(page.getByLabel('Source', { exact: true }), 'import');
    await expect(range(page)).toHaveText('1 - 1 of 1');
    expect(api.listed.at(-1)?.get('source')).toBe('import');
    await choose(page.getByLabel('Source', { exact: true }), 'all');
    await choose(page.getByLabel('Field type', { exact: true }), 'all');

    await choose(page.getByLabel('Created', { exact: true }), '7');
    await expect(page.getByText('No fields match.', { exact: true })).toBeVisible();
    await expect(range(page)).toHaveText('0 - 0 of 0');
    expect(api.listed.at(-1)?.get('createdFrom')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await choose(page.getByLabel('Created', { exact: true }), 'any');

    await page.getByRole('searchbox', { name: 'Search fields', exact: true }).fill('field 2');
    await expect(range(page)).toHaveText('1 - 6 of 6');
    expect(api.listed.at(-1)?.get('q')).toBe('field 2');
    await page.getByRole('searchbox', { name: 'Search fields', exact: true }).fill('');

    // One object's fields, and its counts on the switch.
    await page
      .getByRole('group', { name: 'Object', exact: true })
      .getByRole('button', { name: 'Opportunity' })
      .click();
    await expect(range(page)).toHaveText('1 - 5 of 5');
    expect(api.listed.at(-1)?.get('objectKey')).toBe('deal');
    await expect(
      page.getByRole('group', { name: 'Fields or folders', exact: true }).getByRole('button'),
    ).toHaveText(['Fields 5', 'Folders 1']);
    await expectNoAccessibilityViolations(page);
  });

  test('creates, renames and deletes folders, and leaves system folders alone', async ({
    page,
  }) => {
    const api = await fakeFieldsApi(page, {
      folders: seededFolders(),
      fields: [fieldOf(1, 'Venue', { folderId: eventFolder.id })],
    });
    await page.goto(inHarbor('/settings/custom-fields'));
    await page.getByRole('button', { name: 'Folders 3', exact: true }).click();
    const table = page.getByRole('region', { name: 'Folders table', exact: true });
    const folderRow = (name: string) => table.getByRole('row').filter({ hasText: name });
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(folderRow('Event details')).toContainText('Contact');
    await expect(folderRow('Event details').getByRole('cell').nth(1)).toHaveText('1');
    // A system folder says what it is, and has nothing to press.
    const system = table.getByRole('row').filter({ hasText: 'System folder' });
    await expect(system).toHaveCount(2);
    await expect(system.getByRole('button')).toHaveCount(0);

    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const creating = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await expect(
      creating.getByRole('button', { name: 'Create folder', exact: true }),
    ).toBeDisabled();
    await choose(creating.getByLabel('Add to object', { exact: true }), 'deal');
    await creating.getByLabel('Folder name', { exact: true }).fill('Quote');
    await creating.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder created.');
    await expect(folderRow('Quote')).toContainText('Opportunity');

    await folderRow('Quote')
      .getByRole('button', { name: 'Actions for Quote', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const renaming = page.getByRole('dialog', { name: 'Rename folder', exact: true });
    await renaming.getByLabel('Folder name', { exact: true }).fill('Quotes (mine)');
    api.staleNext = true;
    await renaming.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(renaming.getByRole('alert')).toContainText('Someone else changed this folder.');
    await renaming.getByRole('button', { name: 'Reload saved version', exact: true }).click();
    await expect(renaming.getByLabel('Folder name', { exact: true })).toHaveValue('Quote (theirs)');
    await renaming.getByLabel('Folder name', { exact: true }).fill('Quotes');
    await renaming.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder renamed.');
    await expect(
      folderRow('Quotes').getByRole('button', { name: 'Actions for Quotes', exact: true }),
    ).toBeFocused();

    await page.getByRole('searchbox', { name: 'Search folders', exact: true }).fill('event');
    await expect(table.getByRole('row')).toHaveCount(2);
    await folderRow('Event details')
      .getByRole('button', { name: 'Actions for Event details', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const deleting = page.getByRole('dialog', {
      name: 'Delete the folder Event details?',
      exact: true,
    });
    await expect(deleting).toContainText("move to the object's system folder");
    await expectNoAccessibilityViolations(page);
    await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder deleted.');
    await expect(page.getByText('No folders match.', { exact: true })).toBeVisible();
    // Its field is kept, in the system folder.
    expect(api.fields[0]?.folderId).toBe(systemFolders.contact);
    await page.getByRole('searchbox', { name: 'Search folders', exact: true }).fill('');
    await expectNoAccessibilityViolations(page);
  });

  test('is read-only for someone who may not manage fields', async ({ page }) => {
    const api = await fakeFieldsApi(page, { fields: [fieldOf(1, 'Budget')] });
    api.canManage = false;
    await page.goto(inHarbor('/settings/custom-fields'));
    await expect(fieldRow(page, 'Budget')).toContainText('{{contact.budget}}');
    await expect(
      page.getByText('Owners and admins manage fields. Everyone on the team can read them.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create field', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create folder', exact: true })).toHaveCount(0);
    await expect(fieldsTable(page).getByRole('columnheader', { name: 'Actions' })).toHaveCount(0);
    // The key can still be copied; nothing else can be pressed.
    await expect(fieldRow(page, 'Budget').getByRole('button')).toHaveCount(1);
    await expectNoAccessibilityViolations(page);
  });

  test('says so when the fields cannot be loaded, and tries again', async ({ page }) => {
    let failing = true;
    const api = await fakeFieldsApi(page, { fields: [fieldOf(1, 'Budget')] });
    await page.route(/\/api\/v1\/custom-fields\?/, (route) =>
      failing
        ? route.fulfill({
            status: 404,
            contentType: 'application/problem+json',
            json: { type: 'about:blank', title: 'Not Found', status: 404 },
          })
        : route.fallback(),
    );
    await page.goto(inHarbor('/settings/custom-fields'));
    await expect(page.getByRole('alert')).toContainText("The fields couldn't be loaded.");
    failing = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(fieldRow(page, 'Budget')).toBeVisible();
    expect(api.listed.length).toBeGreaterThan(0);
  });

  test('keeps the old fields and tags address working', async ({ page }) => {
    await fakeFieldsApi(page);
    await page.goto(inHarbor('/settings/fields-and-tags'));
    await expect(page).toHaveURL(inHarbor('/settings/custom-fields'));
    await expect(page.getByRole('heading', { level: 1, name: 'Custom Fields' })).toBeVisible();
    await expect(
      page.getByText('No fields yet. Add a field for the facts your team needs.'),
    ).toBeVisible();
  });
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeFieldsApi(page, { fields: [fieldOf(1, 'Budget')] });
    await page.goto(inHarbor('/settings/custom-fields'));
    await expect(fieldRow(page, 'Budget')).toBeVisible();
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'Fields and folders' })),
    ).toBe(true);
    expect(await reachesRightGutter(page, page.getByRole('group', { name: 'Object' }))).toBe(true);
  });
});
