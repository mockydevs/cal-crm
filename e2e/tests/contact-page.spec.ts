import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { contact, fieldDefinition, me, recordActivity } from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, query, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';

test.use(asClient('203.0.113.123'));
test('reads saved contact context and pages all real changes newest first, including after reload and trash', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const email = `memory-${suffix}@example.test`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const profile = me.parse(await (await page.request.get(`${address('app')}/api/v1/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('Contact-page fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const api = `${address('app')}/api/v1`;
  const created = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: `Maya ${suffix}`, emails: [email] },
  });
  expect(created.status()).toBe(201);
  const saved = contact.parse(await created.json());
  for (let index = 1; index <= 60; index++) {
    const changed = await page.request.patch(`${api}/contacts/${saved.id}`, {
      headers,
      data: { lastName: `Change ${String(index)}` },
    });
    expect(changed.status()).toBe(200);
  }
  const field = await page.request.post(`${api}/fields`, {
    headers,
    data: {
      objectKey: 'contact',
      key: `budget_${suffix}`,
      label: `Budget ${suffix}`,
      description: 'The agreed event budget.',
      valueType: 'money',
      currency: 'KES',
      options: [],
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
    },
  });
  expect(field.status()).toBe(201);
  const definition = fieldDefinition.parse(await field.json());
  await query(
    `with record as (
    select c.id,c.business_id from crm.contacts c join crm.contact_identities i
    on i.business_id=c.business_id and i.contact_id=c.id where i.kind='email' and i.value_normalized=$1
  ), latest as (
    select e.id from events.events e,record where e.business_id=record.business_id and e.subject_id=record.id order by e.occurred_at desc,e.id desc limit 1
  ), memory as (
    insert into ai.contact_summaries(business_id,contact_id,summary,model,through_event_id)
    select record.business_id,record.id,'Planning an outdoor wedding in October.','fixture-model',latest.id from record,latest
  ) insert into crm.field_values(business_id,record_id,field_id,value_type,value_number,source_kind,source_event_id)
    select record.business_id,record.id,f.id,'money',9007199254740993.25,'ai_agent',latest.id
    from record,latest,crm.field_definitions f where f.business_id=record.business_id and f.key=$2`,
    [email, definition.key],
  );
  const first = recordActivity.parse(
    await (await page.request.get(`${api}/records/${saved.id}/activity`, { headers })).json(),
  );
  expect(first.items).toHaveLength(50);
  if (first.next === null) throw new Error('Expected another activity page.');
  const second = recordActivity.parse(
    await (
      await page.request.get(`${api}/records/${saved.id}/activity?after=${first.next}`, { headers })
    ).json(),
  );
  expect(second.items).toHaveLength(11);
  expect(second.next).toBeNull();
  const expected = [...first.items, ...second.items];
  await page.goto(inOurs(`/contacts/${saved.id}`));
  await expect(page.getByRole('region', { name: 'What your assistant knows' })).toContainText(
    'Planning an outdoor wedding in October.',
  );
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await expect(fields.getByText('KES 9007199254740993.25', { exact: true })).toBeVisible();
  await expect(fields.getByText('AI assistant', { exact: true })).toBeVisible();
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  await expect(activity.getByRole('listitem')).toHaveCount(50);
  await activity.getByRole('button', { name: 'Load older activity' }).click();
  await expect(activity.getByRole('listitem')).toHaveCount(61);
  expect(
    await Promise.all(
      (await activity.getByRole('listitem').locator('time').all()).map((time) =>
        time.getAttribute('datetime'),
      ),
    ),
  ).toEqual(expected.map((entry) => entry.occurredAt));
  await expect(activity.getByRole('listitem').last()).toContainText('Contact created');
  await activity
    .getByRole('listitem')
    .last()
    .getByRole('button', { name: 'Why this change happened' })
    .click();
  await expect(activity.getByRole('region', { name: 'Why this change happened' })).toContainText(
    'Contact created',
  );
  await page.reload();
  await expect(fields.getByText('KES 9007199254740993.25', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByText('This contact is in the trash.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'What your assistant knows' })).toContainText(
    'Planning an outdoor wedding in October.',
  );
  await expect(fields.getByText('KES 9007199254740993.25', { exact: true })).toBeVisible();
});

test('a contact added in the panel keeps its label, time zone and do not disturb, and takes an owner and a follower', async ({
  page,
}) => {
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const name = `Panel ${suffix}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(inOurs('/contacts'));
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Add Contact', exact: true });
  await panel.getByLabel('First name').fill(name);
  await panel.getByLabel('Email 1', { exact: true }).fill(`panel-${suffix}@example.test`);
  // A number of its own: another contact of this business may hold any fixed one.
  const digits = String(parseInt(suffix, 16) % 10_000_000).padStart(7, '0');
  await panel
    .getByLabel('Phone 1', { exact: true })
    .fill(`+254 71${digits.slice(0, 1)} ${digits.slice(1)}`);
  await choose(panel.getByRole('combobox', { name: 'Label for phone 1', exact: true }), 'mobile');
  await panel.getByRole('combobox', { name: 'Time zone' }).fill('Nairobi');
  await page.getByRole('option', { name: /Nairobi/ }).click();
  await panel.getByRole('checkbox', { name: 'Text messages', exact: true }).check();
  await panel.getByLabel('Reason').fill('Asked by phone to get no more text messages.');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  // Everything was saved: the line names nothing that was not.
  await expect(page.getByRole('status').filter({ hasText: `${name} added.` })).toBeVisible();
  await page.getByRole('link', { name: 'Open contact', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const details = page.getByRole('region', { name: 'Contact Details', exact: true });
  const fields = page.getByRole('region', { name: 'Fields', exact: true });
  await expect(fields.getByRole('combobox', { name: /^Label for / })).toHaveText('Mobile');
  await expect(details.getByText('Created by You, in the app', { exact: true })).toBeVisible();

  const owner = details.getByRole('combobox', { name: 'Owner', exact: true });
  await expect(owner).toHaveText('No owner');
  await owner.click();
  await page.getByRole('option', { name: 'You', exact: true }).click();
  await expect(owner).toHaveText('You');
  const followers = details.getByRole('button', { name: /^Followers/ });
  await followers.click();
  // The box is ticked once the server has answered.
  const me = page
    .getByRole('dialog', { name: 'Followers', exact: true })
    .getByRole('checkbox', { name: 'You', exact: true });
  await me.click();
  await expect(me).toBeChecked();
  await expect(followers).toHaveText('You');
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(owner).toHaveText('You');
  await expect(followers).toHaveText('You');
  await page
    .getByRole('navigation', { name: 'Contact details', exact: true })
    .getByRole('link', { name: 'DND', exact: true })
    .click();
  const switches = page.getByRole('region', { name: 'Do not disturb', exact: true });
  await expect(
    switches.getByRole('checkbox', { name: 'Text messages', exact: true }),
  ).toBeChecked();
  await expect(switches.getByRole('checkbox', { name: 'Email', exact: true })).not.toBeChecked();
  await expect(
    page.getByRole('region', { name: 'Time zone and do not contact' }).getByText(/Nairobi/),
  ).toBeVisible();
  await switches.getByRole('checkbox', { name: 'Email', exact: true }).check();
  await switches.getByLabel('Reason').fill('Asked by email to get no more email either.');
  await switches.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(switches.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(switches.getByRole('checkbox', { name: 'Email', exact: true })).toBeChecked();

  // The owner of the business may read the audit log: each change is there with its reason.
  await details.getByRole('button', { name: 'Audit logs', exact: true }).click();
  const log = page.getByRole('dialog', { name: 'Audit logs', exact: true });
  await expect(log.getByRole('listitem').first()).toContainText('Do not disturb changed');
  await expect(log.getByRole('listitem').first()).toContainText(
    'Reason: Asked by email to get no more email either.',
  );
  await expect(log).toContainText('Reason: Asked by phone to get no more text messages.');
  await expect(log).toContainText('Owner changed');
  await expect(log).toContainText('Followers added');
  await expect(log.getByRole('listitem').last()).toContainText('Contact created');
});
