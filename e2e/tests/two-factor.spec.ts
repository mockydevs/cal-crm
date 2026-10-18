import { expect, test } from '@playwright/test';

import { address, asClient, inOurs } from '../servers.js';
import {
  codeFor,
  expectSignedInAs,
  newPerson,
  newStaff,
  setUpTwoFactor,
  signInByLink,
  signOut,
} from '../signing-in.js';

// Two-factor sign-in and passkeys, as people use them: an authenticator app (codes computed
// as an app computes them, from the key Settings shows), recovery codes, a passkey on
// Chromium's virtual authenticator, and an agency that requires it. Better Auth allows
// three two-factor requests per client in 10 seconds, so each scenario is a client of its
// own.

test.describe('an authenticator app', () => {
  test.use(asClient('203.0.113.40'));

  test('is set up in Settings, then asked for after a sign-in link', async ({ page }) => {
    const person = await newPerson();
    await page.goto(`${address('app')}/sign-in`);
    await signInByLink(page, person.email, 1);
    const { key } = await setUpTwoFactor(page);
    await signOut(page);

    await signInByLink(page, person.email, 2);

    await expect(page).toHaveURL(`${address('app')}/sign-in/two-factor?next=%2F`);
    await expect(page.getByText(person.email)).toBeHidden();
    await page.getByLabel('Code').fill(codeFor(key));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(inOurs());
    await expectSignedInAs(page, person.email);
  });
});

test.describe('a recovery code', () => {
  test.use(asClient('203.0.113.41'));

  test('signs in instead of a code from the app', async ({ page }) => {
    const person = await newPerson();
    await page.goto(`${address('app')}/sign-in`);
    await signInByLink(page, person.email, 1);
    const { recoveryCodes } = await setUpTwoFactor(page);
    expect(recoveryCodes).toHaveLength(10);
    await signOut(page);

    await signInByLink(page, person.email, 2);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(recoveryCodes[0] ?? '');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(inOurs());
    await expectSignedInAs(page, person.email);
  });
});

test.describe('an agency that requires two-factor sign-in', () => {
  test.use(asClient('203.0.113.42'));

  test('sends staff without it to set it up before any page', async ({ page, browser }) => {
    const owner = await newStaff();
    await page.goto(`${address('app')}/sign-in`);
    await signInByLink(page, owner.email, 1);
    await setUpTwoFactor(page);
    const agency = page.getByRole('region', { name: 'Your agency' });
    await agency.getByRole('button', { name: 'Require two-factor sign-in for the team' }).click();
    await expect(
      agency.getByRole('button', { name: 'Stop requiring two-factor sign-in' }),
    ).toBeVisible();

    // Someone else on the team, in a browser of their own.
    const colleague = await newStaff();
    const theirs = await browser.newContext(asClient('203.0.113.43'));
    try {
      const them = await theirs.newPage();
      await them.goto(inOurs('/contacts'));
      await expect(them).toHaveURL(/\/sign-in\?next=%2Fb%2Fharbor-lights-events%2Fcontacts$/);
      await signInByLink(them, colleague.email, 1);

      await expect(them).toHaveURL(
        `${address('app')}/set-up-two-factor?next=%2Fb%2Fharbor-lights-events%2Fcontacts`,
      );
      const refused = await them.request.get(
        `${address('app')}/api/v1/agency/two-factor-requirement`,
      );
      expect(refused.status()).toBe(403);
      expect(await refused.json()).toMatchObject({
        detail: 'Set up two-factor sign-in first: your agency requires it.',
      });
      await them.goto(inOurs('/deals'));
      await expect(them).toHaveURL(
        `${address('app')}/set-up-two-factor?next=%2Fb%2Fharbor-lights-events%2Fdeals`,
      );
      await them.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
      const key = (await them.getByTestId('set-up-key').textContent()) ?? '';
      await them.getByLabel('The 6-digit code from the app').fill(codeFor(key));
      await them.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
      await them.getByRole('button', { name: "I've saved my recovery codes" }).click();
      await expect(them).toHaveURL(inOurs('/deals'));
      await expect(them.getByRole('heading', { level: 1, name: 'Opportunities' })).toBeVisible();
    } finally {
      await theirs.close();
      // The rest of the run's staff don't use two factors.
      await agency.getByRole('button', { name: 'Stop requiring two-factor sign-in' }).click();
      await expect(
        agency.getByRole('button', { name: 'Require two-factor sign-in for the team' }),
      ).toBeVisible();
    }
  });
});

test.describe('a passkey', () => {
  test.use(asClient('203.0.113.44'));

  test('is added in Settings, then signs in on its own', async ({ page }) => {
    // Chromium's virtual authenticator: a platform passkey that checks who it is.
    const devtools = await page.context().newCDPSession(page);
    await devtools.send('WebAuthn.enable');
    await devtools.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const person = await newPerson();
    await page.goto(`${address('app')}/sign-in`);
    await signInByLink(page, person.email, 1);
    await page.goto(inOurs('/settings/sign-in'));
    const passkeys = page.getByRole('region', { name: 'Passkeys' });
    await passkeys.getByLabel('Name it (optional)').fill('Laptop');
    await passkeys.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(passkeys.getByRole('list', { name: 'Your passkeys' })).toContainText('Laptop');
    await signOut(page);

    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();

    await expect(page).toHaveURL(inOurs());
    await expectSignedInAs(page, person.email);
  });
});
