// Marketing → Snippets, against a stand-in for the API that answers as the server does.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fakeSnippetsApi, snippetFolderOf, snippetOf } from './conversation-extras-fixtures';
import { reachesRightGutter } from './lists';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const snippetsTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Snippets table', exact: true }).getByRole('table');
const snippetRow = (page: Page, name: string): Locator =>
  snippetsTable(page).getByRole('row').filter({ hasText: name });
const notice = (page: Page): Locator => page.getByRole('main').locator('p.sr-only[role="status"]');
const range = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('status');

async function rowAction(row: Locator, name: string, action: string): Promise<void> {
  await row.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await row.page().getByRole('menuitem', { name: action, exact: true }).click();
}

const replies = snippetFolderOf(1, 'Quick replies');

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`adds a snippet in the panel, edits, duplicates, moves and deletes it at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeSnippetsApi(page, {
      folders: [{ ...replies }],
      snippets: [
        snippetOf(1, 'Directions', 'Park at the back, by the blue door.', {
          folderId: replies.id,
        }),
      ],
    });
    await page.goto(inHarbor('/marketing/snippets'));
    await expect(page.getByRole('heading', { level: 1, name: 'Snippets' })).toBeVisible();
    await expect(page).toHaveTitle('Snippets · Harbor Lights Events');
    // The page is a tab of Marketing.
    const tabs = page.getByRole('navigation', { name: 'Marketing', exact: true });
    await expect(tabs.getByRole('link')).toHaveText(['Emails', 'Snippets', 'Trigger Links']);
    await expect(tabs.getByRole('link', { name: 'Snippets', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(snippetRow(page, 'Directions')).toContainText('Park at the back');
    await expect(snippetRow(page, 'Directions')).toContainText('Quick replies');
    await expect(snippetRow(page, 'Directions')).toContainText('Text');

    const add = page.getByRole('button', { name: 'New snippet', exact: true });
    await add.click();
    const adding = page.getByRole('dialog', { name: 'New snippet', exact: true });
    const create = adding.getByRole('button', { name: 'Create snippet', exact: true });
    await expect(create).toBeDisabled();
    // An email has a subject; a text has none.
    await expect(adding.getByLabel('Subject', { exact: true })).toHaveCount(0);
    await choose(adding.getByLabel('Type', { exact: true }), 'email');
    await adding.getByLabel('Name', { exact: true }).fill('Welcome');
    await adding.getByLabel('Message', { exact: true }).fill('Hello, and welcome aboard.');
    await expect(create).toBeDisabled();
    await adding.getByLabel('Subject', { exact: true }).fill('Welcome aboard');
    await expect(create).toBeEnabled();
    await expect(adding.getByText('26 of 100000 characters')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    // The panel is at the right, as tall as the window.
    const box = await adding.boundingBox();
    expect(box === null ? 0 : box.x + box.width).toBeGreaterThanOrEqual(width - 20);
    expect(box?.height).toBeGreaterThanOrEqual(980);
    await create.click();
    await expect(notice(page)).toHaveText('Snippet created.');
    await expect(adding).toBeHidden();
    await expect(add).toBeFocused();
    expect(api.snippets.at(-1)).toMatchObject({
      type: 'email',
      name: 'Welcome',
      subject: 'Welcome aboard',
      body: 'Hello, and welcome aboard.',
      folderId: null,
    });
    const row = snippetRow(page, 'Welcome');
    await expect(row).toContainText('Welcome aboard: Hello, and welcome aboard.');
    await expect(row).toContainText('Email');

    // Editing reads the whole snippet, and keeps its type.
    await rowAction(row, 'Welcome', 'Edit');
    const editing = page.getByRole('dialog', { name: 'Edit snippet', exact: true });
    await expect(editing.getByLabel('Message', { exact: true })).toHaveValue(
      'Hello, and welcome aboard.',
    );
    await expect(editing.getByLabel('Type', { exact: true })).toBeDisabled();
    await editing.getByLabel('Message', { exact: true }).fill('Hello, and thank you for booking.');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Snippet saved.');
    await expect(row).toContainText('thank you for booking');
    await expect(
      row.getByRole('button', { name: 'Actions for Welcome', exact: true }),
    ).toBeFocused();

    await rowAction(row, 'Welcome', 'Duplicate');
    const copying = page.getByRole('dialog', { name: 'Duplicate snippet', exact: true });
    await expect(copying.getByLabel('Name', { exact: true })).toHaveValue('Copy of Welcome');
    await copying.getByRole('button', { name: 'Create snippet', exact: true }).click();
    await expect(notice(page)).toHaveText('Snippet created.');
    expect(api.snippets.at(-1)).toMatchObject({
      type: 'email',
      name: 'Copy of Welcome',
      subject: 'Welcome aboard',
      body: 'Hello, and thank you for booking.',
    });

    const copy = snippetRow(page, 'Copy of Welcome');
    await rowAction(copy, 'Copy of Welcome', 'Move to folder');
    const moving = page.getByRole('dialog', { name: 'Move to folder', exact: true });
    await expect(moving.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
    await choose(moving.getByLabel('Folder', { exact: true }), replies.id);
    await moving.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(notice(page)).toHaveText('Snippet moved.');
    await expect(copy).toContainText('Quick replies');
    expect(api.snippets.at(-1)?.folderId).toBe(replies.id);

    await rowAction(copy, 'Copy of Welcome', 'Delete');
    const deleting = page.getByRole('dialog', { name: 'Delete Copy of Welcome?', exact: true });
    await expect(deleting).toContainText('The snippet is deleted for good.');
    await expectNoAccessibilityViolations(page);
    await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(notice(page)).toHaveText('Snippet deleted.');
    await expect(copy).toHaveCount(0);
    expect(api.snippets).toHaveLength(2);

    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 360)
      for (const button of await snippetRow(page, 'Directions').getByRole('button').all())
        expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('snippets.png'), fullPage: true });
  });
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('adds, renames and deletes folders, and keeps the snippets of a deleted one', async ({
    page,
  }) => {
    const api = await fakeSnippetsApi(page, {
      folders: [{ ...replies }],
      snippets: [snippetOf(1, 'Directions', 'Park at the back.', { folderId: replies.id })],
    });
    await page.goto(inHarbor('/marketing/snippets'));
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const adding = page.getByRole('dialog', { name: 'New folder', exact: true });
    await expect(adding.getByRole('button', { name: 'Create folder', exact: true })).toBeDisabled();
    await adding.getByLabel('Folder name', { exact: true }).fill('Emails');
    await adding.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder created.');

    await page.getByRole('button', { name: 'Folders', exact: true }).click();
    const table = page.getByRole('region', { name: 'Folders table', exact: true });
    const folderRow = (name: string) => table.getByRole('row').filter({ hasText: name });
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(folderRow('Quick replies').getByRole('cell').first()).toHaveText('1');
    await expect(folderRow('Emails').getByRole('cell').first()).toHaveText('0');

    await rowAction(folderRow('Emails'), 'Emails', 'Rename');
    const renaming = page.getByRole('dialog', { name: 'Rename folder', exact: true });
    await renaming.getByLabel('Folder name', { exact: true }).fill('Email replies');
    await renaming.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder renamed.');
    await expect(folderRow('Email replies')).toBeVisible();

    await rowAction(folderRow('Quick replies'), 'Quick replies', 'Delete');
    const deleting = page.getByRole('dialog', {
      name: 'Delete the folder Quick replies?',
      exact: true,
    });
    await expect(deleting).toContainText('Its snippets are kept, in no folder.');
    await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder deleted.');
    await expect(folderRow('Quick replies')).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    expect(api.snippets[0]).toMatchObject({ name: 'Directions', folderId: null });

    await page.getByRole('button', { name: 'All snippets', exact: true }).click();
    await expect(snippetRow(page, 'Directions')).toBeVisible();
    await expect(snippetRow(page, 'Directions')).not.toContainText('Quick replies');
  });

  test('ticks snippets to move and delete them together', async ({ page }) => {
    const api = await fakeSnippetsApi(page, {
      folders: [{ ...replies }],
      snippets: [
        snippetOf(1, 'Directions', 'Park at the back.'),
        snippetOf(2, 'Hours', 'We open at {{custom_values.opening_time}}.'),
        snippetOf(3, 'Parking', 'Free after six.'),
      ],
    });
    await page.goto(inHarbor('/marketing/snippets'));
    // A merge field in a body shows as one.
    await expect(
      snippetRow(page, 'Hours').locator('code', { hasText: '{{custom_values.opening_time}}' }),
    ).toBeVisible();
    const bar = page.getByRole('group', { name: 'Selected snippets', exact: true });
    await expect(bar).toHaveCount(0);
    const all = page.getByRole('checkbox', { name: 'Select every snippet on this page' });
    await page.getByRole('checkbox', { name: 'Select Directions', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select Hours', exact: true }).check();
    await expect(bar).toContainText('2 selected');
    expect(await all.evaluate((box: HTMLInputElement) => box.indeterminate)).toBe(true);
    await expectNoAccessibilityViolations(page);

    await bar.getByRole('button', { name: 'Move to folder', exact: true }).click();
    const moving = page.getByRole('dialog', { name: 'Move to folder', exact: true });
    await expect(moving).toContainText('2 snippets');
    await choose(moving.getByLabel('Folder', { exact: true }), replies.id);
    await moving.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(notice(page)).toHaveText('2 snippets moved.');
    await expect(snippetRow(page, 'Directions')).toContainText('Quick replies');
    await expect(snippetRow(page, 'Hours')).toContainText('Quick replies');
    await expect(snippetRow(page, 'Parking')).not.toContainText('Quick replies');
    expect(api.snippets.map((snippet) => snippet.folderId)).toEqual([replies.id, replies.id, null]);
    // Done with, so no longer ticked.
    await expect(bar).toHaveCount(0);

    await all.check();
    await expect(bar).toContainText('3 selected');
    await page.getByRole('checkbox', { name: 'Select Parking', exact: true }).uncheck();
    await bar.getByRole('button', { name: 'Delete', exact: true }).click();
    const deleting = page.getByRole('dialog', { name: 'Delete 2 snippets?', exact: true });
    await expect(deleting).toContainText('The snippets are deleted for good.');
    await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(notice(page)).toHaveText('2 snippets deleted.');
    expect(api.snippets.map((snippet) => snippet.name)).toEqual(['Parking']);
    await expect(snippetsTable(page).getByRole('row')).toHaveCount(2);
    await expect(bar).toHaveCount(0);
  });

  test('searches, filters by type and folder, and pages the list on the server', async ({
    page,
  }) => {
    const snippets = Array.from({ length: 23 }, (_, at) =>
      snippetOf(at + 1, `Snippet ${String(at + 1).padStart(2, '0')}`, at === 4 ? 'needle' : 'hay', {
        folderId: at < 2 ? replies.id : null,
        ...(at < 3 ? { type: 'email' as const, subject: 'Hello' } : {}),
      }),
    );
    const api = await fakeSnippetsApi(page, { folders: [{ ...replies }], snippets });
    await page.goto(inHarbor('/marketing/snippets'));
    await expect(range(page)).toHaveText('1 - 20 of 23');
    const previous = page.getByRole('button', { name: 'Previous page', exact: true });
    const next = page.getByRole('button', { name: 'Next page', exact: true });
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(range(page)).toHaveText('21 - 23 of 23');
    await expect(snippetsTable(page).getByRole('row')).toHaveCount(4);
    await expect(next).toBeDisabled();
    expect(api.listed.at(-1)?.get('after')).toBe(snippets[19]?.id);
    await previous.click();
    await expect(range(page)).toHaveText('1 - 20 of 23');
    await choose(page.getByLabel('Rows per page', { exact: true }), '10');
    await expect(range(page)).toHaveText('1 - 10 of 23');
    expect(api.listed.at(-1)?.get('limit')).toBe('10');

    // By any part of the name, the subject or the body.
    const search = page.getByRole('searchbox', { name: 'Search snippets', exact: true });
    await search.fill('needle');
    await expect(range(page)).toHaveText('1 - 1 of 1');
    await expect(snippetRow(page, 'Snippet 05')).toBeVisible();
    expect(api.listed.at(-1)?.get('q')).toBe('needle');
    await search.fill('nothing here');
    await expect(page.getByText('No snippets match.', { exact: true })).toBeVisible();
    await search.fill('');
    await expect(range(page)).toHaveText('1 - 10 of 23');

    await choose(page.getByLabel('Type', { exact: true }), 'email');
    await expect(range(page)).toHaveText('1 - 3 of 3');
    expect(api.listed.at(-1)?.get('type')).toBe('email');
    await choose(page.getByLabel('Folder', { exact: true }), replies.id);
    await expect(range(page)).toHaveText('1 - 2 of 2');
    expect(api.listed.at(-1)?.get('folder')).toBe(replies.id);
    await choose(page.getByLabel('Type', { exact: true }), 'any');
    await choose(page.getByLabel('Folder', { exact: true }), 'none');
    await expect(range(page)).toHaveText('1 - 10 of 21');
    expect(api.listed.at(-1)?.get('folder')).toBe('none');
    expect(api.listed.at(-1)?.has('type')).toBe(false);
  });

  test('offers the saved version when someone else changed the snippet first', async ({ page }) => {
    const api = await fakeSnippetsApi(page, {
      snippets: [snippetOf(1, 'Directions', 'Park at the back.')],
    });
    await page.goto(inHarbor('/marketing/snippets'));
    await rowAction(snippetRow(page, 'Directions'), 'Directions', 'Edit');
    const editing = page.getByRole('dialog', { name: 'Edit snippet', exact: true });
    await editing.getByLabel('Message', { exact: true }).fill('Park out front.');
    api.staleNext = true;
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(editing.getByRole('alert')).toContainText('Someone else changed this snippet.');
    await editing.getByRole('button', { name: 'Reload saved version', exact: true }).click();
    await expect(editing.getByLabel('Message', { exact: true })).toHaveValue(
      'Park at the back. (theirs)',
    );
    await editing.getByLabel('Message', { exact: true }).fill('Park out front.');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Snippet saved.');
    expect(api.snippets[0]?.body).toBe('Park out front.');
  });

  test('is read-only for someone who may not manage templates', async ({ page }) => {
    const api = await fakeSnippetsApi(page, {
      snippets: [snippetOf(1, 'Directions', 'Park at the back.')],
    });
    api.canManage = false;
    await page.goto(inHarbor('/marketing/snippets'));
    await expect(snippetRow(page, 'Directions')).toContainText('Park at the back.');
    await expect(
      page.getByText('You can read snippets. Changing them needs permission to manage templates.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'New snippet', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0);
    await expect(snippetRow(page, 'Directions').getByRole('button')).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
  });

  test('says so when there are none yet', async ({ page }) => {
    await fakeSnippetsApi(page);
    await page.goto(inHarbor('/marketing/snippets'));
    await expect(
      page.getByText('No snippets yet. Add one to keep a message you write often.'),
    ).toBeVisible();
    await expect(range(page)).toHaveText('0 - 0 of 0');
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
    await expect(
      page.getByText('No folders yet. Folders keep related snippets together.'),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeSnippetsApi(page, { snippets: [snippetOf(1, 'Directions', 'Park at the back.')] });
    await page.goto(inHarbor('/marketing/snippets'));
    await expect(snippetRow(page, 'Directions')).toBeVisible();
    expect(
      await reachesRightGutter(
        page,
        page.getByRole('region', { name: 'All snippets', exact: true }),
      ),
    ).toBe(true);
  });
});
