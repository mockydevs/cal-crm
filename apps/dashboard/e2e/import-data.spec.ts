import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  importPlanInput,
  inspectImportFileInput,
  previewImportInput,
  type ImportFileInspection,
  type ImportPreview,
} from '@repo/contracts';
import { reachesRightGutter } from './lists';
import { choose, expectChoice } from './select';
import { inHarbor, signedIn } from './session';
import { fakeImportsApi, idOf, importOf, type ImportsApi } from './settings-fixtures';
import { configurationOf } from './tag-fixtures';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const historyTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Import history table', exact: true }).getByRole('table');
const historyRow = (page: Page, name: string): Locator =>
  historyTable(page).getByRole('row').filter({ hasText: name });
const notice = (page: Page): Locator => page.getByRole('main').locator('p.sr-only[role="status"]');
const range = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('status');
const flow = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Import contacts from CSV', exact: true });
const step = (page: Page): Locator => flow(page).locator('[aria-current="step"]');

const fileId = idOf('file', 1);
const fieldId = idOf('fld', 1);
const vip = idOf('tag', 1);
const csv = [
  'First name,Email,Shoe size,Event date',
  'Maya,maya@example.com,38,2026-11-02',
  'Jordan,jordan@example.com,42,2026-12-24',
  'Priya,not-an-address,40,',
  '',
].join('\n');

const inspection: ImportFileInspection = {
  file: { id: fileId, filename: 'contacts.csv', size: csv.length },
  delimiter: ',',
  columns: [
    { index: 0, header: 'First name', samples: ['Maya', 'Jordan', 'Priya'] },
    { index: 1, header: 'Email', samples: ['maya@example.com', 'jordan@example.com'] },
    { index: 2, header: 'Shoe size', samples: ['38', '42', '40'] },
    { index: 3, header: 'Event date', samples: ['2026-11-02', '2026-12-24'] },
  ],
  rowCount: 3,
  suggestedMapping: [
    { column: 0, target: { kind: 'attribute', attribute: 'firstName' } },
    { column: 1, target: { kind: 'attribute', attribute: 'email' } },
  ],
  attributes: [
    'firstName',
    'lastName',
    'email',
    'additionalEmails',
    'phone',
    'additionalPhones',
    'timeZone',
    'doNotContact',
    'tags',
  ],
  fields: [{ id: fieldId, key: 'event_date', label: 'Event date', valueType: 'date' }],
  limits: { rows: 100_000, columns: 200, previewRows: 50, tags: 20 },
};

const preview: ImportPreview = {
  rows: [
    {
      row: 2,
      outcome: 'create',
      values: [
        { column: 0, target: { kind: 'attribute', attribute: 'firstName' }, value: 'Maya' },
        { column: 1, target: { kind: 'attribute', attribute: 'email' }, value: 'maya@example.com' },
        { column: 3, target: { kind: 'field', fieldId }, value: '2026-11-02' },
      ],
      issues: [],
    },
    {
      row: 3,
      outcome: 'update',
      values: [
        { column: 0, target: { kind: 'attribute', attribute: 'firstName' }, value: 'Jordan' },
        {
          column: 1,
          target: { kind: 'attribute', attribute: 'email' },
          value: 'jordan@example.com',
        },
        { column: 3, target: { kind: 'field', fieldId }, value: '2026-12-24' },
      ],
      issues: [],
    },
    {
      row: 4,
      outcome: 'fail',
      values: [
        { column: 0, target: { kind: 'attribute', attribute: 'firstName' }, value: 'Priya' },
        { column: 3, target: { kind: 'field', fieldId }, value: null },
      ],
      issues: [
        {
          column: 1,
          code: 'invalid_format',
          message: 'Enter an email address, such as maya@example.com.',
        },
      ],
    },
  ],
};

const problem = (route: Route, status: number, body: Record<string, unknown>): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    json: { type: 'about:blank', title: 'Refused', status, ...body },
  });

interface Steps {
  /** The upload as the page sent it. */
  upload: { filename: string | null; contentType: string | undefined; body: string } | undefined;
  inspected: unknown;
  previewed: unknown;
  started: unknown;
  cancelled: string[];
  /** How the next start is answered: an import that waits, or a refusal. */
  refuseStart: boolean;
}

/** Stands in for the steps of an import, beside the history of fakeImportsApi. */
async function fakeSteps(page: Page, api: ImportsApi): Promise<Steps> {
  const steps: Steps = {
    upload: undefined,
    inspected: undefined,
    previewed: undefined,
    started: undefined,
    cancelled: [],
    refuseStart: false,
  };
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({
      json: configurationOf([
        {
          id: vip,
          name: 'VIP',
          description: 'Our best customers.',
          createdAt: '2026-09-01T10:00:00.000Z',
          updatedAt: '2026-09-01T10:00:00.000Z',
        },
      ]),
    }),
  );
  await page.route(/\/api\/v1\/files\?/, (route) => {
    const request = route.request();
    steps.upload = {
      filename: new URL(request.url()).searchParams.get('filename'),
      contentType: request.headers()['content-type'],
      body: request.postData() ?? '',
    };
    return route.fulfill({
      status: 201,
      json: {
        id: fileId,
        filename: 'contacts.csv',
        contentType: 'text/csv',
        size: csv.length,
        sha256: 'a'.repeat(64),
        createdAt: '2026-10-01T10:00:00.000Z',
      },
    });
  });
  await page.route('**/api/v1/imports/inspect', (route) => {
    steps.inspected = inspectImportFileInput.parse(route.request().postDataJSON());
    return route.fulfill({ json: inspection });
  });
  await page.route('**/api/v1/imports/preview', (route) => {
    steps.previewed = previewImportInput.parse(route.request().postDataJSON());
    return route.fulfill({ json: preview });
  });
  await page.route('**/api/v1/imports', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (steps.refuseStart)
      return problem(route, 409, {
        detail: 'Another import is waiting or running. Wait for it to end.',
      });
    steps.started = importPlanInput.parse(route.request().postDataJSON());
    const job = importOf(50, {
      status: 'pending',
      fileName: 'contacts.csv',
      counts: { found: 3, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
      startedAt: null,
      finishedAt: null,
      canCancel: true,
    });
    api.imports.push(job);
    return route.fulfill({ status: 201, json: job });
  });
  await page.route(/\/api\/v1\/imports\/imp_[^/]+\/cancel$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    steps.cancelled.push(id);
    const at = api.imports.findIndex((job) => job.id === id);
    const old = api.imports[at];
    if (old === undefined) throw new Error('No such import.');
    const job = { ...old, cancelRequested: true };
    api.imports[at] = job;
    return route.fulfill({ json: job });
  });
  return steps;
}

async function chooseFile(page: Page, name = 'contacts.csv'): Promise<void> {
  // As a browser beside a spreadsheet program reports a .csv file.
  await flow(page)
    .getByLabel('CSV file', { exact: true })
    .setInputFiles({ name, mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(csv) });
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`imports a CSV file step by step, shows its progress, stops it and offers its errors at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeImportsApi(page);
    const steps = await fakeSteps(page, api);
    await page.goto(inHarbor('/settings/import'));
    await expect(page.getByRole('heading', { level: 1, name: 'Import Data' })).toBeVisible();
    await expect(page).toHaveTitle('Import Data · Harbor Lights Events');
    // One way to import, and nothing drawn for what is not built.
    await expect(
      page.getByRole('heading', { level: 2, name: 'Choose an import method' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['Import contacts from CSV']);
    await expect(page.getByText('No imports yet', { exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    const opener = page.getByRole('button', { name: 'Start CSV import', exact: true });
    await opener.click();
    await expect(step(page)).toHaveText('1Upload');
    const next = flow(page).getByRole('button', { name: 'Continue', exact: true });
    await expect(next).toBeDisabled();
    await chooseFile(page);
    await expectNoAccessibilityViolations(page);
    await next.click();

    // The file went up as text/csv, whatever the browser called it.
    await expect(step(page)).toHaveText('2Map columns');
    expect(steps.upload).toEqual({ filename: 'contacts.csv', contentType: 'text/csv', body: csv });
    expect(steps.inspected).toEqual({ fileId, object: 'contact' });
    await expect(flow(page).getByText('3 rows found in contacts.csv.')).toBeVisible();
    const columns = flow(page).getByRole('region', { name: 'Columns of the file', exact: true });
    await expect(columns.getByRole('row').filter({ hasText: 'Shoe size' })).toContainText(
      '38 · 42 · 40',
    );
    // The server's suggestions are chosen; the rest are left out.
    const fills = (header: string) =>
      flow(page).getByLabel(`What ${header} fills`, { exact: true });
    await expectChoice(fills('First name'), 'attribute:firstName');
    await expectChoice(fills('Email'), 'attribute:email');
    await expectChoice(fills('Shoe size'), 'skip');
    await expectChoice(fills('Event date'), 'skip');
    // Nothing is filled by two columns.
    await fills('Event date').click();
    await expect(page.getByRole('option', { name: 'Email', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByRole('option', { name: 'Last name', exact: true })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Escape');
    await choose(fills('Event date'), `field:${fieldId}`);
    await expectNoAccessibilityViolations(page);
    await next.click();

    await expect(step(page)).toHaveText('3Options');
    // The API has no mode of its own: the form starts on "create and update", and says so.
    const both = flow(page).getByRole('radio', {
      name: 'Create new contacts and update existing ones',
      exact: true,
    });
    await expect(both).toBeChecked();
    await expect(flow(page).getByText('Chosen to start with. Every row is used.')).toBeVisible();
    await flow(page).getByRole('radio', { name: 'Only create new contacts', exact: true }).check();
    await both.check();
    await flow(page).getByLabel('VIP', { exact: true }).check();
    await expect(
      flow(page).getByText('Importing gives no one consent to be messaged'),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await flow(page).getByRole('button', { name: 'Review', exact: true }).click();

    await expect(step(page)).toHaveText('4Review');
    const plan = {
      fileId,
      object: 'contact',
      mode: 'create_and_update',
      mapping: [
        { column: 0, target: { kind: 'attribute', attribute: 'firstName' } },
        { column: 1, target: { kind: 'attribute', attribute: 'email' } },
        { column: 3, target: { kind: 'field', fieldId } },
      ],
      delimiter: ',',
      tagIds: [vip],
    };
    expect(steps.previewed).toEqual({ ...plan, rows: 10 });
    const reviewed = flow(page).getByRole('region', { name: 'Review of the first rows' });
    await expect(reviewed.getByRole('row')).toHaveCount(4);
    await expect(reviewed.getByRole('row').nth(1)).toContainText('Create');
    await expect(reviewed.getByRole('row').nth(1)).toContainText(
      'First name: Maya · Email: maya@example.com · Event date: 2026-11-02',
    );
    await expect(reviewed.getByRole('row').nth(2)).toContainText('Update');
    // A row that would fail says why, and in which column.
    await expect(reviewed.getByRole('row').nth(3)).toContainText('Fail');
    await expect(reviewed.getByRole('row').nth(3)).toContainText(
      'Email: Enter an email address, such as maya@example.com.',
    );
    await expect(flow(page).getByText('Nothing has been written.')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    expect(steps.started).toBeUndefined();
    // Back keeps what was chosen.
    await flow(page).getByRole('button', { name: 'Back', exact: true }).click();
    await expect(flow(page).getByLabel('VIP', { exact: true })).toBeChecked();
    await flow(page).getByRole('button', { name: 'Review', exact: true }).click();
    await flow(page).getByRole('button', { name: 'Start import', exact: true }).click();

    await expect(notice(page)).toHaveText('Import started.');
    await expect(flow(page)).toBeHidden();
    await expect(opener).toBeFocused();
    expect(steps.started).toEqual(plan);
    const row = historyRow(page, 'contacts.csv');
    await expect(row).toContainText('Waiting');
    await expect(row).toContainText('You');
    await expect(row).toContainText('Contacts');

    // The worker takes it up: the row shows how far it has got, with no reload.
    const running = api.imports[0];
    if (running === undefined) throw new Error('No import was started.');
    api.imports[0] = {
      ...running,
      status: 'running',
      counts: { found: 3, processed: 1, created: 1, updated: 0, skipped: 0, failed: 0 },
    };
    await expect(row).toContainText('Importing');
    await expect(row).toContainText('1 of 3 rows');
    await expect(row.getByRole('progressbar')).toHaveAttribute('value', '33');
    await expectNoAccessibilityViolations(page);

    await row.getByRole('button', { name: 'Stop the import of contacts.csv', exact: true }).click();
    const stopping = page.getByRole('dialog', { name: 'Stop this import?', exact: true });
    await expect(stopping).toContainText('The rows already imported stay.');
    await stopping.getByRole('button', { name: 'Stop import', exact: true }).click();
    await expect(notice(page)).toHaveText('The import is stopping.');
    expect(steps.cancelled).toEqual([running.id]);
    await expect(row).toContainText('Stopping');
    await expect(row.getByRole('button')).toHaveCount(0);

    // It ends with a row that failed, and the file that says why.
    api.imports[0] = {
      ...running,
      status: 'cancelled',
      cancelRequested: true,
      canCancel: false,
      hasErrorFile: true,
      counts: { found: 3, processed: 2, created: 1, updated: 0, skipped: 0, failed: 1 },
      finishedAt: '2026-10-01T10:51:00.000Z',
    };
    await expect(row).toContainText('Cancelled');
    await expect(row).toContainText('1 created · 0 updated · 0 skipped');
    // A phone folds the counts under the status; a wide window has a column for each.
    if (width === 360) await expect(row).toContainText('3 found · 1 with errors');
    else await expect(row.getByRole('cell').nth(4)).toHaveText('1');
    await page.route(/\/api\/v1\/imports\/imp_[^/]+\/error-file-link$/, (route) =>
      route.fulfill({
        status: 201,
        json: {
          url: 'https://files.harborlights.example/errors.csv?signature=abc',
          expiresAt: '2026-10-01T11:06:00.000Z',
        },
      }),
    );
    await page.route('https://files.harborlights.example/**', (route) =>
      route.fulfill({
        contentType: 'text/csv',
        headers: { 'content-disposition': 'attachment; filename="contacts-errors.csv"' },
        body: 'Row,Reason\n4,Enter an email address\n',
      }),
    );
    const download = page.waitForEvent('download');
    await row
      .getByRole('button', {
        name: 'Download the rows of contacts.csv that were not imported',
        exact: true,
      })
      .click();
    expect((await download).url()).toBe(
      'https://files.harborlights.example/errors.csv?signature=abc',
    );

    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('import-data.png'), fullPage: true });
  });
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows the server's reasons: a file it cannot read, and an import already running", async ({
    page,
  }) => {
    const api = await fakeImportsApi(page);
    const steps = await fakeSteps(page, api);
    await page.goto(inHarbor('/settings/import'));
    await page.getByRole('button', { name: 'Start CSV import', exact: true }).click();
    const next = flow(page).getByRole('button', { name: 'Continue', exact: true });

    // Not a CSV file by its name: nothing is uploaded.
    await chooseFile(page, 'contacts.xlsx');
    await expect(flow(page).getByRole('alert')).toHaveText(
      'Choose a file whose name ends in .csv.',
    );
    await expect(next).toBeDisabled();
    expect(steps.upload).toBeUndefined();

    // A file the server refuses, in its own words.
    await page.route('**/api/v1/imports/inspect', (route) =>
      problem(route, 422, {
        errors: [
          {
            path: '/fileId',
            code: 'not_utf8',
            message: 'This file is not saved as UTF-8. Save it as UTF-8 and upload it again.',
          },
        ],
      }),
    );
    await chooseFile(page);
    await next.click();
    await expect(flow(page).getByRole('alert')).toHaveText(
      'This file is not saved as UTF-8. Save it as UTF-8 and upload it again.',
    );
    await expect(step(page)).toHaveText('1Upload');
    await page.unroute('**/api/v1/imports/inspect');
    await page.route('**/api/v1/imports/inspect', (route) => route.fulfill({ json: inspection }));
    await chooseFile(page);
    await next.click();
    await expect(step(page)).toHaveText('2Map columns');

    // A column must fill something before the import can go on.
    const fills = (header: string) =>
      flow(page).getByLabel(`What ${header} fills`, { exact: true });
    await choose(fills('First name'), 'skip');
    await choose(fills('Email'), 'skip');
    await expect(next).toBeDisabled();
    await choose(fills('Email'), 'attribute:email');
    await next.click();
    await flow(page).getByRole('button', { name: 'Review', exact: true }).click();
    steps.refuseStart = true;
    await flow(page).getByRole('button', { name: 'Start import', exact: true }).click();
    await expect(flow(page).getByRole('alert')).toHaveText(
      'Another import is waiting or running. Wait for it to end.',
    );
    await expect(step(page)).toHaveText('4Review');
    expect(api.imports).toHaveLength(0);

    // Cancel leaves everything as it was.
    await flow(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(flow(page)).toBeHidden();
    await expect(page.getByText('No imports yet', { exact: true })).toBeVisible();
  });

  test('lists the history with its filters and pages, and a failed import with its reason', async ({
    page,
  }) => {
    const imports = [
      ...Array.from({ length: 22 }, (_, at) => importOf(at + 1)),
      importOf(23, {
        status: 'failed',
        fileName: 'broken.csv',
        counts: { found: 0, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
        error: { code: 'stalled', message: 'The import stopped and could not go on.' },
        startedBy: { kind: 'api_key', name: null, you: false },
      }),
    ];
    const api = await fakeImportsApi(page, imports);
    await page.goto(inHarbor('/settings/import'));
    await expect(range(page)).toHaveText('1 - 20 of 23');
    await expect(historyTable(page).getByRole('columnheader')).toHaveText([
      'Source',
      'Imported by',
      'Status',
      'Objects',
      'Records found',
      'Errors',
      'Started',
      'Completed',
      'Actions',
    ]);
    const failed = historyRow(page, 'broken.csv');
    await expect(failed).toContainText('Failed');
    await expect(failed).toContainText('The import stopped and could not go on.');
    await expect(failed).toContainText('An API key');
    await expect(failed.getByRole('button')).toHaveCount(0);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(range(page)).toHaveText('21 - 23 of 23');
    expect(api.listed.at(-1)?.get('after')).toBe(imports[3]?.id);
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(range(page)).toHaveText('1 - 20 of 23');

    await choose(page.getByLabel('Status', { exact: true }), 'failed');
    await expect(range(page)).toHaveText('1 - 1 of 1');
    expect(api.listed.at(-1)?.get('status')).toBe('failed');
    await choose(page.getByLabel('Status', { exact: true }), 'cancelled');
    await expect(page.getByText('No imports match', { exact: true })).toBeVisible();
    await choose(page.getByLabel('Status', { exact: true }), 'all');
    await choose(page.getByLabel('Started', { exact: true }), '30');
    await expect(range(page)).toHaveText('1 - 20 of 23');
    expect(api.listed.at(-1)?.get('startedFrom')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expectNoAccessibilityViolations(page);
  });

  test('says so to someone who may not import contacts, and offers nothing', async ({ page }) => {
    const api = await fakeImportsApi(page);
    api.allowed = false;
    await page.goto(inHarbor('/settings/import'));
    await expect(page.getByRole('alert')).toHaveText('You need permission to import contacts.');
    await expect(page.getByRole('button', { name: 'Start CSV import', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
  });
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeImportsApi(page, [importOf(1)]);
    await page.goto(inHarbor('/settings/import'));
    await expect(historyRow(page, 'contacts-1.csv')).toBeVisible();
    const card = page.getByRole('main').locator('div.rounded-card').first();
    expect(await reachesRightGutter(page, card)).toBe(true);
  });
});
