import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { me, recordActivity, recordTagList, tagConfiguration } from '@repo/contracts';
import { address, asClient } from '../servers.js';
import { query, signInByLink } from '../signing-in.js';
import { choose, expectChosen } from '../select.js';

test.use(asClient('203.0.113.119'));
test('configures grouped tags and records assignment sources and exact history through the real API', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const slug = `tags-${suffix}`;
  const email = `${slug}@example.test`;
  await query(
    `with agency as (
    insert into tenancy.agencies (name, slug) values ($1, $2) returning id
  ), business as (
    insert into tenancy.businesses (agency_id, name, slug, address)
    select id, 'Tags business', $2, '{"country": "KE"}' from agency returning id, agency_id
  ), types as (
    insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
    select business.id, kind, kind, initcap(kind), initcap(kind) || 's'
    from business, unnest(array['contact', 'company', 'deal']) as kind
  ), role as (
    insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
    select id, 'business', 'owner', 'Owner', true from agency returning id
  ), person as (
    insert into auth.users (email, name) values ($3, 'Tags owner') returning id
  ) insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
    select person.id, business.agency_id, business.id, role.id from person, business, role`,
    [`Tags agency ${suffix}`, slug, email],
  );
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, email, 1);
  const profile = me.parse(await (await page.request.get(`${address('app')}/api/v1/me`)).json());
  const business = profile.businesses.find((item) => item.slug === slug);
  if (business === undefined) throw new Error('Tags fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const path = `${address('app')}/b/${slug}`;
  await page.goto(`${path}/settings/tags`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Audience');
  await page.getByLabel('What it means').fill('Customer segments.');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.getByRole('button', { name: 'New tag', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Hot lead');
  await page.getByLabel('What it means').fill('Asked for a quote.');
  await choose(page.getByLabel('Group', { exact: true }), { label: 'Audience' });
  await page.getByRole('button', { name: 'Create tag', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Created the tag Hot lead.');
  await page.getByRole('button', { name: 'New tag', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Hot laed');
  await page.getByRole('button', { name: 'Use existing Hot lead' }).click();
  const rules = page.getByRole('region', { name: 'Tag rules' });
  await choose(rules.getByLabel('Who can create new tags'), 'everyone');
  await rules.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByRole('status')).toHaveText('Tag rules saved.');
  await page.reload();
  await expectChosen(rules.getByLabel('Who can create new tags'), 'everyone');
  const configured = tagConfiguration.parse(
    await (
      await page.request.get(`${address('app')}/api/v1/tag-configuration`, { headers })
    ).json(),
  );
  expect(configured.items).toHaveLength(1);
  expect(configured.items[0]?.groupId).toBe(configured.groups[0]?.id);
  const tagId = configured.items[0]?.id;
  if (tagId === undefined) throw new Error('No configured tag.');

  // The address the new-contact page had opens the list with the Add Contact panel.
  await page.goto(`${path}/contacts/new`);
  const adding = page.getByRole('dialog', { name: 'Add Contact', exact: true });
  await adding.getByLabel('First name').fill('Maya');
  await adding.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('link', { name: 'Open contact', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Maya' })).toBeVisible();
  const recordId = new URL(page.url()).pathname.split('/').at(-1);
  if (recordId === undefined) throw new Error('No contact id in address.');
  const tags = page.getByRole('region', { name: 'Tags', exact: true });
  // A tag is a chip. The plus beside the title offers the tags that can be added, and
  // pressing a chip says what the tag means, who added it and why.
  const chip = tags.getByRole('button', { name: 'Hot lead', exact: true });
  const addingTag = page.getByRole('dialog', { name: 'Add a tag', exact: true });
  const about = page.getByRole('dialog', { name: 'Hot lead', exact: true });
  const addHotLead = async (): Promise<void> => {
    await tags.getByRole('button', { name: 'Add tag', exact: true }).click();
    await addingTag.getByRole('button', { name: 'Hot lead', exact: true }).click();
    await expect(chip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(addingTag).toBeHidden();
  };
  await addHotLead();
  await chip.click();
  await expect(about.getByText('You', { exact: true })).toBeVisible();
  await page.reload();
  await chip.click();
  await expect(about.getByText('Asked for a quote.', { exact: true })).toBeVisible();
  await expect(about.getByText('You', { exact: true })).toBeVisible();
  const resource = `${address('app')}/api/v1/records/${recordId}`;
  const assigned = recordTagList.parse(
    await (await page.request.get(`${resource}/tags`, { headers })).json(),
  );
  expect(assigned.items[0]?.source).toMatchObject({ kind: 'user', you: true });
  expect(assigned.items[0]?.source.eventId).not.toBeNull();
  expect(
    (await page.request.put(`${resource}/tags/${tagId}`, { headers, data: {} })).status(),
  ).toBe(200);
  const history = async () =>
    recordActivity.parse(
      await (await page.request.get(`${resource}/activity`, { headers })).json(),
    );
  expect((await history()).items.filter((item) => item.type === 'tag.assigned')).toHaveLength(1);
  await about.getByRole('button', { name: 'Why Hot lead was added' }).click();
  await expect(
    about
      .getByRole('region', { name: 'Why Hot lead was added' })
      .getByText('Tag assigned', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
  await tags.getByRole('button', { name: 'Remove Hot lead', exact: true }).click();
  await expect(chip).toBeHidden();
  expect((await page.request.delete(`${resource}/tags/${tagId}`, { headers })).status()).toBe(204);
  expect((await history()).items.filter((item) => item.type === 'tag.removed')).toHaveLength(1);
  // A name nobody has made yet becomes a tag of the business and goes on the record, in
  // one step: the rules saved above let everyone create tags.
  await tags.getByRole('button', { name: 'Add tag', exact: true }).click();
  await addingTag.getByRole('textbox', { name: 'Tag name', exact: true }).fill('Walk in');
  await addingTag.getByRole('button', { name: 'Create tag Walk in', exact: true }).click();
  await expect(tags.getByRole('button', { name: 'Walk in', exact: true })).toBeVisible();
  // A name that differs only in case and spacing is the tag already on the record.
  await addingTag.getByRole('textbox', { name: 'Tag name', exact: true }).fill('walk-in');
  await expect(addingTag.getByText('This tag is already on the record.')).toBeVisible();
  await expect(addingTag.getByRole('button', { name: /Create tag/ })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(addingTag).toBeHidden();
  const made = tagConfiguration.parse(
    await (
      await page.request.get(`${address('app')}/api/v1/tag-configuration`, { headers })
    ).json(),
  );
  expect(made.items.map((item) => item.name).sort()).toEqual(['Hot lead', 'Walk in']);
  const onRecord = recordTagList.parse(
    await (await page.request.get(`${resource}/tags`, { headers })).json(),
  );
  expect(onRecord.items.map((item) => [item.tag.name, item.source.kind, item.source.you])).toEqual([
    ['Walk in', 'user', true],
  ]);
  await addHotLead();
  await page.reload();
  await expect(chip).toBeVisible();
  await expect(tags.getByRole('button', { name: 'Walk in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByText('This contact is in the trash.')).toBeVisible();
  await expect(chip).toBeVisible();
  await expect(tags.getByRole('button', { name: 'Add tag', exact: true })).toBeHidden();
  await expect(tags.getByRole('button', { name: /Remove / })).toBeHidden();
  expect(
    (await page.request.put(`${resource}/tags/${tagId}`, { headers, data: {} })).status(),
  ).toBe(409);
});
