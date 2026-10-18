import { expect, test } from '@playwright/test';

import { address, asClient, inOurs } from '../servers.js';
import {
  askForSignInLink,
  emailTo,
  expectSignedInAs,
  expireLinksOf,
  newPerson,
  query,
} from '../signing-in.js';

// Links that sign someone in, as the app emails them: each works once, within 15 minutes.
const client = '203.0.113.20';
test.use(asClient(client));

const usedOrRunOut = 'That sign-in link has run out or was already used. Ask for a new one below.';

test('a sign-in link signs in once, and goes where the person was going', async ({ page }) => {
  const person = await newPerson();

  await page.goto(inOurs('/contacts'));
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fharbor-lights-events%2Fcontacts$/);
  await askForSignInLink(page, person.email);
  const { subject, link } = await emailTo(person.email);
  expect(subject).toBe('Sign in to Bluebird Digital');

  await page.goto(link);
  await expect(page).toHaveURL(inOurs('/contacts'));
  await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
  await expectSignedInAs(page, person.email);
  // The session records the client's address, as the proxy passed it on.
  const sessions = await query<{ ip_address: string }>(
    'select ip_address from auth.sessions where user_id = $1',
    [person.id],
  );
  expect(sessions).toEqual([{ ip_address: client }]);

  await page.getByRole('button', { name: 'Your account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto(link);
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fharbor-lights-events%2Fcontacts&error=/);
  await expect(page.getByRole('alert')).toHaveText(usedOrRunOut);
});

test('a sign-in link runs out after 15 minutes', async ({ page }) => {
  const person = await newPerson();
  await page.goto(`${address('app')}/sign-in`);
  await askForSignInLink(page, person.email);
  const { link } = await emailTo(person.email);

  const left = await expireLinksOf(person);
  expect(left).toEqual([expect.closeTo(15, 0)]);

  await page.goto(link);
  await expect(page).toHaveURL(/\/sign-in\?error=/);
  await expect(page.getByRole('alert')).toHaveText(usedOrRunOut);
});
