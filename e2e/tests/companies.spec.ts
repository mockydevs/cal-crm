import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { company, contact, contactCompanies, me } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, query, signInByLink } from '../signing-in.js';
import { choose, expectOffered } from '../select.js';

test.use(asClient('203.0.113.124'));

test('company domains and contact primary links survive real saves, reloads and trash', async ({
  page,
}) => {
  const person = await newPerson();
  // Starts with a letter: a search of digits alone is kept in the address as a quoted string
  // (q=%2240180068%22, so it stays text), which the address check below would not match.
  const suffix = `c${randomUUID().slice(0, 7)}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const profile = me.parse(await (await page.request.get(`${address('app')}/api/v1/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('Companies fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const api = `${address('app')}/api/v1`;
  // The shared low-level fixture seeds object types only; real business.create also
  // seeds this relationship (covered by the business-default integration suite).
  await query(
    `insert into crm.link_types(business_id,key,from_object_type_id,to_object_type_id,label,reverse_label,allows_primary)
    select b.id,'contact_company',c.id,o.id,'Company','Person',true from tenancy.businesses b
    join crm.object_types c on c.business_id=b.id and c.kind='contact'
    join crm.object_types o on o.business_id=b.id and o.kind='company'
    where b.slug=$1 on conflict(business_id,key) do nothing`,
    [ours.slug],
  );
  const name = `Acme ${suffix}`;
  const domain = `acme-${suffix}.example`;
  await page.goto(inOurs('/contacts'));
  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  // "Add Company" opens the panel over the list; the list is where a save comes back to.
  // The header's button: an empty list offers a second one in its place.
  const add = page.getByRole('button', { name: 'Add Company', exact: true }).first();
  await add.click();
  const adding = page.getByRole('dialog', { name: 'Add new Company', exact: true });
  await adding.getByLabel('Company Name', { exact: true }).fill(name);
  await adding.getByLabel('Phone', { exact: true }).fill('+254 712 345678');
  await adding.getByLabel('City', { exact: true }).fill('Mombasa');
  await choose(adding.getByRole('combobox', { name: 'Country', exact: true }), 'KE');
  await adding.getByLabel('Domain', { exact: true }).fill(domain.toUpperCase());
  await adding.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(adding).toHaveCount(0);
  await expect(page).toHaveURL(inOurs('/contacts/companies'));
  // The saved company is found by the server's own search, with what the server kept.
  const search = page.getByRole('searchbox', { name: 'Search companies', exact: true });
  await search.fill(suffix);
  // The list sends what was typed to the address a moment after typing stops. Wait for it:
  // a click on a company before then is undone when the search arrives (seen on CI).
  await expect(page).toHaveURL(new RegExp(`[?&]q=${suffix}(?:&|$)`));
  const table = page.getByRole('region', { name: 'Companies table', exact: true });
  const row = table.getByRole('row').filter({ hasText: name });
  await expect(row.getByRole('cell', { name: 'Kenya', exact: true })).toBeVisible();
  await row.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: domain, exact: true })).toBeVisible();
  const companyId = new URL(page.url()).pathname.split('/').at(-1);
  if (companyId === undefined) throw new Error('Missing company URL.');
  const first = company.parse(
    await (await page.request.get(`${api}/companies/${companyId}`, { headers })).json(),
  );
  expect(first).toMatchObject({
    name,
    phone: '+254712345678',
    city: 'Mombasa',
    country: 'KE',
    domain,
  });
  const duplicate = await page.request.post(`${api}/companies`, {
    headers,
    data: { name: 'Duplicate', domain },
  });
  expect(duplicate.status()).toBe(422);
  // The same refusal, from the panel: the server's sentence lands under Domain, the draft
  // stays, and nothing is added.
  await page.getByRole('link', { name: 'All companies', exact: true }).click();
  await add.click();
  await adding.getByLabel('Company Name', { exact: true }).fill(`Copy ${suffix}`);
  await adding.getByLabel('Domain', { exact: true }).fill(domain);
  await adding.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    adding.getByText(
      'Another company uses this domain. Choose that company or enter a different domain.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(adding.getByLabel('Domain', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(adding.getByLabel('Company Name', { exact: true })).toHaveValue(`Copy ${suffix}`);
  await adding.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(adding).toHaveCount(0);
  await search.fill(suffix);
  await expect(row).toHaveCount(1);
  await expect(table.getByRole('row').filter({ hasText: `Copy ${suffix}` })).toHaveCount(0);
  await row.getByRole('link', { name, exact: true }).click();
  // Edit is the same panel, on the company's own page.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editing = page.getByRole('dialog', { name: 'Edit company', exact: true });
  await expect(editing.getByLabel('Phone', { exact: true })).toHaveValue('+254712345678');
  await editing.getByLabel('Company Name', { exact: true }).fill(`${name} Events`);
  await editing.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editing).toHaveCount(0);
  await expect(page.getByRole('heading', { name: `${name} Events`, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: `${name} Events`, exact: true })).toBeVisible();
  const secondResponse = await page.request.post(`${api}/companies`, {
    headers,
    data: { name: `Northwind ${suffix}` },
  });
  expect(secondResponse.status()).toBe(201);
  const second = company.parse(await secondResponse.json());
  const contactResponse = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: `Maya ${suffix}` },
  });
  expect(contactResponse.status()).toBe(201);
  const personRecord = contact.parse(await contactResponse.json());
  await page.goto(inOurs(`/contacts/${personRecord.id}?view=companies`));
  const panel = page.getByRole('region', { name: 'Companies', exact: true });
  await panel.getByLabel('Find company', { exact: true }).fill(suffix);
  await expectOffered(panel.getByLabel('Company', { exact: true }), `${name} Events`, 1);
  await choose(panel.getByLabel('Company', { exact: true }), first.id);
  await panel.getByRole('button', { name: 'Link company', exact: true }).click();
  await panel.getByRole('button', { name: `Make ${name} Events primary`, exact: true }).click();
  await expect(panel.getByText('Primary', { exact: true })).toHaveCount(1);
  await choose(panel.getByLabel('Company', { exact: true }), second.id);
  await panel.getByRole('button', { name: 'Link company', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: `Make Northwind ${suffix} primary`, exact: true }),
  ).toBeEnabled();
  // Give this real write a slow network hop: reloading must wait for its saved state.
  await page.route(
    `${api}/contacts/${personRecord.id}/companies/${second.id}`,
    async (route) => {
      await delay(1000);
      await route.continue();
    },
    { times: 1 },
  );
  await panel
    .getByRole('button', { name: `Make Northwind ${suffix} primary`, exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: `Clear Northwind ${suffix} as primary`, exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(panel.getByText('Primary', { exact: true })).toHaveCount(1);
  const primary = contactCompanies.parse(
    await (
      await page.request.get(`${api}/contacts/${personRecord.id}/companies`, { headers })
    ).json(),
  );
  expect(primary.items.filter((item) => item.isPrimary).map((item) => item.company.id)).toEqual([
    second.id,
  ]);
  await page.goto(inOurs(`/contacts/companies/${first.id}`));
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByText('This company is in the trash.', { exact: true })).toBeVisible();
  const reused = await page.request.post(`${api}/companies`, {
    headers,
    data: { name: 'Replacement', domain },
  });
  expect(reused.status()).toBe(201);
  const replacement = company.parse(await reused.json());
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Another company uses this domain.');
  expect(
    (await page.request.delete(`${api}/companies/${replacement.id}`, { headers })).status(),
  ).toBe(200);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('This company is in the trash.', { exact: true })).toHaveCount(0);
  await page.goto(inOurs(`/contacts/${personRecord.id}?view=companies`));
  await expect(panel.getByRole('link', { name: `${name} Events`, exact: true })).toBeVisible();
  await expect(panel.getByText('Primary', { exact: true })).toHaveCount(1);
});
