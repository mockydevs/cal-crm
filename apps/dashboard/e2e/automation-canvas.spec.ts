// The builder's Canvas view: the same draft the Steps and JSON views show, drawn as boxes
// and lines. Dragging a step from the library and the + between steps both produce valid
// documents, moving a box changes only the document's layout, the document goes round the
// three views and the server unchanged, and all of it works from the keyboard.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { replaceAutomationDraftInput, validateAutomation } from '@repo/contracts';
import {
  automationsApi,
  builderAt,
  expectNoSidewaysScroll,
  expectNoViolations,
  json,
  openBuilder,
  step,
  view,
  world,
  type World,
} from './automation-api';
import { automationOf, followUp, harborSetup, welcome } from './automation-fixtures';
import { signedIn } from './session';

const guide = 'Send the email “Pricing guide”';
const canvas = (page: Page): Locator => page.getByTestId('automation-canvas');
const add = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true });
const library = (page: Page): Locator => page.getByRole('region', { name: 'Actions', exact: true });

/** Where a step's box is drawn, in the canvas's own coordinates. */
const placeOf = (page: Page, id: string): Promise<{ left: number; top: number }> =>
  step(page, id).evaluate((box: HTMLElement) => ({
    left: Number.parseFloat(box.style.left),
    top: Number.parseFloat(box.style.top),
  }));
interface Place {
  left: number;
  top: number;
}
const placesOf = async (page: Page, ids: readonly string[]): Promise<Record<string, Place>> => {
  const places: Record<string, Place> = {};
  for (const id of ids) places[id] = await placeOf(page, id);
  return places;
};

/** Opens the list of actions beside the canvas, from its Add menu. */
async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add action', exact: true }).click();
  await expect(library(page)).toBeVisible();
}

/** The document the builder holds, as the JSON view writes it. */
async function documentIn(page: Page): Promise<Record<string, unknown>> {
  await view(page, 'JSON').click();
  await expect(json(page)).toBeVisible();
  return JSON.parse(await json(page).inputValue()) as Record<string, unknown>;
}
const lastSave = (state: World): Record<string, unknown> => {
  const save = state.writes.findLast((write) => write.method === 'PUT');
  return replaceAutomationDraftInput.parse(save?.body).document;
};

test.describe('the canvas', () => {
  test('is fetched when first opened, and draws the draft the other views show', async ({
    page,
  }) => {
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
    });
    const ofCanvas = (): string[] => scripts.filter((path) => path.includes('automation-canvas'));
    await openBuilder(page, world());
    await expect(step(page, 'send_guide')).toBeVisible();
    // The builder is open in the Steps view, and nothing of the canvas has been fetched.
    expect(ofCanvas()).toEqual([]);

    await view(page, 'Canvas').click();
    await expect(page).toHaveURL(builderAt('canvas'));
    await expect(
      page.getByRole('heading', { level: 2, name: 'Canvas', exact: true }),
    ).toBeAttached();
    expect(ofCanvas()).toHaveLength(1);
    await expect(view(page, 'Canvas')).toHaveAttribute('aria-current', 'page');

    await expect(
      page.getByRole('group', {
        name: 'Trigger: Someone submits “Request a quote”',
        exact: true,
      }),
    ).toBeVisible();
    // Every step, in the order a contact meets it: the order the keyboard and a screen
    // reader go through them in.
    await expect(canvas(page).locator('[data-canvas-box][id^="automation-step-"]')).toHaveText([
      /Send email.*Send the email “Pricing guide”/,
      /Wait.*Wait 2 days/,
      /If \/ else.*If services includes “video”/,
      /Send text.*Text them “Here’s our video sample reel/,
      /Send text.*Text them “Hi \{\{contact\.firstName\}\}/,
      /Wait.*Wait 3 days/,
      /Send text.*Text them “Last check-in from Harbor Lights\.”/,
    ]);
    await expect(canvas(page).getByText('END', { exact: true })).toHaveCount(2);
    await expect(canvas(page).getByText('If yes', { exact: true })).toBeVisible();
    await expect(page.getByText('Their opportunity is won or lost', { exact: true })).toBeVisible();
    // Laid out as a tree: each step under the one before it, the branches side by side.
    const at = await placesOf(page, ['send_guide', 'wait_2_days', 'send_reel', 'check_in']);
    expect(at['wait_2_days']).toEqual({
      left: at['send_guide']?.left,
      top: (at['send_guide']?.top ?? 0) + 140,
    });
    expect(at['send_reel']?.top).toBe(at['check_in']?.top);
    expect((at['check_in']?.left ?? 0) - (at['send_reel']?.left ?? 0)).toBe(400);
    // Nobody arranged it, so the document has no layout to save.
    await expect(page.getByTestId('automation-unsaved')).toHaveCount(0);
  });

  test('adds a step with the + between two steps: a valid document, in every view', async ({
    page,
  }) => {
    const state = world();
    await openBuilder(page, state, 'canvas');
    await add(page, `Add an action after: ${guide}`).click();
    const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
    await picker.getByRole('button', { name: /^Wait\s*Wait for a length/ }).click();
    const form = page.getByRole('dialog', { name: 'Wait', exact: true });
    await form.getByRole('spinbutton', { name: 'How long to wait', exact: true }).fill('4');
    await form.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(form).toBeHidden();

    // On the canvas, between the two steps it was added between.
    const added = step(page, 'wait');
    await expect(added).toContainText('Wait 4 days');
    const at = await placesOf(page, ['send_guide', 'wait', 'wait_2_days']);
    expect(at['wait']?.top).toBe((at['send_guide']?.top ?? 0) + 140);
    expect(at['wait_2_days']?.top).toBe((at['wait']?.top ?? 0) + 140);
    // The keyboard is on the step that was added.
    expect(await added.evaluate((box) => box.contains(document.activeElement))).toBe(true);

    const written = await documentIn(page);
    expect(written).toMatchObject({
      steps: {
        send_guide: { next: 'wait' },
        wait: { type: 'wait', config: { duration: 'P4D' }, next: 'wait_2_days' },
      },
    });
    expect(validateAutomation(written, harborSetup).errors).toEqual([]);
    await view(page, 'Steps').click();
    await expect(step(page, 'wait')).toContainText('Wait 4 days');
  });

  test('adds a step dragged from the library onto the canvas: a valid document', async ({
    page,
  }) => {
    const state = world();
    await openBuilder(page, state, 'canvas');
    await openLibrary(page);
    // The keyboard is in the search box.
    const search = library(page).getByRole('searchbox', { name: 'Search actions', exact: true });
    await expect(search).toBeFocused();
    await search.fill('tag');
    await expect(library(page).getByRole('listitem')).toHaveText([/^Add tag/, /^Remove tag/]);

    // Dropped on the canvas beside the line from "Wait 3 days": it goes to the nearest add
    // point, which is on that line.
    const target = add(page, 'Add an action after: Wait 3 days');
    await target.scrollIntoViewIfNeeded();
    await library(page)
      .getByRole('button', { name: /^Add tag/ })
      .dragTo(target, { targetPosition: { x: 36, y: 20 } });
    const form = page.getByRole('dialog', { name: 'Add tag', exact: true });
    await expect(form).toBeVisible();
    await form.getByRole('combobox', { name: 'Tag', exact: true }).click();
    await page.getByRole('option', { name: 'VIP', exact: true }).click();
    await form.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(step(page, 'tag_add')).toContainText('Add the tag VIP');

    // The open list never hides the drawing on a canvas this wide: the drawing makes room
    // for it, so the rightmost line can be dropped on as well, and none lies under the list.
    const rightmost = add(page, 'Add an action to: If no of If services includes “video”');
    await rightmost.scrollIntoViewIfNeeded();
    const panel = await library(page).boundingBox();
    const point = await rightmost.boundingBox();
    expect((point?.x ?? 0) + (point?.width ?? 0)).toBeLessThan(panel?.x ?? 0);
    const leftmost = add(page, 'Add an action to: If yes of If services includes “video”');
    await leftmost.scrollIntoViewIfNeeded();
    await search.fill('wait');
    await library(page)
      .getByRole('button', { name: /^Wait\s*Wait for a length/ })
      .dragTo(leftmost);
    const waiting = page.getByRole('dialog', { name: 'Wait', exact: true });
    await waiting.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(step(page, 'wait')).toContainText('Wait 1 day');

    const written = await documentIn(page);
    expect(written).toMatchObject({
      steps: {
        asked_about_video: { next: { yes: 'wait', no: 'check_in' } },
        wait: { type: 'wait', next: 'send_reel' },
        wait_3_days: { next: 'tag_add' },
        tag_add: { type: 'tag.add', config: { tag: 'tag_vip' }, next: 'last_check_in' },
      },
    });
    expect(validateAutomation(written, harborSetup).errors).toEqual([]);
  });

  test('moves a box with the mouse: only the layout changes, and the document goes round the three views and the server unchanged', async ({
    page,
  }) => {
    const state = world();
    await openBuilder(page, state, 'canvas');
    const ids = Object.keys(followUp.steps);
    const before = await placesOf(page, ids);

    await step(page, 'send_reel').scrollIntoViewIfNeeded();
    const box = await step(page, 'send_reel').boundingBox();
    if (box === null) throw new Error('The step is on the canvas.');
    await page.mouse.move(box.x + 80, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 90, { steps: 4 });
    await page.mouse.move(box.x - 60, box.y + 160, { steps: 6 });
    await page.mouse.up();
    // A drag is not a click: no form opened.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('automation-unsaved')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tidy layout', exact: true })).toBeVisible();

    // The box moved 140 left and 120 down, on the grid. Every other box is where it was:
    // the drawing may have grown to the left, which moves them all alike on the screen.
    const after = await placesOf(page, ids);
    const shift = (after['send_guide']?.left ?? 0) - (before['send_guide']?.left ?? 0);
    for (const id of ids) {
      const moved = id === 'send_reel' ? { left: -140, top: 120 } : { left: 0, top: 0 };
      expect(after[id], id).toEqual({
        left: (before[id]?.left ?? 0) + shift + moved.left,
        top: (before[id]?.top ?? 0) + moved.top,
      });
    }

    // In the JSON view: the same document, plus a place for every step.
    const written = await documentIn(page);
    const { layout, ...rest } = written;
    expect(rest).toEqual(followUp);
    expect(Object.keys(layout as object)).toEqual(ids);
    expect(validateAutomation(written, harborSetup).errors).toEqual([]);
    // Through the Steps view and back, nothing has changed.
    await view(page, 'Steps').click();
    await expect(step(page, 'send_reel')).toContainText('video sample reel');
    expect(await documentIn(page)).toEqual(written);

    // Saved, it is what the server holds; opened again, the canvas draws it the same.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Draft saved.' })).toBeVisible();
    expect(lastSave(state)).toEqual(written);
    await page.goto(builderAt('canvas'));
    await expect(step(page, 'send_reel')).toBeVisible();
    expect(await placesOf(page, ids)).toEqual(after);
    expect(await documentIn(page)).toEqual(written);

    // Tidying forgets the arrangement: the document is the original again.
    await view(page, 'Canvas').click();
    await page.getByRole('button', { name: 'Tidy layout', exact: true }).click();
    expect(await placesOf(page, ids)).toEqual(before);
    expect(await documentIn(page)).toEqual(followUp);
  });

  test('draws what the JSON view and the API wrote: a layout for one step only, as the documentation has it', async ({
    page,
  }) => {
    // AUTOMATIONS.md's own example places only the first step; the rest are laid out from it.
    const documented = { ...followUp, layout: { send_guide: { x: 0, y: 160 } } };
    await openBuilder(
      page,
      world({ automations: [automationOf({ draft: documented })] }),
      'canvas',
    );
    await expect(step(page, 'last_check_in')).toBeVisible();
    const at = await placesOf(page, ['send_guide', 'wait_2_days', 'asked_about_video']);
    expect(at['wait_2_days']).toEqual({
      left: at['send_guide']?.left,
      top: (at['send_guide']?.top ?? 0) + 140,
    });
    // No two boxes overlap.
    const boxes = await canvas(page)
      .locator('[data-canvas-box]')
      .evaluateAll((all) => all.map((each) => each.getBoundingClientRect().toJSON() as DOMRect));
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1))
        expect(
          a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
        ).toBe(true);
    // Opening it changed nothing: the document is as it was written.
    await expect(page.getByTestId('automation-unsaved')).toHaveCount(0);
    expect(await documentIn(page)).toEqual(documented);
  });

  test('works from the keyboard alone: the library, placing a step, its form, and moving a box', async ({
    page,
  }) => {
    await openBuilder(page, world(), 'canvas');
    await expect(step(page, 'send_guide')).toBeVisible();
    const tabTo = async (target: Locator): Promise<void> => {
      for (let presses = 0; presses < 120; presses += 1) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press('Tab');
      }
      await expect(target).toBeFocused();
    };

    // The list of actions opens from the Add menu and closes from the keyboard, and the
    // keyboard is given on each time: to its search box, then back to the button.
    const toggle = page.getByRole('button', { name: 'Add', exact: true });
    const fromMenu = async (): Promise<void> => {
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'Add trigger', exact: true })).toBeVisible();
      await page.getByRole('menuitem', { name: 'Add action', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(library(page)).toBeVisible();
    };
    await tabTo(toggle);
    await fromMenu();
    await expect(
      library(page).getByRole('searchbox', { name: 'Search actions', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(library(page)).toBeHidden();
    await expect(toggle).toBeFocused();

    // Choosing a step puts the keyboard on the first place it could go.
    await fromMenu();
    await tabTo(library(page).getByRole('button', { name: /^Send text/ }));
    await page.keyboard.press('Enter');
    await expect(library(page)).toBeHidden();
    await expect(page.getByText('Choose where to put: Send text', { exact: true })).toBeVisible();
    await expect(add(page, 'Add an action at the start')).toBeFocused();
    await tabTo(add(page, 'Add an action after: Wait 3 days'));
    await page.keyboard.press('Enter');
    const form = page.getByRole('dialog', { name: 'Send text', exact: true });
    await expect(form.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
    await page.keyboard.type('Still there?');
    await tabTo(form.getByRole('button', { name: 'Save action', exact: true }));
    await page.keyboard.press('Enter');
    await expect(form).toBeHidden();
    const added = step(page, 'sms_send');
    await expect(added).toContainText('Text them “Still there?”');
    expect(await added.evaluate((box) => box.contains(document.activeElement))).toBe(true);

    // The arrow keys move a box from its Move button, a grid square at a time.
    const before = await placeOf(page, 'wait_3_days');
    const move = page.getByRole('button', { name: 'Move: Wait 3 days', exact: true });
    await tabTo(move);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(move).toBeFocused();
    expect(await placeOf(page, 'wait_3_days')).toEqual({
      left: before.left + 40,
      top: before.top + 20,
    });
    await expect(
      page.getByRole('status').filter({ hasText: 'Moved Wait 3 days down.' }),
    ).toBeAttached();

    // Enter on a box opens its step; Escape closes it and gives the keyboard back.
    const open = page.getByRole('button', { name: 'Edit: Wait 3 days', exact: true });
    await open.focus();
    await page.keyboard.press('Enter');
    const editing = page.getByRole('dialog', { name: 'Wait', exact: true });
    await expect(editing).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editing).toBeHidden();
    await expect(open).toBeFocused();

    // Deleting, from the card's own menu, asks first, from the keyboard too.
    await tabTo(page.getByRole('button', { name: 'Actions for: Wait 3 days', exact: true }));
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).focus();
    await page.keyboard.press('Enter');
    const asking = page.getByRole('dialog', { name: 'Delete this action?', exact: true });
    await expect(asking.getByRole('button', { name: 'Keep it', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(asking).toBeHidden();

    const written = await documentIn(page);
    expect(validateAutomation(written, harborSetup).errors).toEqual([]);
    expect(written).toMatchObject({
      steps: { wait_3_days: { next: 'sms_send' }, sms_send: { next: 'last_check_in' } },
    });
  });

  test('zooms, and fits the drawing to the screen', async ({ page }) => {
    await openBuilder(page, world(), 'canvas');
    const width = async (): Promise<number> =>
      (await step(page, 'send_guide').boundingBox())?.width ?? 0;
    // Each size is asked for until it is drawn: see the fit below.
    await expect.poll(width).toBeCloseTo(240, 0);
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await expect.poll(width).toBeCloseTo(180, 0);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(width).toBeCloseTo(300, 0);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.getByRole('button', { name: 'Fit to screen', exact: true }).click();
    // The whole drawing is now as wide as the canvas shows, or narrower. Asked until it
    // is so: the new scale is drawn a frame after the click where every change is a
    // (momentary) transition, as it is for people who ask for reduced motion.
    await expect
      .poll(() =>
        canvas(page).evaluate((scroller) => scroller.scrollWidth <= scroller.clientWidth + 1),
      )
      .toBe(true);
    await expect.poll(width).toBeLessThan(240);
  });

  test('is for looking only without the permission to change automations', async ({ page }) => {
    await openBuilder(page, world({ flags: { canManage: false, canPublish: false } }), 'canvas');
    await expect(step(page, 'send_guide')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^(Add|Edit|Move|Remove|Delete|Duplicate|Actions for)/ }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
    await expectNoViolations(page);
  });

  test('starts an empty automation from its first step', async ({ page }) => {
    const empty = { name: 'Welcome', triggers: welcome.triggers, steps: {} };
    await openBuilder(page, world({ automations: [automationOf({ draft: empty })] }), 'canvas');
    await expect(canvas(page).getByText('END', { exact: true })).toBeVisible();
    await add(page, 'Add the first action').click();
    await page
      .getByRole('dialog', { name: 'Actions', exact: true })
      .getByRole('button', { name: /^Add tag/ })
      .click();
    const form = page.getByRole('dialog', { name: 'Add tag', exact: true });
    await form.getByRole('combobox', { name: 'Tag', exact: true }).click();
    await page.getByRole('option', { name: 'VIP', exact: true }).click();
    await form.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(step(page, 'tag_add')).toContainText('Add the tag VIP');
    const written = await documentIn(page);
    expect(written).toMatchObject({ start: 'tag_add' });
    expect(validateAutomation(written, harborSetup).errors).toEqual([]);
  });
});

for (const width of [360, 1440])
  test.describe(`the canvas at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('fits the page: the drawing scrolls inside the canvas, never the page', async ({
      page,
    }, testInfo) => {
      await signedIn(page);
      await automationsApi(page, world());
      await page.goto(builderAt('canvas'));
      await expect(step(page, 'send_guide')).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: testInfo.outputPath('canvas.png'), fullPage: true });
      // The canvas itself is inside the page, however wide the drawing is.
      const frame = await canvas(page).boundingBox();
      expect(frame?.x).toBeGreaterThanOrEqual(0);
      expect((frame?.x ?? 0) + (frame?.width ?? 0)).toBeLessThanOrEqual(width);

      // With the library open, and its controls inside the page.
      const toggle = page.getByRole('button', { name: 'Add', exact: true });
      await openLibrary(page);
      await expectNoSidewaysScroll(page);
      // The pointer is still on the button: its hover colours are checked too, on every
      // machine, and not only where the browser happens to report the hover.
      await toggle.hover();
      await expectNoViolations(page);
      const panel = await library(page).boundingBox();
      expect(panel?.x).toBeGreaterThanOrEqual(0);
      expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath('library.png') });

      // Choosing a step and its place works at this width too, and the form fits.
      await library(page)
        .getByRole('button', { name: /^Wait\s*Wait for a length/ })
        .click();
      const first = add(page, 'Add an action at the start');
      await expect(first).toBeFocused();
      await expectNoViolations(page);
      await first.click();
      const form = page.getByRole('dialog', { name: 'Wait', exact: true });
      await expect(form).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await form.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(step(page, 'wait')).toBeVisible();
      await expectNoSidewaysScroll(page);

      // Fitted to the screen, the whole drawing is in view across.
      await page.getByRole('button', { name: 'Fit to screen', exact: true }).click();
      await expect
        .poll(() =>
          canvas(page).evaluate((scroller) => scroller.scrollWidth <= scroller.clientWidth + 1),
        )
        .toBe(true);
      await page.screenshot({ path: testInfo.outputPath('fitted.png'), fullPage: true });
    });
  });
