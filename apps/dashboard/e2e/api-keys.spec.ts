import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { apiKeyList, createApiKeyInput, createdApiKey, type ApiKey } from '@repo/contracts';

import { agencyStaff, inHarbor, signedIn } from './session';

const keyId = 'key_01m4bd188ff82s0add91b7pz63';
const theKey = `crm_live_8f3e2b9c1a0d${'7'.repeat(52)}`;

const zapier = {
  id: keyId,
  name: 'Zapier',
  prefix: 'crm_live_8f3e2b9c1a0d',
  scopes: ['tags.manage'],
  createdAt: '2026-10-02T09:30:00.000Z',
  createdBy: 'Dana Brooks',
  lastUsedAt: null,
};

/** The keys the API answers with, kept up to date as the page changes them. */
async function keysApi(
  page: Page,
  list: { items: ApiKey[]; canManage: boolean },
  options: { policies?: boolean; scope?: 'business' | 'agency' } = {},
) {
  const sent: { method: string; body: unknown }[] = [];
  await page.route('**/api/v1/api-keys', async (route) => {
    if (route.request().method() === 'POST') {
      const body: unknown = route.request().postDataJSON();
      const input = createApiKeyInput.parse(body);
      sent.push({ method: 'POST', body });
      const made: ApiKey = {
        ...zapier,
        name: input.name,
        scopes: input.scopes,
        scope: options.scope ?? 'business',
        readOnly: input.readOnly ?? false,
        readGroups: input.readGroups ?? null,
        expiresAt: input.expiresAt ?? null,
      };
      list.items = [made, ...list.items];
      await route.fulfill({ status: 201, json: createdApiKey.parse({ ...made, key: theKey }) });
      return;
    }
    await route.fulfill({
      json: apiKeyList.parse({
        ...list,
        scopes: ['files.upload', 'tags.manage', 'reports.view'],
        ...(options.policies === false
          ? {}
          : {
              scope: options.scope ?? 'business',
              readGroups: ['Files', 'Tags', 'Contacts', 'Reports'],
            }),
      }),
    });
  });
  await page.route(`**/api/v1/api-keys/${keyId}`, async (route) => {
    sent.push({ method: route.request().method(), body: undefined });
    list.items = [];
    await route.fulfill({ status: 204 });
  });
  return sent;
}

async function chooseTagAccess(page: Page) {
  await page.getByRole('radio', { name: 'Custom access' }).check();
  await page.getByRole('checkbox', { name: 'Tags', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Manage tags' }).check();
}

test('refuses creating a supposedly restricted key against a legacy server without policy support', async ({
  page,
}) => {
  await signedIn(page);
  const sent = await keysApi(page, { items: [], canManage: true }, { policies: false });
  await page.goto(inHarbor('/settings/apps'));
  await expect(page.getByRole('button', { name: 'New API key' })).toBeDisabled();
  await expect(
    page.getByText(/This server does not yet support API-key access policies/),
  ).toBeVisible();
  expect(sent).toEqual([]);
});

test('creates an agency read-only key without a business selector or unrequested protected grants', async ({
  page,
}) => {
  await signedIn(page, undefined, {}, agencyStaff);
  const sent = await keysApi(page, { items: [], canManage: true }, { scope: 'agency' });
  await page.goto('/agency/settings/apps');
  await expect(page.getByRole('heading', { level: 1, name: 'Apps and API keys' })).toBeVisible();
  await page.getByRole('button', { name: 'New API key' }).click();
  await page.getByLabel('Name').fill('Agency reader');
  await expect(page.getByRole('radio', { name: 'Read-only', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Contacts', exact: true }).check();
  const posted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/api-keys',
  );
  await page.getByRole('button', { name: 'Create key' }).click();
  expect((await posted).headers()['business-id']).toBeUndefined();
  await expect(page.getByRole('region', { name: 'Your new key' })).toBeVisible();
  expect(sent).toEqual([
    {
      method: 'POST',
      body: { name: 'Agency reader', scopes: [], readOnly: true, readGroups: ['Contacts'] },
    },
  ]);
  await page.getByRole('button', { name: 'I’ve copied it' }).click();
  const listed = page.getByRole('listitem').filter({ hasText: 'Agency reader' });
  await expect(listed).toContainText('Read-only');
  await expect(listed).toContainText('Agency');
  await expect(listed).toContainText('Contacts');
});

test('makes a key, shows it once to copy, then lists it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signedIn(page);
  const sent = await keysApi(page, { items: [], canManage: true });
  await page.goto(inHarbor('/settings/apps'));

  await expect(page.getByRole('heading', { level: 1, name: 'Apps and API keys' })).toBeVisible();
  await expect(page.getByText('No API keys yet.')).toBeVisible();
  await page.getByRole('button', { name: 'New API key' }).click();
  await page.getByLabel('Name').fill('Zapier');
  await chooseTagAccess(page);
  await page.getByRole('button', { name: 'Create key' }).click();

  const shown = page.getByRole('region', { name: 'Your new key' });
  await expect(shown.getByRole('textbox', { name: 'Key' })).toHaveValue(theKey);
  await expect(shown).toContainText('Copy it now: you won’t see it again.');
  expect(sent).toEqual([
    {
      method: 'POST',
      body: { name: 'Zapier', scopes: ['tags.manage'], readOnly: false, readGroups: ['Tags'] },
    },
  ]);
  await shown.getByRole('button', { name: 'Copy' }).click();
  await expect(shown.getByRole('status')).toHaveText('Copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(theKey);

  await shown.getByRole('button', { name: 'I’ve copied it' }).click();
  await expect(shown).toHaveCount(0);
  const listed = page.getByRole('listitem').filter({ hasText: 'Zapier' });
  await expect(listed).toContainText('crm_live_8f3e2b9c1a0d…');
  await expect(listed).toContainText('Manage tags');
  await expect(listed).toContainText('Made by Dana Brooks on Oct 2, 2026 · Never used');
});

test('asks before revoking a key', async ({ page }) => {
  await signedIn(page);
  const sent = await keysApi(page, { items: [zapier], canManage: true });
  await page.goto(inHarbor('/settings/apps'));

  await page.getByRole('button', { name: 'Revoke Zapier' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(sent).toEqual([]);
  await page.getByRole('button', { name: 'Revoke Zapier' }).click();
  await page.getByRole('button', { name: 'Confirm revoke' }).click();

  await expect(page.getByRole('status')).toHaveText('Key revoked. Apps using it stop working now.');
  expect(sent).toEqual([{ method: 'DELETE', body: undefined }]);
  await expect(page.getByText('No API keys yet.')).toBeVisible();
});

test("shows what's wrong under the field it's about, from the page and from the server", async ({
  page,
}) => {
  await signedIn(page);
  await keysApi(page, { items: [], canManage: true });
  await page.goto(inHarbor('/settings/apps'));
  await page.getByRole('button', { name: 'New API key' }).click();
  await page.getByRole('radio', { name: 'Custom access' }).check();

  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByLabel('Name')).toHaveAccessibleDescription(
    /Give the key a name, such as the app that uses it\./,
  );
  await expect(page.getByRole('group', { name: 'What it may change' })).toHaveAccessibleDescription(
    /Choose at least one permission or read group\./,
  );

  await page.route('**/api/v1/api-keys', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 422,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            title: 'Unprocessable Content',
            status: 422,
            errors: [
              {
                path: '/scopes',
                code: 'not_yours',
                message:
                  "You can give a key only permissions you have, and you don't have tags.manage.",
              },
            ],
          },
        })
      : route.fallback(),
  );
  await page.getByLabel('Name').fill('Zapier');
  await expect(page.getByLabel('Name')).not.toHaveAttribute('aria-invalid', 'true');
  await chooseTagAccess(page);
  await expect(page.getByLabel('Name')).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByRole('group', { name: 'What it may change' })).toHaveAccessibleDescription(
    /you don't have tags\.manage\./,
  );
});

test("shows someone who can't manage keys the keys, and nothing to change them with", async ({
  page,
}) => {
  await signedIn(page);
  await keysApi(page, { items: [zapier], canManage: false });
  await page.goto(inHarbor('/settings/apps'));

  await expect(page.getByRole('listitem').filter({ hasText: 'Zapier' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New API key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoke Zapier' })).toHaveCount(0);
});

for (const width of [360, 1440]) {
  test(`is accessible and fits at ${String(width)} px, with a new key showing`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    await keysApi(page, { items: [zapier], canManage: true });
    await page.goto(inHarbor('/settings/apps'));
    // On a phone the sidebar is behind the menu button.
    if (width < 1024) await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('link', { name: 'Apps and API keys' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    if (width < 1024) await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'New API key' }).click();
    await page.getByLabel('Name').fill('Zapier');
    await chooseTagAccess(page);
    await page.getByRole('button', { name: 'Create key' }).click();
    await expect(page.getByRole('region', { name: 'Your new key' })).toBeVisible();

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
