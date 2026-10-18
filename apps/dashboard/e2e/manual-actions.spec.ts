// Conversations → Manual Actions, against a stand-in for the API that answers as the server
// does.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { actionOf, fakeManualActionsApi, people, workflows } from './conversation-extras-fixtures';
import { reachesRightGutter } from './lists';
import { choose, expectChoice } from './select';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const ANY = 'any';
const queue = (page: Page): Locator => page.getByRole('region', { name: 'Queue', exact: true });
const actionsTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Manual actions table', exact: true }).getByRole('table');
const actionRow = (page: Page, contact: string): Locator =>
  actionsTable(page).getByRole('row').filter({ hasText: contact });
// The page is inert while the panel is open, so this is found by its place, not its role.
const notice = (page: Page): Locator => page.locator('main p.sr-only[role="status"]');
const start = (page: Page): Locator =>
  page.getByRole('button', { name: "Let's start", exact: true });

const seeded = (): ReturnType<typeof actionOf>[] => [
  actionOf(1, 'sms', 'Mara Ellison'),
  actionOf(2, 'call', 'Theo Varga', { automation: { ...workflows.winBack } }),
  actionOf(3, 'sms', 'Ines Okafor', {
    assignee: { membershipId: people.eli.id, name: people.eli.name, you: false },
  }),
];

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`walks the queue from "Let's start", completing and skipping, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeManualActionsApi(page, { actions: seeded() });
    await page.goto(inHarbor('/inbox/manual-actions'));
    await expect(page.getByRole('heading', { level: 1, name: 'Manual Actions' })).toBeVisible();
    await expect(page).toHaveTitle('Manual Actions · Harbor Lights Events');
    await expect(
      page
        .getByRole('navigation', { name: 'Conversations', exact: true })
        .getByRole('link', { name: 'Manual Actions', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    // The pending queue, oldest first, with what each row is and who has it.
    await expect(actionsTable(page).getByRole('row')).toHaveCount(4);
    const first = actionRow(page, 'Mara Ellison');
    await expect(first).toContainText('New lead follow-up');
    await expect(first).toContainText('SMS');
    await expect(first).toContainText('Pending');
    await expect(first).toContainText('Unassigned');
    await expect(actionRow(page, 'Theo Varga')).toContainText('Call');
    await expect(actionRow(page, 'Theo Varga')).toContainText('Win back');
    await expect(actionRow(page, 'Ines Okafor')).toContainText('Eli Frost');
    await expectNoAccessibilityViolations(page);

    // "Let's start" opens the oldest pending action.
    await start(page).click();
    const texting = page.getByRole('dialog', { name: 'Text to send', exact: true });
    await expect(texting).toContainText('Mara Ellison');
    await expect(texting).toContainText('Hi Mara Ellison, are you still looking?');
    await expect(texting.getByRole('link', { name: '+14155550001', exact: true })).toHaveAttribute(
      'href',
      'tel:+14155550001',
    );
    await expectNoAccessibilityViolations(page);

    // Completing it moves straight on to the next one in the queue.
    await texting.getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(notice(page)).toHaveText('Action completed.');
    const calling = page.getByRole('dialog', { name: 'Call to place', exact: true });
    await expect(calling).toContainText('Theo Varga');
    expect(api.actions.find((action) => action.contact.name === 'Mara Ellison')?.status).toBe(
      'completed',
    );

    // Skipping is recorded as skipped, not completed.
    await calling.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(notice(page)).toHaveText('Action skipped.');
    expect(api.actions.find((action) => action.contact.name === 'Theo Varga')?.status).toBe(
      'skipped',
    );

    // The walk carries on to the last one; cancelling leaves it pending.
    const last = page.getByRole('dialog', { name: 'Text to send', exact: true });
    await expect(last).toContainText('Ines Okafor');
    await last.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(last).toBeHidden();
    await expect(actionsTable(page).getByRole('row')).toHaveCount(2);
    await expect(actionRow(page, 'Ines Okafor')).toContainText('Pending');
    expect(api.actions.find((action) => action.contact.name === 'Ines Okafor')?.status).toBe(
      'pending',
    );
  });
}

test('filters the queue as the server does, and shows closed actions on request', async ({
  page,
}) => {
  const api = await fakeManualActionsApi(page, {
    actions: [
      ...seeded(),
      actionOf(4, 'call', 'Jonas Reyes', {
        status: 'completed',
        closedAt: '2026-10-05T09:00:00.000Z',
        closedBy: { membershipId: people.dana.id, name: people.dana.name, you: true },
      }),
    ],
  });
  await page.goto(inHarbor('/inbox/manual-actions'));
  await expect(actionsTable(page).getByRole('row')).toHaveCount(4);

  await choose(queue(page).getByLabel('Type', { exact: true }), 'call');
  await expect(actionsTable(page).getByRole('row')).toHaveCount(2);
  await expect(actionRow(page, 'Theo Varga')).toBeVisible();
  expect(api.listed.at(-1)?.get('type')).toBe('call');

  await choose(queue(page).getByLabel('Type', { exact: true }), ANY);
  await choose(queue(page).getByLabel('Workflow', { exact: true }), workflows.winBack.id);
  await expect(actionsTable(page).getByRole('row')).toHaveCount(2);
  expect(api.listed.at(-1)?.get('automationId')).toBe(workflows.winBack.id);

  await choose(queue(page).getByLabel('Workflow', { exact: true }), ANY);
  await choose(queue(page).getByLabel('Assignee', { exact: true }), 'unassigned');
  await expect(actionsTable(page).getByRole('row')).toHaveCount(3);
  await expect(actionRow(page, 'Ines Okafor')).toHaveCount(0);

  // Nothing is assigned to the person signed in: the filtered list says so plainly.
  await choose(queue(page).getByLabel('Assignee', { exact: true }), 'me');
  await expect(page.getByText('No manual actions match.', { exact: true })).toBeVisible();

  await choose(queue(page).getByLabel('Assignee', { exact: true }), 'anyone');
  await choose(queue(page).getByLabel('Status', { exact: true }), 'completed');
  await expect(actionsTable(page).getByRole('row')).toHaveCount(2);
  await expect(actionRow(page, 'Jonas Reyes')).toContainText('Completed');

  // A closed action can be read, and can no longer be completed or skipped.
  await page.getByRole('button', { name: 'Open the action for Jonas Reyes', exact: true }).click();
  const closed = page.getByRole('dialog', { name: 'Call to place', exact: true });
  await expect(closed).toContainText('Closed');
  await expect(closed).toContainText('by Dana Brooks');
  await expect(closed.getByRole('button', { name: 'Complete', exact: true })).toHaveCount(0);
  await expect(closed.getByRole('button', { name: 'Skip', exact: true })).toHaveCount(0);
  await expectNoAccessibilityViolations(page);
});

test('shows the action as someone else left it when it changed first', async ({ page }) => {
  const api = await fakeManualActionsApi(page, { actions: seeded() });
  await page.goto(inHarbor('/inbox/manual-actions'));
  await page.getByRole('button', { name: 'Open the action for Mara Ellison', exact: true }).click();
  const texting = page.getByRole('dialog', { name: 'Text to send', exact: true });
  api.staleNext = true;
  await texting.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(
    texting.getByText('Someone else changed this action. This is how it is now.', { exact: true }),
  ).toBeVisible();
  // Not completed: it is shown as it now is, assigned to the other person.
  expect(api.actions.find((action) => action.contact.name === 'Mara Ellison')?.status).toBe(
    'pending',
  );
  await expectChoice(texting.getByLabel('Assigned to', { exact: true }), people.eli.id);
});

test('only shows the queue to someone who may not work it', async ({ page }) => {
  const api = await fakeManualActionsApi(page, { actions: seeded() });
  api.canWork = false;
  api.canAssign = false;
  await page.goto(inHarbor('/inbox/manual-actions'));
  await expect(actionRow(page, 'Mara Ellison')).toBeVisible();
  await expect(start(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Open the action for Mara Ellison', exact: true }).click();
  const texting = page.getByRole('dialog', { name: 'Text to send', exact: true });
  await expect(texting).toContainText('Hi Mara Ellison, are you still looking?');
  await expect(texting.getByRole('button', { name: 'Complete', exact: true })).toHaveCount(0);
  await expect(texting.getByRole('button', { name: 'Skip', exact: true })).toHaveCount(0);
});

test('says what is needed when the server refuses the queue', async ({ page }) => {
  const api = await fakeManualActionsApi(page, { actions: seeded() });
  api.refused = true;
  await page.goto(inHarbor('/inbox/manual-actions'));
  await expect(
    page.getByText(
      'Working the manual actions queue needs permission to manage or to reply to conversations.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(queue(page)).toHaveCount(0);
  await expectNoAccessibilityViolations(page);
});

test('says so when nothing is pending', async ({ page }) => {
  await fakeManualActionsApi(page);
  await page.goto(inHarbor('/inbox/manual-actions'));
  await expect(page.getByText('Good work!', { exact: true })).toBeVisible();
  await expect(page.getByText('You have no pending tasks.', { exact: true })).toBeVisible();
  await expect(start(page)).toBeDisabled();
  await expectNoAccessibilityViolations(page);
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeManualActionsApi(page, { actions: seeded() });
    await page.goto(inHarbor('/inbox/manual-actions'));
    await expect(actionRow(page, 'Mara Ellison')).toBeVisible();
    expect(await reachesRightGutter(page, queue(page))).toBe(true);
  });
});
