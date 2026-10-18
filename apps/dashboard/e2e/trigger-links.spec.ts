// Marketing → Trigger Links, against a stand-in for the API that answers as the server
// does.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickOf, fakeTriggerLinksApi, linkOf } from './conversation-extras-fixtures';
import { reachesRightGutter } from './lists';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const linksTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Links table', exact: true }).getByRole('table');
const linkRow = (page: Page, name: string): Locator =>
  linksTable(page).getByRole('row').filter({ hasText: name });
const notice = (page: Page): Locator => page.getByRole('main').locator('p.sr-only[role="status"]');
const range = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('status');

async function rowAction(row: Locator, name: string, action: string): Promise<void> {
  await row.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await row.page().getByRole('menuitem', { name: action, exact: true }).click();
}

const offer = (): ReturnType<typeof linkOf> =>
  linkOf(1, 'Spring Offer', 'https://harborlights.example/spring', {
    clicks: 3,
    contacts: 2,
    lastClickedAt: '2026-10-02T09:30:00.000Z',
  });

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`adds a link, copies its merge field, edits and deletes it at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeTriggerLinksApi(page, { links: [offer()] });
    await page.goto(inHarbor('/marketing/trigger-links'));
    await expect(page.getByRole('heading', { level: 1, name: 'Trigger Links' })).toBeVisible();
    await expect(page).toHaveTitle('Trigger Links · Harbor Lights Events');
    await expect(
      page
        .getByRole('navigation', { name: 'Marketing', exact: true })
        .getByRole('link', { name: 'Trigger Links', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    const first = linkRow(page, 'Spring Offer');
    await expect(first).toContainText('https://harborlights.example/spring');
    await expect(first).toContainText('{{trigger_link.spring_offer}}');
    // Clicks and different contacts, as the server counts them.
    await expect(first.getByRole('cell').nth(2)).toHaveText('3');
    await expect(first.getByRole('cell').nth(3)).toHaveText('2');

    const add = page.getByRole('button', { name: 'Add link', exact: true });
    await add.click();
    const adding = page.getByRole('dialog', { name: 'Add link', exact: true });
    const create = adding.getByRole('button', { name: 'Create link', exact: true });
    await expect(create).toBeDisabled();
    await adding.getByLabel('Name', { exact: true }).fill('Booking page');
    await expect(adding.getByText('{{trigger_link.booking_page}}')).toBeVisible();
    await adding.getByLabel('Link URL', { exact: true }).fill('https://harborlights.example/book');
    await expectNoAccessibilityViolations(page);
    await create.click();
    await expect(notice(page)).toHaveText('Link created.');
    await expect(adding).toBeHidden();
    await expect(add).toBeFocused();
    expect(api.links.at(-1)).toMatchObject({
      name: 'Booking page',
      key: 'booking_page',
      url: 'https://harborlights.example/book',
    });

    const row = linkRow(page, 'Booking page');
    await expect(row).toContainText('Never');
    await row
      .getByRole('button', { name: 'Copy {{trigger_link.booking_page}}', exact: true })
      .click();
    await expect(notice(page)).toHaveText('Copied {{trigger_link.booking_page}}');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '{{trigger_link.booking_page}}',
    );

    // An address the server refuses is said under its field; the link keeps its key.
    await rowAction(row, 'Booking page', 'Edit');
    const editing = page.getByRole('dialog', { name: 'Edit link', exact: true });
    await editing.getByLabel('Name', { exact: true }).fill('Book a visit');
    await editing.getByLabel('Link URL', { exact: true }).fill('harborlights.example/visit');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(editing).toContainText('Use a full web address starting with https://');
    await editing
      .getByLabel('Link URL', { exact: true })
      .fill('https://harborlights.example/visit');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Link saved.');
    const renamed = linkRow(page, 'Book a visit');
    await expect(renamed).toContainText('{{trigger_link.booking_page}}');
    await expect(renamed).toContainText('https://harborlights.example/visit');
    await expect(
      renamed.getByRole('button', { name: 'Actions for Book a visit', exact: true }),
    ).toBeFocused();

    // A copy is a new link with the same address and a key of its own.
    await rowAction(renamed, 'Book a visit', 'Duplicate');
    const copying = page.getByRole('dialog', { name: 'Duplicate link', exact: true });
    await expect(copying.getByLabel('Name', { exact: true })).toHaveValue('Copy of Book a visit');
    await expect(copying.getByLabel('Link URL', { exact: true })).toHaveValue(
      'https://harborlights.example/visit',
    );
    await copying.getByRole('button', { name: 'Create link', exact: true }).click();
    await expect(notice(page)).toHaveText('Link created.');
    const copy = linkRow(page, 'Copy of Book a visit');
    await expect(copy).toContainText('{{trigger_link.copy_of_book_a_visit}}');
    await rowAction(copy, 'Copy of Book a visit', 'Delete');
    await page
      .getByRole('dialog', { name: 'Delete Copy of Book a visit?', exact: true })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(notice(page)).toHaveText('Link deleted.');
    await expect(copy).toHaveCount(0);

    await rowAction(renamed, 'Book a visit', 'Delete');
    const deleting = page.getByRole('dialog', { name: 'Delete Book a visit?', exact: true });
    await expect(deleting).toContainText('Its click history is deleted with it.');
    await expect(deleting).toContainText('{{trigger_link.booking_page}}');
    await expectNoAccessibilityViolations(page);
    await deleting.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(notice(page)).toHaveText('Link deleted.');
    await expect(renamed).toHaveCount(0);
    expect(api.links).toHaveLength(1);

    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 360)
      for (const button of await first.getByRole('button').all())
        expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('trigger-links.png'), fullPage: true });
  });

  test(`analyzes who clicked a link, over a range of days, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const link = offer();
    const api = await fakeTriggerLinksApi(page, {
      links: [link, linkOf(2, 'Booking page', 'https://harborlights.example/book')],
      clicks: {
        [link.id]: [
          clickOf(31, 'Maya Chen', '2026-10-02T09:30:00.000Z'),
          clickOf(32, 'Jordan Reyes', '2026-09-20T08:00:00.000Z'),
          clickOf(31, 'Maya Chen', '2026-09-19T08:00:00.000Z', 33),
        ],
      },
    });
    await page.goto(inHarbor('/marketing/trigger-links'));
    await rowAction(linkRow(page, 'Spring Offer'), 'Spring Offer', 'Analyze');
    const analyze = page.getByRole('region', { name: 'Analyze', exact: true });
    const clicks = analyze.getByRole('region', { name: 'Clicks table', exact: true });
    await expect(clicks.getByRole('row')).toHaveCount(4);
    await expect(clicks.getByRole('link', { name: 'Maya Chen', exact: true })).toHaveCount(2);
    await expect(analyze.locator('dl')).toContainText('Clicks3');
    await expect(analyze.locator('dl')).toContainText('Contacts2');
    await expect(range(page)).toHaveText('1 - 3 of 3');

    await analyze.getByLabel('From', { exact: true }).fill('2026-10-01');
    await analyze.getByLabel('To', { exact: true }).fill('2026-10-05');
    await expect(clicks.getByRole('row')).toHaveCount(2);
    await expect(analyze.locator('dl')).toContainText('Clicks in the range1');
    await expect(analyze.locator('dl')).toContainText('Contacts in the range1');
    // Whole days where the reader is: from the first's start to the end of the last.
    const asked = api.analyzed.at(-1);
    expect(asked?.get('from')).toBe(await page.evaluate(() => new Date(2026, 9, 1).toISOString()));
    expect(asked?.get('to')).toBe(await page.evaluate(() => new Date(2026, 9, 6).toISOString()));
    await expectNoAccessibilityViolations(page);

    // A link nobody clicked says so.
    await choose(analyze.getByLabel('Link', { exact: true }), api.links[1]?.id ?? '');
    await expect(analyze.getByText('Nobody clicked this link in the range.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(linkRow(page, 'Spring Offer')).toBeVisible();
  });
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('searches and pages the list on the server', async ({ page }) => {
    const links = Array.from({ length: 23 }, (_, at) =>
      linkOf(
        at + 1,
        `Link ${String(at + 1).padStart(2, '0')}`,
        at === 4 ? 'https://needle.example/' : 'https://hay.example/',
      ),
    );
    const api = await fakeTriggerLinksApi(page, { links });
    await page.goto(inHarbor('/marketing/trigger-links'));
    await expect(range(page)).toHaveText('1 - 20 of 23');
    // Newest first.
    await expect(linksTable(page).getByRole('rowheader').first()).toHaveText('Link 23');
    const previous = page.getByRole('button', { name: 'Previous page', exact: true });
    const next = page.getByRole('button', { name: 'Next page', exact: true });
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(range(page)).toHaveText('21 - 23 of 23');
    await expect(next).toBeDisabled();
    expect(api.listed.at(-1)?.get('after')).toBe(links[3]?.id);
    await previous.click();
    await expect(range(page)).toHaveText('1 - 20 of 23');

    const search = page.getByRole('searchbox', { name: 'Search links', exact: true });
    await search.fill('needle');
    await expect(range(page)).toHaveText('1 - 1 of 1');
    await expect(linkRow(page, 'Link 05')).toBeVisible();
    expect(api.listed.at(-1)?.get('q')).toBe('needle');
    await search.fill('nothing here');
    await expect(page.getByText('No links match.', { exact: true })).toBeVisible();
  });

  test('offers the saved version when someone else changed the link first', async ({ page }) => {
    const api = await fakeTriggerLinksApi(page, { links: [offer()] });
    await page.goto(inHarbor('/marketing/trigger-links'));
    await rowAction(linkRow(page, 'Spring Offer'), 'Spring Offer', 'Edit');
    const editing = page.getByRole('dialog', { name: 'Edit link', exact: true });
    await editing.getByLabel('Name', { exact: true }).fill('Spring Sale');
    api.staleNext = true;
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(editing.getByRole('alert')).toContainText('Someone else changed this link.');
    await editing.getByRole('button', { name: 'Reload saved version', exact: true }).click();
    await expect(editing.getByLabel('Link URL', { exact: true })).toHaveValue(
      'https://harborlights.example/spring/theirs',
    );
    await editing.getByLabel('Name', { exact: true }).fill('Spring Sale');
    await editing.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(notice(page)).toHaveText('Link saved.');
    expect(api.links[0]?.name).toBe('Spring Sale');
  });

  test('lets someone who may not manage templates read and analyze only', async ({ page }) => {
    const api = await fakeTriggerLinksApi(page, { links: [offer()] });
    api.canManage = false;
    await page.goto(inHarbor('/marketing/trigger-links'));
    await expect(linkRow(page, 'Spring Offer')).toBeVisible();
    await expect(
      page.getByText(
        'You can read trigger links. Changing them needs permission to manage templates.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add link', exact: true })).toHaveCount(0);
    await linkRow(page, 'Spring Offer')
      .getByRole('button', { name: 'Actions for Spring Offer', exact: true })
      .click();
    await expect(page.getByRole('menuitem')).toHaveText(['Analyze']);
    await expectNoAccessibilityViolations(page);
  });

  test('says so when there are none yet', async ({ page }) => {
    await fakeTriggerLinksApi(page);
    await page.goto(inHarbor('/marketing/trigger-links'));
    await expect(page.getByText('No links available.', { exact: true })).toBeVisible();
    await expect(range(page)).toHaveText('0 - 0 of 0');
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect(page.getByText('Choose a link to see who clicked it.')).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeTriggerLinksApi(page, { links: [offer()] });
    await page.goto(inHarbor('/marketing/trigger-links'));
    await expect(linkRow(page, 'Spring Offer')).toBeVisible();
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'Links', exact: true })),
    ).toBe(true);
  });
});
