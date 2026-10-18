import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { choose } from './select';
import { inHarbor, signedIn } from './session';
import { fakeSiteEditorApi } from './site-editor-fixtures';
import {
  domainId,
  fakeSitesApi,
  folderOf,
  siteOf,
  templateOf,
  type SitesApi,
} from './sites-fixtures';

const main = (page: Page): Locator => page.getByRole('main');
const dialog = (page: Page, name: string): Locator =>
  page.getByRole('dialog', { name, exact: true });
const row = (page: Page, name: string): Locator =>
  main(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name, exact: true }) });
const tabs = (page: Page): Locator =>
  page.getByRole('region', { name: 'Top bar' }).getByRole('navigation', { name: 'Sites' });

async function pick(page: Page, name: string, action: string): Promise<void> {
  await main(page)
    .getByRole('button', { name: `Actions for ${name}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

const bodyOf = (api: SitesApi, call: RegExp): unknown =>
  api.sent.findLast((each) => call.test(each.call))?.body;

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** A business with two funnels at Home, one in a folder, a website and two templates. */
async function harborSites(page: Page, options: { canManage?: boolean } = {}) {
  const campaigns = folderOf('funnel', 'Campaigns');
  const spring = siteOf('funnel', 'Spring offer', [
    ['Landing Page', 'landing'],
    ['Thank You', 'thank-you'],
  ]);
  const autumn = siteOf('funnel', 'Autumn offer', [['Landing Page', 'landing']]);
  const filed = siteOf('funnel', 'Wedding fair', [], { folderId: campaigns.id });
  const brochure = siteOf('website', 'Harbor brochure', [['Home', 'home']]);
  const api = await fakeSitesApi(page, {
    ...options,
    folders: [campaigns],
    sites: [spring, autumn, filed, brochure],
    templates: [
      templateOf('funnel', 'Lead magnet'),
      templateOf('funnel', 'Webinar sign-up', { category: 'Business', pageType: 'Webinar' }),
    ],
  });
  return { api, campaigns, spring, autumn, filed, brochure };
}

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('lists funnels and folders, opens a folder, searches, and has Websites beside it', async ({
  page,
}) => {
  const { api, campaigns } = await harborSites(page);
  await page.goto(inHarbor('/sites'));
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/sites/funnels')}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Funnels' })).toBeVisible();
  await expect(
    main(page).getByText(
      'Create and manage funnels to generate leads, appointments and receive payments.',
    ),
  ).toBeVisible();
  await expect(tabs(page).getByRole('link')).toHaveText([
    'Funnels',
    'Websites',
    'Forms',
    'Chat Widget',
  ]);
  await expect(tabs(page).getByRole('link', { name: 'Funnels' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(main(page).getByRole('columnheader')).toHaveText([
    'Name',
    'Last updated',
    'Funnel steps',
    'Actions',
  ]);
  await expect(main(page).getByRole('rowheader')).toHaveText([
    'Campaigns',
    'Spring offer',
    'Autumn offer',
  ]);
  await expect(row(page, 'Campaigns')).toContainText('1 Funnel');
  await expect(row(page, 'Spring offer')).toContainText('2 Steps');
  expect(api.lists.at(-1)).toEqual({ kind: 'funnel', folder: 'none', sort: 'updated', limit: 20 });

  await main(page).getByRole('link', { name: 'Campaigns' }).click();
  await expect(page).toHaveURL(new RegExp(`/sites/funnels/folder/${campaigns.id}$`));
  await expect(main(page).getByRole('rowheader')).toHaveText(['Wedding fair']);
  await expect(main(page).getByRole('navigation', { name: 'Folders' })).toContainText('Campaigns');
  await main(page).getByRole('navigation', { name: 'Folders' }).getByRole('link').click();

  // A search at Home looks through every folder; the List view orders by name.
  await main(page).getByRole('searchbox', { name: 'Search funnels' }).fill('wedding');
  await expect(main(page).getByRole('rowheader')).toHaveText(['Wedding fair']);
  expect(api.lists.at(-1)).toEqual({ kind: 'funnel', q: 'wedding', sort: 'updated', limit: 20 });
  await main(page).getByRole('searchbox', { name: 'Search funnels' }).fill('');
  await main(page).getByRole('button', { name: 'List', exact: true }).click();
  await expect(main(page).getByRole('rowheader')).toHaveText([
    'Campaigns',
    'Autumn offer',
    'Spring offer',
  ]);

  await tabs(page).getByRole('link', { name: 'Websites' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Websites' })).toBeVisible();
  await expect(
    main(page).getByText('Build websites to showcase your products and build a trusted brand.'),
  ).toBeVisible();
  await expect(main(page).getByRole('columnheader').nth(2)).toHaveText('Website pages');
  await expect(row(page, 'Harbor brochure')).toContainText('1 Page');
  await expect(tabs(page).getByRole('link', { name: 'Websites' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test("an empty list says GoHighLevel's sentence", async ({ page }) => {
  await fakeSitesApi(page);
  await page.goto(inHarbor('/sites/websites'));
  await expect(
    main(page).getByText(
      'Start by creating a website. All your websites and folders will live here.',
    ),
  ).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'New website' })).toHaveCount(2);
});

test('creates, renames and deletes a folder, and moves, clones and deletes a funnel', async ({
  page,
}) => {
  const { api, campaigns, spring } = await harborSites(page);
  await page.goto(inHarbor('/sites/funnels'));

  await main(page).getByRole('button', { name: 'Create folder' }).click();
  await dialog(page, 'Create folder').getByLabel('Folder name').fill('Seasonal');
  await dialog(page, 'Create folder').getByRole('button', { name: 'Create' }).click();
  await expect(main(page).getByText('Folder created.')).toBeVisible();
  expect(bodyOf(api, /^POST \/site-folders$/)).toEqual({ kind: 'funnel', name: 'Seasonal' });
  await expect(row(page, 'Seasonal')).toContainText('0 Funnels');

  await pick(page, 'the folder Seasonal', 'Rename');
  await dialog(page, 'Rename folder').getByLabel('Folder name').fill('Seasons');
  await dialog(page, 'Rename folder').getByRole('button', { name: 'Save' }).click();
  await expect(main(page).getByText('Folder renamed.')).toBeVisible();
  expect(bodyOf(api, /^PATCH \/site-folders\//)).toEqual({ name: 'Seasons', revision: 1 });

  await pick(page, 'Spring offer', 'Move to folder');
  await choose(
    dialog(page, 'Move to folder').getByRole('combobox', { name: 'Folder' }),
    campaigns.id,
  );
  await dialog(page, 'Move to folder').getByRole('button', { name: 'Move' }).click();
  await expect(main(page).getByText('Spring offer was moved.')).toBeVisible();
  expect(bodyOf(api, /^PATCH \/sites\//)).toEqual({ revision: 1, folderId: campaigns.id });
  await expect(row(page, 'Spring offer')).toHaveCount(0);
  await expect(row(page, 'Campaigns')).toContainText('2 Funnels');

  await pick(page, 'Autumn offer', 'Clone');
  await expect(main(page).getByText('Copied as Autumn offer (copy).')).toBeVisible();
  await expect(row(page, 'Autumn offer (copy)')).toBeVisible();

  await pick(page, 'Autumn offer', 'Delete');
  await expect(dialog(page, 'Delete funnel')).toContainText(
    'Autumn offer will be deleted for good',
  );
  await dialog(page, 'Delete funnel').getByRole('button', { name: 'Delete for good' }).click();
  await expect(main(page).getByText('Autumn offer was deleted.')).toBeVisible();
  await expect(row(page, 'Autumn offer')).toHaveCount(0);

  await pick(page, 'the folder Campaigns', 'Delete');
  await expect(dialog(page, 'Delete folder')).toContainText('Its funnels are kept');
  await dialog(page, 'Delete folder').getByRole('button', { name: 'Delete folder' }).click();
  await expect(main(page).getByText('The folder Campaigns was deleted.')).toBeVisible();
  await expect(row(page, 'Spring offer')).toBeVisible();
  expect(api.sites.find((each) => each.id === spring.id)?.folderId).toBeNull();
});

test('creates a funnel from blank, then adds, clones and deletes steps', async ({ page }) => {
  const { api } = await harborSites(page);
  await page.goto(inHarbor('/sites/funnels'));
  await main(page).getByRole('button', { name: 'New funnel' }).click();
  const create = dialog(page, 'Create new funnel');
  await expect(create.getByRole('radio')).toHaveCount(2);
  await expect(create.getByText('Build with AI')).toHaveCount(0);
  await expect(create.getByRole('button', { name: 'Create' })).toBeDisabled();
  await create.getByLabel('Funnel name').fill('Open day');
  await create.getByRole('button', { name: 'Create' }).click();
  expect(bodyOf(api, /^POST \/sites$/)).toEqual({
    kind: 'funnel',
    name: 'Open day',
    folderId: null,
  });

  await expect(page.getByRole('heading', { level: 1, name: 'Open day' })).toBeVisible();
  await expect(page).toHaveURL(/\/sites\/funnels\/site_[0-9a-z]{26}$/);
  await expect(main(page).getByText('This funnel has no steps yet.')).toBeVisible();
  await expect(
    main(page).getByRole('navigation', { name: 'Funnel sections' }).getByRole('link'),
  ).toHaveText(['Steps', 'Settings']);

  await main(page).getByRole('button', { name: 'Add new step' }).click();
  const add = dialog(page, 'New step in funnel');
  await add.getByLabel('Name for page').fill('Landing Page');
  await expect(add.getByLabel('Path')).toHaveValue('landing-page');
  await add.getByRole('button', { name: 'Create funnel step' }).click();
  expect(bodyOf(api, /^POST \/sites\/site_[0-9a-z]+\/steps$/)).toEqual({
    name: 'Landing Page',
    path: 'landing-page',
  });
  await expect(page).toHaveURL(/\/steps\/sstp_[0-9a-z]{26}$/);
  const detail = main(page).getByRole('region', { name: 'Landing Page', exact: true });
  await expect(detail.getByText('Not published')).toBeVisible();
  // Edit opens the page editor (e2e/site-editor.spec.ts follows it there); an unpublished
  // page has no address, and nothing is said about one.
  await expect(detail.getByRole('link', { name: 'Edit', exact: true })).toHaveAttribute(
    'href',
    /\/sites\/funnels\/site_[0-9a-z]{26}\/pages\/spg_[0-9a-z]{26}\/edit$/,
  );
  await expect(detail.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
  await expect(detail.getByText(/domain/i)).toHaveCount(0);
  await expect(detail.getByText(/Live at/)).toHaveCount(0);

  await detail.getByRole('button', { name: 'Clone Funnel Step' }).click();
  const steps = main(page).getByRole('region', { name: 'Funnel steps' });
  await expect(steps.getByRole('listitem')).toHaveCount(2);
  await expect(main(page).getByRole('region', { name: 'Landing Page (copy)' })).toBeVisible();

  // Order: the copy moves up, with the funnel's revision.
  await steps.getByRole('button', { name: 'Move Landing Page (copy) up' }).click();
  await expect(main(page).getByText('The order was saved.')).toBeVisible();
  await expect(steps.getByRole('link').first()).toContainText('Landing Page (copy)');

  await main(page).getByRole('button', { name: 'Delete Funnel Step' }).click();
  await expect(dialog(page, 'Delete Funnel Step')).toContainText('will be deleted for good');
  await dialog(page, 'Delete Funnel Step').getByRole('button', { name: 'Delete for good' }).click();
  await expect(steps.getByRole('listitem')).toHaveCount(1);
  await expect(steps.getByRole('link')).toContainText('Landing Page');

  // Publishing: the step's name and path.
  await main(page).getByRole('button', { name: 'Publishing', exact: true }).click();
  await main(page).getByLabel('Step path').fill('offers/open-day');
  await main(page).getByRole('button', { name: 'Update step' }).click();
  await expect(main(page).getByText('Step updated.')).toBeVisible();
  expect(bodyOf(api, /^PATCH \/site-steps\//)).toMatchObject({
    name: 'Landing Page',
    path: 'offers/open-day',
  });
  await expect(steps.getByRole('link')).toContainText('/offers/open-day');
});

test('creates a funnel from a template chosen in the library', async ({ page }) => {
  const { api } = await harborSites(page);
  await page.goto(inHarbor('/sites/funnels'));
  await main(page).getByRole('button', { name: 'New funnel' }).click();
  await dialog(page, 'Create new funnel')
    .getByRole('radio', { name: /From templates/ })
    .check();
  await dialog(page, 'Create new funnel').getByRole('button', { name: 'Continue' }).click();

  const library = dialog(page, 'Funnel templates');
  await expect(library.getByRole('heading', { level: 3 })).toHaveText([
    'Lead magnet',
    'Webinar sign-up',
  ]);
  await expect(
    library.getByRole('group', { name: 'Template lists' }).getByRole('button'),
  ).toHaveText(['All templates', 'My templates', 'Shared with me', 'Favorites']);
  await expect(library.getByText('Showing 2 templates')).toBeVisible();
  await library.getByRole('checkbox', { name: /Business/ }).check();
  await expect(library.getByRole('heading', { level: 3 })).toHaveText(['Webinar sign-up']);
  await library.getByRole('button', { name: 'Clear filters' }).click();
  await library.getByRole('searchbox', { name: 'Search templates' }).fill('lead');
  await expect(library.getByRole('heading', { level: 3 })).toHaveText(['Lead magnet']);

  await library.getByRole('button', { name: 'Favorite Lead magnet' }).click();
  await expect(library.getByText('Lead magnet is in your favorites.')).toBeVisible();
  await library.getByRole('searchbox', { name: 'Search templates' }).fill('');
  await library.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(library.getByRole('heading', { level: 3 })).toHaveText(['Lead magnet']);

  await library.getByRole('button', { name: 'Choose Lead magnet' }).click();
  const naming = dialog(page, 'Name your funnel');
  await expect(naming.getByLabel('Funnel name')).toHaveValue('Lead magnet');
  await naming.getByLabel('Funnel name').fill('Spring leads');
  await naming.getByRole('button', { name: 'Create' }).click();
  expect(bodyOf(api, /^POST \/sites$/)).toEqual({
    kind: 'funnel',
    name: 'Spring leads',
    folderId: null,
    templateId: api.templates[0]?.id,
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Spring leads' })).toBeVisible();
  await expect(
    main(page).getByRole('region', { name: 'Funnel steps' }).getByRole('listitem'),
  ).toHaveCount(2);
});

test('a variation and its split test are out of view until visitors are really shared', async ({
  page,
}) => {
  const { spring } = await harborSites(page);
  await page.goto(inHarbor(`/sites/funnels/${spring.id}`));
  const detail = main(page).getByRole('region', { name: 'Landing Page', exact: true });
  await expect(detail.getByRole('heading', { level: 3 })).toHaveText(['Control']);
  await expect(detail.getByRole('button', { name: 'Create variation' })).toHaveCount(0);
  await expect(main(page).getByText(/split test/i)).toHaveCount(0);
  await expect(main(page).getByText(/Variation/)).toHaveCount(0);
});

// Hidden while it does nothing: the split test comes back with stage 4, by
// SITE_STAGES.splitTests in src/sites-rules.ts, and this test with it, as it was.
test.skip('runs a split test: a variation, the shares, and a winner', async ({ page }) => {
  const { api, spring } = await harborSites(page);
  await page.goto(inHarbor(`/sites/funnels/${spring.id}`));
  const detail = main(page).getByRole('region', { name: 'Landing Page', exact: true });
  await expect(
    detail.getByText('Start split test: Optimize your lead and sales generation with split tests.'),
  ).toBeVisible();
  await detail.getByRole('button', { name: 'Create variation' }).click();
  await expect(
    main(page).getByText('Variation created as a copy of the control page.'),
  ).toBeVisible();
  expect(bodyOf(api, /\/variation$/)).toEqual({ revision: 1, copyControl: true });
  await expect(detail.getByText('50% of visitors')).toHaveCount(2);

  await detail.getByLabel('Control share (%)').fill('70');
  await detail.getByRole('button', { name: 'Start split test' }).click();
  await expect(main(page).getByText('The split test is running.')).toBeVisible();
  expect(bodyOf(api, /\/split-test$/)).toEqual({ revision: 2, active: true, controlWeight: 70 });
  await expect(detail.getByText('70% of visitors')).toBeVisible();
  await expect(detail.getByText('30% of visitors')).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Stop split test' })).toBeVisible();

  await detail.getByRole('button', { name: 'Declare the variation the winner' }).click();
  await expect(dialog(page, 'Declare winner')).toContainText(
    'the control page is deleted for good',
  );
  await dialog(page, 'Declare winner').getByRole('button', { name: 'Declare winner' }).click();
  await expect(main(page).getByText("The winner is now the step's only page.")).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Create variation' })).toBeVisible();
  expect(api.sites.find((each) => each.id === spring.id)?.steps[0]?.pages).toHaveLength(1);
});

test('a website has pages without order, variation or split test', async ({ page }) => {
  const { brochure } = await harborSites(page);
  await page.goto(inHarbor(`/sites/websites/${brochure.id}`));
  await expect(page.getByRole('heading', { level: 1, name: 'Harbor brochure' })).toBeVisible();
  await expect(main(page).getByRole('region', { name: 'Website pages' })).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Add new page' })).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Clone page' })).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Create variation' })).toHaveCount(0);
  await expect(main(page).getByText(/split test/i)).toHaveCount(0);
  await expect(tabs(page).getByRole('link', { name: 'Websites' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await main(page).getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Websites' })).toBeVisible();
});

test('saves the settings that are applied, after a refusal, and deletes the funnel', async ({
  page,
}) => {
  const { api, spring } = await harborSites(page);
  await page.goto(inHarbor(`/sites/funnels/${spring.id}`));
  const sections = main(page).getByRole('navigation', { name: 'Funnel sections' });
  // Stats and Security are out of view until something counts a visit and a domain can
  // carry a header; their addresses name no page meanwhile.
  await expect(sections.getByRole('link')).toHaveText(['Steps', 'Settings']);

  await sections.getByRole('link', { name: 'Settings' }).click();
  const form = main(page).getByRole('form', { name: 'Funnel settings' });
  // The details, then how the site remembers the way visitors arrived.
  await expect(form.getByRole('heading', { level: 2 })).toHaveText([
    'Funnel details',
    'Remember how visitors arrived',
  ]);
  await expect(form.getByRole('combobox', { name: 'Domain' })).toHaveCount(0);
  await expect(form.getByLabel('Head tracking code')).toHaveCount(0);
  await expect(form.getByRole('switch')).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
  await form.getByLabel('Name').fill('Spring offer 2027');
  await form.getByLabel('Favicon URL').fill('favicon.png');
  api.refuse(/^PATCH \/sites\//, {
    status: 422,
    errors: [
      {
        path: '/faviconUrl',
        code: 'invalid_format',
        message: 'Use a web address starting with http:// or https://.',
      },
    ],
  });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(
    form.getByText('Use a web address starting with http:// or https://.').last(),
  ).toBeVisible();
  await expect(form.getByLabel('Favicon URL')).toBeFocused();
  await form.getByLabel('Favicon URL').fill('https://harborlights.example/favicon.png');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Settings saved.')).toBeVisible();
  expect(bodyOf(api, /^PATCH \/sites\//)).toEqual({
    revision: 1,
    name: 'Spring offer 2027',
    faviconUrl: 'https://harborlights.example/favicon.png',
  });
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();

  await form.getByRole('button', { name: 'Delete funnel' }).click();
  await expect(dialog(page, 'Delete funnel')).toContainText('deleted for good');
  await dialog(page, 'Delete funnel').getByRole('button', { name: 'Delete for good' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Funnels' })).toBeVisible();
  await expect(row(page, 'Spring offer 2027')).toHaveCount(0);
});

test('the Stats and Security addresses name no page while those tabs are out of view', async ({
  page,
}) => {
  const { spring } = await harborSites(page);
  for (const tab of ['stats', 'security']) {
    await page.goto(inHarbor(`/sites/funnels/${spring.id}/${tab}`));
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  }
});

// Hidden while they do nothing: Stats comes back with stage 4,
// Security, the Domain selector, the site's path and tracking code with stage 5, the
// performance switches with stage 6 (SITE_STAGES in src/sites-rules.ts), and this test
// with them, as it was.
test.skip('shows stats and security headers, and saves settings after a refusal', async ({
  page,
}) => {
  const { api, spring } = await harborSites(page);
  await page.goto(inHarbor(`/sites/funnels/${spring.id}`));
  const sections = main(page).getByRole('navigation', { name: 'Funnel sections' });

  await sections.getByRole('link', { name: 'Stats' }).click();
  await expect(row(page, 'Landing Page').getByRole('cell')).toHaveText([
    '1,200',
    '800',
    '100',
    '12.5%',
  ]);
  await main(page).getByRole('button', { name: 'Reset' }).click();
  await expect(dialog(page, 'Reset statistics')).toContainText('for good');
  await dialog(page, 'Reset statistics').getByRole('button', { name: 'Reset for good' }).click();
  await expect(main(page).getByText('The statistics were reset.')).toBeVisible();

  await sections.getByRole('link', { name: 'Security' }).click();
  await expect(main(page).getByText('No security headers yet.')).toBeVisible();
  await main(page).getByRole('button', { name: 'Add security header' }).click();
  await dialog(page, 'Add security header').getByLabel('Header').fill('X-Frame-Options');
  await dialog(page, 'Add security header').getByLabel('Value').fill('DENY');
  await dialog(page, 'Add security header').getByRole('button', { name: 'Add' }).click();
  await expect(main(page).getByText('X-Frame-Options was added.')).toBeVisible();
  expect(bodyOf(api, /\/security-headers$/)).toEqual({
    revision: 1,
    headers: [{ name: 'X-Frame-Options', value: 'DENY' }],
  });
  await expect(row(page, 'X-Frame-Options')).toContainText('DENY');

  await sections.getByRole('link', { name: 'Settings' }).click();
  const form = main(page).getByRole('form', { name: 'Funnel settings' });
  await expect(form.getByRole('heading', { level: 2 })).toHaveText([
    'Funnel details',
    'Remember how visitors arrived',
    'Tracking and scripts',
    'Payments and checkout',
    'Performance and compliance',
    'SEO and AEO',
  ]);
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
  await form.getByLabel('Path').fill('Offers');
  await choose(form.getByRole('combobox', { name: 'Domain' }), domainId);
  await form.getByRole('switch', { name: 'GDPR compliant fonts' }).click();
  await form.getByLabel('Head tracking code').fill('<script>window.x = 1;</script>');
  api.refuse(/^PATCH \/sites\//, {
    status: 422,
    errors: [
      {
        path: '/path',
        code: 'invalid_format',
        message: 'Use lowercase letters, numbers and hyphens, with / between parts.',
      },
    ],
  });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(
    form.getByText('Use lowercase letters, numbers and hyphens, with / between parts.').last(),
  ).toBeVisible();
  await expect(form.getByLabel('Path')).toBeFocused();
  await form.getByLabel('Path').fill('offers');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Settings saved.')).toBeVisible();
  expect(bodyOf(api, /^PATCH \/sites\//)).toEqual({
    revision: 2,
    domainId,
    path: 'offers',
    headCode: '<script>window.x = 1;</script>',
    privacyFonts: true,
  });
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();

  await form.getByRole('button', { name: 'Delete funnel' }).click();
  await expect(dialog(page, 'Delete funnel')).toContainText('deleted for good');
  await dialog(page, 'Delete funnel').getByRole('button', { name: 'Delete for good' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Funnels' })).toBeVisible();
  await expect(row(page, 'Spring offer')).toHaveCount(0);
});

test('shares a funnel as text and imports one', async ({ page }) => {
  const { api, spring } = await harborSites(page);
  await page.goto(inHarbor(`/sites/funnels/${spring.id}`));
  await main(page).getByRole('button', { name: 'Share' }).click();
  await dialog(page, 'Share funnel').getByRole('button', { name: 'Create share text' }).click();
  await expect(dialog(page, 'Share funnel').getByLabel('Share text')).toHaveValue(/\S+\.\S+/);
  await dialog(page, 'Share funnel').getByRole('button', { name: 'Done' }).click();

  await main(page).getByRole('link', { name: 'Back' }).click();
  await main(page).getByRole('button', { name: 'Import' }).click();
  const bring = dialog(page, 'Import a shared funnel or website');
  await bring.getByLabel('Shared text').fill('eyJzaXRlIjoiYnVuZGxlIn0.c2lnbmF0dXJl');
  await bring.getByLabel('Name').fill('From Northwind');
  await bring.getByRole('button', { name: 'Import' }).click();
  expect(bodyOf(api, /^POST \/sites\/import$/)).toEqual({
    bundle: 'eyJzaXRlIjoiYnVuZGxlIn0.c2lnbmF0dXJl',
    name: 'From Northwind',
    folderId: null,
  });
  await expect(page.getByRole('heading', { level: 1, name: 'From Northwind' })).toBeVisible();
});

test('someone who may only read sees no way to change anything', async ({ page }) => {
  const { spring } = await harborSites(page, { canManage: false });
  await page.goto(inHarbor('/sites/funnels'));
  await expect(row(page, 'Spring offer')).toBeVisible();
  await expect(main(page).getByText(/needs permission to manage sites/)).toBeVisible();
  await expect(main(page).getByRole('button')).toHaveText(['Recent', 'List', 'Previous', 'Next']);
  await main(page).getByRole('link', { name: 'Spring offer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Spring offer' })).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Share' })).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: 'Add new step' })).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: 'Delete Funnel Step' })).toHaveCount(0);
  await page.goto(inHarbor(`/sites/funnels/${spring.id}/settings`));
  await expect(main(page).getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(main(page).getByRole('button', { name: 'Save' })).toHaveCount(0);
});

test('a refusal to read says so, and an unknown address is not found', async ({ page }) => {
  await fakeSitesApi(page, { forbidden: true });
  await page.goto(inHarbor('/sites/funnels'));
  await expect(main(page).getByRole('alert')).toHaveText(
    "You don't have permission to see this business's sites.",
  );
  await page.goto(inHarbor('/sites/stores'));
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
});

for (const width of [1440, 360]) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the lists, the dialogs and a funnel have no axe violations', async ({ page }) => {
      const { api, spring } = await harborSites(page);
      await fakeSiteEditorApi(page, api);
      await page.goto(inHarbor('/sites/funnels'));
      await expect(row(page, 'Spring offer')).toBeVisible();
      await expectNoAccessibilityViolations(page);

      await pick(page, 'Spring offer', 'Delete');
      await expect(dialog(page, 'Delete funnel')).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await dialog(page, 'Delete funnel').getByRole('button', { name: 'Cancel' }).click();

      await main(page).getByRole('button', { name: 'New funnel' }).click();
      await expect(dialog(page, 'Create new funnel')).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await dialog(page, 'Create new funnel')
        .getByRole('radio', { name: /From templates/ })
        .check();
      await dialog(page, 'Create new funnel').getByRole('button', { name: 'Continue' }).click();
      await expect(dialog(page, 'Funnel templates').getByRole('heading', { level: 3 })).toHaveCount(
        2,
      );
      await expectNoAccessibilityViolations(page);
      await dialog(page, 'Funnel templates').getByRole('button', { name: 'Close' }).click();

      await page.goto(inHarbor(`/sites/funnels/${spring.id}`));
      const detail = main(page).getByRole('region', { name: 'Landing Page', exact: true });
      await expect(detail.getByRole('link', { name: 'Edit', exact: true })).toBeVisible();
      await expectNoAccessibilityViolations(page);
      // Publish first shows what stands in the way: this page is still empty.
      await detail.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(dialog(page, 'Publish page').getByRole('listitem')).toHaveCount(1);
      await expectNoAccessibilityViolations(page);
      await dialog(page, 'Publish page').getByRole('button', { name: 'Cancel' }).click();
      await detail.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(dialog(page, 'Preview').locator('iframe')).toBeVisible();
      // The frame holds another document, the published page (stood in for here): read
      // together with the dashboard it has a second main landmark, as any framed page has.
      const preview = await new AxeBuilder({ page })
        .exclude('iframe[title="Preview of the page"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(preview.violations).toEqual([]);
      await dialog(page, 'Preview').getByRole('button', { name: 'Close' }).click();
      await main(page).getByRole('button', { name: 'Publishing', exact: true }).click();
      await expectNoAccessibilityViolations(page);

      const sections = main(page).getByRole('navigation', { name: 'Funnel sections' });
      await sections.getByRole('link', { name: 'Settings' }).click();
      await expect(main(page).getByRole('form', { name: 'Funnel settings' })).toBeVisible();
      await expectNoAccessibilityViolations(page);
    });
  });
}

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('the list and a funnel use the whole width', async ({ page }) => {
    const { spring } = await harborSites(page);
    const short = (): Promise<string[]> =>
      page.evaluate(() => {
        const edge = document.documentElement.clientWidth - 16;
        const column = document.querySelector('main > div');
        if (column === null) return ['no page'];
        const mayBeShort = new Set(['P', 'BUTTON', 'A', 'LABEL']);
        return [column, ...column.children]
          .filter((element) => !mayBeShort.has(element.tagName))
          .filter((element) => element.getBoundingClientRect().width > 0)
          .filter((element) => Math.abs(element.getBoundingClientRect().right - edge) > 1)
          .map(
            (element) =>
              `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}"`,
          );
      });
    await page.goto(inHarbor('/sites/funnels'));
    await expect(row(page, 'Spring offer')).toBeVisible();
    expect(await short()).toEqual([]);
    await page.goto(inHarbor(`/sites/funnels/${spring.id}`));
    await expect(main(page).getByRole('region', { name: 'Funnel steps' })).toBeVisible();
    expect(await short()).toEqual([]);
    await page.goto(inHarbor(`/sites/funnels/${spring.id}/settings`));
    await expect(main(page).getByRole('form', { name: 'Funnel settings' })).toBeVisible();
    expect(await short()).toEqual([]);
  });
});
