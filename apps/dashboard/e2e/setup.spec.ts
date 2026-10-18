import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { dana, inHarbor, signedIn, worksIn } from './session';

// The first admin's setup page, against the built dashboard with Better Auth's endpoints
// stood in for. The server's container tests make one for real.

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

/** The setup endpoint: whether a link works, and what each try at creating the admin gets. */
async function setupEndpoint(
  page: Page,
  valid: boolean,
  ...replies: readonly { status: number; json: unknown }[]
): Promise<unknown[]> {
  const posted: unknown[] = [];
  await page.route('**/api/auth/setup**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { valid } });
      return;
    }
    posted.push(route.request().postDataJSON());
    await route.fulfill(replies[posted.length - 1] ?? { status: 200, json: { status: true } });
  });
  return posted;
}

test('creates the first admin from the link, then opens the app signed in', async ({ page }) => {
  let user: typeof dana | null = null;
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(user === null ? null : { user, session: {} }),
    }),
  );
  await page.route('**/api/auth/security', (route) =>
    route.fulfill({ json: { twoFactorRequired: false, hasPassword: true } }),
  );
  // The first admin runs the agency, which has no business yet.
  await worksIn(page, { agencyStaff: true, businesses: [] });
  // The first try's password is too short; the second creates the admin, now signed in.
  const posted: unknown[] = [];
  await page.route('**/api/auth/setup**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { valid: true } });
      return;
    }
    posted.push(route.request().postDataJSON());
    if (posted.length === 1) {
      await route.fulfill({ status: 400, json: { code: 'PASSWORD_TOO_SHORT' } });
      return;
    }
    user = dana;
    await route.fulfill({ json: { status: true } });
  });
  await page.goto('/setup?token=abc123');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Create the first admin' }),
  ).toBeVisible();
  await expectNoAccessibilityViolations(page);
  await page.getByLabel('Your name').fill('Dana Brooks');
  await page.getByLabel('Email').fill(dana.email);
  await page.getByLabel('Password').fill('shortpwd');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('alert')).toHaveText('Use 8 characters or more.');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create my account' }).click();

  await expect(page).toHaveURL('/agency');
  await expect(page.getByText('No businesses yet')).toBeVisible();
  expect(posted).toEqual([
    { token: 'abc123', name: 'Dana Brooks', email: dana.email, password: 'shortpwd' },
    {
      token: 'abc123',
      name: 'Dana Brooks',
      email: dana.email,
      password: 'correct horse battery staple',
    },
  ]);
});

test('says how to get a new link when this one has run out', async ({ page }) => {
  await signedIn(page, null);
  await setupEndpoint(page, false);
  await page.goto('/setup?token=spent');

  await expect(
    page.getByRole('heading', { level: 1, name: 'This setup link has run out' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('restart the app');
  await expectNoAccessibilityViolations(page);
});

test('says the same when the link runs out while the form is open', async ({ page }) => {
  await signedIn(page, null);
  await setupEndpoint(page, true, { status: 403, json: { code: 'SETUP_DONE' } });
  await page.goto('/setup?token=abc123');

  await page.getByLabel('Your name').fill('Dana Brooks');
  await page.getByLabel('Email').fill(dana.email);
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create my account' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'This setup link has run out' }),
  ).toBeVisible();
});

test('sends someone already signed in on to the app', async ({ page }) => {
  await signedIn(page);
  await page.goto('/setup?token=abc123');

  await expect(page).toHaveURL(inHarbor());
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('fits the setup page without scrolling sideways', async ({ page }) => {
    await signedIn(page, null);
    await setupEndpoint(page, true);
    await page.goto('/setup?token=abc123');
    await expect(page.getByLabel('Password')).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
    await expectNoAccessibilityViolations(page);
  });
});
