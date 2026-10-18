// Where a lead came from, in the workflow builder: a trigger that starts only for the lead
// sources ticked, an If / else on this lead's arrival built with the keyboard alone, the
// three groups of attribution fields in the lists, an opportunity whose source is how the
// lead arrived, and "Start from a recipe". The API is stood in for by the in-memory one in
// automation-api.ts.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  createAutomationInput,
  ensureLeadSourceTagsInput,
  leadSourceLabels,
  leadSourceRecipeTags,
  replaceAutomationDraftInput,
  validateAutomation,
} from '@repo/contracts';
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
import { harborSetup } from './automation-fixtures';
import { choose } from './select';
import { inHarbor, signedIn } from './session';

// Kept where the owner can open them after the run: reports/ is not cleared between runs.
const shots = path.join(import.meta.dirname, '..', 'reports', 'lead-source-workflows');
mkdirSync(shots, { recursive: true });
const shot = (name: string): string => path.join(shots, name);

const canvas = (page: Page): Locator => page.getByTestId('automation-canvas');

const lastSaved = (state: World): Record<string, unknown> => {
  const save = state.writes.findLast((write) => write.method === 'PUT');
  return replaceAutomationDraftInput.parse(save?.body).document;
};

async function scrolledToEnd(panel: Locator): Promise<void> {
  await panel.evaluate((element) => {
    element.scrollTo(0, element.scrollHeight);
  });
}

const FORM_CARD = 'Someone submits “Request a quote”';

for (const width of [360, 1440])
  test.describe(`lead source in the builder at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test('starts a trigger only for the lead sources ticked, and says so on its card', async ({
      page,
    }) => {
      const state = world();
      await openBuilder(page, state, 'canvas');
      await page.getByRole('button', { name: `Edit: ${FORM_CARD}`, exact: true }).click();
      const panel = page.getByRole('dialog', { name: 'Form submitted', exact: true });
      // The panel opens with no source on it: a source filter is added from the menu, and
      // is chips with a list that is searched.
      const filters = panel.getByRole('group', { name: 'Filters', exact: true });
      await expect(panel.getByRole('checkbox')).toHaveCount(0);
      await filters.getByRole('button', { name: 'Add filters', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Lead source', exact: true }).click();
      const sources = filters.locator('[data-setting="sources"]');
      await sources.getByRole('button', { name: /^Lead source is any of: / }).click();
      await page.getByRole('option', { name: 'Google Ads', exact: true }).click();
      await page.getByRole('option', { name: 'Facebook Ads', exact: true }).click();
      // One of the business's own names, such as one it puts in source= on a flyer's link.
      await page.getByRole('combobox', { name: 'Search or type a lead source' }).fill('Flyer');
      await page.getByRole('option', { name: 'Add “Flyer”', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(
        sources
          .getByRole('list', { name: 'Lead source is any of', exact: true })
          .getByRole('listitem'),
      ).toHaveText(['Google Ads', 'Facebook Ads', 'Flyer']);
      await filters.getByRole('button', { name: 'Add filters', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Session source', exact: true }).click();
      const sessions = filters.locator('[data-setting="sessionSources"]');
      await sessions.getByRole('button', { name: /^Session source is any of: / }).click();
      await page.getByRole('option', { name: 'Paid Search', exact: true }).click();
      await page.keyboard.press('Escape');
      await scrolledToEnd(panel);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`trigger-lead-sources-${String(width)}.png`) });

      await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(
        page.getByRole('group', {
          name: `Trigger: ${FORM_CARD}, from Google Ads, Facebook Ads, or Flyer, through Paid Search`,
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect(lastSaved(state)['triggers']).toEqual([
        {
          id: 'quote_form',
          type: 'form.submitted',
          config: {
            form: 'Request a quote',
            sources: ['Google Ads', 'Facebook Ads', 'Flyer'],
            sessionSources: ['paid_search'],
          },
        },
      ]);
    });

    test('branches on the lead source, lists the three groups of fields, and gives the opportunity its source', async ({
      page,
    }) => {
      const state = world();
      await openBuilder(page, state, 'canvas');
      await page
        .getByRole('button', { name: 'Edit: If services includes “video”', exact: true })
        .click();
      const condition = page.getByRole('dialog', { name: 'If / else', exact: true });
      const field = condition.getByRole('combobox', { name: 'Field of condition 1', exact: true });
      // The list has the three groups, each under its heading, after the opportunity's.
      await field.click();
      const list = page.getByRole('listbox');
      for (const heading of ["This lead's arrival", 'Attribution (first)', 'Attribution (latest)'])
        await expect(list.getByRole('option', { name: heading, exact: true })).toBeDisabled();
      await expect(list.getByRole('option', { name: 'Lead source', exact: true })).toBeVisible();
      await expect(
        list.getByRole('option', { name: 'Lead source (first)', exact: true }),
      ).toBeVisible();
      await expect(
        list.getByRole('option', { name: 'Has a Google click ID (latest)', exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: shot(`condition-field-list-${String(width)}.png`) });
      await page.keyboard.press('Escape');
      await choose(field, 'trigger.attribution.source');
      await choose(
        condition.getByRole('combobox', { name: 'Comparison of condition 1', exact: true }),
        'equals',
      );
      // The built-in names are offered while typing; any other text can be typed.
      const value = condition.getByRole('combobox', { name: 'Value of condition 1', exact: true });
      await expect(value).toHaveAttribute('list', /.+/);
      await expect(condition.locator('datalist option[value="Google Ads"]')).toHaveCount(1);
      await value.fill('Google Ads');
      await scrolledToEnd(condition);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`condition-lead-source-${String(width)}.png`) });
      await condition.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(condition).toBeHidden();
      await expect(step(page, 'asked_about_video')).toContainText('If lead source is “Google Ads”');

      // A new opportunity takes its source from how the lead arrived, unless told otherwise.
      await page
        .getByRole('button', {
          name: 'Add an action after: Text them “Last check-in from Harbor Lights.”',
          exact: true,
        })
        .click();
      const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
      await actions.getByRole('button', { name: /^Create opportunity/ }).click();
      const create = page.getByRole('dialog', { name: 'Create opportunity', exact: true });
      await choose(create.getByRole('combobox', { name: /^Pipeline/ }), 'pip_sales');
      await choose(create.getByRole('combobox', { name: /^Stage/ }), 'stg_new');
      const source = create.getByRole('combobox', { name: /^Opportunity source/ });
      await expect(source).toHaveValue('arrival');
      await expect(source.locator('option')).toHaveText([
        'From how they arrived (recommended)',
        'Text I write',
        'No source',
      ]);
      await source.selectOption('text');
      await create
        .getByRole('textbox', { name: 'Opportunity source, the text', exact: true })
        .fill('Ad: ');
      const insert = create.getByRole('combobox', {
        name: 'Insert a field into: Opportunity source, the text',
        exact: true,
      });
      // The seven there were, and what a submission of the form that starts this workflow
      // holds (its page; this form's questions are not in the fixture).
      await expect(insert.locator('optgroup')).toHaveCount(8);
      await expect(insert.locator('optgroup[label="Form answers"] option')).toHaveText([
        'Page the form was sent from',
      ]);
      await expect(
        insert.locator('optgroup[label="This lead\'s arrival"] option').first(),
      ).toHaveText('Lead source');
      await insert.selectOption('trigger.attribution.utmCampaign');
      await expect(
        create.getByRole('textbox', { name: 'Opportunity source, the text', exact: true }),
      ).toHaveValue('Ad: {{trigger.attribution.utmCampaign}}');
      await source.selectOption('arrival');
      await scrolledToEnd(create);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`create-opportunity-source-${String(width)}.png`) });
      await create.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(create).toBeHidden();
      await expect(step(page, 'deal_create')).toContainText(
        'Create an opportunity in Sales, at New lead. Source: from how they arrived',
      );
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      const saved = lastSaved(state);
      expect(saved['steps']).toMatchObject({
        asked_about_video: {
          config: {
            if: { field: 'trigger.attribution.source', operator: 'equals', value: 'Google Ads' },
          },
        },
        deal_create: {
          type: 'deal.create',
          config: { pipeline: 'pip_sales', stage: 'stg_new', source: { from: 'arrival' } },
        },
      });
      expect(validateAutomation(saved, harborSetup).errors).toEqual([]);
      await page.screenshot({
        path: shot(`canvas-lead-source-${String(width)}.png`),
        fullPage: true,
      });
    });

    test('starts a valid draft from the recipe, with the tags forms add for its sources', async ({
      page,
    }) => {
      const state = world({ automations: [] });
      const asked: string[][] = [];
      const createdByName: string[] = [];
      await signedIn(page);
      await automationsApi(page, state);
      // The recipe never makes a tag by name.
      await page.route('**/api/v1/tags', async (route) => {
        if (route.request().method() === 'POST')
          createdByName.push(route.request().postData() ?? '');
        await route.fallback();
      });
      // It asks for the tags of its lead sources by key. A person renamed the first one: it
      // is still the tag of that source, and the draft names it by id.
      await page.route('**/api/v1/lead-sources/tags', async (route) => {
        const { sources } = ensureLeadSourceTagsInput.parse(route.request().postDataJSON());
        asked.push(sources);
        const items = sources.map((source, index) => ({
          source,
          label: leadSourceLabels[source],
          tag: {
            id: `tag_01k8e2wzr0e00800000000009${String(index)}`,
            name: index === 0 ? 'Paid Google' : `Source: ${leadSourceLabels[source]}`,
            description: 'Added by forms to the leads that arrived this way.',
            createdAt: '2026-10-13T09:00:00.000Z',
            updatedAt: '2026-10-13T09:00:00.000Z',
          },
        }));
        // The business has the tags from here on, as the catalog then says.
        state.setup = {
          ...state.setup,
          tags: [...state.setup.tags, ...items.map((item) => item.tag)],
        };
        await route.fulfill({ status: 200, json: { items } });
      });
      await page.goto(inHarbor('/automations'));
      await page.getByRole('button', { name: 'Start from a recipe', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Start from a recipe', exact: true });
      // The recipes are listed first; the keyboard is on the first of them.
      const pick = dialog.getByRole('button', {
        name: 'Tag and route leads by source',
        exact: true,
      });
      await expect(pick).toBeFocused();
      await pick.click();
      await expect(
        dialog.getByRole('heading', { name: 'Tag and route leads by source', exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole('listitem')).toHaveText([
        'Starts when any form is submitted.',
        'Takes a branch for each of Google Ads, Facebook Ads, Instagram Ads, Organic Search, and one for everything else.',
        'Adds the tag of that source, such as “Source: Google Ads”: the same tag your forms add. Everything else gets no tag here.',
        'Gives the lead an owner, unless you leave that out.',
        'Opens an opportunity whose source is how the lead arrived.',
      ]);
      await expect(dialog).toContainText(
        `It adds the tags your forms add for these sources (${leadSourceRecipeTags().join(', ')}). One that isn't here yet is made first, in the “Lead source” tag group; no second copy is ever made.`,
      );
      const pipeline = dialog.getByRole('combobox', {
        name: 'Pipeline for the new opportunities',
        exact: true,
      });
      await expect(pipeline).toBeFocused();
      await expect(pipeline).toHaveValue('pip_sales');
      await expect(dialog.getByRole('combobox', { name: /^Who new leads go to/ })).toHaveValue(
        'usr_dana',
      );
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`recipe-dialog-${String(width)}.png`) });

      await dialog.getByRole('button', { name: 'Create the draft', exact: true }).click();
      await expect(page).toHaveURL(builderAt());
      expect(asked).toEqual([['google_ads', 'facebook_ads', 'instagram_ads', 'organic_search']]);
      expect(createdByName).toEqual([]);
      const created = state.writes.find((write) => write.method === 'POST' && write.path === '');
      const { document } = createAutomationInput.parse(created?.body);
      // The renamed tag by its id; and everything else adds no tag ("Source: Other" is gone).
      const steps = document['steps'] as Record<string, { config?: unknown }>;
      expect(steps['tag_google_ads']?.config).toEqual({ tag: 'tag_01k8e2wzr0e008000000000090' });
      expect(Object.keys(steps)).not.toContain('tag_other');
      // Valid in this business as it now is: nothing for the person to fix before publishing.
      const checked = validateAutomation(document, state.setup);
      expect(checked.errors).toEqual([]);
      expect(checked.warnings).toEqual([]);
      await expect(canvas(page)).toBeVisible();
      await expect(
        page.getByRole('group', { name: 'Trigger: Someone submits a form', exact: true }),
      ).toBeVisible();
      // Each card is named for what it is for; its panel holds the tag, the owner and the source.
      await expect(step(page, 'tag_google_ads')).toContainText('Tag: Google Ads');
      await expect(step(page, 'assign_owner')).toContainText('Give the lead an owner');
      await expect(step(page, 'create_opportunity')).toContainText('Open an opportunity');
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`recipe-draft-${String(width)}.png`), fullPage: true });
    });
  });

test('builds a branch on the lead source with the keyboard alone', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = world();
  await openBuilder(page, state, 'canvas');
  const tabTo = async (target: Locator): Promise<void> => {
    for (let presses = 0; presses < 160; presses += 1) {
      if (await target.evaluate((element) => element === document.activeElement)) return;
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
  };
  // A themed list: opened with Enter, a choice found by typing its name, taken with Enter.
  const pick = async (list: Locator, name: string): Promise<void> => {
    await tabTo(list);
    await page.keyboard.press('Enter');
    const options = page.getByRole('listbox');
    await expect(options).toBeVisible();
    await expect(options.getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.type(name);
    await expect(options.getByRole('option', { name, exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(options).toBeHidden();
  };

  await tabTo(
    page.getByRole('button', { name: 'Edit: If services includes “video”', exact: true }),
  );
  await page.keyboard.press('Enter');
  const condition = page.getByRole('dialog', { name: 'If / else', exact: true });
  await tabTo(condition.getByRole('button', { name: 'Use branches I name', exact: true }));
  await page.keyboard.press('Enter');
  const branches = [
    [1, 'Google Ads'],
    [2, 'Facebook Ads'],
  ] as const;
  for (const [number, source] of branches) {
    if (number > 1) {
      await tabTo(condition.getByRole('button', { name: 'Add branch', exact: true }));
      await page.keyboard.press('Enter');
    }
    const branch = condition.getByRole('group', {
      name: new RegExp(`^Branch ${String(number)}: `),
    });
    const name = branch.getByRole('textbox', {
      name: `Name of branch ${String(number)}`,
      exact: true,
    });
    await tabTo(name);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(source);
    // "Lead source" alone is this lead's arrival: the contact's own two say which they are.
    await pick(
      branch.getByRole('combobox', { name: 'Field of condition 1', exact: true }),
      'Lead source',
    );
    // "Is" is the first comparison of a text field: Home goes to it, whatever was chosen.
    const comparison = branch.getByRole('combobox', {
      name: 'Comparison of condition 1',
      exact: true,
    });
    await tabTo(comparison);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('listbox').getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(
      page.getByRole('listbox').getByRole('option', { name: 'Is', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(comparison).toHaveText('Is');
    const value = branch.getByRole('combobox', { name: 'Value of condition 1', exact: true });
    await tabTo(value);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(source);
  }
  await tabTo(condition.getByRole('button', { name: 'Save action', exact: true }));
  await page.keyboard.press('Enter');
  await expect(condition).toBeHidden();
  // The page behind the panel is hidden from a screen reader until the panel has gone.
  await expect(page.getByRole('link', { name: 'Skip to content', exact: true })).toBeAttached();
  await expectNoViolations(page);
  await page.screenshot({ path: shot('keyboard-branches-1440.png'), fullPage: true });

  await tabTo(page.getByRole('button', { name: 'Save', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  const saved = lastSaved(state);
  expect(saved['steps']).toMatchObject({
    asked_about_video: {
      config: {
        branches: [
          {
            label: 'Google Ads',
            if: { field: 'trigger.attribution.source', operator: 'equals', value: 'Google Ads' },
          },
          {
            label: 'Facebook Ads',
            if: { field: 'trigger.attribution.source', operator: 'equals', value: 'Facebook Ads' },
          },
        ],
      },
    },
  });
  expect(validateAutomation(saved, harborSetup).errors).toEqual([]);
});
