import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { address, asClient } from '../servers.js';
import { query, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';
import { openSort } from '../lists.js';

// Against the real stack: a member adds, changes and trashes a contact, and a duplicate
// email address leads to the contact holding it, or restores it from the trash.
test.use(asClient('203.0.113.111'));

/** Fills the Add Contact panel over the list and saves it. */
async function addContact(page: Page, slug: string, fields: Record<string, string>) {
  await page.goto(`${address('app')}/b/${slug}/contacts`);
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Add Contact', exact: true });
  for (const [label, value] of Object.entries(fields))
    await panel.getByLabel(label, { exact: true }).fill(value);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
}

test('a duplicate email address links its contact, or restores it from the trash', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `contacts-${suffix}@example.test`;
  const slug = 'contacts-business';
  // A business made as business.create makes one: in Kenya, with its object types.
  await query(
    `with agency as (
       insert into tenancy.agencies (name, slug) values ($1, $2) returning id
     ), business as (
       insert into tenancy.businesses (agency_id, name, slug, address)
       select id, 'Contacts business', $4, '{"country": "KE"}' from agency
       returning id, agency_id
     ), types as (
       insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
       select business.id, kind, kind, initcap(kind), initcap(kind) || 's'
       from business, unnest(array['contact', 'company', 'deal']) as kind
     ), role as (
       insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       select id, 'business', 'member', 'Member', true from agency returning id
     ), person as (
       insert into auth.users (email, name) values ($3, 'Contacts member') returning id
     ) insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select person.id, business.agency_id, business.id, role.id from person, business, role`,
    [`Contacts agency ${suffix}`, `contacts-${suffix}`, email, slug],
  );
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, email, 1);

  await addContact(page, slug, {
    'First name': 'Maya',
    'Last name': 'Thompson',
    'Email 1': ' Maya@Example.com ',
    'Phone 1': '0712 345678',
  });
  // The panel closes over the list, which says what was added and leads to it.
  await expect(page.getByRole('status').filter({ hasText: 'Maya Thompson added.' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Maya Thompson');
  await page.getByRole('link', { name: 'Open contact', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Maya Thompson' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'maya@example.com' })).toBeVisible();
  await expect(page.getByRole('link', { name: '0712 345678' })).toHaveAttribute(
    'href',
    'tel:+254712345678',
  );

  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Last name').fill('Okafor');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Maya Okafor' })).toBeVisible();

  // The same address, written differently, belongs to Maya.
  await addContact(page, slug, { 'First name': 'Someone', 'Email 1': 'MAYA@example.com' });
  await expect(page.getByText('Another contact has this email address.')).toBeVisible();
  await page.getByRole('link', { name: 'Open Maya Okafor' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Maya Okafor' })).toBeVisible();

  await page.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByText('This contact is in the trash.')).toBeVisible();

  // In the trash, the address is still hers: the form offers to restore her.
  await addContact(page, slug, { 'First name': 'Maya', 'Phone 1': '+254 712 345 678' });
  await expect(
    page.getByText('A contact in the trash has this phone number. Restore it instead.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Restore Maya Okafor' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Maya Okafor' })).toBeVisible();
  await expect(page.getByText('This contact is in the trash.')).toBeHidden();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Maya Okafor' })).toBeVisible();
  await expect(page.getByText('This contact is in the trash.')).toBeHidden();
  const events = await query<{ type: string }>(
    `select e.type from events.events e join tenancy.businesses b on b.id = e.business_id
     where b.slug = $1 and b.agency_id = (select id from tenancy.agencies where slug = $2)
     order by e.recorded_at, e.id`,
    [slug, `contacts-${suffix}`],
  );
  expect(events.map((event) => event.type)).toEqual([
    'contact.created',
    'contact.updated',
    'contact.trashed',
    'contact.restored',
  ]);
});

test('the list finds names, email addresses and phone fragments, and pages', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `contact-list-${suffix}@example.test`;
  const slug = 'contact-list-business';
  // 60 guests in a Kenyan business: "Guest 07", guest7@example.test, +254712000007.
  await query(
    `with agency as (
       insert into tenancy.agencies (name, slug) values ($1, $2) returning id
     ), business as (
       insert into tenancy.businesses (agency_id, name, slug, address)
       select id, 'Contact list business', $4, '{"country": "KE"}' from agency
       returning id, agency_id
     ), types as (
       insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
       select business.id, kind, kind, initcap(kind), initcap(kind) || 's'
       from business, unnest(array['contact', 'company', 'deal']) as kind
       returning business_id, id, kind
     ), numbered as (
       select n, uuidv7() as id from generate_series(1, 60) as n
     ), records as (
       insert into crm.records (business_id, id, kind, object_type_id)
       select types.business_id, numbered.id, 'contact', types.id
       from numbered, types where types.kind = 'contact'
     ), contacts as (
       insert into crm.contacts (business_id, id, first_name, last_name, created_by_kind, created_at)
       select business.id, numbered.id, 'Guest', lpad(n::text, 2, '0'), 'import', now() - n * interval '1 minute'
       from numbered, business
     ), identities as (
       insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
       select business.id, numbered.id, kind, value, value, true
       from numbered, business,
         lateral (values ('email', 'guest' || n || '@example.test'),
                         ('phone', '+25471200' || lpad(n::text, 4, '0'))) as each (kind, value)
     ), role as (
       insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       select id, 'business', 'member', 'Member', true from agency returning id
     ), person as (
       insert into auth.users (email, name) values ($3, 'List member') returning id
     ) insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select person.id, business.agency_id, business.id, role.id from person, business, role`,
    [`Contact list agency ${suffix}`, `contact-list-${suffix}`, email, slug],
  );
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, email, 1);
  await page.goto(`${address('app')}/b/${slug}/contacts`);
  const rows = page.getByRole('table', { name: 'Contacts' }).locator('tbody tr[data-index]');
  const count = page.getByRole('status').filter({ hasText: /Contacts?$/ });
  const shown = page.getByRole('navigation', { name: 'Pages' }).getByRole('status');

  await expect(page.getByRole('link', { name: 'Guest 01' })).toBeVisible();
  // The server counts all 60, and a page holds 50 of them.
  await expect(count).toHaveText('60 Contacts');
  await expect(shown).toHaveText('Page 1 of 2');
  await expect(rows).toHaveCount(50);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(shown).toHaveText('Page 2 of 2');
  await expect(rows).toHaveCount(10);
  await expect(page.getByRole('link', { name: 'Guest 60' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();

  for (const [search, name] of [
    ['guest 07', 'Guest 07'],
    ['guest7@', 'Guest 07'],
    ['0712 000 07', 'Guest 07'],
    ['+254 712 0000 42', 'Guest 42'],
  ] as const) {
    await page.getByLabel('Search contacts').fill(search);
    await expect(rows).toHaveCount(1);
    await expect(page.getByRole('link', { name })).toBeVisible();
  }
  await expect(page.getByRole('cell', { name: '0712 000042' })).toBeVisible();

  // A search is counted too: the last one found one guest.
  await expect(count).toHaveText('1 Contact');
  await page.getByLabel('Search contacts').fill('');
  await expect(count).toHaveText('60 Contacts');
  const sort = await openSort(page);
  await choose(sort.getByRole('combobox', { name: 'Sort by', exact: true }), 'name');
  await page.keyboard.press('Escape');
  await expect(rows.first()).toContainText('Guest 01');
  await page.getByLabel('Search contacts').fill('nobody');
  await expect(page.getByText('No contacts match this search.')).toBeVisible();
  await expect(count).toHaveText('0 Contacts');
});
