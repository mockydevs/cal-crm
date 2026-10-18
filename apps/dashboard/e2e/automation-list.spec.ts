// The Workflows list and the Overview tab of Automation. The API is stood in for by the
// in-memory one in automation-api.ts, which lists, files, deletes and restores as the
// server does.
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  automationsApi,
  builderAt,
  expectNoSidewaysScroll,
  expectNoViolations,
  published,
  world,
} from './automation-api';
import { automationId, automationOf, folderIds, folderOf } from './automation-fixtures';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

const winBackId = 'aut_01k8e2wzr0e008000000000012';
const birthdayId = 'aut_01k8e2wzr0e008000000000013';

const three = () => [
  automationOf({
    ...published(4),
    lastRunAt: '2026-10-08T14:30:00.000Z',
    totalEnrolled: 1204,
    activeEnrolled: 37,
  }),
  automationOf({ id: winBackId, name: 'Win back', ...published(1), status: 'paused' }),
  automationOf({ id: birthdayId, name: 'Birthday note' }),
];

const table = (page: Page): Locator => page.getByRole('table', { name: 'Workflows', exact: true });
const row = (page: Page, name: string): Locator =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
const workflow = (page: Page, name: string): Locator =>
  page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
const notice = (page: Page): Locator => page.getByRole('main').getByRole('status');

async function act(page: Page, menu: string, action: string): Promise<void> {
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test.describe('the workflows list', () => {
  test('lists each workflow with its status, what it enrolled and when it changed', async ({
    page,
  }) => {
    const state = world({ automations: three() });
    await signedIn(page);
    await automationsApi(page, state);
    await page.goto(inHarbor('/automations'));
    await expect(page.getByRole('heading', { level: 1, name: 'Workflows list' })).toBeVisible();
    // The top bar names the module, with its pages as tabs.
    const tabs = page.getByRole('navigation', { name: 'Automation', exact: true });
    await expect(tabs.getByRole('link', { name: 'Workflows', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(tabs.getByRole('link')).toHaveText(['Workflows', 'Overview']);

    await expect(table(page).getByRole('columnheader')).toHaveText([
      'Name',
      'Status',
      'Total enrolled',
      'Active enrolled',
      'Last updated',
      'Created on',
      'Stats',
      'Actions',
    ]);
    const first = workflow(page, 'New lead follow-up');
    await expect(first.getByRole('cell').nth(0)).toHaveText('Published');
    await expect(first.getByRole('cell').nth(1)).toHaveText('1,204');
    await expect(first.getByRole('cell').nth(2)).toHaveText('37');
    await expect(first.getByRole('cell').nth(3)).toContainText('2026');
    await expect(workflow(page, 'Win back').getByRole('cell').nth(0)).toHaveText('Paused');
    await expect(workflow(page, 'Birthday note').getByRole('cell').nth(0)).toHaveText('Draft');
    // Published is the outlined green pill; the others are neutral.
    const pill = first.getByText('Published', { exact: true });
    await expect(pill).toHaveCSS('color', 'rgb(2, 122, 72)');
    await expect(pill).toHaveCSS('border-top-color', 'rgb(108, 233, 166)');
    expect(state.listQueries).toEqual(['folder=root']);
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);

    await expect(
      first.getByRole('link', { name: 'Open New lead follow-up in a new tab', exact: true }),
    ).toHaveAttribute('target', '_blank');
    await first.getByRole('link', { name: 'New lead follow-up', exact: true }).click();
    await expect(page).toHaveURL(builderAt());
  });

  test('says when there are none, and creates the first: named, then opened in the builder', async ({
    page,
  }) => {
    const state = world({ automations: [] });
    await signedIn(page);
    await automationsApi(page, state);
    await page.goto(inHarbor('/automations'));
    await expect(
      page.getByRole('heading', { name: 'No workflows yet', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
    await expect(page).toHaveURL(builderAt());
    expect(state.writes).toEqual([
      {
        method: 'POST',
        path: '',
        body: {
          document: {
            name: expect.stringMatching(/^New Workflow : \d+$/),
            triggers: [],
            steps: {},
          },
        },
      },
    ]);
  });

  test('says when the workflows fail to load, never that there are none, and offers no changes without permission', async ({
    page,
  }) => {
    await signedIn(page);
    let failing = true;
    await page.route('**/api/v1/automation-folders**', (route) =>
      route.fulfill({ json: { items: [], canManage: false } }),
    );
    await page.route('**/api/v1/automations**', (route) =>
      failing
        ? route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            json: { type: 'about:blank', title: 'Service Unavailable', status: 503 },
          })
        : route.fulfill({ json: { items: [], nextCursor: null, canManage: false } }),
    );
    await page.goto(inHarbor('/automations'));
    await expect(page.getByRole('alert')).toContainText("We couldn't load the workflows.", {
      timeout: 20_000,
    });
    await expect(page.getByRole('heading', { name: 'No workflows yet', exact: true })).toHaveCount(
      0,
    );
    await expectNoViolations(page);
    failing = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'No workflows yet', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create workflow', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create folder', exact: true })).toHaveCount(0);
  });

  test('narrows by status and by name, wherever a workflow is filed', async ({ page }) => {
    const state = world({
      automations: [
        ...three().slice(0, 2),
        automationOf({ id: birthdayId, name: 'Birthday note', folderId: folderIds.leads }),
      ],
      folders: [folderOf(folderIds.leads, 'Leads')],
    });
    await signedIn(page);
    await automationsApi(page, state);
    await page.goto(inHarbor('/automations'));
    await expect(table(page).getByRole('rowheader')).toHaveText([
      'Leads',
      'New lead follow-up',
      'Win back',
    ]);
    await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'draft');
    await expect(table(page).getByRole('rowheader')).toHaveText(['Birthday note']);
    expect(state.listQueries.at(-1)).toBe('status=draft');
    await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'any');
    await page.getByRole('searchbox', { name: 'Search workflows', exact: true }).fill('win');
    await expect(table(page).getByRole('rowheader')).toHaveText(['Win back']);
    expect(state.listQueries.at(-1)).toBe('q=win');
    await page.getByRole('searchbox', { name: 'Search workflows', exact: true }).fill('nothing');
    await expect(page.getByText('No workflows match.', { exact: true })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('folders', () => {
  test('creates a folder, files a workflow in it, and walks in and back out', async ({ page }) => {
    const state = world({ automations: three() });
    await signedIn(page);
    await automationsApi(page, state);
    await page.goto(inHarbor('/automations'));
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const naming = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await naming.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(naming.getByRole('alert')).toHaveText('Give it a name.');
    await expectNoViolations(page);
    await naming.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Leads');
    await naming.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(naming).toHaveCount(0);
    await expect(notice(page)).toHaveText('Folder created.');
    // The keyboard is back on the button that opened the dialog.
    await expect(page.getByRole('button', { name: 'Create folder', exact: true })).toBeFocused();
    await expect(table(page).getByRole('rowheader').first()).toHaveText('Leads');
    const folderId = state.folders[0]?.id ?? '';

    await act(page, 'Actions for Win back', 'Move to folder');
    const moving = page.getByRole('dialog', { name: 'Move to folder', exact: true });
    await choose(moving.getByRole('combobox', { name: 'Folder', exact: true }), folderId);
    await expectNoViolations(page);
    await moving.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(notice(page)).toHaveText('Workflow moved.');
    await expect(workflow(page, 'Win back')).toHaveCount(0);
    expect(state.writes.at(-1)).toEqual({
      method: 'PUT',
      path: `/${winBackId}/folder`,
      body: { folderId },
    });

    await page.getByRole('link', { name: 'Open the folder Leads', exact: true }).click();
    await expect(page).toHaveURL(inHarbor(`/automations?folder=${folderId}`));
    await expect(table(page).getByRole('rowheader')).toHaveText(['Win back']);
    const crumbs = page.getByRole('navigation', { name: 'Folders', exact: true });
    await expect(crumbs.getByText('Leads', { exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);

    // A workflow made here is filed here.
    await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
    await expect(page).toHaveURL(/automation=aut_/);
    expect(state.writes.at(-1)).toMatchObject({ method: 'PUT', body: { folderId } });
    await page.goBack();
    await expect(table(page).getByRole('rowheader')).toHaveCount(2);

    await crumbs.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/automations'));
    await expect(table(page).getByRole('rowheader')).toHaveText([
      'Leads',
      'New lead follow-up',
      'Birthday note',
    ]);
  });

  test('renames a folder, refuses a name already used there, and deletes one without deleting what is in it', async ({
    page,
  }) => {
    const state = world({
      automations: [automationOf({ folderId: folderIds.leads })],
      folders: [folderOf(folderIds.leads, 'Leads'), folderOf(folderIds.weddings, 'Weddings')],
    });
    await signedIn(page);
    await automationsApi(page, state);
    await page.goto(inHarbor('/automations'));
    await act(page, 'Actions for the folder Leads', 'Rename');
    const naming = page.getByRole('dialog', { name: 'Rename folder', exact: true });
    const name = naming.getByRole('textbox', { name: 'Folder name', exact: true });
    await expect(name).toHaveValue('Leads');
    await name.fill('weddings');
    await naming.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(naming.getByRole('alert')).toHaveText(
      'Another folder here already has that name.',
    );
    await name.fill('Prospects');
    await naming.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder renamed.');
    await expect(
      page.getByRole('link', { name: 'Open the folder Prospects', exact: true }),
    ).toBeVisible();

    await act(page, 'Actions for the folder Prospects', 'Delete folder');
    const asking = page.getByRole('dialog', { name: 'Delete this folder?', exact: true });
    await expect(asking).toContainText(
      'Prospects: the workflows and folders in it move up one level. None is deleted.',
    );
    await expectNoViolations(page);
    await asking.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await expect(notice(page)).toHaveText('Folder deleted.');
    await expect(table(page).getByRole('rowheader')).toHaveText(['Weddings', 'New lead follow-up']);
  });
});

test.describe("a workflow's row", () => {
  test('opens the numbers the server has under the row', async ({ page }) => {
    const state = world({ automations: three() });
    await signedIn(page);
    await automationsApi(page, state);
    await page.goto(inHarbor('/automations'));
    const toggle = page.getByRole('button', { name: 'Stats for New lead follow-up', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const all = page.getByRole('group', { name: 'Every version', exact: true });
    await expect(all.getByRole('term')).toHaveText([
      'Enrolled',
      'Active',
      'Completed',
      'Stopped early',
      'Failed',
      'Cancelled',
    ]);
    await expect(all.getByRole('definition')).toHaveText(['12', '3', '8', '0', '1', '0']);
    await expect(
      page.getByRole('group', { name: 'Live version 2', exact: true }).getByRole('definition'),
    ).toHaveText(['5', '2', '3', '0', '0', '0']);
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);
    await toggle.click();
    await expect(all).toHaveCount(0);
  });

  test('renames and duplicates a workflow from its menu', async ({ page }) => {
    const state = world({ automations: three() });
    await signedIn(page);
    await automationsApi(page, state);
    await page.goto(inHarbor('/automations'));
    await act(page, 'Actions for Birthday note', 'Rename');
    const naming = page.getByRole('dialog', { name: 'Rename workflow', exact: true });
    await naming.getByRole('textbox', { name: 'Workflow name', exact: true }).fill('Birthday card');
    await naming.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(notice(page)).toHaveText('Workflow renamed.');
    await expect(workflow(page, 'Birthday card')).toBeVisible();
    expect(state.writes.at(-1)).toEqual({
      method: 'PATCH',
      path: `/${birthdayId}/draft`,
      body: {
        baseDraftVersion: 3,
        patch: [{ op: 'replace', path: '/name', value: 'Birthday card' }],
      },
    });

    await act(page, 'Actions for Birthday card', 'Duplicate');
    await expect(notice(page)).toHaveText('Created Birthday card (copy) as a draft.');
    await expect(workflow(page, 'Birthday card (copy)').getByRole('cell').nth(0)).toHaveText(
      'Draft',
    );
    // The row's menu button keeps the keyboard: nothing opened to take it.
    await expect(
      page.getByRole('button', { name: 'Actions for Birthday card', exact: true }),
    ).toBeFocused();
  });

  test('deletes a workflow to the Deleted list, and restores it paused', async ({ page }) => {
    const state = world({ automations: three() });
    await signedIn(page);
    await automationsApi(page, state);
    await page.goto(inHarbor('/automations'));
    await act(page, 'Actions for New lead follow-up', 'Delete workflow');
    const asking = page.getByRole('dialog', { name: 'Delete this workflow?', exact: true });
    await expect(asking).toContainText('It stays under Deleted for 30 days');
    await expectNoViolations(page);
    await asking.getByRole('button', { name: 'Delete workflow', exact: true }).click();
    await expect(notice(page)).toHaveText('Workflow deleted.');
    await expect(workflow(page, 'New lead follow-up')).toHaveCount(0);
    expect(state.writes.at(-1)).toMatchObject({ method: 'DELETE', path: `/${automationId}` });

    await page.getByRole('link', { name: 'Deleted', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/automations?list=deleted'));
    const deleted = page.getByRole('table', { name: 'Deleted workflows', exact: true });
    await expect(deleted.getByRole('columnheader')).toHaveText([
      'Name',
      'Deleted on',
      'Removed for good on',
      'Actions',
    ]);
    await expect(deleted.getByRole('rowheader')).toHaveText(['New lead follow-up']);
    await expect(row(page, 'New lead follow-up').getByRole('cell').nth(1)).toContainText(
      'Nov 8, 2026',
    );
    await expect(page.getByRole('navigation', { name: 'Folders', exact: true })).toHaveCount(0);
    expect(state.listQueries.at(-1)).toBe('status=archived');
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);

    await page.getByRole('button', { name: 'Restore New lead follow-up', exact: true }).click();
    await expect(notice(page)).toHaveText(
      'Restored New lead follow-up. It is paused: nothing new starts until it is published again.',
    );
    await expect(
      page.getByText('No workflow has been deleted in the last 30 days.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'All workflows', exact: true }).click();
    await expect(workflow(page, 'New lead follow-up').getByRole('cell').nth(0)).toHaveText(
      'Paused',
    );
  });
});

test.describe('the Overview', () => {
  test('counts the workflows and what they have enrolled, from the list', async ({ page }) => {
    await signedIn(page);
    await automationsApi(page, world({ automations: three() }));
    await page.goto(inHarbor('/automations'));
    await page
      .getByRole('navigation', { name: 'Automation', exact: true })
      .getByRole('link', { name: 'Overview', exact: true })
      .click();
    await expect(page).toHaveURL(inHarbor('/automations/overview'));
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('term')).toHaveText([
      'Total workflows',
      'Published workflows',
      'Total enrollments',
      'Active enrollments',
    ]);
    await expect(page.locator('dd.tabular-nums')).toHaveText(['3', '1', '1,204', '37']);
    await expect(
      page
        .getByRole('navigation', { name: 'Automation', exact: true })
        .getByRole('link', { name: 'Overview', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);
  });

  test('says when the workflows cannot be read, and shows no number', async ({ page }) => {
    await signedIn(page);
    await page.route('**/api/v1/automations**', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        json: { type: 'about:blank', title: 'Service Unavailable', status: 503 },
      }),
    );
    await page.goto(inHarbor('/automations/overview'));
    await expect(page.getByRole('alert')).toContainText("We couldn't load the workflows.", {
      timeout: 20_000,
    });
    await expect(page.getByRole('term')).toHaveCount(0);
    await expectNoViolations(page);
  });
});

for (const width of [360, 1440])
  test.describe(`the workflows list at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('fits the list, its folders, an open row and the Overview without sideways scrolling', async ({
      page,
    }) => {
      const state = world({
        automations: three(),
        folders: [folderOf(folderIds.leads, 'Leads with a long name to wrap on a phone')],
      });
      await signedIn(page);
      await automationsApi(page, state);
      await page.goto(inHarbor('/automations'));
      await expect(table(page)).toBeVisible();
      // The table scrolls inside its own frame, never the page.
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.getByRole('button', { name: 'Stats for New lead follow-up', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Every version', exact: true })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);

      await act(page, 'Actions for Birthday note', 'Move to folder');
      const moving = page.getByRole('dialog', { name: 'Move to folder', exact: true });
      await expect(moving).toBeVisible();
      const box = await moving.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      await expectNoViolations(page);
      await moving.getByRole('button', { name: 'Cancel', exact: true }).click();

      await page.goto(inHarbor('/automations?list=deleted'));
      await expect(
        page.getByText('No workflow has been deleted in the last 30 days.', { exact: true }),
      ).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);

      await page.goto(inHarbor('/automations/overview'));
      await expect(page.getByRole('term')).toHaveCount(4);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
    });
  });
