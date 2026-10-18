// The Send email action as GoHighLevel's: a template found by searching its subject among
// sixty, who the email is from and copied to, the popup editor (formatted text, a merge
// field as a chip, a picture from Media Storage, a button, a preview filled in for a
// contact, Save and Save as new template), an email that syncs with its template and the
// other workflows that use it, attachments, and the Statistics tab. The API is stood in for
// by automation-api.ts and template-fixtures.ts, whose answers are parsed by the contract's
// own schemas.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  automationStepTypes,
  copyWorkflowEmailTemplate,
  createMessageTemplate,
  replaceAutomationDraftInput,
  type WorkflowEmailStepStatistics,
} from '@repo/contracts';
import {
  automationsApi,
  builderAt,
  checksOf,
  expectNoSidewaysScroll,
  runsApi,
  step,
  world,
  type World,
} from './automation-api';
import { automationOf, followUp, harborSetup } from './automation-fixtures';
import { fakeMediaApi, mediaFileOf } from './media-fixtures';
import { harbor, signedIn } from './session';
import { templateId, templateOf, templateServer, type TemplateServer } from './template-fixtures';

// Kept where the owner can open them after the run: reports/ is not cleared between runs.
const shots = path.join(import.meta.dirname, '..', 'reports', 'email-step');
mkdirSync(shots, { recursive: true });
const shot = (name: string): string => path.join(shots, name);

/**
 * The page checked for accessibility, each fault named with where it is. The email's own
 * frame is not gone into: it is sandboxed, so nothing can be run inside it (the checker
 * would wait a minute for an answer that cannot come), and what it holds is the email, not
 * the dashboard. The frame itself is checked: it has a title.
 */
async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .options({ iframes: false })
    // The page alone is asked: asking each frame would never return from the sandboxed one.
    .setLegacyMode(true)
    .analyze();
  expect(
    results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`,
    ),
  ).toEqual([]);
}

const revision = 'a'.repeat(64);
const guide = templateOf({
  id: templateId('2q'),
  name: 'Pricing guide',
  subject: 'Your guide, {{contact.firstName}}',
  content: {
    format: 'html',
    html: '<p>Hi {{contact.firstName}},</p><p>Here is our pricing guide.</p>',
    text: 'Hi {{contact.firstName}},\n\nHere is our pricing guide.',
  },
  revision,
});
/** Sixty templates: the guide, and fifty-nine wedding emails, each with its own subject. */
const sixty = [
  guide,
  ...Array.from({ length: 59 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return templateOf({
      id: templateId(number),
      name: `Wedding ${number}`,
      subject: `Save the date ${number}`,
      body: `Wedding email ${number}`,
      folder:
        index % 2 === 0
          ? null
          : { id: 'tfld_01h455vb4pex5vsknk084sn02q', name: 'Sales', path: ['Sales'] },
      revision,
    });
  }),
];
const setup = {
  ...harborSetup,
  emailTemplates: [{ id: guide.id, name: guide.name }],
};
const copied = {
  mode: 'copy',
  source: { id: guide.id, revision },
  subject: 'Your guide, {{contact.firstName}}',
  body: 'Hi {{contact.firstName}},\n\nHere is our pricing guide.',
  html: '<p>Hi {{contact.firstName}},</p><p>Here is our pricing guide.</p>',
};

const withEmail = (config: Record<string, unknown>): World =>
  world({
    setup,
    automations: [
      automationOf({
        draft: {
          ...followUp,
          steps: { ...followUp.steps, send_guide: { ...followUp.steps.send_guide, config } },
        },
      }),
    ],
  });

/** Signs in, serves the builder and the template library, and opens the Steps view. */
async function open(page: Page, state: World): Promise<TemplateServer> {
  await signedIn(page);
  await automationsApi(page, state);
  await runsApi(page, state);
  const library = await templateServer(page, sixty);
  await page.route('**/api/v1/contacts?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'con_01h455vb4pex5vsknk084sn02q',
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            phone: null,
            createdAt: '2026-10-09T09:00:00.000Z',
          },
        ],
        next: null,
        canManage: true,
      },
    }),
  );
  await page.goto(builderAt('steps'));
  await expect(page.getByRole('navigation', { name: 'Automation views' })).toBeVisible();
  return library;
}

const emailPanel = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Send email', exact: true });
const editEmail = async (page: Page): Promise<Locator> => {
  await step(page, 'send_guide')
    .getByRole('button', { name: /^Edit:/ })
    .click();
  const panel = emailPanel(page);
  await expect(panel.getByLabel('From name', { exact: true })).toBeVisible();
  return panel;
};
const savedEmail = (state: World): Record<string, unknown> => {
  const save = state.writes.findLast((write) => write.method === 'PUT');
  const steps = replaceAutomationDraftInput.parse(save?.body).document['steps'] as Record<
    string,
    { config: Record<string, unknown> }
  >;
  const config = steps['send_guide']?.config ?? {};
  // What the builder saves is a Send email step the contract accepts.
  expect(automationStepTypes['email.send'].config.safeParse(config).success).toBe(true);
  return config;
};

for (const width of [360, 1440])
  test.describe(`the Send email action at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 1000 } });
    // Each walks a whole flow, with an accessibility check and a screenshot at every stop.
    test.describe.configure({ timeout: 120_000 });

    test('finds a template by its subject among sixty, and sets who it is from, Cc, subject and preview text', async ({
      page,
    }) => {
      const state = withEmail({ subject: 'Hello', body: 'Welcome.' });
      await open(page, state);
      const copies: unknown[] = [];
      await page.route('**/api/v1/automations/*/draft/email-template-copy', async (route) => {
        const input = copyWorkflowEmailTemplate.body.parse(route.request().postDataJSON());
        copies.push(input);
        const current = state.automations[0];
        if (current === undefined || input.document === undefined) throw new Error('No draft.');
        const saved = { ...current, draft: input.document, draftVersion: 4 };
        state.automations[0] = saved;
        await route.fulfill({
          json: { automation: saved, validation: checksOf(input.document, state.setup) },
        });
      });
      const panel = await editEmail(page);
      await panel.getByRole('radio', { name: 'Select existing template', exact: true }).check();

      // The list: sixty templates, a first screenful, under their folders, each with its
      // subject and whether it is formatted.
      await panel.getByRole('button', { name: /^Email template: / }).click();
      const search = page.getByRole('combobox', { name: 'Search by name or subject' });
      await expect(search).toBeFocused();
      await expect(page.getByText('Showing 50 of 60. Type to narrow the list.')).toBeVisible();
      const list = page.getByRole('listbox', { name: 'Email template', exact: true });
      await expect(list.getByRole('group', { name: 'Sales', exact: true })).toBeVisible();
      await expect(list.getByRole('option', { name: /^Pricing guide/ })).toContainText('Formatted');
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`template-picker-${String(width)}.png`) });
      // By subject, with the keyboard alone.
      await search.fill('save the date 41');
      await expect(list.getByRole('option')).toHaveCount(1);
      await expect(list.getByRole('option')).toContainText('Wedding 41');
      await expect(list.getByRole('option')).toContainText('Plain text');
      await expect(page.getByRole('link', { name: 'Manage templates' })).toHaveAttribute(
        'href',
        `/b/${harbor.slug}/marketing/emails/templates`,
      );
      await page.keyboard.press('Enter');
      await expect(panel.getByRole('button', { name: 'Email template: Wedding 41' })).toBeVisible();
      await expect(
        panel.getByText(/^“Wedding 41” is copied into this action when you save it\./),
      ).toBeVisible();
      // The email as it will look: the server's own answer, in a frame that runs nothing.
      const frame = panel.locator('iframe[title="Preview of the email"]');
      await expect(frame).toHaveAttribute('sandbox', '');
      await expect(frame.contentFrame().getByText('Wedding email 41')).toBeVisible();

      await panel.getByLabel('From name', { exact: true }).fill('Dana at Harbor Lights');
      await panel.getByRole('button', { name: 'Cc', exact: true }).click();
      // The text box: the list of addresses below it is labelled Cc too, once it holds one.
      const cc = panel.getByRole('textbox', { name: 'Cc', exact: true });
      await cc.fill('owner@harbor.example');
      await cc.press('Enter');
      await expect(
        panel.getByRole('list', { name: 'Cc', exact: true }).getByRole('listitem'),
      ).toHaveText(['owner@harbor.example']);
      const subject = panel.getByLabel('Subject (optional)', { exact: true });
      await subject.fill('For you, ');
      await panel.getByRole('button', { name: 'Insert a field into: Subject (optional)' }).click();
      await page.getByRole('combobox', { name: 'Search fields' }).fill('first name');
      await page.keyboard.press('Enter');
      await expect(subject).toHaveValue('For you, {{contact.firstName}}');
      await panel.getByLabel('Preview text (optional)', { exact: true }).fill('Dates and prices');
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`panel-${String(width)}.png`) });

      await panel.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(panel).toBeHidden();
      // Saving the action copies the template into it, through the server's own command.
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({
        step: 'send_guide',
        template: templateId('41'),
        revision,
        document: {
          steps: {
            send_guide: {
              config: {
                template: templateId('41'),
                fromName: 'Dana at Harbor Lights',
                cc: ['owner@harbor.example'],
                subject: 'For you, {{contact.firstName}}',
                preheader: 'Dates and prices',
              },
            },
          },
        },
      });
    });

    test('edits the email in the popup editor: formatting, a merge chip, a picture, a button, a preview for a contact, Save, and Save as new template', async ({
      page,
    }) => {
      const state = withEmail(copied);
      const library = await open(page, state);
      const picture = mediaFileOf('storefront.jpg', 'image/jpeg', {
        public: true,
        publicUrl: 'http://127.0.0.1:4173/m/abc123/storefront.jpg',
      });
      await fakeMediaApi(page, { files: [picture] });
      const panel = await editEmail(page);
      await expect(
        panel.getByRole('button', { name: 'Email template: Pricing guide' }),
      ).toBeVisible();
      // Click the preview to edit.
      await panel.getByRole('button', { name: 'Edit the email', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Email', exact: true });
      const body = editor.getByRole('textbox', { name: 'Email body', exact: true });
      await expect(body).toContainText('Here is our pricing guide.');
      // A merge field of the stored text is a chip.
      await expect(body.locator('[data-merge="contact.firstName"]')).toHaveText(
        '{{contact.firstName}}',
      );
      const toolbar = editor.getByRole('toolbar', { name: 'Formatting', exact: true });
      const tool = (name: string): Locator => toolbar.getByRole('button', { name, exact: true });

      // Formatted text: a new line, bold.
      await body.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await tool('Bold').click();
      await expect(tool('Bold')).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.type('Book early');
      await tool('Bold').click();
      // A merge field from the list, as a chip.
      await page.keyboard.type(' for ');
      await tool('Insert a field').click();
      await page.getByRole('combobox', { name: 'Search fields' }).fill('last name');
      await page.keyboard.press('Enter');
      await expect(body.locator('[data-merge="contact.lastName"]')).toBeVisible();
      // A picture from Media Storage: its description is asked for, and required.
      await tool('Picture').click();
      await page
        .getByRole('dialog', { name: 'Choose a picture', exact: true })
        .getByRole('button', { name: 'Choose storefront.jpg' })
        .click();
      const asking = editor.getByRole('group', { name: 'Picture', exact: true });
      await asking.getByRole('button', { name: 'Insert picture', exact: true }).click();
      await expect(asking.getByRole('alert')).toContainText('Describe the picture');
      await asking.getByLabel('Description (alt text)').fill('Our storefront at night');
      await asking.getByRole('button', { name: 'Insert picture', exact: true }).click();
      await expect(body.locator('img[alt="Our storefront at night"]')).toBeVisible();
      // A button.
      await page.keyboard.press('ArrowRight');
      await tool('Button').click();
      const button = editor.getByRole('group', { name: 'Button', exact: true });
      await button.getByLabel('Button label').fill('Book a call');
      await button.getByLabel('Button link').fill('example.com/book');
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`editor-button-${String(width)}.png`) });
      await button.getByRole('button', { name: 'Insert button', exact: true }).click();
      await expect(body.getByRole('link', { name: 'Book a call' })).toBeVisible();
      // The toolbar is one stop for the Tab key, and the arrow keys move along it.
      await tool('Bold').focus();
      await page.keyboard.press('ArrowRight');
      await expect(tool('Italic')).toBeFocused();
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`editor-${String(width)}.png`) });

      // The plain-text part is written from the formatted one.
      await editor.getByRole('tab', { name: 'Plain text', exact: true }).click();
      await expect(editor.getByLabel('Plain-text part', { exact: true })).toHaveValue(
        /Book early for \{\{contact\.lastName\}\}/,
      );
      // Preview, filled in for a contact; a field she has no value for is named.
      await editor.getByRole('tab', { name: 'Preview', exact: true }).click();
      const preview = editor.locator('iframe[title="Preview of the email"]');
      await expect(preview).toHaveAttribute('sandbox', '');
      await expect(editor.getByText(/^Not filled in here: /)).toContainText(
        '{{contact.firstName}}',
      );
      await editor.getByRole('button', { name: /^Contact to preview with: / }).click();
      await page.getByRole('option', { name: /^Ada Lovelace/ }).click();
      await expect(preview.contentFrame().getByText('Hi Ada,')).toBeVisible();
      await expect(editor.getByText(/^Ada Lovelace has no value for /)).toContainText(
        '{{contact.lastName}}',
      );
      await editor.getByRole('button', { name: 'Mobile', exact: true }).click();
      await expect(editor.getByRole('button', { name: 'Mobile', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`editor-preview-${String(width)}.png`) });

      // Save as new template: a library asset of its own; this email is unchanged.
      await editor.getByRole('button', { name: 'Save as new template', exact: true }).click();
      const saving = editor.getByRole('form', { name: 'Save as new template', exact: true });
      await saving.getByLabel('New template name').fill('Storefront guide');
      await saving.getByRole('button', { name: 'Save template', exact: true }).click();
      await expect(
        editor.getByText('Saved “Storefront guide” as a new template. This email is unchanged.'),
      ).toBeVisible();
      const created = createMessageTemplate.body.parse(library.requests.at(-1)?.body);
      expect(created.name).toBe('Storefront guide');
      expect(created.content).toMatchObject({ format: 'html' });

      // Closing with changes asks first; Save keeps them in the action.
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      const leaving = editor.getByRole('alertdialog', { name: 'Leave without saving?' });
      await leaving.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor.getByText('Saved.', { exact: true })).toBeVisible();
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(editor).toBeHidden();

      await panel.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(panel).toBeHidden();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      const config = savedEmail(state);
      // Still an independent copy, with where it came from.
      expect(config).toMatchObject({ mode: 'copy', source: { id: guide.id, revision } });
      const html = String(config['html']);
      // Merge fields are {{path}} text again; nothing of the editor's own is left.
      expect(html).toContain('<p>Hi {{contact.firstName}},</p>');
      expect(html).toContain('<strong>Book early</strong> for {{contact.lastName}}');
      expect(html).not.toContain('data-merge');
      expect(html).not.toContain('class=');
      expect(html).toContain(
        '<img src="/m/abc123/storefront.jpg" alt="Our storefront at night" width="100%"',
      );
      expect(html).toContain('<table role="presentation"');
      expect(html).toContain(
        '<a href="https://example.com/book" target="_blank" rel="noopener noreferrer"',
      );
      expect(String(config['body'])).toContain('Book early for {{contact.lastName}}');
      expect(String(config['body'])).toContain('[Our storefront at night]');
    });

    test('shows a syncing email with the other workflows that use its template, and its attachments', async ({
      page,
    }) => {
      const file = mediaFileOf('price-list.pdf', 'application/pdf', { size: 860_160 });
      const state = withEmail({
        mode: 'sync',
        source: { id: guide.id, revision },
        attachments: [file.id],
      });
      const library = await open(page, state);
      const extra = mediaFileOf('menu.pdf', 'application/pdf', { size: 20_480 });
      await fakeMediaApi(page, { files: [file, extra] });
      library.uses[guide.id] = [
        {
          automation: {
            id: 'aut_01k8e2wzr0e008000000000099',
            name: 'DJ enquiry',
            status: 'active',
          },
          scope: 'published',
          version: null,
          step: 'send_prices',
          label: 'Prices',
          mode: 'sync',
          sourceRevision: revision,
          current: null,
        },
      ];
      const panel = await editEmail(page);
      await expect(panel.getByRole('checkbox', { name: 'Sync edits to template' })).toBeChecked();
      await expect(
        panel.getByText(
          'Syncing with “Pricing guide”: every send uses the template as it is then.',
        ),
      ).toBeVisible();
      await expect(
        panel
          .getByRole('list', { name: 'Other workflow actions that use this template' })
          .getByRole('listitem'),
      ).toHaveText(['DJ enquiry · Prices (syncs with it)']);
      // The template itself is what is shown.
      await expect(
        panel
          .locator('iframe[title="Preview of the email"]')
          .contentFrame()
          .getByText('Here is our pricing guide.'),
      ).toBeVisible();

      // Attachments: listed with their size, one added from Media Storage, one taken off.
      const attachments = panel.getByRole('list', { name: 'Attachments', exact: true });
      await expect(attachments.getByRole('listitem')).toHaveText([/price-list\.pdf.*840 KB/]);
      await panel.getByRole('button', { name: 'Add attachments', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Attach a file', exact: true })
        .getByRole('button', { name: 'Choose menu.pdf' })
        .click();
      await expect(attachments.getByRole('listitem')).toHaveCount(2);
      await panel.evaluate((element) => {
        element.scrollTo(0, element.scrollHeight);
      });
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`sync-attachments-${String(width)}.png`) });
      await attachments.getByRole('button', { name: 'Remove price-list.pdf' }).click();
      await expect(attachments.getByRole('listitem')).toHaveText([/menu\.pdf.*20 KB/]);

      await panel.getByRole('button', { name: 'Save action', exact: true }).click();
      await expect(panel).toBeHidden();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
      expect(savedEmail(state)).toEqual({
        mode: 'sync',
        source: { id: guide.id, revision },
        attachments: [extra.id],
      });
    });

    test('has a Statistics tab where nothing unmeasured reads as zero', async ({ page }) => {
      const state = withEmail(copied);
      await open(page, state);
      const asked: string[] = [];
      const statistics: WorkflowEmailStepStatistics = {
        step: 'send_guide',
        from: null,
        to: null,
        total: 1240,
        waiting: 3,
        sent: 1100,
        delivered: null,
        bounced: 0,
        failed: 5,
        skipped: {
          total: 132,
          reasons: [
            { reason: 'unsubscribed', count: 95 },
            { reason: 'no_consent', count: 37 },
          ],
        },
        unsubscribed: 7,
        opened: null,
        clicked: null,
      };
      await page.route('**/api/v1/automations/*/steps/*/email-statistics**', async (route) => {
        asked.push(new URL(route.request().url()).search);
        await route.fulfill({ json: statistics });
      });
      const panel = await editEmail(page);
      const tabs = panel.getByRole('tablist', { name: 'Send email', exact: true });
      await expect(tabs.getByRole('tab')).toHaveText(['Edit action', 'Statistics']);
      await tabs.getByRole('tab', { name: 'Statistics', exact: true }).click();
      const shown = (key: string): Locator => panel.locator(`[data-statistic="${key}"] dd`).first();
      await expect(shown('sent')).toHaveText('1,100');
      await expect(shown('bounced')).toHaveText('0');
      await expect(shown('delivered')).toHaveText('Not measured');
      await expect(shown('opened')).toHaveText('Not tracked yet');
      await expect(shown('clicked')).toHaveText('Not tracked yet');
      await expect(panel.getByText('No consent to marketing email')).toBeVisible();
      // The last thirty days by default; another range asks again.
      expect(asked.at(-1)).toMatch(/^\?from=/);
      await panel.getByLabel('Dates', { exact: true }).selectOption('all');
      await expect.poll(() => asked.at(-1)).toBe('');
      await expectNoSidewaysScroll(page);
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`statistics-${String(width)}.png`) });
      // The settings are behind the other tab, as they were.
      await tabs.getByRole('tab', { name: 'Edit action', exact: true }).click();
      await expect(panel.getByLabel('Subject', { exact: true })).toHaveValue(
        'Your guide, {{contact.firstName}}',
      );
    });

    test('opens a formatted template in the same editor from the Templates page', async ({
      page,
    }) => {
      await signedIn(page);
      const library = await templateServer(page, [guide, sixty[1] ?? guide]);
      library.uses[guide.id] = [
        {
          automation: {
            id: 'aut_01k8e2wzr0e008000000000099',
            name: 'DJ enquiry',
            status: 'active',
          },
          scope: 'draft',
          version: null,
          step: 'send_prices',
          label: null,
          mode: 'copy',
          sourceRevision: revision,
          current: true,
        },
      ];
      await page.goto(`/b/${harbor.slug}/marketing/emails/templates`);
      const row = page.getByRole('row').filter({ hasText: 'Pricing guide' });
      await expect(row).toContainText(width >= 768 ? 'Designed' : 'Used in 1 workflow');
      await expect(row).toContainText('Used in 1 workflow');
      if (width >= 768)
        await expect(page.getByRole('row').filter({ hasText: 'Wedding 01' })).toContainText(
          'Plain text',
        );
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`templates-${String(width)}.png`) });

      await row.getByRole('button', { name: 'Open Pricing guide' }).click();
      await expect(page.getByRole('dialog', { name: 'Pricing guide', exact: true })).toBeVisible();
      // By what it holds: its name is about to change.
      const editor = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('textbox', { name: 'Email body', exact: true }) });
      const body = editor.getByRole('textbox', { name: 'Email body', exact: true });
      await expect(body.locator('[data-merge="contact.firstName"]')).toBeVisible();
      await editor.getByRole('button', { name: 'Rename', exact: true }).click();
      await editor.getByLabel('Name', { exact: true }).fill('Pricing guide 2027');
      await editor.getByRole('button', { name: 'Done renaming' }).click();
      await body.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' See you soon.');
      await expectNoViolations(page);
      await page.screenshot({ path: shot(`templates-editor-${String(width)}.png`) });
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor.getByText('Saved.', { exact: true })).toBeVisible();
      expect(library.requests.at(-1)).toMatchObject({
        method: 'PUT',
        body: {
          name: 'Pricing guide 2027',
          revision,
          content: {
            format: 'html',
            html: '<p>Hi {{contact.firstName}},</p><p>Here is our pricing guide. See you soon.</p>',
          },
        },
      });
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(editor).toBeHidden();
      await expect(page.getByRole('row').filter({ hasText: 'Pricing guide 2027' })).toBeVisible();

      // A plain-text template stays plain text, in its own form, until its author formats it.
      await page.getByRole('button', { name: 'Open Wedding 01' }).click();
      const plain = page.getByRole('region', { name: 'Wedding 01', exact: true });
      await expect(plain.getByLabel('Message', { exact: true })).toHaveValue('Wedding email 01');
      await plain.getByRole('button', { name: 'Convert to formatted', exact: true }).click();
      const converted = page.getByRole('dialog', { name: 'Wedding 01', exact: true });
      await expect(converted.getByRole('textbox', { name: 'Email body', exact: true })).toHaveText(
        'Wedding email 01',
      );
      await expect(
        converted.getByText(
          'The plain text is now formatted content. It stays plain text until you save.',
        ),
      ).toBeVisible();
    });
  });
