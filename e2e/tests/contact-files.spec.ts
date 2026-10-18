// A contact's files on the whole product: the built dashboard and server over a migrated
// Postgres, with the files service on disk. A person makes a file upload field, uploads a
// file to it and a document to the contact from the contact page, saves one through its
// short-lived link, and deletes it; the server keeps exactly that.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, fieldDefinition, me, recordFields, recordFilesPage } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.215'));

test('uploads to a file field and to the contact, saves a file through its link and deletes it', async ({
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
  const made = await page.request.post(`${api}/fields`, {
    headers,
    data: {
      objectKey: 'contact',
      key: `contract_${suffix}`,
      label: `Contract ${suffix}`,
      description: 'The signed contract.',
      valueType: 'file',
      files: { formats: ['pdf'], limit: 1 },
      options: [],
      currency: null,
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const field = fieldDefinition.parse(await made.json());
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: `Files ${suffix}`, emails: [`files-${suffix}@example.test`] },
  });
  expect(created.status()).toBe(201);
  const saved = contact.parse(await created.json());

  // The field's own upload, on the contact page.
  await page.goto(inOurs(`/contacts/${saved.id}`));
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  const label = `Contract ${suffix}`;
  await expect(fields.getByText('No file yet.')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await fields.getByRole('button', { name: `Upload a file to ${label}`, exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'contract.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n'),
  });
  const inField = fields.getByRole('list', { name: `Files in ${label}`, exact: true });
  await expect(inField).toContainText('contract.pdf');
  const value = recordFields
    .parse(await (await page.request.get(`${api}/records/${saved.id}/fields`, { headers })).json())
    .items.find((item) => item.definition.id === field.id)?.value;
  expect(Array.isArray(value) ? value.length : 0).toBe(1);

  // A document of the contact's own, in the Documents panel.
  await page.goto(inOurs(`/contacts/${saved.id}?view=documents`));
  const documents = page.getByRole('region', { name: 'Documents', exact: true });
  await documents.locator('input[type="file"]').setInputFiles({
    name: 'guests.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Email\r\nAnn,ann@example.test\r\n'),
  });
  const list = documents.getByRole('list', { name: 'Documents of this contact', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // Saving one: a five-minute link, the bytes as uploaded.
  const download = page.waitForEvent('download');
  await list.getByRole('button', { name: 'Download guests.csv', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('guests.csv');

  // Deleting one asks first, and then it is gone from the server too.
  await list.getByRole('button', { name: 'Delete guests.csv', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete guests.csv?' })
    .getByRole('button', { name: 'Delete file', exact: true })
    .click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  const left = recordFilesPage.parse(
    await (await page.request.get(`${api}/records/${saved.id}/files`, { headers })).json(),
  );
  expect(left.items.map((item) => [item.filename, item.field?.id ?? null])).toEqual([
    ['contract.pdf', field.id],
  ]);
});
