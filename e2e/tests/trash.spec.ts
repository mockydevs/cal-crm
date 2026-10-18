import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, me } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

// The trash on the real stack: a contact trashed through the API is listed, restored with
// its tag, trashed again and deleted forever.
test.use(asClient('203.0.113.126'));
test('restores a contact from the trash with its tag, then deletes it forever', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const name = `Trash test ${suffix}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const profile = me.parse(await (await page.request.get(`${address('app')}/api/v1/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('The trash fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const api = `${address('app')}/api/v1`;
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: name, emails: [`trash-${suffix}@example.test`] },
  });
  expect(created.status()).toBe(201);
  const saved = contact.parse(await created.json());
  const tagged = await page.request.post(`${api}/tags`, {
    headers,
    data: { name: `trash ${suffix}` },
  });
  expect(tagged.status()).toBe(201);
  const { id: tagId } = (await tagged.json()) as { id: string };
  const assigned = await page.request.put(`${api}/records/${saved.id}/tags/${tagId}`, {
    headers,
    data: {},
  });
  expect(assigned.ok()).toBe(true);
  const trash = () => page.request.delete(`${api}/contacts/${saved.id}`, { headers });
  expect((await trash()).status()).toBe(200);

  await page.goto(inOurs('/contacts'));
  // The trash is in the menu at the end of the row of saved views.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Trash', exact: true }).click();
  const row = page
    .getByRole('list', { name: 'In the trash' })
    .getByRole('listitem')
    .filter({ hasText: name });
  await expect(row).toContainText('Deleted for good on');
  await row.getByRole('button', { name: `Restore ${name}`, exact: true }).click();
  await expect(page.getByRole('status').last()).toHaveText(`${name} restored.`);
  await expect(row).toHaveCount(0);

  const tags = await page.request.get(`${api}/records/${saved.id}/tags`, { headers });
  expect(JSON.stringify(await tags.json())).toContain(`trash ${suffix}`);

  expect((await trash()).status()).toBe(200);
  await page.reload();
  await row.getByRole('button', { name: `Delete ${name} forever`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeFocused();
  await page
    .getByRole('group', { name: `Delete ${name} forever?`, exact: true })
    .getByRole('button', { name: 'Delete forever', exact: true })
    .click();
  await expect(page.getByRole('status').last()).toHaveText(`${name} deleted forever.`);
  await expect(row).toHaveCount(0);
  expect((await page.request.get(`${api}/contacts/${saved.id}`, { headers })).status()).toBe(404);
});
