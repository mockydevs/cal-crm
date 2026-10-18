import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  domainOf,
  fakeDomainsApi,
  redirectOf,
  siteOf,
  verified,
  type DomainsApi,
} from './domains-fixtures';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

const main = (page: Page): Locator => page.getByRole('main');
const dialog = (page: Page, name: string): Locator =>
  page.getByRole('dialog', { name, exact: true });
const card = (page: Page, hostname: string): Locator =>
  main(page).getByRole('region', { name: hostname, exact: true });
const row = (page: Page, address: string): Locator =>
  main(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: address, exact: true }) });
const view = (page: Page, name: string): Locator =>
  main(page)
    .getByRole('group', { name: 'Domains & URL Redirects' })
    .getByRole('button', { name, exact: true });

async function pick(page: Page, address: string, action: string): Promise<void> {
  await main(page)
    .getByRole('button', { name: `Actions for ${address}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

const bodiesOf = (api: DomainsApi, call: RegExp): unknown[] =>
  api.sent.filter((each) => call.test(each.call)).map((each) => each.body);

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** A business with a verified root domain, a pending subdomain, two redirects and two sites. */
async function harborDomains(
  page: Page,
  options: { canManage?: boolean; pointsElsewhere?: readonly string[] } = {},
) {
  const root = domainOf('harborlights.example', { verification: verified, siteCount: 2 });
  const go = domainOf('go.harborlights.example');
  const spring = siteOf('funnel', 'Spring offer');
  const brochure = siteOf('website', 'Harbor brochure');
  const api = await fakeDomainsApi(page, {
    ...options,
    domains: [root, go],
    sites: [spring, brochure],
    redirects: [
      redirectOf(root, '/old-menu', { type: 'url', url: 'https://example.com/menu' }),
      redirectOf(
        go,
        '/spring',
        { type: 'site', siteId: spring.id, siteName: spring.name, siteKind: 'funnel' },
        302,
      ),
    ],
  });
  return { api, root, go, spring, brochure };
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('with no domain: a sentence, Connect a domain, and a link out to a registrar', async ({
  page,
}) => {
  await fakeDomainsApi(page);
  await page.goto(inHarbor('/settings/domains'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Domains & URL Redirects' }),
  ).toBeVisible();
  await expect(main(page).getByRole('heading', { name: 'No domains connected yet' })).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Connect a domain' })).toBeVisible();
  const link = main(page).getByRole('link', { name: /Cloudflare Registrar/ });
  await expect(link).toHaveAttribute('href', 'https://www.cloudflare.com/products/registrar/');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // Nothing in the product buys or transfers a domain.
  await expect(main(page).getByText(/purchase|transfer/i)).toHaveCount(0);
  await expect(main(page).getByRole('link')).toHaveCount(1);
});

test('connects a domain, shows its record to copy, and checks it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const api = await fakeDomainsApi(page, { pointsElsewhere: ['harborlights.example'] });
  await page.goto(inHarbor('/settings/domains'));
  await main(page).getByRole('button', { name: 'Connect a domain' }).click();
  const connect = dialog(page, 'Connect a domain');
  await connect.getByLabel('Domain').fill('https://shop.harborlights.example');
  await connect.getByRole('button', { name: 'Connect' }).click();
  await expect(connect.getByText('Enter a domain name, such as www.example.com.')).toBeVisible();
  expect(bodiesOf(api, /^POST \/site-domains$/)).toEqual([]);

  await connect.getByLabel('Domain').fill(' Shop.HarborLights.example ');
  await connect.getByRole('button', { name: 'Connect' }).click();
  await expect(connect).toHaveCount(0);
  expect(bodiesOf(api, /^POST \/site-domains$/)).toEqual([
    { hostname: 'shop.harborlights.example' },
  ]);

  // The record, exactly as the server gave it.
  const shop = card(page, 'shop.harborlights.example');
  await expect(shop.getByText('Pending', { exact: true })).toBeVisible();
  const record = shop.getByRole('group', { name: 'DNS record' });
  await expect(record.getByRole('definition')).toHaveText(['CNAME', 'shop', 'sites.crm.example']);
  await record.getByRole('button', { name: 'Copy value' }).click();
  await expect(main(page).getByRole('status')).toHaveText('Copied sites.crm.example');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('sites.crm.example');
  await record.getByRole('button', { name: 'Copy name' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('shop');

  await shop.getByRole('button', { name: 'Check' }).click();
  await expect(shop.getByText('Verified', { exact: true })).toBeVisible();
  await expect(main(page).getByRole('status')).toHaveText('shop.harborlights.example is verified.');
  await expect(shop.getByText(/Last checked/)).toBeVisible();

  // The same name twice is the server's to refuse, under the box; a root domain gets an A record.
  await main(page).getByRole('button', { name: 'Connect a domain' }).click();
  await connect.getByLabel('Domain').fill('shop.harborlights.example');
  await connect.getByRole('button', { name: 'Connect' }).click();
  await expect(connect.getByText(/already connected/)).toBeVisible();
  await expect(connect.getByLabel('Domain')).toHaveAttribute('aria-invalid', 'true');
  await connect.getByLabel('Domain').fill('harborlights.example');
  await connect.getByRole('button', { name: 'Connect' }).click();
  await expect(connect).toHaveCount(0);
  const root = card(page, 'harborlights.example');
  await expect(root.getByRole('group', { name: 'DNS record' }).getByRole('definition')).toHaveText([
    'A',
    '@',
    '203.0.113.10',
  ]);

  // A check that finds the record missing says why, in the server's words.
  await root.getByRole('button', { name: 'Check' }).click();
  await expect(root.getByText('Failed', { exact: true })).toBeVisible();
  await expect(
    root.getByText('harborlights.example does not point at this install yet.'),
  ).toBeVisible();

  // A root domain can answer at www too.
  // The box shows what is saved, so it turns on once the server has answered.
  const www = root.getByRole('checkbox', { name: /Also answer at www\.harborlights\.example/ });
  await www.click();
  await expect(www).toBeChecked();
  expect(bodiesOf(api, /^PATCH \/site-domains\//)).toEqual([{ revision: 2, wwwRedirect: true }]);
  await expect(shop.getByRole('checkbox')).toHaveCount(0);
});

test('an install without a sites address says so, with no record and no error dump', async ({
  page,
}) => {
  await fakeDomainsApi(page, {
    domains: [domainOf('go.harborlights.example')],
    noAddress: true,
  });
  await page.goto(inHarbor('/settings/domains'));
  const go = card(page, 'go.harborlights.example');
  await expect(
    go.getByText(/This install's sites address isn't set up yet, so there is no DNS record/),
  ).toBeVisible();
  await expect(go.getByRole('group', { name: 'DNS record' })).toHaveCount(0);
  await go.getByRole('button', { name: 'Check' }).click();
  await expect(go.getByRole('alert')).toHaveText(
    "It wasn't checked: this install's sites address isn't set up yet.",
  );
  await expect(go.getByText('Pending', { exact: true })).toBeVisible();
});

test('removes a domain after asking, and its redirects go with it', async ({ page }) => {
  const { api, go } = await harborDomains(page);
  await page.goto(inHarbor('/settings/domains'));
  await expect(card(page, 'harborlights.example').getByText('Verified')).toBeVisible();
  await expect(
    card(page, 'harborlights.example').getByText('Linked to 2 funnels and websites.'),
  ).toBeVisible();
  const remove = card(page, 'go.harborlights.example').getByRole('button', { name: 'Remove' });
  await remove.click();
  const asking = dialog(page, 'Remove domain');
  await expect(asking).toContainText('go.harborlights.example and its redirects will be removed.');
  await asking.getByRole('button', { name: 'Cancel' }).click();
  await expect(remove).toBeFocused();
  expect(api.sent).toEqual([]);

  await remove.click();
  await asking.getByRole('button', { name: 'Remove' }).click();
  await expect(card(page, 'go.harborlights.example')).toHaveCount(0);
  await expect(main(page).getByRole('status')).toHaveText('go.harborlights.example was removed.');
  expect(api.sent.map((each) => each.call)).toEqual([`DELETE /site-domains/${go.id}`]);

  await view(page, 'URL Redirects').click();
  await expect(row(page, 'harborlights.example/old-menu')).toBeVisible();
  await expect(row(page, 'go.harborlights.example/spring')).toHaveCount(0);
});

test('adds, changes and deletes a redirect, with a refusal under its box', async ({ page }) => {
  const { api, root, go, brochure } = await harborDomains(page);
  await page.goto(inHarbor('/settings/domains'));
  await view(page, 'URL Redirects').click();
  await expect(view(page, 'URL Redirects')).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 'harborlights.example/old-menu')).toContainText(
    'https://example.com/menu',
  );
  await expect(row(page, 'harborlights.example/old-menu')).toContainText('Permanent (301)');
  await expect(row(page, 'go.harborlights.example/spring')).toContainText('Spring offer (funnel)');
  await expect(row(page, 'go.harborlights.example/spring')).toContainText('Temporary (302)');

  // Add: the same path twice on a domain is refused under Path, and Save works again after.
  await main(page).getByRole('button', { name: 'Add redirect' }).click();
  const adding = dialog(page, 'Add redirect');
  await choose(adding.getByRole('combobox', { name: 'Domain' }), root.id);
  await adding.getByLabel('Path').fill('/old-menu');
  await choose(adding.getByRole('combobox', { name: 'Send to' }), 'site');
  await expect(adding.getByRole('button', { name: 'Save' })).toBeDisabled();
  await choose(adding.getByRole('combobox', { name: 'Funnel or website' }), brochure.id);
  await adding.getByRole('button', { name: 'Save' }).click();
  await expect(adding.getByText('This domain already has a redirect at this path.')).toBeVisible();
  await expect(adding.getByLabel('Path')).toHaveAttribute('aria-invalid', 'true');
  await expect(adding.getByLabel('Path')).toBeFocused();
  await adding.getByLabel('Path').fill('/brochure');
  await expect(adding.getByText('This domain already has a redirect at this path.')).toHaveCount(0);
  await adding.getByRole('button', { name: 'Save' }).click();
  await expect(adding).toHaveCount(0);
  await expect(row(page, 'harborlights.example/brochure')).toContainText(
    'Harbor brochure (website)',
  );
  expect(bodiesOf(api, /^POST \/site-redirects$/)).toEqual([
    {
      domainId: root.id,
      path: '/old-menu',
      target: { type: 'site', siteId: brochure.id },
      status: 301,
    },
    {
      domainId: root.id,
      path: '/brochure',
      target: { type: 'site', siteId: brochure.id },
      status: 301,
    },
  ]);

  // Change: the domain stays; the schema refuses a bad web address before anything is sent.
  await pick(page, 'go.harborlights.example/spring', 'Edit');
  const editing = dialog(page, 'Edit redirect');
  await expect(editing.getByLabel('Path')).toHaveValue('/spring');
  await choose(editing.getByRole('combobox', { name: 'Send to' }), 'url');
  await editing.getByLabel('Web address').fill('example.com/spring');
  await editing.getByRole('button', { name: 'Save' }).click();
  await expect(
    editing.getByText('Use a web address starting with http:// or https://.'),
  ).toBeVisible();
  expect(bodiesOf(api, /^PATCH \/site-redirects\//)).toEqual([]);
  await editing.getByLabel('Web address').fill('https://example.com/spring');
  await choose(editing.getByRole('combobox', { name: 'Type' }), '301');
  // A refusal only the server can make is said under the box it names, and Save works again.
  api.refuse(/^PATCH \/site-redirects\//, {
    status: 422,
    errors: [{ path: '/target/url', code: 'invalid', message: 'This address cannot be used.' }],
  });
  await editing.getByRole('button', { name: 'Save' }).click();
  await expect(editing.getByText('This address cannot be used.')).toBeVisible();
  await expect(editing.getByLabel('Web address')).toHaveAttribute('aria-invalid', 'true');
  await editing.getByRole('button', { name: 'Save' }).click();
  await expect(editing).toHaveCount(0);
  await expect(row(page, 'go.harborlights.example/spring')).toContainText(
    'https://example.com/spring',
  );
  await expect(row(page, 'go.harborlights.example/spring')).toContainText('Permanent (301)');
  const change = {
    revision: 1,
    path: '/spring',
    target: { type: 'url', url: 'https://example.com/spring' },
    status: 301,
  };
  expect(bodiesOf(api, /^PATCH \/site-redirects\//)).toEqual([change, change]);
  expect(api.redirects.find((each) => each.path === '/spring')?.domainId).toBe(go.id);

  // Delete, after asking.
  await pick(page, 'harborlights.example/old-menu', 'Delete');
  const asking = dialog(page, 'Delete redirect');
  await expect(asking).toContainText('harborlights.example/old-menu will stop redirecting.');
  await asking.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'harborlights.example/old-menu')).toHaveCount(0);
  await expect(main(page).getByRole('row')).toHaveCount(3);
});

test('someone who may only read sees no way to change anything', async ({ page }) => {
  await harborDomains(page, { canManage: false });
  await page.goto(inHarbor('/settings/domains'));
  await expect(card(page, 'harborlights.example')).toBeVisible();
  await expect(main(page).getByText(/needs permission to manage domains/)).toBeVisible();
  await expect(main(page).getByRole('button')).toHaveText([
    'Domains',
    'URL Redirects',
    '',
    '',
    '',
    '',
  ]);
  await expect(card(page, 'harborlights.example').getByRole('checkbox')).toBeDisabled();
  await view(page, 'URL Redirects').click();
  await expect(row(page, 'harborlights.example/old-menu')).toBeVisible();
  await expect(main(page).getByText(/needs permission to manage domains/)).toBeVisible();
  await expect(main(page).getByRole('button')).toHaveText(['Domains', 'URL Redirects']);
});

test('a refusal to read says permission is needed', async ({ page }) => {
  await fakeDomainsApi(page, { forbidden: true });
  await page.goto(inHarbor('/settings/domains'));
  await expect(main(page).getByRole('alert')).toHaveText('You need permission to manage domains.');
  await view(page, 'URL Redirects').click();
  await expect(main(page).getByRole('alert')).toHaveText('You need permission to manage domains.');
});

for (const width of [1440, 360]) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the two views and their dialogs have no axe violations', async ({ page }) => {
      await harborDomains(page);
      await page.goto(inHarbor('/settings/domains'));
      await expect(card(page, 'go.harborlights.example')).toBeVisible();
      await expectNoAccessibilityViolations(page);

      await main(page).getByRole('button', { name: 'Connect a domain' }).click();
      await dialog(page, 'Connect a domain').getByLabel('Domain').fill('nope');
      await dialog(page, 'Connect a domain').getByRole('button', { name: 'Connect' }).click();
      await expect(dialog(page, 'Connect a domain').getByText(/Enter a domain name/)).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await dialog(page, 'Connect a domain').getByRole('button', { name: 'Cancel' }).click();

      await card(page, 'go.harborlights.example').getByRole('button', { name: 'Remove' }).click();
      await expect(dialog(page, 'Remove domain')).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await dialog(page, 'Remove domain').getByRole('button', { name: 'Cancel' }).click();

      await view(page, 'URL Redirects').click();
      await expect(row(page, 'harborlights.example/old-menu')).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await main(page).getByRole('button', { name: 'Add redirect' }).click();
      const adding = dialog(page, 'Add redirect');
      await adding.getByLabel('Path').fill('no-slash');
      await adding.getByLabel('Web address').fill('nope');
      await adding.getByRole('button', { name: 'Save' }).click();
      await expect(adding.getByText(/Start the path with/)).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await choose(adding.getByRole('combobox', { name: 'Send to' }), 'site');
      await expect(adding.getByRole('combobox', { name: 'Funnel or website' })).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await adding.getByRole('button', { name: 'Cancel' }).click();
      await pick(page, 'harborlights.example/old-menu', 'Delete');
      await expect(dialog(page, 'Delete redirect')).toBeVisible();
      await expectNoAccessibilityViolations(page);
    });

    test('the empty page has no axe violations', async ({ page }) => {
      await fakeDomainsApi(page);
      await page.goto(inHarbor('/settings/domains'));
      await expect(
        main(page).getByRole('heading', { name: 'No domains connected yet' }),
      ).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await view(page, 'URL Redirects').click();
      await expect(main(page).getByText(/Connect a domain first/)).toBeVisible();
      await expectNoAccessibilityViolations(page);
    });
  });
}

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('both views use the whole width', async ({ page }) => {
    await harborDomains(page);
    const short = (): Promise<string[]> =>
      page.evaluate(() => {
        const edge = document.documentElement.clientWidth - 16;
        const column = document.querySelector('main > div');
        if (column === null) return ['no page'];
        const mayBeShort = new Set(['P', 'BUTTON', 'A', 'LABEL']);
        return [column, ...column.children]
          .filter((element) => !mayBeShort.has(element.tagName))
          .filter((element) => element.getBoundingClientRect().width > 0)
          .filter((element) => Math.abs(element.getBoundingClientRect().right - edge) > 1)
          .map(
            (element) =>
              `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}"`,
          );
      });
    await page.goto(inHarbor('/settings/domains'));
    await expect(card(page, 'go.harborlights.example')).toBeVisible();
    expect(await short()).toEqual([]);
    // Each domain's card reaches the edge of the list's card too.
    const list = await main(page)
      .getByRole('region', { name: 'Domains', exact: true })
      .boundingBox();
    const one = await card(page, 'go.harborlights.example').boundingBox();
    expect((list?.width ?? 0) - (one?.width ?? 0)).toBeLessThanOrEqual(34);
    await view(page, 'URL Redirects').click();
    await expect(row(page, 'harborlights.example/old-menu')).toBeVisible();
    expect(await short()).toEqual([]);
  });
});
