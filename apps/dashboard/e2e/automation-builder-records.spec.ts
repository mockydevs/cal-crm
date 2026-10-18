// The record steps as forms instead of JSON, and what a person does about a run: Assign
// owner in turn, Update contact with a copied field and "now", Find opportunity with its
// two branches on the canvas, Update opportunity, "Continue now" on a wait for a reply, and
// "Why didn't this run?" for one contact.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { continueAutomationRunInput, replaceAutomationDraftInput } from '@repo/contracts';
import {
  automationsApi,
  builderAt,
  expectNoSidewaysScroll,
  expectNoViolations,
  runsApi,
  step,
  world,
  type World,
} from './automation-api';
import {
  automationId,
  automationOf,
  contactIds,
  followUp,
  recordSetup,
  runIds,
  runSummaryOf,
  stamp,
  welcome,
} from './automation-fixtures';
import { emptyContactPanels } from './contact-panels';
import { inHarbor, signedIn } from './session';

// Kept where the owner can open them after the run: reports/ is not cleared between runs.
const shots = path.join(import.meta.dirname, '..', 'reports', 'builder-ui-2');
mkdirSync(shots, { recursive: true });
const shot = (name: string): string => path.join(shots, name);

const canvas = (page: Page): Locator => page.getByTestId('automation-canvas');

async function openCanvas(page: Page, state: World): Promise<void> {
  await signedIn(page);
  await automationsApi(page, state);
  await runsApi(page, state);
  await page.goto(builderAt('canvas'));
  await expect(canvas(page)).toBeVisible();
}

const withWelcome = (): World =>
  world({
    setup: recordSetup,
    automations: [automationOf({ draft: welcome, name: welcome.name })],
  });

/** Opens the Actions panel after the workflow's one action, and chooses an action. */
async function addAction(page: Page, action: RegExp, title: string): Promise<Locator> {
  await page.getByRole('button', { name: /^Add an action after: Add the tag VIP/ }).click();
  const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
  await actions.getByRole('button', { name: action }).click();
  const panel = page.getByRole('dialog', { name: title, exact: true });
  await expect(panel.getByRole('button', { name: 'Save action', exact: true })).toBeVisible();
  return panel;
}

/**
 * Scrolls a panel to its end, so nothing of the form is half under the bar that keeps Save
 * in sight: a control cut by it is too small to press until the panel is scrolled.
 */
async function scrolledToEnd(panel: Locator): Promise<void> {
  await panel.evaluate((element) => {
    element.scrollTo(0, element.scrollHeight);
  });
}

async function savedDocument(page: Page, state: World): Promise<Record<string, unknown>> {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  const save = state.writes.findLast((write) => write.method === 'PUT');
  return replaceAutomationDraftInput.parse(save?.body).document;
}

/** A run that waits for a reply: a person may end the wait down either branch. */
const waitingRun = {
  ...runSummaryOf('jordan', 'Jordan Lee', {
    status: 'waiting',
    currentStep: 'wait_for_reply',
    currentAction: { step: 'wait_for_reply', type: 'wait.event', label: null },
    wakeAt: '2026-10-09T12:15:00.000Z',
    startedAt: '2026-10-07T12:15:00.000Z',
    revision: 'rev-1',
    continuable: { branches: ['received', 'timed_out'] },
  }),
  steps: [
    {
      step: 'wait_for_reply',
      type: 'wait.event',
      status: 'waiting',
      input: { config: { event: 'message.received', from: 'contact', timeout: 'P2D' } },
      output: { wakeAt: '2026-10-09T12:15:00.000Z' },
      branch: null,
      explanation: 'Waiting up to 2 days for a reply.',
      error: null,
      attempt: 1,
      startedAt: '2026-10-07T12:15:00.000Z',
      finishedAt: null,
    },
  ],
};

/** Why the follow-up did not start for Maya: her tag was not the one its trigger wants. */
const mismatch = {
  automationId,
  automationName: followUp.name,
  automationStatus: 'active',
  recordId: contactIds.maya,
  state: 'not_started',
  runs: 0,
  run: null,
  ended: null,
  evaluations: [
    {
      id: '0198c1f0-0000-7000-8000-000000000001',
      evaluatedAt: '2026-10-11T08:30:00.000Z',
      eventId: '0198c1f0-0000-7000-8000-0000000000aa',
      eventType: 'tag.assigned',
      trigger: { id: 'tagged', type: 'tag.added' },
      recordId: contactIds.maya,
      reason: 'filter_mismatch',
      detail: { filter: 'tag', expected: 'VIP', actual: 'Cold' },
      explanation: "The trigger's tag filter wanted VIP, and the event had Cold.",
    },
  ],
  evaluationsKeptDays: 30,
  summary:
    'This workflow has not started for Maya Thompson. The last time an event came, its tag filter did not match.',
};

async function contactsApi(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/contacts\?/, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: contactIds.maya,
            name: 'Maya Thompson',
            email: 'maya@example.test',
            phone: null,
            createdAt: '2026-10-01T09:00:00.000Z',
          },
        ],
        next: null,
        canManage: true,
      },
    }),
  );
}

for (const width of [360, 1440])
  test.describe(`the record steps at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test('assigns in turn to two people, only to unassigned contacts', async ({ page }) => {
      const state = withWelcome();
      await openCanvas(page, state);
      const panel = await addAction(page, /^Assign owner/, 'Assign owner');
      await panel.getByRole('searchbox', { name: 'Search team members' }).fill('chr');
      await panel.getByRole('checkbox', { name: 'Chris Marino', exact: true }).check();
      await panel.getByRole('searchbox', { name: 'Search team members' }).fill('');
      await panel.getByRole('checkbox', { name: 'Sam Okoye', exact: true }).check();
      await expect(
        panel.getByRole('list', { name: 'Chosen team members' }).getByRole('listitem'),
      ).toHaveText(['1. Chris Marino', '2. Sam Okoye']);
      await expect(panel.getByRole('status')).toHaveText(
        '2 chosen: each contact goes to the next of them in turn.',
      );
      await panel.getByRole('switch', { name: 'Only apply to unassigned contacts' }).click();
      await expect(
        panel.getByText('A contact that already has an owner keeps them.', { exact: true }),
      ).toBeVisible();
      await scrolledToEnd(panel);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`assign-owner-in-turn-${String(width)}.png`) });

      await panel.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(step(page, 'owner_assign')).toContainText(
        'Assign in turn to 2 people, only when unassigned',
      );
      expect(await savedDocument(page, state)).toMatchObject({
        steps: {
          owner_assign: {
            type: 'owner.assign',
            config: { users: ['usr_chris', 'usr_sam'], onlyIfUnassigned: true },
          },
        },
      });
    });

    test('updates a contact: copies one field into another, and sets a date to now', async ({
      page,
    }) => {
      const state = withWelcome();
      await openCanvas(page, state);
      const panel = await addAction(page, /^Update contact/, 'Update contact');
      await panel.getByRole('button', { name: 'Add field', exact: true }).click();
      // A field the business named is listed by that name, under the folder Settings keeps it in.
      await expect(
        panel
          .getByRole('combobox', { name: 'Field 1', exact: true })
          .locator('optgroup[label="Contact: Wedding details"] option'),
      ).toHaveText(['Dietary requirements', 'Number of guests']);
      await panel
        .getByRole('combobox', { name: 'Field 1', exact: true })
        .selectOption({ label: 'Lead source raw' });
      await panel
        .getByRole('combobox', { name: 'Set to, field 1', exact: true })
        .selectOption({ label: 'Copy from another field' });
      await panel
        .getByRole('combobox', { name: 'Copy from, field 1', exact: true })
        .selectOption({ label: 'Utm source' });
      await panel.getByRole('button', { name: 'Add field', exact: true }).click();
      await panel
        .getByRole('combobox', { name: 'Field 2', exact: true })
        .selectOption({ label: 'First enquiry' });
      await panel
        .getByRole('combobox', { name: 'Set to, field 2', exact: true })
        .selectOption({ label: 'Now' });
      await panel.getByRole('checkbox', { name: 'Only if empty, field 2', exact: true }).check();
      await scrolledToEnd(panel);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`update-contact-rows-${String(width)}.png`) });

      await panel.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(step(page, 'contact_update')).toContainText(
        'copy utm source to lead source raw and set first enquiry to now, only if empty',
      );
      expect(await savedDocument(page, state)).toMatchObject({
        steps: {
          contact_update: {
            type: 'contact.update',
            config: {
              fields: {
                'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}',
                'contact.custom.first_enquiry': { set: { op: 'now' }, onlyIfEmpty: true },
              },
            },
          },
        },
      });
    });

    test('finds an opportunity by two filters, with Found and Not found on the canvas', async ({
      page,
    }) => {
      const state = withWelcome();
      await openCanvas(page, state);
      const panel = await addAction(page, /^Find opportunity/, 'Find opportunity');
      const add = panel.getByRole('combobox', { name: 'Add filter', exact: true });
      await add.selectOption({ label: 'Pipeline' });
      await add.selectOption({ label: 'Status' });
      await panel.getByRole('combobox', { name: 'Status is', exact: true }).selectOption('won');
      // Each filter once: the two in use are no longer offered.
      await expect(add.getByRole('option')).toHaveText([
        '+ Add filter',
        'Pipeline stage',
        'Opportunity name',
        'Opportunity value',
        'Custom field',
      ]);
      await scrolledToEnd(panel);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`find-opportunity-filters-${String(width)}.png`) });

      await panel.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(step(page, 'deal_find')).toContainText(
        'Find their most recent opportunity: in Sales, won',
      );
      for (const name of ['Found', 'Not found'])
        await expect(
          canvas(page)
            .locator('[data-branch-label]')
            .filter({ hasText: new RegExp(`^${name}$`) }),
        ).toBeVisible();
      await expectNoViolations(page);
      await canvas(page).screenshot({
        path: shot(`find-opportunity-branches-${String(width)}.png`),
      });
      expect(await savedDocument(page, state)).toMatchObject({
        steps: {
          deal_find: { type: 'deal.find', config: { pipeline: 'pip_sales', status: 'won' } },
        },
      });
    });

    test('updates the opportunity in hand: its name with a merge field, and when it should close', async ({
      page,
    }) => {
      const state = withWelcome();
      await openCanvas(page, state);
      const panel = await addAction(page, /^Update opportunity/, 'Update opportunity');
      await expect(
        panel.getByText(/^Acts on the opportunity found or created earlier in this workflow/),
      ).toBeVisible();
      const add = panel.getByRole('combobox', { name: 'Add field', exact: true });
      await add.selectOption({ label: 'Opportunity name' });
      await panel.getByLabel('Opportunity name is set to', { exact: true }).fill('Renewal for ');
      await panel
        .getByRole('combobox', { name: 'Insert a field into: Opportunity name is set to' })
        .selectOption({ label: 'First name' });
      await add.selectOption({ label: 'Expected close date' });
      await panel.getByLabel('Expected close date, how many', { exact: true }).fill('2');
      await panel
        .getByRole('combobox', { name: 'Expected close date, days or weeks', exact: true })
        .selectOption('weeks');
      await add.selectOption({ label: 'Owner' });
      await panel
        .getByRole('combobox', { name: 'Owner is set to', exact: true })
        .selectOption({ label: 'Sam Okoye' });
      await scrolledToEnd(panel);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`update-opportunity-rows-${String(width)}.png`) });

      await panel.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(step(page, 'deal_update')).toContainText(
        'On the opportunity: set name, owner, and expected close date',
      );
      expect(await savedDocument(page, state)).toMatchObject({
        steps: {
          deal_update: {
            type: 'deal.update',
            config: {
              name: 'Renewal for {{contact.firstName}}',
              owner: 'usr_sam',
              expectedCloseDate: { in: 'P2W' },
            },
          },
        },
      });
    });

    test('continues a run that waits for a reply, down the branch chosen', async ({ page }) => {
      const state = world({
        setup: recordSetup,
        runs: [waitingRun],
        runDetails: { [runIds.jordan]: waitingRun },
        continueRefusal: 'The run has moved since it was read. Read it again.',
      });
      await signedIn(page);
      await automationsApi(page, state);
      await runsApi(page, state);
      // It is offered in the enrollment history, on the run that waits.
      await page.goto(builderAt('runs'));
      const table = page.getByRole('table', { name: 'Enrollment history', exact: true });
      await expect(table.getByRole('button', { name: 'Continue now', exact: true })).toHaveCount(1);
      await expectNoViolations(page);

      await page.goto(builderAt('runs', runIds.jordan));
      await page.getByRole('button', { name: 'Continue now', exact: true }).click();
      const asking = page.getByRole('dialog', { name: 'Continue now: which way?', exact: true });
      await expect(asking.getByRole('radio')).toHaveCount(2);
      await asking.getByRole('radio', { name: 'If time runs out', exact: true }).check();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`continue-now-which-way-${String(width)}.png`) });
      // Refused in the server's own words, and the question stays to be asked again.
      await asking.getByRole('button', { name: 'Continue now', exact: true }).click();
      await expect(asking.getByRole('alert')).toHaveText(state.continueRefusal ?? '');
      await expectNoViolations(page);

      state.continueRefusal = undefined;
      await asking.getByRole('button', { name: 'Continue now', exact: true }).click();
      await expect(asking).toBeHidden();
      await expect(
        page.getByText('Continued: the run went on from its wait.', { exact: true }),
      ).toBeVisible();
      const sent = state.writes
        .filter((write) => write.path.endsWith('/continue'))
        .map((write) => continueAutomationRunInput.parse(write.body));
      expect(sent).toEqual([
        { branch: 'timed_out', revision: 'rev-1' },
        { branch: 'timed_out', revision: 'rev-1' },
      ]);
      // The step says who continued it, in the server's words, and which branch it took.
      const taken = page.getByRole('list', { name: 'Steps taken' }).getByRole('listitem').first();
      await expect(taken).toContainText('Continued by Dana Brooks before the wait ended.');
      await expect(taken).toContainText('If time runs out');
      await expect(page.getByRole('button', { name: 'Continue now', exact: true })).toHaveCount(0);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({
        path: shot(`continued-run-${String(width)}.png`),
        fullPage: true,
      });
    });

    test('says why the workflow did not run for a contact: a filter that did not match', async ({
      page,
    }) => {
      const state = world({
        setup: recordSetup,
        explanations: { [contactIds.maya]: mismatch },
      });
      await signedIn(page);
      await contactsApi(page);
      await automationsApi(page, state);
      await runsApi(page, state);
      await page.goto(builderAt('runs'));
      await page.getByRole('button', { name: 'Check a contact', exact: true }).click();
      const check = page.getByRole('region', { name: 'Check a contact', exact: true });
      await check.getByRole('searchbox', { name: 'Contact to check', exact: true }).fill('maya');
      await check.getByRole('button', { name: /^Maya Thompson/ }).click();
      const answer = check.getByRole('region', {
        name: 'It did not start for this contact',
        exact: true,
      });
      await expect(answer).toContainText(mismatch.summary);
      const times = answer.getByRole('list', { name: 'The latest times it did not start' });
      await expect(times.getByRole('listitem')).toHaveCount(1);
      await expect(times).toContainText('A trigger filter did not match');
      await expect(times).toContainText(
        "The trigger's tag filter wanted VIP, and the event had Cold.",
      );
      await expect(times.getByRole('term')).toHaveText(['Expected', 'Actual']);
      await expect(times.getByRole('definition')).toHaveText(['VIP', 'Cold']);
      await expect(answer).toContainText(
        'Each time a workflow does not start is kept for 30 days.',
      );
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({
        path: shot(`why-did-it-not-run-${String(width)}.png`),
        fullPage: true,
      });
    });
  });

test.describe("why a workflow didn't run, on the contact's own page", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('asks which workflow, and shows the same answer', async ({ page }) => {
    const state = world({
      setup: recordSetup,
      explanations: { [contactIds.maya]: mismatch },
    });
    await signedIn(page);
    await automationsApi(page, state);
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
          createdAt: stamp,
          updatedAt: stamp,
          trashedAt: null,
          canManage: true,
        },
      }),
    );
    await runsApi(page, state);
    await page.goto(inHarbor(`/contacts/${contactIds.maya}?tab=actions`));
    const panel = page.getByRole('region', { name: 'Workflows', exact: true });
    const ask = panel.getByRole('button', { name: "Why didn't a workflow run?", exact: true });
    await ask.click();
    await expect(ask).toHaveAttribute('aria-expanded', 'true');
    await panel
      .getByRole('combobox', { name: 'Workflow', exact: true })
      .selectOption({ label: followUp.name });
    const answer = panel.getByRole('region', {
      name: 'It did not start for this contact',
      exact: true,
    });
    await expect(answer).toContainText(mismatch.summary);
    await expect(answer).toContainText('A trigger filter did not match');
    await expect(answer.getByRole('definition')).toHaveText(['VIP', 'Cold']);
    await expectNoViolations(page);
    await panel.screenshot({ path: shot('contact-page-why-did-it-not-run-1440.png') });
  });
});
