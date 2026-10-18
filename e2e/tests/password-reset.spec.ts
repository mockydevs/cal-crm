import { expect, test } from '@playwright/test';

import { address, asClient, inOurs } from '../servers.js';
import {
  askForSignInLink,
  emailTo,
  expectSignedInAs,
  expireLinksOf,
  newPerson,
} from '../signing-in.js';

// Resetting a forgotten password through the emailed link: it works once, within an hour,
// and a new password ends every link sent before it.
test.use(asClient('203.0.113.30'));

const newPassword = 'four unrelated words, safely';

test('a reset link sets a new password once, and ends the links sent before it', async ({
  page,
}) => {
  const person = await newPerson();
  await page.goto(`${address('app')}/sign-in`);
  await askForSignInLink(page, person.email);
  const signInLink = (await emailTo(person.email, 1)).link;

  await page.getByRole('button', { name: 'Back to signing in' }).click();
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  // The page loads when it's opened, so the sign-in page's Email field shows until then.
  await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
  await page.getByLabel('Email').fill(person.email);
  await page.getByRole('button', { name: 'Send the link' }).click();
  await expect(page.getByRole('status')).toContainText(person.email);
  const reset = await emailTo(person.email, 2);
  expect(reset.subject).toBe('Reset your password for Bluebird Digital');

  await page.goto(reset.link);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Choose a new password' }),
  ).toBeVisible();
  await page.getByLabel('New password').fill(newPassword);
  await page.getByRole('button', { name: 'Save the new password' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your password is changed' }),
  ).toBeVisible();

  await page.goto(reset.link);
  await expect(
    page.getByRole('heading', { level: 1, name: 'This link has run out' }),
  ).toBeVisible();

  await page.goto(signInLink);
  await expect(page).toHaveURL(/\/sign-in\?error=/);
  await expect(page.getByRole('alert')).toHaveText(
    'That sign-in link has run out or was already used. Ask for a new one below.',
  );

  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(inOurs());
  await expectSignedInAs(page, person.email);
});

test('a reset link runs out after an hour', async ({ page }) => {
  const person = await newPerson();
  await page.goto(`${address('app')}/forgot-password`);
  await page.getByLabel('Email').fill(person.email);
  await page.getByRole('button', { name: 'Send the link' }).click();
  const { link } = await emailTo(person.email);

  const left = await expireLinksOf(person);
  expect(left).toEqual([expect.closeTo(60, 0)]);

  await page.goto(link);
  await expect(
    page.getByRole('heading', { level: 1, name: 'This link has run out' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ask for a new link' })).toBeVisible();
});
