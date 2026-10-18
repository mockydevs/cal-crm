// Run history: each automation's runs and each contact's runs, and for one run every step
// it took: what the step was given, the branch it took and why.
import { expect, test, type Page } from '@playwright/test';
import {
  builderAt,
  expectNoSidewaysScroll,
  expectNoViolations,
  openBuilder,
  runsApi,
  step,
  tab,
  world,
  type World,
} from './automation-api';
import {
  automationId,
  contactIds,
  mayaRun,
  priyaRun,
  runIds,
  runList,
} from './automation-fixtures';
import { emptyContactPanels } from './contact-panels';
import { inHarbor } from './session';

const withRuns = (over: Partial<World> = {}): World =>
  world({
    runs: runList.items,
    runDetails: { [runIds.maya]: mayaRun, [runIds.priya]: priyaRun },
    ...over,
  });
const runs = (page: Page) => page.getByRole('table', { name: 'Enrollment history', exact: true });
const enrolled = (page: Page) => runs(page).locator('tbody tr');
const stepsTaken = (page: Page) =>
  page.getByRole('list', { name: 'Steps taken', exact: true }).locator(':scope > li');

test.describe("an automation's runs", () => {
  test('are fetched when first opened, and list everyone it ran for with where each stands', async ({
    page,
  }) => {
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
    });
    const state = withRuns();
    await openBuilder(page, state);
    await expect(step(page, 'send_guide')).toBeVisible();
    expect(scripts.filter((path) => path.includes('automation-runs'))).toEqual([]);
    expect(state.runQueries).toEqual([]);

    await tab(page, 'Enrollment history').click();
    await expect(page).toHaveURL(builderAt('runs'));
    await expect(enrolled(page)).toHaveCount(3);
    expect(scripts.filter((path) => path.includes('automation-runs'))).toHaveLength(1);
    const rows = enrolled(page);
    await expect(rows.nth(0)).toContainText('Priya Nair');
    await expect(rows.nth(0)).toContainText(
      "Failed: the contact hasn't agreed to marketing messages on this channel.",
    );
    await expect(rows.nth(1)).toContainText('If / else');
    await expect(rows.nth(1)).toContainText('Waiting');
    await expect(rows.nth(1)).toContainText(/Oct 9, 2026/);
    await expect(rows.nth(2)).toContainText('Finished');
    await expect(rows.nth(2)).toContainText('Someone submits “Request a quote”');
    await expect(rows.nth(2)).toContainText(/Version 2/);
    // A contact's name leads to the contact.
    await expect(
      runs(page).getByRole('link', { name: 'Maya Thompson', exact: true }),
    ).toHaveAttribute('href', inHarbor(`/contacts/${contactIds.maya}`));
    // The checks of the draft are not about the runs.
    await expect(page.getByRole('heading', { name: 'Checks', exact: true })).toBeHidden();
  });

  test('filters by status, and refreshes on request', async ({ page }) => {
    const state = withRuns();
    await openBuilder(page, state, 'runs');
    await expect(enrolled(page)).toHaveCount(3);
    await page.getByRole('combobox', { name: 'Status', exact: true }).click();
    await page.getByRole('option', { name: 'Failed', exact: true }).click();
    await expect(enrolled(page)).toHaveCount(1);
    await expect(runs(page)).toContainText('Priya Nair');
    expect(state.runQueries.at(-1)).toBe('status=failed');

    await page.getByRole('combobox', { name: 'Status', exact: true }).click();
    await page.getByRole('option', { name: 'Cancelled', exact: true }).click();
    await expect(page.getByText('No enrollment matches that.', { exact: true })).toBeVisible();

    await page.getByRole('combobox', { name: 'Status', exact: true }).click();
    await page.getByRole('option', { name: 'All statuses', exact: true }).click();
    await expect(enrolled(page)).toHaveCount(3);
    // Someone new went through it meanwhile: a refresh shows them.
    state.runs = [
      { ...runList.items[2], id: 'arun_01k8e2wzr0e008000000000029', status: 'running' },
      ...runList.items,
    ];
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(enrolled(page)).toHaveCount(4);
  });

  test('shows one run: each step, what it was given, the branch it took and why', async ({
    page,
  }) => {
    await openBuilder(page, withRuns(), 'runs');
    await page
      .getByRole('link', { name: /^Open the run for Maya Thompson, started Oct 6, 2026/ })
      .click();
    await expect(page).toHaveURL(builderAt('runs', runIds.maya));
    await expect(
      page.getByRole('heading', { level: 2, name: /^Run for Maya Thompson/ }),
    ).toBeVisible();
    await expect(page.getByText('Went through to the end.', { exact: true })).toBeVisible();

    await expect(stepsTaken(page)).toHaveCount(4);
    // Each step is named as the version that ran names it.
    await expect(stepsTaken(page).nth(0)).toContainText('Send the email “Pricing guide”');
    await expect(stepsTaken(page).nth(0)).toContainText('The email was queued to send.');
    await expect(stepsTaken(page).nth(1)).toContainText('Wait 2 days');
    await expect(stepsTaken(page).nth(1)).toContainText(/Its wait ends Oct 8, 2026/);
    // The condition: what it compared, the branch it took, and the engine's own reason.
    const branching = stepsTaken(page).nth(2);
    await expect(branching).toContainText('If services includes “video”');
    await expect(branching.getByRole('definition').nth(0)).toHaveText('services was: video, photo');
    await expect(branching.getByRole('definition').nth(1)).toHaveText('If yes');
    await expect(branching.getByRole('definition').nth(2)).toHaveText(
      'The condition was true, so the yes branch was taken.',
    );
    await expect(stepsTaken(page).nth(3)).toContainText(
      'Text them “Here’s our video sample reel.”',
    );
    // Everything it was given, exactly, for whoever wants the data.
    await branching.getByText('What it was given, as data', { exact: true }).click();
    await expect(branching.locator('pre')).toContainText('"contact.custom.services"');
    await expectNoViolations(page);

    // The address is the run's own: opened again, it is the same run.
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 2, name: /^Run for Maya Thompson/ }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to the enrollment history', exact: true }).click();
    await expect(page).toHaveURL(builderAt('runs'));
    await expect(enrolled(page)).toHaveCount(3);
  });

  test('shows why a run failed, on the run and on the step that failed', async ({ page }) => {
    await openBuilder(page, withRuns(), 'runs', runIds.priya);
    await expect(
      page.getByRole('heading', { level: 2, name: /^Run for Priya Nair/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Failed: the contact hasn't agreed to marketing messages on this channel.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(stepsTaken(page)).toHaveCount(1);
    await expect(stepsTaken(page).first()).toContainText(
      'Messaging refused the email: consent_required.',
    );
    await expect(stepsTaken(page).first().locator('code')).toHaveText('consent_required');
  });

  test('says when there are none yet, when a run is not there, and when the runs fail to load', async ({
    page,
  }) => {
    const state = world();
    await openBuilder(page, state, 'runs');
    await expect(
      page.getByRole('heading', { name: 'Nobody has been enrolled yet', exact: true }),
    ).toBeVisible();
    await expectNoViolations(page);

    await page.goto(builderAt('runs', runIds.maya));
    await expect(page.getByRole('alert')).toContainText(
      "This run doesn't exist, or it belongs to another business.",
    );
    await page.getByRole('link', { name: 'Back to the enrollment history', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Nobody has been enrolled yet', exact: true }),
    ).toBeVisible();

    let failing = true;
    await page.route(`**/api/v1/automations/${automationId}/runs**`, (route) =>
      failing ? route.fulfill({ status: 500, json: {} }) : route.fallback(),
    );
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const alert = page.getByRole('alert');
    // It tries a few more times by itself before it says so.
    await expect(alert).toContainText("We couldn't load the enrollment history.", {
      timeout: 20_000,
    });
    failing = false;
    await alert.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Nobody has been enrolled yet', exact: true }),
    ).toBeVisible();
  });
});

test.describe("a contact's runs", () => {
  async function contactPage(page: Page, state: World): Promise<void> {
    await emptyContactPanels(page);
    await page.route(`**/api/v1/contacts/${contactIds.maya}`, (route) =>
      route.fulfill({
        json: {
          id: contactIds.maya,
          firstName: 'Maya',
          lastName: 'Thompson',
          name: 'Maya Thompson',
          emails: ['maya@example.com'],
          phones: [],
          timeZone: null,
          doNotContact: false,
          preferencesRevision: 'a'.repeat(64),
          createdAt: '2026-10-06T12:00:00.000Z',
          updatedAt: '2026-10-06T12:00:00.000Z',
          trashedAt: null,
          canManage: true,
        },
      }),
    );
    await runsApi(page, state);
  }

  test('are on the contact’s own page, each leading to the run with its steps', async ({
    page,
  }) => {
    const state = withRuns();
    await openBuilder(page, state, 'runs');
    await contactPage(page, state);
    await page.goto(inHarbor(`/contacts/${contactIds.maya}?tab=actions`));
    const panel = page.getByRole('region', { name: 'Workflows', exact: true });
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    await expect(panel).toContainText('New lead follow-up');
    await expect(panel).toContainText('Went through to the end.');
    await expect(panel).toContainText(/Started Oct 6, 2026/);

    await panel.getByRole('link', { name: /^New lead follow-up: open the run started/ }).click();
    await expect(page).toHaveURL(builderAt('runs', runIds.maya));
    await expect(
      page.getByRole('heading', { level: 2, name: /^Run for Maya Thompson/ }),
    ).toBeVisible();
    await expect(stepsTaken(page)).toHaveCount(4);
  });

  test('says so when no automation has run for the contact', async ({ page }) => {
    const state = world();
    await openBuilder(page, state);
    await contactPage(page, state);
    await page.goto(inHarbor(`/contacts/${contactIds.maya}?tab=actions`));
    await expect(
      page
        .getByRole('region', { name: 'Workflows', exact: true })
        .getByText('No automation has run for this contact.', { exact: true }),
    ).toBeVisible();
  });
});

for (const width of [360, 1440])
  test.describe(`run history at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('fits the page: the list of runs and one run, without sideways scrolling', async ({
      page,
    }, testInfo) => {
      await openBuilder(page, withRuns(), 'runs');
      await expect(enrolled(page)).toHaveCount(3);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: testInfo.outputPath('runs.png'), fullPage: true });

      await page.goto(builderAt('runs', runIds.maya));
      await expect(stepsTaken(page)).toHaveCount(4);
      await page
        .getByRole('list', { name: 'Steps taken', exact: true })
        .getByText('What it was given, as data', { exact: true })
        .nth(2)
        .click();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: testInfo.outputPath('run.png'), fullPage: true });
      // Every link and button is inside the page.
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll('main a, main button, main pre')]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && (box.left < 0 || box.right > window.innerWidth + 0.5);
          })
          .map((element) => element.textContent),
      );
      expect(overflowing).toEqual([]);
    });
  });
