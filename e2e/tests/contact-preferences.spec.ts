import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, me, timeZoneList } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, query, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.141'));
test("sets a contact's time zone from the server's own list and turns do not contact on with a reason, through every layer", async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const profile = me.parse(await (await page.request.get(`${address('app')}/api/v1/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('Contact-preferences fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const api = `${address('app')}/api/v1`;
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: `Zone ${suffix}`, emails: [`zone-${suffix}@example.test`] },
  });
  expect(created.status()).toBe(201);
  const saved = contact.parse(await created.json());
  expect(saved).toMatchObject({ timeZone: null, doNotContact: false });
  const read = async () =>
    contact.parse(
      await (await page.request.get(`${api}/contacts/${saved.id}`, { headers })).json(),
    );

  // The list the picker shows is PostgreSQL's own.
  const zones = timeZoneList.parse(
    await (await page.request.get(`${api}/time-zones`, { headers })).json(),
  );
  expect(zones.items).toEqual(expect.arrayContaining(['Africa/Nairobi', 'UTC']));
  const listed = await query<{ name: string }>('select name from pg_catalog.pg_timezone_names', []);
  const names = new Set(listed.map((row) => row.name));
  expect(zones.items.every((name) => names.has(name))).toBe(true);

  await page.goto(inOurs(`/contacts/${saved.id}?tab=dnd`));
  const panel = page.getByRole('region', { name: 'Time zone and do not contact', exact: true });
  await expect(panel.getByText(/This contact has no time zone\./)).toBeVisible();
  await panel.getByRole('button', { name: 'Set time zone' }).click();
  const box = panel.getByRole('combobox', { name: 'Time zone' });
  await expect(box).toBeFocused();
  await page.keyboard.type('nairobi');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(box).toHaveValue('Africa/Nairobi');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('status')).toHaveText('Time zone saved.');
  expect(await read()).toMatchObject({ timeZone: 'Africa/Nairobi', doNotContact: false });

  await panel.getByRole('button', { name: 'Turn on do not contact' }).click();
  const reason = `Asked by phone not to be contacted (${suffix}).`;
  await panel.getByLabel('Why?').fill(reason);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('status')).toHaveText('Do not contact is on.');
  expect(await read()).toMatchObject({ timeZone: 'Africa/Nairobi', doNotContact: true });
  // The consent panel reads the contact again and says the same.
  await expect(
    page.getByRole('region', { name: 'Consent', exact: true }).getByText(/Do not contact is on\./),
  ).toBeVisible();

  // What the send check reads, the reason kept with the command, and the events.
  const [stored] = await query<{ timezone: string | null; do_not_contact: boolean }>(
    `select c.timezone, c.do_not_contact from crm.contacts c
     join crm.contact_identities i on i.business_id = c.business_id and i.contact_id = c.id
     where i.value_normalized = $1`,
    [`zone-${suffix}@example.test`],
  );
  expect(stored).toEqual({ timezone: 'Africa/Nairobi', do_not_contact: true });
  const audited = await query<{ reason: string | null }>(
    `select input ->> 'doNotContactReason' as reason from audit.commands
     where command = 'contact.update' and input ->> 'doNotContactReason' = $1`,
    [reason],
  );
  expect(audited).toEqual([{ reason }]);
  const events = await query<{ type: string; payload: unknown }>(
    `select e.type, e.payload from events.events e
     join crm.contact_identities i on i.business_id = e.business_id and i.contact_id = e.subject_id
     where i.value_normalized = $1 and e.type <> 'contact.created' order by e.recorded_at, e.id`,
    [`zone-${suffix}@example.test`],
  );
  expect(events).toEqual([
    { type: 'contact.updated', payload: { changed: ['timeZone'] } },
    { type: 'contact.do_not_contact_set', payload: {} },
  ]);

  // After a reload both are still shown, and the change is on the contact's activity.
  await page.reload();
  await expect(panel.getByText('Africa/Nairobi', { exact: true })).toBeVisible();
  await expect(panel.getByText('On', { exact: true })).toBeVisible();
  await expect(page.getByText('Do not contact turned on').first()).toBeVisible();
});
