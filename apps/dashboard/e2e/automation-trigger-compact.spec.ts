// The compact trigger editor: a "Form submitted" trigger opens on its form and its filters
// only, never on every lead source and session source; a source filter is added from the
// menu as chips with a list that is searched; an answer of the form is a filter of its own
// kind ("Service interest is DJ"); and a form that is still a draft is named as a draft,
// not as "not found". The API is stood in for by the in-memory one in automation-api.ts.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { replaceAutomationDraftInput, type FormSummary } from '@repo/contracts';
import {
  expectNoSidewaysScroll,
  expectNoViolations,
  openBuilder,
  world,
  type World,
} from './automation-api';
import { automationOf, followUp, harborSetup } from './automation-fixtures';

// Kept where the owner can open them after the run: reports/ is not cleared between runs.
const shots = path.join(import.meta.dirname, '..', 'reports', 'email-step');
mkdirSync(shots, { recursive: true });
const shot = (name: string): string => path.join(shots, name);

const enquiry = 'form_01h455vb4pex5vsknk084sn02q';
const weddingDraft = 'form_01h455vb4pex5vsknk084sn02r';
const setup = {
  ...harborSetup,
  forms: [
    {
      id: enquiry,
      name: 'Event enquiry',
      questions: [
        {
          key: 'service_interest',
          label: 'Service interest',
          type: 'single_choice' as const,
          options: [
            { key: 'dj', label: 'DJ' },
            { key: 'photo', label: 'Photo booth' },
          ],
        },
        { key: 'guests', label: 'Guests', type: 'number' as const, options: [] },
      ],
    },
  ],
};
const summary = (id: string, name: string, status: FormSummary['status']): FormSummary => ({
  id,
  name,
  status,
  hasUnpublishedChanges: false,
  submissionCount: 0,
  lastSubmissionAt: null,
  updatedAt: '2026-10-13T09:00:00.000Z',
});

const withTrigger = (config: Record<string, unknown>): World =>
  world({
    setup,
    automations: [
      automationOf({
        draft: { ...followUp, triggers: [{ id: 'enquiry_form', type: 'form.submitted', config }] },
      }),
    ],
  });

/** The business's forms, as its own list has them: the published one, and a draft. */
async function formsApi(page: Page): Promise<void> {
  await page.route('**/api/v1/forms?**', (route) => {
    const archived = new URL(route.request().url()).searchParams.get('archived') === 'true';
    return route.fulfill({
      json: {
        canManage: true,
        nextCursor: null,
        items: archived
          ? []
          : [
              summary(enquiry, 'Event enquiry', 'published'),
              summary(weddingDraft, 'Wedding demo', 'draft'),
            ],
      },
    });
  });
}

const triggerPanel = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Form submitted', exact: true });
const savedTriggers = (state: World): unknown => {
  const save = state.writes.findLast((write) => write.method === 'PUT');
  return replaceAutomationDraftInput.parse(save?.body).document['triggers'];
};

for (const width of [360, 1440])
  test.describe(`the compact trigger editor at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 1000 } });
    test.describe.configure({ timeout: 90_000 });

    test('opens on the form alone, and filters on an answer and a lead source from the menu', async ({
      page,
    }) => {
      const state = withTrigger({ form: enquiry });
      await formsApi(page);
      await openBuilder(page, state, 'canvas');
      await page
        .getByRole('button', { name: 'Edit: Someone submits “Event enquiry”', exact: true })
        .click();
      const panel = triggerPanel(page);
      await expect(panel.getByRole('button', { name: 'Form: Event enquiry' })).toBeVisible();
      const filters = panel.getByRole('group', { name: 'Filters', exact: true });
      await expect(filters).toContainText('No filters applied');
      // Not one source is on the panel until a source filter is added.
      await expect(panel.getByRole('checkbox')).toHaveCount(0);
      await expect(panel.getByText('Google Ads')).toHaveCount(0);
      await expect(panel.getByText('Paid Search')).toHaveCount(0);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`trigger-compact-${String(width)}.png`) });

      // An answer of the form, typed by its question, with the keyboard.
      const add = filters.getByRole('button', { name: 'Add filters', exact: true });
      await add.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem')).toHaveText([
        'Lead source',
        'Session source',
        'An answer on the form',
        'Another field',
      ]);
      await page.getByRole('menuitem', { name: 'An answer on the form', exact: true }).click();
      const field = filters.getByRole('combobox', { name: 'Field of filter 1', exact: true });
      await expect(field).toHaveText('Service interest');
      await expect(field).toBeFocused();
      await filters.getByRole('combobox', { name: 'Value of filter 1', exact: true }).click();
      await page.getByRole('option', { name: 'DJ', exact: true }).click();

      // A lead source: chips, and a list that is searched.
      await add.click();
      await page.getByRole('menuitem', { name: 'Lead source', exact: true }).click();
      const sources = filters.getByRole('list', { name: 'Source filters', exact: true });
      const choose = sources.getByRole('button', { name: /^Lead source is any of: / });
      await expect(choose).toBeFocused();
      await page.keyboard.press('Enter');
      await page.getByRole('combobox', { name: 'Search or type a lead source' }).fill('goo');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await expect(
        sources
          .getByRole('list', { name: 'Lead source is any of', exact: true })
          .getByRole('listitem'),
      ).toHaveText(['Google Ads']);
      await panel.evaluate((element) => {
        element.scrollTo(0, element.scrollHeight);
      });
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`trigger-filters-${String(width)}.png`) });

      await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(panel).toBeHidden();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect(savedTriggers(state)).toEqual([
        {
          id: 'enquiry_form',
          type: 'form.submitted',
          config: { form: enquiry, sources: ['Google Ads'] },
          if: { field: 'trigger.answers.service_interest', operator: 'equals', value: 'dj' },
        },
      ]);
    });

    test('keeps a stored source filter, and names a draft form as a draft', async ({ page }) => {
      const stored = { form: weddingDraft, sources: ['Google Ads', 'Billboard'] };
      const state = withTrigger(stored);
      await formsApi(page);
      await openBuilder(page, state, 'canvas');
      await page
        .getByRole('group', { name: /^Trigger: / })
        .getByRole('button', { name: /^Edit: / })
        .click();
      const panel = triggerPanel(page);
      await expect(panel.getByRole('button', { name: 'Form: Wedding demo' })).toBeVisible();
      await expect(
        panel.getByText('This form is a draft. Publish it to receive submissions.'),
      ).toBeVisible();
      await expect(panel.getByText(/not found/)).toHaveCount(0);
      // The stored filter is in sight, as chips: collapsing nothing made it unrestricted.
      await expect(
        panel
          .getByRole('list', { name: 'Lead source is any of', exact: true })
          .getByRole('listitem'),
      ).toHaveText(['Google Ads', 'Billboard']);
      // The list of forms offers the draft with its mark.
      await panel.getByRole('button', { name: 'Form: Wedding demo' }).click();
      await expect(
        page.getByRole('listbox', { name: 'Form', exact: true }).getByRole('option'),
      ).toHaveText(['Any form', 'Event enquiry', /^Wedding demo\s*Draft$/]);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`trigger-draft-form-${String(width)}.png`) });
      await page.keyboard.press('Escape');

      // Saved as it was opened, the trigger is as it was: nothing of the filter is lost, and
      // the workflow has nothing new to save.
      await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      // One source taken off, and only that one goes.
      await page
        .getByRole('group', { name: /^Trigger: / })
        .getByRole('button', { name: /^Edit: / })
        .click();
      await panel
        .getByRole('list', { name: 'Lead source is any of', exact: true })
        .getByRole('button', { name: 'Remove Billboard' })
        .click();
      await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(panel).toBeHidden();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      // A draft form can be worked with; publishing waits for the form to be published.
      await expect(
        page.getByText('Draft saved. It has problems to fix before it can be published.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(savedTriggers(state)).toEqual([
        {
          id: 'enquiry_form',
          type: 'form.submitted',
          config: { form: weddingDraft, sources: ['Google Ads'] },
        },
      ]);
    });
  });
