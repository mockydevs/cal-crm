import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { address, asClient } from '../servers.js';
import { query, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.82'));
test('pipelines and stages persist and a concurrent edit must reload before saving', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `pipelines-${suffix}@example.test`;
  await query(
    `with agency as (
    insert into tenancy.agencies (name,slug) values ($1,$2) returning id
  ), business as (
    insert into tenancy.businesses (agency_id,name,slug)
    select id,'Pipeline business','pipeline-business' from agency returning id,agency_id
  ), role as (
    insert into tenancy.roles (agency_id,scope,key,name,is_builtin)
    select id,'business','admin','Admin',true from agency returning id
  ), person as (
    insert into auth.users (email,name) values ($3,'Pipeline admin') returning id
  ) insert into tenancy.memberships (user_id,agency_id,business_id,role_id)
    select person.id,business.agency_id,business.id,role.id from person,business,role`,
    [`Pipeline agency ${suffix}`, `pipeline-${suffix}`, email],
  );
  const app = address('app');
  await page.goto(`${app}/sign-in`);
  await signInByLink(page, email, 1);
  // Reached from the Pipelines tab of Opportunities; Settings shows the same list.
  await page.goto(`${app}/b/pipeline-business/deals/pipelines`);
  await page.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  const creating = page.getByRole('dialog', { name: 'Create pipeline', exact: true });
  await creating.getByLabel('Pipeline name').fill('Bookings');
  // A new pipeline starts with four stages; two of them are renamed here.
  await creating.getByLabel('Stage name', { exact: true }).nth(0).fill('Enquiry');
  await creating.getByLabel('Stage name', { exact: true }).nth(1).fill('Quoted');
  await creating.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Pipeline created.', { exact: true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'Bookings' })).toBeVisible();
  const editing = (on: typeof page) =>
    on.getByRole('dialog', { name: 'Edit pipeline', exact: true });
  const other = await context.newPage();
  try {
    await other.goto(`${app}/b/pipeline-business/settings/deal-stages`);
    await other.getByRole('button', { name: 'Actions for Bookings', exact: true }).click();
    await other.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await expect(editing(other).getByLabel('Pipeline name')).toHaveValue('Bookings');

    await page.getByRole('button', { name: 'Actions for Bookings', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await editing(page).getByRole('button', { name: 'Reorder Quoted', exact: true }).focus();
    await page.keyboard.press('ArrowUp');
    await editing(page).getByRole('button', { name: 'Archive Quoted', exact: true }).click();
    await editing(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Pipeline saved.', { exact: true })).toBeVisible();

    await editing(other).getByLabel('Pipeline name').fill('Stale edit');
    await editing(other).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editing(other).getByRole('alert')).toContainText('Deal stages changed');
    await expect(editing(other).getByLabel('Pipeline name')).toHaveValue('Stale edit');
    await editing(other).getByRole('button', { name: 'Reload saved version' }).click();
    await expect(editing(other).getByLabel('Pipeline name')).toHaveValue('Bookings');
    await expect(editing(other).getByLabel('Stage name', { exact: true }).first()).toHaveValue(
      'Quoted',
    );
    await expect(
      editing(other).getByRole('button', { name: 'Restore Quoted', exact: true }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
  await page.reload();
  await page.getByRole('button', { name: 'Actions for Bookings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(
    editing(page).getByRole('button', { name: 'Restore Quoted', exact: true }),
  ).toBeVisible();
});
