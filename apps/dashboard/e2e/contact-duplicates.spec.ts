// Duplicate contacts against the built dashboard, with the API stood in for: Contacts → ⋯
// → Manage Duplicates (find by email, phone or name; review; reject), a contact's "Possible
// duplicates", and Business Profile → Contact Deduplication Preferences. There is no Merge
// button anywhere yet. The real server is exercised by @repo/e2e.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  companyNames,
  fakeDuplicatesApi,
  gmailTwins,
  phoneTails,
} from './contact-duplicates-fixtures';
import { reachesRightGutter } from './lists';
import { choose, expectChoice } from './select';
import { harbor, inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function mayMerge(page: Page, merge: boolean): Promise<void> {
  await page.route('**/api/v1/me/permissions', (route) =>
    route.fulfill({
      json: {
        business: null,
        permissions: ['contacts.manage', ...(merge ? ['contacts.merge'] : [])],
      },
    }),
  );
}

const noPageScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`finds duplicates by email, phone and name, reviews and rejects a group at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fakeDuplicatesApi(page, {
      groups: { email: [gmailTwins()], phone: [phoneTails()], name: [companyNames()] },
    });
    await page.goto(inHarbor('/contacts/duplicates'));
    await expect(page.getByRole('heading', { level: 1, name: 'Manage Duplicates' })).toBeVisible();
    await expect(page).toHaveTitle('Manage Duplicates · Harbor Lights Events');

    // Email is GoHighLevel's default "Find by".
    const findBy = page.getByRole('group', { name: 'Find by' });
    await expect(findBy.getByRole('button', { name: 'Email', pressed: true })).toBeVisible();
    const groups = page.getByRole('region', { name: 'Duplicates by email' });
    await expect(groups.getByText('janedoe@gmail.com')).toBeVisible();
    await expect(groups.getByText('2 contacts: Jane Doe, Jane Doe')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    expect(await noPageScroll(page)).toBe(true);

    await findBy.getByRole('button', { name: 'Phone' }).click();
    const byPhone = page.getByRole('region', { name: 'Duplicates by phone' });
    await expect(byPhone.getByText('…2125550199')).toBeVisible();
    await expect(byPhone.getByText('Weaker match')).toBeVisible();
    await findBy.getByRole('button', { name: 'Name' }).click();
    const byName = page.getByRole('region', { name: 'Duplicates by name' });
    await expect(byName.getByText('Same company')).toBeVisible();
    expect(api.asked).toEqual(['email', 'phone', 'name']);

    await findBy.getByRole('button', { name: 'Email' }).click();
    const review = groups.getByRole('button', { name: 'Review' });
    await review.click();
    const panel = page.getByRole('dialog', { name: 'Review duplicates' });
    await expect(panel.getByRole('table')).toBeVisible();
    await expect(panel.getByRole('columnheader')).toHaveText(['Jane Doe', 'Jane Doe']);
    await expect(panel.getByRole('cell', { name: 'janedoe+news@gmail.com' })).toBeVisible();
    await expect(page.getByRole('button', { name: /merge/iu })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(review).toBeFocused();

    await groups.getByRole('button', { name: 'Reject' }).click();
    const confirm = page.getByRole('dialog', { name: 'Reject these duplicates?' });
    await expect(confirm).toContainText("This can't be undone.");
    await confirm.getByRole('button', { name: 'Reject' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole('status')).toHaveText(
      "janedoe@gmail.com was rejected. Those contacts won't be shown as duplicates again.",
    );
    await expect(groups.getByText('No possible duplicates found.')).toBeVisible();
    await expect(groups.getByRole('heading', { name: 'Duplicates by email' })).toBeFocused();
    expect(api.rejected).toEqual([
      {
        by: 'email',
        valueKey: 'janedoe@gmail.com',
        contactIds: gmailTwins().contacts.map((each) => each.id),
      },
    ]);
  });

  test(`sets the contact deduplication preferences in the business profile at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fakeDuplicatesApi(page);
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
    await page.goto(inHarbor('/settings/business'));
    const section = page.getByRole('region', { name: 'Contact Deduplication Preferences' });
    await expectChoice(section.getByRole('combobox', { name: 'Primary field' }), 'email');
    await expectChoice(section.getByRole('combobox', { name: 'Secondary field' }), 'none');
    await expect(section.getByRole('button', { name: 'Save preferences' })).toBeDisabled();

    await choose(section.getByRole('combobox', { name: 'Primary field' }), 'phone');
    await choose(section.getByRole('combobox', { name: 'Secondary field' }), 'email');
    await section.getByRole('button', { name: 'Save preferences' }).click();
    await expect(section.getByRole('status')).toHaveText(
      'Contact deduplication preferences saved.',
    );
    expect(api.saved).toEqual([
      { primary: 'phone', secondary: 'email', revision: '1'.padStart(64, '0') },
    ]);
    await expectNoAccessibilityViolations(page);
    expect(await reachesRightGutter(page, section)).toBe(true);
  });
}

test('offers Manage Duplicates in the contacts menu only to whoever may manage duplicates', async ({
  page,
}) => {
  await mayMerge(page, true);
  await page.route(/\/api\/v1\/contacts(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], next: null, canManage: true } }),
  );
  await page.goto(inHarbor('/contacts'));
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Manage Duplicates' }).click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/contacts/duplicates')}$`, 'u'));

  await page.unroute('**/api/v1/me/permissions');
  await mayMerge(page, false);
  await page.goto(inHarbor('/contacts'));
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: 'Trash' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Manage Duplicates' })).toHaveCount(0);
});

test("shows a contact's possible duplicates and opens the same review", async ({ page }) => {
  await mayMerge(page, false);
  const twins = gmailTwins();
  const id = twins.contacts[0]?.id ?? '';
  await fakeDuplicatesApi(page, { groups: { email: [twins] } });
  await page.route(`**/api/v1/contacts/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        firstName: 'Jane',
        lastName: 'Doe',
        name: 'Jane Doe',
        emails: ['jane.doe@gmail.com'],
        phones: [],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: '2026-10-08T12:00:00.000Z',
        updatedAt: '2026-10-08T12:00:00.000Z',
        trashedAt: null,
        canManage: true,
      },
    }),
  );
  await page.goto(inHarbor(`/contacts/${id}`));
  const chip = page.getByRole('button', { name: 'Possible duplicates (1)' });
  await chip.click();
  const panel = page.getByRole('dialog', { name: 'Review duplicates' });
  await expect(panel.getByRole('heading', { name: 'janedoe@gmail.com' })).toBeVisible();
  // Reject is Manage Duplicates' (contacts.merge), which this role does not have.
  await expect(panel.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await expectNoAccessibilityViolations(page);
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
});

test('says who may manage duplicates to a role that may not', async ({ page }) => {
  const api = await fakeDuplicatesApi(page);
  api.refused = true;
  await page.goto(inHarbor('/contacts/duplicates'));
  await expect(page.getByRole('alert')).toHaveText('Only admins can manage duplicates.');
});
