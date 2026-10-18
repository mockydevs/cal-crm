import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { address, asClient } from '../servers.js';
import { query, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.81'));

test('saves a business profile and logo, and preserves them on reload', async ({ page }) => {
  // An agency of its own: parallel security tests change the shared agency's 2FA rule.
  const suffix = randomUUID().slice(0, 8);
  const email = `profile-${suffix}@example.test`;
  await query(
    `with agency as (
    insert into tenancy.agencies (name,slug) values ($1,$2) returning id
  ), business as (
    insert into tenancy.businesses (agency_id,name,slug)
    select id,'Profile business','profile-business' from agency returning id,agency_id
  ), role as (
    insert into tenancy.roles (agency_id,scope,key,name,is_builtin)
    select id,'business','admin','Admin',true from agency returning id
  ), person as (
    insert into auth.users (email,name) values ($3,'Profile admin') returning id
  ) insert into tenancy.memberships (user_id,agency_id,business_id,role_id)
    select person.id,business.agency_id,business.id,role.id from person,business,role`,
    [`Profile agency ${suffix}`, `profile-${suffix}`, email],
  );
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, email, 1);
  await page.goto(`${address('app')}/b/profile-business/settings`);
  await expect(page.getByRole('heading', { name: 'Business Profile', exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Nairobi Events');
  await page.getByLabel('Time zone', { exact: true }).fill('not-a-zone');
  await page.getByLabel('Currency', { exact: true }).fill('ZZZ');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.getByLabel('Currency', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.getByLabel('Time zone', { exact: true }).fill('Africa/Nairobi');
  await page.getByLabel('Currency', { exact: true }).fill('KES');
  await page.getByLabel('Locale', { exact: true }).fill('en-KE');
  await page.getByLabel('Street address').fill('12 Market Road');
  await page.getByLabel('City', { exact: true }).fill('Nairobi');
  await page.getByLabel('Country code').fill('KE');
  await page.getByLabel('Logo', { exact: true }).setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Business profile saved.');
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Nairobi Events');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('Africa/Nairobi');
  await expect(page.getByLabel('Country code')).toHaveValue('KE');
  await expect(page.getByRole('img', { name: 'Business logo' })).toBeVisible();
  const src = await page.getByRole('img', { name: 'Business logo' }).getAttribute('src');
  if (src === null) throw new Error('The logo has no signed link.');
  const downloaded = await page.request.get(src);
  expect(downloaded.ok()).toBe(true);
  expect((await downloaded.body()).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await page.getByRole('button', { name: 'Remove logo' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Business profile saved.');
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Nairobi Events');
  await expect(page.getByRole('img', { name: 'Business logo' })).toHaveCount(0);
});
