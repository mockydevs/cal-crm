// Settings → Integrations, against a stand-in for the API (integrations-fixtures.ts):
// GoHighLevel's grid of cards with its search and category chips, each card's state,
// connecting with the provider's sign-in or a key, the outcome the sign-in comes back with,
// disconnecting, and the Manage panel's accounts and activity.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  activityPageIn,
  authorizeUrlOf,
  connectIn,
  detailOf,
  disconnectIn,
  integrationConnectionId,
  integrationsWorldOf,
  isRefusal,
  listOf,
  refusedKey,
  testIn,
  updateIn,
  type IntegrationsWorld,
} from './integrations-fixtures';
import { agencyStaff, dana, harbor, inHarbor, signedIn } from './session';

interface Api {
  readonly world: IntegrationsWorld;
  readonly writes: { readonly method: string; readonly path: string; readonly body: unknown }[];
}

async function integrationsApi(
  page: Page,
  world: IntegrationsWorld = integrationsWorldOf(),
): Promise<Api> {
  const api: Api = { world, writes: [] };
  const answer = (
    route: Parameters<Parameters<Page['route']>[1]>[0],
    value: unknown,
    status = 200,
  ) =>
    isRefusal(value)
      ? route.fulfill({
          status: value.status,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Refused', ...value },
        })
      : route.fulfill({ status, json: value });
  await page.route(/\/api\/v1\/integrations(?:\/[^?]*)?(?:\?.*)?$/, (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/integrations', '');
    const method = request.method();
    const body: unknown = request.postData() === null ? undefined : request.postDataJSON();
    if (method !== 'GET') api.writes.push({ method, path, body });
    if (path === '') return answer(route, listOf(world));
    const [, provider = '', part, id = '', tail] = path.split('/');
    if (part === undefined) return answer(route, detailOf(world, provider));
    if (part === 'connect') return answer(route, connectIn(world, provider, body), 201);
    if (tail === 'test') return answer(route, testIn(world, provider, id));
    if (tail === 'activity')
      return answer(route, activityPageIn(world, id, url.searchParams.get('before') ?? undefined));
    if (method === 'DELETE') {
      const refused = disconnectIn(world, provider, id);
      return refused === null ? route.fulfill({ status: 204 }) : answer(route, refused);
    }
    return answer(route, updateIn(world, provider, id, body));
  });
  // The provider's sign-in, which a test only arrives at.
  await page.route('https://auth.example.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Sign in</title><h1>Provider sign-in</h1>',
    }),
  );
  return api;
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const card = (page: Page, name: string) => page.getByRole('article', { name, exact: true });

test('lists the integrations with their states, and filters them by chip and search', async ({
  page,
}) => {
  await signedIn(page);
  await integrationsApi(page);
  await page.goto(inHarbor('/settings/integrations'));
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
  await expect(page.getByText('Connect the tools your business already uses.')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(13);
  await expect(card(page, 'Xero')).toContainText('Connected by Dana Brooks · Oct 17, 2026');
  await expect(card(page, 'Slack')).toContainText('2 accounts connected');
  await expect(card(page, 'QuickBooks Online')).toContainText(
    'QuickBooks asks to be signed in again.',
  );
  await expect(
    card(page, 'QuickBooks Online').getByRole('button', { name: 'Reconnect QuickBooks Online' }),
  ).toBeVisible();
  await expect(card(page, 'Shopify')).toContainText('Checking the account…');
  await expect(card(page, 'Notion')).toContainText("Your administrator hasn't set this up.");
  // Nothing to connect with: only the menu's documentation is offered.
  await expect(card(page, 'Notion').getByRole('button', { name: /^(Connect|Manage)/ })).toHaveCount(
    0,
  );
  await expect(card(page, 'Notion').getByRole('link')).toHaveCount(0);

  const chips = page.getByRole('group', { name: 'Categories' });
  await expect(chips.getByRole('button')).toHaveText([
    'All',
    'Connected',
    'Calendar & email',
    'Phone & messaging',
    'AI',
    'Payments & accounting',
    'E-commerce',
    'Productivity',
    'Forms',
    'Developers',
  ]);
  await chips.getByRole('button', { name: 'Productivity', exact: true }).click();
  await expect(page.getByRole('article').getByRole('heading')).toHaveText(['Slack', 'Notion']);
  await chips.getByRole('button', { name: 'Connected', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(6);
  await chips.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search integrations' }).fill('twilio');
  await expect(page.getByRole('article').getByRole('heading')).toHaveText(['Phone System']);
  await expect(
    page.getByRole('link', { name: 'Find more in App Marketplace', exact: true }),
  ).toHaveAttribute('href', inHarbor('/app-marketplace'));
});

test('shows the operator setup guide to the agency’s staff, in a new tab', async ({ page }) => {
  await signedIn(page, dana, {}, agencyStaff);
  await integrationsApi(page);
  await page.goto(inHarbor('/settings/integrations'));
  const guide = card(page, 'Notion').getByRole('link', {
    name: 'Operator setup guide (opens in a new tab)',
  });
  await expect(guide).toHaveAttribute(
    'href',
    'https://github.com/mockydevs/cal-crm/blob/main/docs/HOSTING.md#51-what-you-set',
  );
  await expect(guide).toHaveAttribute('target', '_blank');
  await expect(guide).toHaveAttribute('rel', 'noopener noreferrer');
});

test('opens the page an integration lives on', async ({ page }) => {
  await signedIn(page);
  await integrationsApi(page);
  await page.goto(inHarbor('/settings/integrations'));
  await expect(card(page, 'Phone System').getByRole('link')).toHaveCount(0);
  await card(page, 'Google Calendar')
    .getByRole('link', { name: 'Manage Google Calendar', exact: true })
    .click();
  await expect(page).toHaveURL(inHarbor('/settings/calendars/connections'));
});

test('is read-only for someone who may not manage integrations', async ({ page }) => {
  await signedIn(page);
  await integrationsApi(page, integrationsWorldOf({ canManage: false }));
  await page.goto(inHarbor('/settings/integrations'));
  await expect(page.getByText('You need permission to manage integrations.')).toBeVisible();
  for (const name of ['QuickBooks Online', 'Xero', 'Slack', 'Typeform', 'Zoom'])
    await expect(card(page, name).getByRole('button')).toHaveCount(0);
});

test('connects with a key, and shows why a key was refused', async ({ page }) => {
  await signedIn(page);
  const api = await integrationsApi(page);
  await page.goto(inHarbor('/settings/integrations'));
  await card(page, 'Typeform').getByRole('button', { name: 'Connect Typeform' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Typeform', exact: true });
  await dialog.getByLabel('Key', { exact: true }).fill(refusedKey);
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Typeform refused that key. Check it and paste it again.',
  );
  await dialog.getByLabel('Key', { exact: true }).fill('tfp_live_123');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, 'Typeform')).toContainText('Checking the account…');
  expect(api.writes.map((each) => each.body)).toEqual([
    { apiKey: refusedKey },
    { apiKey: 'tfp_live_123' },
  ]);
});

test('connects with the provider’s sign-in at the address the server hands over', async ({
  page,
}) => {
  await signedIn(page);
  const api = await integrationsApi(page);
  await page.goto(inHarbor('/settings/integrations'));
  await card(page, 'Zoom').getByRole('button', { name: 'Connect Zoom' }).click();
  await expect(page).toHaveURL(authorizeUrlOf('zoom'));
  await expect(page.getByRole('heading', { name: 'Provider sign-in' })).toBeVisible();
  expect(api.writes).toEqual([{ method: 'POST', path: '/zoom/connect', body: {} }]);
});

test('says how the sign-in went and clears the address', async ({ page }) => {
  await signedIn(page);
  await integrationsApi(page);
  await page.goto(inHarbor('/settings/integrations?integration=slack&outcome=denied'));
  await expect(page.getByRole('status').filter({ hasText: 'Slack' })).toHaveText(
    'Connecting Slack was cancelled.',
  );
  await expect(page).toHaveURL(inHarbor('/settings/integrations'));
});

test('disconnects from the menu after saying what stops', async ({ page }) => {
  await signedIn(page);
  const api = await integrationsApi(page);
  await page.goto(inHarbor('/settings/integrations'));
  await card(page, 'Xero').getByRole('button', { name: 'Actions for Xero' }).click();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  const asking = page.getByRole('dialog', { name: 'Disconnect Xero?' });
  await expect(asking).toContainText(
    'Its steps stop and it no longer sends anything here. What it already brought in stays.',
  );
  await asking.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(card(page, 'Xero').getByRole('button', { name: 'Connect Xero' })).toBeVisible();
  expect(api.writes).toEqual([
    { method: 'DELETE', path: `/xero/connections/${integrationConnectionId(2)}`, body: undefined },
  ]);
});

test('manages accounts in the panel: primary, a check, and older activity', async ({ page }) => {
  await signedIn(page);
  const api = await integrationsApi(page);
  await page.goto(inHarbor('/settings/integrations'));
  await card(page, 'Slack').getByRole('button', { name: 'Manage Slack' }).click();
  const panel = page.getByRole('dialog', { name: 'Manage Slack' });
  const northwind = panel.getByRole('listitem', { name: 'Northwind crew' });
  await northwind.getByRole('button', { name: 'Make primary', exact: true }).click();
  await expect(
    panel.getByRole('listitem', { name: 'Harbor Lights' }).getByRole('button', {
      name: 'Make primary',
    }),
  ).toBeVisible();
  await northwind.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(2);
  expect(api.writes).toEqual([
    {
      method: 'PATCH',
      path: `/slack/connections/${integrationConnectionId(5)}`,
      body: { primary: true, revision: 1 },
    },
    {
      method: 'POST',
      path: `/slack/connections/${integrationConnectionId(5)}/test`,
      body: undefined,
    },
  ]);
  const activity = panel.getByRole('list', { name: 'Activity' });
  await expect(activity.getByRole('listitem')).toHaveCount(20);
  await panel.getByRole('button', { name: 'Older', exact: true }).click();
  await expect(activity.getByRole('listitem')).toHaveCount(api.world.activity.length);
  await expect(panel.getByRole('button', { name: 'Older', exact: true })).toHaveCount(0);
});

for (const width of [360, 1280]) {
  test(`is accessible and fits at ${String(width)} px, with the Manage panel open`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page, dana, {}, agencyStaff);
    await integrationsApi(page);
    await page.goto(inHarbor('/settings/integrations'));
    await expect(card(page, 'Slack')).toBeVisible();
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);
    await expectNoAccessibilityViolations(page);
    await card(page, 'Slack').getByRole('button', { name: 'Actions for Slack' }).click();
    await page.getByRole('menuitem', { name: 'Activity', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Manage Slack' });
    await expect(panel.getByRole('heading', { name: 'Activity', exact: true })).toBeFocused();
    expect(await fits()).toBe(true);
    await expectNoAccessibilityViolations(page);
  });
}
