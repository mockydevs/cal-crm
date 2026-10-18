import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, duplicateSettings, me } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';

test.use(asClient('203.0.113.221'));

// Two addresses one Gmail inbox receives, on two contacts: the contact page says so, Manage
// Duplicates groups them, Review shows them side by side, and Reject keeps them apart for
// good. Then the Business Profile's deduplication preferences are changed and put back.
test('finds two contacts one Gmail inbox reaches, reviews and rejects them, and sets the match order', async ({
  page,
}) => {
  const person = await newPerson();
  // Keys sort by their text: one starting with 0 comes before the business's other groups.
  const suffix = `0${randomUUID().slice(0, 8)}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const api = `${address('app')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((each) => each.slug === ours.slug);
  if (business === undefined) throw new Error('Expected the duplicates business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const add = async (lastName: string, email: string) => {
    const created = await page.request.post(`${api}/contacts`, {
      headers,
      data: { firstName: 'Jane', lastName, emails: [email] },
    });
    expect(created.status()).toBe(201);
    return contact.parse(await created.json());
  };
  const dotted = await add(`Doe ${suffix}`, `jane.doe.${suffix}@gmail.com`);
  await add(`Doe ${suffix}`, `janedoe${suffix}+news@googlemail.com`);
  const key = `janedoe${suffix}@gmail.com`;

  await page.goto(inOurs(`/contacts/${dotted.id}`));
  await page.getByRole('button', { name: 'Possible duplicates (1)', exact: true }).click();
  const fromContact = page.getByRole('dialog', { name: 'Review duplicates' });
  await expect(fromContact.getByRole('heading', { name: key })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(inOurs('/contacts'));
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Manage Duplicates', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Manage Duplicates' })).toBeVisible();
  const groups = page.getByRole('region', { name: 'Duplicates by email', exact: true });
  const card = groups.getByRole('listitem').filter({ hasText: key });
  await expect(card).toContainText(`2 contacts: Jane Doe ${suffix}, Jane Doe ${suffix}`);
  await card.getByRole('button', { name: 'Review', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Review duplicates' });
  await expect(panel.getByRole('cell', { name: `jane.doe.${suffix}@gmail.com` })).toBeVisible();
  await expect(
    panel.getByRole('cell', { name: `janedoe${suffix}+news@googlemail.com` }),
  ).toBeVisible();
  // Merge opens Merge Contacts (contact-merge.spec.ts); this test rejects them instead.
  await expect(panel.getByRole('button', { name: 'Merge', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Reject', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Reject these duplicates?' });
  await confirm.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(panel).toBeHidden();
  await expect(groups.getByRole('status')).toContainText(`${key} was rejected.`);
  await expect(card).toHaveCount(0);
  // The server keeps the rejection: read again, the group is not there.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Manage Duplicates' })).toBeVisible();
  await expect(groups.getByText(key, { exact: true })).toHaveCount(0);

  const read = async () =>
    duplicateSettings.parse(
      await (await page.request.get(`${api}/contact-duplicate-settings`, { headers })).json(),
    );
  const before = await read();
  try {
    await page.goto(inOurs('/settings/business'));
    const section = page.getByRole('region', { name: 'Contact Deduplication Preferences' });
    await choose(section.getByRole('combobox', { name: 'Secondary field', exact: true }), 'phone');
    await section.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await expect(section.getByRole('status')).toHaveText(
      'Contact deduplication preferences saved.',
    );
    expect(await read()).toMatchObject({ primary: before.primary, secondary: 'phone' });
  } finally {
    // The business is shared with the other tests: its order goes back as it was.
    const current = await read();
    await page.request.put(`${api}/contact-duplicate-settings`, {
      headers,
      data: { primary: before.primary, secondary: before.secondary, revision: current.revision },
    });
  }
});
