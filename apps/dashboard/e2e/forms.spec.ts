// Settings > Forms, against a stand-in for the API that keeps one form in memory and checks
// every write against the contract.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  createFormInput,
  DEFAULT_FORM_DEFINITION,
  formRevisionInput,
  updateFormInput,
  type Form,
  type FormSubmission,
  type UpdateFormInput,
} from '@repo/contracts';
import { harbor, inHarbor, signedIn } from './session';
import { choose } from './select';

const formId = 'form_01k8e2wzr0e008000000000001';
const budgetField = 'fld_01k8e2wzr0e008000000000001';
const at = '2026-10-10T09:00:00.000Z';
const ATTACK = '<img src=x onerror=alert(1)>';
const snippet = `<script async src="https://crm.example/forms/embed.js" data-form-key="${'A'.repeat(32)}"></script>`;

interface World {
  form: Form | undefined;
  writes: UpdateFormInput[];
  changes: string[];
  submissions: FormSubmission[];
  discarded: string[];
}
const world = (patch: Partial<World> = {}): World => ({
  form: undefined,
  writes: [],
  changes: [],
  submissions: [],
  discarded: [],
  ...patch,
});
const formOf = (patch: Partial<Form> = {}): Form => ({
  id: formId,
  name: 'Wedding enquiry',
  status: 'draft',
  publicKey: 'A'.repeat(32),
  allowedOrigins: [],
  definition: DEFAULT_FORM_DEFINITION,
  publishedDefinition: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  problems: [],
  embedSnippet: snippet,
  hostedUrl: `https://crm.example.test/f/${'k'.repeat(32)}`,
  submissionCount: 0,
  revision: 'a'.repeat(64),
  canManage: true,
  createdAt: at,
  updatedAt: at,
  ...patch,
});
/** What the server says stands between this form and publishing, as far as this stand-in knows. */
const problemsOf = (form: Pick<Form, 'allowedOrigins'>): Form['problems'] =>
  form.allowedOrigins.length === 0
    ? [
        {
          path: '/allowedOrigins',
          code: 'no_website',
          message: 'Add the website that will show this form.',
        },
      ]
    : [];

/** Stands in for the forms API. Every write is parsed with the contract's own schema. */
async function formsApi(page: Page, state: World): Promise<void> {
  let revisions = 0;
  const next = (patch: Partial<Form>): Form => {
    if (state.form === undefined) throw new Error('No form yet.');
    revisions += 1;
    const changed = { ...state.form, ...patch };
    state.form = {
      ...changed,
      problems: problemsOf(changed),
      revision: String(revisions).padStart(64, 'b'),
    };
    return state.form;
  };
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: budgetField,
            objectKey: 'contact',
            key: 'budget',
            label: 'Budget',
            description: 'What they plan to spend.',
            valueType: 'number',
            currency: null,
            options: [],
            aiFillSources: [],
            aiOverwrite: 'ask',
            archived: false,
            revision: 'a'.repeat(64),
          },
        ],
        objects: [{ key: 'contact', label: 'Contact' }],
        canManage: true,
      },
    }),
  );
  await page.route(/\/api\/v1\/forms(?:[/?].*)?$/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const path = new URL(request.url()).pathname.replace('/api/v1/forms', '');
    const method = request.method();
    if (path === '' && method === 'GET') {
      const archived = new URL(request.url()).searchParams.get('archived') === 'true';
      const listed =
        state.form !== undefined && (state.form.status === 'archived') === archived
          ? [
              {
                id: state.form.id,
                name: state.form.name,
                status: state.form.status,
                hasUnpublishedChanges: state.form.hasUnpublishedChanges,
                submissionCount: state.submissions.length,
                lastSubmissionAt: state.submissions[0]?.submittedAt ?? null,
                updatedAt: at,
              },
            ]
          : [];
      await route.fulfill({ json: { items: listed, nextCursor: null, canManage: true } });
      return;
    }
    if (path === '' && method === 'POST') {
      const { name } = createFormInput.parse(request.postDataJSON());
      state.form = formOf({ name, problems: problemsOf({ allowedOrigins: [] }) });
      await route.fulfill({ status: 201, json: state.form });
      return;
    }
    if (path === `/${formId}` && method === 'GET') {
      await route.fulfill({ json: { ...state.form, submissionCount: state.submissions.length } });
      return;
    }
    if (path === `/${formId}` && method === 'PUT') {
      const input = updateFormInput.parse(request.postDataJSON());
      expect(input.revision).toBe(state.form?.revision);
      state.writes.push(input);
      await route.fulfill({
        json: next({
          name: input.name,
          definition: input.definition,
          allowedOrigins: input.allowedOrigins,
          hasUnpublishedChanges: state.form?.status === 'published',
        }),
      });
      return;
    }
    if (path === `/${formId}/submissions` && method === 'GET') {
      await route.fulfill({
        json: { items: state.submissions, nextCursor: null, canManage: true },
      });
      return;
    }
    const discarding = /^\/[^/]+\/submissions\/(fsub_[0-9a-z]+)$/.exec(path)?.[1];
    if (discarding !== undefined && method === 'DELETE') {
      state.discarded.push(discarding);
      state.submissions = state.submissions.filter((each) => each.id !== discarding);
      await route.fulfill({ status: 204 });
      return;
    }
    const change = /^\/[^/]+\/(publish|unpublish|archive|restore)$/.exec(path)?.[1];
    if (change !== undefined && method === 'POST') {
      expect(formRevisionInput.parse(request.postDataJSON()).revision).toBe(state.form?.revision);
      state.changes.push(change);
      const live = change === 'publish';
      await route.fulfill({
        json: next({
          status: live ? 'published' : change === 'archive' ? 'archived' : 'draft',
          publishedDefinition: live ? (state.form?.definition ?? null) : null,
          publishedAt: live ? at : null,
          hasUnpublishedChanges: false,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { type: 'about:blank', title: 'Not Found', status: 404 },
    });
  });
}

const axe = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
    .violations;
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const width of [360, 1280]) {
  test(`builds a form, publishes it and shows its code at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const state = world();
    await formsApi(page, state);
    // Forms are a page of Sites: the sidebar opens it there, at the address it always had.
    await page.goto(inHarbor('/settings/business'));
    // On a phone the sidebar is behind the menu button.
    if (width < 1024) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('link', { name: 'Go Back', exact: true }).click();
    if (width < 1024) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('link', { name: 'Sites', exact: true }).click();
    await page.getByRole('link', { name: 'Forms', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Forms', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page).toHaveURL(/\/settings\/forms$/);
    await expect(page.getByRole('heading', { name: 'Forms', exact: true })).toBeVisible();
    await expect(page.getByText('No form yet. Add one to start building it.')).toBeVisible();
    expect(await axe(page)).toEqual([]);

    await page.getByRole('button', { name: 'Add a form', exact: true }).click();
    // The new field takes the focus, and Enter sends it.
    await expect(page.getByLabel('Name of the new form', { exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('Enter a name.');
    await page.keyboard.type('Wedding enquiry');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Wedding enquiry' })).toBeVisible();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
    // A new form says what stands between it and a website.
    await expect(page.getByText('Before this form can be published')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    expect(await axe(page)).toEqual([]);
    expect(await fits(page)).toBe(true);

    // A website that isn't an address is refused before anything is sent.
    const websites = page.getByLabel('Websites that may show this form', { exact: true });
    await websites.fill('harbor lights dot example');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Check the parts marked below.');
    await expect(
      page.getByText(/Enter a website address with nothing after the host/),
    ).toBeVisible();
    expect(state.writes).toEqual([]);
    await websites.fill('https://www.harborlights.example');

    await page.getByLabel('Heading', { exact: true }).fill('Plan your wedding');
    await page.getByRole('button', { name: 'Add a question', exact: true }).click();
    await page.getByLabel('Question 3', { exact: true }).fill('What is your budget?');
    await choose(page.getByLabel('Kind of answer for question 3', { exact: true }), 'number');
    await choose(
      page.getByLabel('Where the answer to question 3 is saved', { exact: true }),
      `field:${budgetField}`,
    );
    await page.getByRole('button', { name: 'Add a question', exact: true }).click();
    await page.getByLabel('Question 4', { exact: true }).fill(ATTACK);
    // Moved up with the keyboard alone: the button is reached, and Enter presses it.
    await page.getByRole('button', { name: 'Move question 4 up', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Question 3', { exact: true })).toHaveValue(ATTACK);
    await page.getByRole('button', { name: 'Add a consent box', exact: true }).click();
    await page
      .getByLabel('Words beside consent box 1', { exact: true })
      .fill('Email me news and offers.');

    // The preview follows the draft, and shows markup as the characters it is made of.
    const preview = page.getByRole('region', { name: 'Preview', exact: true });
    await expect(preview.getByText('Plan your wedding', { exact: true })).toBeVisible();
    await expect(preview.getByText(ATTACK, { exact: true })).toBeVisible();
    await expect(preview.getByText('Email me news and offers.', { exact: true })).toBeVisible();
    expect(await preview.locator('img, script').count()).toBe(0);
    expect(await axe(page)).toEqual([]);
    expect(await fits(page)).toBe(true);

    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      name: 'Wedding enquiry',
      allowedOrigins: ['https://www.harborlights.example'],
      definition: {
        title: 'Plan your wedding',
        consents: [{ channel: 'email', wording: 'Email me news and offers.', required: false }],
      },
    });
    expect(
      state.writes[0]?.definition.fields.map((field) => [field.label, field.type, field.target]),
    ).toEqual([
      ['First name', 'text', { kind: 'contact', attribute: 'firstName' }],
      ['Email', 'email', { kind: 'contact', attribute: 'email' }],
      [ATTACK, 'text', { kind: 'none' }],
      ['What is your budget?', 'number', { kind: 'field', fieldId: budgetField }],
    ]);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Published. Websites now show this version.' }),
    ).toBeVisible();
    expect(state.changes).toEqual(['publish']);
    // The code is text on the page, never an element.
    const code = page.getByRole('region', { name: 'Code for your website', exact: true });
    await expect(code.getByText(snippet, { exact: true })).toBeVisible();
    expect(await code.locator('script').count()).toBe(0);
    expect(await axe(page)).toEqual([]);
    expect(await fits(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('form-builder.png'), fullPage: true });

    // Back in the list it shows as published.
    await page.getByRole('button', { name: 'Back to all forms', exact: true }).click();
    const list = page.getByRole('list', { name: 'Forms', exact: true });
    await expect(list.getByText('Wedding enquiry', { exact: true })).toBeVisible();
    await expect(list.getByText('Published', { exact: true })).toBeVisible();
    expect(await fits(page)).toBe(true);
  });
}

test('shows what people sent as text, and discards a submission that reached no contact', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 950 });
  await signedIn(page);
  const state = world({
    form: formOf({
      status: 'published',
      allowedOrigins: ['https://www.harborlights.example'],
      publishedDefinition: DEFAULT_FORM_DEFINITION,
      publishedAt: at,
    }),
    submissions: [
      {
        id: 'fsub_01k8e2wzr0e008000000000002',
        submittedAt: '2026-10-10T11:00:00.000Z',
        contactId: null,
        contactOutcome: 'unresolved',
        answers: [{ key: 'email', label: 'Email', value: 'someone@example.test' }],
        consents: [
          {
            key: 'news',
            channel: 'email',
            wording: 'Email me news and offers.',
            outcome: 'no_address',
          },
        ],
        terms: [],
        skippedFields: [],
        origin: 'https://www.harborlights.example',
        pageUrl: 'https://www.harborlights.example/enquire',
        ipAddress: '203.0.113.9',
        utm: { source: 'newsletter' },
        leadSource: 'Email',
        leadSourceRule: 'email',
      },
      {
        id: 'fsub_01k8e2wzr0e008000000000001',
        submittedAt: '2026-10-10T10:00:00.000Z',
        contactId: 'con_01k8e2wzr0e008000000000001',
        contactOutcome: 'created',
        answers: [
          { key: 'first_name', label: 'First name', value: ATTACK },
          { key: 'email', label: 'Email', value: 'maya@example.test' },
          {
            key: 'notes',
            label:
              'A very long question label that a business wrote without thinking of narrow screens at all',
            value: 'x'.repeat(300),
          },
        ],
        consents: [
          {
            key: 'news',
            channel: 'email',
            wording: 'Email me news and offers.',
            outcome: 'granted',
          },
        ],
        terms: [],
        skippedFields: [],
        origin: 'https://www.harborlights.example',
        pageUrl: 'https://www.harborlights.example/enquire',
        ipAddress: '203.0.113.10',
        utm: {},
        // Stored before lead sources were kept.
        leadSource: null,
        leadSourceRule: null,
      },
    ],
  });
  await formsApi(page, state);
  await page.goto(inHarbor('/settings/forms'));
  await page.getByRole('button', { name: 'Open Wedding enquiry', exact: true }).click();
  await page.getByRole('button', { name: 'Submissions (2)', exact: true }).click();
  const list = page.getByRole('list', { name: 'Submissions, newest first', exact: true });
  const cards = list.getByRole('article');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1).getByText(ATTACK, { exact: true })).toBeVisible();
  expect(await list.locator('img, script').count()).toBe(0);
  await expect(cards.nth(1).getByRole('link', { name: 'Open the new contact' })).toHaveAttribute(
    'href',
    inHarbor('/contacts/con_01k8e2wzr0e008000000000001'),
  );
  await expect(cards.nth(1).getByText('Consent recorded')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  // Long answers and labels wrap: the page never scrolls sideways.
  expect(await fits(page)).toBe(true);

  const unattached = cards.nth(0);
  await expect(unattached.getByText('Not attached to a contact')).toBeVisible();
  await unattached.getByRole('button', { name: 'Discard…', exact: true }).click();
  await expect(unattached.getByText('Discard this submission for good?')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await unattached.getByRole('button', { name: 'Discard it', exact: true }).click();
  await expect(cards).toHaveCount(1);
  expect(state.discarded).toEqual(['fsub_01k8e2wzr0e008000000000002']);
  await expect(page.getByRole('button', { name: 'Submissions (1)', exact: true })).toBeVisible();
});

test('keeps an unsaved draft across the submissions view, and takes a form down and back', async ({
  page,
}) => {
  await signedIn(page);
  const state = world({
    form: formOf({
      status: 'published',
      allowedOrigins: ['https://www.harborlights.example'],
      publishedDefinition: DEFAULT_FORM_DEFINITION,
      publishedAt: at,
    }),
  });
  await formsApi(page, state);
  await page.goto(inHarbor('/settings/forms'));
  await page.getByRole('button', { name: 'Open Wedding enquiry', exact: true }).click();
  await page.getByLabel('Heading', { exact: true }).fill('Typed and not saved');
  await page.getByRole('button', { name: 'Submissions (0)', exact: true }).click();
  await expect(page.getByText('Nobody has sent this form yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await expect(page.getByLabel('Heading', { exact: true })).toHaveValue('Typed and not saved');

  await page.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'The form no longer accepts submissions.' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Code for your website' })).toHaveCount(0);
  // Taking the form down changed its state, not what was typed.
  await expect(page.getByLabel('Heading', { exact: true })).toHaveValue('Typed and not saved');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Archived', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Heading', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Back to all forms', exact: true }).click();
  await expect(page.getByText('No form yet. Add one to start building it.')).toBeVisible();
  await page.getByRole('button', { name: 'Show archived forms', exact: true }).click();
  await page.getByRole('button', { name: 'Open Wedding enquiry', exact: true }).click();
  await page.getByRole('button', { name: 'Restore as a draft', exact: true }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  expect(state.changes).toEqual(['unpublish', 'archive', 'restore']);
});
