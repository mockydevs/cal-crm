import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  deletePipelineInput,
  duplicatePipelineInput,
  movePipelineInput,
  savePipelinesInput,
  type Pipeline,
  type PipelineConfiguration,
} from '@repo/contracts';
import { reachesRightGutter } from './lists';
import { harbor, inHarbor, signedIn } from './session';

// The Pipelines page: a list, and a dialog that creates or edits a pipeline and its stages,
// reached from Settings and from the Pipelines tab of Opportunities.

const pipelineIds = ['pipe_01h455vb4pex5vsknk084sn02q', 'pipe_01h455vb4pex5vsknk084sn02r'];
const stageIdOf = (number: number): string =>
  `stage_01h455vb4pex5vsknk084sn${String(number).padStart(3, '0')}`;

const sales: Pipeline = {
  id: pipelineIds[0] ?? '',
  name: 'Sales',
  description: '',
  archived: false,
  stages: [
    { id: stageIdOf(1), name: 'New', description: '', archived: false },
    { id: stageIdOf(2), name: 'Quoted', description: 'A price was sent', archived: false },
    { id: stageIdOf(3), name: 'Won', description: '', archived: false },
  ],
};
const events: Pipeline = {
  id: pipelineIds[1] ?? '',
  name: 'Events',
  description: 'Weddings and parties',
  archived: false,
  stages: [{ id: stageIdOf(4), name: 'Enquiry', description: '', archived: false }],
};

interface PipelinesApi {
  current: PipelineConfiguration;
  readonly saves: unknown[];
  /** The requests that move, duplicate or delete one pipeline, as they arrived. */
  readonly commands: { method: string; path: string; body: unknown }[];
  /** Pipelines the server will not delete: they hold opportunities. */
  readonly holding: Set<string>;
}

/** Stands in for the server: it keeps what is saved, and gives new entries their ids. */
async function pipelinesApi(
  page: Page,
  items: Pipeline[] = [],
  canManage = true,
): Promise<PipelinesApi> {
  const api: PipelinesApi = {
    current: { revision: 'a'.repeat(64), items, canManage },
    saves: [],
    commands: [],
    holding: new Set(),
  };
  let made = 10;
  await page.route('**/api/v1/pipelines', async (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    if (route.request().method() === 'PUT') {
      const input = savePipelinesInput.parse(route.request().postDataJSON());
      api.saves.push(input);
      api.current = {
        ...api.current,
        revision: String(api.saves.length % 10).repeat(64),
        items: input.items.map((item, index) => ({
          ...item,
          id: item.id ?? pipelineIds[index] ?? '',
          stages: item.stages.map((stage) => ({
            ...stage,
            id: stage.id ?? stageIdOf((made += 1)),
          })),
        })),
      };
    }
    await route.fulfill({ json: api.current });
  });
  // One pipeline moved, copied or deleted by itself, each under the list's revision.
  await page.route(/\/api\/v1\/pipelines\/pipe_[^/]+(?:\/(?:move|duplicate))?$/, async (route) => {
    const request = route.request();
    const [, id = '', command] =
      /\/pipelines\/(pipe_[^/]+)(?:\/(move|duplicate))?$/.exec(new URL(request.url()).pathname) ??
      [];
    const body = request.postDataJSON() as unknown;
    api.commands.push({
      method: request.method(),
      path: new URL(request.url()).pathname.replace('/api/v1', ''),
      body,
    });
    const refuse = (detail: string) =>
      route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        json: { type: 'about:blank', title: 'Conflict', status: 409, detail },
      });
    const items = api.current.items;
    const index = items.findIndex((item) => item.id === id);
    const subject = items[index];
    if (subject === undefined) throw new Error('No such pipeline.');
    const next = (changed: Pipeline[]): PipelineConfiguration => ({
      ...api.current,
      revision: String((api.commands.length + 5) % 10).repeat(64),
      items: changed,
    });
    if (command === 'move') {
      const input = movePipelineInput.parse(body);
      if (input.revision !== api.current.revision) return refuse('Stale.');
      const rest = items.filter((item) => item.id !== id);
      rest.splice(Math.min(input.position, items.length) - 1, 0, subject);
      api.current = next(rest);
      return route.fulfill({ json: api.current });
    }
    if (command === 'duplicate') {
      const input = duplicatePipelineInput.parse(body);
      if (input.revision !== api.current.revision) return refuse('Stale.');
      const copy: Pipeline = {
        ...subject,
        id: 'pipe_01h455vb4pex5vsknk084sn02z',
        name: `${subject.name} (copy)`,
        stages: subject.stages
          .filter((stage) => !stage.archived)
          .map((stage) => ({ ...stage, id: stageIdOf((made += 1)) })),
      };
      api.current = next([...items.slice(0, index + 1), copy, ...items.slice(index + 1)]);
      return route.fulfill({ status: 201, json: api.current });
    }
    const input = deletePipelineInput.parse(body);
    if (input.revision !== api.current.revision) return refuse('Stale.');
    if (api.holding.has(id))
      return refuse(
        'This pipeline holds deals, or deals passed through it. Archive it instead of deleting it.',
      );
    api.current = next(items.filter((item) => item.id !== id));
    return route.fulfill({ json: api.current });
  });
  return api;
}

const creating = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Create pipeline', exact: true });
const editing = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Edit pipeline', exact: true });
const guard = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'You have unsaved changes', exact: true });
const table = (page: Page): Locator =>
  page.getByRole('region', { name: 'Pipelines table', exact: true });
const rowOf = (page: Page, name: string): Locator =>
  table(page).getByRole('row').filter({ hasText: name });
const stageNames = (dialog: Locator): Locator => dialog.getByLabel('Stage name', { exact: true });
const probabilities = (dialog: Locator): Locator => dialog.getByLabel(/^Probability of .+ \(%\)$/);
const bodyOf = (dialog: Locator): Locator => dialog.locator('[data-slot="pipeline-dialog-body"]');
const footerOf = (dialog: Locator): Locator =>
  dialog.locator('[data-slot="pipeline-dialog-footer"]');

/** Neither the page nor the dialog's scrolling part is wider than what shows of it. */
async function expectNoSidewaysScroll(page: Page, dialog: Locator): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await bodyOf(dialog).evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
}

async function boxOf(locator: Locator): Promise<{ top: number; bottom: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('Not on screen.');
  return { top: box.y, bottom: box.y + box.height };
}

async function rowAction(page: Page, pipeline: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${pipeline}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

async function expectNoViolations(page: Page): Promise<void> {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
}

for (const width of [360, 1440]) {
  test(`creates a pipeline, reorders its stages by keyboard and archives one at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page);
    const api = await pipelinesApi(page);
    // Pipelines have one place: the Pipelines tab of Opportunities. An old Settings link lands there.
    await page.goto(inHarbor('/settings/deal-stages'));
    await expect(page).toHaveURL(inHarbor('/deals/pipelines'));
    await expect(page.getByRole('heading', { level: 1, name: 'Pipelines' })).toBeVisible();
    await expect(
      page.getByText('Use pipelines to track opportunities and sales progress across stages.'),
    ).toBeVisible();
    await expect(
      page.getByText('No pipelines yet. Create one to organize your opportunities.'),
    ).toBeVisible();
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'Create pipeline', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/deals/pipelines?mode=create'));
    const dialog = creating(page);
    await expect(dialog.getByLabel('Pipeline name')).toBeFocused();
    await expect(dialog.getByLabel('Pipeline name')).toHaveAttribute(
      'placeholder',
      'Marketing pipeline',
    );
    await expect(
      dialog.getByText('Use a unique, descriptive name so you can find this pipeline later'),
    ).toBeVisible();
    // Nothing to create until the pipeline has a name.
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    await dialog.getByLabel('Pipeline name').fill('Bookings');
    // The description is not in GoHighLevel's dialog: it is kept behind "More options".
    await expect(dialog.getByLabel('Pipeline description')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'More options', exact: true }).click();
    await dialog.getByLabel('Pipeline description').fill('Event sales');
    await expect(dialog.getByRole('heading', { name: 'Pipeline stages (4)' })).toBeVisible();
    await expect(stageNames(dialog)).toHaveCount(4);
    await expect(stageNames(dialog).first()).toHaveValue('New Lead');
    await expect(probabilities(dialog)).toHaveCount(4);
    for (const [index, percent] of ['20', '40', '60', '80'].entries())
      await expect(probabilities(dialog).nth(index)).toHaveValue(percent);

    // The pipeline's settings, as GoHighLevel has them.
    const ownProbability = dialog.getByRole('switch', {
      name: 'Use opportunity-level probability',
      exact: true,
    });
    await expect(ownProbability).toHaveAttribute('aria-checked', 'false');
    await ownProbability.click();
    await expect(ownProbability).toHaveAttribute('aria-checked', 'true');
    const colors = dialog.getByRole('radiogroup', { name: 'Set pipeline display colors' });
    await expect(colors.getByRole('radio')).toHaveCount(3);
    await expect(colors.getByRole('radio', { name: 'Default (no color)' })).toBeChecked();
    await colors.getByRole('radio', { name: 'Colored dot', exact: true }).check();
    await expect(colors.getByRole('radio', { name: 'Background tint' })).not.toBeChecked();
    // Each stage's two report toggles and its probability.
    const inFunnel = dialog.getByRole('button', {
      name: 'Show Contacted in the funnel chart',
      exact: true,
    });
    await expect(inFunnel).toHaveAttribute('aria-pressed', 'true');
    await inFunnel.click();
    await expect(inFunnel).toHaveAttribute('aria-pressed', 'false');
    await dialog
      .getByRole('button', { name: 'Show Proposal Sent in the stage distribution chart' })
      .click();
    await dialog.getByLabel('Probability of New Lead (%)', { exact: true }).fill('15');
    // More than 100 is said beside the box, and nothing can be created.
    await dialog.getByLabel('Probability of Contacted (%)', { exact: true }).fill('140');
    await expect(dialog.getByText('Enter 0 to 100.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    await dialog.getByLabel('Probability of Contacted (%)', { exact: true }).fill('');
    await expect(dialog.getByText('Enter 0 to 100.', { exact: true })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Add stage', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Pipeline stages (5)' })).toBeVisible();
    await expect(stageNames(dialog).nth(4)).toBeFocused();
    // A stage with no name can't be saved.
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    await stageNames(dialog).nth(4).fill('Quoted');
    // A stage's description is kept too, behind the row's details button.
    await expect(dialog.getByLabel('Stage description')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Stage details for Quoted', exact: true }).click();
    await dialog.getByLabel('Stage description').fill('A price was sent');

    // The handle moves its stage with the arrow keys, and keeps the keyboard.
    const handle = dialog.getByRole('button', { name: 'Reorder Quoted', exact: true });
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await expect(stageNames(dialog).nth(3)).toHaveValue('Quoted');
    await expect(handle).toBeFocused();
    await expect(dialog.getByText('Quoted moved to position 4 of 5.')).toBeAttached();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(stageNames(dialog).first()).toHaveValue('Quoted');
    // Already first: one more press changes nothing.
    await page.keyboard.press('ArrowUp');
    await expect(stageNames(dialog).first()).toHaveValue('Quoted');
    await page.keyboard.press('ArrowDown');
    await expect(stageNames(dialog).nth(1)).toHaveValue('Quoted');
    await page.keyboard.press('ArrowUp');
    await expectNoViolations(page);
    // A stage not saved yet is removed, not archived.
    await dialog.getByRole('button', { name: 'Remove Closed', exact: true }).click();
    await expect(stageNames(dialog)).toHaveCount(4);

    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Pipeline created.', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(inHarbor('/deals/pipelines'));
    const row = rowOf(page, 'Bookings');
    await expect(row.getByRole('cell').first()).toHaveText('1');
    await expect(row.getByRole('cell').nth(1)).toHaveText('4');
    expect(api.current.items[0]).toMatchObject({ name: 'Bookings', description: 'Event sales' });
    expect(api.current.items[0]?.stages.map((stage) => stage.name)).toEqual([
      'Quoted',
      'New Lead',
      'Contacted',
      'Proposal Sent',
    ]);
    // What was sent, exactly: every setting the dialog shows, and no id for what is new.
    const reports = { showInFunnel: true, showInPie: true };
    const fresh = { description: '', archived: false, color: null };
    expect(api.saves).toEqual([
      {
        revision: 'a'.repeat(64),
        items: [
          {
            name: 'Bookings',
            description: 'Event sales',
            archived: false,
            dealProbability: true,
            colorStyle: 'dot',
            ...reports,
            stages: [
              {
                ...fresh,
                ...reports,
                name: 'Quoted',
                description: 'A price was sent',
                probability: null,
              },
              { ...fresh, ...reports, name: 'New Lead', probability: 15 },
              { ...fresh, ...reports, name: 'Contacted', probability: null, showInFunnel: false },
              { ...fresh, ...reports, name: 'Proposal Sent', probability: 60, showInPie: false },
            ],
          },
        ],
      },
    ]);

    await rowAction(page, 'Bookings', 'Edit');
    await expect(page).toHaveURL(inHarbor(`/deals/pipelines?pipeline=${pipelineIds[0] ?? ''}`));
    // Nothing to save until something changes.
    await expect(editing(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await editing(page).getByRole('button', { name: 'Archive Quoted', exact: true }).click();
    await editing(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Pipeline saved.', { exact: true })).toBeVisible();
    await expect(row.getByRole('cell').nth(1)).toHaveText('3 (+1 archived)');
    expect(api.current.items[0]?.stages[0]).toMatchObject({ name: 'Quoted', archived: true });

    await page.reload();
    await row.getByRole('button', { name: 'Bookings', exact: true }).click();
    await expect(
      editing(page).getByRole('button', { name: 'Restore Quoted', exact: true }),
    ).toBeVisible();
    // What was saved is what the dialog opens on.
    await expect(
      editing(page).getByRole('switch', { name: 'Use opportunity-level probability' }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(editing(page).getByRole('radio', { name: 'Colored dot' })).toBeChecked();
    await expect(
      editing(page).getByLabel('Probability of New Lead (%)', { exact: true }),
    ).toHaveValue('15');
    await expect(
      editing(page).getByRole('button', { name: 'Show Contacted in the funnel chart' }),
    ).toHaveAttribute('aria-pressed', 'false');
    await editing(page)
      .getByRole('button', { name: 'Stage details for Quoted', exact: true })
      .click();
    await expect(editing(page).getByLabel('Stage description')).toHaveValue('A price was sent');
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page, editing(page));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('pipelines.png'), fullPage: true });
  });
}

for (const size of [
  { width: 1366, height: 650 },
  { width: 360, height: 640 },
]) {
  test(`the footer stays under the stages, never over one, at ${String(size.width)}x${String(size.height)}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page);
    await pipelinesApi(page);
    await page.goto(inHarbor('/deals/pipelines?mode=create'));
    const dialog = creating(page);
    await dialog.getByLabel('Pipeline name').fill('Bookings');
    // More stages than the window shows at once.
    for (const extra of ['Extra 1', 'Extra 2', 'Extra 3']) {
      await dialog.getByRole('button', { name: 'Add stage', exact: true }).click();
      await stageNames(dialog).last().fill(extra);
    }
    await expect(stageNames(dialog)).toHaveCount(7);

    // The body ends where the footer starts, and the footer is whole inside the window.
    const footer = await boxOf(footerOf(dialog));
    const body = await boxOf(bodyOf(dialog));
    expect(body.bottom).toBeLessThanOrEqual(footer.top + 0.5);
    expect(footer.bottom).toBeLessThanOrEqual(size.height + 0.5);
    expect(
      await bodyOf(dialog).evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeInViewport({
      ratio: 1,
    });

    // Scrolled to, the last stage's name and its delete button are whole above the footer.
    const remove = dialog.getByRole('button', { name: 'Remove Extra 3', exact: true });
    await remove.scrollIntoViewIfNeeded();
    await bodyOf(dialog).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const more = await boxOf(dialog.getByRole('button', { name: 'More options', exact: true }));
    expect(more.bottom).toBeLessThanOrEqual(footer.top);
    await remove.scrollIntoViewIfNeeded();
    const removeBox = await boxOf(remove);
    const nameBox = await boxOf(stageNames(dialog).last());
    expect(removeBox.bottom).toBeLessThanOrEqual(footer.top);
    expect(nameBox.bottom).toBeLessThanOrEqual(footer.top);
    expect(removeBox.top).toBeGreaterThanOrEqual(body.top);
    // Nothing lies over it: the press lands on the button.
    await remove.click();
    await expect(stageNames(dialog)).toHaveCount(6);
    await expect(dialog.getByRole('button', { name: 'Remove Extra 3' })).toHaveCount(0);
    await expectNoSidewaysScroll(page, dialog);

    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Pipeline created.', { exact: true })).toBeVisible();
  });
}

for (const width of [360, 1440]) {
  test(`the create dialog, with everything in it opened, has no axe violations at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page);
    await pipelinesApi(page);
    await page.goto(inHarbor('/deals/pipelines?mode=create'));
    const dialog = creating(page);
    await expect(stageNames(dialog)).toHaveCount(4);
    await expectNoViolations(page);
    // The first press in a dialog that has just opened lands where it is aimed: nothing
    // appears and moves the rows as the keyboard leaves the name.
    await expect(dialog.getByLabel('Pipeline name')).toBeFocused();
    const firstRow = await boxOf(dialog.getByRole('listitem').first());
    await dialog.getByRole('button', { name: 'Show New Lead in the funnel chart' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Show New Lead in the funnel chart' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(await boxOf(dialog.getByRole('listitem').first())).toEqual(firstRow);
    if (width === 1440) {
      // As wide as GoHighLevel's, and the four stages show without scrolling.
      const popup = await dialog.boundingBox();
      expect(popup?.width).toBe(750);
      expect(
        await bodyOf(dialog).evaluate((element) => element.scrollHeight <= element.clientHeight),
      ).toBe(true);
      // One row of the table is one stage, about as tall as its controls.
      const first = await boxOf(dialog.getByRole('listitem').first());
      expect(first.bottom - first.top).toBeLessThanOrEqual(48);
      await dialog.getByRole('button', { name: 'About Show in reports', exact: true }).click();
      await expect(dialog.getByText(/^Use the funnel icon to show a stage/)).toBeVisible();
    } else {
      // Below 640px the table has no headings, so no information marks.
      await expect(dialog.getByRole('button', { name: /^About / })).toHaveCount(0);
    }
    await dialog.getByRole('button', { name: 'More options', exact: true }).click();
    await dialog.getByRole('button', { name: 'Stage details for Closed', exact: true }).click();
    await dialog.getByLabel('Probability of Contacted (%)', { exact: true }).fill('101');
    // A name that was typed and emptied is asked for beside its box.
    await dialog.getByLabel('Pipeline name').fill('B');
    await dialog.getByLabel('Pipeline name').fill('');
    await stageNames(dialog).first().fill('');
    await expect(dialog.getByText('Give the pipeline a name.', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Give the stage a name.', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Enter 0 to 100.', { exact: true })).toBeVisible();
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page, dialog);
  });
}

test('drags a stage by its handle to another place', async ({ page }) => {
  await signedIn(page);
  const api = await pipelinesApi(page, [sales]);
  await page.goto(inHarbor(`/deals/pipelines?pipeline=${sales.id}`));
  const dialog = editing(page);
  const from = await dialog.getByRole('button', { name: 'Reorder New', exact: true }).boundingBox();
  const to = await dialog.getByRole('button', { name: 'Reorder Won', exact: true }).boundingBox();
  if (from === null || to === null) throw new Error('The handles are not on screen.');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height + 30, { steps: 12 });
  await page.mouse.up();
  await expect(stageNames(dialog)).toHaveCount(3);
  await expect(stageNames(dialog).nth(2)).toHaveValue('New');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Pipeline saved.', { exact: true })).toBeVisible();
  expect(api.current.items[0]?.stages.map((stage) => stage.name)).toEqual(['Quoted', 'Won', 'New']);
});

test('the address keeps the dialog open over a reload, and Back closes it', async ({ page }) => {
  await signedIn(page);
  await pipelinesApi(page, [sales, events]);
  await page.goto(inHarbor('/deals/pipelines'));
  await page.getByRole('button', { name: 'Create pipeline', exact: true }).click();
  await expect(creating(page)).toBeVisible();
  await page.reload();
  await expect(creating(page)).toBeVisible();
  await page.goBack();
  await expect(creating(page)).toBeHidden();
  await expect(page).toHaveURL(inHarbor('/deals/pipelines'));

  await rowAction(page, 'Events', 'Edit');
  await expect(editing(page).getByLabel('Pipeline name')).toHaveValue('Events');
  await page.reload();
  await expect(editing(page).getByLabel('Pipeline name')).toHaveValue('Events');
  // Closing an unchanged dialog asks nothing, and gives the keyboard back to the page.
  await editing(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editing(page)).toBeHidden();
  await expect(page).toHaveURL(inHarbor('/deals/pipelines'));

  await rowAction(page, 'Sales', 'Edit');
  await page.keyboard.press('Escape');
  await expect(editing(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Actions for Sales', exact: true })).toBeFocused();

  // An address for a pipeline that is not there says so, and opens nothing.
  await page.goto(inHarbor('/deals/pipelines?pipeline=pipe_01h455vb4pex5vsknk084sn02z'));
  await expect(page.getByRole('alert')).toContainText("That pipeline can't be opened.");
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('asks before unsaved changes are lost, by Escape, by Cancel and by Back', async ({ page }) => {
  await signedIn(page);
  const api = await pipelinesApi(page, [sales]);
  await page.goto(inHarbor('/deals/pipelines'));
  await rowAction(page, 'Sales', 'Edit');
  await editing(page).getByLabel('Pipeline name').fill('Sales team');

  await page.keyboard.press('Escape');
  await expect(guard(page)).toBeVisible();
  await expect(guard(page).getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await expectNoViolations(page);
  await page.keyboard.press('Escape');
  await expect(guard(page)).toBeHidden();
  await expect(editing(page).getByLabel('Pipeline name')).toHaveValue('Sales team');

  await editing(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await guard(page).getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editing(page).getByLabel('Pipeline name')).toHaveValue('Sales team');

  await page.goBack();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page).toHaveURL(inHarbor(`/deals/pipelines?pipeline=${sales.id}`));

  await editing(page).getByRole('button', { name: 'Close', exact: true }).click();
  await guard(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(editing(page)).toBeHidden();
  await expect(page).toHaveURL(inHarbor('/deals/pipelines'));
  expect(api.saves).toHaveLength(0);
  // Opened again, it shows what is saved, not the dropped draft.
  await rowAction(page, 'Sales', 'Edit');
  await expect(editing(page).getByLabel('Pipeline name')).toHaveValue('Sales');
});

test('keeps an unsaved edit after a conflict and reloads only when requested', async ({ page }) => {
  await signedIn(page);
  const current = { revision: 'a'.repeat(64), canManage: true, items: [sales] };
  await page.route('**/api/v1/pipelines', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: current })
      : route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'Deal stages changed since you opened this page. Reload before saving.',
          },
        }),
  );
  await page.goto(inHarbor(`/deals/pipelines?pipeline=${sales.id}`));
  const dialog = editing(page);
  await dialog.getByLabel('Pipeline name').fill('My unsaved edit');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Deal stages changed');
  await expect(dialog.getByLabel('Pipeline name')).toHaveValue('My unsaved edit');
  current.items = [{ ...sales, name: 'Sales pipeline' }];
  await dialog.getByRole('button', { name: 'Reload saved version' }).click();
  await expect(dialog.getByLabel('Pipeline name')).toHaveValue('Sales pipeline');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('members can read pipelines and stages but cannot change them', async ({ page }) => {
  await signedIn(page);
  await pipelinesApi(page, [sales], false);
  await page.goto(inHarbor('/deals/pipelines'));
  await expect(rowOf(page, 'Sales')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create pipeline' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for Sales' })).toHaveCount(0);
  await expect(
    page.getByText('Only someone with permission can change pipelines and stages.'),
  ).toBeVisible();
  await rowOf(page, 'Sales').getByRole('button', { name: 'Sales', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sales', exact: true });
  await expect(dialog.getByLabel('Pipeline name')).toBeDisabled();
  await expect(
    dialog.getByRole('switch', { name: 'Use opportunity-level probability' }),
  ).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: 'Colored dot' })).toBeDisabled();
  await expect(dialog.getByLabel('Probability of Quoted (%)', { exact: true })).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Show Quoted in the funnel chart' }),
  ).toBeDisabled();
  // What is kept can still be read: the details button opens for anyone.
  await dialog.getByRole('button', { name: 'Stage details for Quoted', exact: true }).click();
  await expect(dialog.getByLabel('Stage description')).toHaveValue('A price was sent');
  await expect(dialog.getByLabel('Stage description')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add stage' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Reorder/ })).toHaveCount(0);
  // The address of the dialog that creates opens nothing for someone who may not.
  await page.goto(inHarbor('/deals/pipelines?mode=create'));
  await expect(rowOf(page, 'Sales')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a list that did not load says so, and never that there are no pipelines', async ({
  page,
}) => {
  await signedIn(page);
  let failing = true;
  await page.route('**/api/v1/pipelines', (route) =>
    failing
      ? route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Forbidden', status: 403 },
        })
      : route.fulfill({ json: { revision: 'a'.repeat(64), canManage: true, items: [sales] } }),
  );
  await page.goto(inHarbor('/deals/pipelines'));
  await expect(page.getByRole('alert')).toContainText("We couldn't load the pipelines.");
  await expect(page.getByText(/No pipelines/)).toHaveCount(0);
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create pipeline' })).toHaveCount(0);
  await expect(page.getByText(/deals/i)).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(rowOf(page, 'Sales')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the row menu moves, archives and restores, and offers nothing the server lacks', async ({
  page,
}) => {
  await signedIn(page);
  const api = await pipelinesApi(page, [sales, events]);
  await page.goto(inHarbor('/deals/pipelines'));
  await page.getByRole('button', { name: 'Actions for Sales', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveText([
    'Edit',
    'Move down',
    'Move to position',
    'Duplicate',
    'Archive',
    'Delete',
  ]);
  await page.getByRole('menuitem', { name: 'Move down', exact: true }).click();
  await expect(page.getByText('Sales moved to position 2.', { exact: true })).toBeVisible();
  await expect(table(page).getByRole('rowheader')).toHaveText(['Events', 'Sales']);
  // The keyboard stays on the row's button, which moved with its row.
  await expect(page.getByRole('button', { name: 'Actions for Sales', exact: true })).toBeFocused();
  expect(api.current.items.map((item) => item.name)).toEqual(['Events', 'Sales']);

  await rowAction(page, 'Sales', 'Archive');
  const confirm = page.getByRole('dialog', { name: 'Archive Sales?', exact: true });
  await expect(confirm).toContainText('Its opportunities and history stay intact');
  await confirm.getByRole('button', { name: 'Archive pipeline', exact: true }).click();
  await expect(page.getByText('Sales archived.', { exact: true })).toBeVisible();
  await expect(rowOf(page, 'Sales')).toContainText('Archived');
  expect(api.current.items[1]).toMatchObject({ name: 'Sales', archived: true });

  await page.getByRole('button', { name: 'Actions for Sales', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveText([
    'Edit',
    'Move up',
    'Move to position',
    'Duplicate',
    'Restore',
    'Delete',
  ]);
  await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Sales restored.', { exact: true })).toBeVisible();
  expect(api.current.items[1]).toMatchObject({ name: 'Sales', archived: false });

  // The search is over the names, and a row keeps its place in the whole list.
  await page.getByRole('searchbox', { name: 'Search pipelines' }).fill('sal');
  await expect(table(page).getByRole('rowheader')).toHaveText(['Sales']);
  await expect(rowOf(page, 'Sales').getByRole('cell').first()).toHaveText('2');
  await page.getByRole('searchbox', { name: 'Search pipelines' }).fill('zzz');
  await expect(page.getByText('No pipelines match.', { exact: true })).toBeVisible();
});

test('the row menu moves a pipeline to a chosen position, duplicates it and deletes it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  const quotes: Pipeline = { ...events, id: 'pipe_01h455vb4pex5vsknk084sn02s', name: 'Quotes' };
  const api = await pipelinesApi(page, [
    { ...sales, updatedAt: '2026-10-08T12:00:00.000Z' },
    events,
    quotes,
  ]);
  await page.goto(inHarbor('/deals/pipelines'));
  // When the server says when a pipeline last changed, the list shows it.
  await expect(table(page).getByRole('columnheader')).toHaveText([
    '#Position',
    'Pipeline name',
    'Total stages',
    'Updated on',
    'Actions',
  ]);
  await expect(rowOf(page, 'Sales').locator('time')).toHaveAttribute(
    'datetime',
    '2026-10-08T12:00:00.000Z',
  );
  await expect(rowOf(page, 'Events').getByRole('cell').nth(2)).toHaveText('—');

  await rowAction(page, 'Sales', 'Move to position');
  const moving = page.getByRole('dialog', { name: 'Move Sales to a position', exact: true });
  await expect(moving).toContainText('It is at position 1 of 3.');
  const position = moving.getByLabel('Position', { exact: true });
  await expect(position).toHaveValue('1');
  // Its own place, and a place the list does not have, move nothing.
  await expect(moving.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
  await position.fill('4');
  await expect(moving.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
  await position.fill('3');
  await expectNoViolations(page);
  await moving.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(moving).toBeHidden();
  await expect(page.getByText('Sales moved to position 3.', { exact: true })).toBeVisible();
  await expect(table(page).getByRole('rowheader')).toHaveText(['Events', 'Quotes', 'Sales']);
  await expect(page.getByRole('button', { name: 'Actions for Sales', exact: true })).toBeFocused();
  expect(api.commands.at(-1)).toEqual({
    method: 'POST',
    path: `/pipelines/${sales.id}/move`,
    body: { position: 3, revision: 'a'.repeat(64) },
  });
  // Nothing was saved as a whole list: the one pipeline was moved.
  expect(api.saves).toHaveLength(0);

  await rowAction(page, 'Events', 'Duplicate');
  await expect(
    page.getByText('Events duplicated as Events (copy).', { exact: true }),
  ).toBeVisible();
  await expect(table(page).getByRole('rowheader')).toHaveText([
    'Events',
    'Events (copy)',
    'Quotes',
    'Sales',
  ]);
  expect(api.commands.at(-1)).toMatchObject({
    method: 'POST',
    path: `/pipelines/${events.id}/duplicate`,
    body: { revision: '6'.repeat(64) },
  });

  // A pipeline that holds opportunities is not deleted: the dialog says what to do instead.
  api.holding.add(sales.id);
  await rowAction(page, 'Sales', 'Delete');
  const deleting = page.getByRole('dialog', { name: 'Delete Sales?', exact: true });
  await expect(deleting).toContainText('Only a pipeline that holds no opportunity');
  await expectNoViolations(page);
  await deleting.getByRole('button', { name: 'Delete pipeline', exact: true }).click();
  await expect(deleting.getByRole('alert')).toContainText(
    'or that an opportunity ever passed through',
  );
  await deleting.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(table(page).getByRole('rowheader')).toHaveCount(4);

  await rowAction(page, 'Quotes', 'Delete');
  await page
    .getByRole('dialog', { name: 'Delete Quotes?', exact: true })
    .getByRole('button', { name: 'Delete pipeline', exact: true })
    .click();
  await expect(page.getByText('Quotes deleted.', { exact: true })).toBeVisible();
  await expect(table(page).getByRole('rowheader')).toHaveText(['Events', 'Events (copy)', 'Sales']);
  expect(api.commands.at(-1)).toMatchObject({
    method: 'DELETE',
    path: `/pipelines/${quotes.id}`,
  });
  await expectNoViolations(page);
});

test('a change someone else got in first is refused, and the list reloads on request', async ({
  page,
}) => {
  await signedIn(page);
  let current: PipelineConfiguration = {
    revision: 'a'.repeat(64),
    canManage: true,
    items: [sales, events],
  };
  await page.route('**/api/v1/pipelines', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: current })
      : route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Conflict', status: 409 },
        }),
  );
  await page.goto(inHarbor('/deals/pipelines'));
  await rowAction(page, 'Sales', 'Move down');
  await expect(page.getByRole('alert')).toContainText('Someone else changed the pipelines.');
  await expect(table(page).getByRole('rowheader')).toHaveText(['Sales', 'Events']);
  current = { ...current, revision: 'b'.repeat(64), items: [events, sales] };
  await page.getByRole('button', { name: 'Reload pipelines', exact: true }).click();
  await expect(table(page).getByRole('rowheader')).toHaveText(['Events', 'Sales']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test.describe('from Opportunities and from Settings', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('both entry points show the same list, under a Pipelines tab', async ({ page }) => {
    await signedIn(page);
    await pipelinesApi(page, [sales, events]);
    const bar = page.getByRole('region', { name: 'Top bar', exact: true });

    await page.goto(inHarbor('/deals/pipelines'));
    await expect(page.getByRole('heading', { level: 1, name: 'Pipelines' })).toBeVisible();
    const opportunityTabs = bar.getByRole('navigation', { name: 'Opportunities', exact: true });
    await expect(opportunityTabs.getByRole('link')).toHaveText([
      'Opportunities',
      'Pipelines',
      'Bulk Actions',
    ]);
    await expect(opportunityTabs.getByRole('link', { name: 'Pipelines' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(opportunityTabs.getByRole('link', { name: 'Opportunities' })).not.toHaveAttribute(
      'aria-current',
    );
    await expect(table(page).getByRole('rowheader')).toHaveText(['Sales', 'Events']);
    // The card reaches the 16px gutter at the right of a wide window.
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'Pipelines', exact: true })),
    ).toBe(true);
    // The dialog has its own address.
    await page.getByRole('button', { name: 'Create pipeline', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/deals/pipelines?mode=create'));
    await expect(creating(page)).toBeVisible();
    await creating(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/deals/pipelines'));
    await expectNoViolations(page);

    // The page is here only: an old Settings address lands on this tab, with what it had open.
    await page.goto(inHarbor('/settings/deal-stages?mode=create'));
    await expect(page).toHaveURL(inHarbor('/deals/pipelines?mode=create'));
    await expect(creating(page)).toBeVisible();
    await creating(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    // The inline editor is gone.
    await expect(page.getByRole('button', { name: 'New pipeline' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  });
});

for (const width of [360, 1440]) {
  test(`a stage takes a color from the design tokens, and the pipeline its place in the charts, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page);
    const colored: Pipeline = {
      ...sales,
      colorStyle: 'dot',
      showInFunnel: true,
      showInPie: true,
      stages: [
        { id: stageIdOf(1), name: 'New', description: '', archived: false, color: '#12b76a' },
        { id: stageIdOf(2), name: 'Quoted', description: '', archived: false, color: null },
      ],
    };
    const api = await pipelinesApi(page, [colored, events]);
    await page.goto(inHarbor(`/deals/pipelines?pipeline=${sales.id}`));
    const dialog = editing(page);
    const swatchOf = (stage: string) =>
      dialog
        .getByRole('button', { name: `Color of ${stage}`, exact: true })
        .locator('[data-slot="stage-color"]');
    // Each row shows its stage's color; the choices stay closed until asked for.
    await expect(swatchOf('New')).toHaveCSS('background-color', 'rgb(18, 183, 106)');
    await expect(dialog.getByRole('group', { name: /^Color of/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Color of Quoted', exact: true }).click();
    const colors = dialog.getByRole('group', { name: 'Color of Quoted', exact: true });
    await expect(colors.getByRole('button')).toHaveText([
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'No color',
    ]);
    await expect(colors.getByRole('button', { name: 'No color', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (const swatch of await colors.getByRole('button').all())
      expect((await swatch.boundingBox())?.height).toBeGreaterThanOrEqual(width < 1024 ? 44 : 32);
    // The choices open under the stage's own controls, inside its row.
    const row = await boxOf(dialog.getByRole('listitem').nth(1));
    const choices = await boxOf(colors);
    expect(choices.top).toBeGreaterThan(
      (await boxOf(dialog.getByRole('button', { name: 'Color of Quoted', exact: true }))).bottom -
        1,
    );
    expect(choices.bottom).toBeLessThanOrEqual(row.bottom);
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page, dialog);
    // The red of the design system, saved as the value the page gives the token.
    await colors.getByRole('button', { name: 'Red', exact: true }).click();
    await expect(colors.getByRole('button', { name: 'Red', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(swatchOf('Quoted')).toHaveCSS('background-color', 'rgb(180, 35, 24)');
    await dialog.getByRole('button', { name: 'Color of New', exact: true }).click();
    await dialog
      .getByRole('group', { name: 'Color of New', exact: true })
      .getByRole('button', { name: 'No color', exact: true })
      .click();

    // Whether the pipeline itself is in the two charts is with the other extras.
    await dialog.getByRole('button', { name: 'More options', exact: true }).click();
    const funnel = dialog.getByRole('switch', { name: 'Visible in funnel chart', exact: true });
    const pie = dialog.getByRole('switch', {
      name: 'Visible in stage distribution chart',
      exact: true,
    });
    await expect(funnel).toHaveAttribute('aria-checked', 'true');
    await funnel.click();
    await expect(funnel).toHaveAttribute('aria-checked', 'false');
    await expect(pie).toHaveAttribute('aria-checked', 'true');
    expect((await funnel.boundingBox())?.height).toBeGreaterThanOrEqual(width < 1024 ? 44 : 36);
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page, dialog);

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Pipeline saved.', { exact: true })).toBeVisible();
    expect(api.saves).toHaveLength(1);
    const [saved] = api.saves as { items: Record<string, unknown>[] }[];
    expect(saved?.items[0]).toEqual({
      id: sales.id,
      name: 'Sales',
      description: '',
      archived: false,
      dealProbability: false,
      colorStyle: 'dot',
      showInFunnel: false,
      showInPie: true,
      stages: [
        {
          id: stageIdOf(1),
          name: 'New',
          description: '',
          archived: false,
          probability: null,
          color: null,
          showInFunnel: true,
          showInPie: true,
        },
        {
          id: stageIdOf(2),
          name: 'Quoted',
          description: '',
          archived: false,
          probability: null,
          color: '#b42318',
          showInFunnel: true,
          showInPie: true,
        },
      ],
    });
    // A pipeline the dialog did not open is sent back without its settings.
    expect(saved?.items[1]).not.toHaveProperty('showInFunnel');
    expect(saved?.items[1]).not.toHaveProperty('colorStyle');

    // Where the pipeline draws no colors, a row has none to choose.
    await page.getByRole('button', { name: 'Sales', exact: true }).click();
    await expect(swatchOf('Quoted')).toHaveCSS('background-color', 'rgb(180, 35, 24)');
    await editing(page).getByRole('radio', { name: 'Default (no color)' }).check();
    await expect(editing(page).getByRole('button', { name: /^Color of/ })).toHaveCount(0);
  });
}
