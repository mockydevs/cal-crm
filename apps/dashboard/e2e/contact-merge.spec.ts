// Merge Contacts against the built dashboard, with the API stood in for: two contacts ticked
// in the contact list are merged field by field into the one kept, whose page then opens; a
// merged contact waits in the trash without Restore; and the old contact's address opens the
// contact it went into. Manage Duplicates opens the same dialog. The real server is exercised
// by @repo/e2e.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fakeDuplicatesApi, gmailTwins } from './contact-duplicates-fixtures';
import { fakeMergeApi, jane, janeId, janetId, mergeContacts } from './contact-merge-fixtures';
import { emptyContactPanels } from './contact-panels';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const noPageScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Who may merge: Manage Duplicates' permission, contacts.merge. */
async function mayMerge(page: Page, merge = true): Promise<void> {
  await page.route('**/api/v1/me/permissions', (route) =>
    route.fulfill({
      json: {
        business: null,
        permissions: ['contacts.manage', ...(merge ? ['contacts.merge'] : [])],
      },
    }),
  );
}

/** The contact list with the two Jane Does in it, and its count. */
async function contactList(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/contacts(?:\/count)?(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/count')) return route.fulfill({ json: { count: 2, exact: true } });
    return route.fulfill({
      json: {
        items: mergeContacts().map((each) => ({
          id: each.id,
          name: each.name,
          email: each.emails[0] ?? null,
          phone: each.phones[0] ?? null,
          createdAt: each.createdAt,
        })),
        next: null,
        canManage: true,
      },
    });
  });
}

const rowOf = (dialog: Locator, name: string): Locator =>
  dialog.getByRole('row').filter({ has: dialog.page().getByRole('rowheader', { name }) });

test.beforeEach(async ({ page }) => {
  await signedIn(page);
  await emptyContactPanels(page);
});

for (const width of [1440, 360]) {
  test(`merges two contacts ticked in the list into the one kept at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mayMerge(page);
    await contactList(page);
    const api = await fakeMergeApi(page);
    await page.goto(inHarbor('/contacts'));

    await page.getByRole('checkbox', { name: 'Select Jane Doe' }).check();
    const bar = page.getByRole('group', { name: 'Bulk actions' });
    await expect(bar.getByRole('button', { name: 'Merge' })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Select Janet Doe' }).check();
    await bar.getByRole('button', { name: 'Merge' }).click();

    const dialog = page.getByRole('dialog', { name: 'Merge Contacts' });
    await expect(dialog.getByRole('radio', { name: /^Jane Doe/u })).toBeChecked();
    const firstName = rowOf(dialog, 'First name');
    await expect(firstName.getByRole('radio', { name: 'Jane', exact: true })).toBeChecked();
    await expect(rowOf(dialog, 'Last name').getByRole('radio')).toHaveCount(0);
    await expect(dialog.getByText('Notes: 2')).toBeVisible();
    await expect(dialog.getByText('Conversations: 1')).toBeVisible();
    const merge = dialog.getByRole('button', { name: 'Merge', exact: true });
    await expect(merge).toBeDisabled();
    await expectNoAccessibilityViolations(page);
    expect(await noPageScroll(page)).toBe(true);

    await firstName.getByRole('radio', { name: 'Janet' }).check();
    await dialog.getByRole('checkbox', { name: 'I understand this cannot be undone' }).check();
    await merge.click();

    await expect(page).toHaveURL(new RegExp(`${inHarbor(`/contacts/${janeId}`)}$`, 'u'));
    await expect(page.getByRole('status').filter({ hasText: 'merged' })).toHaveText(
      '1 contact was merged into this one.',
    );
    expect(api.previews).toEqual([[janeId, janetId]]);
    expect(api.merges).toEqual([
      {
        id: janeId,
        body: {
          mergeIds: [janetId],
          fields: { firstName: janetId },
          revisions: { [janeId]: '1'.repeat(64), [janetId]: '2'.repeat(64) },
        },
      },
    ]);
  });
}

test('keeps the field table whole in a dialog that has to scroll', async ({ page }) => {
  // A short window: the dialog's body scrolls, and the table of fields must not shrink away.
  await page.setViewportSize({ width: 1280, height: 520 });
  await mayMerge(page);
  await contactList(page);
  await fakeMergeApi(page);
  await page.goto(inHarbor('/contacts'));
  await page.getByRole('checkbox', { name: 'Select Jane Doe' }).check();
  await page.getByRole('checkbox', { name: 'Select Janet Doe' }).check();
  await page
    .getByRole('group', { name: 'Bulk actions' })
    .getByRole('button', { name: 'Merge' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Merge Contacts' });
  const firstName = rowOf(dialog, 'First name');
  await expect(firstName).toBeVisible();
  await firstName.getByRole('radio', { name: 'Janet' }).check();
  await expect(firstName.getByRole('radio', { name: 'Janet' })).toBeChecked();
});

test('refuses a merge that would move more than one merge may', async ({ page }) => {
  await mayMerge(page);
  await contactList(page);
  const api = await fakeMergeApi(page);
  api.preview = { rows: 60_000 };
  await page.goto(inHarbor('/contacts'));
  await page.getByRole('checkbox', { name: 'Select Jane Doe' }).check();
  await page.getByRole('checkbox', { name: 'Select Janet Doe' }).check();
  await page
    .getByRole('group', { name: 'Bulk actions' })
    .getByRole('button', { name: 'Merge' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Merge Contacts' });
  await expect(dialog.getByRole('alert')).toHaveText(
    'These contacts have 60,000 rows of history between them, more than the 50,000 one merge moves. Merge fewer contacts at a time.',
  );
  await dialog.getByRole('checkbox', { name: 'I understand this cannot be undone' }).check();
  await expect(dialog.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
  expect(api.merges).toEqual([]);
});

test('offers no Merge to a role that may not merge contacts', async ({ page }) => {
  await mayMerge(page, false);
  await contactList(page);
  await page.goto(inHarbor('/contacts'));
  await page.getByRole('checkbox', { name: 'Select Jane Doe' }).check();
  const bar = page.getByRole('group', { name: 'Bulk actions' });
  await expect(bar).toContainText('1 selected');
  await expect(bar.getByRole('button', { name: 'Merge' })).toHaveCount(0);
});

test("merges a duplicate group from Manage Duplicates' review", async ({ page }) => {
  await mayMerge(page);
  await fakeDuplicatesApi(page, { groups: { email: [gmailTwins()] } });
  await fakeMergeApi(page);
  await page.goto(inHarbor('/contacts/duplicates'));
  await page.getByRole('button', { name: 'Review' }).click();
  const review = page.getByRole('dialog', { name: 'Review duplicates' });
  await review.getByRole('button', { name: 'Merge' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge Contacts' });
  const columns = dialog.getByRole('columnheader');
  await expect(columns).toHaveCount(2);
  await expect(columns.first()).toContainText('Jane Doe');
  await expect(columns.first()).toContainText('Master');
  await expect(columns.last()).toContainText('Janet Doe');
  await expectNoAccessibilityViolations(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(review.getByRole('button', { name: 'Merge' })).toBeFocused();
});

test('keeps a merged contact in the trash without Restore, linked to the contact kept', async ({
  page,
}) => {
  await page.route(/\/api\/v1\/trash(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: janetId,
            kind: 'contact',
            name: 'Janet Doe',
            trashedAt: '2026-10-08T12:00:00.000Z',
            purgeAt: '2026-11-07T12:00:00.000Z',
            mergedInto: janeId,
          },
        ],
        next: null,
        retentionDays: 30,
        canPurge: true,
      },
    }),
  );
  await page.goto(inHarbor('/trash'));
  const item = page.getByRole('list', { name: 'In the trash' }).getByRole('listitem');
  await expect(item).toContainText('Merged into the contact kept');
  await expect(item.getByRole('button', { name: 'Restore Janet Doe' })).toHaveCount(0);
  await expect(item.getByRole('button', { name: 'Delete Janet Doe forever' })).toBeVisible();
  await expect(item.getByRole('link', { name: 'the contact kept' })).toHaveAttribute(
    'href',
    inHarbor(`/contacts/${janeId}`),
  );
  await expectNoAccessibilityViolations(page);
});

test('opens the contact kept from the address of a contact merged into it', async ({ page }) => {
  const api = await fakeMergeApi(page);
  api.mergedInto.set(janetId, janeId);
  await page.goto(inHarbor(`/contacts/${janetId}`));
  await expect(page).toHaveURL(new RegExp(`${inHarbor(`/contacts/${janeId}`)}$`, 'u'));
  await expect(page.getByRole('status').filter({ hasText: 'merged' })).toHaveText(
    'The contact you opened was merged into this one.',
  );
  await expect(page).toHaveTitle(`${jane().name ?? ''} · Harbor Lights Events`);
});
