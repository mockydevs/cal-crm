import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { dana, inHarbor, signedIn, worksIn } from './session';
import { configurationOf } from './tag-fixtures';

// The sign-in pages, against the built dashboard with Better Auth's endpoints stood in for,
// so each answer they can give is tried. @repo/e2e signs in for real, through Mailpit.

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

/** Answers one endpoint, and records what was posted to it. */
async function answer(
  page: Page,
  path: string,
  status: number,
  body: unknown = { status: true },
): Promise<unknown[]> {
  const posted: unknown[] = [];
  await page.route(`**/api/auth${path}`, async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status, json: body });
  });
  return posted;
}

test.describe('signing in', () => {
  test('sends someone signed out to sign in, and back where they were going', async ({ page }) => {
    let session: typeof dana | null = null;
    await page.route('**/api/auth/get-session', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(session === null ? null : { user: session, session: {} }),
      }),
    );
    await page.route('**/api/auth/sign-in/email', async (route) => {
      session = dana;
      await route.fulfill({ json: { user: dana } });
    });
    await page.route('**/api/auth/security', (route) =>
      route.fulfill({ json: { twoFactorRequired: false, hasPassword: true } }),
    );
    await worksIn(page);

    await page.goto(inHarbor('/contacts'));
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fb%2Fharbor-lights-events%2Fcontacts$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveTitle('Sign in · Bluebird Digital');
    await expectNoAccessibilityViolations(page);

    await page.getByLabel('Email').fill(dana.email);
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(inHarbor('/contacts'));
    await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
    await page.getByRole('button', { name: 'Your account' }).click();
    await expect(page.getByRole('menu').getByText(dana.email, { exact: true })).toBeVisible();
  });

  test("says when the email and password don't match, and when there were too many tries", async ({
    page,
  }) => {
    await signedIn(page, null);
    let status = 401;
    await page.route('**/api/auth/sign-in/email', (route) =>
      route.fulfill({ status, json: { code: status === 401 ? 'INVALID_EMAIL_OR_PASSWORD' : 'x' } }),
    );
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(dana.email);
    await page.getByLabel('Password').fill('not the password');

    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText("That email and password don't match.");
    status = 429;
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Too many attempts. Wait a few minutes, then try again.',
    );
  });

  test('emails a sign-in link to the address given', async ({ page }) => {
    await signedIn(page, null);
    const posted = await answer(page, '/sign-in/magic-link', 200);
    await page.goto('/sign-in');

    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Enter your email address first, so we know where to send the link.',
    );
    await page.getByLabel('Email').fill(dana.email);
    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click();

    await expect(page.getByRole('status')).toContainText(
      `If ${dana.email} has an account here, we've sent it a link`,
    );
    expect(posted).toEqual([{ email: dana.email, callbackURL: '/', errorCallbackURL: '/sign-in' }]);
    await expectNoAccessibilityViolations(page);
  });

  test('has the link go where they were going, or back to sign in to try again', async ({
    page,
  }) => {
    await signedIn(page, null);
    const posted = await answer(page, '/sign-in/magic-link', 200);
    await page.goto('/sign-in?next=%2Fcontacts%3Fview%3Dall');

    await page.getByLabel('Email').fill(dana.email);
    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click();

    await expect(page.getByRole('status')).toContainText(dana.email);
    expect(posted).toEqual([
      {
        email: dana.email,
        callbackURL: '/contacts?view=all',
        errorCallbackURL: '/sign-in?next=%2Fcontacts%3Fview%3Dall',
      },
    ]);
  });

  test('says when a sign-in link was already used or ran out', async ({ page }) => {
    await signedIn(page, null);
    await page.goto('/sign-in?error=INVALID_TOKEN');

    await expect(page.getByRole('alert')).toHaveText(
      'That sign-in link has run out or was already used. Ask for a new one below.',
    );
  });

  test('goes only to pages on this site afterwards, by password or by link', async ({ page }) => {
    let session: typeof dana | null = null;
    await page.route('**/api/auth/get-session', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(session === null ? null : { user: session, session: {} }),
      }),
    );
    await page.route('**/api/auth/sign-in/email', async (route) => {
      session = dana;
      await route.fulfill({ json: { user: dana } });
    });
    await page.route('**/api/auth/security', (route) =>
      route.fulfill({ json: { twoFactorRequired: false, hasPassword: true } }),
    );
    await worksIn(page);
    const linkRequests = await answer(page, '/sign-in/magic-link', 200);
    await page.goto('/sign-in?next=//evil.example/x');

    await page.getByLabel('Email').fill(dana.email);
    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click();
    await expect(page.getByRole('status')).toContainText(dana.email);
    expect(linkRequests).toEqual([
      { email: dana.email, callbackURL: '/', errorCallbackURL: '/sign-in' },
    ]);
    await page.getByRole('button', { name: 'Back to signing in' }).click();

    await page.getByLabel('Email').fill(dana.email);
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // The app opens in Dana's only business.
    await expect(page).toHaveURL(inHarbor());
  });

  test('sends someone already signed in on to the app', async ({ page }) => {
    await signedIn(page);
    await page.goto('/sign-in');

    await expect(page).toHaveURL(inHarbor());
  });
});

test.describe('a forgotten password', () => {
  test('emails a reset link to the address given', async ({ page }) => {
    await signedIn(page, null);
    const posted = await answer(page, '/request-password-reset', 200);
    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Reset your password' }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByLabel('Email').fill(dana.email);
    await page.getByRole('button', { name: 'Send the link' }).click();

    await expect(page.getByRole('status')).toContainText(`If ${dana.email} has an account here`);
    expect(posted).toEqual([{ email: dana.email, redirectTo: '/reset-password' }]);
  });

  test('sets the new password from the link, and says so', async ({ page }) => {
    await signedIn(page, null);
    const posted = await answer(page, '/reset-password', 200);
    await page.goto('/reset-password?token=abc123');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Choose a new password' }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByLabel('New password').fill('a brand new passphrase');
    await page.getByRole('button', { name: 'Save the new password' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Your password is changed' }),
    ).toBeVisible();
    expect(posted).toEqual([{ token: 'abc123', newPassword: 'a brand new passphrase' }]);
  });

  test('says when the link was used or ran out, before or after it was opened', async ({
    page,
  }) => {
    await signedIn(page, null);
    await answer(page, '/reset-password', 400, { code: 'INVALID_TOKEN' });

    await page.goto('/reset-password?error=INVALID_TOKEN');
    await expect(
      page.getByRole('heading', { level: 1, name: 'This link has run out' }),
    ).toBeVisible();

    await page.goto('/reset-password?token=spent');
    await page.getByLabel('New password').fill('a brand new passphrase');
    await page.getByRole('button', { name: 'Save the new password' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'This link has run out' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ask for a new link' })).toBeVisible();
  });
});

test('signs out from the account menu', async ({ page }) => {
  await signedIn(page);
  const posted = await answer(page, '/sign-out', 200);
  await page.route('**/api/v1/tags', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  await page.goto('/');

  await page.getByRole('button', { name: 'Your account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  await expect(page).toHaveURL(/\/sign-in/);
  expect(posted).toHaveLength(1);
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('fits the sign-in page without scrolling sideways', async ({ page }) => {
    await signedIn(page, null);
    await page.goto('/sign-in');

    await expect(page.getByLabel('Password')).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
    await expectNoAccessibilityViolations(page);
  });
});
