import { choose } from './select';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Company, Contact, Deal } from '@repo/contracts';
import { inHarbor, signedIn } from './session';

// The trash, against the built dashboard with the API stood in for. The real server is
// exercised by @repo/e2e.

interface Item {
  id: string;
  kind: 'contact' | 'company' | 'deal';
  name: string | null;
  trashedAt: string;
  purgeAt: string;
}

// Ids the server made: the contract checks each wraps a UUIDv7.
const maya: Item = {
  id: 'con_01m4bd188ff82s0add91b7pz63',
  kind: 'contact',
  name: 'Maya Thompson',
  trashedAt: '2026-10-08T12:00:00.000Z',
  purgeAt: '2026-11-07T12:00:00.000Z',
};
const lee: Item = {
  id: 'com_01m4bd9fteedat3be9bqgx2047',
  kind: 'company',
  name: 'Lee Family',
  trashedAt: '2026-10-07T12:00:00.000Z',
  purgeAt: '2026-11-06T12:00:00.000Z',
};
const wedding: Item = {
  id: 'deal_01m4bdmgqwfgatd5ch0pqddfxm',
  kind: 'deal',
  name: 'Lee wedding',
  trashedAt: '2026-10-06T12:00:00.000Z',
  purgeAt: '2026-11-05T12:00:00.000Z',
};

const at = '2026-10-08T12:00:00.000Z';

/** The record a restore answers with, as its contract has it. */
function restored(item: Item): Contact | Company | Deal {
  const name = item.name ?? 'Unnamed';
  const kept = { id: item.id, trashedAt: null, createdAt: at, updatedAt: at, canManage: true };
  if (item.kind === 'contact')
    return {
      ...kept,
      firstName: name,
      lastName: null,
      name,
      emails: [],
      phones: [],
      timeZone: null,
      doNotContact: false,
      preferencesRevision: 'a'.repeat(64),
    };
  if (item.kind === 'company') return { ...kept, name, domain: null, phone: null };
  return {
    ...kept,
    name,
    pipelineId: 'pipe_01m4bd188ff82s0add91b7pz63',
    stageId: 'stage_01m4bd188ff82s0add91b7pz63',
    pipelineName: 'Weddings',
    stageName: 'New lead',
    amount: null,
    currency: 'KES',
    expectedCloseDate: null,
    status: 'open',
    outcomeReason: null,
    closedAt: null,
    stageEnteredAt: at,
    revision: 'a'.repeat(64),
  };
}

/** An API that keeps the trash in memory and records each request. */
async function fakeApi(
  page: Page,
  items: Item[],
  canPurge = true,
): Promise<{ sent: { method: string; path: string; query: URLSearchParams }[] }> {
  const sent: { method: string; path: string; query: URLSearchParams }[] = [];
  const remove = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    const [removed] = items.splice(index, 1);
    return removed;
  };
  await page.route(
    /\/api\/v1\/(trash|contacts|companies|deals)(\/[^?]*)?(\?.*)?$/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace('/api/v1', '');
      sent.push({ method: request.method(), path, query: url.searchParams });
      const [, area, id] = path.split('/');
      if (area === 'trash' && request.method() === 'GET') {
        const kind = url.searchParams.get('kind');
        return route.fulfill({
          json: {
            items: items.filter((item) => kind === null || item.kind === kind),
            next: null,
            retentionDays: 30,
            canPurge,
          },
        });
      }
      if (area === 'trash' && request.method() === 'DELETE' && id !== undefined) {
        remove(id);
        return route.fulfill({ status: 204 });
      }
      if (path.endsWith('/restore') && id !== undefined) {
        const item = remove(id);
        if (item === undefined) return route.fulfill({ status: 404 });
        return route.fulfill({ json: restored(item) });
      }
      return route.fallback();
    },
  );
  return { sent };
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const rows = (page: Page) => page.getByRole('list', { name: 'In the trash' }).getByRole('listitem');

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lists every kind with when each is deleted for good, and is accessible', async ({
    page,
  }) => {
    await fakeApi(
      page,
      [maya, lee, wedding].map((item) => ({ ...item })),
    );
    await page.goto(inHarbor('/trash'));

    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByText('stay here for 30 days')).toBeVisible();
    await expect(rows(page).first()).toContainText('Contact');
    await expect(rows(page).first()).toContainText('Deleted for good on');
    await expectNoAccessibilityViolations(page);
  });

  test('shows one kind', async ({ page }) => {
    const { sent } = await fakeApi(
      page,
      [maya, lee, wedding].map((item) => ({ ...item })),
    );
    await page.goto(inHarbor('/trash'));
    await expect(rows(page)).toHaveCount(3);

    await choose(page.getByLabel('Show'), 'deal');

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText('Lee wedding');
    expect(sent.at(-1)?.query.get('kind')).toBe('deal');
  });

  test('restores each kind through its own restore', async ({ page }) => {
    const { sent } = await fakeApi(
      page,
      [maya, lee, wedding].map((item) => ({ ...item })),
    );
    await page.goto(inHarbor('/trash'));

    for (const item of [maya, lee, wedding]) {
      await page.getByRole('button', { name: `Restore ${String(item.name)}` }).click();
      await expect(page.getByRole('status').last()).toHaveText(`${String(item.name)} restored.`);
    }

    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible();
    expect(
      sent.filter((request) => request.method === 'POST').map((request) => request.path),
    ).toEqual([
      `/contacts/${maya.id}/restore`,
      `/companies/${lee.id}/restore`,
      `/deals/${wedding.id}/restore`,
    ]);
  });

  test('asks before deleting forever, with the keyboard on Keep', async ({ page }) => {
    const { sent } = await fakeApi(page, [{ ...maya }]);
    await page.goto(inHarbor('/trash'));

    await page.getByRole('button', { name: 'Delete Maya Thompson forever' }).click();
    await expect(
      page.getByText("Delete Maya Thompson forever? This can't be undone."),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Restore Maya Thompson' })).toBeVisible();
    expect(sent.some((request) => request.method === 'DELETE')).toBe(false);

    await page.getByRole('button', { name: 'Delete Maya Thompson forever' }).click();
    await page
      .getByRole('group', { name: 'Delete Maya Thompson forever?' })
      .getByRole('button', { name: 'Delete forever' })
      .click();

    await expect(page.getByRole('status').last()).toHaveText('Maya Thompson deleted forever.');
    expect(sent.find((request) => request.method === 'DELETE')?.path).toBe(`/trash/${maya.id}`);
  });

  test('offers deleting forever only to people who may', async ({ page }) => {
    await fakeApi(page, [{ ...maya }], false);
    await page.goto(inHarbor('/trash'));

    await expect(page.getByRole('button', { name: 'Restore Maya Thompson' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete Maya Thompson forever' })).toBeHidden();
  });

  test('says when the trash is empty', async ({ page }) => {
    await fakeApi(page, []);
    await page.goto(inHarbor('/trash'));

    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible();
  });
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('fits the screen', async ({ page }) => {
    await fakeApi(
      page,
      [maya, lee, wedding].map((item) => ({ ...item })),
    );
    await page.goto(inHarbor('/trash'));

    await expect(rows(page)).toHaveCount(3);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoAccessibilityViolations(page);
  });
});
