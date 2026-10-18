import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { choose } from '../select.js';
import { address, asClient, inOurs } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

// Against the real stack: a small CSV file is uploaded, mapped, reviewed and imported by
// the worker; the history shows what became of its rows, and the contacts are there.
test.use(asClient('203.0.113.143'));

test('imports a small CSV file, and shows it in the history and its contacts in the list', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const fileName = `contacts-${suffix}.csv`;
  const csv = [
    'First name,Last name,Email',
    `Imp${suffix},One,one-${suffix}@example.test`,
    `Imp${suffix},Two,two-${suffix}@example.test`,
    `Imp${suffix},Three,not-an-address`,
    '',
  ].join('\n');
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(inOurs('/settings/import'));
  await expect(page.getByRole('heading', { level: 1, name: 'Import Data' })).toBeVisible();

  await page.getByRole('button', { name: 'Start CSV import', exact: true }).click();
  const flow = page.getByRole('dialog', { name: 'Import contacts from CSV', exact: true });
  await flow
    .getByLabel('CSV file', { exact: true })
    .setInputFiles({ name: fileName, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(flow.getByText(`3 rows found in ${fileName}.`)).toBeVisible();
  // Whatever the server suggested, each column fills what its name says.
  await choose(flow.getByLabel('What First name fills', { exact: true }), 'attribute:firstName');
  await choose(flow.getByLabel('What Last name fills', { exact: true }), 'attribute:lastName');
  await choose(flow.getByLabel('What Email fills', { exact: true }), 'attribute:email');
  await flow.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    flow.getByRole('radio', { name: 'Create new contacts and update existing ones', exact: true }),
  ).toBeChecked();
  await flow.getByRole('button', { name: 'Review', exact: true }).click();

  const reviewed = flow.getByRole('region', { name: 'Review of the first rows' });
  await expect(reviewed.getByRole('row')).toHaveCount(4);
  await expect(reviewed.getByRole('row').nth(1)).toContainText('Create');
  await expect(reviewed.getByRole('row').nth(1)).toContainText(`one-${suffix}@example.test`);
  await expect(reviewed.getByRole('row').nth(3)).toContainText('Fail');
  await flow.getByRole('button', { name: 'Start import', exact: true }).click();
  await expect(flow).toBeHidden();

  // The worker imports it: two contacts made, one row that failed, and its file of errors.
  const row = page
    .getByRole('region', { name: 'Import history table', exact: true })
    .getByRole('row')
    .filter({ hasText: fileName });
  await expect(row).toContainText('Completed', { timeout: 30_000 });
  await expect(row).toContainText('2 created · 0 updated · 0 skipped');
  await expect(row.getByRole('cell').nth(3)).toHaveText('3');
  await expect(row.getByRole('cell').nth(4)).toHaveText('1');
  await expect(row).toContainText('You');
  await expect(
    row.getByRole('button', {
      name: `Download the rows of ${fileName} that were not imported`,
      exact: true,
    }),
  ).toBeVisible();

  await page.goto(inOurs('/contacts'));
  await page.getByRole('searchbox', { name: 'Search contacts', exact: true }).fill(`Imp${suffix}`);
  const contacts = page.getByRole('region', { name: 'Contacts table', exact: true });
  await expect(contacts.getByRole('link', { name: `Imp${suffix} One`, exact: true })).toBeVisible();
  await expect(contacts.getByRole('link', { name: `Imp${suffix} Two`, exact: true })).toBeVisible();
  await expect(contacts.getByRole('link', { name: `Imp${suffix} Three` })).toHaveCount(0);
});
