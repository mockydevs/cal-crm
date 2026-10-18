import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { dana, inHarbor, signedIn, worksIn } from './session';

// Two-factor sign-in and passkeys, against the built dashboard with Better Auth's endpoints
// stood in for. @repo/e2e does it for real, with an authenticator app and a passkey.

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

/** Answers each request to an endpoint in turn, recording what was posted. */
async function answers(
  page: Page,
  path: string,
  ...replies: readonly { status: number; json: unknown }[]
): Promise<unknown[]> {
  const posted: unknown[] = [];
  await page.route(`**/api/auth${path}`, async (route: Route) => {
    posted.push(route.request().postDataJSON());
    const reply = replies[Math.min(posted.length, replies.length) - 1] ?? { status: 200, json: {} };
    await route.fulfill(reply);
  });
  return posted;
}

/** A session that signs in once the code checks out, to work in Dana's business. */
async function signedInAfterCode(page: Page): Promise<() => void> {
  let user: typeof dana | null = null;
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        user === null ? null : { user: { ...user, twoFactorEnabled: true }, session: {} },
      ),
    }),
  );
  await worksIn(page);
  return () => {
    user = dana;
  };
}

const link =
  'otpauth://totp/Bluebird%20Digital:dana%40harborlights.example?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Bluebird+Digital&digits=6&period=30';
const recoveryCodes = ['ab12c-de34f', 'gh56i-jk78l', 'mn90o-pq12r'];

test.describe('signing in with two factors', () => {
  test('asks for the code after the password, then goes where they were going', async ({
    page,
  }) => {
    const signIn = await signedInAfterCode(page);
    await answers(page, '/sign-in/email', {
      status: 200,
      json: { twoFactorRedirect: true, twoFactorMethods: ['totp'] },
    });
    let tries = 0;
    await page.route('**/api/auth/two-factor/verify-totp', async (route) => {
      tries += 1;
      if (tries === 1) {
        await route.fulfill({ status: 401, json: { code: 'INVALID_CODE' } });
        return;
      }
      signIn();
      await route.fulfill({ json: { token: 't' } });
    });
    await page.route('**/api/auth/security', (route) =>
      route.fulfill({ json: { twoFactorRequired: false, hasPassword: true } }),
    );
    await page.goto(`/sign-in?next=${encodeURIComponent(inHarbor('/contacts'))}`);

    await page.getByLabel('Email').fill(dana.email);
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(
      `/sign-in/two-factor?next=${encodeURIComponent(inHarbor('/contacts'))}`,
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.getByLabel('Code').fill('123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      "That code didn't match. Enter the newest code your app shows.",
    );
    await page.getByLabel('Code').fill('654321');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/contacts'));
  });

  test('takes a recovery code instead', async ({ page }) => {
    const signIn = await signedInAfterCode(page);
    const posted: unknown[] = [];
    await page.route('**/api/auth/two-factor/verify-backup-code', async (route) => {
      posted.push(route.request().postDataJSON());
      signIn();
      await route.fulfill({ json: { token: 't' } });
    });
    await page.route('**/api/auth/security', (route) =>
      route.fulfill({ json: { twoFactorRequired: false, hasPassword: true } }),
    );
    await page.goto('/sign-in/two-factor');

    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(' ab12c-de34f ');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(inHarbor());
    expect(posted).toEqual([{ code: 'ab12c-de34f' }]);
  });

  test('sends someone back to sign in when this sign-in ran out', async ({ page }) => {
    await signedIn(page, null);
    await answers(page, '/two-factor/verify-totp', {
      status: 401,
      json: { code: 'INVALID_TWO_FACTOR_COOKIE' },
    });
    await page.goto('/sign-in/two-factor?next=%2Fdeals');

    await page.getByLabel('Code').fill('123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByRole('alert')).toHaveText(
      'Signing in took too long, or had too many wrong codes. Start again.',
    );
    await page.getByRole('link', { name: 'Back to signing in' }).click();
    await expect(page).toHaveURL('/sign-in?next=%2Fdeals');
  });
});

test.describe('when the agency requires two-factor sign-in', () => {
  test('sends someone without it to set it up before any page, then on', async ({ page }) => {
    let enabled = false;
    await page.route('**/api/auth/get-session', (route) =>
      route.fulfill({
        json: { user: { ...dana, twoFactorEnabled: enabled }, session: {} },
      }),
    );
    await page.route('**/api/auth/security', (route) =>
      route.fulfill({ json: { twoFactorRequired: true, hasPassword: true } }),
    );
    const started = await answers(page, '/two-factor/enable', {
      status: 200,
      json: { totpURI: link, backupCodes: recoveryCodes },
    });
    await page.route('**/api/auth/two-factor/verify-totp', async (route) => {
      enabled = true;
      await route.fulfill({ json: { token: 't' } });
    });
    await worksIn(page);

    await page.goto(inHarbor('/contacts'));

    await expect(page).toHaveURL(
      `/set-up-two-factor?next=${encodeURIComponent(inHarbor('/contacts'))}`,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up two-factor sign-in' }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.getByLabel('Your password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
    await expect(
      page.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    await expect(page.getByTestId('set-up-key')).toHaveText(
      'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP',
    );
    await expectNoAccessibilityViolations(page);
    await page.getByLabel('The 6-digit code from the app').fill('123 456');
    await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
    await expect(page.getByRole('list', { name: 'Recovery codes' })).toContainText('gh56i-jk78l');
    await page.getByRole('button', { name: "I've saved my recovery codes" }).click();

    await expect(page).toHaveURL(inHarbor('/contacts'));
    expect(started).toEqual([{ password: 'correct horse battery staple' }]);
  });

  test("doesn't ask for a password that someone doesn't have", async ({ page }) => {
    await signedIn(page, dana, { twoFactorRequired: true, hasPassword: false });
    const started = await answers(page, '/two-factor/enable', {
      status: 200,
      json: { totpURI: link, backupCodes: recoveryCodes },
    });
    await page.goto('/');

    await expect(page).toHaveURL('/set-up-two-factor?next=%2F');
    await expect(page.getByLabel('Your password')).toHaveCount(0);
    await page.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
    await expect(
      page.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    expect(started).toEqual([{}]);
  });
});

test.describe('Settings, Sign-in and security', () => {
  test('shows two-factor sign-in on, kept on while the agency requires it', async ({ page }) => {
    await signedIn(page, dana, { twoFactorEnabled: true, twoFactorRequired: true });
    await page.route('**/api/auth/passkey/list-user-passkeys', (route) =>
      route.fulfill({ json: [] }),
    );
    await page.route('**/api/v1/agency/two-factor-requirement', (route) =>
      route.fulfill({ json: { required: true } }),
    );
    const fresh = await answers(page, '/two-factor/generate-backup-codes', {
      status: 200,
      json: { status: true, backupCodes: ['zz11y-xx22w'] },
    });
    await page.goto(inHarbor('/settings/sign-in'));

    const twoFactor = page.getByRole('region', { name: 'Two-factor sign-in' });
    await expect(twoFactor).toContainText(
      'Your agency requires two-factor sign-in, so it stays on.',
    );
    await expect(twoFactor.getByRole('button', { name: 'Turn off' })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    await twoFactor.getByRole('button', { name: 'Get new recovery codes' }).click();
    await twoFactor.getByLabel('Your password').fill('correct horse battery staple');
    await twoFactor.getByRole('button', { name: 'Get new recovery codes' }).click();
    await expect(twoFactor.getByRole('list', { name: 'Recovery codes' })).toHaveText('zz11y-xx22w');
    expect(fresh).toEqual([{ password: 'correct horse battery staple' }]);
    await expect(
      page.getByRole('region', { name: 'Your agency' }).getByRole('button', {
        name: 'Stop requiring two-factor sign-in',
      }),
    ).toBeVisible();
  });

  test('asks someone without a password to sign in again when it has been a while', async ({
    page,
  }) => {
    await signedIn(page, dana, { twoFactorEnabled: true, hasPassword: false });
    await page.route('**/api/auth/passkey/list-user-passkeys', (route) =>
      route.fulfill({ json: [] }),
    );
    await page.route('**/api/v1/agency/two-factor-requirement', (route) =>
      route.fulfill({ status: 403, json: { status: 403, title: 'Forbidden' } }),
    );
    const asked = await answers(page, '/two-factor/generate-backup-codes', {
      status: 403,
      json: { code: 'SIGN_IN_AGAIN', message: 'Sign in again to change how you sign in.' },
    });
    await page.goto(inHarbor('/settings/sign-in'));

    const twoFactor = page.getByRole('region', { name: 'Two-factor sign-in' });
    await twoFactor.getByRole('button', { name: 'Get new recovery codes' }).click();

    await expect(twoFactor.getByRole('alert')).toHaveText(
      "For your safety, sign out and sign in again first: it's been more than 15 minutes since you signed in.",
    );
    expect(asked).toEqual([{}]);
    await expect(twoFactor.getByRole('list', { name: 'Recovery codes' })).toHaveCount(0);
  });

  test('sets it up and shows the recovery codes before saying it is on', async ({ page }) => {
    let enabled = false;
    await page.route('**/api/auth/get-session', (route) =>
      route.fulfill({ json: { user: { ...dana, twoFactorEnabled: enabled }, session: {} } }),
    );
    await page.route('**/api/auth/security', (route) =>
      route.fulfill({ json: { twoFactorRequired: false, hasPassword: false } }),
    );
    await page.route('**/api/auth/passkey/list-user-passkeys', (route) =>
      route.fulfill({ json: [] }),
    );
    await page.route('**/api/v1/agency/two-factor-requirement', (route) =>
      route.fulfill({ status: 403, json: { status: 403, title: 'Forbidden' } }),
    );
    await answers(page, '/two-factor/enable', {
      status: 200,
      json: { totpURI: link, backupCodes: recoveryCodes },
    });
    await page.route('**/api/auth/two-factor/verify-totp', async (route) => {
      enabled = true;
      await route.fulfill({ json: { token: 't' } });
    });
    await worksIn(page);
    await page.goto(inHarbor('/settings/sign-in'));

    const twoFactor = page.getByRole('region', { name: 'Two-factor sign-in' });
    await twoFactor.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
    await twoFactor.getByLabel('The 6-digit code from the app').fill('123456');
    await twoFactor.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();

    await expect(twoFactor.getByRole('list', { name: 'Recovery codes' })).toContainText(
      'mn90o-pq12r',
    );
    await twoFactor.getByRole('button', { name: "I've saved my recovery codes" }).click();
    await expect(twoFactor.getByText('On', { exact: true })).toBeVisible();
    await expect(twoFactor.getByRole('list', { name: 'Recovery codes' })).toHaveCount(0);
  });

  test('lists passkeys and removes one', async ({ page }) => {
    await signedIn(page, dana, { twoFactorEnabled: true });
    let keys = [{ id: 'pk_1', name: 'Work laptop', createdAt: '2026-10-01T09:00:00.000Z' }];
    await page.route('**/api/auth/passkey/list-user-passkeys', (route) =>
      route.fulfill({ json: keys }),
    );
    const removed: unknown[] = [];
    await page.route('**/api/auth/passkey/delete-passkey', async (route) => {
      removed.push(route.request().postDataJSON());
      keys = [];
      await route.fulfill({ json: { status: true } });
    });
    await page.route('**/api/v1/agency/two-factor-requirement', (route) =>
      route.fulfill({ status: 403, json: { status: 403, title: 'Forbidden' } }),
    );
    await page.goto(inHarbor('/settings/sign-in'));

    const passkeys = page.getByRole('region', { name: 'Passkeys' });
    await expect(passkeys.getByRole('list', { name: 'Your passkeys' })).toContainText(
      'Work laptop',
    );
    await expect(page.getByRole('region', { name: 'Your agency' })).toHaveCount(0);
    await passkeys.getByRole('button', { name: 'Remove Work laptop' }).click();

    await expect(passkeys.getByRole('list', { name: 'Your passkeys' })).toHaveCount(0);
    expect(removed).toEqual([{ id: 'pk_1' }]);
  });

  test('requires two-factor sign-in of the team only once yours is on', async ({ page }) => {
    await signedIn(page, dana);
    await page.route('**/api/auth/passkey/list-user-passkeys', (route) =>
      route.fulfill({ json: [] }),
    );
    await page.route('**/api/v1/agency/two-factor-requirement', (route) =>
      route.fulfill({ json: { required: false } }),
    );
    await page.goto(inHarbor('/settings/sign-in'));

    const agency = page.getByRole('region', { name: 'Your agency' });
    await expect(agency).toContainText('Set up your own two-factor sign-in above first.');
    await expect(
      agency.getByRole('button', { name: 'Require two-factor sign-in for the team' }),
    ).toBeDisabled();
  });
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('fits the set-up page without scrolling sideways', async ({ page }) => {
    await signedIn(page, dana, { twoFactorRequired: true });
    await answers(page, '/two-factor/enable', {
      status: 200,
      json: { totpURI: link, backupCodes: recoveryCodes },
    });
    await page.goto('/');
    await page.getByLabel('Your password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
    await expect(
      page.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
    await expectNoAccessibilityViolations(page);
  });
});
