import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { choose } from '../select.js';
import { address, asClient, inOurs } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

// Against the real stack: a custom value is created in a folder with a key made from its
// name, keeps that key when it is renamed, and can be deleted.
test.use(asClient('203.0.113.142'));

test('creates a custom value in a folder, keeps its key when renamed, and deletes it', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const folder = `Links ${suffix}`;
  const name = `Booking page ${suffix}`;
  const token = `{{custom_values.booking_page_${suffix}}}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(inOurs('/settings/custom-values'));
  await expect(page.getByRole('heading', { level: 1, name: 'Custom Values' })).toBeVisible();
  const notice = page.getByRole('main').locator('p.sr-only[role="status"]');

  await page.getByRole('button', { name: 'Add folder', exact: true }).click();
  const addingFolder = page.getByRole('dialog', { name: 'Add folder', exact: true });
  await addingFolder.getByLabel('Folder name', { exact: true }).fill(folder);
  await addingFolder.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(notice).toHaveText('Folder created.');

  await page.getByRole('button', { name: 'Add custom value', exact: true }).click();
  const adding = page.getByRole('dialog', { name: 'Add custom value', exact: true });
  await adding.getByLabel('Name', { exact: true }).fill(name);
  await expect(adding.getByText(token)).toBeVisible();
  await adding.getByLabel('Value', { exact: true }).fill('https://book.harborlights.example');
  await choose(adding.getByLabel('Folder', { exact: true }), { label: folder });
  await adding.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(notice).toHaveText('Custom value created.');

  // Found again by its key after a reload, in its folder.
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search values', exact: true }).fill(suffix);
  const table = page.getByRole('region', { name: 'Custom values table', exact: true });
  const row = table.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText(token);
  await expect(row).toContainText(folder);
  await expect(row).toContainText('https://book.harborlights.example');

  await row.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const editing = page.getByRole('dialog', { name: 'Edit custom value', exact: true });
  await editing.getByLabel('Name', { exact: true }).fill(`Booking link ${suffix}`);
  await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(notice).toHaveText('Custom value saved.');
  const renamed = table.getByRole('row').filter({ hasText: `Booking link ${suffix}` });
  await expect(renamed).toContainText(token);

  await renamed
    .getByRole('button', { name: `Actions for Booking link ${suffix}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page
    .getByRole('dialog', { name: `Delete Booking link ${suffix}?`, exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(notice).toHaveText('Custom value deleted.');
  await expect(page.getByText('No custom values match.', { exact: true })).toBeVisible();
});
