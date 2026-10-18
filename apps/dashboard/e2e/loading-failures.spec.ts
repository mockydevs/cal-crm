// What the dashboard shows when its own code doesn't arrive. The build is many files: the
// ones every page needs, fetched with the page, and each page's own, fetched when the page
// is first opened. Either can fail to load on a dropped connection. The tests fail a real
// file of the build, named by the build's own manifest, and ask for it again as a reload
// would.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  automationsApi,
  expectNoSidewaysScroll,
  expectNoViolations,
  world,
} from './automation-api';
import { servedDirectory } from './served-build';
import { inHarbor, signedIn } from './session';

interface Chunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
}
const manifest = JSON.parse(
  readFileSync(join(servedDirectory, '.vite', 'manifest.json'), 'utf8'),
) as Record<string, Chunk>;

function fileOf(key: string | undefined): string {
  const file = key === undefined ? undefined : manifest[key]?.file;
  if (file === undefined) throw new Error(`The build has no ${key ?? 'such file'}.`);
  return file;
}
const entry = Object.values(manifest).find((chunk) => chunk.isEntry === true);
/** A file every page needs: the first one the dashboard's entry imports. */
const sharedFile = fileOf(entry?.imports?.[0]);
/** The Automations page's own code. */
const pageFile = fileOf('src/routes/_app.b.$slug.automations.tsx?tsr-split=component');

/** Fails every request for the file, as a dropped connection does, and counts them. */
async function unreachable(page: Page, file: string, times = Infinity): Promise<() => number> {
  let asked = 0;
  await page.route(`**/${file}`, async (route) => {
    asked += 1;
    if (asked > times) await route.continue();
    else await route.abort('connectionfailed');
  });
  return () => asked;
}

async function openAutomations(page: Page): Promise<void> {
  await signedIn(page);
  await automationsApi(page, world());
  await page.goto(inHarbor('/automations'));
}
const automations = (page: Page) =>
  page.getByRole('heading', { level: 1, name: 'Workflows list', exact: true });

for (const width of [360, 1440])
  test.describe(`at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('says so, and offers a reload, when the code every page needs does not arrive', async ({
      page,
    }) => {
      const asked = await unreachable(page, sharedFile);
      await openAutomations(page);
      const notice = page.getByRole('alert');
      await expect(
        page.getByRole('heading', { level: 1, name: "The dashboard couldn't load", exact: true }),
      ).toBeVisible();
      await expect(notice).toHaveText('Check your connection, then reload the page.Reload page');
      const reload = notice.getByRole('button', { name: 'Reload page', exact: true });
      await expect(reload).toBeFocused();
      expect(asked()).toBeGreaterThan(0);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);

      // The connection is back: the reload it offers brings the dashboard.
      await page.unroute(`**/${sharedFile}`);
      await reload.press('Enter');
      await expect(automations(page)).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('says so in the page, and offers a reload, when one page’s code does not arrive', async ({
      page,
    }) => {
      const asked = await unreachable(page, pageFile);
      await openAutomations(page);
      const notice = page.getByRole('alert');
      await expect(
        page.getByRole('heading', { level: 1, name: "This page couldn't load", exact: true }),
      ).toBeVisible();
      await expect(notice).toHaveText('Reload the page to try again.Reload page');
      // The rest of the dashboard is still there to go elsewhere with.
      await expect(page.getByRole('banner')).toContainText('Harbor Lights Events');
      const reload = notice.getByRole('button', { name: 'Reload page', exact: true });
      await expect(reload).toBeFocused();
      // The router had already asked once more by itself before saying so.
      expect(asked()).toBeGreaterThanOrEqual(2);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);

      await page.unroute(`**/${pageFile}`);
      await reload.press('Enter');
      await expect(automations(page)).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    });
  });

test('fetches a page’s code again by itself when it fails once', async ({ page }) => {
  const asked = await unreachable(page, pageFile, 1);
  await openAutomations(page);
  await expect(automations(page)).toBeVisible();
  expect(asked()).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
