// Media Storage in a browser, with the API answered by the test: upload with progress,
// folders, move, rename, search, filter, both views, preview, a public link, delete, the
// picker in the business logo box, and accessibility at a phone and a desk.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { BusinessProfile } from '@repo/contracts';
import { fakeMediaApi, mediaFileOf, mediaFolderOf, PIXEL } from './media-fixtures';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';

const SHOTS = 'reports/media-storage';

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const fitsTheWindow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PIXEL });
const pdf = (name: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7\n%%EOF\n'),
});

async function rowAction(page: Page, name: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

for (const width of [360, 1440]) {
  test.describe(`Media Storage at ${String(width)} px`, () => {
    test.use({
      viewport: { width, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });

    test('uploads, files, renames, finds, previews, shares and deletes', async ({ page }) => {
      await signedIn(page);
      const library = await fakeMediaApi(page);
      await page.goto(inHarbor('/media-storage'));

      await expect(page.getByRole('heading', { level: 1, name: 'Media Storage' })).toBeVisible();
      await expect(page).toHaveTitle('Media Storage · Harbor Lights Events');
      await expect(page.getByText('No media files found')).toBeVisible();
      await expect(page.getByTestId('media-usage')).toHaveText('0 files · 0 bytes');
      await expectAccessible(page);
      expect(await fitsTheWindow(page)).toBe(true);
      await page.screenshot({ path: `${SHOTS}/${String(width)}-empty.png`, fullPage: true });

      // Two files at once, slow enough to see them going.
      library.uploadDelay = 700;
      await page
        .getByLabel('Choose files to upload')
        .setInputFiles([png('a.png'), pdf('prices.pdf')]);
      const uploads = page.getByRole('region', { name: 'Uploads' });
      await expect(uploads.getByText('Uploading 2 files')).toBeVisible();
      await expect(uploads.getByRole('progressbar', { name: 'Upload of a.png' })).toBeVisible();
      await expect(
        uploads.getByRole('progressbar', { name: 'Upload of prices.pdf' }),
      ).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/${String(width)}-uploading.png`, fullPage: true });
      await expect(uploads.getByText('Uploaded')).toHaveCount(2);
      library.uploadDelay = 0;
      const files = page.getByRole('list', { name: 'Files' });
      await expect(files.getByRole('listitem')).toHaveCount(2);
      await expect(page.getByTestId('media-usage')).toContainText('2 files');
      expect(library.changes.filter((change) => change.operation === 'uploadFile')).toEqual([
        {
          operation: 'uploadFile',
          input: { name: 'a.png', contentType: 'image/png', folder: null },
        },
        {
          operation: 'uploadFile',
          input: { name: 'prices.pdf', contentType: 'application/pdf', folder: null },
        },
      ]);
      await expectAccessible(page);
      await uploads.getByRole('button', { name: 'Clear finished' }).click();
      await expect(uploads).toHaveCount(0);

      // A type the server does not store is refused before it is sent.
      await page
        .getByLabel('Choose files to upload')
        .setInputFiles([
          { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
        ]);
      await expect(page.getByRole('region', { name: 'Uploads' }).getByRole('alert')).toContainText(
        "This type of file can't be uploaded here.",
      );
      await page
        .getByRole('region', { name: 'Uploads' })
        .getByRole('button', { name: 'Clear finished' })
        .click();

      // A folder, and a file moved into it.
      await page.getByRole('button', { name: 'New folder' }).click();
      const newFolder = page.getByRole('dialog', { name: 'New folder' });
      await newFolder.getByLabel('Folder name').fill('Brand');
      await expectAccessible(page);
      await newFolder.getByRole('button', { name: 'Create folder' }).click();
      await expect(page.getByRole('button', { name: 'Open folder Brand' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New folder' })).toBeFocused();

      await rowAction(page, 'a.png', 'Move');
      const move = page.getByRole('dialog', { name: 'Move "a.png"' });
      await choose(move.getByRole('combobox', { name: 'Move to' }), library.folders[0]?.id ?? '');
      await move.getByRole('button', { name: 'Move' }).click();
      await expect(files.getByRole('listitem')).toHaveCount(1);
      await expect(page.getByRole('list', { name: 'Folders' }).getByText('1 file')).toBeVisible();

      await page.getByRole('button', { name: 'Open folder Brand' }).click();
      const path = page.getByRole('navigation', { name: 'Folder path' });
      await expect(path.getByText('Brand')).toHaveAttribute('aria-current', 'page');
      await expect(files.getByText('a.png')).toBeVisible();

      // Renamed where it is.
      await rowAction(page, 'a.png', 'Rename');
      const rename = page.getByRole('dialog', { name: 'Rename file' });
      await rename.getByLabel('File name').fill('');
      await rename.getByRole('button', { name: 'Rename' }).click();
      await expect(rename.getByRole('alert')).toHaveText('Give the file a name.');
      await rename.getByLabel('File name').fill('Shop front.png');
      await rename.getByRole('button', { name: 'Rename' }).click();
      await expect(files.getByText('Shop front.png')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'File renamed.' })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/${String(width)}-folder.png`, fullPage: true });

      // Back at the top, a search reads every folder.
      await path.getByRole('button', { name: 'Folders' }).click();
      await expect(files.getByText('prices.pdf')).toBeVisible();
      const search = page.getByRole('searchbox', { name: 'Search the entire media library' });
      await search.fill('shop');
      await expect(page.getByText('Results from the whole library')).toBeVisible();
      await expect(files.getByRole('listitem')).toHaveCount(1);
      await expect(files.getByText('Shop front.png')).toBeVisible();
      await search.fill('nothing like this');
      await expect(page.getByText('Nothing matches. Try another search or filter.')).toBeVisible();
      await search.fill('');
      await expect(path).toBeVisible();

      // The type filter, and the sort.
      await choose(page.getByRole('combobox', { name: 'Type of file' }), 'document');
      await expect(files.getByRole('listitem')).toHaveCount(1);
      await expect(files.getByText('prices.pdf')).toBeVisible();
      await choose(page.getByRole('combobox', { name: 'Type of file' }), 'image');
      await expect(page.getByText('No media files found')).toBeVisible();
      await choose(page.getByRole('combobox', { name: 'Type of file' }), 'all');
      await choose(page.getByRole('combobox', { name: 'Sort by' }), 'name_asc');
      await expect(files.getByText('prices.pdf')).toBeVisible();

      // The list view, and back.
      await page.getByRole('button', { name: 'List view' }).click();
      const table = page.getByRole('region', { name: 'Files' }).getByRole('table');
      await expect(table.getByRole('row')).toHaveCount(2);
      await expect(table.getByText('Document')).toBeVisible();
      await expectAccessible(page);
      expect(await fitsTheWindow(page)).toBe(true);
      await page.screenshot({ path: `${SHOTS}/${String(width)}-list.png`, fullPage: true });
      await page.getByRole('button', { name: 'Grid view' }).click();
      await expect(files).toBeVisible();

      // Several at once: moved together into the folder.
      await page.getByRole('checkbox', { name: 'Select prices.pdf' }).check();
      const bar = page.getByRole('group', { name: 'Selected files' });
      await expect(bar.getByText('1 selected')).toBeVisible();
      await bar.getByRole('button', { name: 'Move' }).click();
      const moveMany = page.getByRole('dialog', { name: 'Move "prices.pdf"' });
      await choose(
        moveMany.getByRole('combobox', { name: 'Move to' }),
        library.folders[0]?.id ?? '',
      );
      await moveMany.getByRole('button', { name: 'Move' }).click();
      await expect(page.getByText('No media files found')).toBeVisible();
      await page.getByRole('button', { name: 'Open folder Brand' }).click();
      await expect(files.getByRole('listitem')).toHaveCount(2);
      await page.screenshot({ path: `${SHOTS}/${String(width)}-grid.png`, fullPage: true });

      // A look at the picture.
      await page.getByRole('button', { name: 'Preview Shop front.png' }).click();
      const preview = page.getByRole('dialog', { name: 'Shop front.png' });
      await expect(preview.getByRole('img', { name: 'Shop front.png' })).toBeVisible();
      await expect(preview.getByText('Private')).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${SHOTS}/${String(width)}-preview.png` });
      await preview.getByRole('button', { name: 'Close' }).click();
      await expect(preview).toHaveCount(0);

      // A link: signed while the file is private, its own address once it is public.
      await rowAction(page, 'Shop front.png', 'Copy link');
      await expect(
        page.getByRole('status').filter({ hasText: 'Link copied. It works for 7 days' }),
      ).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('/api/v1/files/');
      await rowAction(page, 'Shop front.png', 'Make public');
      await expect(files.getByText('Public', { exact: true })).toBeVisible();
      await rowAction(page, 'Shop front.png', 'Copy link');
      await expect(
        page.getByRole('status').filter({ hasText: 'Public link copied.' }),
      ).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        'http://127.0.0.1:4173/m/AbCdEfGhIjKlMnOpQrStUv/Shop%20front.png',
      );
      await choose(page.getByRole('combobox', { name: 'Which files to show' }), 'public');
      await expect(page.locator('p', { hasText: /^Public files$/ })).toBeVisible();
      await expect(files.getByRole('listitem')).toHaveCount(1);
      await choose(page.getByRole('combobox', { name: 'Which files to show' }), 'mine');
      await rowAction(page, 'Shop front.png', 'Make private');
      await expect(files.getByText('Public', { exact: true })).toHaveCount(0);

      // Deleted, after the question.
      await rowAction(page, 'prices.pdf', 'Delete');
      const confirm = page.getByRole('dialog', { name: 'Delete "prices.pdf"?' });
      await expect(confirm.getByText("This can't be undone.")).toBeVisible();
      await expectAccessible(page);
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(files.getByRole('listitem')).toHaveCount(1);
      await expect(page.getByRole('status').filter({ hasText: 'Deleted.' })).toBeVisible();
      expect(library.files.map((file) => file.name)).toEqual(['Shop front.png']);

      // The folder goes; what it held moves up.
      await path.getByRole('button', { name: 'Folders' }).click();
      await rowAction(page, 'folder Brand', 'Delete');
      await page
        .getByRole('dialog', { name: 'Delete folder "Brand"?' })
        .getByRole('button', { name: 'Delete folder' })
        .click();
      await expect(page.getByRole('list', { name: 'Folders' })).toHaveCount(0);
      await expect(files.getByText('Shop front.png')).toBeVisible();
      await expectAccessible(page);
      expect(await fitsTheWindow(page)).toBe(true);
    });

    test('lets someone who may only read look, and offers nothing that changes the library', async ({
      page,
    }) => {
      await signedIn(page);
      const brand = mediaFolderOf('Brand');
      await fakeMediaApi(page, {
        canManage: false,
        folders: [brand],
        files: [
          mediaFileOf('front.png', 'image/png'),
          mediaFileOf('tour.mp4', 'video/mp4'),
          mediaFileOf('rows.csv', 'text/csv'),
        ],
      });
      await page.goto(inHarbor('/media-storage'));

      await expect(page.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(3);
      await expect(page.getByRole('button', { name: 'Upload' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New folder' })).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);
      await page.getByRole('button', { name: 'Actions for rows.csv' }).click();
      await expect(page.getByRole('menuitem')).toHaveText(['Preview', 'Copy link', 'Download']);
      await page.getByRole('menuitem', { name: 'Preview' }).click();
      const preview = page.getByRole('dialog', { name: 'rows.csv' });
      await expect(preview.getByText('Document')).toBeVisible();
      await expectAccessible(page);
      await preview.getByRole('button', { name: 'Close' }).click();
      await expectAccessible(page);
    });

    test('the business logo is chosen from Media Storage', async ({ page }) => {
      await signedIn(page);
      const logo = mediaFileOf('logo.png', 'image/png');
      const library = await fakeMediaApi(page, {
        files: [logo, mediaFileOf('menu.pdf', 'application/pdf')],
      });
      let current: BusinessProfile = {
        id: harbor.id,
        name: harbor.name,
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        address: null,
        logoFileId: null,
        canManage: true,
      };
      const saved: unknown[] = [];
      await page.route('**/api/v1/business-profile', async (route) => {
        if (route.request().method() === 'PUT') {
          saved.push(route.request().postDataJSON());
          current = { ...current, logoFileId: logo.id };
        }
        await route.fulfill({ json: current });
      });
      await page.goto(inHarbor('/settings/business'));

      await page.getByRole('button', { name: 'Choose from Media Storage' }).click();
      const picker = page.getByRole('dialog', { name: 'Choose a logo' });
      // Pictures only: the PDF is not offered for a logo.
      await expect(picker.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(
        1,
      );
      await expect(picker.getByRole('combobox', { name: 'Type of file' })).toHaveCount(0);
      await expectAccessible(page);
      expect(await fitsTheWindow(page)).toBe(true);
      await page.screenshot({ path: `${SHOTS}/${String(width)}-picker.png` });

      // A picture uploaded from the picker lands in the library, and can be chosen at once.
      await picker.getByLabel('Choose files to upload').setInputFiles([png('new-logo.png')]);
      await expect(picker.getByRole('button', { name: 'Choose new-logo.png' })).toBeVisible();
      expect(library.files.map((file) => file.name)).toContain('new-logo.png');

      await picker.getByRole('button', { name: 'Choose logo.png' }).click();
      await expect(picker).toHaveCount(0);
      await expect(page.getByText('from Media Storage: used when you save')).toBeVisible();
      await expect(page.getByRole('img', { name: 'Business logo' })).toBeVisible();

      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByRole('status')).toHaveText('Business profile saved.');
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ logoFileId: logo.id });
      // Nothing was uploaded for the logo itself: the file was there already.
      expect(library.changes.filter((change) => change.operation === 'uploadFile')).toHaveLength(1);
      await expectAccessible(page);
    });
  });
}
