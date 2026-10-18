// Settings → Custom Fields: GoHighLevel's Radio select, Checkbox, Text box list and File
// upload types, made in the Create panel against a stood-in API and named in the table.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { choose } from './select';
import { inHarbor, signedIn } from './session';
import { fakeFieldsApi, fieldOf, folderOf } from './settings-fixtures';

const panel = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Create custom field', exact: true });
const fieldRow = (page: Page, name: string): Locator =>
  page
    .getByRole('region', { name: 'Fields table', exact: true })
    .getByRole('table')
    .getByRole('row')
    .filter({ hasText: name });

async function startField(page: Page, kind: string, name: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Create field', exact: true }).click();
  const creating = panel(page);
  await choose(creating.getByLabel('Field type', { exact: true }), kind);
  await creating.getByLabel('Field name', { exact: true }).fill(name);
  await creating.getByLabel('What it means', { exact: true }).fill(`What ${name} holds.`);
  return creating;
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`makes a radio select, a checkbox, a text box list and a file upload field at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeFieldsApi(page, {
      folders: [folderOf(1, 'Additional Info', 'contact', true)],
      fields: [fieldOf(1, 'Budget', { valueType: 'money', currency: 'USD' })],
    });
    await page.goto(inHarbor('/settings/custom-fields'));

    // Radio select: a single choice shown as radio buttons, in the preview too.
    let creating = await startField(page, 'radio', 'Venue');
    await creating.getByRole('button', { name: 'Add choice', exact: true }).click();
    await creating.getByLabel('Choice name', { exact: true }).fill('Garden');
    await expect(creating.getByRole('radio', { name: 'Garden', exact: true })).toBeDisabled();
    await creating.getByRole('button', { name: 'Create custom field', exact: true }).click();
    await expect(creating).toBeHidden();
    expect(api.fields.at(-1)).toMatchObject({ valueType: 'single_choice', display: 'radio' });
    await expect(fieldRow(page, 'Venue')).toContainText('Radio select');

    // Checkbox: several choices shown as checkboxes.
    creating = await startField(page, 'checkbox', 'Services');
    await creating.getByRole('button', { name: 'Add choice', exact: true }).click();
    await creating.getByLabel('Choice name', { exact: true }).fill('Lighting');
    await creating.getByRole('button', { name: 'Create custom field', exact: true }).click();
    await expect(creating).toBeHidden();
    expect(api.fields.at(-1)).toMatchObject({ valueType: 'multi_choice', display: 'checkbox' });
    await expect(fieldRow(page, 'Services')).toContainText('Checkbox');

    // Text box list: its boxes, and no assistant settings (the assistant never fills it).
    creating = await startField(page, 'text_list', 'References');
    await expect(creating.getByRole('heading', { name: 'Assistant', exact: true })).toHaveCount(0);
    await creating.getByRole('button', { name: 'Add text box', exact: true }).click();
    await creating.getByLabel('Box name', { exact: true }).fill('First reference');
    await expect(creating.getByLabel('First reference', { exact: true })).toBeVisible();
    await creating.getByRole('button', { name: 'Create custom field', exact: true }).click();
    await expect(creating).toBeHidden();
    expect(api.fields.at(-1)).toMatchObject({
      valueType: 'text_list',
      aiFillSources: [],
      options: [{ label: 'First reference' }],
    });
    await expect(fieldRow(page, 'References')).toContainText('Text box list');

    // File upload: the formats it takes, and several files up to a limit.
    creating = await startField(page, 'file', 'Signed contract');
    const formats = creating.getByRole('group', { name: 'Accepted formats', exact: true });
    for (const format of ['DOC', 'DOCX', 'JPG', 'PNG', 'GIF', 'CSV', 'XLS', 'XLSX'])
      await formats.getByLabel(format, { exact: true }).uncheck();
    await expect(creating.getByText('Upload a file', { exact: true })).toBeVisible();
    await creating.getByLabel('Allow multiple files', { exact: true }).check();
    await creating.getByLabel('Most files on one record', { exact: true }).fill('3');
    await expect(creating.getByText('Upload up to 3 files', { exact: true })).toBeVisible();
    await expect(
      creating
        .getByRole('group', { name: 'Preview of Signed contract', exact: true })
        .getByText('PDF', { exact: true }),
    ).toBeVisible();
    const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(results.violations).toEqual([]);
    await creating.getByRole('button', { name: 'Create custom field', exact: true }).click();
    await expect(creating).toBeHidden();
    expect(api.fields.at(-1)).toMatchObject({
      valueType: 'file',
      files: { formats: ['pdf'], limit: 3 },
    });
    await expect(fieldRow(page, 'Signed contract')).toContainText('File upload');
  });
}

test('keeps a file upload field without a format from being made', async ({ page }) => {
  await fakeFieldsApi(page, { folders: [folderOf(1, 'Additional Info', 'contact', true)] });
  await page.goto(inHarbor('/settings/custom-fields'));
  const creating = await startField(page, 'file', 'Scan');
  const formats = creating.getByRole('group', { name: 'Accepted formats', exact: true });
  for (const checkbox of await formats.getByRole('checkbox').all()) await checkbox.uncheck();
  await expect(
    creating.getByRole('button', { name: 'Create custom field', exact: true }),
  ).toBeDisabled();
});
