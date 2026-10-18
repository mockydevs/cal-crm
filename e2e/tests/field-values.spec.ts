import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, fieldDefinition, me, recordFields } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, query, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';
import { openFilters, openSort } from '../lists.js';

test.use(asClient('203.0.113.125'));
test('confirms an AI field, edits an exact value, filters the real list and clears it', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const profile = me.parse(await (await page.request.get(`${address('app')}/api/v1/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('Field-value fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const api = `${address('app')}/api/v1`;
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: `Field test ${suffix}`, emails: [`field-${suffix}@example.test`] },
  });
  expect(created.status()).toBe(201);
  const saved = contact.parse(await created.json());
  const label = `Budget ${suffix}`;
  const response = await page.request.post(`${api}/fields`, {
    headers,
    data: {
      objectKey: 'contact',
      key: `budget_${suffix}`,
      label,
      description: 'The agreed event budget.',
      valueType: 'money',
      currency: 'KES',
      options: [],
      aiFillSources: ['conversations'],
      aiOverwrite: 'ask',
      archived: false,
    },
  });
  expect(response.status()).toBe(201);
  const field = fieldDefinition.parse(await response.json());
  // Extraction is a trusted worker operation. Seed its saved output at the system boundary.
  await query(
    `insert into crm.field_values(business_id,record_id,field_id,value_type,value_number,source_kind,confidence)
    select c.business_id,c.id,f.id,'money',9007199254740993.25,'ai_agent',0.9 from crm.contacts c
    join crm.contact_identities i on i.business_id=c.business_id and i.contact_id=c.id
    join crm.field_definitions f on f.business_id=c.business_id and f.key=$2
    where i.kind='email' and i.value_normalized=$1`,
    [`field-${suffix}@example.test`, field.key],
  );
  await page.goto(inOurs(`/contacts/${saved.id}`));
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await fields.getByRole('button', { name: `Confirm ${label}`, exact: true }).click();
  await expect(fields.getByText('Confirmed by you', { exact: true })).toBeVisible();
  await fields.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
  await fields.getByLabel(label, { exact: true }).fill('9007199254740994.1250');
  await fields.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(fields.getByText('KES 9007199254740994.1250', { exact: true })).toBeVisible();
  await fields.getByRole('button', { name: `Why ${label} has this value`, exact: true }).click();
  await expect(
    fields.getByRole('region', { name: `Why ${label} has this value`, exact: true }),
  ).toContainText('Field value set');
  const values = recordFields.parse(
    await (await page.request.get(`${api}/records/${saved.id}/fields`, { headers })).json(),
  );
  const value = values.items.find((item) => item.definition.id === field.id);
  expect(value).toMatchObject({
    value: '9007199254740994.1250',
    source: { kind: 'user', you: true },
    confirmedAt: null,
    confidence: null,
  });
  await page.goto(inOurs('/contacts'));
  const filters = await openFilters(page);
  await filters.getByRole('button', { name: label, exact: true }).click();
  await choose(filters.getByRole('combobox', { name: 'Match', exact: true }), 'gt');
  await filters.getByLabel('Field value', { exact: true }).fill('9007199254740994');
  await filters.getByRole('button', { name: 'Apply', exact: true }).click();
  const sort = await openSort(page);
  await choose(sort.getByRole('combobox', { name: 'Sort by', exact: true }), `field:${field.id}`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: `Field test ${suffix}`, exact: true })).toBeVisible();
  // The server counts what the field condition keeps: this one contact.
  await expect(page.getByRole('status').filter({ hasText: /Contacts?$/ })).toHaveText('1 Contact');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sort (1)', exact: true })).toBeVisible();
  const reopened = await openFilters(page);
  await expect(reopened.getByLabel('Field value', { exact: true })).toHaveValue('9007199254740994');
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: `Field test ${suffix}`, exact: true }).click();
  await fields.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
  await fields.getByRole('button', { name: 'Clear value', exact: true }).click();
  await expect(fields.getByText('KES 9007199254740994.1250', { exact: true })).toHaveCount(0);
  const cleared = recordFields.parse(
    await (await page.request.get(`${api}/records/${saved.id}/fields`, { headers })).json(),
  );
  expect(cleared.items.find((item) => item.definition.id === field.id)).toMatchObject({
    value: null,
    source: null,
    confirmedAt: null,
  });
});
