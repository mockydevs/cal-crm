// Opportunities → Bulk Actions: the bulk actions that were run on opportunities, against
// the built dashboard with the API stood in for.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { DealBulkAction } from '@repo/contracts';
import { reachesRightGutter } from './lists';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';

const entry = (number: number, changes: Partial<DealBulkAction> = {}): DealBulkAction => ({
  id: `bulk_01m4bd188ff82s0add91b7pz6${String(number)}`,
  action: 'trash',
  requested: 5,
  done: 3,
  unchanged: 1,
  skipped: 1,
  actor: { kind: 'user', name: 'Lee Park', you: false },
  createdAt: '2026-10-08T12:00:00.000Z',
  completedAt: '2026-10-08T12:00:01.000Z',
  ...changes,
});

/** Stands in for GET /deals/bulk-actions: newest first, a page at a time, by action. */
async function history(
  page: Page,
  entries: DealBulkAction[],
  pageSize = 20,
): Promise<{ readonly asked: string[] }> {
  const asked: string[] = [];
  await page.route(/\/api\/v1\/deals\/bulk-actions(?:\?.*)?$/, async (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    const query = new URL(route.request().url()).searchParams;
    asked.push(query.toString());
    const kept = entries.filter(
      (each) => query.get('action') === null || each.action === query.get('action'),
    );
    const start = kept.findIndex((each) => each.id === query.get('after')) + 1;
    const items = kept.slice(start, start + pageSize);
    await route.fulfill({
      json: {
        items,
        next: start + pageSize < kept.length ? (items.at(-1)?.id ?? null) : null,
      },
    });
  });
  return { asked };
}

const table = (page: Page): Locator =>
  page.getByRole('region', { name: 'Bulk actions table', exact: true });

async function expectNoViolations(page: Page): Promise<void> {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze()
    ).violations,
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360])
  test(`lists the bulk actions run, by action and a page at a time, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await history(
      page,
      [
        entry(1),
        entry(2, {
          action: 'assign_owner',
          requested: 2,
          done: 2,
          unchanged: 0,
          skipped: 0,
          actor: { kind: 'user', name: 'Dana Brooks', you: true },
        }),
        entry(3, { action: 'move' }),
      ],
      2,
    );
    await page.goto(inHarbor('/deals/bulk-actions'));
    await expect(page.getByRole('heading', { level: 1, name: 'Bulk Actions' })).toBeVisible();
    await expect(page).toHaveTitle('Bulk Actions · Harbor Lights Events');
    if (width >= 1024) {
      const tabs = page
        .getByRole('region', { name: 'Top bar', exact: true })
        .getByRole('navigation', { name: 'Opportunities', exact: true });
      await expect(tabs.getByRole('link')).toHaveText([
        'Opportunities',
        'Pipelines',
        'Bulk Actions',
      ]);
      await expect(tabs.getByRole('link', { name: 'Bulk Actions' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(
        await reachesRightGutter(
          page,
          page.getByRole('region', { name: 'Bulk actions', exact: true }),
        ),
      ).toBe(true);
    }
    // A phone has room for what was done, when, and what became of it.
    await expect(table(page).getByRole('columnheader')).toHaveText(
      width >= 1024
        ? ['Action', 'User', 'Created', 'Completed', 'Statistics']
        : ['Action', 'Completed', 'Statistics'],
    );
    await expect(table(page).getByRole('rowheader')).toHaveText([
      'Delete opportunities',
      'Change owner',
    ]);
    const mine = table(page).getByRole('row').filter({ hasText: 'Change owner' });
    await expect(mine.getByRole('cell').last()).toHaveText(
      '2 selected · 2 changed · 0 unchanged · 0 skipped',
    );
    if (width >= 1024) {
      await expect(mine.getByRole('cell').first()).toHaveText('You');
      await expect(
        table(page).getByRole('row').filter({ hasText: 'Delete opportunities' }),
      ).toContainText('Lee Park');
    }
    await expectNoViolations(page);
    // The page itself never scrolls sideways: the table does, inside its card.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    const more = page.getByRole('button', { name: 'Load more bulk actions', exact: true });
    expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(width < 1024 ? 44 : 36);
    await more.click();
    await expect(table(page).getByRole('rowheader')).toHaveText([
      'Delete opportunities',
      'Change owner',
      'Change pipeline and stage',
    ]);
    await expect(more).toHaveCount(0);
    expect(api.asked.at(-1)).toBe(`after=${entry(2).id}`);

    const filter = page.getByRole('combobox', { name: 'Action', exact: true });
    expect((await filter.boundingBox())?.height).toBeGreaterThanOrEqual(width < 1024 ? 44 : 36);
    await choose(filter, 'move');
    await expect(table(page).getByRole('rowheader')).toHaveText(['Change pipeline and stage']);
    expect(api.asked.at(-1)).toBe('action=move');
  });

test('says there are none, and says so when the list did not load', async ({ page }) => {
  await history(page, []);
  await page.goto(inHarbor('/deals/bulk-actions'));
  await expect(page.getByText('No bulk actions found.', { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expectNoViolations(page);

  let failing = true;
  await page.route(/\/api\/v1\/deals\/bulk-actions(?:\?.*)?$/, (route) =>
    failing
      ? route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Forbidden', status: 403 },
        })
      : route.fallback(),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('load the bulk actions.');
  await expect(page.getByText('No bulk actions found.', { exact: true })).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No bulk actions found.', { exact: true })).toBeVisible();
});
