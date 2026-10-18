import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { address, asClient, inOurs } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';

test.use(asClient('203.0.113.83'));
test('creates a field in a folder, shows its key and renames it without changing the key through the real API', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const folder = `Event ${suffix}`;
  const token = `{{opportunity.guest_count_${suffix}}}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  // The address fields and tags shared still opens the fields.
  await page.goto(inOurs('/settings/fields-and-tags'));
  await expect(page).toHaveURL(inOurs('/settings/custom-fields'));
  await expect(page.getByRole('heading', { level: 1, name: 'Custom Fields' })).toBeVisible();
  const notice = page.getByRole('main').locator('p.sr-only[role="status"]');
  const table = page.getByRole('region', { name: 'Fields table', exact: true });

  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  const addingFolder = page.getByRole('dialog', { name: 'Create folder', exact: true });
  await choose(addingFolder.getByLabel('Add to object', { exact: true }), 'deal');
  await addingFolder.getByLabel('Folder name', { exact: true }).fill(folder);
  await addingFolder.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(notice).toHaveText('Folder created.');

  await page.getByRole('button', { name: 'Create field', exact: true }).click();
  const creating = page.getByRole('dialog', { name: 'Create custom field', exact: true });
  const create = creating.getByRole('button', { name: 'Create custom field', exact: true });
  await creating.getByLabel('Field name', { exact: true }).fill(`Guest count ${suffix}`);
  await expect(creating.getByLabel('Key', { exact: true })).toHaveValue(`guest_count_${suffix}`);
  await choose(creating.getByLabel('Add to object', { exact: true }), 'deal');
  await choose(creating.getByLabel('Field type', { exact: true }), 'number');
  await choose(creating.getByLabel('Folder name', { exact: true }), { label: folder });
  await expect(creating.getByText(token, { exact: true })).toBeVisible();
  // What the field means is required: the assistant reads it.
  await expect(create).toBeDisabled();
  await creating
    .getByLabel('What it means', { exact: true })
    .fill('The latest expected number of guests.');
  await creating.getByLabel('Conversations', { exact: true }).check();
  await create.click();
  await expect(notice).toHaveText('Field created.');
  const row = table.getByRole('row').filter({ hasText: `Guest count ${suffix}` });
  await expect(row).toContainText(token);
  await expect(row).toContainText(folder);
  await expect(row).toContainText('Number');

  await row.getByRole('button', { name: `Edit Guest count ${suffix}`, exact: true }).click();
  const editing = page.getByRole('dialog', { name: 'Edit custom field', exact: true });
  await expect(editing.getByLabel('Key', { exact: true })).toBeDisabled();
  await editing.getByLabel('Field name', { exact: true }).fill(`Attendees ${suffix}`);
  await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(notice).toHaveText('Field saved.');

  await page.reload();
  const renamed = table.getByRole('row').filter({ hasText: `Attendees ${suffix}` });
  await expect(renamed).toContainText(token);
  await renamed.getByRole('button', { name: `Edit Attendees ${suffix}`, exact: true }).click();
  await expect(editing.getByLabel('Key', { exact: true })).toHaveValue(`guest_count_${suffix}`);
  await expect(editing.getByLabel('Conversations', { exact: true })).toBeChecked();
  await editing.getByLabel('Archive field', { exact: true }).check();
  await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(notice).toHaveText('Field saved.');
  // Archived, not deleted: gone from the active fields, listed with the archived ones.
  await expect(renamed).toHaveCount(0);
  await choose(page.getByLabel('Status', { exact: true }), 'only');
  await expect(renamed).toContainText('Archived');
  await expect(renamed).toContainText(token);
});
