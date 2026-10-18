import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fakeMediaApi } from './media-fixtures';
import { harbor, inHarbor, signedIn } from './session';
import { fakeFieldsApi, fakeImportsApi, fakeValuesApi } from './settings-fixtures';
import { configurationOf } from './tag-fixtures';

// The values below are the default theme's (packages/ui's tokens).
const ACCENT = 'rgb(21, 94, 239)';
const GROUND = 'rgb(248, 249, 250)';
const SURFACE = 'rgb(255, 255, 255)';
const LINE = 'rgb(234, 236, 240)';
const SIDEBAR = 'rgb(45, 55, 72)';
const SIDEBAR_ACTIVE = 'rgb(26, 32, 44)';
const SIDEBAR_INK = 'rgb(255, 255, 255)';

const sections = [
  { path: inHarbor(), name: 'Dashboard' },
  { path: inHarbor('/inbox'), name: 'Conversations' },
  { path: inHarbor('/calendar'), name: 'Calendars' },
  { path: inHarbor('/contacts'), name: 'Contacts' },
  { path: inHarbor('/deals'), name: 'Opportunities' },
  { path: inHarbor('/automations'), name: 'Workflows list' },
  // Reporting opens on its first tab, Custom reports, whose page is the Reports overview.
  { path: inHarbor('/reports'), name: 'Reports overview' },
  // Settings opens on its first page.
  { path: inHarbor('/settings'), name: 'Business Profile' },
  // The agency's listed apps: none here (marketplace.spec.ts tries the rest).
  { path: inHarbor('/app-marketplace'), name: 'App Marketplace' },
] as const;

// The sidebar, top to bottom, as GoHighLevel has it, without its Ask AI and Launchpad: the
// assistant is on every page instead. The divider follows Payments.
const sidebarItems = [
  'Dashboard',
  'Conversations',
  'Calendars',
  'Contacts',
  'Opportunities',
  'Payments',
  'Marketing',
  'Automation',
  'Sites',
  'Media Storage',
  'Reporting',
  'App Marketplace',
] as const;

// Every page is for someone signed in (auth.spec.ts tries signing in). Settings → Tags
// loads the tags, and Custom Fields, Custom Values and Import Data their lists, all empty
// here; each page's own spec tries the API's answers.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
  await fakeFieldsApi(page);
  await fakeValuesApi(page);
  await fakeImportsApi(page);
  // Media Storage reads its library, empty here (media-storage.spec.ts tries the rest).
  await fakeMediaApi(page);
  // The App Marketplace lists the agency's apps, none here (marketplace.spec.ts tries the rest).
  await page.route(/\/api\/v1\/marketplace\/apps(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], canInstall: true } }),
  );
  await page.route('**/api/v1/tags', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  await page.route('**/api/v1/business-profile', (route) =>
    route.fulfill({
      json: {
        id: harbor.id,
        name: harbor.name,
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        address: null,
        logoFileId: null,
        canManage: true,
      },
    }),
  );
});

// The sidebar is the banner landmark: the brand, the business, search and navigation.
function sidebar(page: Page): Locator {
  return page.getByRole('banner');
}

// The bar above every page: the module's name, its pages and who's signed in.
function topBar(page: Page): Locator {
  return page.getByRole('region', { name: 'Top bar', exact: true });
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lays out the shell as on the design canvas', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('No overdue tasks.', { exact: true })).toBeVisible();

    const sidebarBox = await sidebar(page).boundingBox();
    expect(sidebarBox?.width).toBe(224);
    await expect(sidebar(page)).toHaveCSS('background-color', SIDEBAR);
    await expect(sidebar(page)).toHaveCSS('color', SIDEBAR_INK);
    await expect(page.locator('body')).toHaveCSS('background-color', GROUND);

    const dashboard = sidebar(page).getByRole('link', { name: 'Dashboard' });
    await expect(dashboard).toHaveAttribute('aria-current', 'page');
    await expect(dashboard).toHaveCSS('background-color', SIDEBAR_ACTIVE);
    await expect(dashboard).toHaveCSS('color', SIDEBAR_INK);
    await expect(dashboard).toHaveCSS('height', '36px');
    await expect(dashboard).toHaveCSS('border-radius', '6px');
    await expect(dashboard).toHaveCSS('font-size', '14px');
    await expect(dashboard).toHaveCSS('font-weight', '500');
    const conversations = sidebar(page).getByRole('link', { name: 'Conversations' });
    await expect(conversations).not.toHaveAttribute('aria-current');
    await expect(conversations).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    const navigation = page.getByRole('navigation', { name: 'Main' });
    await expect(navigation.getByRole('link')).toHaveText([...sidebarItems]);
    await expect(navigation.getByRole('separator')).toHaveCount(1);
    await expect(
      navigation.locator('a, [role=separator]').nth(6),
      'the divider follows Payments',
    ).toHaveRole('separator');
    await expect(sidebar(page).getByText('Bluebird Digital')).toBeVisible();
    await expect(sidebar(page).getByText('Harbor Lights Events')).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: 'Search Ctrl K' })).toBeVisible();

    // Settings stays at the foot of the window, however long the page is.
    const settings = sidebar(page).getByRole('link', { name: 'Settings' });
    const settingsBox = await settings.boundingBox();
    expect((settingsBox?.y ?? 0) + (settingsBox?.height ?? 0)).toBeGreaterThan(900 - 24);
    expect((settingsBox?.y ?? 0) + (settingsBox?.height ?? 0)).toBeLessThanOrEqual(900);

    const robotoLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('14px "Roboto Variable"');
    });
    expect(robotoLoaded).toBe(true);
    await expect(page.locator('body')).toHaveCSS('font-family', /Roboto Variable/);
    await expect(page.locator('body')).toHaveCSS('font-size', '14px');
    await expect(page.locator('body')).toHaveCSS('line-height', '20px');

    await testInfo.attach('shell-1440', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('spaces the sidebar in clear groups, each as wide as the rest', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const box = async (locator: Locator) => {
      const found = await locator.boundingBox();
      if (found === null) throw new Error('Not on the page.');
      return found;
    };
    const brand = await box(sidebar(page).getByText('Bluebird Digital').locator('..'));
    const switcher = await box(sidebar(page).getByRole('combobox', { name: /^Business:/ }));
    const search = await box(sidebar(page).getByRole('button', { name: 'Search Ctrl K' }));
    const first = await box(sidebar(page).getByRole('link', { name: 'Dashboard' }));
    const second = await box(sidebar(page).getByRole('link', { name: 'Conversations' }));

    // 12px at the sides, and everything the same width.
    for (const each of [brand, switcher, search, first]) {
      expect(each.x).toBe(12);
      expect(each.width).toBe(200);
    }
    // 16px between the groups: brand, switcher, search, navigation.
    expect(switcher.y - (brand.y + brand.height)).toBe(16);
    expect(search.y - (switcher.y + switcher.height)).toBe(16);
    expect(first.y - (search.y + search.height)).toBeGreaterThanOrEqual(16);
    expect(first.y - (search.y + search.height)).toBeLessThanOrEqual(20);
    expect(switcher.height).toBe(44);
    expect(search.height).toBe(36);
    // 36px items, 4px apart, the label 12px after an 18px icon and on one line.
    expect(first.height).toBe(36);
    expect(second.y - (first.y + first.height)).toBe(4);
    const link = sidebar(page).getByRole('link', { name: 'Media Storage' });
    const icon = await box(link.locator('svg'));
    const label = await box(link.getByText('Media Storage'));
    expect(icon.width).toBe(18);
    expect(label.x - (icon.x + icon.width)).toBe(12);
    await expect(link.getByText('Media Storage')).toHaveCSS('white-space', 'nowrap');
    await expect(link.getByText('Media Storage')).toHaveAttribute('title', 'Media Storage');
    // Only the module the page is in is heavier, and hovering never looks like it.
    await expect(link).toHaveCSS('font-weight', '400');
    await link.hover();
    await expect(link).not.toHaveCSS('background-color', SIDEBAR_ACTIVE);
    await expect(link).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    // A hairline above Settings, which stays at the foot.
    const foot = sidebar(page).getByRole('link', { name: 'Settings' }).locator('..');
    await expect(foot).toHaveCSS('border-top-width', '1px');
  });

  test('shows the keyboard where it is on the dark sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    const dashboard = sidebar(page).getByRole('link', { name: 'Dashboard' });
    const conversations = sidebar(page).getByRole('link', { name: 'Conversations' });
    await dashboard.focus();
    await page.keyboard.press('Tab');

    await expect(conversations).toBeFocused();
    await expect(conversations).toHaveCSS('outline-style', 'solid');
    await expect(conversations).toHaveCSS('outline-width', '2px');
    await expect(conversations).toHaveCSS('outline-color', SIDEBAR_INK);
  });

  test('names the module in a top bar, with its pages as tabs', async ({ page }) => {
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();

    const bar = topBar(page);
    const barBox = await bar.boundingBox();
    expect(barBox?.x).toBe(224);
    expect(barBox?.y).toBe(0);
    expect(barBox?.height).toBe(92);
    await expect(bar).toHaveCSS('background-color', SURFACE);
    await expect(bar).toHaveCSS('border-bottom-color', LINE);
    await expect(bar.getByText('Contacts', { exact: true })).toBeVisible();
    // The page keeps the one heading; the bar's name is not a second.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(bar.getByRole('heading')).toHaveCount(0);
    await expect(page.getByRole('main')).toHaveCount(1);

    const tabs = bar.getByRole('navigation', { name: 'Contacts', exact: true }).getByRole('link');
    await expect(tabs).toHaveText([
      'Smart Lists',
      'Bulk Actions',
      'Tasks',
      'Companies',
      'Custom Fields',
    ]);
    const smartLists = tabs.nth(0);
    await expect(smartLists).toHaveAttribute('aria-current', 'page');
    await expect(smartLists).toHaveCSS('color', ACCENT);
    await expect(smartLists).toHaveCSS('border-bottom-color', ACCENT);
    await expect(smartLists).toHaveCSS('border-bottom-width', '2px');
    await expect(tabs.nth(3)).not.toHaveAttribute('aria-current');
    await expect(tabs.nth(3)).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');

    await tabs.nth(3).click();
    await expect(page).toHaveURL(inHarbor('/contacts/companies'));
    await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible();
    await expect(tabs.nth(3)).toHaveAttribute('aria-current', 'page');
    await expect(smartLists).not.toHaveAttribute('aria-current');
    await expect(sidebar(page).getByRole('link', { name: 'Contacts' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await tabs.nth(2).click();
    await expect(page).toHaveURL(inHarbor('/tasks'));
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await expect(tabs.nth(2)).toHaveAttribute('aria-current', 'page');
    await expect(sidebar(page).getByRole('link', { name: 'Contacts' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(sidebar(page).getByRole('link', { name: 'Contacts' })).toHaveCSS(
      'background-color',
      SIDEBAR_ACTIVE,
    );

    await tabs.nth(4).click();
    await expect(page).toHaveURL(inHarbor('/settings/custom-fields'));
    await expect(bar.getByText('Settings', { exact: true })).toBeVisible();
    await expect(bar.getByRole('navigation')).toHaveCount(0);
  });

  test('fills the width beside the sidebar, with buttons the size of the design', async ({
    page,
  }) => {
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();

    // 16px gutters either side of the page, on the ground color.
    const content = await page.locator('main > div').boundingBox();
    expect(content?.x).toBe(224 + 16);
    expect(content?.width).toBe(1440 - 224 - 32);
    await expect(page.getByRole('main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    // The list's card is as wide as the column, with its search at its right end.
    const card = await page.getByRole('region', { name: 'Contacts', exact: true }).boundingBox();
    expect(card?.width).toBe(1440 - 224 - 32);
    const search = await page.getByRole('search').boundingBox();
    expect(Math.round((search?.x ?? 0) + (search?.width ?? 0))).toBeGreaterThan(
      (card?.x ?? 0) + (card?.width ?? 0) - 20,
    );

    // The trash is in the menu at the end of the row of views: its button is 36px with 8px
    // corners, and the trash in it is a link.
    const more = page.getByRole('main').getByRole('button', { name: 'More', exact: true });
    await expect(more).toHaveCSS('height', '36px');
    await expect(more).toHaveCSS('border-radius', '8px');
    await more.click();
    const trash = page.getByRole('menuitem', { name: 'Trash', exact: true });
    await expect(trash).toHaveCSS('height', '36px');
    await expect(trash).toHaveCSS('font-size', '14px');
    await expect(trash).toHaveAttribute('href', inHarbor('/trash'));
  });

  test('keeps Settings at the foot of a short window, the list scrolling above it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 520 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    const settings = await sidebar(page).getByRole('link', { name: 'Settings' }).boundingBox();
    expect((settings?.y ?? 0) + (settings?.height ?? 0)).toBeLessThanOrEqual(520);
    expect((settings?.y ?? 0) + (settings?.height ?? 0)).toBeGreaterThan(520 - 24);
    const navigation = page.getByRole('navigation', { name: 'Main' });
    const last = navigation.getByRole('link', { name: 'App Marketplace' });
    await expect(last).not.toBeInViewport();
    await last.focus();
    await expect(last).toBeInViewport();
    const lastBox = await last.boundingBox();
    expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0)).toBeLessThanOrEqual(settings?.y ?? 0);
    await expectNoAccessibilityViolations(page);
  });

  test('opens the App Marketplace from the sidebar', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('link', { name: 'App Marketplace' }).click();

    await expect(page).toHaveURL(inHarbor('/app-marketplace'));
    await expect(page.getByRole('heading', { level: 1, name: 'App Marketplace' })).toBeVisible();
    await expect(page).toHaveTitle('App Marketplace · Harbor Lights Events');
    await expect(sidebar(page).getByRole('link', { name: 'App Marketplace' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(topBar(page).getByText('App Marketplace', { exact: true })).toBeVisible();
    await expect(topBar(page).getByRole('navigation')).toHaveCount(0);
    const main = page.getByRole('main');
    await expect(main.getByRole('tab', { name: 'All apps' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(main.getByRole('heading', { level: 2, name: 'No apps yet' })).toBeVisible();
  });

  test('opens Funnels, Forms and the chat widget from Sites, and templates from Marketing', async ({
    page,
  }) => {
    await page.route('**/api/v1/forms**', (route) =>
      route.fulfill({ json: { items: [], canManage: true } }),
    );
    await page.route(/\/api\/v1\/site(?:s|-folders)\?/, (route) =>
      route.fulfill({ json: { items: [], total: 0, next: null, canManage: true } }),
    );
    await page.goto('/');
    await sidebar(page).getByRole('link', { name: 'Sites' }).click();

    // Sites opens on its first tab, Funnels, as GoHighLevel's does.
    await expect(page.getByRole('heading', { level: 1, name: 'Funnels' })).toBeVisible();
    const sites = sidebar(page).getByRole('link', { name: 'Sites' });
    await expect(sites).toHaveAttribute('aria-current', 'page');
    await expect(sidebar(page).getByRole('link', { name: 'Settings' })).not.toHaveAttribute(
      'aria-current',
    );
    await expect(topBar(page).getByText('Sites', { exact: true })).toBeVisible();
    const tabs = topBar(page).getByRole('navigation', { name: 'Sites' }).getByRole('link');
    await expect(tabs).toHaveText(['Funnels', 'Websites', 'Forms', 'Chat Widget']);
    await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'page');

    await tabs.nth(2).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Forms' })).toBeVisible();
    await expect(tabs.nth(2)).toHaveAttribute('aria-current', 'page');

    await tabs.nth(3).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Web chat' })).toBeVisible();
    await expect(tabs.nth(3)).toHaveAttribute('aria-current', 'page');
    await expect(sites).toHaveAttribute('aria-current', 'page');

    await sidebar(page).getByRole('link', { name: 'Marketing' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Email campaigns' })).toBeVisible();
    await expect(topBar(page).getByText('Marketing', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(inHarbor('/marketing/emails/campaigns'));
    // GoHighLevel's order, with the tabs that are built; Emails names its own pages.
    const marketing = topBar(page).getByRole('navigation', { name: 'Marketing' }).getByRole('link');
    await expect(marketing).toHaveText(['Emails', 'Snippets', 'Trigger Links']);
    await expect(marketing.nth(0)).toHaveAttribute('aria-current', 'page');
    await expect(
      page.getByRole('navigation', { name: 'Emails', exact: true }).getByRole('link'),
    ).toHaveText(['Campaigns', 'Templates']);

    await marketing.nth(1).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Snippets' })).toBeVisible();
    await expect(page).toHaveURL(inHarbor('/marketing/snippets'));
    await expect(marketing.nth(1)).toHaveAttribute('aria-current', 'page');
    await marketing.nth(2).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Trigger Links' })).toBeVisible();
    await expect(page).toHaveURL(inHarbor('/marketing/trigger-links'));
    await expect(marketing.nth(2)).toHaveAttribute('aria-current', 'page');
    await expect(sidebar(page).getByRole('link', { name: 'Marketing' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  for (const moved of [
    { path: '/settings/forms', heading: 'Forms', module: 'Sites' },
    { path: '/settings/webchat', heading: 'Web chat', module: 'Sites' },
    { path: '/settings/templates', heading: 'Email templates', module: 'Marketing' },
  ]) {
    test(`still opens ${moved.heading} at its earlier address, now under ${moved.module}`, async ({
      page,
    }) => {
      await page.goto(inHarbor(moved.path));

      await expect(page.getByRole('heading', { level: 1, name: moved.heading })).toBeVisible();
      await expect(topBar(page).getByText(moved.module, { exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(sidebar(page).getByRole('link', { name: moved.module })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  }

  test('swaps the sidebar for the settings list in Settings, and goes back', async ({ page }) => {
    await page.goto(inHarbor('/deals'));
    await expect(page.getByRole('heading', { level: 1, name: 'Opportunities' })).toBeVisible();
    await sidebar(page).getByRole('link', { name: 'Settings' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Business Profile' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    const settings = sidebar(page).getByRole('navigation', { name: 'Settings' });
    await expect(settings.getByRole('link')).toHaveText([
      'Go Back',
      'Business Profile',
      'Users',
      'Sign-in and security',
      'My Notifications',
      'Calendars',
      'Email Services',
      'Phone System',
      'AI Models',
      'Custom Fields',
      'Custom Values',
      'Import Data',
      'Manage Scoring',
      'Domains & URL Redirects',
      'Integrations',
      'Tags',
      'Lead Sources',
      'External Tracking',
      'Apps and API keys',
      'Audit Logs',
    ]);
    await expect(settings.getByRole('group')).toHaveCount(3);
    for (const group of ['My Business', 'Business Services', 'Other Settings'])
      await expect(settings.getByRole('group', { name: group, exact: true })).toBeVisible();
    await expect(settings.getByText('My Business', { exact: true })).toHaveCSS(
      'text-transform',
      'uppercase',
    );
    // Each label sits nearer its own pages than the group above: 20px over it, 6px under.
    const labelBox = await settings.getByText('Business Services', { exact: true }).boundingBox();
    const above = await settings.getByRole('link', { name: 'My Notifications' }).boundingBox();
    const below = await settings.getByRole('link', { name: 'Calendars' }).boundingBox();
    expect((labelBox?.y ?? 0) - ((above?.y ?? 0) + (above?.height ?? 0))).toBe(20);
    expect((below?.y ?? 0) - ((labelBox?.y ?? 0) + (labelBox?.height ?? 0))).toBe(6);
    await expect(settings.getByText('Business Services', { exact: true })).toHaveCSS(
      'font-size',
      '11px',
    );
    // The way back is a quiet link, not a filled button.
    const back = settings.getByRole('link', { name: 'Go Back' });
    await expect(back).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(back).toHaveCSS('height', '36px');
    await expect(settings.getByRole('link', { name: 'Users' })).toHaveCSS('font-weight', '400');
    await expect(settings.getByRole('link', { name: 'Users' })).toHaveCSS('height', '36px');
    const profile = settings.getByRole('link', { name: 'Business Profile' });
    await expect(profile).toHaveAttribute('aria-current', 'page');
    await expect(profile).toHaveCSS('background-color', SIDEBAR_ACTIVE);
    await expect(profile).toHaveCSS('font-weight', '500');
    // The page is all there is beside the sidebar: its own list of pages is gone.
    await expect(page.getByRole('main').getByRole('navigation')).toHaveCount(0);
    await expect(topBar(page).getByText('Settings', { exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await settings.getByRole('link', { name: 'Custom Values' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Custom Values' })).toBeVisible();
    await expect(settings.getByRole('link', { name: 'Custom Values' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(profile).not.toHaveAttribute('aria-current');

    await settings.getByRole('link', { name: 'Go Back' }).click();
    await expect(page).toHaveURL(inHarbor('/deals'));
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });

  test('goes back to the Dashboard from Settings opened by its address', async ({ page }) => {
    await page.goto(inHarbor('/settings/sign-in'));
    const settings = sidebar(page).getByRole('navigation', { name: 'Settings' });
    await settings.getByRole('link', { name: 'Go Back' }).click();

    await expect(page).toHaveURL(inHarbor());
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test('gives a module with one page its name and no tabs', async ({ page }) => {
    await page.goto(inHarbor('/app-marketplace'));
    await expect(page.getByRole('heading', { level: 1, name: 'App Marketplace' })).toBeVisible();

    await expect(topBar(page).getByText('App Marketplace', { exact: true })).toBeVisible();
    await expect(topBar(page).getByRole('navigation')).toHaveCount(0);
    await expect(topBar(page).getByRole('link')).toHaveCount(0);
  });

  test('shows who is signed in from the top bar', async ({ page }) => {
    await page.goto('/');
    // The page is still arriving when the top bar is there: a menu opened then can be closed
    // by what loads after it, on a busy machine.
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('No overdue tasks.', { exact: true })).toBeVisible();
    const account = topBar(page).getByRole('button', { name: 'Your account' });
    await expect(account).toHaveText('DB');
    await expect(sidebar(page).getByText('dana@harborlights.example')).toHaveCount(0);

    await account.click();

    const menu = topBar(page).getByRole('menu');
    await expect(menu.getByText('Dana Brooks', { exact: true })).toBeVisible();
    await expect(menu.getByText('dana@harborlights.example', { exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });

  test('moves between sections from the sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Opportunities' }).click();

    await expect(page).toHaveURL(inHarbor('/deals'));
    await expect(page.getByRole('heading', { level: 1, name: 'Opportunities' })).toBeVisible();
    // Opportunities has a tab of its own name in the top bar; this is the sidebar's link.
    await expect(sidebar(page).getByRole('link', { name: 'Opportunities' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
    await expect(page).toHaveTitle('Opportunities · Harbor Lights Events');
  });

  test('restyles everything from the accent token', async ({ page }) => {
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--accent', '#7A3FC2');
      document.documentElement.style.setProperty('--accent-ink', '#FFFFFF');
      document.documentElement.style.setProperty('--accent-text', '#7A3FC2');
    });

    const smartLists = topBar(page).getByRole('link', { name: 'Smart Lists' });
    await expect(smartLists).toHaveCSS('color', 'rgb(122, 63, 194)');
    await expect(smartLists).toHaveCSS('border-bottom-color', 'rgb(122, 63, 194)');
    await expect(sidebar(page).locator('svg rect').first()).toHaveCSS('fill', 'rgb(122, 63, 194)');
  });

  test('keeps hover fills on the sidebar readable', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('No overdue tasks.', { exact: true })).toBeVisible();
    for (const target of [
      sidebar(page).getByRole('link', { name: 'Conversations' }),
      sidebar(page).getByRole('link', { name: 'Dashboard' }),
      sidebar(page).getByRole('link', { name: 'Settings' }),
      sidebar(page).getByRole('button', { name: 'Search Ctrl K' }),
      sidebar(page).getByRole('combobox', { name: /^Business:/ }),
      topBar(page).getByRole('button', { name: 'Your account' }),
    ]) {
      await target.hover();
      await expectNoAccessibilityViolations(page);
    }
  });

  test('lets keyboard users skip to the content', async ({ page }) => {
    await page.goto(inHarbor('/inbox'));
    // The app renders once its translations load, which can be after the load event.
    await expect(page.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();

    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });

  test('explains an address that leads nowhere', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(sidebar(page)).toBeVisible();
  });
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('keeps navigation in a compact hamburger menu without scrolling sideways', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    // Measure once the shell is there (after the session is known), the Dashboard's tasks
    // have loaded and Roboto has replaced the fallback font, which moves the text.
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('No overdue tasks.', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const sidebarBox = await sidebar(page).boundingBox();
    const mainBox = await page.locator('main').boundingBox();

    expect(sidebarBox?.width).toBe(360);
    expect(sidebarBox?.height).toBeLessThanOrEqual(96);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).not.toBeVisible();
    expect(mainBox?.y).toBeGreaterThanOrEqual((sidebarBox?.y ?? 0) + (sidebarBox?.height ?? 0));
    await expect(sidebar(page)).toHaveCSS('background-color', SIDEBAR);
    // The module's name and who's signed in stay above the page.
    await expect(topBar(page).getByText('Dashboard', { exact: true })).toBeVisible();
    const account = await topBar(page).getByRole('button', { name: 'Your account' }).boundingBox();
    expect(account?.width).toBeGreaterThanOrEqual(44);
    expect(account?.height).toBeGreaterThanOrEqual(44);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);

    await testInfo.attach('shell-360', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test("reaches a module's pages from its tabs, each big enough for a finger", async ({ page }) => {
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
    const tabs = topBar(page).getByRole('navigation', { name: 'Contacts' }).getByRole('link');
    await expect(tabs).toHaveText([
      'Smart Lists',
      'Bulk Actions',
      'Tasks',
      'Companies',
      'Custom Fields',
    ]);
    for (const tab of await tabs.all())
      expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const more = page.getByRole('main').getByRole('button', { name: 'More', exact: true });
    expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await more.click();
    const trash = page.getByRole('menuitem', { name: 'Trash', exact: true });
    expect((await trash.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');

    await tabs.nth(3).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    await expectNoAccessibilityViolations(page);
  });

  test('opens a keyboard accessible navigation menu, closes on Escape and follows a section', async ({
    page,
  }) => {
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Open navigation' });
    await menu.click();
    const navigation = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await expect(navigation).toBeVisible();
    await expect(navigation).toHaveCSS('background-color', SIDEBAR);
    await expect(navigation.getByRole('link')).toHaveText([...sidebarItems, 'Settings']);
    for (const link of await navigation.getByRole('link').all())
      expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expectNoAccessibilityViolations(page);
    await page.keyboard.press('Escape');
    await expect(navigation).not.toBeVisible();
    await expect(menu).toBeFocused();
    await menu.click();
    await navigation.getByRole('link', { name: 'Opportunities', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Opportunities', level: 1 })).toBeVisible();
    await expect(navigation).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
  });
});

// Every page uses the whole column beside the sidebar: nothing at the top level of a page
// stops short of the right gutter. Sentences and lone controls may; cards, tables, boards,
// forms and toolbars may not.
const wholeWidthPages = [
  ...sections,
  { path: inHarbor('/media-storage'), name: 'Media Storage' },
  { path: inHarbor('/settings/forms'), name: 'Forms' },
  { path: inHarbor('/settings/webchat'), name: 'Web chat' },
  { path: inHarbor('/marketing/emails/campaigns'), name: 'Email campaigns' },
  { path: inHarbor('/marketing/emails/templates'), name: 'Email templates' },
  { path: inHarbor('/marketing/snippets'), name: 'Snippets' },
  { path: inHarbor('/marketing/trigger-links'), name: 'Trigger Links' },
  { path: inHarbor('/tasks'), name: 'Tasks' },
  { path: inHarbor('/contacts/companies'), name: 'Companies' },
  { path: inHarbor('/trash'), name: 'Trash' },
  { path: inHarbor('/settings/ai-models'), name: 'AI Models' },
  { path: inHarbor('/settings/email'), name: 'Email Services' },
  { path: inHarbor('/settings/custom-fields'), name: 'Custom Fields' },
  { path: inHarbor('/settings/custom-values'), name: 'Custom Values' },
  { path: inHarbor('/settings/import'), name: 'Import Data' },
  { path: inHarbor('/settings/tags'), name: 'Tags' },
  { path: inHarbor('/settings/team'), name: 'Users' },
] as const;

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  for (const each of wholeWidthPages) {
    test(`${each.name} reaches the right gutter`, async ({ page }) => {
      await page.goto(each.path);
      await expect(page.getByRole('heading', { level: 1, name: each.name })).toBeVisible();
      await page.evaluate(async () => {
        await document.fonts.ready;
      });

      const short = await page.evaluate(() => {
        const gutter = 16;
        const edge = document.documentElement.clientWidth - gutter;
        const column = document.querySelector('main > div');
        if (column === null) return ['no page'];
        const mayBeShort = new Set(['P', 'BUTTON', 'A', 'LABEL']);
        const describe = (element: Element): string =>
          `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}" ends at ${String(Math.round(element.getBoundingClientRect().right))}, not ${String(edge)}`;
        return (
          [column, ...column.children]
            .filter((element) => !mayBeShort.has(element.tagName))
            // One field by itself, such as the choice of what a list shows.
            .filter((element) => element.getAttribute('data-slot') !== 'field')
            .filter((element) => element.getBoundingClientRect().width > 0)
            .filter((element) => Math.abs(element.getBoundingClientRect().right - edge) > 1)
            .map(describe)
        );
      });
      expect(short).toEqual([]);

      const bar = await topBar(page).boundingBox();
      expect((bar?.x ?? 0) + (bar?.width ?? 0)).toBe(1920);
      await expectNoAccessibilityViolations(page);
    });
  }
});

for (const width of [1440, 360]) {
  test.describe(`accessibility at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const section of sections) {
      test(`${section.name} has no axe violations`, async ({ page }) => {
        await page.goto(section.path);
        await expect(page.getByRole('heading', { level: 1, name: section.name })).toBeVisible();
        // Check the Dashboard with its task list loaded, not while it loads.
        if (section.path === inHarbor())
          await expect(page.getByText('No overdue tasks.', { exact: true })).toBeVisible();
        // A list's saved-view tabs are dimmed and off until its views have loaded: check
        // the page with them on, not in the moment they come on.
        const currentView = page.getByRole('main').locator('button[aria-current="true"]');
        if ((await currentView.count()) > 0) {
          await expect(currentView.first()).toBeEnabled();
          await expect(currentView.first()).toHaveCSS('opacity', '1');
        }
        await expectNoAccessibilityViolations(page);
      });
    }
  });
}
