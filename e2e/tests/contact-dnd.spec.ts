// Do not disturb on the contact page, on the whole product: the built dashboard and server
// over a migrated Postgres. A person turns do not disturb on for calls and web chat and
// turns inbound do not disturb on, and the server keeps exactly that, with the reason in
// the audit log.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, contactDetails, me } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.129'));

test('turns do not disturb on for calls, web chat and inbound messages, and the server keeps it', async ({
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
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: `Quiet ${suffix}`, emails: [`quiet-${suffix}@example.test`] },
  });
  expect(created.status()).toBe(201);
  const saved = contact.parse(await created.json());

  await page.goto(inOurs(`/contacts/${saved.id}?tab=dnd`));
  const switches = page.getByRole('region', { name: 'Do not disturb', exact: true });
  for (const name of [
    'DND all channels',
    'Email',
    'Text messages',
    'Calls & Voicemails',
    'Web chat',
    'Inbound Calls and SMS',
  ])
    await expect(switches.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  // WhatsApp sends nothing yet, so it is not offered.
  await expect(switches.getByText(/WhatsApp/)).toHaveCount(0);

  await switches.getByRole('checkbox', { name: 'Calls & Voicemails', exact: true }).check();
  await switches.getByRole('checkbox', { name: 'Web chat', exact: true }).check();
  await switches.getByRole('checkbox', { name: 'Inbound Calls and SMS', exact: true }).check();
  await switches
    .getByLabel('Reason')
    .fill('Asked to hear nothing more from us, and texts at night.');
  await switches.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(switches.getByLabel('Reason')).toHaveCount(0);

  const read = async () =>
    contactDetails.parse(
      await (await page.request.get(`${api}/contacts/${saved.id}/details`, { headers })).json(),
    ).dnd;
  expect(await read()).toMatchObject({ all: false, channels: ['call', 'webchat'], inbound: true });

  await page.reload();
  for (const name of ['Calls & Voicemails', 'Web chat', 'Inbound Calls and SMS'])
    await expect(switches.getByRole('checkbox', { name, exact: true })).toBeChecked();
  await expect(switches.getByRole('checkbox', { name: 'Email', exact: true })).not.toBeChecked();

  // Inbound off again, from the page; the outbound channels stay as they are.
  await switches.getByRole('checkbox', { name: 'Inbound Calls and SMS', exact: true }).uncheck();
  await switches.getByLabel('Reason').fill('Texts are welcome again, said on the phone today.');
  await switches.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(switches.getByLabel('Reason')).toHaveCount(0);
  expect(await read()).toMatchObject({ channels: ['call', 'webchat'], inbound: false });

  // Each change is in the audit log with its reason.
  await page
    .getByRole('region', { name: 'Contact Details', exact: true })
    .getByRole('button', { name: 'Audit logs', exact: true })
    .click();
  const log = page.getByRole('dialog', { name: 'Audit logs', exact: true });
  await expect(log).toContainText('Reason: Texts are welcome again, said on the phone today.');
  await expect(log).toContainText(
    'Reason: Asked to hear nothing more from us, and texts at night.',
  );
});
