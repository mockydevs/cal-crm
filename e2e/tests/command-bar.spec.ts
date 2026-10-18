import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, me } from '@repo/contracts';
import { address, asClient, inOurs, ours, theirs } from '../servers.js';
import { newPerson, query, signInByLink } from '../signing-in.js';

// The command bar on the real stack, by keyboard alone: it finds our contact and company,
// never the other business's contact of the same name, and goes to the contact.
test.use(asClient('203.0.113.127'));
test('finds only our records, and goes to one by keyboard alone', async ({ page }) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const name = `Zara ${suffix}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const profile = me.parse(await (await page.request.get(`${address('app')}/api/v1/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('The command bar fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const api = `${address('app')}/api/v1`;
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: 'Zara', lastName: suffix, emails: [`zara-${suffix}@example.test`] },
  });
  expect(created.status()).toBe(201);
  const saved = contact.parse(await created.json());
  const company = await page.request.post(`${api}/companies`, {
    headers,
    data: { name: `${name} Studio` },
  });
  expect(company.status()).toBe(201);
  // The other business has a Zara of the same name.
  await query(
    `with business as (select id from tenancy.businesses where slug = $1),
     record as (
       insert into crm.records (business_id, kind, object_type_id)
       select b.id, 'contact', t.id from business b
       join crm.object_types t on t.business_id = b.id and t.kind = 'contact'
       returning business_id, id)
     insert into crm.contacts (business_id, id, first_name, last_name, created_by_kind)
     select business_id, id, 'Zara', $2, 'user' from record`,
    [theirs.slug, suffix],
  );

  await page.goto(inOurs());
  // The shell, which listens for the shortcut, is up once its Search button is.
  await expect(page.getByRole('button', { name: /^Search/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await expect(bar.getByRole('combobox', { name: 'Search or go to' })).toBeFocused();
  await page.keyboard.type(suffix);

  await expect(bar.getByRole('option')).toHaveText([
    new RegExp(`^${name}\\s*zara-${suffix}@example.test$`),
    new RegExp(`^${name} Studio$`),
  ]);
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(inOurs(`/contacts/${saved.id}`));
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
});
