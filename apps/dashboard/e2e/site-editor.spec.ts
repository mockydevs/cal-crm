// The page editor in a browser, with the API stood in for: a page is opened from a funnel's
// step, edited from the keyboard, saved by itself, previewed, published and opened again; a
// newer version saved elsewhere is asked about; a save that never arrives keeps the work
// across a reload; a version is restored; the page document's limits are held while
// editing; a long page stays quick. And what this stage added: a picture from Media
// Storage, dragging in from the Elements list, autosaves that rewrite one working draft and
// "Save a version", what an install that serves no public page says before Publish, a
// calendar element, and when a popup opens.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import {
  mediaFile,
  pageDocument,
  updateMediaFileInput,
  type PageElement,
  type VisualPageDocument,
} from '@repo/contracts';
import { everyElementPage, longPage, smallPage } from '../src/site-editor/fixtures';
import { fakeMediaApi, mediaFileOf } from './media-fixtures';
import { choose } from './select';
import { servedDirectory } from './served-build';
import { inHarbor, signedIn } from './session';
import {
  editorCalendars,
  editorForms,
  fakeSiteEditorApi,
  type SiteEditorApi,
} from './site-editor-fixtures';
import { fakeSitesApi, siteOf, type SitesApi } from './sites-fixtures';

const reports = 'reports/site-editor';
const main = (page: Page): Locator => page.getByRole('main');
const canvas = (page: Page): FrameLocator => page.frameLocator('#preview-frame');
const node = (page: Page, id: string): Locator =>
  canvas(page).locator(`[data-puck-component="${id}"]`);
const zone = (page: Page, name: string): Locator =>
  canvas(page).locator(`[data-puck-dropzone="${name}"]`);
const childrenOf = (page: Page, name: string): Promise<string[]> =>
  zone(page, name)
    .locator(':scope > [data-puck-component]')
    .evaluateAll((all) => all.map((each) => each.getAttribute('data-puck-component') ?? ''));
const said = (page: Page): Locator => page.getByTestId('said');
const saveState = (page: Page): Locator => page.getByTestId('save-state');
const selection = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'What is selected' });
const leftPanel = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Add to the page, and its layers' });
const dialog = (page: Page, name: string | RegExp): Locator => page.getByRole('dialog', { name });
const outline = (page: Page, id: string): Locator => page.locator(`[data-outline="${id}"]`);

/** What the console said that a person would have to care about. */
function listen(page: Page): string[] {
  const heard: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      heard.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => heard.push(`pageerror: ${error.message}`));
  return heard;
}

/** The files of the build that hold the editor, and the ones Puck would fetch for rich text. */
function editorFiles(): { editor: string[]; richText: string[] } {
  const manifest = JSON.parse(
    readFileSync(join(servedDirectory, '.vite', 'manifest.json'), 'utf8'),
  ) as Record<string, { file: string }>;
  const files = (test_: (key: string) => boolean): string[] =>
    Object.entries(manifest)
      .filter(([key]) => test_(key))
      .map(([, chunk]) => chunk.file);
  return {
    editor: files((key) => /^src\/site-editor\/(?:editor|canvas)\.tsx$/.test(key)),
    richText: files((key) => key.includes('/node_modules/@puckeditor/core/dist/')),
  };
}

interface Opened {
  readonly sites: SitesApi;
  readonly api: SiteEditorApi;
  readonly siteId: string;
  readonly pageId: string;
  readonly address: string;
}

/** A funnel with two steps; the first step's page starts as the document given, or empty. */
async function funnel(
  page: Page,
  document?: VisualPageDocument,
  options: {
    readonly liveBase?: string | null;
    readonly scripts?: { readonly countdown: boolean; readonly popup: boolean };
  } = {},
): Promise<Opened> {
  await signedIn(page);
  // The sample pages name pictures at example.com: answered here, so nothing leaves the test.
  await page.route('https://example.com/**', (route) =>
    route.fulfill({
      contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'),
    }),
  );
  const spring = siteOf('funnel', 'Spring offer', [
    ['Landing Page', 'landing'],
    ['Thank You', 'thank-you'],
  ]);
  const pageId = spring.steps[0]?.pages[0]?.id ?? '';
  const sites = await fakeSitesApi(page, { sites: [spring] });
  const api = await fakeSiteEditorApi(page, sites, {
    ...(document === undefined ? {} : { documents: { [pageId]: document } }),
    ...options,
  });
  return {
    sites,
    api,
    siteId: spring.id,
    pageId,
    address: inHarbor(`/sites/funnels/${spring.id}/pages/${pageId}/edit`),
  };
}

async function openEditor(page: Page, opened: Opened): Promise<void> {
  await page.goto(opened.address);
  await expect(page.getByRole('heading', { level: 1, name: 'Landing Page' })).toBeVisible();
  await expect(canvas(page).locator('main')).toBeAttached();
}

const find = (document: unknown, id: string): Record<string, unknown> => {
  let found: Record<string, unknown> | undefined;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      if ((value as { id?: unknown }).id === id) found = value as Record<string, unknown>;
      Object.values(value).forEach(walk);
    }
  };
  walk(document);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};

/** Presses a control with the keyboard alone: the keyboard is put on it, then Enter. */
async function press(control: Locator): Promise<void> {
  await control.focus();
  await control.page().keyboard.press('Enter');
}

const visual = (document: unknown): VisualPageDocument => {
  const parsed = pageDocument.parse(document);
  if (parsed.mode !== 'visual') throw new Error('not a visual page');
  return parsed;
};

const elementsIn = (document: VisualPageDocument): PageElement[] =>
  document.sections.flatMap((section) =>
    section.type === 'section'
      ? section.rows.flatMap((row) => row.columns.flatMap((column) => column.children))
      : [],
  );

test.use({ viewport: { width: 1440, height: 900 } });

test('a page is made from the keyboard, saved by itself, previewed, published and opened live', async ({
  page,
}) => {
  const heard = listen(page);
  const requested: string[] = [];
  page.on('request', (request) => requested.push(new URL(request.url()).pathname));
  const opened = await funnel(page);
  const { api, pageId, siteId } = opened;
  const files = editorFiles();
  expect(files.editor).toHaveLength(2);

  // The funnel's page: Edit works, and nothing of the editor has been downloaded for it.
  await page.goto(inHarbor(`/sites/funnels/${siteId}`));
  const step = main(page).getByRole('region', { name: 'Landing Page', exact: true });
  await expect(step.getByTestId('publish-state')).toHaveText('Not published');
  await expect(step.getByRole('button', { name: 'Unpublish' })).toHaveCount(0);
  expect(requested.filter((path) => files.editor.some((file) => path.endsWith(file)))).toEqual([]);
  await step.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sites/funnels/${siteId}/pages/${pageId}/edit$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Landing Page' })).toBeVisible();
  await expect(canvas(page).locator('main')).toBeAttached();
  for (const file of files.editor) expect(requested.some((path) => path.endsWith(file))).toBe(true);
  // The shell is gone: the editor has the whole window.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(saveState(page)).toHaveText('Saved');
  await expect(page.getByTestId('publish-state')).toHaveText('Not published');

  // An empty page: "add a headline" makes the section, row and column it needs.
  await press(page.getByRole('button', { name: 'Add Headline', exact: true }));
  await expect(said(page)).toHaveText('Headline added to the page.');
  await expect(canvas(page).locator('h1.hl')).toHaveText('Your headline');
  await press(page.getByRole('button', { name: 'Add Form', exact: true }));
  await expect(said(page)).toHaveText('Form added after the selected Headline.');
  await expect(canvas(page).locator('.fm')).toHaveText('Form: none chosen yet');
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Form');

  // Layers is the keyboard's way to any element; the headline's text is edited as runs.
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  await press(page.getByRole('button', { name: /^Headline Your headline/ }));
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Headline');
  const text = selection(page).getByRole('textbox', { name: 'Text', exact: true });
  await text.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Spring offer');
  await expect(canvas(page).locator('h1.hl')).toHaveText('Spring offer');
  await press(selection(page).getByRole('button', { name: 'Bold', exact: true }));
  await expect(canvas(page).locator('h1.hl strong')).toHaveText('Spring offer');

  // A value for phones only: the canvas is drawn at a phone's width, by the page's own rules.
  const size = selection(page).getByRole('spinbutton', { name: 'Text size (px)' });
  const drawn = (): Promise<string> =>
    canvas(page)
      .locator('h1.hl')
      .evaluate((heading) => getComputedStyle(heading).fontSize);
  await size.fill('40');
  await expect.poll(drawn).toBe('40px');
  await press(page.getByRole('group', { name: 'Device' }).getByRole('button', { name: 'Mobile' }));
  await expect(page.getByTestId('look-fields')).toHaveAttribute('data-device', 'mobile');
  await expect(page.getByTestId('canvas-stage')).toHaveAttribute('data-width', '360');
  await expect(page.locator('#preview-frame')).toHaveJSProperty('clientWidth', 360);
  // The selection stays through the change of device.
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Headline');
  await expect(size).toHaveValue('40');
  await expect(selection(page).getByText('From a wider screen').first()).toBeVisible();
  await size.fill('22');
  await expect.poll(drawn).toBe('22px');
  await press(page.getByRole('group', { name: 'Device' }).getByRole('button', { name: 'Desktop' }));
  await expect.poll(drawn).toBe('40px');

  // Saved by itself after a pause, with the version the edits started from.
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  const firstSave = api.sent.find((each) => each.call.endsWith('/draft'))?.body as {
    baseVersion: number;
  };
  expect(firstSave.baseVersion).toBe(1);
  const saved = visual(api.documentOf(pageId));
  const [headline, form] = elementsIn(saved);
  expect(headline).toMatchObject({
    type: 'headline',
    props: { text: [{ text: 'Spring offer', bold: true }], level: 1 },
    style: { fontSize: 40 },
    responsive: { mobile: { fontSize: 22 } },
  });
  expect(form).toMatchObject({ type: 'form', props: { formId: null } });
  expect(api.calls.filter((call) => call.endsWith('/publish'))).toEqual([]);

  // Preview: the signed link of the newest saved version, in a frame and as a link.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = dialog(page, 'Preview');
  await expect(preview.locator('iframe[title="Preview of the page"]')).toHaveAttribute(
    'src',
    /^\/s\/_preview\//,
  );
  await expect(preview.getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute(
    'href',
    /^\/s\/_preview\//,
  );
  expect(api.calls.filter((call) => call.endsWith('/preview'))).toHaveLength(1);
  await preview.getByRole('button', { name: 'Close' }).click();

  // Publish shows what stands in the way, and takes the person to it.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const publish = dialog(page, 'Publish page');
  await expect(publish.getByText('Choose a form for this form element.')).toBeVisible();
  await expect(publish.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await publish.getByRole('button', { name: 'Show it' }).click();
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Form');
  await choose(
    selection(page).getByRole('combobox', { name: 'Form', exact: true }),
    editorForms[0].id,
  );
  await expect(canvas(page).locator('.fm')).toHaveText('Form: Contact us');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(publish.getByText('Nothing stands in the way.')).toBeVisible();
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  const live = dialog(page, 'The page is live');
  await expect(live.getByTestId('live-address')).toHaveText(
    'https://crm.example/s/k4v9x2m7q1w8e5r3t6y0u2i4/landing',
  );
  await expect(live.getByRole('button', { name: 'Copy the live address' })).toBeVisible();
  const openLive = live.getByRole('link', { name: 'Open the live page in a new tab' });
  await expect(openLive).toHaveText('Open live page');
  await expect(openLive).toHaveAttribute(
    'href',
    'https://crm.example/s/k4v9x2m7q1w8e5r3t6y0u2i4/landing',
  );
  await expect(openLive).toHaveAttribute('target', '_blank');
  await live.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('publish-state')).toHaveText('Published');
  // An install that serves pages says nothing about it.
  await expect(page.getByTestId('public-pages-off')).toHaveCount(0);
  // The live page is one press away from the editor too.
  await page.getByRole('button', { name: 'More for this page' }).click();
  await expect(page.getByRole('menuitem', { name: 'Open live page' })).toBeVisible();
  await page.keyboard.press('Escape');
  // The publish was of the saved version, with the page's revision, pressed by a person.
  expect(api.sent.filter((each) => each.call.endsWith('/publish'))).toHaveLength(1);

  // The funnel's page says so at once, with the address: what it draws first is already
  // the published state, from the publish's own answer, not the page as it was.
  await page.getByRole('link', { name: 'Back to the funnel' }).click();
  await expect(step.getByTestId('publish-state')).toBeVisible();
  expect(await step.getByTestId('publish-state').textContent()).toBe('Published');
  await expect(step.getByTestId('publish-state')).toHaveText('Published');
  await expect(main(page).getByTestId('live-address')).toHaveText(
    'https://crm.example/s/k4v9x2m7q1w8e5r3t6y0u2i4/landing',
  );
  await expect(step.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);

  // Edited again: what is live is no longer the newest.
  await step.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(canvas(page).locator('h1.hl')).toHaveText('Spring offer');
  await canvas(page).locator('h1.hl').click();
  await selection(page).getByRole('textbox', { name: 'Text', exact: true }).fill('Autumn offer');
  await expect(page.getByTestId('publish-state')).toHaveText(
    'Published · changes not yet published',
  );
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  await page.getByRole('link', { name: 'Back to the funnel' }).click();
  await expect(step.getByTestId('publish-state')).toHaveText(
    'Published · changes not yet published',
  );
  await expect(step.getByRole('button', { name: 'Publish changes' })).toBeVisible();

  // Nothing Puck would fetch for rich text was ever asked for.
  expect(requested.filter((path) => files.richText.some((file) => path.endsWith(file)))).toEqual(
    [],
  );
  expect(heard).toEqual([]);
});

test('a refused publish lists the server’s sentences at their elements, and unpublish asks first', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage);
  const { api } = opened;
  await openEditor(page, opened);
  // The image has no picture: the page's own problems say so before the server is asked.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const publish = dialog(page, 'Publish page');
  await expect(publish.getByText('This image has no picture yet.')).toBeVisible();
  await publish.getByRole('button', { name: 'Show it' }).click();
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Image');
  await selection(page)
    .getByRole('textbox', { name: 'Image address' })
    .fill('https://example.com/a.gif');
  await selection(page)
    .getByRole('textbox', { name: 'Description for screen readers' })
    .fill('A harbour at dusk');
  await expect(canvas(page).locator('img.im')).toHaveAttribute('alt', 'A harbour at dusk');

  // The server may still refuse: its sentences are listed, each at its element.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(publish.getByText('Nothing stands in the way.')).toBeVisible();
  api.refuse(/\/publish$/, {
    status: 422,
    errors: [
      {
        path: '/document/title',
        code: 'link_missing',
        message: 'This headline links to a step that is gone.',
      },
    ],
  });
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(
    publish.getByText('The server refused to publish it. Put these right first:'),
  ).toBeVisible();
  await expect(publish.getByText('This headline links to a step that is gone.')).toBeVisible();
  await publish.getByRole('button', { name: 'Show it' }).click();
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Headline');

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  await dialog(page, 'The page is live').getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('publish-state')).toHaveText('Published');

  await page.getByRole('button', { name: 'More for this page' }).click();
  await page.getByRole('menuitem', { name: 'Unpublish' }).click();
  const unpublish = dialog(page, 'Unpublish page');
  await expect(unpublish).toContainText('stops answering at its address at once');
  await unpublish.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await expect(page.getByTestId('publish-state')).toHaveText('Not published');
  await expect(page.getByRole('button', { name: 'More for this page' })).toHaveCount(0);
});

test('an install that serves no public page says so before Publish, and Publish explains', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage, { liveBase: null });
  const withPicture: VisualPageDocument = structuredClone(smallPage);
  Object.assign(find(withPicture, 'picture')['props'] as object, {
    src: 'https://example.com/a.gif',
    alt: 'A harbour',
  });
  opened.api.saveElsewhere(opened.pageId, withPicture);
  const reason =
    'Whoever runs the server sets PUBLIC_INTAKE_SECRET in its settings and restarts it.';
  // The funnel's own page says it up front, in the server's words.
  await page.goto(inHarbor(`/sites/funnels/${opened.siteId}`));
  await expect(main(page).getByTestId('public-pages-off')).toHaveText(
    `Visitors can't reach pages on this install yet: public pages are switched off. ${reason} You can still build, save and publish; a published page gets its address once they are on.`,
  );
  // So does the editor, before anything is pressed.
  await openEditor(page, opened);
  await expect(page.getByTestId('public-pages-off')).toContainText(
    "Visitors can't reach pages on this install yet",
  );
  await expect(page.getByTestId('public-pages-off')).toContainText(reason);
  // Preview is a public page too: it says why there is none, and asks the server for nothing.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = dialog(page, 'Preview');
  await expect(
    preview.getByText(`Public pages are switched off on this install. ${reason}`),
  ).toBeVisible();
  await expect(preview.locator('iframe')).toHaveCount(0);
  await expect(preview.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
  expect(opened.api.calls.filter((call) => call.endsWith('/preview'))).toEqual([]);
  await preview.getByRole('button', { name: 'Close' }).click();

  // Publish explains instead of failing: it still records the version to show.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const publish = dialog(page, 'Publish page');
  await expect(publish.getByTestId('publish-pages-off')).toContainText(reason);
  await expect(publish.getByTestId('publish-pages-off')).toContainText(
    'Publishing still works: it records this version as the one to show.',
  );
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  // Nothing is called live that no visitor can reach.
  const done = dialog(page, 'The page is published');
  await expect(done).toContainText("They can't reach it yet.");
  await expect(
    done.getByText(`Public pages are switched off on this install. ${reason}`),
  ).toBeVisible();
  await expect(done.getByTestId('live-address')).toHaveCount(0);
  await expect(dialog(page, 'The page is live')).toHaveCount(0);
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('publish-state')).toHaveText('Published');
  await page.getByRole('link', { name: 'Back to the funnel' }).click();
  await expect(
    main(page)
      .getByRole('region', { name: 'Landing Page', exact: true })
      .getByText(`Public pages are switched off on this install. ${reason}`),
  ).toBeVisible();
});

test('a newer version saved elsewhere is asked about: keep mine, or load theirs', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage);
  const { api, pageId } = opened;
  await openEditor(page, opened);
  const theirs: VisualPageDocument = structuredClone(smallPage);
  Object.assign(find(theirs, 'title')['props'] as object, { text: [{ text: 'Their headline' }] });
  api.saveElsewhere(pageId, theirs);

  await node(page, 'title').click();
  const text = selection(page).getByRole('textbox', { name: 'Text', exact: true });
  await text.fill('My headline');
  const asked = dialog(page, 'A newer version was saved');
  await expect(asked).toContainText('Maya Okafor saved version 2 of this page', {
    timeout: 10_000,
  });
  await expect(saveState(page)).toHaveText('Not saved: someone else saved a newer version.');
  // Looking changes nothing; theirs is drawn by the page's own renderer.
  await asked.getByRole('button', { name: 'Look at theirs' }).click();
  await expect(asked.frameLocator('iframe[title="The newer version"]').locator('h1')).toHaveText(
    'Their headline',
  );
  await asked.getByRole('button', { name: 'Keep mine' }).click();
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  // Mine was saved on top of theirs, which is still a version.
  expect(api.sent.filter((each) => each.call.endsWith('/draft')).at(-1)?.body).toMatchObject({
    baseVersion: 2,
  });
  expect(api.versionsOf(pageId).map((version) => version.number)).toEqual([1, 2, 3]);
  expect(find(api.versionsOf(pageId)[1]?.document, 'title')['props']).toMatchObject({
    text: [{ text: 'Their headline' }],
  });
  expect(find(api.documentOf(pageId), 'title')['props']).toMatchObject({
    text: [{ text: 'My headline' }],
  });

  // Again, and this time theirs is loaded: mine goes, and the page says it is saved.
  const again: VisualPageDocument = structuredClone(theirs);
  Object.assign(find(again, 'title')['props'] as object, { text: [{ text: 'Theirs again' }] });
  api.saveElsewhere(pageId, again);
  await node(page, 'title').click();
  await text.fill('Mine again');
  await expect(asked).toBeVisible({ timeout: 10_000 });
  await asked.getByRole('button', { name: 'Load theirs' }).click();
  await expect(node(page, 'title')).toHaveText('Theirs again');
  await expect(saveState(page)).toHaveText('Saved');
  expect(find(api.documentOf(pageId), 'title')['props']).toMatchObject({
    text: [{ text: 'Theirs again' }],
  });
});

test('a save that never arrives keeps the work, tries again, and a reload offers it back', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage);
  const { api, pageId } = opened;
  await openEditor(page, opened);
  const cut = api.cut(/^PUT .*\/draft$/);
  await node(page, 'title').click();
  await selection(page)
    .getByRole('textbox', { name: 'Text', exact: true })
    .fill('Kept through it all');
  await expect(saveState(page)).toHaveText(
    "Not saved: the save didn't arrive. Trying again by itself.",
    { timeout: 10_000 },
  );
  // It is tried again by itself: a second request leaves without anyone pressing anything.
  await expect
    .poll(() => api.calls.filter((call) => call.endsWith('/draft')).length, { timeout: 10_000 })
    .toBeGreaterThan(1);
  await expect(node(page, 'title')).toHaveText('Kept through it all');

  // The tab is closed and opened again while the server still has nothing.
  await page.reload();
  const offer = dialog(page, 'Restore unsaved changes?');
  await expect(offer).toBeVisible();
  await expect(node(page, 'title')).toHaveText('Welcome');
  cut.restore();
  await offer.getByRole('button', { name: 'Restore them' }).click();
  await expect(node(page, 'title')).toHaveText('Kept through it all');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(find(api.documentOf(pageId), 'title')['props']).toMatchObject({
    text: [{ text: 'Kept through it all' }],
  });
  // Once the server has it, nothing is offered the next time.
  await page.reload();
  await expect(node(page, 'title')).toHaveText('Kept through it all');
  await expect(offer).toHaveCount(0);
});

test('a page that cannot be saved as it stands says what to put right, and leaving asks', async ({
  page,
}) => {
  const opened = await funnel(page, everyElementPage);
  const { api } = opened;
  await openEditor(page, opened);
  // A button of the page opens the popup "Claim the offer". With the popup deleted the
  // button leads nowhere, and the contract refuses the page until that is put right.
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  await press(outline(page, 'claim'));
  await press(selection(page).getByRole('button', { name: 'Delete Popup' }));
  await expect(saveState(page)).toHaveText('Not saved: 1 to put right first.', { timeout: 10_000 });
  await page.waitForTimeout(2500);
  expect(api.sent).toEqual([]);
  await page.getByRole('button', { name: 'Show what' }).click();
  const unsaved = dialog(page, 'Not saved yet');
  await expect(unsaved.getByRole('listitem')).toHaveText(/This page has no such popup\./);

  // Leaving with work the server does not have asks first; staying keeps everything.
  await unsaved.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('link', { name: 'Back to the funnel' }).click();
  const leave = dialog(page, 'Leave with unsaved changes?');
  await expect(leave).toContainText('kept in this browser');
  await leave.getByRole('button', { name: 'Stay and keep editing' }).click();

  await page.getByRole('button', { name: 'Show what' }).click();
  await unsaved.getByRole('button', { name: 'Show it' }).click();
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Button');
  await choose(
    selection(page).getByRole('combobox', { name: 'Pressing the button goes to' }),
    'none',
  );
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(api.sent).toHaveLength(1);

  // A box keeps what the page would not take, and says why: a button is never left
  // without a label, so the page stays one that can be saved.
  const label = selection(page).getByRole('textbox', { name: 'Label', exact: true });
  await label.fill('');
  await expect(selection(page).getByText('A button needs a label.')).toBeVisible();
  await expect(node(page, 'hero-cta')).toHaveText('Claim it');
  await expect(saveState(page)).toHaveText('Saved');
  await label.fill('Go on');
  await expect(node(page, 'hero-cta')).toHaveText('Go on');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  // With everything saved, leaving does not ask.
  await page.getByRole('link', { name: 'Back to the funnel' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Spring offer' })).toBeVisible();
});

test('versions are listed, looked at and restored as the draft', async ({ page }) => {
  const opened = await funnel(page, smallPage);
  const { api, pageId } = opened;
  await openEditor(page, opened);
  await node(page, 'title').click();
  await selection(page).getByRole('textbox', { name: 'Text', exact: true }).fill('Second thoughts');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });

  await page.getByRole('button', { name: 'Versions' }).click();
  const versions = dialog(page, 'Versions');
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  await expect(versions.getByRole('listitem').first()).toContainText('Version 2');
  await expect(versions.getByRole('listitem').first()).toContainText('Newest');
  await expect(versions.getByRole('listitem').first()).toContainText('Dana Brooks');
  // The newest is what is open: it cannot be restored onto itself.
  await expect(versions.getByRole('button', { name: 'Restore version 2' })).toHaveCount(0);

  await versions.getByRole('button', { name: 'Look at version 1' }).click();
  const looking = dialog(page, 'Version 1, to look at');
  await expect(
    looking.frameLocator('iframe[title="Version 1 of the page"]').locator('h1'),
  ).toHaveText('Welcome');
  await looking.getByRole('button', { name: 'Back to the list of versions' }).click();

  await versions.getByRole('button', { name: 'Restore version 1' }).click();
  const confirm = dialog(page, 'Restore version 1');
  await expect(confirm).toContainText('The live page does not change');
  await confirm.getByRole('button', { name: 'Restore as the draft' }).click();
  await expect(node(page, 'title')).toHaveText('Welcome');
  await expect(saveState(page)).toHaveText('Saved');
  expect(api.sent.at(-1)).toMatchObject({ body: { version: 1, revision: 2 } });
  expect(api.versionsOf(pageId).map((version) => version.restoredFrom)).toEqual([null, null, 1]);
});

test('every move is a button: up, down, to another column, copy, delete, undo', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage);
  await openEditor(page, opened);
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  await press(outline(page, 'title'));
  expect(await childrenOf(page, 'left:children')).toEqual(['title', 'copy']);
  await expect(
    selection(page).getByText('Section 1 › Row 1 › Column 1 › Headline 1'),
  ).toBeVisible();
  await expect(selection(page).getByRole('button', { name: 'Move Headline up' })).toBeDisabled();

  await press(selection(page).getByRole('button', { name: 'Move Headline down' }));
  await expect.poll(() => childrenOf(page, 'left:children')).toEqual(['copy', 'title']);
  await expect(said(page)).toHaveText('Headline moved to place 2 of 2.');

  await choose(
    selection(page).getByRole('combobox', { name: 'Move Headline to' }),
    'right:children',
  );
  await expect.poll(() => childrenOf(page, 'right:children')).toEqual(['picture', 'title']);
  await expect(said(page)).toHaveText('Headline moved to Section 1 › Row 1 › Column 2.');

  await press(selection(page).getByRole('button', { name: 'Duplicate Headline' }));
  await expect(said(page)).toHaveText('Headline duplicated.');
  await expect.poll(async () => (await childrenOf(page, 'right:children')).length).toBe(3);

  await press(selection(page).getByRole('button', { name: 'Select what holds this Headline' }));
  await expect(said(page)).toHaveText('Column selected.');
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Column');
  // A row keeps at least one column, so a column is moved and deleted by rule.
  await press(selection(page).getByRole('button', { name: 'Move Column left' }));
  await expect.poll(() => childrenOf(page, 'top-row:columns')).toEqual(['right', 'left']);

  await press(outline(page, 'copy'));
  // History is written a quarter of a second after the last change, so changes made
  // faster than a person makes them are one step of undo. A person's pace, then.
  await page.waitForTimeout(400);
  await press(selection(page).getByRole('button', { name: 'Delete Paragraph' }));
  await expect(said(page)).toHaveText('Paragraph deleted. Undo brings it back.');
  await expect.poll(() => childrenOf(page, 'left:children')).toEqual([]);
  await expect(selection(page).getByRole('heading', { level: 2, name: 'Page' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await page.waitForTimeout(400);
  await press(page.getByRole('button', { name: 'Undo' }));
  await expect.poll(() => childrenOf(page, 'left:children')).toEqual(['copy']);
  await press(page.getByRole('button', { name: 'Redo' }));
  await expect.poll(() => childrenOf(page, 'left:children')).toEqual([]);
});

test('the page document’s limits are held while editing, with a plain sentence', async ({
  page,
}) => {
  // A column with fifty elements, a row with six columns, and containers three deep.
  const full: VisualPageDocument = structuredClone(smallPage);
  const left = find(full, 'left') as { children: PageElement[] };
  left.children = Array.from({ length: 50 }, (_, at) => ({
    id: `p${String(at)}`,
    type: 'paragraph' as const,
    props: { text: [{ text: `Line ${String(at)}` }] },
  }));
  const row = find(full, 'top-row') as { columns: unknown[] };
  for (let at = 0; at < 4; at += 1)
    row.columns.push({
      id: `extra${String(at)}`,
      type: 'column',
      props: { span: 2 },
      children: [],
    });
  const opened = await funnel(page, full);
  const { api } = opened;
  await openEditor(page, opened);
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));

  await press(outline(page, 'p49'));
  await press(leftPanel(page).getByRole('button', { name: 'Elements', exact: true }));
  await press(page.getByRole('button', { name: 'Add Paragraph', exact: true }));
  await expect(said(page)).toHaveText('A column or a container holds at most 50 elements.');
  await press(selection(page).getByRole('button', { name: 'Duplicate Paragraph' }));
  await expect(said(page)).toHaveText('A column or a container holds at most 50 elements.');
  expect(await childrenOf(page, 'left:children')).toHaveLength(50);

  await press(page.getByRole('button', { name: 'Add Column', exact: true }));
  await expect(said(page)).toHaveText('A row holds at most 6 columns.');
  expect(await childrenOf(page, 'top-row:columns')).toHaveLength(6);

  // The column itself says it is full, and the canvas takes no drop into it.
  await press(selection(page).getByRole('button', { name: 'Select what holds this Paragraph' }));
  await expect(selection(page).getByText(/This Column is full: it holds 50/)).toBeVisible();
  // Moving into a full column is offered as refused.
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  await press(outline(page, 'picture'));
  await selection(page).getByRole('combobox', { name: 'Move Image to' }).click();
  await expect(
    page.getByRole('option', { name: 'Section 1 › Row 1 › Column 1', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  // Nothing was changed, so nothing was saved.
  expect(api.sent).toEqual([]);
});

test('containers nest three deep and no deeper', async ({ page }) => {
  const opened = await funnel(page, everyElementPage);
  await openEditor(page, opened);
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  // box-3 is the deepest container the format allows: it takes an element, not a container.
  await node(page, 'deep-text').click();
  await press(selection(page).getByRole('button', { name: 'Select what holds this Paragraph' }));
  await expect(selection(page).getByText(/Container 7 › Container 1 › Container 1$/)).toBeVisible();
  await press(leftPanel(page).getByRole('button', { name: 'Elements', exact: true }));
  await press(page.getByRole('button', { name: 'Add Container', exact: true }));
  // It cannot go inside, so it goes after the container, where one may still be.
  await expect(said(page)).toHaveText('Container added after the selected Container.');
  expect(await childrenOf(page, 'box-3:children')).toEqual(['deep-text']);
  await expect.poll(async () => (await childrenOf(page, 'box-2:children')).length).toBe(2);
  // An element that is not a container still goes into the deepest one.
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  await press(outline(page, 'box-3'));
  await press(leftPanel(page).getByRole('button', { name: 'Elements', exact: true }));
  await press(page.getByRole('button', { name: 'Add Divider', exact: true }));
  await expect(said(page)).toHaveText('Divider added inside the selected Container.');
  await expect.poll(async () => (await childrenOf(page, 'box-3:children')).length).toBe(2);
});

test('a page with every element type is drawn as it publishes, and saved as it was but for the edit', async ({
  page,
}) => {
  const heard = listen(page);
  const opened = await funnel(page, everyElementPage);
  const { api, pageId } = opened;
  await openEditor(page, opened);
  // Popups apart from the sections, the saved section as a reference, tenant code as a
  // notice and never as markup.
  await expect(zone(page, 'root:popups').locator(':scope > [data-puck-component]')).toHaveCount(2);
  await expect(node(page, 'shared-footer')).toContainText('shown here by reference');
  await expect(node(page, 'details-code')).toHaveText('Custom code runs on your connected domain.');
  await expect(canvas(page).locator('script')).toHaveCount(0);
  expect(await page.title()).not.toBe('tenant code ran');
  // The published page's own class names and rules: a section, its width, a row of columns.
  await expect(canvas(page).locator('section.sc.sc-wide > .ez > .rw').first()).toBeVisible();
  await expect(node(page, 'hero-title')).toHaveCSS('font-size', '48px');
  await expect(node(page, 'hero-cta')).toHaveCSS('background-color', 'rgb(15, 118, 110)');
  await expect(node(page, 'hero-left')).toHaveCSS('flex-grow', '7');
  // Nothing was touched, so nothing was saved.
  await page.waitForTimeout(2500);
  expect(api.sent).toEqual([]);
  await expect(saveState(page)).toHaveText('Saved');

  await node(page, 'hero-sub').click();
  await selection(page)
    .getByRole('textbox', { name: 'Text', exact: true })
    .fill('Three weeks only');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  const expected: VisualPageDocument = structuredClone(everyElementPage);
  Object.assign(find(expected, 'hero-sub')['props'] as object, {
    text: [{ text: 'Three weeks only', italic: true }],
  });
  expect(api.documentOf(pageId)).toStrictEqual(expected);
  expect(heard).toEqual([]);
});

test('an element is dragged to another place with the pointer', async ({ page }) => {
  const opened = await funnel(page, smallPage);
  await openEditor(page, opened);
  // The canvas registers its drop zones just after it is drawn.
  await page.waitForTimeout(800);
  expect(await childrenOf(page, 'left:children')).toEqual(['title', 'copy']);
  const from = await node(page, 'copy').boundingBox();
  const to = await node(page, 'title').boundingBox();
  if (from === null || to === null) throw new Error('nothing to drag');
  // As slowly as a hand: the canvas waits 200 ms and 5 px before a drag starts, and its
  // drop target follows the pointer's movement over time.
  const x = from.x + 40;
  const y = from.y + from.height / 2;
  const toY = to.y + to.height * 0.1;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  for (let step = 1; step <= 40; step += 1) {
    await page.mouse.move(x, y + ((toY - y) * step) / 40);
    await page.waitForTimeout(25);
  }
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.move(x + step * 2, toY + step);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await expect.poll(() => childrenOf(page, 'left:children')).toEqual(['copy', 'title']);
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(elementsIn(visual(opened.api.documentOf(opened.pageId))).map((each) => each.id)).toEqual([
    'copy',
    'title',
    'picture',
  ]);
});

test('a picture is chosen from Media Storage: made public after one question, its address and size kept', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage);
  const { api, pageId } = opened;
  const stored = mediaFileOf('storefront.png', 'image/png');
  const library = await fakeMediaApi(page, { files: [stored] });
  // The library's stand-in answers at the test server's own plain address. A real install
  // has a secure one, which is what a page takes: making the file public gives it here.
  const live = 'https://media.example/m/AbCdEfGhIjKlMnOpQrStUv/storefront.png';
  const made: unknown[] = [];
  await page.route(/\/api\/v1\/media\/file_[^/?]+$/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const input = updateMediaFileInput.parse(route.request().postDataJSON());
    made.push(input);
    const changed = mediaFile.parse({ ...stored, public: true, publicUrl: live });
    library.files = library.files.map((file) => (file.id === stored.id ? changed : file));
    return route.fulfill({ json: changed });
  });
  // The picture itself, 640 by 480, wherever it is asked for.
  await page.route('https://media.example/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#0f766e"/></svg>',
    }),
  );
  await openEditor(page, opened);
  await node(page, 'picture').click();
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Image');
  await expect(
    selection(page).getByText("The page can't be published until this image has a picture."),
  ).toBeVisible();

  const choose = selection(page).getByRole('button', {
    name: 'Image address: choose from Media Storage',
  });
  await press(choose);
  const picker = dialog(page, 'Choose a picture');
  await picker.getByRole('button', { name: 'Choose storefront.png' }).click();
  // A private file: one sentence says what using it does, and nothing is changed before a yes.
  const asked = dialog(page, 'Make "storefront.png" public?');
  await expect(asked).toContainText(
    'A page needs a picture anyone can open. "storefront.png" is private now: using it makes it public',
  );
  expect(made).toEqual([]);
  await asked.getByRole('button', { name: 'Make public and use it' }).click();
  await expect(asked).toHaveCount(0);
  expect(made).toEqual([{ public: true }]);

  // The page keeps the file's public address and the picture's own size, and draws it.
  await expect(selection(page).getByRole('textbox', { name: 'Image address' })).toHaveValue(live);
  await expect(selection(page).getByTestId('picture-size')).toContainText('640 × 480 px');
  await expect(canvas(page).locator('img.im')).toHaveAttribute('src', live);
  await expect(canvas(page).locator('img.im')).toHaveAttribute('width', '640');
  await expect(canvas(page).locator('img.im')).toHaveAttribute('height', '480');
  await expect(choose).toBeFocused();
  // A new picture owes a description, or the mark that it is decoration.
  await expect(selection(page).getByTestId('alt-prompt')).toHaveText(
    'Describe the picture, or mark it below as decoration only.',
  );
  await selection(page)
    .getByRole('textbox', { name: 'Description for screen readers' })
    .fill('Our shop front');
  await expect(selection(page).getByTestId('alt-prompt')).toHaveCount(0);
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(find(api.documentOf(pageId), 'picture')['props']).toStrictEqual({
    src: live,
    alt: 'Our shop front',
    action: { type: 'none' },
    optimize: true,
    width: 640,
    height: 480,
  });

  // A pasted address is measured the same way; an emptied box takes the size with it.
  await page.route('https://example.com/wide.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="300"/>',
    }),
  );
  await selection(page)
    .getByRole('textbox', { name: 'Image address' })
    .fill('https://example.com/wide.svg');
  await expect(selection(page).getByTestId('picture-size')).toContainText('1200 × 300 px');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(find(api.documentOf(pageId), 'picture')['props']).toMatchObject({
    src: 'https://example.com/wide.svg',
    width: 1200,
    height: 300,
  });

  // The page's own pictures are chosen the same way: its background, from the library.
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  await press(outline(page, 'picture'));
  await press(selection(page).getByRole('button', { name: 'Delete Image' }));
  await press(
    selection(page).getByRole('button', {
      name: 'Picture for social sharing: choose from Media Storage',
    }),
  );
  // Public by now, so it is used at once, with no question.
  await dialog(page, 'Choose a picture for social sharing')
    .getByRole('button', { name: 'Choose storefront.png' })
    .click();
  await expect(
    selection(page).getByRole('textbox', { name: 'Picture for social sharing' }),
  ).toHaveValue(live);
  expect(made).toHaveLength(1);
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(visual(api.documentOf(pageId)).settings.seo.imageUrl).toBe(live);
});

test('a file with no secure address is not put on a page, and the editor says why', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage);
  // As on a developer's machine: the install is reached over plain http.
  await fakeMediaApi(page, {
    files: [
      mediaFileOf('storefront.png', 'image/png', {
        public: true,
        publicUrl: 'http://127.0.0.1:4173/m/AbCdEfGhIjKlMnOpQrStUv/storefront.png',
      }),
    ],
  });
  await openEditor(page, opened);
  await node(page, 'picture').click();
  await selection(page)
    .getByRole('button', { name: 'Image address: choose from Media Storage' })
    .click();
  await dialog(page, 'Choose a picture')
    .getByRole('button', { name: 'Choose storefront.png' })
    .click();
  const told = dialog(page, "This file can't be used on a page here");
  await expect(told).toContainText('A page takes pictures from secure addresses only (https://).');
  await told.getByRole('button', { name: 'Close' }).click();
  await expect(selection(page).getByRole('textbox', { name: 'Image address' })).toHaveValue('');
  await page.waitForTimeout(2000);
  expect(opened.api.sent).toEqual([]);
});

test('an element is dragged from the Elements list onto the page, and a row arrives with its column', async ({
  page,
}) => {
  const heard = listen(page);
  const opened = await funnel(page, smallPage);
  const { api, pageId } = opened;
  await openEditor(page, opened);
  // The canvas registers its drop zones just after it is drawn.
  await page.waitForTimeout(800);
  /** Drags a tile of the list to a point of the page, as slowly as a hand does. */
  const dragTile = async (type: string, to: { x: number; y: number }): Promise<void> => {
    const tile = await leftPanel(page).locator(`[data-tile="${type}"]`).last().boundingBox();
    if (tile === null) throw new Error(`no tile for ${type}`);
    const from = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.waitForTimeout(400);
    for (let step = 1; step <= 40; step += 1) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * step) / 40,
        from.y + ((to.y - from.y) * step) / 40,
      );
      await page.waitForTimeout(25);
    }
    for (let step = 0; step < 6; step += 1) {
      await page.mouse.move(to.x + step, to.y + step);
      await page.waitForTimeout(60);
    }
    await page.mouse.up();
  };
  const boxOf = async (
    id: string,
  ): Promise<{ x: number; y: number; width: number; height: number }> => {
    const box = await node(page, id).boundingBox();
    if (box === null) throw new Error(`nothing drawn for ${id}`);
    return box;
  };

  // A tile is for the pointer; the keyboard and a screen reader have the button beside it.
  const tile = leftPanel(page).locator('[data-tile="button"]').last();
  await expect(tile).toBeVisible();
  expect(await tile.evaluate((element) => element.closest('[aria-hidden="true"]') !== null)).toBe(
    true,
  );
  expect(
    await leftPanel(page)
      .locator('[data-puck-drawer-item]')
      .evaluateAll((items) => items.filter((item) => item.hasAttribute('tabindex')).length),
  ).toBe(0);
  await expect(
    leftPanel(page).getByRole('button', { name: 'Add Button', exact: true }),
  ).toBeVisible();
  await expect(leftPanel(page).getByText('Or drag one onto the page')).toBeVisible();

  // A button, dropped under the paragraph of the left column.
  const copy = await boxOf('copy');
  await dragTile('button', { x: copy.x + 60, y: copy.y + copy.height * 0.9 });
  await expect.poll(async () => (await childrenOf(page, 'left:children')).length).toBe(3);
  expect((await childrenOf(page, 'left:children')).slice(0, 2)).toEqual(['title', 'copy']);
  await expect(said(page)).toHaveText('Button added where it was dropped.');
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Button');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  const dropped = elementsIn(visual(api.documentOf(pageId)));
  expect(dropped.map((each) => each.type)).toEqual(['headline', 'paragraph', 'button', 'image']);
  expect(dropped[2]).toMatchObject({ props: { label: 'Click here', action: { type: 'none' } } });

  // A place takes only its own kind: a headline dropped on the row's own strip of columns
  // lands in a column, never beside the columns; the row still has its two.
  expect(await childrenOf(page, 'top-row:columns')).toEqual(['left', 'right']);

  // A row dropped on the section comes with its first column, as the page document asks.
  const row = await boxOf('top-row');
  await dragTile('row', { x: row.x + row.width / 2, y: row.y + row.height - 4 });
  await expect.poll(async () => (await childrenOf(page, 'top:rows')).length).toBe(2);
  const [, newRow = ''] = await childrenOf(page, 'top:rows');
  await expect.poll(async () => (await childrenOf(page, `${newRow}:columns`)).length).toBe(1);
  await expect(said(page)).toHaveText('Row added where it was dropped.');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  const saved = visual(api.documentOf(pageId));
  const [top] = saved.sections;
  if (top?.type !== 'section') throw new Error('a section');
  expect(top.rows).toHaveLength(2);
  expect(top.rows[1]?.columns).toHaveLength(1);
  // Undo takes the dropped row away, column and all.
  await page.waitForTimeout(400);
  await press(page.getByRole('button', { name: 'Undo' }));
  await expect.poll(async () => (await childrenOf(page, 'top:rows')).length).toBe(1);
  expect(heard).toEqual([]);
});

test('a full column takes no drop, and a full page lets nothing be picked up', async ({ page }) => {
  // A column with fifty elements: the most it may hold.
  const full: VisualPageDocument = structuredClone(smallPage);
  const left = find(full, 'left') as { children: PageElement[] };
  left.children = Array.from({ length: 50 }, (_, at) => ({
    id: `p${String(at)}`,
    type: 'divider' as const,
    props: { thickness: 1, line: 'solid' as const, color: null },
  }));
  const opened = await funnel(page, full);
  await openEditor(page, opened);
  await page.waitForTimeout(800);
  const tile = await leftPanel(page).locator('[data-tile="paragraph"]').last().boundingBox();
  const target = await node(page, 'p3').boundingBox();
  if (tile === null || target === null) throw new Error('nothing to drag');
  await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  for (let step = 1; step <= 40; step += 1) {
    await page.mouse.move(
      tile.x + ((target.x + 40 - tile.x) * step) / 40,
      tile.y + ((target.y + 2 - tile.y) * step) / 40,
    );
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(800);
  expect(await childrenOf(page, 'left:children')).toHaveLength(50);
  await page.waitForTimeout(2000);
  expect(opened.api.sent).toEqual([]);
});

test('autosaves rewrite one working draft, and "Save a version" keeps one named version', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage);
  const { api, pageId } = opened;
  await openEditor(page, opened);
  await node(page, 'title').click();
  const text = selection(page).getByRole('textbox', { name: 'Text', exact: true });
  // Four rounds of editing, each saved by itself after its pause.
  for (const words of ['One', 'One two', 'One two three', 'Four in all']) {
    await text.fill(words);
    await expect(saveState(page)).toHaveText('Not saved');
    await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  }
  const saves = api.sent.filter((each) => each.call.endsWith('/draft'));
  expect(saves.length).toBeGreaterThanOrEqual(4);
  // Each said it was the editor's own save, with the revision the page then had.
  expect(saves.map((each) => (each.body as { autosave?: boolean }).autosave)).toEqual(
    saves.map(() => true),
  );
  expect(saves.map((each) => (each.body as { revision?: number }).revision)).toEqual(
    saves.map((_, at) => at + 1),
  );
  // Four saves, one version: the page as created, and the working draft.
  expect(api.versionsOf(pageId).map((version) => version.number)).toEqual([1, 2]);

  await page.getByRole('button', { name: 'Versions' }).click();
  const versions = dialog(page, 'Versions');
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  const draft = versions.getByTestId('versions-draft');
  await expect(draft.getByRole('heading', { level: 3 })).toHaveText('Working draft');
  await expect(draft.getByRole('listitem')).toHaveCount(1);
  await expect(draft.getByRole('listitem')).toContainText('Version 2');
  await expect(versions.getByTestId('versions-kept').getByRole('listitem')).toHaveCount(1);
  await expect(versions.getByTestId('versions-checkpoints')).toHaveCount(0);

  // Kept on purpose, under a name: the working draft becomes that version.
  await versions
    .getByRole('textbox', { name: 'Name for this version (optional)' })
    .fill('Before the launch');
  await versions.getByRole('button', { name: 'Save a version' }).click();
  await expect(versions.getByTestId('version-kept')).toHaveText(
    'Kept as version 2, "Before the launch".',
  );
  expect(api.sent.at(-1)?.body).toMatchObject({
    baseVersion: 2,
    name: 'Before the launch',
    revision: saves.length + 1,
  });
  expect(api.sent.at(-1)?.body).not.toHaveProperty('autosave');
  await expect(versions.getByTestId('versions-draft')).toHaveCount(0);
  const kept = versions.getByTestId('versions-kept').getByRole('listitem');
  await expect(kept).toHaveCount(2);
  // One named version, not four.
  await expect(kept.first()).toContainText('Before the launch');
  await expect(kept.first()).toContainText('Version 2');
  await expect(kept.first()).toContainText('Newest');
  await expect(
    versions.getByTestId('versions-kept').getByText('Before the launch', { exact: true }),
  ).toHaveCount(1);
  await expect(
    versions.getByRole('textbox', { name: 'Name for this version (optional)' }),
  ).toHaveValue('');
  await versions.getByRole('button', { name: 'Close' }).click();

  // The next edit starts a new working draft on top of the kept version, which stays as it was.
  await text.fill('After the launch');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(api.versionsOf(pageId).map((version) => [version.number, version.name])).toEqual([
    [1, null],
    [2, 'Before the launch'],
    [3, null],
  ]);
  expect(find(api.versionsOf(pageId)[1]?.document, 'title')['props']).toMatchObject({
    text: [{ text: 'Four in all' }],
  });
  await page.getByRole('button', { name: 'Versions' }).click();
  await expect(versions.getByTestId('versions-draft').getByRole('listitem')).toContainText(
    'Version 3',
  );
  await expect(versions.getByTestId('versions-kept').getByRole('listitem')).toHaveCount(2);
});

test('leaving the window saves at once, without waiting for the pause', async ({ page }) => {
  const opened = await funnel(page, smallPage);
  await openEditor(page, opened);
  await node(page, 'title').click();
  await selection(page).getByRole('textbox', { name: 'Text', exact: true }).fill('Going away');
  await expect(saveState(page)).toHaveText('Not saved');
  const before = Date.now();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(saveState(page)).toHaveText('Saved', { timeout: 1200 });
  // Well inside the pause an edit otherwise waits for.
  expect(Date.now() - before).toBeLessThan(1400);
  expect(opened.api.sent.filter((each) => each.call.endsWith('/draft'))).toHaveLength(1);
});

test('a calendar element is given a calendar, drawn as its button, and published', async ({
  page,
}) => {
  const opened = await funnel(page, smallPage);
  const { api, pageId } = opened;
  const withPicture: VisualPageDocument = structuredClone(smallPage);
  Object.assign(find(withPicture, 'picture')['props'] as object, {
    src: 'https://example.com/a.gif',
    alt: 'A harbour',
  });
  api.saveElsewhere(pageId, withPicture, 'Dana Brooks');
  await openEditor(page, opened);
  await node(page, 'copy').click();
  await press(page.getByRole('button', { name: 'Add Calendar', exact: true }));
  await expect(said(page)).toHaveText('Calendar added after the selected Paragraph.');
  await expect(canvas(page).locator('.ep', { hasText: 'Calendar' })).toHaveText(
    'Calendar: none chosen yet',
  );
  await expect(selection(page).getByTestId('calendar-state')).toHaveText(
    "Choose a calendar: the page can't be published without one.",
  );
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });

  // Publishing says what is in the way, and the element says it too once it is shown.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const publish = dialog(page, 'Publish page');
  await expect(
    publish.getByText('A calendar element has no calendar chosen. Choose one or remove it.'),
  ).toBeVisible();
  await expect(publish.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await publish.getByRole('button', { name: 'Show it' }).click();
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Calendar');
  await expect(selection(page).getByTestId('element-problems')).toHaveText(
    'A calendar element has no calendar chosen. Choose one or remove it.',
  );

  // Only active calendars are offered; an inactive one that was chosen is named as such.
  const picker = selection(page).getByRole('combobox', { name: 'Calendar', exact: true });
  await picker.click();
  await expect(page.getByRole('option')).toHaveText(['No calendar chosen', 'Venue tours']);
  await page.keyboard.press('Escape');
  await choose(picker, editorCalendars[0]?.id ?? '');
  await expect(selection(page).getByTestId('calendar-state')).toHaveCount(0);
  // Drawn as it will publish: the button-styled link to the calendar's booking page.
  const link = canvas(page).locator('a.bt', { hasText: 'Book a time' });
  await expect(link).toBeVisible();
  await expect(link).toHaveCSS('background-color', 'rgb(29, 42, 36)');
  await selection(page).getByRole('textbox', { name: 'Button label' }).fill('Book your tour');
  await expect(canvas(page).locator('a.bt')).toHaveText('Book your tour');
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  // The problem was the saved page's: once saved with a calendar it is gone from the element.
  await expect(selection(page).getByTestId('element-problems')).toHaveCount(0);
  const calendar = elementsIn(visual(api.documentOf(pageId))).find(
    (each) => each.type === 'calendar',
  );
  expect(calendar?.props).toStrictEqual({
    calendarId: editorCalendars[0]?.id,
    label: 'Book your tour',
  });

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(publish.getByText('Nothing stands in the way.')).toBeVisible();
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  await dialog(page, 'The page is live').getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('publish-state')).toHaveText('Published');
  expect(api.sent.filter((each) => each.call.endsWith('/publish'))).toHaveLength(1);
});

test('a popup is set to open by itself, and a countdown is drawn as a labelled sample', async ({
  page,
}) => {
  const opened = await funnel(page, everyElementPage);
  const { api, pageId } = opened;
  await openEditor(page, opened);
  // What the server no longer says of a countdown or a popup is not said here either.
  await expect(leftPanel(page).getByText(/does not count down/i)).toHaveCount(0);
  await expect(leftPanel(page).getByText(/does not open by itself/i)).toHaveCount(0);
  // The countdown: the page's own words, with a sample of the time left and a tag saying so.
  const countdown = node(page, 'details-countdown');
  await expect(countdown.locator('[role="timer"]')).toHaveText(/^(\d+d )?\d\dh \d\dm$/);
  await expect(countdown).toContainText('left, ends 1 December 2026, 00:00 UTC');
  await expect(countdown.locator('.ep-tag')).toHaveText('Sample: on the page it counts down');
  // The calendar of the page is an active one: drawn as its link.
  await expect(node(page, 'details-calendar')).toHaveText('Book a time');

  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  await press(outline(page, 'claim'));
  await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Popup');
  const opens = selection(page).getByRole('combobox', { name: 'Opens', exact: true });
  await choose(opens, 'delay');
  const delay = selection(page).getByRole('spinbutton', { name: 'Delay (seconds)' });
  await expect(delay).toHaveValue('5');
  await delay.fill('12');
  const once = selection(page).getByRole('switch', { name: 'Once in a visit' });
  await expect(once).toBeChecked();
  await once.click();
  await expect(
    selection(page).getByText('It opens by itself every time a page with it is shown.'),
  ).toBeVisible();
  await expect(selection(page).getByTestId('popup-script-off')).toHaveCount(0);
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(find(api.documentOf(pageId), 'claim')['props']).toStrictEqual({
    trigger: 'delay',
    delaySeconds: 12,
    width: 'medium',
    frequency: 'always',
  });

  // The other popup opens when the visitor is about to leave, once in a visit: unchanged.
  await press(outline(page, 'leaving'));
  await expect(selection(page).getByRole('combobox', { name: 'Opens', exact: true })).toContainText(
    'when the visitor is about to leave',
  );
  await expect(selection(page).getByRole('switch', { name: 'Once in a visit' })).toBeChecked();
  // Back to a link only: how often goes with it, and the page is as it was but for the change.
  await press(outline(page, 'claim'));
  await choose(selection(page).getByRole('combobox', { name: 'Opens', exact: true }), 'none');
  await expect(selection(page).getByRole('spinbutton', { name: 'Delay (seconds)' })).toHaveCount(0);
  await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
  expect(find(api.documentOf(pageId), 'claim')['props']).toStrictEqual({
    trigger: 'none',
    delaySeconds: 12,
    width: 'medium',
  });
});

test('an install without its page scripts says what a popup and a countdown then do', async ({
  page,
}) => {
  const opened = await funnel(page, everyElementPage, {
    scripts: { countdown: false, popup: false },
  });
  await openEditor(page, opened);
  await expect(node(page, 'details-countdown').locator('.ep-tag')).toHaveText(
    'Sample: on the page it is brought up to date when the page is loaded',
  );
  await expect(leftPanel(page).locator('[data-tile="popup"]')).toContainText(
    'Opens over the page from a link or a button. On this install it does not open by itself.',
  );
  // The button beside the tile is described by the same words, for whoever cannot see the tile.
  await expect(
    leftPanel(page).getByRole('button', { name: 'Add Popup', exact: true }),
  ).toHaveAccessibleDescription(
    'Opens over the page from a link or a button. On this install it does not open by itself.',
  );
  await press(leftPanel(page).getByRole('button', { name: 'Layers', exact: true }));
  await press(outline(page, 'leaving'));
  await expect(selection(page).getByTestId('popup-script-off')).toContainText(
    'this popup opens from a link or a button only',
  );
});

test('the canvas lays a page out where the published page does, a row’s own margin included', async ({
  page,
}) => {
  const words = (id: string, text: string): PageElement => ({
    id,
    type: 'paragraph',
    props: { text: [{ text }] },
  });
  const laid: VisualPageDocument = {
    ...smallPage,
    sections: [
      {
        id: 'first',
        type: 'section',
        props: { width: 'wide' },
        rows: [
          {
            id: 'row-a',
            type: 'row',
            // Its own margin below adds to the space between rows on the published page.
            style: { margin: { bottom: 20 } },
            columns: [
              {
                id: 'a-left',
                type: 'column',
                props: { span: 7 },
                children: [
                  {
                    id: 'a-title',
                    type: 'headline',
                    props: { level: 1, text: [{ text: 'Rows' }] },
                  },
                  words('a-copy', 'A row with a margin of its own below it.'),
                ],
              },
              {
                id: 'a-right',
                type: 'column',
                props: { span: 5 },
                children: [
                  {
                    id: 'a-button',
                    type: 'button',
                    props: { label: 'Go on', subLabel: 'Second line', action: { type: 'none' } },
                  },
                ],
              },
            ],
          },
          {
            id: 'row-b',
            type: 'row',
            style: { padding: { top: 8, bottom: 8 } },
            columns: [
              {
                id: 'b-only',
                type: 'column',
                props: { span: 12 },
                children: [
                  words('b-copy', 'A second row, with padding of its own.'),
                  {
                    id: 'b-line',
                    type: 'divider',
                    props: { thickness: 2, line: 'solid', color: null },
                  },
                  {
                    id: 'b-box',
                    type: 'container',
                    props: { direction: 'horizontal', gap: 16 },
                    children: [words('b-in-1', 'Side'), words('b-in-2', 'by side')],
                  },
                ],
              },
            ],
          },
          {
            id: 'row-c',
            type: 'row',
            columns: [
              {
                id: 'c-only',
                type: 'column',
                props: { span: 12 },
                children: [words('c-copy', 'Third.')],
              },
            ],
          },
        ],
      },
      {
        id: 'second',
        type: 'section',
        props: { width: 'small' },
        style: { padding: { top: 40 } },
        rows: [
          {
            id: 'row-d',
            type: 'row',
            columns: [
              {
                id: 'd-only',
                type: 'column',
                props: { span: 12 },
                children: [words('d-copy', 'Narrow.')],
              },
            ],
          },
        ],
      },
    ],
  };
  const opened = await funnel(page, laid);
  await openEditor(page, opened);
  /** Where every section, row, column and element lies in a frame, to a tenth of a pixel. */
  const boxes = (frame: FrameLocator): Promise<[string, number, number, number, number][]> =>
    frame.locator('body').evaluate((body) => {
      const section = body.querySelector('.sc');
      const origin = section?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const found = body.querySelectorAll('.sc, .rw, .cl, .kt, .hl, .pg, .bt, .dv');
      const tenth = (value: number): number => Math.round(value * 10) / 10;
      return [...found].map((element): [string, number, number, number, number] => {
        const box = element.getBoundingClientRect();
        return [
          element.classList.item(0) ?? '',
          tenth(box.left - origin.left),
          tenth(box.top - origin.top),
          tenth(box.width),
          tenth(box.height),
        ];
      });
    });
  await expect(page.getByTestId('canvas-stage')).toHaveAttribute('data-width', '1280');
  const edited = await boxes(canvas(page));
  expect(edited.map(([kind]) => kind).join(' ')).toBe(
    'sc rw cl hl pg cl bt rw cl pg dv kt pg pg rw cl pg sc rw cl pg',
  );
  // The published page's own renderer, at the same width: a version, to look at.
  await page.getByRole('button', { name: 'Versions' }).click();
  await dialog(page, 'Versions').getByRole('button', { name: 'Look at version 1' }).click();
  const looking = dialog(page, 'Version 1, to look at');
  const live = looking.frameLocator('iframe[title="Version 1 of the page"]');
  await expect(live.locator('.sc')).toHaveCount(2);
  await expect(looking.getByTestId('page-render')).toHaveAttribute('data-width', '1280');
  expect(edited).toEqual(await boxes(live));
  // And the margin is there: 20 px of the row's own under it, and the 24 px between rows.
  // (Rows in a plain block would have the two collapse into 24.)
  const [rowA, rowB] = edited.filter(([kind]) => kind === 'rw');
  if (rowA === undefined || rowB === undefined) throw new Error('two rows');
  expect(Math.round(rowB[2] - (rowA[2] + rowA[4]))).toBe(20 + 24);
});

test('someone who may only read sees the page and nothing to change', async ({ page }) => {
  await signedIn(page);
  const spring = siteOf('funnel', 'Spring offer', [['Landing Page', 'landing']]);
  const pageId = spring.steps[0]?.pages[0]?.id ?? '';
  const sites = await fakeSitesApi(page, { sites: [spring], canManage: false });
  await fakeSiteEditorApi(page, sites, { documents: { [pageId]: smallPage }, canManage: false });
  await page.goto(inHarbor(`/sites/funnels/${spring.id}`));
  const step = main(page).getByRole('region', { name: 'Landing Page', exact: true });
  await expect(step.getByRole('button', { name: 'Publish' })).toHaveCount(0);
  await step.getByRole('link', { name: 'View', exact: true }).click();
  await expect(
    main(page).getByText(
      'You can look at this page. Changing it needs permission to manage sites.',
    ),
  ).toBeVisible();
  await expect(page.frameLocator('iframe[title="The page as saved"]').locator('h1')).toHaveText(
    'Welcome',
  );
  await expect(page.locator('#preview-frame')).toHaveCount(0);
});

// What a long page may take: twenty sections and 300 elements. Measured on this machine on
// 2026-10-13, from the press to the page showing it: opening 1.5 s, selecting an element
// 145 ms, a typed letter 65 ms, a move 95 ms. The ceilings are about four times that, so a
// two-core CI runner passes and a real slowdown does not: before the editor stopped drawing
// itself again for every letter, a typed letter took 1.2 s here, and this test said so.
const CEILINGS = { open: 10_000, select: 600, type: 300, move: 400 } as const;

test('a long page stays quick: selecting, typing and moving on 300 elements', async ({ page }) => {
  mkdirSync(reports, { recursive: true });
  const opened = await funnel(page, longPage());
  const startedAt = Date.now();
  await openEditor(page, opened);
  await expect(canvas(page).locator('[data-puck-component]')).toHaveCount(20 * (1 + 1 + 3 + 15));
  const open = Date.now() - startedAt;

  /** How long from an action until the page shows what it did, in the browser's own time. */
  const until = async (
    act: () => Promise<void>,
    shown: () => Promise<boolean>,
  ): Promise<number> => {
    const from = Date.now();
    await act();
    while (!(await shown()))
      if (Date.now() - from > 10_000) throw new Error(`never shown: ${act.toString()}`);
    return Date.now() - from;
  };
  const heading = selection(page).getByRole('heading', { level: 2 });
  const select = await until(
    () => node(page, 's10-c1-e1').click(),
    async () => (await heading.textContent()) === 'Paragraph',
  );
  const text = selection(page).getByRole('textbox', { name: 'Text', exact: true });
  await text.focus();
  await page.keyboard.press('ControlOrMeta+End');
  const type = await until(
    () => page.keyboard.type('!'),
    async () => ((await node(page, 's10-c1-e1').textContent()) ?? '').endsWith('!'),
  );
  const move = await until(
    () => selection(page).getByRole('button', { name: 'Move Paragraph down' }).click(),
    async () => (await childrenOf(page, 's10-c1:children'))[2] === 's10-c1-e1',
  );
  const measured = { open, select, type, move };
  writeFileSync(`${reports}/long-page-timings.json`, JSON.stringify(measured, null, 2));
  test.info().annotations.push({ type: 'timings', description: JSON.stringify(measured) });
  expect(open).toBeLessThan(CEILINGS.open);
  expect(select).toBeLessThan(CEILINGS.select);
  expect(type).toBeLessThan(CEILINGS.type);
  expect(move).toBeLessThan(CEILINGS.move);
  await expect(saveState(page)).toHaveText('Saved', { timeout: 15_000 });
});

/**
 * axe on the editor: the bar, the panels, the dialogs and the canvas's own frame, with
 * every rule and nothing of ours set aside. (The canvas library gives every node of the
 * page a button's role, which made the page buttons inside buttons; the canvas takes
 * those roles off again, canvas.tsx, so no rule has to be switched off for it.)
 *
 * One frame is left out: the Preview dialog's. What it shows is another document, the
 * published page itself, served by the server and stood in for here by a few lines of
 * HTML; its own accessibility is checked where it is made (packages/site-render). Read
 * together with the dashboard it has a second, unnamed main landmark, as any page in a
 * frame has.
 */
async function expectAccessible(page: Page): Promise<void> {
  const found = await new AxeBuilder({ page })
    .exclude('iframe[title="Preview of the page"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    found.violations.map((violation) => [
      violation.id,
      violation.nodes.map((each) => each.target.join(' ')).slice(0, 3),
    ]),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [1440, 360]) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the editor, its panels and its dialogs have no axe violations', async ({ page }) => {
      mkdirSync(reports, { recursive: true });
      const narrow = width < 1024;
      const part = (name: string): Promise<void> =>
        narrow
          ? page
              .getByRole('group', { name: 'Part of the editor' })
              .getByRole('button', { name, exact: true })
              .click()
          : Promise.resolve();
      const opened = await funnel(page, everyElementPage);
      await openEditor(page, opened);
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/editor-${String(width)}.png` });

      // Elements, then Layers.
      await part('Add');
      await expectAccessible(page);
      if (narrow) await page.screenshot({ path: `${reports}/editor-add-${String(width)}.png` });
      await part('Layers');
      if (!narrow)
        await leftPanel(page).getByRole('button', { name: 'Layers', exact: true }).click();
      await outline(page, 'hero-title').click();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/editor-layers-${String(width)}.png` });

      // The selected element's panel, with every group of fields open, on a phone's look.
      await part('Edit');
      await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText('Headline');
      const shut = selection(page).locator('details:not([open]) > summary');
      while ((await shut.count()) > 0) await shut.first().click();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/editor-fields-${String(width)}.png` });
      await page
        .getByRole('group', { name: 'Device' })
        .getByRole('button', { name: 'Mobile' })
        .click();
      await part('Page');
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/editor-mobile-look-${String(width)}.png` });

      // The dialogs: publish with its problems, preview, versions.
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(dialog(page, 'Publish page').getByRole('listitem').first()).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/publish-${String(width)}.png` });
      await dialog(page, 'Publish page').getByRole('button', { name: 'Cancel' }).click();

      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(dialog(page, 'Preview').locator('iframe')).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/preview-${String(width)}.png` });
      await dialog(page, 'Preview').getByRole('button', { name: 'Close' }).click();

      await page.getByRole('button', { name: 'Versions' }).click();
      await expect(dialog(page, 'Versions').getByRole('listitem')).toHaveCount(1);
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/versions-${String(width)}.png` });
    });

    test('pictures from the library, a calendar, a popup’s opening and a kept version have no axe violations', async ({
      page,
    }) => {
      mkdirSync(reports, { recursive: true });
      const narrow = width < 1024;
      const part = (name: string): Promise<void> =>
        narrow
          ? page
              .getByRole('group', { name: 'Part of the editor' })
              .getByRole('button', { name, exact: true })
              .click()
          : Promise.resolve();
      /** Selects a node through Layers, and shows its fields. */
      const show = async (id: string, kind: string): Promise<void> => {
        await part('Layers');
        await outline(page, id).click();
        await part('Edit');
        await expect(selection(page).getByRole('heading', { level: 2 })).toHaveText(kind);
      };
      const opened = await funnel(page, everyElementPage);
      await fakeMediaApi(page, {
        files: [
          mediaFileOf('storefront.png', 'image/png'),
          mediaFileOf('team.jpg', 'image/jpeg'),
          mediaFileOf('price-list.pdf', 'application/pdf'),
        ],
      });
      await openEditor(page, opened);
      if (!narrow)
        await leftPanel(page).getByRole('button', { name: 'Layers', exact: true }).click();

      // An image: its picture, its size and its description.
      await show('hero-image', 'Image');
      await expect(selection(page).getByTestId('picture-size')).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/image-fields-${String(width)}.png` });
      // The library, inside the editor: pictures only.
      await selection(page)
        .getByRole('button', { name: 'Image address: choose from Media Storage' })
        .click();
      const picker = dialog(page, 'Choose a picture');
      await expect(picker.getByRole('button', { name: 'Choose storefront.png' })).toBeVisible();
      await expect(picker.getByRole('button', { name: 'Choose price-list.pdf' })).toHaveCount(0);
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/media-picker-${String(width)}.png` });
      await picker.getByRole('button', { name: 'Choose storefront.png' }).click();
      const asked = dialog(page, 'Make "storefront.png" public?');
      await expect(asked).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/media-make-public-${String(width)}.png` });
      await asked.getByRole('button', { name: 'Cancel' }).click();
      await expect(asked).toHaveCount(0);

      // A calendar, and a popup that opens by itself.
      await show('details-calendar', 'Calendar');
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/calendar-fields-${String(width)}.png` });
      await show('claim', 'Popup');
      await choose(selection(page).getByRole('combobox', { name: 'Opens', exact: true }), 'delay');
      await expect(selection(page).getByRole('switch', { name: 'Once in a visit' })).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/popup-fields-${String(width)}.png` });
      await part('Page');
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/editor-countdown-${String(width)}.png` });

      // Versions: the working draft, then a version kept under a name.
      await expect(saveState(page)).toHaveText('Saved', { timeout: 10_000 });
      await page.getByRole('button', { name: 'Versions' }).click();
      const versions = dialog(page, 'Versions');
      await expect(versions.getByTestId('versions-draft').getByRole('listitem')).toHaveCount(1);
      await versions
        .getByRole('textbox', { name: 'Name for this version (optional)' })
        .fill('Before the launch');
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/versions-draft-${String(width)}.png` });
      await versions.getByRole('button', { name: 'Save a version' }).click();
      await expect(versions.getByTestId('version-kept')).toContainText('Kept as version 2');
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/versions-kept-${String(width)}.png` });
    });

    test('an install that serves no public page: the notice and Publish have no axe violations', async ({
      page,
    }) => {
      mkdirSync(reports, { recursive: true });
      const opened = await funnel(page, smallPage, { liveBase: null });
      const withPicture: VisualPageDocument = structuredClone(smallPage);
      Object.assign(find(withPicture, 'picture')['props'] as object, {
        src: 'https://example.com/a.gif',
        alt: 'A harbour',
      });
      opened.api.saveElsewhere(opened.pageId, withPicture);
      await page.goto(inHarbor(`/sites/funnels/${opened.siteId}`));
      await expect(main(page).getByTestId('public-pages-off')).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/pages-off-funnel-${String(width)}.png` });
      await openEditor(page, opened);
      await expect(page.getByTestId('public-pages-off')).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/pages-off-editor-${String(width)}.png` });
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(dialog(page, 'Publish page').getByTestId('publish-pages-off')).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: `${reports}/pages-off-publish-${String(width)}.png` });
    });
  });
}
