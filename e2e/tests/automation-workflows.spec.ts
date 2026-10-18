import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { choose } from '../select.js';
import { address, asClient, inOurs } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

// Against the real stack: the Workflows list files, renames, copies, deletes and restores
// through the automation API, and the numbers it shows are the server's.
test.use(asClient('203.0.113.143'));

const row = (page: Page, name: string): Locator =>
  page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });

async function act(page: Page, menu: string, action: string): Promise<void> {
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('files a new workflow in a folder, renames and copies it, deletes and restores it, and counts it', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const folder = `Leads ${suffix}`;
  const name = `Quote follow-up ${suffix}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(inOurs('/automations'));
  await expect(page.getByRole('heading', { level: 1, name: 'Workflows list' })).toBeVisible();
  const notice = page.getByRole('main').locator('p.sr-only[role="status"]');
  const search = page.getByRole('searchbox', { name: 'Search workflows', exact: true });

  await test.step('a folder, and a workflow created inside it', async () => {
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const naming = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await naming.getByRole('textbox', { name: 'Folder name', exact: true }).fill(folder);
    await naming.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(notice).toHaveText('Folder created.');
    await page.getByRole('link', { name: `Open the folder ${folder}`, exact: true }).click();
    await expect(page).toHaveURL(/folder=afol_/);
    await expect(page.getByText('This folder is empty.', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
    await expect(page).toHaveURL(/automation=aut_/);
    await page.goBack();
    await expect(page.getByRole('table', { name: 'Workflows', exact: true })).toBeVisible();
  });

  const created = page
    .getByRole('table', { name: 'Workflows', exact: true })
    .getByRole('link', { name: /^New Workflow : \d+$/ });
  const firstName = (await created.textContent()) ?? '';

  await test.step('its row: a draft nobody has entered, renamed from its menu', async () => {
    const cells = row(page, firstName).getByRole('cell');
    await expect(cells.nth(0)).toHaveText('Draft');
    await expect(cells.nth(1)).toHaveText('0');
    await expect(cells.nth(2)).toHaveText('0');
    await act(page, `Actions for ${firstName}`, 'Rename');
    const naming = page.getByRole('dialog', { name: 'Rename workflow', exact: true });
    await naming.getByRole('textbox', { name: 'Workflow name', exact: true }).fill(name);
    await naming.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(notice).toHaveText('Workflow renamed.');
    await expect(row(page, name)).toBeVisible();
  });

  await test.step('its numbers, from the statistics the server keeps', async () => {
    await page.getByRole('button', { name: `Stats for ${name}`, exact: true }).click();
    const all = page.getByRole('group', { name: 'Every version', exact: true });
    await expect(all.getByRole('term')).toHaveText([
      'Enrolled',
      'Active',
      'Completed',
      'Stopped early',
      'Failed',
      'Cancelled',
    ]);
    await expect(all.getByRole('definition')).toHaveText(['0', '0', '0', '0', '0', '0']);
    // Never published: there is no live version to count.
    await expect(page.getByRole('group', { name: /^Live version/ })).toHaveCount(0);
  });

  await test.step('a copy, in the same folder, then moved to the top level', async () => {
    await act(page, `Actions for ${name}`, 'Duplicate');
    await expect(notice).toHaveText(`Created ${name} (copy) as a draft.`);
    await expect(row(page, `${name} (copy)`)).toBeVisible();
    await act(page, `Actions for ${name} (copy)`, 'Move to folder');
    const moving = page.getByRole('dialog', { name: 'Move to folder', exact: true });
    await choose(moving.getByRole('combobox', { name: 'Folder', exact: true }), { label: 'Home' });
    await moving.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(notice).toHaveText('Workflow moved.');
    await expect(row(page, `${name} (copy)`)).toHaveCount(0);
  });

  await test.step('deleted, listed under Deleted, and restored to the top level', async () => {
    await act(page, `Actions for ${name}`, 'Delete workflow');
    await page
      .getByRole('dialog', { name: 'Delete this workflow?', exact: true })
      .getByRole('button', { name: 'Delete workflow', exact: true })
      .click();
    await expect(notice).toHaveText('Workflow deleted.');
    await expect(page.getByText('This folder is empty.', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Deleted', exact: true }).click();
    await search.fill(suffix);
    const deleted = page.getByRole('table', { name: 'Deleted workflows', exact: true });
    await expect(deleted.getByRole('rowheader')).toHaveText([name]);
    await page.getByRole('button', { name: `Restore ${name}`, exact: true }).click();
    await expect(notice).toHaveText(`Restored ${name} as a draft.`);

    await page.getByRole('link', { name: 'All workflows', exact: true }).click();
    await search.fill(suffix);
    // Both are at the top level now: the restored one, and the copy moved there.
    await expect(row(page, name)).toBeVisible();
    await expect(row(page, `${name} (copy)`)).toBeVisible();
  });

  await test.step('the folder deleted, and the Overview counting what there is', async () => {
    await search.fill('');
    await act(page, `Actions for the folder ${folder}`, 'Delete folder');
    await page
      .getByRole('dialog', { name: 'Delete this folder?', exact: true })
      .getByRole('button', { name: 'Delete folder', exact: true })
      .click();
    await expect(notice).toHaveText('Folder deleted.');
    await expect(
      page.getByRole('link', { name: `Open the folder ${folder}`, exact: true }),
    ).toHaveCount(0);

    await page
      .getByRole('navigation', { name: 'Automation', exact: true })
      .getByRole('link', { name: 'Overview', exact: true })
      .click();
    await expect(page.getByRole('term')).toHaveText([
      'Total workflows',
      'Published workflows',
      'Total enrollments',
      'Active enrollments',
    ]);
    const total = Number((await page.locator('dd.tabular-nums').first().textContent()) ?? '');
    expect(total).toBeGreaterThanOrEqual(2);
  });

  // Left as it was found: the two workflows this test made go to the Deleted list.
  await page.goto(inOurs('/automations'));
  for (const each of [name, `${name} (copy)`]) {
    await search.fill(each);
    await act(page, `Actions for ${each}`, 'Delete workflow');
    await page
      .getByRole('dialog', { name: 'Delete this workflow?', exact: true })
      .getByRole('button', { name: 'Delete workflow', exact: true })
      .click();
    await expect(notice).toHaveText('Workflow deleted.');
  }
});
