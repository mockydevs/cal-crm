// Accepting an invitation, at /accept-invitation. These three cases lived in team.spec.ts
// beside the old Users page's; that page's own cases are now in users.spec.ts.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signedIn } from './session';
test('an invitation for an existing account asks for that account without a password form', async ({
  page,
}) => {
  await signedIn(page, null);
  const token = 'a'.repeat(43);
  await page.route('**/api/auth/invitations/check?*', (route) =>
    route.fulfill({ json: { valid: true, email: 'riley@example.test', existingAccount: true } }),
  );
  await page.goto(`/accept-invitation?token=${token}`);
  await expect(page.getByRole('link', { name: 'Sign in to accept' })).toHaveAttribute(
    'href',
    /\/sign-in\?next=/,
  );
  await expect(page.getByLabel('Password')).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('a new account accepts only the invited address and handles a spent link', async ({
  page,
}) => {
  await signedIn(page, null);
  const token = 'b'.repeat(43);
  await page.route('**/api/auth/invitations/check?*', (route) =>
    route.fulfill({ json: { valid: true, email: 'invited@example.test', existingAccount: false } }),
  );
  let posted: unknown;
  await page.route('**/api/auth/invitations/accept', async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { code: 'INVALID_INVITATION' } });
  });
  await page.goto(`/accept-invitation?token=${token}`);
  await page.getByLabel('Your name').fill('Riley');
  await page.getByLabel('Password', { exact: true }).fill('a sufficiently long password');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('heading', { name: 'This invitation has run out' })).toBeVisible();
  expect(posted).toEqual({
    token,
    email: 'invited@example.test',
    name: 'Riley',
    password: 'a sufficiently long password',
  });
});

test('someone else signed in can step aside for a new account, and stay on the invitation (1A review A4)', async ({
  page,
}) => {
  await signedIn(page);
  let signedOut = false;
  await page.route('**/api/auth/get-session', (route) =>
    signedOut ? route.fulfill({ json: null }) : route.fallback(),
  );
  await page.route('**/api/auth/sign-out', async (route) => {
    signedOut = true;
    await route.fulfill({ json: { success: true } });
  });
  const token = 'c'.repeat(43);
  await page.route('**/api/auth/invitations/check?*', (route) =>
    route.fulfill({ json: { valid: true, email: 'invited@example.test', existingAccount: false } }),
  );
  await page.goto(`/accept-invitation?token=${token}`);

  await expect(page.getByText('Your existing password stays the same.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out to create the invited account' }).click();

  await expect(page.getByLabel('Your name')).toBeVisible();
  const here = new URL(page.url());
  expect([here.pathname, here.searchParams.get('token')]).toEqual(['/accept-invitation', token]);
});
