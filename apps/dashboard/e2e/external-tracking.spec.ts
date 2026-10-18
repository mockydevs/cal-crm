// Settings → External Tracking, against a stand-in for the API (external-tracking-fixtures.ts):
// the page in GoHighLevel's layout and names (Installation, Troubleshoot, Settings), the
// script to copy, what the script reported, and changing what it records.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  heardFrom,
  isRefusal,
  permissionsOf,
  regenerateIn,
  trackingId,
  trackingWorldOf,
  updateTrackingIn,
  type TrackingWorld,
} from './external-tracking-fixtures';
import { harbor, inHarbor, signedIn } from './session';

async function trackingApi(page: Page, world: TrackingWorld = trackingWorldOf()) {
  const writes: unknown[] = [];
  const answer = (route: Parameters<Parameters<Page['route']>[1]>[0], value: unknown) =>
    isRefusal(value)
      ? route.fulfill({
          status: value.status,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Refused', ...value },
        })
      : route.fulfill({ json: value });
  await page.route('**/api/v1/me/permissions', (route) =>
    route.fulfill({
      json: {
        ...permissionsOf(world),
        business: route.request().headers()['business-id'] ?? null,
      },
    }),
  );
  await page.route(/\/api\/v1\/external-tracking(?:\/.*)?$/, (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const path = new URL(request.url()).pathname.replace('/api/v1/external-tracking', '');
    const body: unknown = request.postData() === null ? undefined : request.postDataJSON();
    if (request.method() !== 'GET') writes.push(body);
    if (path === '/activity') return answer(route, world.activity);
    if (path === '/regenerate') return answer(route, regenerateIn(world, body));
    if (request.method() === 'PUT') return answer(route, updateTrackingIn(world, body));
    return answer(route, world.settings);
  });
  return { world, writes };
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('Installation gives the script and the events it tracks, in GoHighLevel’s layout', async ({
  page,
}) => {
  await signedIn(page);
  await trackingApi(page);
  await page.goto(inHarbor('/settings/external-tracking'));
  await expect(page.getByRole('heading', { name: 'External Tracking', level: 1 })).toBeVisible();
  for (const tab of ['Installation', 'Troubleshoot', 'Settings'])
    await expect(page.getByRole('link', { name: tab, exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'External Tracking Script Installation' }),
  ).toBeVisible();
  const origin = new URL(page.url()).origin;
  await expect(page.getByRole('textbox', { name: 'Tracking script' })).toHaveValue(
    `<script src="${origin}/tracking/external-tracking.js" data-tracking-id="${trackingId}"></script>`,
  );
  await expect(page.getByRole('button', { name: 'Copy Script' })).toBeEnabled();
  await expect(page.getByText('Page Views', { exact: true })).toBeVisible();
  await expect(page.getByText('Form Fills / Optins', { exact: true })).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test('Troubleshoot shows what the script reported', async ({ page }) => {
  await signedIn(page);
  await trackingApi(page, trackingWorldOf({ activity: heardFrom }));
  await page.goto(inHarbor('/settings/external-tracking/troubleshoot'));
  await expect(page.getByText('Receiving events')).toBeVisible();
  const [events, pages] = [page.getByRole('table').nth(0), page.getByRole('table').nth(1)];
  await expect(events.getByRole('row')).toHaveCount(3);
  await expect(events.getByRole('link', { name: 'View contact' })).toBeVisible();
  await expect(pages.getByRole('row').nth(1)).toContainText('www.acme-roofing.example/contact');
  await expectNoAccessibilityViolations(page);
});

test('Settings changes what the script records, and makes a new tracking id', async ({ page }) => {
  await signedIn(page);
  const api = await trackingApi(page);
  await page.goto(inHarbor('/settings/external-tracking/settings'));
  const pageViews = page.getByRole('checkbox', { name: 'Track page views' });
  await expect(pageViews).toBeChecked();
  await expect(pageViews).toBeEnabled();
  await pageViews.uncheck();
  await page.getByRole('textbox', { name: 'Allowed websites' }).fill('acme-roofing.example');
  await page.getByRole('radio', { name: /^Always/ }).check();
  await expectNoAccessibilityViolations(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  expect(api.writes).toEqual([
    {
      pageViews: false,
      formCapture: true,
      allowedDomains: ['acme-roofing.example'],
      visitorIds: 'always',
      revision: 1,
    },
  ]);
  await page.getByRole('button', { name: 'Regenerate tracking ID' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByText(api.world.settings.trackingId, { exact: true })).toBeVisible();
  expect(api.world.settings.trackingId).not.toBe(trackingId);
});

test('the page is listed in Settings, under Other Settings', async ({ page }) => {
  await signedIn(page);
  await trackingApi(page);
  await page.goto(inHarbor('/settings/external-tracking'));
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'External Tracking' }),
  ).toBeVisible();
});
