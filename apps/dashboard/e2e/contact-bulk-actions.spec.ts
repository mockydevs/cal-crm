// Contacts → Bulk Actions, against a stand-in for the API that answers as the server does.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { bulkActionOf, bulkItemOf, fakeContactBulkApi } from './contact-bulk-fixtures';
import { reachesRightGutter } from './lists';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const card = (page: Page): Locator =>
  page.getByRole('region', { name: 'Bulk actions', exact: true });
const actionsTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Bulk actions table', exact: true }).getByRole('table');
const actionRow = (page: Page, label: string): Locator =>
  actionsTable(page).getByRole('row').filter({ hasText: label });
// The page is inert while the panel is open, so this is found by its place, not its role.
const notice = (page: Page): Locator => page.locator('main p.sr-only[role="status"]');
const pageStatus = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('status');

const tagged = (): ReturnType<typeof bulkActionOf> =>
  bulkActionOf(1, { name: 'Tag trade fair leads' });
const reassigning = (): ReturnType<typeof bulkActionOf> =>
  bulkActionOf(2, {
    name: 'Give the north region to Eli',
    action: 'assign_owner',
    status: 'running',
    requested: 250,
    done: 100,
    unchanged: 0,
    skipped: 0,
    finishedAt: null,
    canCancel: true,
    actor: { kind: 'user', name: 'Eli Frost', you: false },
  });

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`lists the actions, shows what became of each contact, and stops one at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const first = tagged();
    const api = await fakeContactBulkApi(page, {
      actions: [first, reassigning()],
      contacts: {
        [first.id]: [
          bulkItemOf(1, 'Mara Ellison', 'done'),
          bulkItemOf(2, 'Theo Varga', 'done'),
          bulkItemOf(3, null, 'skipped', {
            code: 'not_found',
            message: 'This contact no longer exists.',
          }),
        ],
      },
    });
    await page.goto(inHarbor('/contacts/bulk-actions'));
    await expect(page.getByRole('heading', { level: 1, name: 'Bulk actions' })).toBeVisible();
    await expect(page).toHaveTitle('Bulk actions · Harbor Lights Events');
    await expect(
      page
        .getByRole('navigation', { name: 'Contacts', exact: true })
        .getByRole('link', { name: 'Bulk Actions', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    // Newest first: the action still going is above the one that ended.
    const rows = actionsTable(page).getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('Give the north region to Eli');
    const going = actionRow(page, 'Give the north region to Eli');
    await expect(going).toContainText('Assign owner');
    await expect(going).toContainText('Processing');
    await expect(going).toContainText('100 of 250');
    await expect(going).toContainText('Eli Frost');
    await expect(going).toContainText('Not yet');
    const ended = actionRow(page, 'Tag trade fair leads');
    await expect(ended).toContainText('Add tag');
    await expect(ended).toContainText('Complete');
    await expect(ended).toContainText('Dana Brooks (you)');
    await expect(ended.getByRole('button', { name: 'Stop Tag trade fair leads' })).toHaveCount(0);
    await expect(pageStatus(page)).toHaveText('Page 1');
    await expectNoAccessibilityViolations(page);

    // What became of each contact, and why the skipped one was skipped.
    await page.getByRole('button', { name: 'Show stats for Tag trade fair leads' }).click();
    const stats = page.getByRole('dialog', { name: 'Bulk action stats', exact: true });
    await expect(stats).toContainText('Tag trade fair leads');
    const contacts = stats
      .getByRole('region', { name: 'Contacts in this action', exact: true })
      .getByRole('row');
    await expect(contacts).toHaveCount(4);
    await expect(stats.getByRole('link', { name: 'Mara Ellison', exact: true })).toBeVisible();
    await expect(contacts.nth(3)).toContainText('Contact not found');
    await expect(contacts.nth(3)).toContainText('Skipped');
    await expect(contacts.nth(3)).toContainText('This contact no longer exists.');
    await expect(stats.getByRole('link', { name: 'Contact not found' })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);

    await choose(stats.getByLabel('Show', { exact: true }), 'skipped');
    await expect(contacts).toHaveCount(2);
    expect(api.itemsListed.at(-1)?.get('outcome')).toBe('skipped');
    await stats.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(stats).toBeHidden();

    // Stopping the one still going: the server's answer is what the row then shows.
    await page.getByRole('button', { name: 'Stop Give the north region to Eli' }).click();
    await expect(notice(page)).toHaveText('Action stopped. What was already done stays done.');
    await expect(going).toContainText('Cancelled');
    await expect(
      going.getByRole('button', { name: 'Stop Give the north region to Eli' }),
    ).toHaveCount(0);
    expect(api.cancelled).toEqual([reassigning().id]);
  });
}

test('filters on the server and pages with its cursor', async ({ page }) => {
  const many = Array.from({ length: 23 }, (_, index) =>
    bulkActionOf(index + 1, { name: `Action ${String(index + 1).padStart(2, '0')}` }),
  );
  const api = await fakeContactBulkApi(page, {
    actions: [...many, bulkActionOf(40, { name: 'Clear out duplicates', action: 'trash' })],
  });
  await page.goto(inHarbor('/contacts/bulk-actions'));
  await expect(actionsTable(page).getByRole('row')).toHaveCount(21);
  await expect(pageStatus(page)).toHaveText('Page 1');
  const pages = page.getByRole('navigation', { name: 'Pages', exact: true });
  await expect(pages.getByRole('button', { name: 'Previous page' })).toBeDisabled();

  await pages.getByRole('button', { name: 'Next page' }).click();
  await expect(pageStatus(page)).toHaveText('Page 2');
  await expect(actionsTable(page).getByRole('row')).toHaveCount(5);
  await expect(pages.getByRole('button', { name: 'Next page' })).toBeDisabled();
  expect(api.listed.at(-1)?.get('after')).not.toBeNull();
  await pages.getByRole('button', { name: 'Previous page' }).click();
  await expect(pageStatus(page)).toHaveText('Page 1');

  await choose(card(page).getByLabel('Action', { exact: true }), 'trash');
  await expect(actionsTable(page).getByRole('row')).toHaveCount(2);
  await expect(actionRow(page, 'Clear out duplicates')).toContainText('Move to trash');
  expect(api.listed.at(-1)?.get('action')).toBe('trash');

  await choose(card(page).getByLabel('Status', { exact: true }), 'queued');
  await expect(page.getByText('No bulk actions match.', { exact: true })).toBeVisible();
  expect(api.listed.at(-1)?.get('status')).toBe('queued');
});

test('says so when there are none yet', async ({ page }) => {
  await fakeContactBulkApi(page);
  await page.goto(inHarbor('/contacts/bulk-actions'));
  await expect(
    page.getByText('No bulk actions yet. Select contacts in a smart list to change many at once.', {
      exact: true,
    }),
  ).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test('says what is needed when the server refuses the list', async ({ page }) => {
  const api = await fakeContactBulkApi(page, { actions: [tagged()] });
  api.refused = true;
  await page.goto(inHarbor('/contacts/bulk-actions'));
  await expect(
    page.getByText('Seeing the bulk actions needs permission to manage contacts.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('downloads an export, and says when the next batch of a drip runs and why one failed', async ({
  page,
}) => {
  const exported = bulkActionOf(3, {
    name: 'Fair leads',
    action: 'export',
    file: { filename: 'Fair_leads_2026-10-01.csv', size: 1024 },
  });
  const dripping = bulkActionOf(4, {
    name: 'Saturday texts',
    action: 'send_sms',
    status: 'running',
    requested: 250,
    done: 100,
    unchanged: 0,
    skipped: 0,
    finishedAt: null,
    canCancel: true,
    drip: { batchSize: 100, intervalMinutes: 60 },
    nextBatchAt: '2026-10-01T11:04:00.000Z',
  });
  const failed = bulkActionOf(5, {
    name: 'Everything',
    action: 'export',
    status: 'failed',
    failure: {
      code: 'file_too_large',
      message: 'The file is larger than this install keeps. Export fewer contacts or columns.',
    },
  });
  const api = await fakeContactBulkApi(page, { actions: [exported, dripping, failed] });
  await page.route('**/api/v1/files/file_export/content?signature=x', (route) =>
    route.fulfill({
      body: '"Contact Name"\n"Maya Thompson"\n',
      headers: {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="Fair_leads_2026-10-01.csv"',
      },
    }),
  );
  await page.goto(inHarbor('/contacts/bulk-actions'));

  await expect(actionRow(page, 'Saturday texts')).toContainText('SMS');
  await expect(actionRow(page, 'Saturday texts')).toContainText('Next batch');
  await expect(actionRow(page, 'Everything')).toContainText('Failed');
  await expect(actionRow(page, 'Everything')).toContainText(
    'The file is larger than this install keeps.',
  );
  await expect(actionRow(page, 'Everything').getByRole('button', { name: /Download/ })).toHaveCount(
    0,
  );
  await expectNoAccessibilityViolations(page);

  const saved = page.waitForEvent('download');
  await actionRow(page, 'Fair leads')
    .getByRole('button', { name: 'Download Fair_leads_2026-10-01.csv' })
    .click();
  expect((await saved).suggestedFilename()).toBe('Fair_leads_2026-10-01.csv');
  expect(api.linked).toEqual([exported.id]);
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeContactBulkApi(page, { actions: [tagged()] });
    await page.goto(inHarbor('/contacts/bulk-actions'));
    await expect(actionRow(page, 'Tag trade fair leads')).toBeVisible();
    expect(await reachesRightGutter(page, card(page))).toBe(true);
  });
});
