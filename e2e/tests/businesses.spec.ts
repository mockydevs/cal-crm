import { randomUUID } from 'node:crypto';

import { expect, test, type Request } from '@playwright/test';
import { tagConfiguration } from '@repo/contracts';

import { address, asClient } from '../servers.js';
import { query, signInByLink, type Person } from '../signing-in.js';
import { choose } from '../select.js';

// Agency staff move between the agency's businesses. Each page works in the business its
// address names, so what's made in one business stays in it.
test.use(asClient('203.0.113.50'));

const lakeside = { name: 'Lakeside Dental', slug: 'lakeside-dental' } as const;
const meadow = { name: 'Meadow Florists', slug: 'meadow-florists' } as const;

/**
 * An agency of its own, with two businesses and a member of staff. Another file makes the
 * shared agency require two-factor sign-in for a while, which would refuse this staff.
 */
async function anAgencyOfItsOwn(): Promise<Person & { readonly agency: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await query<{ id: string; email: string }>(
    `with agency as (
       insert into tenancy.agencies (name, slug) values ($1, $2) returning id
     ), businesses as (
       insert into tenancy.businesses (agency_id, name, slug)
       select agency.id, b.name, b.slug from agency,
         (values ($3, $4), ($5, $6)) as b (name, slug)
     ), role as (
       insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       select id, 'agency', 'admin', 'Admin', true from agency returning id, agency_id
     ), person as (
       insert into auth.users (email, name) values ($7, $8) returning id, email
     ), membership as (
       insert into tenancy.memberships (user_id, agency_id, role_id)
       select person.id, role.agency_id, role.id from person, role
     )
     select id, email from person`,
    [
      `Agency ${suffix}`,
      `agency-${suffix}`,
      lakeside.name,
      lakeside.slug,
      meadow.name,
      meadow.slug,
      `staff-${suffix}@agency.example`,
      `Staff ${suffix}`,
    ],
  );
  if (person === undefined) throw new Error('Making the agency returned no row.');
  return { ...person, agency: `agency-${suffix}` };
}

/** The business a request to the API named, by its Business-Id header. */
const businessOf = (request: Request): string | undefined => request.headers()['business-id'];

test('agency staff switch between businesses, and each keeps its own tags', async ({ page }) => {
  const staff = await anAgencyOfItsOwn();
  const name = `Switched ${randomUUID().slice(0, 8)}`;
  const tags = page.getByRole('region', { name: 'Tags' });
  let meadowId: string | undefined;

  await test.step('signed in, staff start on the list of every business', async () => {
    await page.goto(`${address('app')}/sign-in`);
    await signInByLink(page, staff.email, 1);
    await expect(page).toHaveURL(`${address('app')}/agency`);
    const list = page.getByRole('list', { name: 'Businesses' });
    await expect(list.getByRole('link')).toHaveCount(2);
    await list.getByRole('link', { name: meadow.name }).click();
    await expect(page).toHaveURL(`${address('app')}/b/${meadow.slug}`);
    // The address can change while the previous agency page is still being replaced.
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  await test.step('they make a tag in that business', async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: 'Tags' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
    await page.getByRole('button', { name: 'New tag' }).click();
    await page.getByLabel('Name').fill(name);
    const created = page.waitForRequest(
      (request) => request.url().endsWith('/api/v1/tags') && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create tag' }).click();
    meadowId = businessOf(await created);
    expect(meadowId).toMatch(/^biz_/);
    await expect(tags.getByRole('row', { name: new RegExp(name) })).toBeVisible();
  });

  await test.step('the switcher takes them to the same page in the other business', async () => {
    const listed = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/tag-configuration') &&
        response.request().method() === 'GET' &&
        businessOf(response.request()) !== meadowId,
    );
    await page.getByRole('combobox', { name: /^Business:/ }).click();
    await page.getByRole('option', { name: lakeside.name }).click();

    await expect(page).toHaveURL(`${address('app')}/b/${lakeside.slug}/settings/tags`);
    const theirTags = await listed;
    expect(theirTags.status()).toBe(200);
    expect(businessOf(theirTags.request())).toMatch(/^biz_/);
    const names = tagConfiguration.parse(await theirTags.json()).items.map((tag) => tag.name);
    expect(names).not.toContain(name);
    await expect(tags.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);
  });

  await test.step('the tag is in that business only, and back there it is listed', async () => {
    const rows = await query<{ slug: string }>(
      `select b.slug from crm.tags t join tenancy.businesses b on b.id = t.business_id
       where t.name = $1`,
      [name],
    );
    expect(rows).toEqual([{ slug: meadow.slug }]);

    await page.goBack();
    await expect(page).toHaveURL(`${address('app')}/b/${meadow.slug}/settings/tags`);
    await expect(tags.getByRole('row', { name: new RegExp(name) })).toBeVisible();
  });
});

/** Someone whose only business, in an agency of its own, is suspended. */
async function aMemberOfAClosedBusiness(): Promise<Person> {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await query<{ id: string; email: string }>(
    `with agency as (
       insert into tenancy.agencies (name, slug) values ($1, $2) returning id
     ), business as (
       insert into tenancy.businesses (agency_id, name, slug, status)
       select id, $3, 'closed', 'suspended' from agency returning id, agency_id
     ), role as (
       insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       select id, 'business', 'member', 'Member', true from agency returning id
     ), person as (
       insert into auth.users (email, name) values ($4, $5) returning id, email
     ), membership as (
       insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select person.id, business.agency_id, business.id, role.id from person, business, role
     )
     select id, email from person`,
    [
      `Agency ${suffix}`,
      `agency-${suffix}`,
      `Closed ${suffix}`,
      `member-${suffix}@agency.example`,
      `Member ${suffix}`,
    ],
  );
  if (person === undefined) throw new Error('Making the business returned no row.');
  return person;
}

test('someone whose only business is suspended is told no business is open', async ({ page }) => {
  const member = await aMemberOfAClosedBusiness();

  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, member.email, 1);

  await expect(page).toHaveURL(`${address('app')}/`);
  await expect(page.getByText('No business is open to you')).toBeVisible();
  const refused = await page.request.get(`${address('app')}/api/v1/tags`);
  expect(refused.status()).toBe(403);
});

test('agency staff create a business, which starts with what every business has', async ({
  page,
}) => {
  const staff = await anAgencyOfItsOwn();

  await test.step('they fill in the new business form on the agency page', async () => {
    await page.goto(`${address('app')}/sign-in`);
    await signInByLink(page, staff.email, 1);
    await expect(page).toHaveURL(`${address('app')}/agency`);
    await page.getByRole('button', { name: 'New business' }).click();
    const form = page.getByRole('region', { name: 'New business' });
    await form.getByLabel('Name').fill('Orchard Café');
    await choose(form.getByLabel('Time zone'), 'Africa/Nairobi');
    await choose(form.getByLabel('Currency'), 'KES');
    await form.getByRole('button', { name: 'Create business' }).click();
  });

  await test.step('the new business opens, and the switcher lists it', async () => {
    await expect(page).toHaveURL(`${address('app')}/b/orchard-cafe`);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await page.getByRole('combobox', { name: /^Business:/ }).click();
    // The agency first, then the business the page is in, then the others by name.
    await expect(page.getByRole('option')).toHaveText([
      /^Agency view/,
      /^OCOrchard Café/,
      /^LDLakeside Dental/,
      /^MFMeadow Florists/,
    ]);
  });

  await test.step('it has its settings, and the CRM made its types and pipeline', async () => {
    const rows = await query<{
      timezone: string;
      currency: string;
      types: string[];
      pipelines: string[];
    }>(
      `select b.timezone, b.currency,
              array(select o.key from crm.object_types o
                    where o.business_id = b.id order by o.key) as types,
              array(select p.name from crm.pipelines p where p.business_id = b.id) as pipelines
       from tenancy.businesses b join tenancy.agencies a on a.id = b.agency_id
       where a.slug = $1 and b.slug = 'orchard-cafe'`,
      [staff.agency],
    );
    expect(rows).toEqual([
      {
        timezone: 'Africa/Nairobi',
        currency: 'KES',
        types: ['company', 'contact', 'deal'],
        pipelines: ['Sales'],
      },
    ]);
  });
});
