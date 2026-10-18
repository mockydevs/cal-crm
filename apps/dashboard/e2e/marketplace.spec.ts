import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  agencyMarketplaceApp,
  agencyMarketplaceAppList,
  createMarketplaceAppInput,
  installedMarketplaceAppList,
  marketplaceAppDetail,
  marketplaceAppList,
  marketplaceInstall,
  updateMarketplaceAppInput,
  type AgencyMarketplaceApp,
  type MarketplaceApp,
  type MarketplaceInstall,
} from '@repo/contracts';

import { choose } from './select';
import { agencyStaff, harbor, inHarbor, northwind, signedIn } from './session';

// The App Marketplace against stand-ins for the API: a business browses the agency's listed
// apps, installs one with Allow & Install and uninstalls it; the agency adds, lists and
// delists its apps in Settings → Marketplace apps and gives an app's developer its
// connection; and a person connects an app on the consent page. The real API is tried by
// the real-stack suite.

const zapId = 'mapp_01k8e2wzr0e008000000000001';
const dialId = 'mapp_01k8e2wzr0e008000000000002';
const installId = 'mins_01k8e2wzr0e008000000000001';

const zap: MarketplaceApp = {
  id: zapId,
  name: 'Zap Sync',
  tagline: 'Sends new contacts to your spreadsheet',
  description: 'Keeps a sheet up to date.\nEvery new contact is a row.',
  developer: 'Northwind Labs',
  websiteUrl: 'https://zapsync.example',
  supportEmail: 'help@zapsync.example',
  iconUrl: null,
  categories: ['productivity', 'sales'],
  scopes: ['contacts.manage', 'tags.manage'],
  readGroups: ['Contacts', 'Tags'],
  webhookEvents: ['contact.created'],
  status: 'listed',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  install: null,
};
const dial: MarketplaceApp = {
  ...zap,
  id: dialId,
  name: 'Dial Pad',
  tagline: 'Calls from your browser',
  developer: 'Lakeside Software',
  categories: ['communication'],
  scopes: ['calls.read'],
};

interface Business {
  apps: MarketplaceApp[];
  missing: string[];
  canInstall: boolean;
  sent: { method: string; path: string }[];
}

/** The business's marketplace as the API answers it, kept up to date as the page changes it. */
async function marketplaceApi(page: Page, business: Business): Promise<void> {
  const record = (method: string, url: string) => {
    business.sent.push({ method, path: new URL(url).pathname });
  };
  await page.route(/\/api\/v1\/marketplace\/apps(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q')?.toLowerCase() ?? '';
    const category = url.searchParams.get('category');
    await route.fulfill({
      json: marketplaceAppList.parse({
        items: business.apps.filter(
          (app) =>
            app.name.toLowerCase().includes(q) &&
            (category === null || app.categories.some((each) => each === category)),
        ),
        canInstall: business.canInstall,
      }),
    });
  });
  await page.route('**/api/v1/marketplace/installs', (route) =>
    route.fulfill({
      json: installedMarketplaceAppList.parse({
        items: business.apps.filter((app) => app.install !== null),
        canInstall: business.canInstall,
      }),
    }),
  );
  await page.route(/\/api\/v1\/marketplace\/apps\/mapp_[^/]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const app = business.apps.find((each) => each.id === id);
    await (app === undefined
      ? route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Not Found', status: 404 },
        })
      : route.fulfill({
          json: marketplaceAppDetail.parse({
            ...app,
            missingScopes: business.missing,
            canInstall: business.canInstall,
          }),
        }));
  });
  await page.route(/\/api\/v1\/marketplace\/apps\/mapp_[^/]+\/install$/, async (route) => {
    record(route.request().method(), route.request().url());
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const install: MarketplaceInstall = marketplaceInstall.parse({
      id: installId,
      appId: id,
      grantedScopes: business.apps.find((each) => each.id === id)?.scopes ?? [],
      grantedReadGroups: business.apps.find((each) => each.id === id)?.readGroups ?? [],
      installedBy: 'Dana Brooks',
      installedAt: '2026-10-16T09:00:00.000Z',
    });
    business.apps = business.apps.map((each) => (each.id === id ? { ...each, install } : each));
    await route.fulfill({ status: 201, json: install });
  });
  await page.route(/\/api\/v1\/marketplace\/installs\/mins_[^/]+$/, async (route) => {
    record(route.request().method(), route.request().url());
    business.apps = business.apps.map((each) =>
      each.install?.id === installId ? { ...each, install: null } : each,
    );
    await route.fulfill({ status: 204 });
  });
}

const harborMarketplace = (patch: Partial<Business> = {}): Business => ({
  apps: [zap, dial],
  missing: [],
  canInstall: true,
  sent: [],
  ...patch,
});

async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(result.violations).toEqual([]);
}
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('browses the listed apps by search, category and the Installed tab', async ({ page }) => {
    await signedIn(page);
    const business = harborMarketplace({
      apps: [
        zap,
        {
          ...dial,
          install: {
            id: installId,
            appId: dialId,
            grantedScopes: ['calls.read'],
            grantedReadGroups: [],
            installedBy: 'Dana Brooks',
            installedAt: '2026-10-03T09:00:00.000Z',
          },
        },
      ],
    });
    await marketplaceApi(page, business);
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'App Marketplace' }).click();

    await expect(page).toHaveURL(inHarbor('/app-marketplace'));
    await expect(page.getByRole('heading', { level: 1, name: 'App Marketplace' })).toBeVisible();
    await expect(page).toHaveTitle('App Marketplace · Harbor Lights Events');
    const apps = page.getByRole('list', { name: 'Apps' });
    await expect(apps.getByRole('link')).toHaveText(['Zap Sync', 'Dial Pad']);
    await expect(apps.locator('> li').nth(1)).toContainText('Installed');

    await page.getByRole('searchbox', { name: 'Search apps' }).fill('zap');
    await expect(apps.getByRole('link')).toHaveText(['Zap Sync']);
    await expect(page).toHaveURL(`${inHarbor('/app-marketplace')}?q=zap`);
    await page.getByRole('searchbox', { name: 'Search apps' }).fill('');
    await expect(apps.getByRole('link')).toHaveText(['Zap Sync', 'Dial Pad']);
    await choose(page.getByRole('combobox', { name: 'Category' }), 'communication');
    await expect(apps.getByRole('link')).toHaveText(['Dial Pad']);
    await choose(page.getByRole('combobox', { name: 'Category' }), 'any');

    await page.getByRole('tab', { name: 'Installed' }).click();
    await expect(page).toHaveURL(`${inHarbor('/app-marketplace')}?tab=installed`);
    await expect(apps.getByRole('link')).toHaveText(['Dial Pad']);
    await expectAccessible(page);
  });

  test('installs an app from the keyboard, with consent, and then uninstalls it', async ({
    page,
  }) => {
    await signedIn(page);
    const business = harborMarketplace();
    await marketplaceApi(page, business);
    await page.goto(inHarbor('/app-marketplace'));

    await page.getByRole('link', { name: 'Zap Sync' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(inHarbor(`/app-marketplace/${zapId}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Zap Sync' })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Permissions' }).getByRole('listitem'),
    ).toHaveText([
      'Add, change and trash contacts',
      'Manage tags',
      'Contacts',
      'Tags',
      'A contact is created',
    ]);
    await expect(
      page.getByText(/connects through the link its developer gives you/).first(),
    ).toBeVisible();

    await page.getByRole('main').getByRole('link', { name: 'App Marketplace' }).focus();
    await page.keyboard.press('Tab');
    const install = page.getByRole('button', { name: 'Install App' });
    await expect(install).toBeFocused();
    await page.keyboard.press('Enter');
    const review = page.getByRole('dialog', { name: 'Install Zap Sync?' });
    await expect(review.getByRole('listitem')).toHaveText([
      'Add, change and trash contacts',
      'Manage tags',
      'Contacts',
      'Tags',
      'A contact is created',
    ]);
    await expectAccessible(page);
    await expect(review.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(review.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(review.getByRole('button', { name: 'Allow & Install' })).toBeFocused();
    expect(business.sent).toEqual([]);
    await page.keyboard.press('Enter');

    await expect(review).toHaveCount(0);
    const uninstall = page.getByRole('button', { name: 'Uninstall' });
    await expect(uninstall).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'installed' })).toHaveText(
      'Zap Sync is installed.',
    );
    await expect(page.getByRole('region', { name: 'Installed' })).toContainText(
      'Installed by Dana Brooks on Oct 16, 2026.',
    );
    expect(business.sent).toEqual([
      { method: 'POST', path: `/api/v1/marketplace/apps/${zapId}/install` },
    ]);

    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: 'Uninstall Zap Sync?' });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(uninstall).toBeFocused();
    expect(business.sent).toHaveLength(1);
    await uninstall.click();
    await confirm.getByRole('button', { name: 'Uninstall' }).click();
    await expect(page.getByRole('button', { name: 'Install App' })).toBeVisible();
    expect(business.sent.at(-1)).toEqual({
      method: 'DELETE',
      path: `/api/v1/marketplace/installs/${installId}`,
    });

    await page.getByRole('main').getByRole('link', { name: 'App Marketplace' }).click();
    await page.getByRole('tab', { name: 'Installed' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'No apps installed' })).toBeVisible();
  });

  test('refuses an install that asks for a permission the person lacks', async ({ page }) => {
    await signedIn(page);
    const business = harborMarketplace({ missing: ['tags.manage'] });
    await marketplaceApi(page, business);
    await page.goto(inHarbor(`/app-marketplace/${zapId}`));
    await expect(page.getByRole('button', { name: 'Install App' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Install App' })).toHaveAccessibleDescription(
      /You can’t install this app: it asks for permissions you don’t have\..*Manage tags/,
    );
    await expectAccessible(page);
    expect(business.sent).toEqual([]);
  });

  test('says when an app is not in the marketplace', async ({ page }) => {
    await signedIn(page);
    await marketplaceApi(page, harborMarketplace());
    await page.goto(inHarbor('/app-marketplace/mapp_01k8e2wzr0e008000000000009'));
    await expect(page.getByRole('heading', { level: 1, name: 'App not found' })).toBeVisible();
    await expect(page.getByText('This app isn’t listed for this business.')).toBeVisible();
  });
});

const agencyApp: AgencyMarketplaceApp = agencyMarketplaceApp.parse({
  ...zap,
  status: 'draft',
  installCount: 0,
  redirectUris: [],
  clientSecretPrefix: null,
  clientSecretSetAt: null,
  webhookUrl: null,
  webhookSecretSetAt: null,
});

/** The agency's apps as the API answers them, kept up to date as the page changes them. */
async function agencyApi(page: Page, apps: AgencyMarketplaceApp[]) {
  const sent: { method: string; body: unknown }[] = [];
  await page.route('**/api/v1/agency/marketplace/apps', async (route) => {
    if (route.request().method() === 'POST') {
      const body: unknown = route.request().postDataJSON();
      sent.push({ method: 'POST', body });
      const made = agencyMarketplaceApp.parse({
        ...agencyApp,
        ...createMarketplaceAppInput.parse(body),
        id: dialId,
      });
      apps.push(made);
      await route.fulfill({ status: 201, json: made });
      return;
    }
    await route.fulfill({ json: agencyMarketplaceAppList.parse({ items: apps }) });
  });
  await page.route(
    /\/api\/v1\/agency\/marketplace\/apps\/mapp_[^/]+\/client-secret$/,
    async (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
      sent.push({ method: 'POST', body: { secretFor: id } });
      const secret = {
        clientId: id,
        clientSecret: `crm_cs_${'1'.repeat(64)}`,
        clientSecretPrefix: 'crm_cs_11111111',
        clientSecretSetAt: '2026-10-17T09:00:00.000Z',
      };
      const index = apps.findIndex((each) => each.id === id);
      const before = apps[index];
      if (before !== undefined)
        apps[index] = {
          ...before,
          clientSecretPrefix: secret.clientSecretPrefix,
          clientSecretSetAt: secret.clientSecretSetAt,
        };
      await route.fulfill({ status: 201, json: secret });
    },
  );
  await page.route(/\/api\/v1\/agency\/marketplace\/apps\/mapp_[^/]+$/, async (route) => {
    const body: unknown = route.request().postDataJSON();
    sent.push({ method: 'PUT', body });
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const index = apps.findIndex((each) => each.id === id);
    const before = apps[index];
    if (before === undefined) throw new Error(`No app ${String(id)}`);
    const saved = { ...before, ...updateMarketplaceAppInput.parse(body) };
    apps[index] = saved;
    await route.fulfill({ json: saved });
  });
  await page.route(/\/webhook-secret$/, async (route) => {
    sent.push({ method: 'POST', body: { webhookSecret: true } });
    await route.fulfill({
      status: 201,
      json: { secret: `whsec_${'w'.repeat(43)}`, setAt: '2026-10-17T09:00:00.000Z' },
    });
  });
  await page.route(/\/deliveries(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'mdlv_01k8e2wzr0e008000000000001',
            eventType: 'app.installed',
            business: { id: harbor.id, name: harbor.name },
            status: 'delivered',
            attempts: 1,
            lastStatus: 200,
            lastError: null,
            lastAttemptAt: '2026-10-17T09:00:01.000Z',
            nextAttemptAt: null,
            deliveredAt: '2026-10-17T09:00:01.000Z',
            createdAt: '2026-10-17T09:00:00.000Z',
          },
        ],
      },
    }),
  );
  await page.route(/\/redeliver$/, async (route) => {
    sent.push({ method: 'POST', body: { redeliver: true } });
    await route.fulfill({
      json: {
        id: 'mdlv_01k8e2wzr0e008000000000001',
        eventType: 'app.installed',
        business: { id: harbor.id, name: harbor.name },
        status: 'pending',
        attempts: 0,
        lastStatus: 200,
        lastError: null,
        lastAttemptAt: null,
        nextAttemptAt: '2026-10-17T09:05:00.000Z',
        deliveredAt: null,
        createdAt: '2026-10-17T09:00:00.000Z',
      },
    });
  });
  return sent;
}

test.describe('the agency’s apps at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('adds an app as a draft, then lists and delists it', async ({ page }) => {
    await signedIn(page, undefined, {}, agencyStaff);
    const sent = await agencyApi(page, [agencyApp]);
    await page.goto('/agency/settings');
    await page.getByRole('link', { name: 'Marketplace apps' }).click();
    await expect(page).toHaveURL('/agency/settings/marketplace-apps');
    await expect(page.getByRole('heading', { level: 1, name: 'Marketplace apps' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Marketplace apps' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByRole('button', { name: 'Add app' }).click();
    const form = page.getByRole('region', { name: 'Add app' });
    await form.getByRole('button', { name: 'Add app' }).click();
    await expect(
      form.getByRole('textbox', { name: 'Name', exact: true }),
    ).toHaveAccessibleDescription('Give the app a name.');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Dial Pad');
    await form.getByRole('textbox', { name: 'Developer', exact: true }).fill('Lakeside Software');
    await form
      .getByRole('textbox', { name: 'Website', exact: true })
      .fill('https://dialpad.example');
    await form.getByRole('checkbox', { name: 'Communication' }).check();
    await form.getByRole('checkbox', { name: 'Read call history' }).check();
    await expectAccessible(page);
    await form.getByRole('button', { name: 'Add app' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'draft' })).toHaveText(
      'Dial Pad is added as a draft. List it when businesses should see it.',
    );
    expect(sent).toEqual([
      {
        method: 'POST',
        body: {
          name: 'Dial Pad',
          tagline: '',
          description: '',
          developer: 'Lakeside Software',
          websiteUrl: 'https://dialpad.example',
          supportEmail: null,
          iconUrl: null,
          categories: ['communication'],
          scopes: ['calls.read'],
          readGroups: [],
          redirectUris: [],
          webhookUrl: null,
          webhookEvents: [],
        },
      },
    ]);
    const row = page.getByRole('row').filter({ hasText: 'Dial Pad' });
    await expect(row).toContainText('Draft');
    await row.getByRole('button', { name: 'List Dial Pad' }).click();
    await expect(row).toContainText('Listed');
    await row.getByRole('button', { name: 'Delist Dial Pad' }).click();
    await expect(row).toContainText('Delisted');
    expect(sent.slice(1).map((each) => (each.body as { status: string }).status)).toEqual([
      'listed',
      'delisted',
    ]);
    await expectAccessible(page);
  });
});

test.describe('an app’s connection at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('shows the client id, generates the secret once, and gives the authorization address', async ({
    page,
  }) => {
    await signedIn(page, undefined, {}, agencyStaff);
    const sent = await agencyApi(page, [
      { ...agencyApp, redirectUris: ['https://zapsync.example/oauth/callback'] },
    ]);
    await page.goto('/agency/settings/marketplace-apps');
    await page.getByRole('button', { name: 'Connection for Zap Sync' }).click();
    const panel = page.getByRole('region', { name: 'Connect Zap Sync' });
    await expect(panel.getByRole('textbox', { name: 'Client ID' })).toHaveValue(zapId);
    await expect(
      panel.getByText('None yet. The app can’t connect until it has one.'),
    ).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'Send people here to connect' })).toHaveValue(
      /\/oauth\/authorize\?response_type=code&client_id=mapp_[^&]+&redirect_uri=https%3A%2F%2Fzapsync\.example%2Foauth%2Fcallback&state=\{state\}/,
    );
    await panel.getByRole('button', { name: 'Generate client secret' }).click();
    await expect(panel.getByRole('textbox', { name: 'New client secret' })).toHaveValue(
      `crm_cs_${'1'.repeat(64)}`,
    );
    expect(sent).toEqual([{ method: 'POST', body: { secretFor: zapId } }]);
    await expectAccessible(page);
    await panel.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Connection for Zap Sync' }).click();
    await expect(page.getByText(/Starts with crm_cs_11111111/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'New client secret' })).toHaveCount(0);
  });
});

const REDIRECT = 'https://zapsync.example/oauth/callback';
/** What an app puts in the address it sends a person to; the state looks like a number. */
const consentAddress = `/oauth/authorize?${new URLSearchParams({
  client_id: zapId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  state: '40180068',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
}).toString()}`;

/** The consent page's two endpoints, and the app's own page the person is sent back to. */
async function consentApi(page: Page) {
  const sent: {
    method: string;
    business: string | undefined;
    body: unknown;
    state: string | null;
  }[] = [];
  await page.route('**/api/v1/oauth/authorize*', async (route) => {
    const request = route.request();
    const business = request.headers()['business-id'];
    if (request.method() === 'POST') {
      const body: unknown = request.postDataJSON();
      sent.push({ method: 'POST', business, body, state: null });
      await route.fulfill({
        status: 201,
        json: { redirectUrl: `${REDIRECT}?code=crm_ac_${'a'.repeat(64)}&state=40180068` },
      });
      return;
    }
    const state = new URL(request.url()).searchParams.get('state');
    sent.push({ method: 'GET', business, body: undefined, state });
    await route.fulfill({
      json: {
        kind: 'consent',
        app: {
          id: zapId,
          name: 'Zap Sync',
          developer: 'Northwind Labs',
          iconUrl: null,
          websiteUrl: null,
        },
        scopes: ['contacts.manage', 'tags.manage'],
        readGroups: ['Contacts', 'Tags'],
        webhookEvents: ['contact.created'],
        missingScopes: [],
        canInstall: true,
        installed: business === northwind.id,
        denyUrl: `${REDIRECT}?error=access_denied&state=40180068`,
      },
    });
  });
  await page.route('https://zapsync.example/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Zap Sync</title><h1>Back in Zap Sync</h1>',
    }),
  );
  return sent;
}

test.describe('connecting an app at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('someone signed out signs in first and comes back to the same request', async ({ page }) => {
    await signedIn(page, null);
    await page.goto(consentAddress);
    await expect(page).toHaveURL(/\/sign-in\?/);
    const next = new URL(page.url()).searchParams.get('next') ?? '';
    expect(new URL(next, 'http://crm.test').searchParams.get('state')).toBe('40180068');
  });

  test('allows the app in the business chosen and sends the person back with the code', async ({
    page,
  }) => {
    await signedIn(page, undefined, {}, agencyStaff);
    const sent = await consentApi(page);
    await page.goto(consentAddress);
    await expect(page.getByText('Zap Sync wants to connect to Harbor Lights Events')).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveText([
      'Add, change and trash contacts',
      'Manage tags',
      'Contacts',
      'Tags',
      'A contact is created',
    ]);
    await page.getByLabel('Business').selectOption(northwind.id);
    await expect(page.getByText('Zap Sync wants to connect to Northwind Weddings')).toBeVisible();
    await page.getByLabel('Business').selectOption(harbor.id);
    await page.getByRole('button', { name: 'Allow & Install' }).click();
    await expect(page.getByRole('heading', { name: 'Back in Zap Sync' })).toBeVisible();
    expect(page.url()).toBe(`${REDIRECT}?code=crm_ac_${'a'.repeat(64)}&state=40180068`);
    // The state reached the API as the app wrote it, not as a number.
    expect(sent.filter((each) => each.method === 'GET').map((each) => each.state)).toContain(
      '40180068',
    );
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      business: harbor.id,
      body: { clientId: zapId, redirectUri: REDIRECT, state: '40180068' },
    });
  });

  test('Cancel sends the person back with access_denied', async ({ page }) => {
    await signedIn(page);
    await consentApi(page);
    await page.goto(consentAddress);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Back in Zap Sync' })).toBeVisible();
    expect(page.url()).toBe(`${REDIRECT}?error=access_denied&state=40180068`);
  });
});

for (const width of [360, 1280]) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('the marketplace, an app and its review are accessible and fit', async ({
      page,
    }, testInfo) => {
      await signedIn(page);
      await marketplaceApi(page, harborMarketplace());
      await page.goto(inHarbor('/app-marketplace'));
      await expect(page.getByRole('list', { name: 'Apps' }).getByRole('link')).toHaveCount(2);
      await expectAccessible(page);
      expect(await fits(page)).toBe(true);
      await testInfo.attach(`marketplace-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });

      await page.getByRole('link', { name: 'Zap Sync' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Zap Sync' })).toBeVisible();
      await testInfo.attach(`marketplace-app-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      await page.getByRole('button', { name: 'Install App' }).click();
      await expect(page.getByRole('dialog', { name: 'Install Zap Sync?' })).toBeVisible();
      await expectAccessible(page);
      expect(await fits(page)).toBe(true);
      await testInfo.attach(`marketplace-review-${String(width)}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });

    test('the consent page is accessible and fits', async ({ page }, testInfo) => {
      await signedIn(page, undefined, {}, agencyStaff);
      await consentApi(page);
      await page.goto(consentAddress);
      await expect(page.getByRole('button', { name: 'Allow & Install' })).toBeVisible();
      await expectAccessible(page);
      expect(await fits(page)).toBe(true);
      await testInfo.attach(`oauth-consent-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });

    test('an app’s connection is accessible and fits', async ({ page }, testInfo) => {
      await signedIn(page, undefined, {}, agencyStaff);
      await agencyApi(page, [
        {
          ...agencyApp,
          redirectUris: [REDIRECT],
          webhookUrl: 'https://zapsync.example/hooks',
          webhookEvents: ['contact.created'],
        },
      ]);
      await page.goto('/agency/settings/marketplace-apps');
      await page.getByRole('button', { name: 'Connection for Zap Sync' }).click();
      await page.getByRole('button', { name: 'Generate client secret' }).click();
      await expect(page.getByRole('textbox', { name: 'New client secret' })).toBeVisible();
      await page.getByRole('button', { name: 'Generate webhook secret' }).click();
      await expect(page.getByRole('textbox', { name: 'New webhook secret' })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Latest deliveries' })).toBeVisible();
      await expectAccessible(page);
      expect(await fits(page)).toBe(true);
      await testInfo.attach(`marketplace-connection-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });

    test('Marketplace apps is accessible and fits, with the form open', async ({
      page,
    }, testInfo) => {
      await signedIn(page, undefined, {}, agencyStaff);
      await agencyApi(page, [agencyApp]);
      await page.goto('/agency/settings/marketplace-apps');
      await expect(page.getByRole('cell', { name: 'Zap Sync', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Edit Zap Sync' }).click();
      await expect(page.getByRole('region', { name: 'Edit Zap Sync' })).toBeVisible();
      await expectAccessible(page);
      expect(await fits(page)).toBe(true);
      await testInfo.attach(`marketplace-apps-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });
  });
}
