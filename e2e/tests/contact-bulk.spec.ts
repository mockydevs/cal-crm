// Bulk actions from the contact list, on the whole product: the built dashboard and server
// over a migrated Postgres, with the worker. A person ticks contacts and turns do not
// disturb on for text messages, exports them as CSV and downloads the file from Bulk
// Actions once the worker has written it, then deletes them; the server keeps each change.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { contact, contactDetails, me } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.214'));

test('sets do not disturb, exports and deletes the ticked contacts, as the server keeps them', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const profile = me.parse(await (await page.request.get(`${address('app')}/api/v1/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('The fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const api = `${address('app')}/api/v1`;
  const made = [];
  for (const name of ['One', 'Two']) {
    const created = await page.request.post(`${api}/contacts`, {
      headers,
      data: {
        firstName: `Bulk${suffix}`,
        lastName: name,
        emails: [`bulk-${name.toLowerCase()}-${suffix}@example.test`],
      },
    });
    expect(created.status()).toBe(201);
    made.push(contact.parse(await created.json()));
  }

  await page.goto(inOurs(`/contacts?q=Bulk${suffix}`));
  const table = page.getByRole('region', { name: 'Contacts table', exact: true });
  await expect(table.getByRole('link', { name: `Bulk${suffix} One`, exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select all contacts on this page' }).check();
  const bar = page.getByRole('group', { name: 'Bulk actions' });
  await expect(bar).toContainText('2 selected');

  // Do not disturb, for text messages only, with the reason the audit log keeps.
  await bar.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Do not disturb' }).click();
  const dnd = page.getByRole('dialog', { name: 'Do not disturb' });
  await dnd.getByRole('checkbox', { name: 'All channels' }).uncheck();
  await dnd.getByRole('checkbox', { name: 'Text messages' }).check();
  await dnd.getByLabel('Reason').fill('Both asked at the fair to get no more texts.');
  await dnd.getByRole('button', { name: 'Apply to 2 contacts' }).click();
  await expect(dnd).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Done:' })).toContainText('2 changed');
  for (const each of made) {
    const details = contactDetails.parse(
      await (await page.request.get(`${api}/contacts/${each.id}/details`, { headers })).json(),
    );
    expect(details.dnd).toMatchObject({ all: false, channels: ['sms'] });
  }

  // Export: the worker writes the file, and Bulk Actions offers it.
  await page.getByRole('checkbox', { name: 'Select all contacts on this page' }).check();
  await bar.getByRole('button', { name: 'Export' }).click();
  const exporting = page.getByRole('dialog', { name: 'Export contacts' });
  await exporting.getByLabel('Action name (optional)').fill(`Export ${suffix}`);
  await exporting.getByRole('button', { name: 'Export 2 contacts' }).click();
  await expect(exporting).toBeHidden();
  await page.getByRole('link', { name: 'Download it from Bulk Actions' }).click();
  const row = page
    .getByRole('region', { name: 'Bulk actions table', exact: true })
    .getByRole('row')
    .filter({ hasText: `Export ${suffix}` });
  await expect(row).toContainText('Complete', { timeout: 30_000 });
  const saved = page.waitForEvent('download');
  await row.getByRole('button', { name: /^Download Export_/ }).click();
  const csv = await readFile(await (await saved).path(), 'utf8');
  expect(csv).toContain(`"Bulk${suffix} One"`);
  expect(csv).toContain(`"bulk-two-${suffix}@example.test"`);

  // Delete: both move to the trash.
  await page.goto(inOurs(`/contacts?q=Bulk${suffix}`));
  await page.getByRole('checkbox', { name: 'Select all contacts on this page' }).check();
  await page
    .getByRole('group', { name: 'Bulk actions' })
    .getByRole('button', { name: 'Delete' })
    .click();
  const deleting = page.getByRole('dialog', { name: 'Delete contacts' });
  await expect(deleting).toContainText('2 contacts are selected.');
  await deleting.getByRole('button', { name: 'Delete 2 contacts' }).click();
  await expect(deleting).toBeHidden();
  await expect(page.getByText('No contacts match this search.')).toBeVisible();
});
