import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { harbor, inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

// Settings → Tags, against the built dashboard with the API stood in for, so each
// answer the API can give is tried. The real server is exercised by @repo/e2e.

interface StoredTag {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

// Ids the server made: the contract checks each wraps a UUIDv7.
const ids = [
  'tag_01m4bd188ff82s0add91b7pz63',
  'tag_01m4bd9fteedat3be9bqgx2047',
  'tag_01m4bdmgqwfgatd5ch0pqddfxm',
] as const;
const at = '2026-10-07T12:00:00.000Z';
const tag = (id: string, name: string, description: string): StoredTag => ({
  id,
  name,
  description,
  createdAt: at,
  updatedAt: at,
});

const problem = (status: number, title: string, errors?: unknown[]) => ({
  status,
  contentType: 'application/problem+json',
  body: JSON.stringify({ type: 'about:blank', title, status, ...(errors ? { errors } : {}) }),
});

/**
 * An API that keeps tags in memory; `answer` can replace any reply. It records what was
 * created, and the business each request named (its Business-Id header).
 */
async function fakeApi(
  page: Page,
  tags: StoredTag[],
  answer?: (route: Route) => Promise<boolean>,
): Promise<{ created: unknown[]; businesses: (string | undefined)[] }> {
  const created: unknown[] = [];
  const businesses: (string | undefined)[] = [];
  await page.route('**/api/v1/tag-configuration', async (route) => {
    businesses.push((await route.request().headerValue('business-id')) ?? undefined);
    if (answer !== undefined && (await answer(route))) return;
    await route.fulfill({
      json: configurationOf([...tags].sort((a, b) => a.name.localeCompare(b.name))),
    });
  });
  await page.route('**/api/v1/tags', async (route) => {
    businesses.push((await route.request().headerValue('business-id')) ?? undefined);
    if (answer !== undefined && (await answer(route))) return;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string; description: string };
      created.push(body);
      const stored = tag(ids[2], body.name, body.description);
      tags.push(stored);
      await route.fulfill({ status: 201, json: stored });
    } else {
      const items = [...tags].sort((a, b) => a.name.localeCompare(b.name));
      await route.fulfill({ json: { items } });
    }
  });
  return { created, businesses };
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

const tagsTable = (page: Page) => page.getByRole('region', { name: 'Tags' }).getByRole('table');

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens Tags from the Settings navigation', async ({ page }) => {
    await fakeApi(page, []);
    await page.goto('/');
    await page.getByRole('link', { name: 'Settings' }).click();
    await page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: 'Tags' })
      .click();

    await expect(page).toHaveURL(inHarbor('/settings/tags'));
    await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
    await expect(page).toHaveTitle('Tags · Harbor Lights Events');
    const settingsPages = page.getByRole('navigation', { name: 'Settings' });
    await expect(settingsPages.getByRole('link', { name: 'Tags' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // In Settings the sidebar lists its pages in place of the modules, and the top bar names it.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Top bar' }).getByText('Settings', { exact: true }),
    ).toBeVisible();
  });

  test("lists the business's tags with what each means", async ({ page }) => {
    await fakeApi(page, [
      tag(ids[0], 'wedding', 'Planning a wedding or rehearsal dinner.'),
      tag(ids[1], 'vip', ''),
    ]);
    await page.goto(inHarbor('/settings/tags'));

    const rows = tagsTable(page).getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1).getByRole('rowheader')).toHaveText('vip');
    await expect(rows.nth(1)).toContainText('Not described yet');
    await expect(rows.nth(2).getByRole('rowheader')).toHaveText('wedding');
    await expect(rows.nth(2)).toContainText('Planning a wedding or rehearsal dinner.');
    await expectNoAccessibilityViolations(page);
  });

  test('says when there are no tags yet', async ({ page }) => {
    await fakeApi(page, []);
    await page.goto(inHarbor('/settings/tags'));

    await expect(page.getByText('No tags yet', { exact: true })).toBeVisible();
    await expect(tagsTable(page)).toHaveCount(0);
  });

  test("says when the tags can't be loaded, and tries again", async ({ page }) => {
    let failing = true;
    await fakeApi(page, [tag(ids[0], 'wedding', '')], async (route) => {
      if (!failing) return false;
      await route.fulfill(problem(500, 'Internal Server Error'));
      return true;
    });
    await page.goto(inHarbor('/settings/tags'));

    // TanStack Query retries three times before giving up.
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(/The tags couldn’t be loaded\./, { timeout: 15_000 });
    failing = false;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(tagsTable(page).getByRole('row', { name: /wedding/ })).toBeVisible();
  });

  test('creates a tag, then shows it in the list', async ({ page }) => {
    const api = await fakeApi(page, []);
    await page.goto(inHarbor('/settings/tags'));

    const newTag = page.getByRole('button', { name: 'New tag' });
    await expect(newTag).toHaveAttribute('aria-expanded', 'false');
    await newTag.click();
    await expect(newTag).toHaveAttribute('aria-expanded', 'true');
    const form = page.getByRole('region', { name: 'New tag' });
    await expect(form.getByLabel('Name')).toBeFocused();
    await expectNoAccessibilityViolations(page);

    await form.getByLabel('Name').fill('  Corporate ');
    await form.getByLabel('What it means').fill('Company events: launches, parties, conferences.');
    await form.getByRole('button', { name: 'Create tag' }).click();

    await expect(tagsTable(page).getByRole('row', { name: /Corporate/ })).toBeVisible();
    expect(api.created).toEqual([
      { name: 'Corporate', description: 'Company events: launches, parties, conferences.' },
    ]);
    // Listing, creating and listing again: each in the business the address names.
    expect(api.businesses).toEqual([harbor.id, harbor.id, harbor.id]);
    await expect(form).toHaveCount(0);
    await expect(newTag).toBeFocused();
    await expect(page.getByRole('status')).toHaveText('Created the tag Corporate.');
  });

  test('asks for a name before sending anything', async ({ page }) => {
    const api = await fakeApi(page, []);
    await page.goto(inHarbor('/settings/tags'));
    await page.getByRole('button', { name: 'New tag' }).click();
    const name = page.getByLabel('Name');

    await name.fill('   ');
    await page.getByRole('button', { name: 'Create tag' }).click();

    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(/Give the tag a name\./);
    expect(api.created).toEqual([]);
    await expectNoAccessibilityViolations(page);
  });

  test("shows the server's reason under the field it's about, until the field changes", async ({
    page,
  }) => {
    await fakeApi(page, [], async (route) => {
      if (route.request().method() !== 'POST') return false;
      await route.fulfill(
        problem(422, 'Unprocessable Content', [
          { path: '/name', code: 'taken', message: 'A tag with this name already exists.' },
        ]),
      );
      return true;
    });
    await page.goto(inHarbor('/settings/tags'));
    await page.getByRole('button', { name: 'New tag' }).click();
    const name = page.getByLabel('Name');

    await name.fill('hot-lead');
    await page.getByRole('button', { name: 'Create tag' }).click();

    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(/A tag with this name already exists\./);
    await name.fill('hot leads');
    await expect(name).not.toHaveAttribute('aria-invalid');
    await expect(page.getByText('A tag with this name already exists.')).toHaveCount(0);
  });

  test("says when the tag couldn't be saved at all", async ({ page }) => {
    await fakeApi(page, [], async (route) => {
      if (route.request().method() !== 'POST') return false;
      await route.abort('connectionrefused');
      return true;
    });
    await page.goto(inHarbor('/settings/tags'));
    await page.getByRole('button', { name: 'New tag' }).click();

    await page.getByLabel('Name').fill('vip');
    await page.getByRole('button', { name: 'Create tag' }).click();

    await expect(page.getByRole('alert')).toHaveText(
      "The tag wasn't saved. Check your connection and try again.",
    );
    await expect(page.getByRole('region', { name: 'New tag' })).toBeVisible();
  });

  test('cancels without saving, and puts the focus back', async ({ page }) => {
    const api = await fakeApi(page, []);
    await page.goto(inHarbor('/settings/tags'));
    const newTag = page.getByRole('button', { name: 'New tag' });
    await newTag.click();

    await page.getByLabel('Name').fill('vip');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByRole('region', { name: 'New tag' })).toHaveCount(0);
    await expect(newTag).toBeFocused();
    expect(api.created).toEqual([]);
  });
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('fits without scrolling sideways, with the form open', async ({ page }) => {
    await fakeApi(page, [tag(ids[0], 'venue partner', 'Venues that send us clients.')]);
    await page.goto(inHarbor('/settings/tags'));
    await page.getByRole('button', { name: 'New tag' }).click();

    await expect(page.getByLabel('What it means')).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
    await expectNoAccessibilityViolations(page);
  });
});
