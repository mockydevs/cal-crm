// Lead source in a browser, with the API answered by the test from fixtures shaped by the
// contract's own types: the form card "When someone sends the form" (tags as chips out of
// sixty, the Source a form writes, the tag by source, "Check a link"), a submission's lead
// source, the contact page's Attribution, and the public booking page sending how the
// visitor arrived. Accessibility is checked at a phone and at a desk, and each screen is
// photographed.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  BOOKING_NOTIFICATION_WORDING,
  createTagInput,
  DEFAULT_FORM_DEFINITION,
  leadSourceLabels,
  leadSourceRuleDescriptions,
  previewLeadSourceInput,
  publicBookingInput,
  updateFormInput,
  type ContactAttribution,
  type ContactAttributions,
  type Form,
  type FormSubmission,
  type LeadSourcePreview,
  type PublicBookingInput,
  type TagConfiguration,
  type UpdateFormInput,
} from '@repo/contracts';
import { emptyContactPanels } from './contact-panels';
import { harbor, inHarbor, signedIn } from './session';

const SHOTS = 'reports/lead-source';
const formId = 'form_01k8e2wzr0e008000000000001';
const at = '2026-10-10T09:00:00.000Z';

const violations = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
    .violations;
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const tagId = (number: number): string =>
  `tag_01k8e2wzr0e00800000000${String(number).padStart(4, '0')}`;
const groups: TagConfiguration['groups'] = [
  {
    id: 'tgrp_01k8e2wzr0e008000000000001',
    name: 'Campaigns',
    description: '',
    revision: 'a'.repeat(64),
  },
  {
    id: 'tgrp_01k8e2wzr0e008000000000002',
    name: 'Lead source',
    description: '',
    revision: 'a'.repeat(64),
  },
];
/** Sixty tags: forty campaigns, the lead source tags the system made, and the rest loose. */
const sixtyTags = (): TagConfiguration['items'] =>
  Array.from({ length: 60 }, (_, index) => {
    const number = index + 1;
    const [name, groupId] =
      number <= 40
        ? [`Campaign ${String(number).padStart(2, '0')}`, groups[0]?.id ?? null]
        : number <= 44
          ? [
              `Source: ${['Google Ads', 'Organic Search', 'Direct', 'Email'][number - 41] ?? ''}`,
              groups[1]?.id ?? null,
            ]
          : [number === 45 ? 'Wedding enquiry' : `Interest ${String(number - 45)}`, null];
    return {
      id: tagId(number),
      name,
      description: '',
      createdAt: at,
      updatedAt: at,
      groupId,
      revision: 'a'.repeat(64),
    };
  });

const formOf = (patch: Partial<Form> = {}): Form => ({
  id: formId,
  name: 'Wedding enquiry',
  status: 'draft',
  publicKey: 'A'.repeat(32),
  allowedOrigins: ['https://www.harborlights.example'],
  definition: DEFAULT_FORM_DEFINITION,
  publishedDefinition: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  problems: [],
  embedSnippet: '',
  hostedUrl: `https://crm.example.test/f/${'k'.repeat(32)}`,
  submissionCount: 0,
  revision: 'a'.repeat(64),
  canManage: true,
  createdAt: at,
  updatedAt: at,
  ...patch,
});

const noFacts = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  matchType: null,
  campaignId: null,
  adGroupId: null,
  adId: null,
  referrerDomain: null,
};

interface World {
  form: Form;
  tags: TagConfiguration['items'];
  writes: UpdateFormInput[];
  made: string[];
  checked: { url: string; referrer?: string | undefined; formId?: string | undefined }[];
  submissions: FormSubmission[];
  /** The lead source each read of the submissions asked for; null for every source. */
  submissionQueries: (string | null)[];
}

/**
 * Stands in for the API the card talks to. Every write is parsed with the contract's own
 * schema. "Check a link" answers as the server would for the form as saved: a Google click
 * id is Google Ads, a paid Facebook link is Facebook Ads, a bare link is Direct.
 */
async function leadSourceApi(page: Page, state: World): Promise<void> {
  let revisions = 0;
  await page.route('**/api/v1/fields', (route) =>
    route.fulfill({
      json: { items: [], objects: [{ key: 'contact', label: 'Contact' }], canManage: true },
    }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({
      json: {
        items: state.tags,
        groups,
        rules: { creation: 'everyone', suggestSimilar: true, revision: 'a'.repeat(64) },
        canManage: true,
        canCreate: true,
      } satisfies TagConfiguration,
    }),
  );
  await page.route('**/api/v1/tags', async (route) => {
    const { name } = createTagInput.parse(route.request().postDataJSON());
    state.made.push(name);
    const made = {
      id: tagId(900 + state.made.length),
      name,
      description: '',
      createdAt: at,
      updatedAt: at,
    };
    state.tags = [...state.tags, { ...made, groupId: null, revision: 'a'.repeat(64) }];
    await route.fulfill({ status: 201, json: made });
  });
  await page.route('**/api/v1/lead-sources/preview', async (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    const asked = previewLeadSourceInput.parse(route.request().postDataJSON());
    state.checked.push(asked);
    const query = new URL(asked.url).searchParams;
    const landingUrl = asked.url.split('?')[0] ?? asked.url;
    const actions = state.form.definition.contactActions;
    const key = query.has('gclid')
      ? 'google_ads'
      : query.get('utm_source') === 'facebook'
        ? 'facebook_ads'
        : 'direct';
    const label = leadSourceLabels[key];
    const own = (actions?.tagIds ?? []).map((id) => ({
      name: state.tags.find((tag) => tag.id === id)?.name ?? '',
      kind: 'form' as const,
      exists: true,
    }));
    const sourceTag = `Source: ${label}`;
    const preview: LeadSourcePreview = {
      sessionSource:
        key === 'google_ads' ? 'paid_search' : key === 'facebook_ads' ? 'paid_social' : 'direct',
      source: label,
      sourceRule: key,
      reason: leadSourceRuleDescriptions[key],
      decidedBy: { kind: 'built_in', key },
      builtIn: { source: label, sourceRule: key },
      rules: [],
      facts: {
        ...noFacts,
        utmSource: query.get('utm_source'),
        utmMedium: query.get('utm_medium'),
        campaignId: query.get('campaign_id'),
        landingUrl,
      },
      clickIds: query.has('gclid') ? ['gclid'] : query.has('fbclid') ? ['fbclid'] : [],
      form: {
        id: formId,
        contactSource:
          actions?.source.kind === 'arrived'
            ? label
            : actions?.source.kind === 'text'
              ? actions.source.text
              : actions?.source.kind === 'form_name'
                ? state.form.name
                : null,
        tags: [
          ...own,
          ...(actions?.tagBySource === true
            ? [
                {
                  name: sourceTag,
                  kind: 'source' as const,
                  exists: state.tags.some((tag) => tag.name === sourceTag),
                },
              ]
            : []),
        ],
      },
      warnings:
        key === 'direct'
          ? [{ code: 'no_tracking', message: 'Nothing in the address says how they arrived.' }]
          : [],
    };
    await route.fulfill({ json: preview });
  });
  await page.route(/\/api\/v1\/forms(?:[/?].*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/forms', '');
    const method = request.method();
    if (path === '' && method === 'GET') {
      await route.fulfill({
        json: {
          items: [
            {
              id: state.form.id,
              name: state.form.name,
              status: state.form.status,
              hasUnpublishedChanges: false,
              submissionCount: state.submissions.length,
              lastSubmissionAt: state.submissions[0]?.submittedAt ?? null,
              updatedAt: at,
            },
          ],
          nextCursor: null,
          canManage: true,
        },
      });
      return;
    }
    if (path === `/${formId}` && method === 'GET') {
      await route.fulfill({ json: { ...state.form, submissionCount: state.submissions.length } });
      return;
    }
    if (path === `/${formId}` && method === 'PUT') {
      const input = updateFormInput.parse(request.postDataJSON());
      expect(input.revision).toBe(state.form.revision);
      state.writes.push(input);
      revisions += 1;
      state.form = {
        ...state.form,
        name: input.name,
        definition: input.definition,
        allowedOrigins: input.allowedOrigins,
        revision: String(revisions).padStart(64, 'b'),
      };
      await route.fulfill({ json: state.form });
      return;
    }
    if (path === `/${formId}/submissions` && method === 'GET') {
      // As the server filters: by the key of the rule that named the lead source.
      const rule = new URL(request.url()).searchParams.get('leadSourceRule');
      state.submissionQueries.push(rule);
      await route.fulfill({
        json: {
          items: state.submissions.filter((each) => rule === null || each.leadSourceRule === rule),
          nextCursor: null,
          canManage: true,
        },
      });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { type: 'about:blank', title: 'Not Found', status: 404 },
    });
  });
}

const worldOf = (patch: Partial<World> = {}): World => ({
  form: formOf(),
  tags: sixtyTags(),
  writes: [],
  made: [],
  checked: [],
  submissions: [],
  submissionQueries: [],
  ...patch,
});

async function openForm(page: Page): Promise<void> {
  await page.goto(inHarbor('/settings/forms'));
  await page.getByRole('button', { name: 'Open Wedding enquiry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'When someone sends the form' })).toBeVisible();
}
const saved = async (page: Page, state: World): Promise<UpdateFormInput['definition']> => {
  const before = state.writes.length;
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(before + 1);
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  const last = state.writes.at(-1);
  if (last === undefined) throw new Error('A save.');
  return last.definition;
};

for (const width of [360, 1440]) {
  test.describe(`at ${String(width)}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 950 });
    });

    test('picks tags as chips out of sixty: adds by search, removes, and makes a new one', async ({
      page,
    }) => {
      await signedIn(page);
      const state = worldOf({
        form: formOf({
          definition: {
            ...DEFAULT_FORM_DEFINITION,
            contactActions: {
              tagIds: [tagId(45), tagId(3)],
              source: { kind: 'arrived' },
              tagBySource: true,
            },
          },
        }),
      });
      await leadSourceApi(page, state);
      await openForm(page);
      const card = page.getByRole('region', { name: 'When someone sends the form' });
      const chips = card.getByRole('list', { name: 'Tags added to the contact' });
      // The chosen tags only, never the business's sixty.
      await expect(chips.getByRole('listitem')).toHaveText(['Wedding enquiry', 'Campaign 03']);
      await expect(card.getByRole('checkbox')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await card.scrollIntoViewIfNeeded();
      await shot(page, `${String(width)}-card`);

      // The plus opens a search over every tag, grouped as the business grouped them.
      await card.getByRole('button', { name: 'Add tag', exact: true }).click();
      const search = page.getByRole('combobox', { name: 'Search tags' });
      await expect(search).toBeFocused();
      const list = page.getByRole('listbox', { name: 'Tags to add' });
      await expect(list.getByRole('option')).toHaveCount(50);
      await expect(page.getByText('Showing 50 of 58. Type to narrow the list.')).toBeVisible();
      await expect(list.getByRole('group', { name: 'Campaigns' })).toBeVisible();
      expect(await violations(page)).toEqual([]);

      // By keyboard alone: type, arrow, Enter. The panel stays open for the next one.
      await page.keyboard.type('campaign 1');
      await expect(list.getByRole('option')).toHaveText([
        'Campaign 10',
        'Campaign 11',
        'Campaign 12',
        'Campaign 13',
        'Campaign 14',
        'Campaign 15',
        'Campaign 16',
        'Campaign 17',
        'Campaign 18',
        'Campaign 19',
        'Create tag “campaign 1”',
      ]);
      // The first match is ready; the arrows move from it and back.
      await expect(search).toHaveAttribute(
        'aria-activedescendant',
        (await list.getByRole('option').first().getAttribute('id')) ?? '',
      );
      await page.keyboard.press('ArrowDown');
      await expect(list.getByRole('option', { name: 'Campaign 11' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');
      await expect(chips.getByRole('listitem')).toHaveText([
        'Wedding enquiry',
        'Campaign 03',
        'Campaign 10',
      ]);
      await expect(search).toHaveValue('');
      await expect(search).toBeFocused();
      await page.keyboard.type('organic');
      await expect(list.getByRole('group', { name: 'Lead source' })).toBeVisible();
      await shot(page, `${String(width)}-card-tag-picker`);
      expect(await violations(page)).toEqual([]);
      await list.getByRole('option', { name: 'Source: Organic Search' }).click();

      // A name no tag has yet: made, and on the form at once.
      await search.fill('VIP guest');
      await expect(list.getByRole('option')).toHaveText(['Create tag “VIP guest”']);
      await page.keyboard.press('Enter');
      await expect(chips.getByRole('listitem')).toHaveText([
        'Wedding enquiry',
        'Campaign 03',
        'Campaign 10',
        'Source: Organic Search',
        'VIP guest',
      ]);
      expect(state.made).toEqual(['VIP guest']);
      await page.keyboard.press('Escape');
      await expect(search).toHaveCount(0);

      // Each chip has its own button, and the keyboard is not lost when one goes.
      await chips.getByRole('button', { name: 'Remove Campaign 03', exact: true }).click();
      await expect(chips.getByRole('listitem')).toHaveCount(4);
      await expect(card.getByRole('button', { name: 'Add tag', exact: true })).toBeFocused();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);

      const definition = await saved(page, state);
      expect(definition.contactActions).toEqual({
        tagIds: [tagId(45), tagId(10), tagId(42), tagId(901)],
        source: { kind: 'arrived' },
        tagBySource: true,
      });
    });

    test('chooses each source, the tag by source, and saves what the contract stores', async ({
      page,
    }) => {
      await signedIn(page);
      const state = worldOf();
      await leadSourceApi(page, state);
      await openForm(page);
      const card = page.getByRole('region', { name: 'When someone sends the form' });
      const source = card.getByRole('radiogroup', { name: 'Source written on the contact' });
      await expect(source.getByRole('radio')).toHaveCount(4);
      // A new form reads how they arrived, and tags by it.
      await expect(
        source.getByRole('radio', { name: 'From how they arrived (recommended)' }),
      ).toBeChecked();
      const toggle = card.getByRole('switch', { name: 'Also tag by source' });
      await expect(toggle).toBeChecked();
      await expect(
        card.getByText('A contact who already has a source keeps it; tags are always added.'),
      ).toBeVisible();

      await source.getByRole('radio', { name: 'A name I write' }).check();
      await card.getByRole('textbox', { name: 'Source to write' }).fill('Open day 2026');
      expect((await saved(page, state)).contactActions).toEqual({
        tagIds: [],
        source: { kind: 'text', text: 'Open day 2026' },
        tagBySource: true,
      });
      // With the keyboard: the arrows move through the group, as radios do.
      await source.getByRole('radio', { name: 'A name I write' }).focus();
      await page.keyboard.press('ArrowDown');
      await expect(source.getByRole('radio', { name: 'The name of this form' })).toBeChecked();
      await expect(
        card.getByText('“Wedding enquiry” for everyone who sends this form.'),
      ).toBeVisible();
      expect((await saved(page, state)).contactActions?.source).toEqual({ kind: 'form_name' });

      await source.getByRole('radio', { name: 'Leave it empty' }).check();
      await toggle.uncheck();
      expect((await saved(page, state)).contactActions).toEqual({
        tagIds: [],
        source: { kind: 'none' },
        tagBySource: false,
      });

      await source.getByRole('radio', { name: 'From how they arrived (recommended)' }).check();
      await toggle.check();
      expect((await saved(page, state)).contactActions).toEqual({
        tagIds: [],
        source: { kind: 'arrived' },
        tagBySource: true,
      });

      // The names it can write are the server's list, shown only when asked for.
      await card.getByRole('button', { name: 'The names “how they arrived” can be' }).click();
      await expect(card.getByText(leadSourceRuleDescriptions.organic_search)).toBeVisible();
      await expect(card.getByText(leadSourceLabels.microsoft_ads, { exact: true })).toBeVisible();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await card.scrollIntoViewIfNeeded();
      await shot(page, `${String(width)}-card-source-names`);
    });

    test('checks a Google ad link, a Facebook ad link and a bare link: three different outcomes', async ({
      page,
    }) => {
      await signedIn(page);
      const state = worldOf({
        form: formOf({
          definition: {
            ...DEFAULT_FORM_DEFINITION,
            contactActions: {
              tagIds: [tagId(45)],
              source: { kind: 'arrived' },
              tagBySource: true,
            },
          },
        }),
      });
      await leadSourceApi(page, state);
      await openForm(page);
      const card = page.getByRole('region', { name: 'When someone sends the form' });
      const opener = card.getByRole('button', { name: 'Check a link', exact: true });
      await expect(opener).toHaveAttribute('aria-expanded', 'false');
      await opener.click();
      const check = card.getByRole('group', { name: 'Check a link' });
      const link = check.getByRole('textbox', { name: 'Link they follow' });
      const outcome = async (): Promise<Record<string, string>> =>
        check
          .locator('dl')
          .evaluate((list) =>
            Object.fromEntries(
              [...list.querySelectorAll('dt')].map((term) => [
                term.textContent,
                term.nextElementSibling?.textContent ?? '',
              ]),
            ),
          );

      // Nothing typed: told so by the box, and nothing is asked.
      await check.getByRole('button', { name: 'Check', exact: true }).click();
      await expect(check.getByRole('alert')).toHaveText(
        'Enter a web address, starting with https://.',
      );
      expect(state.checked).toEqual([]);
      expect(await violations(page)).toEqual([]);

      // A Google ad's final address, pasted as people copy it, checked with Enter.
      await link.fill(
        'www.harborlights.example/open-day?utm_source=google&utm_medium=cpc&campaign_id=4242&gclid=Cj0KCQexample',
      );
      await link.press('Enter');
      await expect(check.getByText('Google Ads', { exact: true }).first()).toBeVisible();
      expect(await outcome()).toEqual({
        'Lead source': 'Google Ads',
        'Session source': 'Paid Search',
        'Decided by': leadSourceRuleDescriptions.google_ads,
        'Source written on the contact': 'Google Ads (only if the contact has none yet)',
        'Tags added': 'Wedding enquirySource: Google Ads',
        'Click ids in the link': 'Google',
      });
      // Enter checked the link: it did not save the form.
      expect(state.writes).toEqual([]);
      expect(state.checked[0]).toEqual({
        url: 'https://www.harborlights.example/open-day?utm_source=google&utm_medium=cpc&campaign_id=4242&gclid=Cj0KCQexample',
        formId,
      });
      // The click id's value is on the page only where it was typed.
      await expect(check.locator('dl')).not.toContainText('Cj0KCQexample');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await check.scrollIntoViewIfNeeded();
      await shot(page, `${String(width)}-card-check-link-google`);

      // The same form, a Facebook ad: another lead source, another tag, made on first use.
      await link.fill(
        'https://www.harborlights.example/open-day?utm_source=facebook&utm_medium=paid_social&fbclid=IwAR0example',
      );
      await check
        .getByRole('textbox', { name: 'Where they came from (optional)' })
        .fill('https://l.facebook.com/');
      await check.getByRole('button', { name: 'Check', exact: true }).click();
      await expect(check.getByText('Facebook Ads', { exact: true }).first()).toBeVisible();
      expect(await outcome()).toEqual({
        'Lead source': 'Facebook Ads',
        'Session source': 'Paid Social',
        'Decided by': leadSourceRuleDescriptions.facebook_ads,
        'Source written on the contact': 'Facebook Ads (only if the contact has none yet)',
        'Tags added': 'Wedding enquirySource: Facebook Ads (made by the first such lead)',
        'Click ids in the link': 'Meta',
      });
      expect(state.checked[1]?.referrer).toBe('https://l.facebook.com/');
      await shot(page, `${String(width)}-card-check-link-facebook`);

      // A link with no tracking: said plainly, and Direct.
      await link.fill('https://www.harborlights.example/open-day');
      await check.getByRole('textbox', { name: 'Where they came from (optional)' }).fill('');
      await check.getByRole('button', { name: 'Check', exact: true }).click();
      await expect(
        check.getByText(
          'This link carries nothing that tells us where the visitor came from, so it would be recorded as Direct.',
          { exact: false },
        ),
      ).toBeVisible();
      expect(await outcome()).toEqual({
        'Lead source': 'Direct',
        'Session source': 'Direct Traffic',
        'Decided by': leadSourceRuleDescriptions.direct,
        'Source written on the contact': 'Direct (only if the contact has none yet)',
        'Tags added': 'Wedding enquirySource: Direct',
      });
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-card-check-link-bare`);

      // A change not yet saved is not in the answer, and the card says so.
      await card.getByRole('switch', { name: 'Also tag by source' }).uncheck();
      await expect(
        check.getByText(
          'This checks the form as last saved. Save the draft to check what you changed.',
        ),
      ).toBeVisible();
    });

    test("shows each submission's lead source", async ({ page }) => {
      await signedIn(page);
      const submissionOf = (number: number, patch: Partial<FormSubmission>): FormSubmission => ({
        id: `fsub_01k8e2wzr0e00800000000000${String(number)}`,
        submittedAt: `2026-10-10T1${String(number)}:00:00.000Z`,
        contactId: `con_01k8e2wzr0e00800000000000${String(number)}`,
        contactOutcome: 'created',
        answers: [{ key: 'email', label: 'Email', value: `lead${String(number)}@example.test` }],
        consents: [],
        terms: [],
        skippedFields: [],
        origin: 'https://www.harborlights.example',
        pageUrl: 'https://www.harborlights.example/open-day',
        ipAddress: null,
        utm: {},
        leadSource: null,
        leadSourceRule: null,
        ...patch,
      });
      const state = worldOf({
        submissions: [
          submissionOf(3, {
            leadSource: 'Google Ads',
            leadSourceRule: 'google_ads',
            utm: { source: 'google', medium: 'cpc' },
          }),
          submissionOf(2, { leadSource: 'Facebook Ads', leadSourceRule: 'facebook_ads' }),
          // Stored before lead sources were kept.
          submissionOf(1, {}),
        ],
      });
      await leadSourceApi(page, state);
      await page.goto(inHarbor('/settings/forms'));
      await page.getByRole('button', { name: 'Open Wedding enquiry', exact: true }).click();
      await page.getByRole('button', { name: 'Submissions (3)', exact: true }).click();
      const cards = page
        .getByRole('list', { name: 'Submissions, newest first', exact: true })
        .getByRole('article');
      await expect(cards).toHaveCount(3);
      await expect(cards.nth(0)).toContainText('Lead sourceGoogle Ads');
      await expect(cards.nth(1)).toContainText('Lead sourceFacebook Ads');
      await expect(cards.nth(2)).not.toContainText('Lead source');
      // The page address stays with each one.
      await expect(cards.nth(0)).toContainText('https://www.harborlights.example/open-day');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-submissions`);

      // Narrowed to one lead source: the server is asked by the rule's key, and answers
      // that source's submissions alone.
      const filter = page.getByRole('combobox', { name: 'Lead source', exact: true });
      await expect(filter).toHaveValue('');
      await filter.selectOption({ label: 'Facebook Ads' });
      await expect(cards).toHaveCount(1);
      await expect(cards.nth(0)).toContainText('Lead sourceFacebook Ads');
      expect(state.submissionQueries.at(-1)).toBe('facebook_ads');
      // By the keyboard too: the choice above it in the list.
      await filter.focus();
      await filter.press('ArrowUp');
      await expect(filter).toHaveValue('microsoft_ads');
      await expect(
        page.getByText('No submission of this form arrived this way.', { exact: true }),
      ).toBeVisible();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-submissions-filtered`);
      await filter.selectOption({ label: 'Every lead source' });
      await expect(cards).toHaveCount(3);
      expect(state.submissionQueries.at(-1)).toBeNull();
    });

    test("shows a contact's lead source, ids and whose click ids are held, never an id", async ({
      page,
    }) => {
      const id = 'con_01m4bd188ff82s0add91b7pz63';
      const touches: ContactAttributions = {
        first: {
          touchedAt: '2026-09-20T08:30:00.000Z',
          medium: 'form',
          sessionSource: 'paid_search',
          utmSource: 'google',
          utmMedium: 'cpc',
          utmCampaign: 'spring-open-day',
          utmContent: null,
          utmTerm: 'wedding venue',
          matchType: 'e',
          campaignId: '4242',
          adGroupId: '77',
          adId: '9001',
          referrerDomain: 'google.com',
          landingUrl: 'https://harborlights.example/open-day',
          pageUrl: 'https://harborlights.example/open-day',
          source: 'Google Ads',
          sourceRule: 'google_ads',
          clickIds: ['gclid'],
          // The API sends no click id. This stands for an answer that still carried one:
          // the page shows whose are held and reads nothing else.
          gclid: 'Cj0KCQ-secret-google',
        },
        latest: {
          touchedAt: '2026-10-08T11:00:00.000Z',
          medium: 'calendar',
          sessionSource: 'paid_social',
          utmSource: 'facebook',
          utmMedium: 'paid_social',
          utmCampaign: null,
          utmContent: null,
          utmTerm: null,
          matchType: null,
          campaignId: '120211',
          adGroupId: null,
          adId: null,
          referrerDomain: 'l.facebook.com',
          landingUrl: 'https://harborlights.example/book',
          pageUrl: 'https://harborlights.example/book',
          source: 'Facebook Ads',
          sourceRule: 'facebook_ads',
          clickIds: ['fbclid', 'msclkid'],
        },
      };
      let answer: ContactAttributions = touches;
      await signedIn(page);
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
      await page.route(`**/api/v1/records/${id}/tags`, (route) =>
        route.fulfill({ json: { items: [], canManage: true } }),
      );
      await page.route('**/api/v1/tag-configuration', (route) =>
        route.fulfill({
          json: {
            items: [],
            groups: [],
            rules: { creation: 'admins', suggestSimilar: true, revision: 'a'.repeat(64) },
            canManage: true,
            canCreate: true,
          } satisfies TagConfiguration,
        }),
      );
      await page.route(`**/api/v1/contacts/${id}/attribution`, (route) =>
        route.fulfill({ json: answer }),
      );
      await page.goto(inHarbor(`/contacts/${id}`));
      const group = page.getByRole('group', { name: 'Attribution', exact: true });
      const first = group.getByRole('group', { name: 'First attribution' });
      // In the order the page lists them: the lead source leads.
      await expect(first.locator('dt')).toHaveText([
        'Lead source',
        'Session source',
        'Medium',
        'UTM source',
        'UTM medium',
        'UTM campaign',
        'UTM term',
        'Match type',
        'Campaign ID',
        'Ad group ID',
        'Ad ID',
        'Referrer',
        'Landing page',
        'When',
        'Click ids held',
      ]);
      await expect(first).toContainText('Lead sourceGoogle Ads');
      await expect(first).toContainText('Session sourcePaid Search');
      await expect(first).toContainText('Campaign ID4242');
      await expect(first).toContainText('Ad group ID77');
      await expect(first).toContainText('Ad ID9001');
      await expect(first).toContainText('Click ids heldGoogle');
      const latest = group.getByRole('group', { name: 'Latest attribution' });
      await expect(latest).toContainText('Lead sourceFacebook Ads');
      await expect(latest).toContainText('Click ids heldMeta, Microsoft');
      await expect(latest).not.toContainText('UTM campaign');
      // No click id is anywhere on the page.
      await expect(page.locator('body')).not.toContainText('secret');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await group.scrollIntoViewIfNeeded();
      await shot(page, `${String(width)}-contact-attribution`);

      // Found by its new fields in the field search.
      await page.getByRole('searchbox', { name: 'Search fields and folders' }).fill('lead source');
      await expect(first).toBeVisible();
      await page.getByRole('searchbox', { name: 'Search fields and folders' }).fill('');

      // One touch added by hand: no lead source, and nothing more to list.
      const byHand = {
        ...(touches.first as ContactAttribution),
        medium: 'manual' as const,
        sessionSource: 'crm_ui' as const,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        matchType: null,
        campaignId: null,
        adGroupId: null,
        adId: null,
        referrerDomain: null,
        landingUrl: null,
        pageUrl: null,
        source: null,
        sourceRule: null,
        clickIds: [],
      };
      answer = { first: byHand, latest: byHand };
      await page.reload();
      await expect(first).toContainText('Lead source--Not set');
      await expect(
        first.getByText(
          'Nothing more is known of this touch: no campaign labels, ids or referrer.',
        ),
      ).toBeVisible();
      await expect(page.getByText('Latest attribution is the same')).toBeVisible();
      expect(await violations(page)).toEqual([]);
      answer = { first: null, latest: null };
      await page.reload();
      await expect(page.getByText('No touch is recorded for this contact yet.')).toBeVisible();
    });

    test('the booking page sends how the visitor arrived: an ad link its labels, a bare link none', async ({
      page,
    }) => {
      const inputs: PublicBookingInput[] = [];
      const base = '/api/v1/public/book/agency/events/venue-tour';
      await page.route(`**${base}**`, async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'POST') {
          inputs.push(publicBookingInput.parse(route.request().postDataJSON()));
          await route.fulfill({
            json: {
              status: 'booked',
              startsAt: '2030-10-01T00:30:00Z',
              endsAt: '2030-10-01T01:00:00Z',
            },
          });
          return;
        }
        if (url.pathname.endsWith('/slots')) {
          await route.fulfill({
            json: { slots: [{ startsAt: '2030-10-01T00:30:00Z', endsAt: '2030-10-01T01:00:00Z' }] },
          });
          return;
        }
        await route.fulfill({
          json: {
            name: 'Venue tour',
            description: 'Visit the waterfront venue.',
            timezone: 'UTC',
            slotMinutes: 30,
            durations: [30],
            renderToken: `1790000000000.${'a'.repeat(43)}`,
            notificationWording: BOOKING_NOTIFICATION_WORDING,
            appearance: {
              style: 'neo',
              primaryColor: '#178af6',
              backgroundColor: '#ffffff',
              buttonText: '',
              logoUrl: null,
              coverUrl: null,
            },
          },
        });
      });
      const book = async (address: string, referer?: string): Promise<void> => {
        await page.goto(address, referer === undefined ? {} : { referer });
        await expect(page.getByRole('heading', { name: 'Venue tour', exact: true })).toBeVisible();
        await page.getByLabel('Appointment date', { exact: true }).fill('2030-10-01');
        await page.getByRole('radio', { name: /00:30/ }).check();
        await page.getByLabel('Email', { exact: true }).fill('lead@example.test');
        await page.getByRole('checkbox', { name: BOOKING_NOTIFICATION_WORDING }).check();
      };
      const origin = 'http://127.0.0.1:4173';
      const ad =
        '/book/agency/events/venue-tour?utm_source=google&utm_medium=cpc&utm_campaign=spring&campaign_id=4242&gclid=Cj0KCQexample';
      await book(`${ad}#times`, 'https://www.google.com/aclk?sa=l&q=venue+tour');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-booking`);
      await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Appointment booked', exact: true }),
      ).toBeVisible();
      // The page's own address with its query, without its fragment; the referrer's origin
      // and nothing of its path.
      expect(inputs[0]?.visit).toEqual({
        pageUrl: `${origin}${ad}`,
        referrer: 'https://www.google.com',
      });
      // Nothing is kept in the browser beyond the page.
      expect(await page.context().cookies()).toEqual([]);
      expect(
        await page.evaluate(() => [window.localStorage.length, window.sessionStorage.length]),
      ).toEqual([0, 0]);

      await book('/book/agency/events/venue-tour');
      await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Appointment booked', exact: true }),
      ).toBeVisible();
      expect(inputs[1]?.visit).toEqual({ pageUrl: `${origin}/book/agency/events/venue-tour` });
      expect(new URL(inputs[1]?.visit?.pageUrl ?? '').search).toBe('');
    });
  });
}
