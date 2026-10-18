// The builder's tools around the drawing: how the canvas draws branches that come together
// again (one lane, one add button), the Wait panel's own controls, the version history with
// restore, and running a failed run again.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { replaceAutomationDraftInput } from '@repo/contracts';
import {
  automationsApi,
  builderAt,
  expectNoSidewaysScroll,
  expectNoViolations,
  openBuilder,
  step,
  world,
  type World,
} from './automation-api';
import {
  automationOf,
  followUp,
  leadIntake,
  mayaRun,
  priyaRun,
  runIds,
  runList,
  stamp,
  threeDeals,
  versionId,
} from './automation-fixtures';
import { signedIn } from './session';

// Kept where the owner can open them after the run: reports/ is not cleared between runs.
const shots = path.join(import.meta.dirname, '..', 'reports', 'builder-ui');
mkdirSync(shots, { recursive: true });
const shot = (name: string): string => path.join(shots, name);

const canvas = (page: Page) => page.getByTestId('automation-canvas');
/** Every line of the drawing, as its corners: read from the path the canvas drew. */
const linesOf = (page: Page): Promise<number[][]> =>
  canvas(page)
    .locator('svg path[d]')
    .evaluateAll((paths) =>
      paths.map(
        (each) => (each.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [],
      ),
    );
const boxOf = async (page: Page, id: string) => {
  const box = await step(page, id).boundingBox();
  if (box === null) throw new Error(`${id} is not drawn.`);
  return box;
};

async function openCanvas(page: Page, draft: Record<string, unknown>): Promise<World> {
  const state = world({ automations: [automationOf({ draft, name: String(draft['name']) })] });
  await signedIn(page);
  await automationsApi(page, state);
  await page.goto(builderAt('canvas'));
  await expect(canvas(page)).toBeVisible();
  return state;
}

test.describe('branches that join again on the canvas', () => {
  test.use({ viewport: { width: 1440, height: 1100 } });

  test('draws three branches into one step: a column each, one lane, one add button', async ({
    page,
  }) => {
    await openCanvas(page, threeDeals);
    await expect(step(page, 'thanks')).toBeVisible();
    const [photo, video, other, join] = await Promise.all(
      ['deal_photo', 'deal_video', 'deal_other', 'thanks'].map((id) => boxOf(page, id)),
    );
    // Three columns on one row, and the step they join at under the middle of them.
    expect(new Set([photo?.y, video?.y, other?.y]).size).toBe(1);
    expect(photo && video && video.x - photo.x).toBeGreaterThan(photo?.width ?? 0);
    expect(join?.x).toBe(video?.x);
    expect(join?.y).toBeGreaterThan((photo?.y ?? 0) + (photo?.height ?? 0) + 80);
    // Each branch is named by a pill on its own column.
    for (const name of ['If “photo”', 'If “video”', 'If none of them holds'])
      await expect(canvas(page).locator('[data-branch-label]', { hasText: name })).toBeVisible();
    // One add button where they join, and none on the three lines that arrive there.
    await expect(
      page.getByRole('button', {
        name: /^Add an action before: .*for every path that joins here$/,
      }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: /^Add an action after: Create an opportunity/ }),
    ).toHaveCount(0);
    // Corners are drawn round.
    expect((await linesOf(page)).length).toBeGreaterThan(5);
    await expect(canvas(page).locator('svg path[d*=" Q "]').first()).toBeAttached();
    await expectNoViolations(page);
    await canvas(page).screenshot({ path: shot('three-branches-rejoin-1440.png') });
  });

  test('draws two branches sharing a follow-up and all three joining again, with one + at each join', async ({
    page,
  }) => {
    const state = await openCanvas(page, leadIntake);
    await expect(step(page, 'follow_up')).toBeVisible();
    const joins = page.getByRole('button', {
      name: /^Add an action before: .*for every path that joins here$/,
    });
    await expect(joins).toHaveCount(2);
    // No two add buttons are close together anywhere on the drawing.
    const centres = await canvas(page)
      .locator('[data-add-point]')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return [box.x + box.width / 2, box.y + box.height / 2] as const;
        }),
      );
    for (const [i, a] of centres.entries())
      for (const b of centres.slice(i + 1))
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThanOrEqual(40);
    await canvas(page).screenshot({ path: shot('lead-intake-two-joins-1440.png') });

    // The one + adds before the joined step, for both branches that arrive there.
    await joins.first().click();
    const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
    await actions.getByRole('button', { name: /^Add tag/ }).click();
    await page.getByRole('combobox', { name: 'Tag', exact: true }).click();
    await page.getByRole('option', { name: 'VIP', exact: true }).click();
    await page.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(step(page, 'tag_add')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    const save = state.writes.findLast((write) => write.method === 'PUT');
    expect(replaceAutomationDraftInput.parse(save?.body).document).toMatchObject({
      steps: {
        deal_photo: { next: 'tag_add' },
        deal_video: { next: 'tag_add' },
        deal_other: { next: 'thanks' },
        tag_add: { next: 'follow_up' },
      },
    });

    // Adding to one of the joining branches alone is in that step's own menu.
    await page
      .getByRole('button', { name: /^Actions for: Create an opportunity/ })
      .first()
      .click();
    await expect(
      page.getByRole('menuitem', { name: 'Add an action after this one', exact: true }),
    ).toBeVisible();
  });
});

for (const width of [360, 1440])
  test.describe(`the builder's tools at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the joined drawing and the Wait panel fit the page', async ({ page }) => {
      await openCanvas(page, leadIntake);
      await expect(step(page, 'follow_up')).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({
        path: shot(`lead-intake-page-${String(width)}.png`),
        fullPage: true,
      });

      await openCanvas(page, followUp);
      await page.getByRole('button', { name: 'Edit: Wait 2 days', exact: true }).click();
      const wait = page.getByRole('dialog', { name: 'Wait', exact: true });
      await wait.getByRole('combobox', { name: 'Unit for: How long to wait' }).click();
      await page.getByRole('option', { name: 'Seconds', exact: true }).click();
      await wait.getByRole('button', { name: 'One more: How long to wait' }).click();
      await expect(wait.getByLabel('How long to wait', { exact: true })).toHaveValue('3');
      await wait.getByRole('switch', { name: 'Only go on during certain hours' }).click();
      await expect(wait.getByRole('group', { name: 'Days', exact: true })).toBeVisible();
      await wait.getByRole('button', { name: 'Saturday', exact: true }).click();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`wait-panel-${String(width)}.png`) });
      await wait.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(step(page, 'wait_2_days')).toContainText('Wait 3 seconds');
    });

    test('lists the versions, says what restoring one would change, and restores it as the draft', async ({
      page,
    }) => {
      const older = {
        ...followUp,
        steps: {
          ...followUp.steps,
          send_reel: { type: 'sms.send', config: { message: 'An older text.' } },
        },
      };
      const state = world({
        automations: [
          automationOf({
            status: 'active',
            liveVersion: 2,
            live: {
              id: versionId,
              version: 2,
              changeSummary: 'Shorter texts',
              publishedAt: stamp,
              document: followUp,
            },
          }),
        ],
        versions: [
          {
            id: versionId,
            version: 2,
            changeSummary: 'Shorter texts',
            publishedAt: stamp,
            publishedByKind: 'user',
          },
          {
            id: 'aver_01k8e2wzr0e008000000000012',
            version: 1,
            changeSummary: '',
            publishedAt: '2026-10-01T09:00:00.000Z',
            publishedByKind: 'api_key',
          },
        ],
        versionDocuments: { 1: older },
      });
      await openBuilder(page, state);
      await page.getByRole('button', { name: 'Versions', exact: true }).click();
      const history = page.getByRole('dialog', { name: 'Version history', exact: true });
      const versions = history.getByRole('list', { name: 'Published versions', exact: true });
      await expect(versions.getByRole('listitem')).toHaveCount(2);
      await expect(versions.getByRole('listitem').first()).toContainText('Live');
      await expect(versions.getByRole('listitem').nth(1)).toContainText(
        'Published by an app, through the API',
      );
      await history.getByRole('button', { name: /^Version 1, published/ }).click();
      const compared = history.getByRole('region', { name: 'Version 1 compared with your draft' });
      await expect(compared).toContainText('An older text.');
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`versions-${String(width)}.png`) });

      await compared.getByRole('button', { name: 'Restore this version as the draft' }).click();
      const confirm = page.getByRole('dialog', { name: 'Restore version 1 as the draft?' });
      await expect(confirm).toContainText('Nothing is published');
      await expectNoViolations(page);
      await confirm.getByRole('button', { name: 'Restore as the draft', exact: true }).click();
      await expect(
        page.getByText(
          'Version 1 is now the draft. Nothing was published; publish when it is ready.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(history).toBeHidden();
      // Saved as the draft, over the draft it started from, and nothing was published.
      const saves = state.writes.filter((write) => write.method === 'PUT');
      expect(saves).toHaveLength(1);
      expect(replaceAutomationDraftInput.parse(saves[0]?.body)).toMatchObject({
        baseDraftVersion: 3,
        document: { steps: { send_reel: { config: { message: 'An older text.' } } } },
      });
      expect(state.writes.filter((write) => write.path.endsWith('/publish'))).toEqual([]);
      await expect(step(page, 'send_reel')).toContainText('An older text.');
      await expect(page.getByText('Live · version 2', { exact: true })).toBeVisible();
    });

    test('runs a failed run again, and says in the server’s words when it cannot', async ({
      page,
    }) => {
      const state = world({
        runs: runList.items,
        runDetails: { [runIds.maya]: mayaRun, [runIds.priya]: priyaRun },
        retryRefusal:
          'The automation has been published again since this run began, so the run cannot go on from its failed step. Enrol the contact again instead.',
      });
      await openBuilder(page, state, 'runs');
      // One press narrows the history to the runs that need review.
      const review = page.getByRole('button', { name: 'Needs review', exact: true });
      await review.click();
      await expect(review).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => state.runQueries.at(-1)).toContain('status=failed');
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);

      await page.goto(builderAt('runs', runIds.priya));
      const again = page.getByRole('button', { name: 'Run again', exact: true });
      await again.click();
      await expect(page.getByRole('alert')).toHaveText(state.retryRefusal ?? '');
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({
        path: shot(`run-again-refused-${String(width)}.png`),
        fullPage: true,
      });

      state.retryRefusal = undefined;
      await again.click();
      await expect(
        page.getByText('Running again from the action that failed.', { exact: true }),
      ).toBeVisible();
      await expect(again).toBeHidden();
      expect(state.writes.map((write) => write.path)).toEqual([
        `/automation-runs/${runIds.priya}/retry`,
        `/automation-runs/${runIds.priya}/retry`,
      ]);
      // A run that did not fail has nothing to run again.
      await page.goto(builderAt('runs', runIds.maya));
      await expect(page.getByRole('heading', { level: 2, name: /^Run for Maya/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Run again', exact: true })).toHaveCount(0);
    });
  });
