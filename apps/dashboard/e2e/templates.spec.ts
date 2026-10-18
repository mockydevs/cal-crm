// Email templates, under Marketing → Emails: the library (its folders, Archived and Trash,
// the toolbar kept in the address, the row menu, ticked rows, the grid), and writing,
// editing, a stale save, archive and restore, from the keyboard, at phone and desktop
// widths. The API is stood in for, as in the other specs (template-fixtures.ts).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { inHarbor, signedIn } from './session';
import { templateId, templateOf, templateServer } from './template-fixtures';

/**
 * Goes to a place of the library: the left panel on a wide screen, the list that stands for
 * it on a phone.
 */
async function showPlace(page: Page, width: number, place: string): Promise<void> {
  if (width >= 1024) {
    await page
      .getByRole('navigation', { name: 'Template folders' })
      .getByRole('button', { name: new RegExp(`^${place}`) })
      .click();
    return;
  }
  const list = page.getByRole('combobox', { name: 'Template folders' });
  const label = await list
    .getByRole('option', { name: new RegExp(`^${place}`) })
    .first()
    .textContent();
  await list.selectOption({ label: label ?? place });
}

const noOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const axe = async (page: Page): Promise<unknown[]> =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
    .violations;

for (const width of [360, 1440]) {
  test(`writes, edits, archives and restores a template from the keyboard at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const server = await templateServer(page, []);
    await page.goto(inHarbor('/marketing/emails/templates'));
    await expect(page.getByRole('heading', { level: 1, name: 'Email templates' })).toBeVisible();
    await expect(page.getByText(/^No templates yet\./)).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);

    // Write the first one. The name is missing at first: said under the field, nothing sent.
    // "Write the first template" opens the formatted editor (e2e/automation-email.spec.ts);
    // this is the plain-text form, which stays for emails written as plain text.
    await expect(page.getByRole('button', { name: 'Write the first template' })).toBeVisible();
    await page.getByRole('button', { name: 'New template' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: /^Plain text/ }).focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('region', { name: 'New template' });
    await editor.getByLabel('Subject', { exact: true }).fill('Your guide');
    await editor.getByLabel('Message', { exact: true }).fill('Hi ,\nHere is our pricing guide.');
    await editor.getByLabel('Subject', { exact: true }).press('Enter');
    await expect(editor.getByText('Give the template a name.')).toBeVisible();
    expect(server.requests).toEqual([]);
    await editor.getByLabel('Name', { exact: true }).fill('Pricing guide');

    // A merge field goes in where the cursor was, and the keyboard returns to the text.
    const message = editor.getByLabel('Message', { exact: true });
    await message.focus();
    await message.evaluate((element: HTMLTextAreaElement) => {
      element.setSelectionRange(3, 3);
    });
    await editor.getByRole('button', { name: 'Insert contact.firstName' }).focus();
    await page.keyboard.press('Enter');
    await expect(message).toHaveValue('Hi {{contact.firstName}},\nHere is our pricing guide.');
    await expect(message).toBeFocused();
    await expect(editor.getByRole('button', { name: 'Insert Services' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Insert Budget' })).toHaveCount(0);

    // The preview fills it from a sample, as text.
    const preview = page.getByRole('region', { name: 'Preview' });
    await expect(preview.getByText('Hi Ada,')).toBeVisible();
    await preview.getByLabel('contact.firstName').fill('');
    await expect(preview.getByText(/^No value for contact\.firstName\./)).toBeVisible();
    await preview.getByLabel('contact.firstName').fill('<b>Maya</b>');
    await expect(preview.getByText('Hi <b>Maya</b>,')).toBeVisible();
    await expect(preview.locator('b')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`template-editor-${String(width)}.png`),
      fullPage: true,
    });

    await editor.getByRole('button', { name: 'Create template' }).focus();
    await page.keyboard.press('Enter');
    const saved = page.getByRole('region', { name: 'Pricing guide' });
    await expect(saved.getByRole('status')).toHaveText('Template saved.');
    expect(server.requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/message-templates',
        body: {
          name: 'Pricing guide',
          subject: 'Your guide',
          body: 'Hi {{contact.firstName}},\nHere is our pricing guide.',
        },
      },
    ]);

    // Someone else edits it meanwhile: the save is refused, their text is shown, and
    // keeping this form's changes saves over the new revision on purpose.
    const id = server.templates[0]?.id ?? '';
    server.editElsewhere(id, { subject: 'Their subject' });
    await saved
      .getByLabel('Message', { exact: true })
      .fill('My new message for {{contact.firstName}}.');
    await saved.getByRole('button', { name: 'Save template' }).click();
    const alert = saved.getByRole('alert').filter({ hasText: 'Someone else saved this template' });
    await expect(alert.getByLabel('Subject as saved now')).toHaveValue('Their subject');
    await expect(saved.getByLabel('Message', { exact: true })).toHaveValue(
      'My new message for {{contact.firstName}}.',
    );
    expect(server.templates[0]?.body).toBe('Hi {{contact.firstName}},\nHere is our pricing guide.');
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await alert.getByRole('button', { name: 'Keep my changes' }).click();
    await expect(saved.getByLabel('Subject', { exact: true })).toHaveValue('Their subject');
    await saved.getByRole('button', { name: 'Save template' }).click();
    await expect(saved.getByRole('status')).toHaveText('Template saved.');
    expect(server.templates[0]).toMatchObject({
      subject: 'Their subject',
      body: 'My new message for {{contact.firstName}}.',
    });

    // Leaving with unsaved changes asks first.
    await saved.getByLabel('Name', { exact: true }).fill('Price list');
    await saved.getByRole('button', { name: 'Back to templates' }).click();
    const leave = page.getByRole('dialog', { name: 'Leave without saving?' });
    await expect(leave.getByRole('button', { name: 'Stay here' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(leave).toHaveCount(0);
    await expect(saved.getByLabel('Name', { exact: true })).toHaveValue('Price list');
    await saved.getByLabel('Name', { exact: true }).fill('Pricing guide');

    // Archive names the consequence first; Escape backs out.
    await saved.getByRole('button', { name: 'Archive', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Archive this template?' });
    await expect(confirm.getByText('No published automation sends this template.')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect(server.templates[0]?.archivedAt).toBeNull();
    await saved.getByRole('button', { name: 'Archive', exact: true }).click();
    await confirm.getByRole('button', { name: 'Archive template' }).click();
    await expect(saved.getByRole('status')).toHaveText('Template archived.');
    await expect(saved.getByLabel('Message', { exact: true })).toBeDisabled();

    // The list hides it unless asked, and it can be restored from there.
    await saved.getByRole('button', { name: 'Back to templates' }).click();
    await expect(page.getByText(/^No templates yet\./)).toBeVisible();
    await showPlace(page, width, 'Archived');
    await page.getByRole('button', { name: 'Open Pricing guide' }).click();
    await saved.getByRole('button', { name: 'Restore template' }).click();
    await expect(saved.getByRole('status')).toHaveText('Template restored.');
    await expect(saved.getByLabel('Message', { exact: true })).toBeEnabled();
    expect(server.templates[0]?.archivedAt).toBeNull();
    expect(await noOverflow(page)).toBe(true);
  });
}

test('refuses to archive a template automations send, naming them, and refuses a name another template has', async ({
  page,
}) => {
  await signedIn(page);
  const server = await templateServer(page, [
    templateOf({
      usedBy: [{ id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome series', status: 'active' }],
    }),
    templateOf({ id: templateId('2r'), name: 'Welcome', subject: 'Hello', body: 'Hi there' }),
  ]);
  await page.goto(inHarbor('/marketing/emails/templates'));
  await page.getByRole('button', { name: 'Open Welcome' }).click();
  const welcome = page.getByRole('region', { name: 'Welcome' });
  await welcome.getByLabel('Name', { exact: true }).fill('pricing GUIDE');
  await welcome.getByRole('button', { name: 'Save template' }).click();
  await expect(
    welcome.getByText('A template is already named "pricing GUIDE". Choose another name.'),
  ).toBeVisible();
  expect(server.templates[1]?.name).toBe('Welcome');
  await welcome.getByLabel('Name', { exact: true }).fill('Welcome');
  await welcome.getByRole('button', { name: 'Back to templates' }).click();

  await page.getByRole('button', { name: 'Open Pricing guide' }).click();
  await page
    .getByRole('region', { name: 'Pricing guide' })
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
  const refused = page.getByRole('dialog', { name: 'This template is in use' });
  await expect(refused.getByText('Welcome series (active)')).toBeVisible();
  await expect(refused.getByRole('button', { name: 'Archive template' })).toHaveCount(0);
  await refused.getByRole('button', { name: 'OK' }).click();
  expect(server.requests.filter((request) => request.path.endsWith('/archive'))).toEqual([]);
});

test('is read-only for a role that cannot change templates', async ({ page }) => {
  await signedIn(page);
  const server = await templateServer(page, [templateOf()], false);
  await page.goto(inHarbor('/marketing/emails/templates'));
  await expect(page.getByRole('button', { name: 'New template' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Pricing guide' }).click();
  const editor = page.getByRole('region', { name: 'Pricing guide' });
  await expect(editor.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(editor.getByLabel('Message', { exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Save template' })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  await expect(
    editor.getByText("You can read this template, but your role can't change it."),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preview' }).getByText('Hi Ada,')).toBeVisible();
  expect(server.requests).toEqual([]);
});

test('says so when the templates cannot be loaded, and loads them on a retry', async ({ page }) => {
  await signedIn(page);
  await templateServer(page, [templateOf()]);
  let fail = true;
  await page.route('**/api/v1/message-templates?*', async (route) => {
    if (!fail) return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      json: { type: 'about:blank', title: 'Service unavailable', status: 503 },
    });
  });
  await page.goto(inHarbor('/marketing/emails/templates'));
  // A failing server is asked again a few times before the page gives up.
  await expect(page.getByRole('alert')).toContainText("We couldn't load the templates.", {
    timeout: 20_000,
  });
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Open Pricing guide' })).toBeVisible();
});

for (const width of [360, 1440]) {
  test(`keeps a tidy library: folders, filters in the address, menu, trash, ticked rows and cards at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    const designed = templateOf({
      id: templateId('2r'),
      name: 'Spring offer',
      subject: 'Spring is here',
      content: { format: 'html', html: '<p>Spring is here</p>', text: 'Spring is here' },
      updatedAt: '2026-10-12T09:00:00.000Z',
      usedBy: [{ id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Welcome series', status: 'active' }],
    });
    const server = await templateServer(page, [templateOf(), designed]);
    server.uses[designed.id] = [
      {
        automation: {
          id: 'aut_01h455vb4pex5vsknk084sn02q',
          name: 'Welcome series',
          status: 'active',
        },
        scope: 'published',
        version: null,
        step: 'send',
        label: null,
        mode: 'sync',
        sourceRevision: null,
        current: null,
      },
    ];
    await page.goto(inHarbor('/marketing/emails/templates'));
    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.getByRole('row').filter({ hasText: 'Spring offer' })).toContainText(
      'Used in 1 workflow',
    );
    await expect(page.getByText('1 - 2 of 2')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`templates-library-${String(width)}.png`),
      fullPage: true,
    });

    // Order and filters are kept in the address.
    await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('updated');
    await expect(page).toHaveURL(/sort=updated/);
    await expect(table.getByRole('row').nth(1)).toContainText('Spring offer');
    await page.getByRole('combobox', { name: 'Workflows', exact: true }).selectOption('no');
    await expect(page).toHaveURL(/used=no/);
    await expect(table.getByRole('row')).toHaveCount(2);
    await page.getByRole('combobox', { name: 'Workflows', exact: true }).selectOption('any');

    // Delete is refused while a published workflow sends the template, with its name.
    await page.getByRole('button', { name: 'Actions for Spring offer' }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const inUse = page.getByRole('dialog', { name: 'This template is in use' });
    await expect(inUse).toContainText('“Welcome series”');
    expect(await axe(page)).toEqual([]);
    await inUse.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('button', { name: 'Actions for Spring offer' })).toBeFocused();

    // Duplicate, then delete the copy to the trash, and restore it from there.
    await page.getByRole('button', { name: 'Actions for Pricing guide' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    await expect(page.getByText('Copy of Pricing guide created.')).toBeVisible();
    await page.getByRole('button', { name: 'Actions for Copy of Pricing guide' }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const deleting = page.getByRole('dialog', { name: 'Delete template' });
    await deleting.getByRole('button', { name: 'Move to trash' }).click();
    await expect(page.getByText('Copy of Pricing guide moved to the trash.')).toBeVisible();
    await showPlace(page, width, 'Trash');
    await expect(page).toHaveURL(/show=trash/);
    await expect(table.getByRole('row').filter({ hasText: 'Copy of Pricing guide' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Actions for Copy of Pricing guide' }).click();
    await page.getByRole('menuitem', { name: 'Restore', exact: true }).click();
    await expect(page.getByText('Copy of Pricing guide restored.')).toBeVisible();
    await showPlace(page, width, 'All templates');

    // Ticked rows are archived together.
    await page.getByRole('checkbox', { name: 'Select Pricing guide' }).check();
    await page.getByRole('checkbox', { name: 'Select Copy of Pricing guide' }).check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bar).toContainText('2 selected');
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await bar.getByRole('button', { name: 'Archive', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Archive 2 templates' })
      .getByRole('button', { name: 'Archive', exact: true })
      .click();
    await expect(page.getByText('2 templates archived.')).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(2);

    // Cards: a picture of the designed email, drawn by the server's preview.
    await page.getByRole('button', { name: 'Grid view' }).click();
    await expect(page).toHaveURL(/layout=grid/);
    const picture = page.locator('iframe[title="Preview of Spring offer"]');
    await expect(picture).toHaveAttribute('sandbox', '');
    await expect(picture.contentFrame().getByText('Spring is here')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`templates-grid-${String(width)}.png`),
      fullPage: true,
    });
  });
}
