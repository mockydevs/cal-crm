import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { address, asClient } from '../servers.js';
import { query, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';

test.use(asClient('203.0.113.117'));

test('a member creates, moves, closes and reopens a deal with contiguous history', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `deals-${suffix}@example.test`;
  const slug = `deals-${suffix}`;
  await query(
    `with agency as (
       insert into tenancy.agencies (name, slug) values ($1, $2) returning id
     ), business as (
       insert into tenancy.businesses (agency_id, name, slug, address)
       select id, 'Deals business', $2, '{"country":"KE"}' from agency returning id, agency_id
     ), types as (
       insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
       select business.id, kind, kind, initcap(kind), initcap(kind) || 's'
       from business, unnest(array['contact','company','deal']) as kind
     ), role as (
       insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       select id, 'business', 'member', 'Member', true from agency returning id
     ), person as (
       insert into auth.users (email, name) values ($3, 'Deals member') returning id
     ), pipeline as (
       insert into crm.pipelines (business_id, name, position)
       select id, 'Bookings', 0 from business returning id, business_id
     ), stages as (
       insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
       select business_id, id, stage.name, stage.position from pipeline,
       (values ('Enquiry',0),('Quoted',1)) as stage(name,position)
     ) insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select person.id, business.agency_id, business.id, role.id from person, business, role`,
    [`Deals agency ${suffix}`, slug, email],
  );
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, email, 1);
  await page.goto(`${address('app')}/b/${slug}/deals`);
  await page.getByRole('button', { name: 'Add opportunity', exact: true }).click();
  const adding = page.getByRole('dialog', { name: 'Add new opportunity', exact: true });
  await adding.getByLabel('Opportunity name').fill('Reception');
  await adding.getByLabel('Value', { exact: true }).fill('123456789.1234');
  await adding.getByLabel('Source', { exact: true }).fill('Referral');
  await adding.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(adding).toBeHidden();
  const editing = page.getByRole('dialog', { name: 'Edit Reception', exact: true });
  const opener = page.getByRole('link', { name: 'Reception', exact: true });
  // The column's header counts the card and totals its value; the card says its source.
  const enquiry = page.getByRole('region', { name: 'Enquiry', exact: true });
  await expect(enquiry).toContainText('1 opportunity');
  await expect(enquiry).toContainText('KES 123,456,789.1234');
  await expect(enquiry.getByRole('article')).toContainText('Source:Referral');
  const handle = page.getByRole('button', { name: 'Move Reception' });
  await expect(handle).toBeVisible();
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('status').filter({ hasText: 'Reception moved to Quoted.' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Quoted', exact: true })
      .getByRole('heading', { name: 'Reception', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('KES 123,456,789.1234');
  // It opens in its dialog, at its own address, and a reload opens it there again.
  await opener.click();
  await expect(page).toHaveURL(/[?&]deal=deal_[0-9a-z]+$/);
  await page.reload();
  await expect(editing.getByLabel('Opportunity name')).toHaveValue('Reception');
  await expect(editing.getByLabel('Source', { exact: true })).toHaveValue('Referral');
  await choose(editing.getByRole('combobox', { name: 'Status', exact: true }), 'lost');
  await editing.getByLabel('Status reason').fill('Event postponed.');
  await editing.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(editing).toBeHidden();
  const statusFilter = page.getByRole('combobox', { name: 'Status filter', exact: true });
  await choose(statusFilter, 'lost');
  await expect(page.getByRole('row', { name: /Reception/ })).toContainText('Lost');
  await opener.click();
  await expect(editing.getByLabel('Status reason')).toHaveValue('Event postponed.');
  await choose(editing.getByRole('combobox', { name: 'Status', exact: true }), 'open');
  await editing.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(editing).toBeHidden();
  await choose(statusFilter, 'open');
  await expect(page.getByRole('table')).toContainText('Reception');
  const history = await query<{ stage: string; contiguous: boolean | null; open: boolean }>(
    `select s.name as stage, h.exited_at is null as open,
       lag(h.exited_at) over (order by h.entered_at) = h.entered_at as contiguous
     from crm.deal_stage_history h
     join crm.pipeline_stages s on s.id = h.stage_id
     join tenancy.businesses b on b.id = h.business_id
     where b.slug = $1 order by h.entered_at`,
    [slug],
  );
  expect(history).toEqual([
    { stage: 'Enquiry', open: false, contiguous: null },
    { stage: 'Quoted', open: true, contiguous: true },
  ]);
});
