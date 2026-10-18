// The Automations page and its builder: the list, and the Steps and JSON views of one
// draft. The API is stood in for by a small in-memory one that keeps the contract's rules
// that matter here: a save from a stale draft version is a 409, the checks are the
// contract's own validator, and publishing a draft with errors is refused.
import { expect, test, type Locator } from '@playwright/test';
import { replaceAutomationDraftInput } from '@repo/contracts';
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
} from './automation-api';
import { automationId, automationOf, followUp, harborSetup } from './automation-fixtures';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';

test.describe('the builder', () => {
  test('reads the automation in plain words in the Steps view', async ({ page }) => {
    await openBuilder(page, world());
    await expect(page.getByText('Draft · version 3', { exact: true })).toBeVisible();
    await expect(page.getByText('Not published yet', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'What starts it', exact: true }).getByRole('listitem'),
    ).toHaveText(/Starts when\s*Someone submits “Request a quote”/);
    await expect(step(page, 'send_guide')).toContainText('Send the email “Pricing guide”');
    await expect(step(page, 'wait_2_days')).toContainText('Wait 2 days');
    await expect(step(page, 'asked_about_video')).toContainText('If services includes “video”');
    const no = page.getByRole('group', { name: 'If no', exact: true });
    await expect(no).toContainText('Wait 3 days');
    await expect(no).toContainText('Then it ends.');
    await expect(
      page.getByRole('region', { name: 'Stops as soon as', exact: true }).getByRole('listitem'),
    ).toHaveText(['They reply', 'They book an appointment', 'Their opportunity is won or lost']);
    // The builder's three views, and the tabs of a workflow beside them.
    const views = page.getByRole('navigation', { name: 'Automation views' });
    await expect(views.getByRole('link')).toHaveText(['Canvas', 'Steps', 'JSON']);
    await expect(view(page, 'Steps')).toHaveAttribute('aria-current', 'page');
    await expect(
      page.getByRole('navigation', { name: 'Workflow', exact: true }).getByRole('link'),
    ).toHaveText(['Builder', 'Settings', 'Enrollment history', 'Execution logs']);
    await expect(tab(page, 'Builder')).toHaveAttribute('aria-current', 'page');
    await expectNoViolations(page);
  });

  test('edits one draft in both views: a change in either is what the other shows', async ({
    page,
  }) => {
    const state = world();
    await openBuilder(page, state);
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();

    // Add a step in the Steps view.
    await page
      .getByRole('button', { name: 'Add an action after: Wait 2 days', exact: true })
      .click();
    const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
    await picker.getByRole('button', { name: /^Add tag/ }).click();
    const adding = page.getByRole('dialog', { name: 'Add tag', exact: true });
    await adding.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(adding.getByText('Fill this in.', { exact: true })).toBeVisible();
    await choose(adding.getByRole('combobox', { name: 'Tag', exact: true }), 'tag_vip');
    await adding.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(adding).toBeHidden();
    await expect(step(page, 'tag_add')).toContainText('Add the tag VIP');
    await expect(page.getByTestId('automation-unsaved')).toBeVisible();

    // Edit a step's settings in the Steps view.
    await page.getByRole('button', { name: 'Edit: Wait 2 days', exact: true }).click();
    const editing = page.getByRole('dialog', { name: 'Wait', exact: true });
    await editing.getByRole('spinbutton', { name: 'How long to wait', exact: true }).fill('5');
    await editing.getByRole('button', { name: 'Save action', exact: true }).click();
    await expect(step(page, 'wait_2_days')).toContainText('Wait 5 days');

    // The JSON view shows both changes.
    await view(page, 'JSON').click();
    await expect(page).toHaveURL(builderAt('json'));
    await expect(json(page)).toHaveValue(/"duration": "P5D"/);
    await expect(json(page)).toHaveValue(/"tag_add": \{\s+"type": "tag.add"/);
    const text = await json(page).inputValue();
    const written = JSON.parse(text) as { steps: Record<string, { next?: unknown }> };
    expect(written.steps['wait_2_days']?.next).toBe('tag_add');
    expect(written.steps['tag_add']?.next).toBe('asked_about_video');

    // And a change made in JSON is what the Steps view shows.
    await json(page).fill(text.replace('"duration": "P3D"', '"duration": "PT6H"'));
    await view(page, 'Steps').click();
    await expect(step(page, 'wait_3_days')).toContainText('Wait 6 hours');
    await expect(step(page, 'wait_2_days')).toContainText('Wait 5 days');

    // Saving sends the one draft, with the draft version it started from.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
    await expect(page.getByText('Draft · version 4', { exact: true })).toBeVisible();
    await expect(page.getByTestId('automation-unsaved')).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
    const [save] = state.writes;
    expect(save).toMatchObject({
      method: 'PUT',
      path: `/${automationId}/draft`,
      body: { baseDraftVersion: 3 },
    });
    const sent = replaceAutomationDraftInput.parse(save?.body).document;
    expect(sent).toEqual(JSON.parse(text.replace('"duration": "P3D"', '"duration": "PT6H"')));
  });

  test('asks before removing a step, then joins the flow back up', async ({ page }) => {
    await openBuilder(page, world());
    await page.getByRole('button', { name: 'Remove: Wait 2 days', exact: true }).click();
    const asking = page.getByRole('dialog', { name: 'Delete this action?', exact: true });
    await expect(asking).toContainText(
      'What came before it will lead straight to: If services includes “video”',
    );
    await expect(asking.getByRole('button', { name: 'Keep it', exact: true })).toBeFocused();
    await asking.getByRole('button', { name: 'Keep it', exact: true }).click();
    await expect(step(page, 'wait_2_days')).toBeVisible();

    await page.getByRole('button', { name: 'Remove: Wait 2 days', exact: true }).click();
    await asking.getByRole('button', { name: 'Delete action', exact: true }).click();
    await expect(step(page, 'wait_2_days')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Steps', exact: true })).toBeFocused();
    await view(page, 'JSON').click();
    const written = JSON.parse(await json(page).inputValue()) as {
      steps: Record<string, { next?: unknown }>;
    };
    expect(written.steps['send_guide']?.next).toBe('asked_about_video');

    // Removing a step that branches says what it cuts off, and keeps those steps in sight.
    await view(page, 'Steps').click();
    await page
      .getByRole('button', { name: 'Remove: If services includes “video”', exact: true })
      .click();
    await expect(asking).toContainText(
      '3 actions on its other branches will no longer be connected.',
    );
    await asking.getByRole('button', { name: 'Delete action', exact: true }).click();
    const loose = page.getByRole('region', { name: 'Not connected', exact: true });
    await expect(loose).toContainText('Never runs');
    await expect(loose.locator('#automation-step-check_in')).toBeVisible();
  });

  test('adds and removes ways to start, and renames the automation', async ({ page }) => {
    await openBuilder(page, world());
    const starts = page.getByRole('list', { name: 'What starts it', exact: true });
    await expect(starts.getByRole('button', { name: /^Remove:/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add trigger', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add trigger', exact: true });
    await picker.getByRole('button', { name: /^Contact created/ }).click();
    await page
      .getByRole('dialog', { name: 'Contact created', exact: true })
      .getByRole('button', { name: 'Save trigger', exact: true })
      .click();
    await expect(starts.getByRole('listitem')).toHaveCount(2);
    await expect(starts).toContainText('A contact is created');
    await starts
      .getByRole('button', { name: 'Remove: Someone submits “Request a quote”', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Delete this trigger?', exact: true })
      .getByRole('button', { name: 'Delete trigger', exact: true })
      .click();
    await expect(starts.getByRole('listitem')).toHaveCount(1);

    await page.getByRole('button', { name: 'Rename workflow', exact: true }).click();
    const name = page.getByRole('textbox', { name: 'Workflow name', exact: true });
    await expect(name).toBeFocused();
    await name.fill('Quote follow-up');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Quote follow-up' })).toBeVisible();
    await expect(page).toHaveTitle(`Quote follow-up · ${harbor.name}`);
  });

  test('shows a setting too involved for a form as it reads, and opens it in JSON', async ({
    page,
  }) => {
    // Either of two things: rows hold comparisons that must all be true, and not this.
    const either = {
      ...followUp.steps.asked_about_video,
      config: {
        if: {
          any: [
            { field: 'contact.services', operator: 'includes', value: 'video' },
            { field: 'contact.email', operator: 'is_set' },
          ],
        },
      },
    };
    await openBuilder(
      page,
      world({
        automations: [
          automationOf({
            draft: { ...followUp, steps: { ...followUp.steps, asked_about_video: either } },
          }),
        ],
      }),
    );
    await page
      .getByRole('button', {
        name: 'Edit: If services includes “video” or email is filled in',
        exact: true,
      })
      .click();
    const form = page.getByRole('dialog', { name: 'If / else', exact: true });
    await expect(form).toContainText('services includes “video” or email is filled in');
    await expect(form).toContainText('This setting is edited in the JSON view.');
    await expect(form.getByRole('combobox')).toHaveCount(0);
    await form.getByRole('button', { name: 'Edit in JSON', exact: true }).click();
    await expect(page).toHaveURL(builderAt('json'));
    await expect(json(page)).toBeFocused();
    const selected = await json(page).evaluate((area: HTMLTextAreaElement) =>
      area.value.slice(area.selectionStart, area.selectionEnd),
    );
    expect(JSON.parse(selected)).toEqual(either);
  });

  test('offers SMS authoring without a channel and retains sending and AI readiness checks', async ({
    page,
  }) => {
    await openBuilder(
      page,
      world({
        setup: {
          ...harborSetup,
          channels: { ...harborSetup.channels, sms: false },
          ai: false,
        },
      }),
    );
    // The automation already texts: the checks say it can't, on the steps that would.
    await expect(step(page, 'send_reel')).toContainText(
      'Connect an SMS number before sending from this step.',
    );
    await page.getByRole('button', { name: 'Add an action at the start', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
    await expect(picker.getByRole('button', { name: /^Send email/ })).toBeVisible();
    await expect(picker.getByRole('button', { name: /^Send text/ })).toBeVisible();
    await expect(picker.getByRole('button', { name: /AI/ })).toHaveCount(0);
    const unavailable = picker.getByRole('region', { name: 'Not available yet', exact: true });
    await expect(unavailable.getByRole('listitem')).toHaveCount(3);
    await expect(unavailable.getByText('Send text', { exact: true })).toHaveCount(0);
    await expect(unavailable).toContainText('Add an AI key in Settings to use this action.');
    await expect(unavailable.getByRole('button')).toHaveCount(0);
    await expectNoViolations(page);
  });

  test('checks the JSON as it is typed, and copies, imports and downloads it', async ({
    page,
  }, testInfo) => {
    await openBuilder(page, world(), 'json');
    await expect(view(page, 'JSON')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('automation-json-state')).toHaveText('Valid · 7 steps');
    const original = await json(page).inputValue();
    expect(JSON.parse(original)).toEqual(followUp);

    // Text that isn't JSON: where it goes wrong, and no saving.
    await json(page).fill('{\n  "name": "Broken",\n  "steps": ,\n}');
    await expect(page.getByText(/Line 3, column 12: “,” doesn't belong here\./)).toBeVisible();
    await expect(json(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Go to the mistake', exact: true }).click();
    await expect(json(page)).toBeFocused();
    expect(
      await json(page).evaluate((area: HTMLTextAreaElement) =>
        area.value.slice(area.selectionStart, area.selectionEnd),
      ),
    ).toBe(',');
    await expectNoViolations(page);
    await page.getByRole('button', { name: 'Undo my JSON changes', exact: true }).click();
    await expect(json(page)).toHaveValue(original);

    // JSON that reads, with something wrong in it: the problem, its place and a fix to try.
    await json(page).fill(
      original.replace('"template": "Pricing guide"', '"template": "Pricing guid"'),
    );
    const problems = page.getByRole('list', { name: 'Problems found', exact: true });
    await expect(problems).toContainText('/steps/send_guide/config/template');
    await expect(problems).toContainText('Did you mean Pricing guide?');
    await expect(page.getByTestId('automation-json-state')).toHaveText(
      'Reads as JSON · has errors',
    );
    await problems
      .getByRole('button', { name: /^Show where/ })
      .first()
      .click();
    expect(
      await json(page).evaluate((area: HTMLTextAreaElement) =>
        area.value.slice(area.selectionStart, area.selectionEnd),
      ),
    ).toBe('"Pricing guid"');

    // Import a file: it replaces the draft, unsaved.
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const importing = page.getByRole('dialog', { name: 'Import an automation', exact: true });
    await importing.getByLabel('Open a JSON file', { exact: true }).setInputFiles({
      name: 'welcome.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'crm.automation',
          formatVersion: 1,
          document: { ...followUp, name: 'Imported follow-up' },
        }),
      ),
    });
    await expect(importing).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Imported follow-up' })).toBeVisible();
    await expect(page.getByTestId('automation-unsaved')).toBeVisible();

    // Download gives the text as a file named after the automation.
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('imported-follow-up.json');
    const saved = testInfo.outputPath('download.json');
    await download.saveAs(saved);

    // Copy puts the same text on the clipboard.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByText('Copied.', { exact: true })).toBeVisible();
    // Windows puts CRLF line ends on its clipboard; apart from those, the text is the same.
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.replaceAll('\r\n', '\n')).toBe(await json(page).inputValue());
  });

  test('shows what the server found after a save, each problem at its step', async ({ page }) => {
    await openBuilder(page, world(), 'json');
    const original = await json(page).inputValue();
    await json(page).fill(original.replace('{{contact.firstName}}', '{{contact.firstname}}'));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByText('Draft saved. It has problems to fix before it can be published.', {
        exact: true,
      }),
    ).toBeVisible();
    const problems = page.getByRole('list', { name: 'Problems found', exact: true });
    await expect(problems).toContainText('/steps/check_in/config/message');
    await expect(problems).toContainText('Error:');

    await problems
      .getByRole('button', { name: /^Show where/ })
      .first()
      .click();
    await expect(json(page)).toBeFocused();
    expect(
      await json(page).evaluate((area: HTMLTextAreaElement) =>
        area.value.slice(area.selectionStart, area.selectionEnd),
      ),
    ).toBe('"Hi {{contact.firstname}}, did the pricing guide come through?"');
    await view(page, 'Steps').click();
    await expect(step(page, 'check_in')).toContainText('Error:');
    await expect(page.getByRole('heading', { name: 'Checks', exact: true })).toHaveCount(0);
    await page.getByRole('switch', { name: 'Published', exact: true }).click();
    const publishing = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
    await expect(publishing.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await expect(publishing).toContainText('/steps/check_in/config/message');
  });

  test('tells you when someone else saved first, and overwrites nothing', async ({ page }) => {
    const state = world();
    await openBuilder(page, state, 'json');
    const mine = (await json(page).inputValue()).replace('"duration": "P2D"', '"duration": "P5D"');
    await json(page).fill(mine);

    // Someone else saves while this draft is open.
    const [current] = state.automations;
    if (current === undefined) throw new Error('The world has the automation.');
    const theirs = { ...followUp, name: 'Renamed by Sam' };
    state.automations = [{ ...current, name: theirs.name, draft: theirs, draftVersion: 4 }];

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Someone else saved this workflow' });
    await expect(alert).toContainText(
      "Your changes weren't saved, and theirs weren't overwritten.",
    );
    await expect(json(page)).toHaveValue(mine);
    await expect(page.getByTestId('automation-unsaved')).toBeVisible();
    expect(state.automations[0]?.draft).toEqual(theirs);
    expect(state.writes.map((write) => write.body)).toMatchObject([{ baseDraftVersion: 3 }]);
    await expectNoViolations(page);

    // Keeping my version open changes nothing on the server, however often I save.
    await alert.getByRole('button', { name: 'Keep my version open', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(alert).toBeVisible();
    expect(state.automations[0]?.draft).toEqual(theirs);

    await alert
      .getByRole('button', { name: 'Load the latest and drop my changes', exact: true })
      .click();
    await expect(page.getByText('Loaded the latest saved version.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Renamed by Sam' })).toBeVisible();
    await expect(page.getByText('Draft · version 4', { exact: true })).toBeVisible();
    await expect(json(page)).toHaveValue(/"duration": "P2D"/);
    await expect(page.getByTestId('automation-unsaved')).toHaveCount(0);
  });

  test('publishes with a before-and-after view of what changes', async ({ page }) => {
    const draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        wait_2_days: { ...followUp.steps.wait_2_days, config: { duration: 'P5D' } },
        last_check_in: { ...followUp.steps.last_check_in, next: 'tag_cold' },
        tag_cold: { type: 'tag.add', config: { tag: 'Cold' } },
      },
      stopWhen: followUp.stopWhen.slice(0, 2),
    };
    const state = world({
      automations: [automationOf({ ...published(2), draft, draftVersion: 7 })],
    });
    await openBuilder(page, state);
    await expect(page.getByText('Live · version 2', { exact: true })).toBeVisible();
    // Published already: the switch is on, and the draft's changes have their own button.
    const published_ = page.getByRole('switch', { name: 'Published', exact: true });
    await expect(published_).toBeChecked();
    await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
    await expect(dialog).toContainText('What changes from live version 2 to this draft.');

    const added = dialog.getByRole('region', { name: 'Added', exact: true });
    await expect(added.getByRole('listitem')).toHaveText(/Add tag\s*Add the tag Cold/);
    const removed = dialog.getByRole('region', { name: 'Removed', exact: true });
    await expect(removed.getByRole('listitem')).toHaveText(
      /Stops as soon as\s*Their opportunity is won or lost/,
    );
    const changed = dialog.getByRole('region', { name: 'Changed', exact: true });
    await expect(changed).toContainText('Before');
    await expect(changed).toContainText('Wait 2 days');
    await expect(changed).toContainText('After');
    await expect(changed).toContainText('Wait 5 days');
    await expect(changed).toContainText('How long to wait');
    await expect(changed).toContainText('What comes next');
    await expect(changed).toContainText('Add the tag Cold');
    // Only what someone changed: nothing about names against ids, or the server's bookkeeping.
    await expect(dialog).not.toContainText('typeVersion');
    await expect(dialog).not.toContainText('tpl_guide');
    await expectNoViolations(page);

    await dialog
      .getByLabel(/^Note for the version history/)
      .fill('Longer wait, and tag the cold ones');
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/^Published\. New contacts start version 3;/)).toBeVisible();
    await expect(page.getByText('Live · version 3', { exact: true })).toBeVisible();
    expect(state.writes).toEqual([
      {
        method: 'POST',
        path: `/${automationId}/publish`,
        body: { baseDraftVersion: 7, changeSummary: 'Longer wait, and tag the cold ones' },
      },
    ]);

    // Nothing left to publish: the draft is the live version.
    await expect(page.getByRole('button', { name: 'Publish changes', exact: true })).toHaveCount(0);

    // The switch takes it back to draft, and publishes it again, without a dialog.
    await published_.click();
    await expect(
      page.getByText('Switched to draft. Nobody new starts; contacts already in it carry on.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(published_).not.toBeChecked();
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
    await expectNoViolations(page);
    await published_.click();
    await expect(
      page.getByText('Published again. New contacts can start.', { exact: true }),
    ).toBeVisible();
    await expect(published_).toBeChecked();
    expect(state.writes.slice(1).map((write) => write.path)).toEqual([
      `/${automationId}/pause`,
      `/${automationId}/resume`,
    ]);
  });

  test('shows the errors instead of publishing a draft that is not valid', async ({ page }) => {
    const draft = {
      ...followUp,
      steps: {
        ...followUp.steps,
        send_guide: { ...followUp.steps.send_guide, config: { template: 'No such template' } },
      },
    };
    const state = world({ automations: [automationOf({ draft })] });
    await openBuilder(page, state);
    // Never published: the switch is on Draft, and switching it to Publish asks first.
    const toggle = page.getByRole('switch', { name: 'Published', exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    const dialog = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
    await expect(dialog).toContainText('Nothing is live yet.');
    await expect(dialog.getByRole('region', { name: 'Going live', exact: true })).toContainText(
      'Someone submits “Request a quote”',
    );
    const errors = dialog.getByRole('region', { name: 'Fix these before publishing', exact: true });
    await expect(errors).toContainText('/steps/send_guide/config/template');
    await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    expect(state.writes).toEqual([]);
  });

  test('is read-only without the permission to change automations', async ({ page }) => {
    await openBuilder(
      page,
      world({
        automations: [automationOf(published(1))],
        flags: { canManage: false, canPublish: false },
      }),
    );
    await expect(
      page.getByText("You can look at this workflow, but you don't have permission to change it.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(step(page, 'wait_2_days')).toContainText('Wait 2 days');
    for (const name of [
      /^Edit/,
      /^Remove/,
      /^Add a/,
      /^Saved?$/,
      'Publish changes',
      'Rename workflow',
      'Test workflow',
    ])
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Published', exact: true })).toHaveCount(0);
    await expectNoViolations(page);

    await view(page, 'JSON').click();
    await expect(json(page)).toHaveJSProperty('readOnly', true);
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await expectNoViolations(page);
  });

  test('offers publishing only to someone who may publish', async ({ page }) => {
    await openBuilder(
      page,
      world({
        automations: [automationOf(published(1))],
        flags: { canManage: true, canPublish: false },
      }),
    );
    await expect(
      page.getByRole('button', { name: 'Edit: Wait 2 days', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish changes', exact: true })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Published', exact: true })).toHaveCount(0);
  });

  test('adds a step with the keyboard alone, and keeps the keyboard where the work is', async ({
    page,
  }) => {
    await openBuilder(page, world());
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
    const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
    await expect(picker).toBeVisible();
    await tabTo(picker.getByRole('button', { name: /^Add tag/ }));
    await page.keyboard.press('Enter');
    const form = page.getByRole('dialog', { name: 'Add tag', exact: true });
    const tag = form.getByRole('combobox', { name: 'Tag', exact: true });
    // Choosing a step takes its button away: the keyboard moves to the first setting.
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
    await tabTo(form.getByRole('button', { name: 'Save action', exact: true }));
    await page.keyboard.press('Enter');
    await expect(form).toBeHidden();
    // The keyboard lands on the step that was added, once the dialog has finished closing.
    await expect(step(page, 'tag_add')).toContainText('Add the tag VIP');
    await expect
      .poll(() => step(page, 'tag_add').evaluate((card) => card.contains(document.activeElement)))
      .toBe(true);

    // Escape closes a dialog and gives the keyboard back to what opened it.
    const edit = page.getByRole('button', { name: 'Edit: Wait 2 days', exact: true });
    await edit.focus();
    await page.keyboard.press('Enter');
    const editing = page.getByRole('dialog', { name: 'Wait', exact: true });
    await expect(
      editing.getByRole('spinbutton', { name: 'How long to wait', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(editing).toBeHidden();
    await expect(edit).toBeFocused();

    // The views are links: Enter follows them.
    await view(page, 'JSON').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(builderAt('json'));
    await expect(json(page)).toHaveValue(/"tag_add"/);
  });

  test('asks before leaving with unsaved changes', async ({ page }) => {
    await openBuilder(page, world(), 'json');
    const original = await json(page).inputValue();
    await json(page).fill(original.replace('"duration": "P2D"', '"duration": "P5D"'));
    // Changing view is not leaving.
    await view(page, 'Steps').click();
    await expect(step(page, 'wait_2_days')).toContainText('Wait 5 days');

    await page.getByRole('link', { name: 'Workflows list', exact: true }).click();
    const asking = page.getByRole('dialog', { name: 'Leave without saving?', exact: true });
    await asking.getByRole('button', { name: 'Stay here', exact: true }).click();
    await expect(page).toHaveURL(builderAt('steps'));
    await expect(step(page, 'wait_2_days')).toContainText('Wait 5 days');

    await page.getByRole('link', { name: 'Workflows list', exact: true }).click();
    await asking.getByRole('button', { name: 'Leave and drop my changes', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/automations'));
    await expect(page.getByRole('heading', { level: 1, name: 'Workflows list' })).toBeVisible();
  });

  test('says when the automation is not there', async ({ page }) => {
    await signedIn(page);
    await automationsApi(page, world({ automations: [] }));
    await page.goto(builderAt());
    await expect(page.getByRole('alert')).toContainText(
      "This workflow doesn't exist, or it belongs to another business.",
    );
    await page.getByRole('link', { name: 'Workflows list', exact: true }).click();
    await expect(page).toHaveURL(inHarbor('/automations'));
  });
});

for (const width of [360, 1440])
  test.describe(`at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('fits the list, both views and each dialog without sideways scrolling', async ({
      page,
    }, testInfo) => {
      const draft = {
        ...followUp,
        steps: {
          ...followUp.steps,
          wait_2_days: { ...followUp.steps.wait_2_days, config: { duration: 'P5D' } },
        },
      };
      const state = world({ automations: [automationOf({ ...published(2), draft })] });
      await signedIn(page);
      await automationsApi(page, state);
      await page.goto(inHarbor('/automations'));
      await expect(page.getByRole('table', { name: 'Workflows', exact: true })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);

      await page.getByRole('link', { name: 'New lead follow-up', exact: true }).click();
      // The builder opens on its canvas (automation-canvas.spec.ts); this is the Steps view.
      await view(page, 'Steps').click();
      await expect(step(page, 'last_check_in')).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: testInfo.outputPath('steps.png'), fullPage: true });

      // Every step card, and every button on it, is inside the page.
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll('main [id^="automation-step-"], main button, main a')]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && (box.left < 0 || box.right > window.innerWidth + 0.5);
          })
          .map((element) => element.textContent),
      );
      expect(overflowing).toEqual([]);

      await page
        .getByRole('button', { name: 'Add an action after: Wait 5 days', exact: true })
        .click();
      const picker = page.getByRole('dialog', { name: 'Actions', exact: true });
      await expect(picker).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await picker.getByRole('button', { name: /^Create opportunity/ }).click();
      const form = page.getByRole('dialog', { name: 'Create opportunity', exact: true });
      await choose(form.getByRole('combobox', { name: 'Pipeline', exact: true }), 'pip_sales');
      await choose(form.getByRole('combobox', { name: 'Stage', exact: true }), 'stg_new');
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      const formBox = await form.boundingBox();
      expect(formBox?.x).toBeGreaterThanOrEqual(0);
      expect((formBox?.x ?? 0) + (formBox?.width ?? 0)).toBeLessThanOrEqual(width);
      // Leaving a panel with something filled in asks first.
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expectNoViolations(page);
      await form.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(form).toBeHidden();

      await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
      const publishing = page.getByRole('dialog', { name: 'Publish this workflow', exact: true });
      await expect(publishing.getByRole('region', { name: 'Changed', exact: true })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: testInfo.outputPath('publish.png') });
      await publishing.getByRole('button', { name: 'Cancel', exact: true }).click();

      await view(page, 'JSON').click();
      await expect(json(page)).toBeVisible();
      // Long lines scroll inside the text box, never the page.
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      const editor = await json(page).boundingBox();
      expect((editor?.x ?? 0) + (editor?.width ?? 0)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath('json.png'), fullPage: true });
    });
  });
