// The workflow builder as GoHighLevel lays it out: the whole window, two bars, the canvas
// with its trigger cards, right-hand panels for a trigger and an action, and the Settings,
// Enrollment history and Execution logs tabs. The API is the in-memory one of
// automation-api.ts.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { replaceAutomationDraftInput, validateAutomation } from '@repo/contracts';
import {
  automationsApi,
  builderAt,
  expectNoSidewaysScroll,
  expectNoViolations,
  json,
  openBuilder,
  published,
  step,
  tab,
  view,
  world,
  type World,
} from './automation-api';
import {
  automationId,
  automationOf,
  contactIds,
  followUp,
  harborSetup,
  mayaRun,
  runIds,
  runList,
  stepRunList,
  welcome,
} from './automation-fixtures';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';

for (const width of [360, 1440, 1920])
  test.describe(`native contact fields at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test('scrolls a long workflow vertically without zooming or changing its draft', async ({
      page,
    }) => {
      const state = world({
        automations: [
          automationOf({ draft: { ...followUp, layout: { wait_2_days: { x: 0, y: 2400 } } } }),
        ],
      });
      await openBuilder(page, state, 'canvas');
      const canvas = page.getByTestId('automation-canvas');
      const bounds = await canvas.boundingBox();
      if (bounds === null) throw new Error('The canvas must be visible.');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 800);
      await expect.poll(() => canvas.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
      await expect(page.getByText('Zoom 100%', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
      await page.mouse.wheel(0, -800);
      await expect.poll(() => canvas.evaluate((element) => element.scrollTop)).toBe(0);
      await expectNoSidewaysScroll(page);
    });
    test('composes inline email without providers and reloads its exact content', async ({
      page,
    }) => {
      const state = world({
        setup: {
          ...harborSetup,
          emailTemplates: [],
          mailboxes: [],
          channels: { email: false, sms: false, whatsapp: false },
        },
      });
      await openBuilder(page, state, 'canvas');
      await page
        .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .getByRole('button', { name: /^Send email/ })
        .click();
      const form = page.getByRole('dialog', { name: 'Send email', exact: true });
      await form.getByLabel('Subject', { exact: true }).fill('Hello {{contact.firstName}}');
      await form
        .getByLabel('Message', { exact: true })
        .fill('Welcome.\nYour next steps are ready.');
      await form.getByRole('radio', { name: 'Select existing template', exact: true }).check();
      await form.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(form).toBeVisible();
      await form.getByRole('radio', { name: 'Quick compose', exact: true }).check();
      await expect(form.getByLabel('Subject', { exact: true })).toHaveValue(
        'Hello {{contact.firstName}}',
      );
      await expectNoViolations(page);
      await expectNoSidewaysScroll(page);
      await form.getByRole('button', { name: 'Save action', exact: true }).click();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        page.getByText('Draft saved. It has problems to fix before it can be published.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(lastSaved(state)['steps']).toMatchObject({
        email_send: {
          type: 'email.send',
          config: {
            subject: 'Hello {{contact.firstName}}',
            body: 'Welcome.\nYour next steps are ready.',
          },
        },
      });
      await page.reload();
      await expect(step(page, 'email_send')).toBeVisible();
      await page.getByRole('switch', { name: 'Published', exact: true }).click();
      const publish = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
      await expect(publish.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
      await expect(
        publish.getByRole('listitem').filter({ hasText: '/steps/email_send' }),
      ).toContainText('Error: Connect a mailbox before sending from this step.');
    });
    test('finds Form submitted under triggers and saves its native form configuration', async ({
      page,
    }) => {
      const state = world({
        automations: [automationOf({ draft: { ...welcome, triggers: [] } })],
      });
      await openBuilder(page, state, 'canvas');
      await page.getByRole('button', { name: 'Add new trigger', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Add trigger', exact: true });
      await picker.getByRole('searchbox', { name: 'Search triggers', exact: true }).fill('form');
      await picker.getByRole('button', { name: /^Form submitted/ }).click();
      const form = page.getByRole('dialog', { name: 'Form submitted', exact: true });
      // The form is chosen from a list that can be searched; closed, it reads "Any form".
      await form.getByRole('button', { name: 'Form: Any form', exact: true }).click();
      await page.getByRole('option', { name: 'Request a quote', exact: true }).click();
      await expect(form.getByRole('button', { name: 'Form: Request a quote' })).toBeVisible();
      await expectNoViolations(page);
      await expectNoSidewaysScroll(page);
      await form.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(triggerCard(page, 'Someone submits “Request a quote”')).toBeVisible();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect(lastSaved(state)['triggers']).toEqual([
        { id: 'form_submitted', type: 'form.submitted', config: { form: 'frm_quote' } },
      ]);
      await page.reload();
      await expect(triggerCard(page, 'Someone submits “Request a quote”')).toBeVisible();
      await expectNoViolations(page);
    });

    test('authors email and SMS before connecting providers and preserves publish refusal', async ({
      page,
    }) => {
      const state = world({
        setup: { ...harborSetup, channels: { email: false, sms: false, whatsapp: false } },
      });
      await openBuilder(page, state, 'canvas');
      await page
        .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
        .click();
      const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
      await expect(actions.getByRole('button', { name: /^Send email/ })).toBeVisible();
      await actions.getByRole('button', { name: /^Send text/ }).click();
      const form = page.getByRole('dialog', { name: 'Send text', exact: true });
      await form
        .getByLabel('Message', { exact: true })
        .fill('Hi {{contact.firstName}}, your appointment is tomorrow.');
      await expectNoViolations(page);
      await expectNoSidewaysScroll(page);
      await form.getByRole('button', { name: 'Save action', exact: true }).click();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        page.getByText('Draft saved. It has problems to fix before it can be published.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(lastSaved(state)['steps']).toMatchObject({
        sms_send: {
          type: 'sms.send',
          config: { message: 'Hi {{contact.firstName}}, your appointment is tomorrow.' },
        },
      });
      await page.reload();
      await expect(step(page, 'sms_send')).toBeVisible();
      await page.getByRole('switch', { name: 'Published', exact: true }).click();
      const publish = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
      await expect(publish.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
      await expect(
        publish.getByRole('listitem').filter({ hasText: '/steps/sms_send' }),
      ).toContainText('Error: Connect an SMS number before sending from this step.');
      expect(state.writes.filter((write) => write.path.endsWith('/publish'))).toEqual([]);
    });

    test('centers an empty workflow without a lower checks section', async ({ page }) => {
      const state = world({
        automations: [automationOf({ draft: { name: followUp.name, triggers: [], steps: {} } })],
      });
      await openBuilder(page, state, 'canvas');
      const add = page.getByRole('button', { name: 'Add new trigger', exact: true });
      await expect(add).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Checks', exact: true })).toHaveCount(0);
      if (width >= 1440) {
        const viewport = await page.getByTestId('automation-canvas').boundingBox();
        const trigger = await add.boundingBox();
        if (viewport === null || trigger === null)
          throw new Error('The canvas and trigger are visible.');
        expect(
          Math.abs(trigger.x + trigger.width / 2 - (viewport.x + viewport.width / 2)),
        ).toBeLessThan(2);
      }
      await expectNoViolations(page);
      await expectNoSidewaysScroll(page);
      await add.hover();
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await expect(page.getByText('Zoom 125%', { exact: true })).toBeVisible();
      await page.mouse.wheel(0, 100);
      await page.keyboard.up('Control');
      await expect(page.getByText('Zoom 100%', { exact: true })).toBeVisible();
      await page.getByRole('switch', { name: 'Published', exact: true }).click();
      const publish = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
      await expect(
        publish.getByRole('region', { name: 'Fix these before publishing', exact: true }),
      ).toBeVisible();
      await expect(publish.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
      expect(state.writes.filter((write) => write.path.endsWith('/publish'))).toEqual([]);
    });

    test('saves and reloads native contact fields without JSON', async ({ page }) => {
      const state = world();
      await openBuilder(page, state, 'canvas');
      await page
        .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .getByRole('button', { name: /^Update contact/ })
        .click();
      const form = page.getByRole('dialog', { name: 'Update contact', exact: true });
      await form.getByRole('button', { name: 'Add field', exact: true }).click();
      await form.getByLabel('Value, field 1', { exact: true }).fill('Grace');
      // The next row is for the next field no row sets yet: the last name.
      await form.getByRole('button', { name: 'Add field', exact: true }).click();
      await expect(form.getByRole('combobox', { name: 'Field 2', exact: true })).toHaveValue(
        'contact.lastName',
      );
      await form
        .getByRole('combobox', { name: 'Set to, field 2', exact: true })
        .selectOption({ label: 'Empty the field' });
      await expectNoViolations(page);
      await expectNoSidewaysScroll(page);
      await form.getByRole('button', { name: 'Save action', exact: true }).click();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect(lastSaved(state)['steps']).toMatchObject({
        contact_update: {
          type: 'contact.update',
          config: { fields: { 'contact.firstName': 'Grace', 'contact.lastName': null } },
        },
      });
      await page.reload();
      await step(page, 'contact_update')
        .getByRole('button', { name: /^Edit:/ })
        .click();
      await expect(form.getByLabel('Value, field 1', { exact: true })).toHaveValue('Grace');
      await expect(
        form.getByRole('combobox', { name: 'Set to, field 2', exact: true }),
      ).toHaveValue('clear');
      await expect(form.getByLabel('Value, field 2', { exact: true })).toHaveCount(0);
      await expectNoViolations(page);
      await expectNoSidewaysScroll(page);
    });
  });

const canvas = (page: Page): Locator => page.getByTestId('automation-canvas');
const triggerCard = (page: Page, name: string): Locator =>
  page.getByRole('group', { name: `Trigger: ${name}`, exact: true });
const lastSaved = (state: World): Record<string, unknown> => {
  const save = state.writes.findLast((write) => write.method === 'PUT');
  return replaceAutomationDraftInput.parse(save?.body).document;
};
/** Answers the contact search the history filters and the test dialog use. */
// Three more automations of the business, for a step to name: one of each status.
const others = {
  live: 'aut_01k8e2wzr0e008000000000081',
  paused: 'aut_01k8e2wzr0e008000000000082',
  draft: 'aut_01k8e2wzr0e008000000000083',
} as const;
const withOthers = (): World =>
  world({
    automations: [
      automationOf(),
      automationOf({ id: others.draft, name: 'Birthday', draft: welcome }),
      automationOf({ id: others.paused, name: 'Win back', draft: welcome, status: 'paused' }),
      automationOf({ id: others.live, name: 'Education', draft: welcome, status: 'active' }),
    ],
    setup: {
      ...harborSetup,
      automations: [
        { id: automationId, name: followUp.name },
        { id: others.draft, name: 'Birthday' },
        { id: others.paused, name: 'Win back' },
        { id: others.live, name: 'Education' },
      ],
    },
  });

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

test.describe('the builder in the whole window', () => {
  test('has no sidebar and no top bar, and keeps the way to its content and back to the list', async ({
    page,
  }) => {
    await openBuilder(page, world(), 'canvas');
    await expect(page).toHaveURL(builderAt());
    await expect(page.getByRole('heading', { level: 1, name: followUp.name })).toBeVisible();
    await expect(page).toHaveTitle(`${followUp.name} · ${harbor.name}`);
    // Nothing of the shell: no navigation of the app, no top bar, no business switcher.
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Top bar', exact: true })).toHaveCount(0);
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.getByRole('main')).toHaveCount(1);
    // The first bar reaches both edges of the window.
    const bar = await page
      .getByRole('link', { name: 'Workflows list', exact: true })
      .locator('..')
      .boundingBox();
    expect(bar?.x).toBe(0);
    expect(bar?.width).toBe(page.viewportSize()?.width);

    // The skip link is still the first thing the keyboard meets, and leads to the content.
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();

    // First bar: back, the name with its pencil, the save state. Second bar: the views,
    // the tabs, the test and the Draft / Publish switch.
    await expect(page.getByRole('button', { name: 'Rename workflow', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await expect(view(page, 'Canvas')).toHaveAttribute('aria-current', 'page');
    await expect(tab(page, 'Builder')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: 'Test workflow', exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Published', exact: true })).not.toBeChecked();
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);

    // Ctrl+K still opens the command bar here.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog').getByRole('combobox')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('link', { name: 'Workflows list', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/automations'));
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Workflows list' })).toBeVisible();
  });

  test('renames the workflow in the first bar, and saves from there', async ({ page }) => {
    const state = world();
    await openBuilder(page, state, 'canvas');
    await page.getByRole('button', { name: 'Rename workflow', exact: true }).click();
    const name = page.getByRole('textbox', { name: 'Workflow name', exact: true });
    await expect(name).toBeFocused();
    await expectNoViolations(page);
    // Escape leaves the name as it was.
    await name.fill('Something else');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { level: 1, name: followUp.name })).toBeVisible();

    await page.getByRole('button', { name: 'Rename workflow', exact: true }).click();
    await name.fill('Quote follow-up');
    await page.getByRole('button', { name: 'Use this name', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Quote follow-up' })).toBeVisible();
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    expect(lastSaved(state)['name']).toBe('Quote follow-up');
  });
});

test.describe('triggers', () => {
  for (const [type, label, summary, id] of [
    ['tag.removed', 'Tag removed', 'The tag VIP is removed from a contact', 'tag_removed'],
    ['task.created', 'Task created', 'A task is created for a contact', 'task_created'],
    ['task.completed', 'Task completed', "A contact's task is completed", 'task_completed'],
    ['note.created', 'Note added', 'A note is added to a contact', 'note_created'],
    ['note.updated', 'Note changed', "A contact's note is changed", 'note_updated'],
  ] as const) {
    test(`creates, saves and reloads a ${label} trigger`, async ({ page }) => {
      const state = world({ automations: [automationOf({ draft: { ...welcome, triggers: [] } })] });
      await openBuilder(page, state, 'canvas');
      await page.getByRole('button', { name: 'Add new trigger', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Add trigger', exact: true });
      await picker.getByRole('button', { name: new RegExp(`^${label}`) }).click();
      const panel = page.getByRole('dialog', { name: label, exact: true });
      if (type === 'tag.removed')
        await choose(panel.getByRole('combobox', { name: 'Tag', exact: true }), 'tag_vip');
      await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(triggerCard(page, summary)).toBeVisible();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect(lastSaved(state)['triggers']).toEqual([
        { id, type, config: type === 'tag.removed' ? { tag: 'tag_vip' } : {} },
      ]);
      await page.reload();
      await expect(triggerCard(page, summary)).toBeVisible();
      await expectNoViolations(page);
    });
  }

  test('creates, saves and reloads a Contact DND trigger for one channel turned on', async ({
    page,
  }) => {
    const state = world({ automations: [automationOf({ draft: { ...welcome, triggers: [] } })] });
    await openBuilder(page, state, 'canvas');
    await page.getByRole('button', { name: 'Add new trigger', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add trigger', exact: true });
    await picker.getByRole('button', { name: /^Contact DND/ }).click();
    const panel = page.getByRole('dialog', { name: 'Contact DND', exact: true });
    await choose(panel.getByRole('combobox', { name: /^DND flag/ }), 'enabled');
    await choose(panel.getByRole('combobox', { name: /^DND channel/ }), 'sms');
    // Inbound is one setting: choosing it leaves no channel to choose.
    await choose(panel.getByRole('combobox', { name: /^DND direction/ }), 'inbound');
    await expect(panel.getByRole('combobox', { name: /^DND channel/ })).toHaveCount(0);
    await choose(panel.getByRole('combobox', { name: /^DND direction/ }), 'outbound');
    await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
    const summary = "A contact's do not disturb for text messages is turned on";
    await expect(triggerCard(page, summary)).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    expect(lastSaved(state)['triggers']).toEqual([
      {
        id: 'contact_dnd_changed',
        type: 'contact.dnd_changed',
        config: { direction: 'outbound', flag: 'enabled', channel: 'sms' },
      },
    ]);
    await page.reload();
    await expect(triggerCard(page, summary)).toBeVisible();
    await expectNoViolations(page);
  });

  test('starts a new workflow from the card that adds a trigger, with a filter that is checked', async ({
    page,
  }) => {
    const state = world({
      automations: [
        automationOf({
          name: 'New Workflow : 1',
          draft: { name: 'New Workflow : 1', triggers: [], steps: {} },
        }),
      ],
    });
    await openBuilder(page, state, 'canvas');
    await expect(page.getByRole('group', { name: /^Trigger: / })).toHaveCount(0);
    await expect(canvas(page).getByText('END', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Checks', exact: true })).toHaveCount(0);
    await page.getByRole('switch', { name: 'Published', exact: true }).click();
    const publish = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
    // Having no trigger is pointed out, and stops nothing; having no action is what stops it.
    await expect(publish.getByRole('list', { name: 'Warnings', exact: true })).toContainText(
      'Add at least one trigger to start this workflow. Without one it runs only when another workflow starts it.',
    );
    await expect(publish.getByRole('list', { name: 'Errors', exact: true })).toContainText(
      'Add the first action to choose where this workflow starts.',
    );
    await expect(publish.getByRole('list', { name: 'Errors', exact: true })).not.toContainText(
      'trigger',
    );
    await expect(publish.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await publish.getByRole('button', { name: 'Close', exact: true }).click();
    await expectNoViolations(page);

    await page.getByRole('button', { name: 'Add new trigger', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add trigger', exact: true });
    await expect(
      picker.getByRole('searchbox', { name: 'Search triggers', exact: true }),
    ).toBeFocused();
    await expect(picker.getByRole('region')).toHaveCount(5);
    await expect(
      picker.getByRole('region', { name: 'Contact', exact: true }).getByRole('listitem'),
    ).toHaveText([
      /^Contact created/,
      /^Field changed/,
      /^Contact DND/,
      /^Contact Engagement Score/,
      /^Tag added/,
      /^Tag removed/,
      /^Task created/,
      /^Task completed/,
      /^Task reminder/,
      /^Note added/,
      /^Note changed/,
      /^Date reached/,
    ]);
    // The panel is down the right-hand side of the window.
    const box = await picker.boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(width);
    expect(box?.width).toBeLessThanOrEqual(550);
    expect(box?.width).toBeGreaterThanOrEqual(440);
    await expectNoViolations(page);

    await picker.getByRole('searchbox', { name: 'Search triggers', exact: true }).fill('created');
    await picker.getByRole('button', { name: /^Contact created/ }).click();
    const panel = page.getByRole('dialog', { name: 'Contact created', exact: true });
    await expect(panel).toContainText('A new contact is added.');
    await expect(
      panel.getByRole('combobox', { name: 'Choose a workflow trigger', exact: true }),
    ).toHaveText('Contact created');
    const filters = panel.getByRole('group', { name: 'Filters', exact: true });
    await expect(filters).toContainText('No filters applied');

    // A filter left empty is refused: the banner at the top, the reason at the row.
    await panel.getByRole('button', { name: 'Add filters', exact: true }).click();
    await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText(
      "Oops! Looks like you've missed out on some fields.",
    );
    await expect(filters).toContainText('Choose a field.');
    await expect(
      panel.getByRole('combobox', { name: 'Field of filter 1', exact: true }),
    ).toBeFocused();
    await expectNoViolations(page);

    await choose(
      panel.getByRole('combobox', { name: 'Field of filter 1', exact: true }),
      'contact.tags',
    );
    // Tags are a list: a list "includes" a value where text "contains" it.
    await expect(
      panel.getByRole('combobox', { name: 'Comparison of filter 1', exact: true }),
    ).toHaveText('Includes');
    await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
    await expect(filters).toContainText('Enter what to compare with.');
    await panel.getByRole('textbox', { name: 'Value of filter 1', exact: true }).fill('VIP');
    await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
    await expect(panel).toBeHidden();

    // The card: its type in green, what it listens for, its filter in a line, its footer.
    const card = page.getByRole('group', { name: /^Trigger: A contact is created/ });
    await expect(card).toContainText('Contact created');
    await expect(card).toContainText('tags includes “VIP”');
    await expect(card.getByText('Contact created', { exact: true })).toHaveCSS(
      'color',
      'rgb(2, 122, 72)',
    );
    await expect(card.getByRole('button', { name: /^Stats: / })).toBeVisible();
    await expectNoViolations(page);

    await view(page, 'JSON').click();
    const written = JSON.parse(await json(page).inputValue()) as Record<string, unknown>;
    expect(written['triggers']).toEqual([
      {
        id: 'contact_created',
        type: 'contact.created',
        config: {},
        if: { field: 'contact.tags', operator: 'includes', value: 'VIP' },
      },
    ]);
  });

  test('edits a trigger from its card: another filter, a copy, its numbers, and deleting one', async ({
    page,
  }) => {
    const state = world({ automations: [automationOf(published(2))] });
    await openBuilder(page, state, 'canvas');
    const card = triggerCard(page, 'Someone submits “Request a quote”');
    await expect(card).toContainText('No filters applied');
    // The only trigger cannot be deleted.
    await expect(page.getByRole('button', { name: /^Delete: / })).toHaveCount(0);

    await page
      .getByRole('button', { name: 'Edit: Someone submits “Request a quote”', exact: true })
      .click();
    const panel = page.getByRole('dialog', { name: 'Form submitted', exact: true });
    // The card behind the panel has the accent border while it is open.
    await expect(page.locator('#automation-trigger-0')).toHaveCSS(
      'border-top-color',
      'rgb(21, 94, 239)',
    );
    // A form's trigger adds its filters from a menu: a source, or a field.
    await panel.getByRole('button', { name: 'Add filters', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Another field', exact: true }).click();
    await choose(
      panel.getByRole('combobox', { name: 'Field of filter 1', exact: true }),
      'contact.custom.services',
    );
    await choose(panel.getByRole('combobox', { name: 'Value of filter 1', exact: true }), 'video');
    // Leaving with changes asks first.
    await page.keyboard.press('Escape');
    const asking = panel.getByRole('alertdialog', { name: 'Leave without saving?', exact: true });
    await expect(asking).toBeVisible();
    await expectNoViolations(page);
    await asking.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
    await expect(panel).toBeHidden();
    const filtered = page.getByRole('group', {
      name: /^Trigger: Someone submits “Request a quote”/,
    });
    await expect(filtered).toContainText('services includes “video”');

    // Stats: what the server counts for this trigger.
    const stats = filtered.getByRole('button', { name: /^Stats: / });
    await stats.click();
    await expect(stats).toHaveAttribute('aria-expanded', 'true');
    await expect(filtered).toContainText('Enrolled: 12 (live version: 5)');
    await stats.click();
    await expect(filtered).toContainText('services includes “video”');

    // A copy stands beside it, and then one of the two can go.
    await filtered.getByRole('button', { name: /^Duplicate: / }).click();
    await expect(page.getByRole('group', { name: /^Trigger: / })).toHaveCount(2);
    await expectNoViolations(page);
    await page
      .getByRole('button', { name: /^Delete: / })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: 'Delete this trigger?', exact: true })
      .getByRole('button', { name: 'Delete trigger', exact: true })
      .click();
    await expect(page.getByRole('group', { name: /^Trigger: / })).toHaveCount(1);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    const saved = lastSaved(state);
    expect(saved['triggers']).toEqual([
      {
        id: 'form_submitted',
        type: 'form.submitted',
        config: { form: 'Request a quote' },
        if: { field: 'contact.custom.services', operator: 'includes', value: 'video' },
      },
    ]);
    expect(validateAutomation(saved, harborSetup).errors).toEqual([]);
  });
});

test.describe('a workflow another one starts', () => {
  const { triggers: _none, ...untriggered } = followUp;

  for (const width of [1440, 360])
    test(`has no trigger, says so in plain words, and is published as it is at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = withOthers();
      state.automations = state.automations.map((each) =>
        each.id === automationId ? automationOf({ draft: { ...untriggered, triggers: [] } }) : each,
      );
      await openBuilder(page, state, 'canvas');
      // Said as a note, never as an error, and the way to add a trigger is still there.
      await expect(page.getByRole('note')).toHaveText(
        'Nothing starts this workflow on its own: it runs only when another workflow starts it. Add a trigger if it should also start by itself.',
      );
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Add new trigger', exact: true }),
      ).toBeVisible();
      await expect(step(page, 'send_guide')).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);

      await page.getByRole('switch', { name: 'Published', exact: true }).click();
      const publish = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
      await expect(publish.getByRole('list', { name: 'Warnings', exact: true })).toContainText(
        'Nothing starts this workflow on its own.',
      );
      await expect(publish.getByRole('list', { name: 'Errors', exact: true })).toHaveCount(0);
      await expectNoViolations(page);
      await publish.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(publish).toBeHidden();
      await expect(page.getByRole('switch', { name: 'Published', exact: true })).toBeChecked();
      expect(state.automations.find((each) => each.id === automationId)).toMatchObject({
        status: 'active',
        liveVersion: 1,
      });

      // In the Steps view, the same in its own sentence.
      await view(page, 'Steps').click();
      await expect(
        page.getByText(
          'Nothing starts this automation on its own. Add a way to start it, or leave it so if another automation starts it.',
          { exact: true },
        ),
      ).toBeVisible();
    });

  for (const width of [1440, 360])
    test(`starts when a run of another automation ends: chosen, saved and reloaded at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = withOthers();
      await openBuilder(page, state, 'canvas');
      await page.getByRole('button', { name: 'Add new trigger', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Add trigger', exact: true });
      await picker
        .getByRole('region', { name: 'Events', exact: true })
        .getByRole('button', { name: /^Automation run ended/ })
        .click();
      const form = page.getByRole('dialog', { name: 'Automation run ended', exact: true });
      const which = form.getByRole('group', {
        name: 'When a run of one of these ends',
        exact: true,
      });
      await expect(
        which.getByRole('searchbox', { name: 'Search automations', exact: true }),
      ).toBeFocused();
      // The other automations, published first; never this one.
      await expect(which.getByRole('listitem')).toHaveText([
        'Education (Published)',
        'Win back (Paused)',
        'Birthday (Draft)',
      ]);
      await form.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(form.getByText('Fill this in.', { exact: true })).toBeVisible();
      await which.getByRole('checkbox', { name: 'Education (Published)', exact: true }).check();

      const how = form.getByRole('group', { name: 'How the run ended', exact: true });
      await expect(how.getByRole('checkbox')).toHaveCount(4);
      await expect(how).toContainText(
        "One of that automation's own stop conditions ended it, such as the contact replying.",
      );
      const stoppedBy = form.getByRole('group', {
        name: 'Only when it was stopped by',
        exact: true,
      });
      // What stopped it is asked only while a stopped run can count.
      await how.getByRole('checkbox', { name: /^Completed/ }).check();
      await expect(stoppedBy).toHaveCount(0);
      await how.getByRole('checkbox', { name: /^Stopped/ }).check();
      await how.getByRole('checkbox', { name: /^Completed/ }).uncheck();
      await stoppedBy.getByRole('checkbox', { name: 'A message arrives', exact: true }).check();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await form.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(form).toBeHidden();
      const summary =
        "A contact's run of “Education” is stopped by one of its stop conditions, when what stopped it was “A message arrives, from them or from the team”";
      await expect(triggerCard(page, summary)).toBeVisible();

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect((lastSaved(state)['triggers'] as unknown[]).at(-1)).toMatchObject({
        type: 'automation.run_ended',
        config: { automations: [others.live], how: ['stopped'], stoppedBy: ['message.received'] },
      });
      expect(validateAutomation(lastSaved(state), state.setup).errors).toEqual([]);

      await page.reload();
      await page.getByRole('button', { name: `Edit: ${summary}`, exact: true }).click();
      const reopened = page.getByRole('dialog', { name: 'Automation run ended', exact: true });
      await expect(
        reopened.getByRole('checkbox', { name: 'Education (Published)', exact: true }),
      ).toBeChecked();
      await expect(reopened.getByRole('checkbox', { name: /^Stopped/ })).toBeChecked();
      await expect(
        reopened.getByRole('checkbox', { name: 'A message arrives', exact: true }),
      ).toBeChecked();
      await expectNoViolations(page);
    });
});

test.describe('flow control', () => {
  const lastText = 'Text them “Last check-in from Harbor Lights.”';

  for (const width of [1440, 360])
    test(`builds three branches, a Go To and a goal, saves, reloads and publishes at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = world();
      await openBuilder(page, state, 'canvas');

      // If / else: yes and no until asked; then branches by name, None always last.
      await page
        .getByRole('button', { name: 'Edit: If services includes “video”', exact: true })
        .click();
      const condition = page.getByRole('dialog', { name: 'If / else', exact: true });
      await expect(condition.getByRole('group', { name: /^Branch / })).toHaveCount(0);
      await condition.getByRole('button', { name: 'Use branches I name', exact: true }).click();
      await condition.getByRole('textbox', { name: 'Name of branch 1', exact: true }).fill('Video');
      for (const [number, name, comparison] of [
        [2, 'Has email', 'is_set'],
        [3, 'No email', 'is_empty'],
      ] as const) {
        await condition.getByRole('button', { name: 'Add branch', exact: true }).click();
        const branch = condition.getByRole('group', {
          name: new RegExp(`^Branch ${String(number)}: `),
        });
        await branch
          .getByRole('textbox', { name: `Name of branch ${String(number)}`, exact: true })
          .fill(name);
        await choose(
          branch.getByRole('combobox', { name: 'Field of condition 1', exact: true }),
          'contact.email',
        );
        await choose(
          branch.getByRole('combobox', { name: 'Comparison of condition 1', exact: true }),
          comparison,
        );
      }
      // Order is the order they are tried: the third goes up one place.
      await condition
        .getByRole('button', { name: 'Move branch 3 up: No email', exact: true })
        .click();
      await expect
        .poll(() =>
          condition
            .getByRole('group', { name: /^Branch / })
            .evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-label'))),
        )
        .toEqual(['Branch 1: Video', 'Branch 2: No email', 'Branch 3: Has email', 'Branch None']);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await condition.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(condition).toBeHidden();
      // One path out for each branch, and None's, each labelled; the old paths kept.
      for (const label of [
        'If “Video”',
        'If “No email”',
        'If “Has email”',
        'If none of them holds',
      ])
        await expect(canvas(page).getByText(label, { exact: true })).toBeVisible();

      // Go To: an action chosen by what its card says; the card then says where it leads.
      await page
        .getByRole('button', { name: `Add an action after: ${lastText}`, exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .getByRole('button', { name: /^Go to/ })
        .click();
      const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
      const target = goTo.getByRole('combobox', { name: 'Action to go to', exact: true });
      await expect(target).toBeFocused();
      await target.fill('wait 3');
      await expect(page.getByRole('option')).toHaveText(['Wait 3 days']);
      await page.getByRole('option', { name: 'Wait 3 days', exact: true }).click();
      await expectNoViolations(page);
      await goTo.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(goTo).toBeHidden();
      const chip = step(page, 'goto').getByRole('button', {
        name: 'Goes to: Wait 3 days',
        exact: true,
      });
      await chip.click();
      await expect(step(page, 'wait_3_days')).toBeFocused();

      // Goal: what meets it, with its filter, and what a contact who gets there first does.
      await page
        .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
        .click();
      const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
      await actions.getByRole('button', { name: /^Goal/ }).click();
      const goal = page.getByRole('dialog', { name: 'Goal', exact: true });
      const event = goal.getByRole('group', { name: 'Event 1', exact: true });
      await choose(
        event.getByRole('combobox', { name: 'What happens, event 1', exact: true }),
        'tag.added',
      );
      await goal.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(event.getByText('Fill this in.', { exact: true })).toBeVisible();
      await choose(event.getByRole('combobox', { name: 'Tag of event 1', exact: true }), 'tag_vip');
      const otherwise = goal.getByRole('radiogroup', {
        name: 'A contact who gets here before the goal is met',
        exact: true,
      });
      await expect(otherwise.getByRole('radio')).toHaveCount(3);
      await otherwise.getByRole('radio', { name: /^Waits until the goal is met/ }).check();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await goal.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(goal).toBeHidden();
      await expect(step(page, 'goal')).toContainText('Come straight here on: Tag added');
      // One goal is the most: the list no longer offers it, and says why.
      await page
        .getByRole('button', {
          name: 'Add an action after: Come straight here on: Tag added',
          exact: true,
        })
        .click();
      await expect(actions.getByRole('button', { name: /^Goal/ })).toHaveCount(0);
      await expect(
        actions.getByRole('region', { name: 'Not available yet', exact: true }),
      ).toContainText('This workflow already has one, and one is the most.');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      const saved = lastSaved(state);
      expect(saved['steps']).toMatchObject({
        asked_about_video: {
          config: {
            branches: [
              {
                name: 'yes',
                label: 'Video',
                if: { field: 'contact.services', operator: 'includes', value: 'video' },
              },
              {
                name: 'branch_3',
                label: 'No email',
                if: { field: 'contact.email', operator: 'is_empty' },
              },
              {
                name: 'branch_2',
                label: 'Has email',
                if: { field: 'contact.email', operator: 'is_set' },
              },
            ],
          },
          next: { yes: 'send_reel', none: 'check_in' },
        },
        goto: { type: 'goto', config: { target: 'wait_3_days' } },
        goal: {
          type: 'goal',
          config: {
            events: [{ type: 'tag.added', config: { tag: 'tag_vip' } }],
            otherwise: 'wait',
          },
        },
      });
      expect(validateAutomation(saved, harborSetup).errors).toEqual([]);

      await page.reload();
      await expect(
        step(page, 'goto').getByRole('button', { name: 'Goes to: Wait 3 days', exact: true }),
      ).toBeVisible();
      await page
        .getByRole('button', {
          name: 'Edit: Take the first branch that holds: “Video”, “No email”, or “Has email”',
          exact: true,
        })
        .click();
      await expect(condition.getByRole('group', { name: /^Branch / })).toHaveCount(4);
      await expect(
        condition.getByRole('textbox', { name: 'Name of branch 2', exact: true }),
      ).toHaveValue('No email');
      await expectNoViolations(page);
      await condition.getByRole('button', { name: 'Cancel', exact: true }).click();

      await page.getByRole('switch', { name: 'Published', exact: true }).click();
      const publish = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
      await publish.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(publish).toBeHidden();
      await expect(page.getByRole('switch', { name: 'Published', exact: true })).toBeChecked();
    });

  test('builds them with the keyboard alone', async ({ page }) => {
    const state = world();
    await openBuilder(page, state, 'canvas');
    const tabTo = async (target: Locator): Promise<void> => {
      for (let presses = 0; presses < 120; presses += 1) {
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
      // The list is drawn one frame before focus moves into it.
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
    await tabTo(condition.getByRole('textbox', { name: 'Name of branch 1', exact: true }));
    await page.keyboard.type('Video');
    for (const [number, name, comparison] of [
      [2, 'Has email', 'Is filled in'],
      [3, 'No email', 'Is empty'],
    ] as const) {
      await tabTo(condition.getByRole('button', { name: 'Add branch', exact: true }));
      await page.keyboard.press('Enter');
      const branch = condition.getByRole('group', {
        name: new RegExp(`^Branch ${String(number)}: `),
      });
      await tabTo(
        branch.getByRole('textbox', { name: `Name of branch ${String(number)}`, exact: true }),
      );
      await page.keyboard.type(name);
      await pick(
        branch.getByRole('combobox', { name: 'Field of condition 1', exact: true }),
        'Email',
      );
      await pick(
        branch.getByRole('combobox', { name: 'Comparison of condition 1', exact: true }),
        comparison,
      );
    }
    // The third is moved up with its own button, which keeps the keyboard.
    await page.keyboard.press('Shift+Tab');
    await tabTo(condition.getByRole('button', { name: 'Move branch 3 up: No email', exact: true }));
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        condition
          .getByRole('group', { name: /^Branch / })
          .evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-label'))),
      )
      .toEqual(['Branch 1: Video', 'Branch 2: No email', 'Branch 3: Has email', 'Branch None']);
    await tabTo(condition.getByRole('button', { name: 'Save action', exact: true }));
    await page.keyboard.press('Enter');
    await expect(condition).toBeHidden();

    await tabTo(
      page.getByRole('button', { name: `Add an action after: ${lastText}`, exact: true }),
    );
    await page.keyboard.press('Enter');
    const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
    await page.keyboard.type('go to');
    await tabTo(actions.getByRole('button', { name: /^Go to/ }));
    await page.keyboard.press('Enter');
    const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
    await expect(
      goTo.getByRole('combobox', { name: 'Action to go to', exact: true }),
    ).toBeFocused();
    await page.keyboard.type('wait 3');
    await expect(page.getByRole('option', { name: 'Wait 3 days', exact: true })).toHaveAttribute(
      'data-highlighted',
      '',
    );
    await page.keyboard.press('Enter');
    await tabTo(goTo.getByRole('button', { name: 'Save action', exact: true }));
    await page.keyboard.press('Enter');
    await expect(goTo).toBeHidden();
    // The chip takes the keyboard to the action the jump leads to.
    await tabTo(
      step(page, 'goto').getByRole('button', { name: 'Goes to: Wait 3 days', exact: true }),
    );
    await page.keyboard.press('Enter');
    await expect(step(page, 'wait_3_days')).toBeFocused();

    await tabTo(
      page.getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true }),
    );
    await page.keyboard.press('Enter');
    await page.keyboard.type('goal');
    await tabTo(actions.getByRole('button', { name: /^Goal/ }));
    await page.keyboard.press('Enter');
    const goal = page.getByRole('dialog', { name: 'Goal', exact: true });
    await pick(
      goal.getByRole('combobox', { name: 'What happens, event 1', exact: true }),
      'Tag added',
    );
    await pick(goal.getByRole('combobox', { name: 'Tag of event 1', exact: true }), 'VIP');
    await tabTo(goal.getByRole('radio', { name: /^Continues anyway/ }));
    await page.keyboard.press('ArrowDown');
    await expect(goal.getByRole('radio', { name: /^Waits until the goal is met/ })).toBeChecked();
    await tabTo(goal.getByRole('button', { name: 'Save action', exact: true }));
    await page.keyboard.press('Enter');
    await expect(goal).toBeHidden();

    await page.getByRole('button', { name: 'Save', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    const saved = lastSaved(state);
    expect(saved['steps']).toMatchObject({
      asked_about_video: {
        config: {
          branches: [
            { name: 'yes', label: 'Video' },
            {
              name: 'branch_3',
              label: 'No email',
              if: { field: 'contact.email', operator: 'is_empty' },
            },
            {
              name: 'branch_2',
              label: 'Has email',
              if: { field: 'contact.email', operator: 'is_set' },
            },
          ],
        },
        next: { yes: 'send_reel', none: 'check_in' },
      },
      goto: { type: 'goto', config: { target: 'wait_3_days' } },
      goal: {
        type: 'goal',
        config: { events: [{ type: 'tag.added', config: { tag: 'tag_vip' } }], otherwise: 'wait' },
      },
    });
    expect(validateAutomation(saved, harborSetup).errors).toEqual([]);
  });
});

test.describe('actions', () => {
  for (const native of [
    {
      label: 'Create note',
      key: 'note_create',
      type: 'note.create',
      config: { text: 'Welcome {{contact.firstName}}' },
      edit: 'Edit: Write the note “Welcome {{contact.firstName}}”',
    },
    {
      label: 'Remove owner',
      key: 'owner_remove',
      type: 'owner.remove',
      config: {},
      edit: "Edit: Remove the contact's owner",
    },
    {
      label: 'Set do not disturb',
      key: 'dnd_set',
      type: 'dnd.set',
      config: { channel: 'all', action: 'enable', reason: 'Requested by the contact.' },
      edit: 'Edit: Enable do not disturb for every channel',
    },
  ] as const)
    test(`saves and reloads native ${native.label}`, async ({ page }) => {
      const state = world();
      await openBuilder(page, state, 'canvas');
      await page
        .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Actions', exact: true })
        .getByRole('button', { name: new RegExp(`^${native.label}`) })
        .click();
      const form = page.getByRole('dialog', { name: native.label, exact: true });
      if (native.type === 'note.create')
        await form
          .getByRole('textbox', { name: 'Note text', exact: true })
          .fill(native.config.text);
      if (native.type === 'dnd.set')
        await form.getByRole('textbox', { name: 'Reason', exact: true }).fill(native.config.reason);
      await form.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(step(page, native.key)).toContainText(native.label);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect(lastSaved(state)['steps']).toMatchObject({
        [native.key]: { type: native.type, config: native.config },
      });
      await page.reload();
      await page.getByRole('button', { name: native.edit, exact: true }).click();
      const reopened = page.getByRole('dialog', { name: native.label, exact: true });
      await expect(reopened).toBeVisible();
      if (native.type === 'note.create')
        await expect(reopened.getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue(
          native.config.text,
        );
      if (native.type === 'dnd.set')
        await expect(reopened.getByRole('textbox', { name: 'Reason', exact: true })).toHaveValue(
          native.config.reason,
        );
      await expectNoViolations(page);
    });

  test('saves and reloads inbound do not disturb, which takes no channel', async ({ page }) => {
    const state = world();
    await openBuilder(page, state, 'canvas');
    await page
      .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Actions', exact: true })
      .getByRole('button', { name: /^Set do not disturb/ })
      .click();
    const form = page.getByRole('dialog', { name: 'Set do not disturb', exact: true });
    await choose(form.getByRole('combobox', { name: /^DND direction/ }), 'inbound');
    await expect(form.getByRole('combobox', { name: 'Restrict', exact: true })).toHaveCount(0);
    await form
      .getByRole('textbox', { name: 'Reason', exact: true })
      .fill('Calls every night at 3.');
    await form.getByRole('button', { name: 'Save action', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    expect(lastSaved(state)['steps']).toMatchObject({
      dnd_set: {
        type: 'dnd.set',
        config: { direction: 'inbound', action: 'enable', reason: 'Calls every night at 3.' },
      },
    });
    await page.reload();
    await expect(
      page.getByRole('button', {
        name: 'Edit: Enable inbound do not disturb',
        exact: true,
      }),
    ).toBeVisible();
    await expectNoViolations(page);
  });

  test('saves and reloads Add and Remove Contact Followers', async ({ page }) => {
    const state = world();
    await openBuilder(page, state, 'canvas');
    await page
      .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Actions', exact: true })
      .getByRole('button', { name: /^Add contact followers/ })
      .click();
    const add = page.getByRole('dialog', { name: 'Add contact followers', exact: true });
    await add.getByRole('checkbox', { name: 'Dana Brooks', exact: true }).check();
    await add.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(step(page, 'followers_add')).toContainText('Add contact followers');

    await page
      .getByRole('button', { name: 'Add an action after: Add Dana Brooks as followers' })
      .click();
    await page
      .getByRole('dialog', { name: 'Actions', exact: true })
      .getByRole('button', { name: /^Remove contact followers/ })
      .click();
    const remove = page.getByRole('dialog', { name: 'Remove contact followers', exact: true });
    await remove.getByRole('switch', { name: 'Remove all followers', exact: true }).click();
    await expect(remove.getByRole('checkbox', { name: 'Dana Brooks', exact: true })).toHaveCount(0);
    await remove.getByRole('button', { name: 'Save action', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    expect(lastSaved(state)['steps']).toMatchObject({
      followers_add: { type: 'followers.add', config: { users: ['usr_dana'] } },
      followers_remove: { type: 'followers.remove', config: { all: true } },
    });
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Edit: Add Dana Brooks as followers', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Edit: Remove every follower', exact: true }),
    ).toBeVisible();
    await expectNoViolations(page);
  });

  for (const to of ['contact_owner', 'everyone', 'owner_or_everyone'] as const)
    test(`saves and reloads a native team notification to ${to}`, async ({ page }) => {
      const state = world();
      await openBuilder(page, state, 'canvas');
      await page
        .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
        .click();
      const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
      await picker.getByRole('button', { name: /^Notify the team/ }).click();
      const form = page.getByRole('dialog', { name: 'Notify the team', exact: true });
      await form
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill('Lead: {{contact.firstName}}');
      await choose(form.getByRole('combobox', { name: /^Who to tell/ }), to);
      await form.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(step(page, 'team_notify')).toContainText('Notify the team');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect(lastSaved(state)['steps']).toMatchObject({
        team_notify: {
          type: 'team.notify',
          config: { message: 'Lead: {{contact.firstName}}', to },
        },
      });
      await page.reload();
      await page.getByRole('button', { name: /Edit: Tell .*Lead:/ }).click();
      const reopened = page.getByRole('dialog', { name: 'Notify the team', exact: true });
      await expect(reopened.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
        'Lead: {{contact.firstName}}',
      );
      await expect(reopened.getByRole('combobox', { name: /^Who to tell/ })).toHaveText(
        {
          contact_owner: "The contact's owner",
          everyone: 'Everyone on the team',
          owner_or_everyone: "The contact's owner, or everyone when there is none",
        }[to],
      );
      await expectNoViolations(page);
    });

  for (const width of [1440, 360])
    test.describe(`naming other automations at ${String(width)}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test('starts another automation: found by typing, chosen, saved and reloaded', async ({
        page,
      }) => {
        const state = withOthers();
        await openBuilder(page, state, 'canvas');
        await page
          .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
          .click();
        const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
        // Offered as a choice, under Internal, since the install can run it.
        await picker.getByRole('button', { name: /^Start another automation/ }).click();
        const form = page.getByRole('dialog', { name: 'Start another automation', exact: true });
        const box = form.getByRole('combobox', { name: 'Automation to start', exact: true });
        await expect(box).toBeFocused();
        await box.click();
        // The business's other automations, published first, each with its status.
        await expect(page.getByRole('option')).toHaveText([
          /^Education\s*Published$/,
          /^Win back\s*Paused$/,
          /^Birthday\s*Draft$/,
        ]);
        await box.fill('win');
        await expect(page.getByRole('option')).toHaveText([/^Win back\s*Paused$/]);
        await page.getByRole('option', { name: /^Win back/ }).click();
        await expect(box).toHaveValue('Win back');
        await expect(form.getByRole('status')).toHaveText(
          '“Win back” is paused. This action starts nothing until it is published again.',
        );
        await expectNoSidewaysScroll(page);
        await expectNoViolations(page);
        await form.getByRole('button', { name: 'Save action', exact: true }).click();
        await expect(step(page, 'automation_run')).toContainText('Start the automation “Win back”');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
        expect(lastSaved(state)['steps']).toMatchObject({
          automation_run: { type: 'automation.run', config: { automation: others.paused } },
        });
        expect(validateAutomation(lastSaved(state), state.setup).errors).toEqual([]);

        await page.reload();
        await page
          .getByRole('button', { name: 'Edit: Start the automation “Win back”', exact: true })
          .click();
        const reopened = page.getByRole('dialog', {
          name: 'Start another automation',
          exact: true,
        });
        await expect(
          reopened.getByRole('combobox', { name: 'Automation to start', exact: true }),
        ).toHaveValue('Win back');
        await expectNoViolations(page);
      });

      test('removes from automations: each choice with its list, saved and reloaded', async ({
        page,
      }) => {
        const state = withOthers();
        await openBuilder(page, state, 'canvas');
        await page
          .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
          .click();
        await page
          .getByRole('dialog', { name: 'Actions', exact: true })
          .getByRole('button', { name: /^Remove from automations/ })
          .click();
        const form = page.getByRole('dialog', { name: 'Remove from automations', exact: true });
        const choice = form.getByRole('radiogroup', {
          name: 'Remove the contact from',
          exact: true,
        });
        await expect(choice.getByRole('radio')).toHaveCount(4);
        await expect(choice.getByRole('radio', { name: /^This automation/ })).toBeChecked();
        await expect(choice).toContainText(
          'The contact leaves this automation here. No later step of it runs for them.',
        );
        await expect(form.getByRole('checkbox')).toHaveCount(0);
        await expectNoViolations(page);

        await choice.getByRole('radio', { name: /^Chosen automations/ }).check();
        const chosen = form.getByRole('group', {
          name: 'Automations to remove them from',
          exact: true,
        });
        const search = chosen.getByRole('searchbox', { name: 'Search automations', exact: true });
        // One at least: the panel says so under the list, and puts the keyboard there.
        await form.getByRole('button', { name: 'Save action', exact: true }).click();
        await expect(form.getByText('Fill this in.', { exact: true })).toBeVisible();
        await expect(search).toBeFocused();
        await expect(chosen.getByRole('checkbox')).toHaveCount(3);
        // The box narrows the list; what is ticked is kept in the order it was ticked.
        await search.fill('edu');
        await expect(chosen.getByRole('checkbox')).toHaveCount(1);
        await chosen.getByRole('checkbox', { name: 'Education (Published)', exact: true }).check();
        await search.fill('');
        await chosen.getByRole('checkbox', { name: 'Win back (Paused)', exact: true }).check();
        await expect(chosen.getByRole('status')).toHaveText('2 chosen.');
        await expectNoSidewaysScroll(page);
        await expectNoViolations(page);
        await form.getByRole('button', { name: 'Save action', exact: true }).click();
        await expect(step(page, 'automation_remove')).toContainText(
          'Remove them from “Education” and “Win back”',
        );
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
        expect(lastSaved(state)['steps']).toMatchObject({
          automation_remove: {
            type: 'automation.remove',
            config: { from: 'automations', automations: [others.live, others.paused] },
          },
        });

        await page.reload();
        await page
          .getByRole('button', {
            name: 'Edit: Remove them from “Education” and “Win back”',
            exact: true,
          })
          .click();
        const reopened = page.getByRole('dialog', {
          name: 'Remove from automations',
          exact: true,
        });
        await expect(reopened.getByRole('radio', { name: /^Chosen automations/ })).toBeChecked();
        const again = reopened.getByRole('group', {
          name: 'Automations to remove them from',
          exact: true,
        });
        await expect(again.getByRole('checkbox', { checked: true })).toHaveCount(2);
        await expect(
          again.getByRole('checkbox', { name: 'Birthday (Draft)', exact: true }),
        ).not.toBeChecked();
        // Every other automation, but for the one listed: the first list no longer applies.
        await reopened.getByRole('radio', { name: /^All other automations/ }).check();
        await expect(again).toHaveCount(0);
        await reopened
          .getByRole('group', { name: 'Except', exact: true })
          .getByRole('checkbox', { name: 'Education (Published)', exact: true })
          .check();
        await expectNoViolations(page);
        await reopened.getByRole('button', { name: 'Save action', exact: true }).click();
        await expect(step(page, 'automation_remove')).toContainText(
          'Remove them from every other automation, except “Education”',
        );
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
        expect(
          (lastSaved(state)['steps'] as Record<string, { config: unknown }>)['automation_remove']
            ?.config,
        ).toEqual({ from: 'all_others', except: [others.live] });
        expect(validateAutomation(lastSaved(state), state.setup).errors).toEqual([]);
      });
    });

  test('adds both with the keyboard alone: an automation to start, and some to remove from', async ({
    page,
  }) => {
    const state = withOthers();
    await openBuilder(page, state, 'canvas');
    const tabTo = async (target: Locator): Promise<void> => {
      for (let presses = 0; presses < 80; presses += 1) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press('Tab');
      }
      await expect(target).toBeFocused();
    };

    await tabTo(
      page.getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true }),
    );
    await page.keyboard.press('Enter');
    const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
    await expect(
      actions.getByRole('searchbox', { name: 'Search actions', exact: true }),
    ).toBeFocused();
    await page.keyboard.type('another');
    await tabTo(actions.getByRole('button', { name: /^Start another automation/ }));
    await page.keyboard.press('Enter');
    const start = page.getByRole('dialog', { name: 'Start another automation', exact: true });
    const box = start.getByRole('combobox', { name: 'Automation to start', exact: true });
    await expect(box).toBeFocused();
    await page.keyboard.type('edu');
    // The one that fits is the one Enter takes.
    await expect(page.getByRole('option', { name: /^Education/ })).toHaveAttribute(
      'data-highlighted',
      '',
    );
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('Education');
    await tabTo(start.getByRole('button', { name: 'Save action', exact: true }));
    await page.keyboard.press('Enter');
    await expect(start).toBeHidden();
    await expect(step(page, 'automation_run')).toContainText('Start the automation “Education”');

    await tabTo(
      page.getByRole('button', {
        name: 'Add an action after: Start the automation “Education”',
        exact: true,
      }),
    );
    await page.keyboard.press('Enter');
    await page.keyboard.type('remove from');
    await tabTo(actions.getByRole('button', { name: /^Remove from automations/ }));
    await page.keyboard.press('Enter');
    const remove = page.getByRole('dialog', { name: 'Remove from automations', exact: true });
    // The keyboard starts on the choice that is taken; the arrow keys take the next.
    await expect(remove.getByRole('radio', { name: /^This automation/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(remove.getByRole('radio', { name: /^Chosen automations/ })).toBeChecked();
    const chosen = remove.getByRole('group', {
      name: 'Automations to remove them from',
      exact: true,
    });
    // Typing narrows the list to one; Tab reaches it and Space ticks it.
    await tabTo(chosen.getByRole('searchbox', { name: 'Search automations', exact: true }));
    await page.keyboard.type('edu');
    await expect(chosen.getByRole('checkbox')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(
      chosen.getByRole('checkbox', { name: 'Education (Published)', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('win');
    await page.keyboard.press('Tab');
    await expect(
      chosen.getByRole('checkbox', { name: 'Win back (Paused)', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Space');
    await expect(chosen.getByRole('status')).toHaveText('2 chosen.');
    await tabTo(remove.getByRole('button', { name: 'Save action', exact: true }));
    await page.keyboard.press('Enter');
    await expect(remove).toBeHidden();
    await expect(step(page, 'automation_remove')).toContainText(
      'Remove them from “Education” and “Win back”',
    );

    await page.getByRole('button', { name: 'Save', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    expect(lastSaved(state)['steps']).toMatchObject({
      wait_2_days: { next: 'automation_run' },
      automation_run: {
        type: 'automation.run',
        config: { automation: others.live },
        next: 'automation_remove',
      },
      automation_remove: {
        type: 'automation.remove',
        config: { from: 'automations', automations: [others.live, others.paused] },
        next: 'asked_about_video',
      },
    });
    expect(validateAutomation(lastSaved(state), state.setup).errors).toEqual([]);
  });

  test('says what a refused save names under its setting, and saves when sent again', async ({
    page,
  }) => {
    const refusal =
      'Starting "Win back" would loop: New lead follow-up → Win back → New lead follow-up.';
    const state = withOthers();
    await openBuilder(page, state, 'canvas');
    await page
      .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Actions', exact: true })
      .getByRole('button', { name: /^Start another automation/ })
      .click();
    const form = page.getByRole('dialog', { name: 'Start another automation', exact: true });
    const box = form.getByRole('combobox', { name: 'Automation to start', exact: true });
    await box.click();
    await page.getByRole('option', { name: /^Win back/ }).click();
    await form.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(form).toBeHidden();

    state.saveRefusal = [
      {
        path: '/document/steps/automation_run/config/automation',
        code: 'automation_loop',
        message: refusal,
      },
    ];
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await save.click();
    await expect(page.getByRole('alert').filter({ hasText: refusal })).toBeVisible();
    await expect(page.getByTestId('automation-unsaved')).toBeVisible();
    // On the step's card, and under the setting it names when the step is opened.
    await expect(step(page, 'automation_run')).toContainText(refusal);
    await page
      .getByRole('button', { name: 'Edit: Start the automation “Win back”', exact: true })
      .click();
    await expect(box).toHaveAttribute('aria-invalid', 'true');
    await expect(box).toHaveAccessibleDescription(new RegExp('would loop'));
    await expect(form.getByText(refusal, { exact: true })).toBeVisible();
    await expectNoViolations(page);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toBeHidden();

    // Nothing holds the next save back: the same draft is sent again, and asked about anew.
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    expect(state.writes.filter((write) => write.method === 'PUT')).toHaveLength(2);
    await expect(step(page, 'automation_run')).not.toContainText(refusal);
  });

  test('does not offer team notification execution on an install without its handler', async ({
    page,
  }) => {
    const state = world({ setup: { ...harborSetup, unavailableSteps: ['team.notify'] } });
    await openBuilder(page, state, 'canvas');
    await page
      .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
      .click();
    const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
    await expect(picker.getByRole('button', { name: /^Notify the team/ })).toHaveCount(0);
    await expect(picker).toContainText('Notify the team');
    expect(state.writes).toEqual([]);
  });

  test('adds an action from the panel under its category, names it, and walks between actions', async ({
    page,
  }) => {
    const state = world();
    await openBuilder(page, state, 'canvas');
    await page
      .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
      .click();
    const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
    await expect(picker.getByRole('region')).toHaveText([
      /^Contact/,
      /^Communication/,
      /^Send data/,
      /^Internal/,
      /^Workflow AI/,
      /^Opportunity/,
    ]);
    // A section folds; a category shows alone; a search finds by name.
    const contact = picker.getByRole('button', { name: 'Contact', exact: true });
    await contact.click();
    await expect(contact).toHaveAttribute('aria-expanded', 'false');
    await contact.click();
    await choose(picker.getByRole('combobox', { name: 'Categories', exact: true }), 'opportunity');
    await expect(picker.getByRole('region')).toHaveCount(1);
    await choose(picker.getByRole('combobox', { name: 'Categories', exact: true }), 'all');
    await picker.getByRole('searchbox', { name: 'Search actions', exact: true }).fill('tag');
    await expect(picker.getByRole('listitem')).toHaveText([/^Add tag/, /^Remove tag/]);
    await expectNoViolations(page);
    await picker.getByRole('button', { name: /^Add tag/ }).click();

    const form = page.getByRole('dialog', { name: 'Add tag', exact: true });
    await expect(form).toContainText('Add a tag to the contact.');
    await choose(form.getByRole('combobox', { name: 'Tag', exact: true }), 'tag_vip');
    await form.getByRole('textbox', { name: /^Action name/ }).fill('Mark as VIP');
    // Back to the list asks, since something was filled in.
    await form.getByRole('button', { name: 'Back', exact: true }).click();
    await form.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expectNoViolations(page);
    await form.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(step(page, 'tag_add')).toContainText('Mark as VIP');
    await expect(step(page, 'tag_add')).toContainText('Add tag');

    // Opened from its card: previous and next walk the flow, Delete is at the left.
    await page.getByRole('button', { name: 'Edit: Mark as VIP', exact: true }).click();
    await expect(step(page, 'tag_add')).toHaveCSS('border-top-color', 'rgb(21, 94, 239)');
    await form.getByRole('button', { name: 'Previous action', exact: true }).click();
    const wait = page.getByRole('dialog', { name: 'Wait', exact: true });
    await expect(
      wait.getByRole('spinbutton', { name: 'How long to wait', exact: true }),
    ).toHaveValue('2');
    await wait.getByRole('button', { name: 'Next action', exact: true }).click();
    await expect(form.getByRole('textbox', { name: /^Action name/ })).toHaveValue('Mark as VIP');
    await form.getByRole('button', { name: 'Next action', exact: true }).click();

    // If / else: its conditions are rows, and its branches are columns with their names.
    const condition = page.getByRole('dialog', { name: 'If / else', exact: true });
    await expect(
      condition.getByRole('combobox', { name: 'Field of condition 1', exact: true }),
    ).toHaveText('Services');
    await condition.getByRole('button', { name: 'Add condition', exact: true }).click();
    await choose(
      condition.getByRole('combobox', { name: 'Field of condition 2', exact: true }),
      'contact.email',
    );
    await choose(
      condition.getByRole('combobox', { name: 'Comparison of condition 2', exact: true }),
      'is_set',
    );
    await expectNoViolations(page);
    await condition.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(condition).toBeHidden();
    await expect(step(page, 'asked_about_video')).toContainText(
      'If services includes “video” and email is filled in',
    );
    await expect(canvas(page).getByText('If yes', { exact: true })).toBeVisible();
    await expect(canvas(page).getByText('If no', { exact: true })).toBeVisible();
    const yes = await step(page, 'send_reel').boundingBox();
    const no = await step(page, 'check_in').boundingBox();
    expect(yes?.y).toBe(no?.y);
    expect((no?.x ?? 0) - (yes?.x ?? 0)).toBe(400);
    // A card is about 245px wide.
    expect(yes?.width).toBe(240);

    // Delete, from the panel, asks as it does everywhere.
    await page.getByRole('button', { name: 'Edit: Mark as VIP', exact: true }).click();
    await form.getByRole('button', { name: 'Delete', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Delete this action?', exact: true })
      .getByRole('button', { name: 'Delete action', exact: true })
      .click();
    await expect(step(page, 'tag_add')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    const saved = lastSaved(state);
    expect(saved['steps']).toMatchObject({
      wait_2_days: { next: 'asked_about_video' },
      asked_about_video: {
        config: {
          if: {
            all: [
              { field: 'contact.services', operator: 'includes', value: 'video' },
              { field: 'contact.email', operator: 'is_set' },
            ],
          },
        },
      },
    });
    expect(validateAutomation(saved, harborSetup).errors).toEqual([]);
  });

  test('builds a workflow with the keyboard alone: a trigger, an action, a name, saved', async ({
    page,
  }) => {
    const state = world({
      automations: [
        automationOf({
          name: 'New Workflow : 1',
          draft: { name: 'New Workflow : 1', triggers: [], steps: {} },
        }),
      ],
    });
    await openBuilder(page, state, 'canvas');
    const tabTo = async (target: Locator): Promise<void> => {
      for (let presses = 0; presses < 80; presses += 1) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press('Tab');
      }
      await expect(target).toBeFocused();
    };

    await tabTo(page.getByRole('button', { name: 'Add new trigger', exact: true }));
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Add trigger', exact: true });
    await expect(
      picker.getByRole('searchbox', { name: 'Search triggers', exact: true }),
    ).toBeFocused();
    await page.keyboard.type('tag');
    await tabTo(picker.getByRole('button', { name: /^Tag added/ }));
    await page.keyboard.press('Enter');
    const trigger = page.getByRole('dialog', { name: 'Tag added', exact: true });
    const tag = trigger.getByRole('combobox', { name: 'Tag', exact: true });
    await expect(tag).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    // The list is drawn one frame before focus moves into it; a key pressed in that frame
    // still goes to the trigger. A keyboard user acts once the current choice has focus.
    await expect(page.getByRole('listbox').getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(tag.locator('[data-slot="select-value"]')).toHaveAttribute(
      'data-value',
      'tag_vip',
    );
    await tabTo(trigger.getByRole('button', { name: 'Save trigger', exact: true }));
    await page.keyboard.press('Enter');
    await expect(trigger).toBeHidden();
    await expect(triggerCard(page, 'The tag VIP is added to a contact')).toBeVisible();

    await tabTo(page.getByRole('button', { name: 'Add the first action', exact: true }));
    await page.keyboard.press('Enter');
    const actions = page.getByRole('dialog', { name: 'Actions', exact: true });
    await page.keyboard.type('text');
    await tabTo(actions.getByRole('button', { name: /^Send text/ }));
    await page.keyboard.press('Enter');
    const text = page.getByRole('dialog', { name: 'Send text', exact: true });
    await expect(text.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
    await page.keyboard.type('Welcome, VIP.');
    await tabTo(text.getByRole('button', { name: 'Save action', exact: true }));
    await page.keyboard.press('Enter');
    await expect(text).toBeHidden();
    await expect(step(page, 'sms_send')).toContainText('Text them “Welcome, VIP.”');

    await page.getByRole('button', { name: 'Rename workflow', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('VIP welcome');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Save', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    const saved = lastSaved(state);
    expect(saved).toEqual({
      name: 'VIP welcome',
      triggers: [{ id: 'tag_added', type: 'tag.added', config: { tag: 'tag_vip' } }],
      steps: { sms_send: { type: 'sms.send', config: { message: 'Welcome, VIP.' } } },
      start: 'sms_send',
    });
    expect(validateAutomation(saved, harborSetup).errors).toEqual([]);
  });
});

test.describe('the Settings tab', () => {
  test('shows the settings the engine has as switches, and saves them with the draft', async ({
    page,
  }) => {
    const state = world({ automations: [automationOf({ draft: welcome })] });
    await openBuilder(page, state, 'canvas');
    await tab(page, 'Settings').click();
    await expect(page).toHaveURL(builderAt('settings'));
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Contact', 'Communication']);
    const reEntry = page.getByRole('switch', { name: 'Allow re-entry', exact: true });
    const stop = page.getByRole('switch', { name: 'Stop on response', exact: true });
    const window_ = page.getByRole('switch', { name: 'Specific time', exact: true });
    await expect(reEntry).not.toBeChecked();
    await expect(stop).not.toBeChecked();
    await expect(page.getByRole('switch')).toHaveCount(4);
    // What the server does not have is not drawn.
    await expect(page.getByText(/multiple opportunities/i)).toHaveCount(0);
    await expect(page.getByText(/Sender/)).toHaveCount(0);
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);

    await reEntry.click();
    await stop.click();
    await choose(page.getByRole('combobox', { name: 'Timezone', exact: true }), 'contact');
    await window_.click();
    const days = page.getByRole('group', { name: 'Days', exact: true });
    await expect(days.getByRole('checkbox', { name: 'Monday', exact: true })).toBeChecked();
    await days.getByRole('checkbox', { name: 'Saturday', exact: true }).check();
    await page.getByLabel('Start time', { exact: true }).fill('08:30');
    await page.getByLabel('End time', { exact: true }).fill('18:00');
    await expectNoViolations(page);
    // Invalid settings are still explained in the JSON editor, without a lower Checks section.
    await page.getByLabel('End time', { exact: true }).fill('08:30');
    await view(page, 'JSON').click();
    await expect(page.getByRole('list', { name: 'Problems found', exact: true })).toContainText(
      '/settings/sendingWindow',
    );
    await tab(page, 'Settings').click();
    await page.getByLabel('End time', { exact: true }).fill('18:00');
    await expect(page.getByRole('heading', { name: 'Checks', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    const saved = lastSaved(state);
    expect(saved['settings']).toEqual({
      reEnrollment: 'after_finished',
      timezone: 'contact',
      sendingWindow: {
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
        start: '08:30',
        end: '18:00',
      },
    });
    expect(saved['stopWhen']).toEqual([{ event: 'message.received', from: 'contact' }]);
    expect(validateAutomation(saved, harborSetup).errors).toEqual([]);

    // The Builder tab comes back to the view it was left in.
    await tab(page, 'Builder').click();
    await expect(page).toHaveURL(builderAt('json'));
    await expect(json(page)).toBeVisible();
    await view(page, 'Canvas').click();
    await expect(page).toHaveURL(builderAt());
    await expect(canvas(page)).toBeVisible();
  });

  test('is for reading only without the permission to change workflows', async ({ page }) => {
    await openBuilder(page, world({ flags: { canManage: false, canPublish: false } }), 'settings');
    await expect(
      page.getByText("These settings can't be changed right now.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Allow re-entry', exact: true })).toBeDisabled();
    await expectNoViolations(page);
  });
});

test.describe('the history tabs', () => {
  const withHistory = (): World =>
    world({
      automations: [automationOf(published(2))],
      runs: runList.items,
      runDetails: { [runIds.maya]: mayaRun },
      stepRuns: stepRunList.items,
    });

  test('Enrollment history: the table, narrowed by status and by a contact found by name', async ({
    page,
  }) => {
    const state = withHistory();
    await contactsApi(page);
    await openBuilder(page, state, 'runs');
    await expect(tab(page, 'Enrollment history')).toHaveAttribute('aria-current', 'page');
    const table = page.getByRole('table', { name: 'Enrollment history', exact: true });
    await expect(table.getByRole('columnheader')).toHaveText([
      'Record',
      'Enrollment reason',
      'Date enrolled',
      'Current action',
      'Current status',
      'Next execution on',
      'Actions',
    ]);
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);

    await choose(
      page.getByRole('combobox', { name: 'Enrollment reason', exact: true }),
      'quote_form',
    );
    await expect.poll(() => state.runQueries.at(-1)).toBe('trigger=quote_form');
    await page.getByRole('searchbox', { name: 'Search contacts', exact: true }).fill('maya');
    await page.getByRole('button', { name: /^Maya Thompson/ }).click();
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('Contact: Maya Thompson', { exact: true })).toBeVisible();
    expect(state.runQueries.at(-1)).toBe(`trigger=quote_form&record=${contactIds.maya}`);
    await page.getByLabel('From', { exact: true }).fill('2026-10-06');
    await page.getByLabel('To', { exact: true }).fill('2026-10-08');
    await expect
      .poll(() => new URLSearchParams(state.runQueries.at(-1)).get('to'))
      .toMatch(/^2026-10-0[89]T/);
    expect(new URLSearchParams(state.runQueries.at(-1)).get('from')).toMatch(/^2026-10-0[56]T/);
    await expectNoViolations(page);

    await table.getByRole('link', { name: /^Open the run for Maya Thompson/ }).click();
    await expect(page).toHaveURL(builderAt('runs', runIds.maya));
    await expect(
      page.getByRole('heading', { level: 2, name: /^Run for Maya Thompson/ }),
    ).toBeVisible();
  });

  test('Execution logs: every action taken, narrowed by action and by status, leading to its run', async ({
    page,
  }) => {
    const state = withHistory();
    await openBuilder(page, state, 'canvas');
    await tab(page, 'Execution logs').click();
    await expect(page).toHaveURL(builderAt('logs'));
    const table = page.getByRole('table', { name: 'Execution logs', exact: true });
    await expect(table.getByRole('columnheader')).toHaveText([
      'Record',
      'Action',
      'Status',
      'Executed on',
      'Actions',
    ]);
    await expect(table.locator('tbody tr')).toHaveCount(5);
    await expect(table.locator('tbody tr').nth(2)).toContainText(
      "The contact hasn't agreed to marketing messages on this channel.",
    );
    // The checks of the draft are not about what ran.
    await expect(page.getByRole('heading', { name: 'Checks', exact: true })).toBeHidden();
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);

    await choose(page.getByRole('combobox', { name: 'Action', exact: true }), 'send_guide');
    await expect(table.locator('tbody tr')).toHaveCount(2);
    expect(state.stepRunQueries.at(-1)).toBe('step=send_guide');
    await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'failed');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    expect(state.stepRunQueries.at(-1)).toBe('step=send_guide&status=failed');
    await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'skipped');
    await expect(page.getByText('No action matches that.', { exact: true })).toBeVisible();
    await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'any');
    await choose(page.getByRole('combobox', { name: 'Action', exact: true }), 'any');

    await table
      .getByRole('link', { name: /^Open the run of Maya Thompson that took this action/ })
      .first()
      .click();
    await expect(page).toHaveURL(builderAt('runs', runIds.maya));
    await expect(tab(page, 'Enrollment history')).toHaveAttribute('aria-current', 'page');
    await page.getByRole('link', { name: 'Back to the enrollment history', exact: true }).click();
    await expect(
      page.getByRole('table', { name: 'Enrollment history', exact: true }),
    ).toBeVisible();
  });

  test('says when the logs cannot be read, never that there are none', async ({ page }) => {
    const state = withHistory();
    await signedIn(page);
    await automationsApi(page, state);
    await page.route(`**/api/v1/automations/${automationId}/step-runs**`, (route) =>
      route.fulfill({ status: 500, json: {} }),
    );
    await page.goto(builderAt('logs'));
    await expect(page.getByRole('alert')).toContainText("We couldn't load the execution logs.", {
      timeout: 20_000,
    });
    await expect(page.getByText(/^No action/)).toHaveCount(0);
    await expectNoViolations(page);
  });
});

test.describe('Test workflow', () => {
  for (const width of [360, 1440, 1920]) {
    test(`marks simulated outputs as test-only references at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = world();
      state.testRun = {
        ...state.testRun,
        steps: [
          {
            step: 'note_with_a_long_but_valid_step_identifier_to_check_wrap',
            type: 'note.create',
            kind: 'would_change',
            at: '2026-10-11T09:00:00.000Z',
            explanation: 'Would create a note.',
            simulated: true,
            output: {
              noteId: 'simulated:note:note_with_a_long_but_valid_step_identifier_to_check_wrap:1',
            },
          },
        ],
      };
      await contactsApi(page);
      await openBuilder(page, state, 'canvas');
      await page.getByRole('button', { name: 'Test workflow', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Test workflow', exact: true });
      await dialog.getByRole('button', { name: 'Run test', exact: true }).click();
      const result = dialog.getByRole('region', { name: 'Test result', exact: true });
      await expect(result.getByText('Simulated output', { exact: true })).toBeVisible();
      await expect(
        result.getByText('This reference only exists in this test.', { exact: true }),
      ).toBeVisible();
      const reference = result.getByText(
        'simulated:note:note_with_a_long_but_valid_step_identifier_to_check_wrap:1',
        { exact: true },
      );
      await expect(reference).toBeVisible();
      await expect(result.locator('a')).toHaveCount(0);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
    });
  }

  test('runs the saved draft as a dry run, and asks for unsaved changes to be saved first', async ({
    page,
  }) => {
    const state = world();
    state.testRun = {
      ...state.testRun,
      steps: [
        {
          step: 'send_guide',
          type: 'email.send',
          kind: 'would_send',
          at: '2026-10-09T09:00:00.000Z',
          explanation: 'Would send the email “Pricing guide”.',
        },
        {
          step: 'asked_about_video',
          type: 'condition',
          kind: 'branched',
          at: '2026-10-11T09:00:00.000Z',
          branch: 'no',
          explanation: 'The condition was false, so the no branch was taken.',
        },
      ],
    };
    await contactsApi(page);
    await openBuilder(page, state, 'canvas');
    await page.getByRole('button', { name: 'Test workflow', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Test workflow', exact: true });
    await expect(dialog).toContainText('Nothing is sent and nothing is changed.');
    await expectNoViolations(page);
    await dialog.getByRole('searchbox', { name: 'Search contacts', exact: true }).fill('maya');
    await dialog.getByRole('button', { name: /^Maya Thompson/ }).click();
    await dialog.getByRole('button', { name: 'Run test', exact: true }).click();
    const result = dialog.getByRole('region', { name: 'Test result', exact: true });
    await expect(result.getByRole('status')).toHaveText(
      'The test reached the end of the workflow.',
    );
    await expect(result.getByRole('listitem')).toHaveText([
      /^Would sendSend the email “Pricing guide”/,
      /^BranchedIf services includes “video”.*Branch taken: If no/,
    ]);
    expect(state.writes.at(-1)).toEqual({
      method: 'POST',
      path: `/${automationId}/test-runs`,
      body: { contactId: contactIds.maya },
    });
    await expectNoViolations(page);
    await expectNoSidewaysScroll(page);
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();

    // With changes that are not saved, the test would not see them: it says so, and waits.
    await page.getByRole('button', { name: 'Rename workflow', exact: true }).click();
    await page.getByRole('textbox', { name: 'Workflow name', exact: true }).fill('Renamed');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Test workflow', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Save first');
    await expect(dialog.getByRole('button', { name: /^Run test/ })).toBeDisabled();
  });
});

for (const width of [360, 1440])
  test.describe(`the builder at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('fits its bars, its panels and its tabs without sideways scrolling', async ({
      page,
    }, testInfo) => {
      const state = world({
        automations: [automationOf(published(2))],
        runs: runList.items,
        stepRuns: stepRunList.items,
      });
      await openBuilder(page, state, 'canvas');
      await expect(step(page, 'send_guide')).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: testInfo.outputPath('builder.png'), fullPage: true });
      // Everything in the two bars is inside the window.
      const outside = await page.evaluate(() =>
        [...document.querySelectorAll('main nav a, main h1, main button, main [role="switch"]')]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            const inCanvas = element.closest('[data-testid="automation-canvas"]') !== null;
            return (
              !inCanvas && box.width > 0 && (box.left < 0 || box.right > window.innerWidth + 0.5)
            );
          })
          .map((element) => element.textContent),
      );
      expect(outside).toEqual([]);

      // A trigger's panel, with a filter row, fits the window.
      await page
        .getByRole('button', { name: 'Edit: Someone submits “Request a quote”', exact: true })
        .click();
      const panel = page.getByRole('dialog', { name: 'Form submitted', exact: true });
      await panel.getByRole('button', { name: 'Add filters', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Another field', exact: true }).click();
      await panel.getByRole('button', { name: 'Save trigger', exact: true }).click();
      await expect(panel.getByRole('alert')).toBeVisible();
      const box = await panel.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBeLessThanOrEqual(width);
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: testInfo.outputPath('panel.png') });
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await panel.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(panel).toBeHidden();

      for (const [name, table] of [
        ['Enrollment history', 'Enrollment history'],
        ['Execution logs', 'Execution logs'],
      ] as const) {
        await tab(page, name).click();
        await expect(page.getByRole('table', { name: table, exact: true })).toBeVisible();
        // The table scrolls inside its own frame, never the page.
        await expectNoSidewaysScroll(page);
        await expectNoViolations(page);
      }
      await tab(page, 'Settings').click();
      await page.getByRole('switch', { name: 'Specific time', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Days', exact: true })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true });
    });
  });
