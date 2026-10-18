// A contact's files and the field types that came with them, against a stood-in API: the
// Documents panel (folders, search, upload, a five-minute link to save a file, delete after
// asking), a file upload field's own files, and editing a text box list and a radio field.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  recordFields,
  setRecordFieldInput,
  type RecordField,
  type RecordFile,
} from '@repo/contracts';
import { emptyContactPanels } from './contact-panels';
import { harbor, inHarbor, signedIn } from './session';

const id = 'con_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';
const fileIds = [
  'file_01m4bd188ff82s0add91b7pz63',
  'file_01m4bd188ff82s0add91b7pz64',
  'file_01m4bd188ff82s0add91b7pz65',
];
const definition: Pick<
  RecordField['definition'],
  | 'objectKey'
  | 'description'
  | 'currency'
  | 'aiFillSources'
  | 'aiOverwrite'
  | 'archived'
  | 'revision'
> = {
  objectKey: 'contact',
  description: 'A described contact field.',
  currency: null,
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
  revision: 'a'.repeat(64),
};
const box = (key: string, label: string) => ({ key, label, description: '', archived: false });
const contract: RecordField = {
  definition: {
    ...definition,
    id: 'fld_01m4bd188ff82s0add91b7pz63',
    key: 'signed_contract',
    label: 'Signed contract',
    valueType: 'file',
    options: [],
    files: { formats: ['pdf'], limit: 1 },
  },
  value: [fileIds[0] ?? ''],
  source: { kind: 'user', eventId: null, you: true },
  updatedAt: at,
  confidence: null,
  confirmedAt: null,
  revision: 'b'.repeat(64),
};
const references: RecordField = {
  definition: {
    ...definition,
    id: 'fld_01m4bd188ff82s0add91b7pz64',
    key: 'references',
    label: 'References',
    valueType: 'text_list',
    options: [box('first', 'First reference'), box('second', 'Second reference')],
  },
  value: null,
  source: null,
  updatedAt: null,
  confidence: null,
  confirmedAt: null,
  revision: 'c'.repeat(64),
};
const venue: RecordField = {
  definition: {
    ...definition,
    id: 'fld_01m4bd188ff82s0add91b7pz65',
    key: 'venue',
    label: 'Venue',
    valueType: 'single_choice',
    display: 'radio',
    options: [box('garden', 'Garden'), box('hall', 'Hall')],
  },
  value: null,
  source: null,
  updatedAt: null,
  confidence: null,
  confirmedAt: null,
  revision: 'd'.repeat(64),
};
const fileOf = (at: number, filename: string, rest: Partial<RecordFile> = {}): RecordFile => ({
  id: fileIds[at] ?? '',
  filename,
  contentType: 'application/pdf',
  size: 20480,
  createdAt: new Date(Date.UTC(2026, 9, 8, 12, 10 - at)).toISOString(),
  folder: 'internal',
  field: null,
  addedBy: { kind: 'user', name: 'Dana Brooks', you: true },
  removable: true,
  ...rest,
});

interface State {
  fields: RecordField[];
  files: RecordFile[];
  readonly asked: URLSearchParams[];
  readonly uploads: string[];
  readonly deleted: string[];
  readonly saved: unknown[];
}

async function contactApi(page: Page): Promise<State> {
  const state: State = {
    fields: [contract, references, venue],
    files: [
      fileOf(0, 'Contract.pdf', {
        field: { id: contract.definition.id, label: 'Signed contract' },
      }),
      fileOf(1, 'Their plan.pdf', {
        folder: 'received',
        addedBy: { kind: 'contact', name: null, you: false },
        removable: false,
      }),
      fileOf(2, 'Guest list.csv', { contentType: 'text/csv' }),
    ],
    asked: [],
    uploads: [],
    deleted: [],
    saved: [],
  };
  await emptyContactPanels(page);
  await page.route(`**/api/v1/contacts/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: ['maya@example.com'],
        phones: [],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        canManage: true,
      },
    }),
  );
  await page.route(`**/api/v1/records/${id}/fields`, (route) =>
    route.fulfill({
      json: recordFields.parse({ items: state.fields, canManage: true, canConfirm: true }),
    }),
  );
  await page.route(new RegExp(`/api/v1/records/${id}/fields/fld_[^/]+$`), async (route) => {
    const body = setRecordFieldInput.parse(route.request().postDataJSON());
    state.saved.push(body.value);
    const fieldId = new URL(route.request().url()).pathname.split('/').at(-1);
    const field = state.fields.find((each) => each.definition.id === fieldId);
    if (field === undefined) throw new Error('No such field.');
    const saved: RecordField = {
      ...field,
      value: body.value,
      source: { kind: 'user', eventId: null, you: true },
      updatedAt: at,
      revision: 'e'.repeat(64),
    };
    state.fields = state.fields.map((each) => (each.definition.id === fieldId ? saved : each));
    return route.fulfill({ json: saved });
  });
  await page.route(new RegExp(`/api/v1/records/${id}/files(?:\\?.*)?$`), async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const query = new URL(request.url()).searchParams;
    if (request.method() === 'POST') {
      const filename = query.get('filename') ?? '';
      state.uploads.push(filename);
      if (!filename.endsWith('.pdf'))
        return route.fulfill({
          status: 422,
          json: {
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            errors: [
              {
                path: '/filename',
                code: 'unsupported_type',
                message: 'Upload a file of one of these formats: PDF.',
              },
            ],
          },
        });
      const made = fileOf(2, filename, {
        id: 'file_01m4bd188ff82s0add91b7pz66',
        createdAt: '2026-10-08T13:00:00.000Z',
      });
      state.files = [made, ...state.files];
      return route.fulfill({ status: 201, json: made });
    }
    state.asked.push(query);
    const folder = query.get('folder') ?? 'all';
    const field = query.get('field');
    const q = (query.get('q') ?? '').toLowerCase();
    const items = state.files.filter(
      (file) =>
        (folder === 'all' || file.folder === folder) &&
        (field === null || file.field?.id === field) &&
        file.filename.toLowerCase().includes(q),
    );
    return route.fulfill({ json: { items, next: null, canUpload: true } });
  });
  await page.route(new RegExp(`/api/v1/records/${id}/files/file_[^/]+$`), (route) => {
    const fileId = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    state.deleted.push(fileId);
    state.files = state.files.filter((file) => file.id !== fileId);
    state.fields = state.fields.map((field) =>
      field.definition.id === contract.definition.id
        ? { ...field, value: null, source: null, updatedAt: null }
        : field,
    );
    return route.fulfill({ status: 204 });
  });
  await page.route(new RegExp(`/api/v1/records/${id}/files/file_[^/]+/links$`), (route) =>
    route.fulfill({
      status: 201,
      json: {
        url: `${new URL(route.request().url()).origin}/api/v1/files/${fileIds[0] ?? ''}/content?sig=x`,
        expiresAt: '2026-10-08T12:05:00.000Z',
      },
    }),
  );
  await page.route(/\/api\/v1\/files\/file_[^/]+\/content/, (route) =>
    route.fulfill({
      body: '%PDF-1.7',
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="Contract.pdf"',
      },
    }),
  );
  return state;
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`lists the documents by folder and name, uploads, saves one through a link and deletes one after asking at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await contactApi(page);
    await page.goto(inHarbor(`/contacts/${id}?view=documents`));
    const panel = page.getByRole('region', { name: 'Documents', exact: true });
    const list = panel.getByRole('list', { name: 'Documents of this contact', exact: true });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('listitem').first()).toContainText('Field: Signed contract');
    await expectNoAccessibilityViolations(page);

    // The folders, and a search by name.
    await panel.getByRole('button', { name: 'Received', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Received', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('Their plan.pdf');
    // A message's attachment stays with its message.
    await expect(panel.getByRole('button', { name: 'Delete Their plan.pdf' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'All', exact: true }).click();
    await panel.getByLabel('Search documents').fill('guest');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    expect(state.asked.some((query) => query.get('q') === 'guest')).toBe(true);
    await panel.getByLabel('Search documents').fill('');

    // Two files at once: the one the server refuses is named with its reason.
    await panel.locator('input[type="file"]').setInputFiles([
      { name: 'Floor plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') },
      { name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
    ]);
    await expect(panel.getByRole('alert')).toContainText(
      'Notes.txt: Upload a file of one of these formats: PDF.',
    );
    await expect(list.getByRole('listitem')).toHaveCount(4);
    expect(state.uploads).toEqual(['Floor plan.pdf', 'Notes.txt']);

    // Saving a file asks for a short-lived link and downloads it under its name.
    const download = page.waitForEvent('download');
    await list.getByRole('button', { name: 'Download Contract.pdf', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('Contract.pdf');

    // Deleting asks first, and Cancel keeps the file.
    await list.getByRole('button', { name: 'Delete Guest list.csv', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Guest list.csv?' });
    await expect(dialog).toContainText("This can't be undone.");
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(state.deleted).toEqual([]);
    await list.getByRole('button', { name: 'Delete Guest list.csv', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Delete Guest list.csv?' })
      .getByRole('button', { name: 'Delete file', exact: true })
      .click();
    await expect(list.getByRole('listitem')).toHaveCount(3);
    expect(state.deleted).toEqual([fileIds[2]]);
  });

  test(`shows a file field's files and edits a text box list and a radio field in place at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await contactApi(page);
    await page.goto(inHarbor(`/contacts/${id}`));
    const fields = page.getByRole('region', { name: 'Fields', exact: true });

    // The file field: its file, a full field's word, and deleting the file makes room.
    const files = fields.getByRole('list', { name: 'Files in Signed contract', exact: true });
    await expect(files).toContainText('Contract.pdf');
    await expect(
      fields.getByText('This field is full. Delete a file to upload another.'),
    ).toBeVisible();
    await expect(
      fields.getByRole('button', { name: 'Upload a file to Signed contract', exact: true }),
    ).toBeDisabled();
    expect(state.asked.some((query) => query.get('field') === contract.definition.id)).toBe(true);
    await files.getByRole('button', { name: 'Delete Contract.pdf', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Delete Contract.pdf?' })
      .getByRole('button', { name: 'Delete file', exact: true })
      .click();
    await expect(fields.getByText('No file yet.')).toBeVisible();
    await expect(
      fields.getByRole('button', { name: 'Upload a file to Signed contract', exact: true }),
    ).toBeEnabled();

    // A text box list: one box for each of the field's boxes; an empty box is left out.
    await fields.getByRole('button', { name: 'Edit References', exact: true }).click();
    const references = fields.getByRole('form', { name: 'Edit References', exact: true });
    await references.getByLabel('First reference', { exact: true }).fill('Ann at 555 0100');
    await references.getByRole('button', { name: 'Save value', exact: true }).click();
    await expect(references).toBeHidden();
    await expect(
      fields.getByText('First reference: Ann at 555 0100', { exact: true }),
    ).toBeVisible();

    // A radio field: every choice in sight.
    await fields.getByRole('button', { name: 'Edit Venue', exact: true }).click();
    const venue = fields.getByRole('form', { name: 'Edit Venue', exact: true });
    const choices = venue.getByRole('group', { name: 'Venue', exact: true });
    await expect(choices.getByRole('radio')).toHaveCount(2);
    await choices.getByRole('radio', { name: 'Hall', exact: true }).check();
    await venue.getByRole('button', { name: 'Save value', exact: true }).click();
    await expect(venue).toBeHidden();
    await expect(fields.getByText('Hall', { exact: true })).toBeVisible();
    expect(state.saved).toEqual([{ first: 'Ann at 555 0100' }, 'hall']);
    await expectNoAccessibilityViolations(page);
  });
}
