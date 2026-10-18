import { choose, expectChoice } from './select';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { configurationOf } from './tag-fixtures';
import {
  agencyStaff,
  dana,
  harbor,
  inHarbor,
  northwind,
  signedIn,
  type Business,
  type Workplace,
} from './session';

// Working in a business, and moving between them, against the built dashboard with the API
// stood in for. @repo/e2e switches businesses against the real server.

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    // An open menu's focus guards (Base UI's FocusGuard): hidden spans around it that pass
    // focus on the moment they get it, so Tab stays in the menu. axe sees an aria-hidden
    // element that takes focus; nobody can stop on one.
    .exclude('[data-base-ui-focus-guard]')
    .analyze();
  expect(results.violations).toEqual([]);
}

/** The switcher at the top of the sidebar, named by what it shows. */
const switcher = (page: Page): Locator => page.getByRole('combobox', { name: /^Business:/ });

/** The tags each business has, answered for the business a request names. */
async function tagsByBusiness(page: Page): Promise<(string | undefined)[]> {
  const named: (string | undefined)[] = [];
  const tagsOf: Record<string, string> = {
    [harbor.id]: 'tag_01m4bd188ff82s0add91b7pz63',
    [northwind.id]: 'tag_01m4bd9fteedat3be9bqgx2047',
  };
  await page.route(/\/api\/v1\/(?:tags|tag-configuration)$/, async (route) => {
    const business = (await route.request().headerValue('business-id')) ?? undefined;
    named.push(business);
    const id = business === undefined ? undefined : tagsOf[business];
    const at = '2026-10-07T12:00:00.000Z';
    const items =
      id === undefined
        ? []
        : [
            {
              id,
              name: business === harbor.id ? 'harbor-only' : 'northwind-only',
              description: '',
              createdAt: at,
              updatedAt: at,
            },
          ];
    await route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/tag-configuration')
        ? configurationOf(items)
        : { items },
    });
  });
  return named;
}

test.describe('agency staff', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page, dana, {}, agencyStaff);
  });

  test('open the app on the list of every business', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL('/agency');
    await expect(page.getByRole('heading', { level: 1, name: 'Businesses' })).toBeVisible();
    await expect(page).toHaveTitle('Businesses · Bluebird Digital');
    const list = page.getByRole('list', { name: 'Businesses' });
    await expect(list.getByRole('link')).toHaveText([
      'HLHarbor Lights Events',
      'NWNorthwind Weddings',
      'LDLakeside DentalSuspended',
    ]);
    await expect(switcher(page)).toContainText('All businesses');
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Businesses' }),
    ).toHaveAttribute('aria-current', 'page');
    await expectNoAccessibilityViolations(page);

    await list.getByRole('link', { name: /Northwind Weddings/ }).click();
    await expect(page).toHaveURL('/b/northwind-weddings');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test('switch between businesses, staying in the same section', async ({ page }) => {
    await page.goto(inHarbor('/deals'));
    await expect(switcher(page)).toContainText('Harbor Lights Events');

    await switcher(page).click();
    const menu = page.getByRole('listbox');
    await expect(page.getByRole('combobox', { name: 'Find a business' })).toBeFocused();
    // The agency first, then the business the page is in, then the others by name.
    await expect(menu.getByRole('option')).toHaveText([
      'Agency viewAll businesses',
      'HLHarbor Lights Eventsharbor-lights-events',
      'LDLakeside Dentallakeside-dental',
      'NWNorthwind Weddingsnorthwind-weddings',
    ]);
    await expect(menu.getByRole('option', { name: /Harbor Lights Events/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(menu.getByRole('option', { name: /Northwind Weddings/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    // A popover on the page's light surface, wider than the sidebar and over the page.
    const popup = page.getByRole('dialog', { name: 'Find a business' });
    await expect(popup).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(popup).toHaveCSS('border-radius', '12px');
    const popupBox = await popup.boundingBox();
    expect(popupBox?.width).toBe(320);
    for (const option of await menu.getByRole('option').all())
      expect((await option.boundingBox())?.height).toBe(44);
    const covered = await popup.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.right - 8, box.top + 8);
      return top !== null && element.contains(top);
    });
    expect(covered, 'the popup is above the page beside the sidebar').toBe(true);
    await expectNoAccessibilityViolations(page);

    await menu.getByRole('option', { name: /Northwind Weddings/ }).click();
    await expect(page).toHaveURL('/b/northwind-weddings/deals');
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Opportunities' })).toBeVisible();
    await expect(switcher(page)).toContainText('Northwind Weddings');
    await expect(page).toHaveTitle('Opportunities · Northwind Weddings');
    // The sidebar's link: the top bar has a tab of the same name.
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Opportunities' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('switch with the keyboard', async ({ page }) => {
    await page.goto(inHarbor());
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    await switcher(page).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('listbox');
    const search = page.getByRole('combobox', { name: 'Find a business' });
    await expect(search).toBeFocused();
    // The arrow keys move through the list while the keyboard stays in the search box.
    const northwind = menu.getByRole('option', { name: /Northwind Weddings/ });
    for (let presses = 0; presses < 4; presses += 1) {
      if ((await northwind.getAttribute('data-highlighted')) !== null) break;
      await page.keyboard.press('ArrowDown');
    }
    await expect(northwind).toHaveAttribute('data-highlighted', '');
    await expect(search).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/b/northwind-weddings');
    await expect(switcher(page)).toContainText('Northwind Weddings');
  });

  test('find a business by typing, and are told when none matches', async ({ page }) => {
    await page.goto(inHarbor('/contacts'));
    await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();

    await switcher(page).click();
    const menu = page.getByRole('listbox');
    const search = page.getByRole('combobox', { name: 'Find a business' });
    await expect(search).toBeFocused();
    await page.keyboard.type('zzz');
    await expect(menu.getByRole('option')).toHaveCount(0);
    await expect(page.getByText('No businesses match.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(switcher(page)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(search).toBeFocused();
    await expect(menu.getByRole('option')).toHaveCount(4);
    await page.keyboard.type('lake');
    await expect(menu.getByRole('option')).toHaveText(['LDLakeside Dentallakeside-dental']);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/b/lakeside-dental/contacts');
    await expect(switcher(page)).toContainText('Lakeside Dental');
  });

  test('shows a long business name on one line, whole in its tooltip', async ({ page }) => {
    await page.goto(inHarbor());
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    await expect(switcher(page)).toHaveCSS('height', '44px');
    await expect(switcher(page)).toHaveAttribute('title', 'Harbor Lights Events');
    const name = switcher(page).getByText('Harbor Lights Events', { exact: true });
    await expect(name).toHaveCSS('white-space', 'nowrap');
    await expect(name).toHaveCSS('text-overflow', 'ellipsis');
    const sidebarBox = await page.getByRole('banner').boundingBox();
    const box = await switcher(page).boundingBox();
    expect(box?.x).toBe(12);
    expect(box?.width).toBe((sidebarBox?.width ?? 0) - 24);
  });

  test('see each business only in its own pages, each asking for its own', async ({ page }) => {
    const named = await tagsByBusiness(page);
    await page.goto(inHarbor('/settings/tags'));
    const tags = page.getByRole('region', { name: 'Tags' });
    await expect(tags).toContainText('harbor-only');

    await switcher(page).click();
    await page.getByRole('option', { name: /Northwind Weddings/ }).click();

    await expect(page).toHaveURL('/b/northwind-weddings/settings/tags');
    await expect(tags).toContainText('northwind-only');
    await expect(tags).not.toContainText('harbor-only');

    await page.goBack();
    await expect(page).toHaveURL(inHarbor('/settings/tags'));
    await expect(tags).toContainText('harbor-only');
    await expect(tags).not.toContainText('northwind-only');
    expect(named.length).toBeGreaterThanOrEqual(2);
    expect(new Set(named)).toEqual(new Set([harbor.id, northwind.id]));
  });

  test('go back to the list of every business from the switcher', async ({ page }) => {
    await page.goto(inHarbor('/contacts'));
    await switcher(page).click();
    await page.getByRole('option', { name: /Agency view/ }).click();

    await expect(page).toHaveURL('/agency');
    await expect(page.getByRole('heading', { level: 1, name: 'Businesses' })).toBeVisible();
  });

  test('leave a half-written form behind when they switch', async ({ page }) => {
    const named = await tagsByBusiness(page);
    await page.goto(inHarbor('/settings/tags'));
    await page.getByRole('button', { name: 'New tag' }).click();
    await page.getByRole('region', { name: 'New tag' }).getByLabel('Name').fill('half-written');

    await switcher(page).click();
    await page.getByRole('option', { name: /Northwind Weddings/ }).click();

    await expect(page).toHaveURL('/b/northwind-weddings/settings/tags');
    await expect(page.getByRole('region', { name: 'Tags' })).toContainText('northwind-only');
    await expect(page.getByRole('region', { name: 'New tag' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New tag' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(named).not.toContain(undefined);
  });

  test('keep a change on its way in the business it was made in', async ({ page }) => {
    await tagsByBusiness(page);
    const posted: (string | undefined)[] = [];
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await page.route('**/api/v1/tags', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      posted.push((await route.request().headerValue('business-id')) ?? undefined);
      // Answers once the person has moved on to the other business.
      await answered;
      await route.fulfill({
        status: 201,
        json: {
          id: 'tag_01m4bdmgqwfgatd5ch0pqddfxm',
          name: 'late',
          description: '',
          createdAt: '2026-10-07T12:00:00.000Z',
          updatedAt: '2026-10-07T12:00:00.000Z',
        },
      });
    });
    await page.goto(inHarbor('/settings/tags'));
    await page.getByRole('button', { name: 'New tag' }).click();
    await page.getByRole('region', { name: 'New tag' }).getByLabel('Name').fill('late');
    await page.getByRole('button', { name: 'Create tag' }).click();
    await expect.poll(() => posted).toEqual([harbor.id]);

    await switcher(page).click();
    await page.getByRole('option', { name: /Northwind Weddings/ }).click();
    await expect(page.getByRole('region', { name: 'Tags' })).toContainText('northwind-only');
    // Had the reply reached this page, it would refresh this business's tags and announce
    // the tag here: give it two seconds to show either.
    const refreshed = page
      .waitForRequest(
        (request) =>
          request.url().endsWith('/api/v1/tags') &&
          request.method() === 'GET' &&
          request.headers()['business-id'] === northwind.id,
        { timeout: 2000 },
      )
      .then(
        () => true,
        () => false,
      );
    answer();

    expect(await refreshed).toBe(false);
    await expect(page.getByRole('status')).toHaveText('');
    expect(posted).toEqual([harbor.id]);
  });

  test('switch from a settings page to the same page in the other business', async ({ page }) => {
    await page.route('**/api/auth/passkey/list-user-passkeys', (route) =>
      route.fulfill({ json: [] }),
    );
    await page.route('**/api/v1/agency/two-factor-requirement', (route) =>
      route.fulfill({ json: { required: false } }),
    );
    await page.goto(inHarbor('/settings/sign-in'));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sign-in and security' }),
    ).toBeVisible();

    await switcher(page).click();
    await page.getByRole('option', { name: /Northwind Weddings/ }).click();

    await expect(page).toHaveURL('/b/northwind-weddings/settings/sign-in');
  });
});

test('agency staff with no business yet find only the list in the switcher', async ({ page }) => {
  await signedIn(page, dana, {}, { agencyStaff: true, businesses: [] });
  await page.goto('/');

  await expect(page).toHaveURL('/agency');
  await expect(page.getByText('No businesses yet')).toBeVisible();
  await switcher(page).click();
  const menu = page.getByRole('listbox');
  await expect(menu.getByRole('option')).toHaveText(['Agency viewAll businesses']);
});

test.describe('a business user', () => {
  test('works in their only business, and sees any other as not found', async ({ page }) => {
    await signedIn(page);
    await page.goto('/');
    await expect(page).toHaveURL(inHarbor());

    await page.goto('/b/northwind-weddings/deals');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

    await switcher(page).click();
    const menu = page.getByRole('listbox');
    await expect(menu.getByRole('option')).toHaveText([
      'HLHarbor Lights Eventsharbor-lights-events',
    ]);
    await menu.getByRole('option', { name: /Harbor Lights Events/ }).click();
    await expect(page).toHaveURL(inHarbor());
  });

  test('sees a page their business lacks as not found, still in its menu', async ({ page }) => {
    await signedIn(page);
    await page.goto(inHarbor('/no-such-page'));

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(switcher(page)).toContainText('Harbor Lights Events');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page).toHaveTitle('Page not found · Harbor Lights Events');
  });

  test("can't open the agency's pages", async ({ page }) => {
    await signedIn(page);
    await page.goto('/agency');

    await expect(page).toHaveURL(inHarbor());
  });

  test('with several businesses chooses one first', async ({ page }) => {
    const several: Workplace = { agencyStaff: false, businesses: [harbor, northwind] };
    await signedIn(page, dana, {}, several);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'Choose a business' })).toBeVisible();
    await expect(switcher(page)).toContainText('Choose a business');
    await expectNoAccessibilityViolations(page);
    await page
      .getByRole('list', { name: 'Businesses' })
      .getByRole('link', { name: /Northwind Weddings/ })
      .click();

    await expect(page).toHaveURL('/b/northwind-weddings');
    await switcher(page).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('option', { name: /Agency view/ })).toHaveCount(0);
  });

  test('with no business open to them is told so', async ({ page }) => {
    await signedIn(page, dana, {}, { agencyStaff: false, businesses: [] });
    await page.goto('/');

    await expect(page.getByText('No business is open to you')).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
  });
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('the switcher and the list fit without scrolling sideways', async ({ page }) => {
    await signedIn(page, dana, {}, agencyStaff);
    await page.goto('/agency');
    await expect(page.getByRole('heading', { level: 1, name: 'Businesses' })).toBeVisible();
    await switcher(page).click();
    await expect(page.getByRole('listbox')).toBeVisible();

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
    await expectNoAccessibilityViolations(page);
  });
});

test.describe('creating a business', () => {
  const riverside: Business = {
    id: 'biz_01k8e2wzr0e008000000000004',
    name: 'Riverside Bakery',
    slug: 'riverside-bakery',
    status: 'active',
  };

  /**
   * Agency staff with no business yet, and an API that creates one: GET /me lists what
   * was created, and `answer` can replace the reply to the create.
   */
  async function agencyThatCreates(
    page: Page,
    answer?: (route: Route) => Promise<void>,
  ): Promise<unknown[]> {
    const created: Business[] = [];
    const posted: unknown[] = [];
    await signedIn(page, dana, {}, { agencyStaff: true, businesses: [] });
    // Registered after signedIn's stand-in, so it answers first.
    await page.route('**/api/v1/me', (route) =>
      route.fulfill({
        json: {
          user: { name: dana.name, email: dana.email },
          agency: { name: 'Bluebird Digital', slug: 'bluebird-digital' },
          agencyStaff: true,
          businesses: created,
          business: null,
        },
      }),
    );
    await page.route('**/api/v1/businesses', async (route) => {
      posted.push(route.request().postDataJSON());
      if (answer !== undefined) {
        await answer(route);
        return;
      }
      created.push(riverside);
      await route.fulfill({
        status: 201,
        json: {
          ...riverside,
          timezone: 'Africa/Nairobi',
          currency: 'KES',
          locale: 'en',
          createdAt: '2026-10-08T12:00:00.000Z',
        },
      });
    });
    return posted;
  }

  test('staff create one from the agency page, and land in it', async ({ page }) => {
    const posted = await agencyThatCreates(page);
    await page.goto('/agency');

    const newBusiness = page.getByRole('button', { name: 'New business' });
    await newBusiness.click();
    await expect(newBusiness).toHaveAttribute('aria-expanded', 'true');
    const form = page.getByRole('region', { name: 'New business' });
    await expect(form.getByLabel('Name')).toBeFocused();
    await expectNoAccessibilityViolations(page);

    await form.getByLabel('Name').fill(' Riverside Bakery ');
    await choose(form.getByLabel('Time zone'), 'Africa/Nairobi');
    await choose(form.getByLabel('Currency'), 'KES');
    await form.getByRole('button', { name: 'Create business' }).click();

    await expect(page).toHaveURL('/b/riverside-bakery');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(switcher(page)).toContainText('Riverside Bakery');
    expect(posted).toEqual([
      { name: 'Riverside Bakery', timezone: 'Africa/Nairobi', currency: 'KES', locale: 'en' },
    ]);
  });

  test('starts in the browser time zone, and names each currency', async ({ page }) => {
    await agencyThatCreates(page);
    await page.goto('/agency');
    await page.getByRole('button', { name: 'New business' }).click();
    const form = page.getByRole('region', { name: 'New business' });

    const here = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await expectChoice(form.getByLabel('Time zone'), here);
    await expectChoice(form.getByLabel('Currency'), '');
    await form.getByLabel('Currency').click();
    await expect(
      page.getByRole('listbox').getByRole('option', { name: 'KES · Kenyan Shilling' }),
    ).toHaveCount(1);
    await page.keyboard.press('Escape');
  });

  test('asks for a name and a currency before sending anything', async ({ page }) => {
    const posted = await agencyThatCreates(page);
    await page.goto('/agency');
    await page.getByRole('button', { name: 'New business' }).click();
    const form = page.getByRole('region', { name: 'New business' });

    await form.getByRole('button', { name: 'Create business' }).click();

    await expect(form.getByLabel('Name')).toHaveAccessibleDescription(/Give the business a name\./);
    await expect(form.getByLabel('Currency')).toHaveAccessibleDescription(/Choose a currency\./);
    expect(posted).toEqual([]);
  });

  test("shows the server's reason under the field it's about", async ({ page }) => {
    await agencyThatCreates(page, (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          errors: [
            {
              path: '/timezone',
              code: 'invalid',
              message: "This isn't a time zone, such as America/New_York.",
            },
          ],
        }),
      }),
    );
    await page.goto('/agency');
    await page.getByRole('button', { name: 'New business' }).click();
    const form = page.getByRole('region', { name: 'New business' });

    await form.getByLabel('Name').fill('Riverside Bakery');
    await choose(form.getByLabel('Currency'), 'KES');
    await form.getByRole('button', { name: 'Create business' }).click();

    await expect(form.getByLabel('Time zone')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByLabel('Time zone')).toHaveAccessibleDescription(
      /This isn't a time zone/,
    );
    await expect(page).toHaveURL('/agency');
  });

  test('says when the business could not be created at all, and cancels', async ({ page }) => {
    await agencyThatCreates(page, (route) => route.abort());
    await page.goto('/agency');
    const newBusiness = page.getByRole('button', { name: 'New business' });
    await newBusiness.click();
    const form = page.getByRole('region', { name: 'New business' });

    await form.getByLabel('Name').fill('Riverside Bakery');
    await choose(form.getByLabel('Currency'), 'KES');
    await form.getByRole('button', { name: 'Create business' }).click();
    await expect(form.getByRole('alert')).toHaveText(
      "The business wasn't created. Check your connection and try again.",
    );

    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toHaveCount(0);
    await expect(newBusiness).toBeFocused();
  });

  test("says the server's reason when it refuses, not a connection problem (1A review A7)", async ({
    page,
  }) => {
    await agencyThatCreates(page, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        json: {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: "Your role doesn't allow this: it needs businesses.create.",
          permission: 'businesses.create',
        },
      }),
    );
    await page.goto('/agency');
    await page.getByRole('button', { name: 'New business' }).click();
    const form = page.getByRole('region', { name: 'New business' });

    await form.getByLabel('Name').fill('Riverside Bakery');
    await choose(form.getByLabel('Currency'), 'KES');
    await form.getByRole('button', { name: 'Create business' }).click();

    await expect(form.getByRole('alert')).toHaveText(
      "Your role doesn't allow this: it needs businesses.create.",
    );
  });

  test.describe('at 360 px', () => {
    test.use({ viewport: { width: 360, height: 800 } });

    test('the form fits without scrolling sideways', async ({ page }) => {
      await agencyThatCreates(page);
      await page.goto('/agency');
      await page.getByRole('button', { name: 'New business' }).click();
      await expect(page.getByRole('region', { name: 'New business' })).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(360);
      await expectNoAccessibilityViolations(page);
    });
  });
});
