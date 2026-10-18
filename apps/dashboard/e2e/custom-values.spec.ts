import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { reachesRightGutter } from './lists';
import { choose } from './select';
import { inHarbor, signedIn } from './session';
import { fakeValuesApi, valueFolderOf, valueOf } from './settings-fixtures';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const valuesTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Custom values table', exact: true }).getByRole('table');
const valueRow = (page: Page, name: string): Locator =>
  valuesTable(page).getByRole('row').filter({ hasText: name });
const notice = (page: Page): Locator => page.getByRole('main').locator('p.sr-only[role="status"]');
const range = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('status');

async function rowAction(row: Locator, name: string, action: string): Promise<void> {
  await row.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await row.page().getByRole('menuitem', { name: action, exact: true }).click();
}

const pricing = valueFolderOf(1, 'Fence pricing');

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`adds a custom value, copies its key, edits, moves and deletes it at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeValuesApi(page, {
      folders: [{ ...pricing }],
      values: [valueOf(1, 'Vinyl price per foot', '65', pricing)],
    });
    await page.goto(inHarbor('/settings/custom-values'));
    await expect(page.getByRole('heading', { level: 1, name: 'Custom Values' })).toBeVisible();
    await expect(page).toHaveTitle('Custom Values · Harbor Lights Events');
    await expect(valueRow(page, 'Vinyl price per foot')).toContainText(
      '{{custom_values.vinyl_price_per_foot}}',
    );
    await expect(valueRow(page, 'Vinyl price per foot')).toContainText('Fence pricing');

    const add = page.getByRole('button', { name: 'Add custom value', exact: true });
    await add.click();
    const adding = page.getByRole('dialog', { name: 'Add custom value', exact: true });
    const create = adding.getByRole('button', { name: 'Create', exact: true });
    // Only the name is required.
    await expect(create).toBeDisabled();
    await adding.getByLabel('Name', { exact: true }).fill('Hours of operation');
    await expect(adding.getByText('{{custom_values.hours_of_operation}}')).toBeVisible();
    await expect(create).toBeEnabled();
    await adding.getByLabel('Value', { exact: true }).fill('Mon to Fri, 8 AM to 5 PM');
    await expectNoAccessibilityViolations(page);
    await create.click();
    await expect(notice(page)).toHaveText('Custom value created.');
    await expect(adding).toBeHidden();
    await expect(add).toBeFocused();
    expect(api.values.at(-1)).toMatchObject({
      name: 'Hours of operation',
      key: 'hours_of_operation',
      value: 'Mon to Fri, 8 AM to 5 PM',
      folderId: null,
    });

    const row = valueRow(page, 'Hours of operation');
    await expect(row).toContainText('Mon to Fri, 8 AM to 5 PM');
    await row
      .getByRole('button', { name: 'Copy {{custom_values.hours_of_operation}}', exact: true })
      .click();
    await expect(notice(page)).toHaveText('Copied {{custom_values.hours_of_operation}}');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '{{custom_values.hours_of_operation}}',
    );

    // Renaming a value keeps its key.
    await rowAction(row, 'Hours of operation', 'Edit');
    const editing = page.getByRole('dialog', { name: 'Edit custom value', exact: true });
    await editing.getByLabel('Name', { exact: true }).fill('Opening hours');
    await editing.getByLabel('Value', { exact: true }).fill('Every day, 9 to 5');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Custom value saved.');
    const renamed = valueRow(page, 'Opening hours');
    await expect(renamed).toContainText('{{custom_values.hours_of_operation}}');
    await expect(renamed).toContainText('Every day, 9 to 5');
    await expect(
      renamed.getByRole('button', { name: 'Actions for Opening hours', exact: true }),
    ).toBeFocused();

    await rowAction(renamed, 'Opening hours', 'Move to folder');
    const moving = page.getByRole('dialog', { name: 'Move to folder', exact: true });
    await expect(moving.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
    await choose(moving.getByLabel('Folder', { exact: true }), pricing.id);
    await moving.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(notice(page)).toHaveText('Custom value moved.');
    await expect(renamed).toContainText('Fence pricing');
    expect(api.values.at(-1)?.folderId).toBe(pricing.id);

    await rowAction(renamed, 'Opening hours', 'Delete');
    const deleting = page.getByRole('dialog', { name: 'Delete Opening hours?', exact: true });
    await expect(deleting).toContainText(
      'A message that still uses {{custom_values.hours_of_operation}} is not sent',
    );
    await expectNoAccessibilityViolations(page);
    await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(notice(page)).toHaveText('Custom value deleted.');
    await expect(renamed).toHaveCount(0);
    expect(api.values).toHaveLength(1);

    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 360)
      for (const button of await valueRow(page, 'Vinyl price per foot').getByRole('button').all())
        expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('custom-values.png'), fullPage: true });
  });
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('adds, renames and deletes folders, and keeps the values of a deleted one', async ({
    page,
  }) => {
    const api = await fakeValuesApi(page, {
      folders: [{ ...pricing }],
      values: [valueOf(1, 'Vinyl price per foot', '65', pricing)],
    });
    await page.goto(inHarbor('/settings/custom-values'));
    await page.getByRole('button', { name: 'Add folder', exact: true }).click();
    const adding = page.getByRole('dialog', { name: 'Add folder', exact: true });
    await expect(adding.getByRole('button', { name: 'Create folder', exact: true })).toBeDisabled();
    await adding.getByLabel('Folder name', { exact: true }).fill('Links');
    await adding.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder created.');

    await page.getByRole('button', { name: 'Folders', exact: true }).click();
    const table = page.getByRole('region', { name: 'Folders table', exact: true });
    const folderRow = (name: string) => table.getByRole('row').filter({ hasText: name });
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(folderRow('Fence pricing').getByRole('cell').first()).toHaveText('1');
    await expect(folderRow('Links').getByRole('cell').first()).toHaveText('0');

    await rowAction(folderRow('Links'), 'Links', 'Rename');
    const renaming = page.getByRole('dialog', { name: 'Rename folder', exact: true });
    await renaming.getByLabel('Folder name', { exact: true }).fill('Booking links');
    await renaming.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder renamed.');
    await expect(folderRow('Booking links')).toBeVisible();

    await rowAction(folderRow('Fence pricing'), 'Fence pricing', 'Delete');
    const deleting = page.getByRole('dialog', {
      name: 'Delete the folder Fence pricing?',
      exact: true,
    });
    await expect(deleting).toContainText('Its custom values are kept, in no folder.');
    await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder deleted.');
    await expect(folderRow('Fence pricing')).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    expect(api.values[0]).toMatchObject({ name: 'Vinyl price per foot', folderId: null });

    await page.getByRole('button', { name: 'All values', exact: true }).click();
    await expect(valueRow(page, 'Vinyl price per foot')).toBeVisible();
    await expect(valueRow(page, 'Vinyl price per foot')).not.toContainText('Fence pricing');
  });

  test('searches, filters by folder and pages the list on the server', async ({ page }) => {
    const values = Array.from({ length: 23 }, (_, at) =>
      valueOf(
        at + 1,
        `Value ${String(at + 1).padStart(2, '0')}`,
        at === 4 ? 'needle' : 'hay',
        at < 2 ? pricing : null,
      ),
    );
    const api = await fakeValuesApi(page, { folders: [{ ...pricing }], values });
    await page.goto(inHarbor('/settings/custom-values'));
    await expect(range(page)).toHaveText('1 - 20 of 23');
    const previous = page.getByRole('button', { name: 'Previous page', exact: true });
    const next = page.getByRole('button', { name: 'Next page', exact: true });
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(range(page)).toHaveText('21 - 23 of 23');
    await expect(valuesTable(page).getByRole('row')).toHaveCount(4);
    await expect(next).toBeDisabled();
    expect(api.listed.at(-1)?.get('after')).toBe(values[19]?.id);
    await previous.click();
    await expect(range(page)).toHaveText('1 - 20 of 23');
    await choose(page.getByLabel('Rows per page', { exact: true }), '10');
    await expect(range(page)).toHaveText('1 - 10 of 23');
    expect(api.listed.at(-1)?.get('limit')).toBe('10');

    // By any part of the name, the key or the text.
    await page.getByRole('searchbox', { name: 'Search values', exact: true }).fill('needle');
    await expect(range(page)).toHaveText('1 - 1 of 1');
    await expect(valueRow(page, 'Value 05')).toBeVisible();
    expect(api.listed.at(-1)?.get('q')).toBe('needle');
    await page.getByRole('searchbox', { name: 'Search values', exact: true }).fill('nothing here');
    await expect(page.getByText('No custom values match.', { exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search values', exact: true }).fill('');
    await expect(range(page)).toHaveText('1 - 10 of 23');

    await choose(page.getByLabel('Folder', { exact: true }), pricing.id);
    await expect(range(page)).toHaveText('1 - 2 of 2');
    expect(api.listed.at(-1)?.get('folder')).toBe(pricing.id);
    await choose(page.getByLabel('Folder', { exact: true }), 'none');
    await expect(range(page)).toHaveText('1 - 10 of 21');
    expect(api.listed.at(-1)?.get('folder')).toBe('none');
  });

  test('offers the saved version when someone else changed the value first', async ({ page }) => {
    const api = await fakeValuesApi(page, { values: [valueOf(1, 'Deposit percent', '25')] });
    await page.goto(inHarbor('/settings/custom-values'));
    await rowAction(valueRow(page, 'Deposit percent'), 'Deposit percent', 'Edit');
    const editing = page.getByRole('dialog', { name: 'Edit custom value', exact: true });
    await editing.getByLabel('Value', { exact: true }).fill('30');
    api.staleNext = true;
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(editing.getByRole('alert')).toContainText('Someone else changed this value.');
    await editing.getByRole('button', { name: 'Reload saved version', exact: true }).click();
    await expect(editing.getByLabel('Value', { exact: true })).toHaveValue('25 (theirs)');
    await editing.getByLabel('Value', { exact: true }).fill('30');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Custom value saved.');
    expect(api.values[0]?.value).toBe('30');
  });

  test('is read-only for someone who may not manage templates', async ({ page }) => {
    const api = await fakeValuesApi(page, { values: [valueOf(1, 'Deposit percent', '25')] });
    api.canManage = false;
    await page.goto(inHarbor('/settings/custom-values'));
    await expect(valueRow(page, 'Deposit percent')).toContainText(
      '{{custom_values.deposit_percent}}',
    );
    await expect(
      page.getByText(
        'You can read custom values. Changing them needs permission to manage templates.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add custom value', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Add folder', exact: true })).toHaveCount(0);
    // The key can still be copied; nothing else can be pressed.
    await expect(valueRow(page, 'Deposit percent').getByRole('button')).toHaveCount(1);
    await expectNoAccessibilityViolations(page);
  });

  test('says so when there are none yet', async ({ page }) => {
    await fakeValuesApi(page);
    await page.goto(inHarbor('/settings/custom-values'));
    await expect(
      page.getByText('No custom values yet. Add one to use it in your messages.'),
    ).toBeVisible();
    await expect(range(page)).toHaveText('0 - 0 of 0');
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
    await expect(
      page.getByText('No folders yet. Folders keep related custom values together.'),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeValuesApi(page, { values: [valueOf(1, 'Deposit percent', '25')] });
    await page.goto(inHarbor('/settings/custom-values'));
    await expect(valueRow(page, 'Deposit percent')).toBeVisible();
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'All values', exact: true })),
    ).toBe(true);
  });
});
