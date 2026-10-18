// Settings → Lead Sources in a browser, with the API answered by the test from fixtures
// shaped by the contract's own types (lead-sources-fixtures.ts): the business's own rules
// (made, reordered, switched off, tried against a link), the tracking link builder (Google
// in both forms, Meta, and what each will record), "Check a link" with every step of the
// decision, a site's "Remember how visitors arrived", and the carried arrival on a contact.
// Accessibility is checked at a phone and at a desk, and each screen is photographed.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { ContactAttributions, FormList, TagConfiguration } from '@repo/contracts';
import { emptyContactPanels } from './contact-panels';
import {
  at,
  createRule,
  deleteRule,
  fields,
  formId,
  funnelRule,
  isRefusal,
  listOf,
  previewOf,
  reorderRules,
  springRule,
  tagId,
  tags,
  updateRule,
  worldOf,
  type LeadSourcesWorld,
} from './lead-sources-fixtures';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';
import { fakeSitesApi, siteOf } from './sites-fixtures';

const SHOTS = 'reports/lead-sources';

const violations = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
    .violations;
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const main = (page: Page): Locator => page.getByRole('main');

const forms: FormList = {
  items: [
    {
      id: formId,
      name: 'Wedding enquiry',
      status: 'published',
      hasUnpublishedChanges: false,
      submissionCount: 0,
      lastSubmissionAt: null,
      updatedAt: at,
    },
  ],
  nextCursor: null,
  canManage: true,
};

/** Stands in for the API the three tabs talk to: every write is parsed by the contract. */
async function leadSourcesApi(page: Page, world: LeadSourcesWorld): Promise<void> {
  const answer = async (route: Route, result: unknown, status = 200): Promise<void> => {
    if (isRefusal(result)) {
      await route.fulfill({
        status: result.status,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Refused', ...result }),
      });
      return;
    }
    await route.fulfill({ status, json: result });
  };
  await page.route('**/api/v1/fields', (route) => route.fulfill({ json: fields }));
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: tags satisfies TagConfiguration }),
  );
  await page.route(/\/api\/v1\/forms(?:\?.*)?$/, (route) => route.fulfill({ json: forms }));
  await page.route('**/api/v1/lead-sources/preview', async (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    await route.fulfill({ json: previewOf(world, route.request().postDataJSON()) });
  });
  await page.route(/\/api\/v1\/lead-sources\/rules(?:\/.*)?$/, async (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const rest = new URL(request.url()).pathname.replace('/api/v1/lead-sources/rules', '');
    const method = request.method();
    if (rest === '' && method === 'GET') return answer(route, listOf(world));
    if (rest === '' && method === 'POST')
      return answer(route, createRule(world, request.postDataJSON()), 201);
    if (rest === '/order' && method === 'POST')
      return answer(route, reorderRules(world, request.postDataJSON()));
    const id = rest.slice(1);
    if (method === 'PUT') return answer(route, updateRule(world, id, request.postDataJSON()));
    if (method === 'GET')
      return answer(
        route,
        world.rules.find((rule) => rule.id === id) ?? { status: 404, detail: 'No such rule.' },
      );
    if (method === 'DELETE') {
      deleteRule(world, id);
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ status: 405 });
  });
}

const ownRules = (page: Page): Locator => main(page).getByRole('region', { name: 'Your rules' });
const ruleNames = (page: Page): Locator => ownRules(page).getByRole('listitem');
const record = (page: Page): Locator =>
  main(page).getByRole('region', { name: 'What this link will record' });
/** The value beside a small grey label of an answer. */
const said = (within: Locator, term: string): Locator =>
  within
    .locator('dt', { hasText: new RegExp(`^${term}$`) })
    .locator('xpath=following-sibling::dd[1]');

for (const width of [360, 1440]) {
  test.describe(`at ${String(width)}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 950 });
    });

    test('makes a rule with two conditions and two actions, tries a link, reorders and switches one off', async ({
      page,
    }) => {
      await signedIn(page);
      const world = worldOf([funnelRule()]);
      await leadSourcesApi(page, world);
      await page.goto(inHarbor('/settings/lead-sources'));
      await expect(page.getByRole('heading', { level: 1, name: 'Lead Sources' })).toBeVisible();
      await expect(ruleNames(page)).toHaveCount(1);
      // The built-in rules are listed under the business's own, read-only.
      const builtIn = main(page).getByRole('region', { name: 'Built-in rules' });
      await expect(builtIn.getByRole('listitem')).toHaveCount(21);
      await expect(builtIn.getByRole('button')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);

      await ownRules(page).getByRole('button', { name: 'Add rule' }).click();
      const editor = main(page).getByRole('form', { name: 'New rule' });
      await expect(editor.getByLabel('Name', { exact: true })).toBeFocused();
      await editor.getByLabel('Name', { exact: true }).fill('Spring promo');
      await editor.getByRole('textbox', { name: 'Condition 1: value' }).fill('spring');
      await editor.getByRole('button', { name: 'Add condition' }).click();
      await choose(
        editor.getByRole('combobox', { name: 'Condition 2: what to look at' }),
        'lead_source',
      );
      await choose(editor.getByRole('combobox', { name: 'Condition 2: value' }), 'facebook_ads');
      await editor.getByLabel('Name the Source').fill('Spring promo');
      await editor.getByRole('button', { name: 'Add tag' }).click();
      await page.getByRole('option', { name: 'Promo', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(editor.getByRole('list', { name: 'Tags to add' })).toContainText('Promo');

      // Try a link: one that matches the rule as it stands here, and one that does not.
      const trial = editor.getByRole('group', { name: 'Try a link' });
      await trial
        .getByRole('textbox', { name: 'Link to try' })
        .fill(
          'www.harborlights.example/offer?utm_source=facebook&utm_medium=paid_social&utm_campaign=Spring-2026',
        );
      await trial.getByRole('button', { name: 'Try' }).click();
      await expect(trial.getByText('This rule would match this link.')).toBeVisible();
      await expect(trial.getByRole('listitem')).toHaveText([
        'Holds: UTM campaign contains “spring”',
        'Holds: Lead source (built-in) is Facebook Ads',
      ]);
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-rule-editor`);

      await trial
        .getByRole('textbox', { name: 'Link to try' })
        .fill('https://www.harborlights.example/offer?gclid=abc&utm_campaign=spring');
      await trial.getByRole('textbox', { name: 'Link to try' }).press('Enter');
      await expect(trial.getByText('This rule would not match this link.')).toBeVisible();
      await expect(trial.getByRole('listitem')).toHaveText([
        'Holds: UTM campaign contains “spring”',
        'Does not hold: Lead source (built-in) is Facebook Ads',
      ]);
      // Trying a link saved nothing.
      expect(world.writes).toHaveLength(0);

      await editor.getByRole('button', { name: 'Save rule' }).click();
      await expect(main(page).getByText('“Spring promo” was saved.')).toBeVisible();
      await expect(editor).toHaveCount(0);
      expect(world.writes.at(-1)?.body).toEqual({
        name: 'Spring promo',
        enabled: true,
        conditions: [
          { fact: 'utm_campaign', op: 'contains', value: 'spring' },
          { fact: 'lead_source', op: 'is', value: 'facebook_ads' },
        ],
        source: 'Spring promo',
        tagIds: [tagId(1)],
        fieldWrites: [],
      });
      // Each rule reads as a sentence, in the order they are tried: the new one is last.
      await expect(ruleNames(page)).toHaveCount(2);
      await expect(ruleNames(page).nth(1)).toHaveAccessibleName(
        'Rule 2: Spring promo. When UTM campaign contains “spring” and Lead source (built-in) is Facebook Ads → Source: Spring promo · tags: Promo',
      );

      // Reorder with the keyboard's buttons: said aloud, and the keyboard stays on the rule.
      await ownRules(page).getByRole('button', { name: 'Move “Spring promo” up' }).click();
      await expect(main(page).getByText('“Spring promo” is now rule 1 of 2.')).toBeVisible();
      await expect(ruleNames(page).first()).toHaveAccessibleName(/^Rule 1: Spring promo\./);
      await expect(
        ownRules(page).getByRole('button', { name: 'Move “Spring promo” down' }),
      ).toBeFocused();
      expect(world.rules.map((rule) => rule.name)).toEqual(['Spring promo', 'Wedding funnel']);

      // Switched off: kept, and said to be off.
      await ownRules(page).getByRole('switch', { name: 'Use “Wedding funnel”' }).click();
      await expect(main(page).getByText('“Wedding funnel” is off.')).toBeVisible();
      await expect(
        ownRules(page).getByRole('switch', { name: 'Use “Wedding funnel”' }),
      ).toHaveAttribute('aria-checked', 'false');
      expect(world.rules[1]?.enabled).toBe(false);
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-rules`);
    });

    test('builds a Google link in both forms and a Meta link, and shows what each will record', async ({
      page,
    }) => {
      await signedIn(page);
      const world = worldOf([springRule()]);
      await leadSourcesApi(page, world);
      await page.goto(inHarbor('/settings/lead-sources/tracking-links'));
      const built = main(page).getByRole('textbox', { name: /to paste$/ });
      await expect(
        main(page).getByRole('radio', { name: 'Google Ads', exact: true }),
      ).toBeChecked();
      await expect(built).toHaveValue(
        /^utm_source=google&utm_medium=cpc&utm_campaign=\{campaignid\}/,
      );
      // The catalogue marks the Final URL suffix as not fully confirmed: the page says so.
      await expect(main(page).getByText(/^Not fully confirmed/)).toBeVisible();
      await expect(said(record(page), 'Lead source')).toHaveText('Google Ads');
      await expect(said(record(page), 'Session source')).toHaveText('Paid Search');
      await expect(said(record(page), 'Built-in rule')).toContainText('(names the lead)');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-links-google-suffix`);

      await main(page).getByRole('radio', { name: 'Google Ads: tracking template' }).check();
      await expect(built).toHaveValue(/^\{lpurl\}\?utm_source=google&utm_medium=cpc/);
      await expect(main(page).getByText(/^Checked:/)).toBeVisible();
      await main(page).getByLabel('UTM campaign (utm_campaign)').fill('Open day');
      await expect(built).toHaveValue(/utm_campaign=Open%20day&/);
      await main(page).getByLabel('Landing page address').fill('www.harborlights.example/open-day');
      await expect(record(page)).toContainText(
        'https://www.harborlights.example/open-day?utm_source=google&utm_medium=cpc&utm_campaign=Open+day',
      );
      await expect(said(record(page), 'Lead source')).toHaveText('Google Ads');

      // Meta: the sample campaign is "Spring promo", which the business's own rule names.
      await main(page).getByRole('radio', { name: 'Meta', exact: true }).check();
      await expect(built).toHaveValue(
        'utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}',
      );
      await expect(said(record(page), 'Lead source')).toHaveText('Spring promo');
      await expect(said(record(page), 'Your rules that match')).toContainText('1. Spring promo');
      await expect(said(record(page), 'Built-in rule')).toContainText('Facebook Ads');
      await expect(said(record(page), 'Built-in rule')).toContainText(
        '(not used: a rule of yours names the lead)',
      );
      await expect(main(page).getByText(/^Checked:/)).toBeVisible();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-links-meta`);
    });

    test('checks a link: the rule of the business that matched, then the built-in rule', async ({
      page,
    }) => {
      await signedIn(page);
      const world = worldOf([springRule(), funnelRule()]);
      await leadSourcesApi(page, world);
      await page.goto(inHarbor('/settings/lead-sources/check'));
      const form = main(page).getByRole('form', { name: 'Check a link' });
      await form
        .getByLabel('Link they follow')
        .fill(
          'www.harborlights.example/wedding/step-2?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring&fbclid=abc',
        );
      await choose(
        form.getByRole('combobox', { name: 'Form to check against (optional)' }),
        formId,
      );
      await form.getByRole('button', { name: 'Check', exact: true }).click();
      const answer = main(page).getByRole('region', {
        name: 'What a lead arriving by this link would be',
      });
      await expect(answer.getByRole('listitem').filter({ hasText: /^\d\./ })).toHaveText([
        '1. Spring promoSource: Spring promo (used) · tags: Promo, VIP',
        '2. Wedding funnelNames no Source · tags: Wedding enquiry · fills Campaign: wedding',
      ]);
      await expect(said(answer, 'Built-in rule')).toContainText('Facebook Ads');
      await expect(said(answer, 'Lead source')).toHaveText('Spring promo');
      await expect(said(answer, 'Session source')).toHaveText('Paid Social');
      await expect(said(answer, 'Click ids in the link')).toHaveText('Meta');
      await expect(said(answer, 'Source written on the contact')).toContainText('Spring promo');
      expect(world.checked.at(-1)).toEqual({
        url: 'https://www.harborlights.example/wedding/step-2?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring&fbclid=abc',
        formId,
      });
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-check`);

      // A bare link: no rule matches, the built-in rule names it, and the warning is plain.
      await form.getByLabel('Link they follow').fill('https://www.harborlights.example/');
      await form.getByLabel('Link they follow').press('Enter');
      await expect(said(answer, 'Your rules that match')).toHaveText(
        'None of your rules match this link.',
      );
      await expect(said(answer, 'Built-in rule')).toContainText('(names the lead)');
      await expect(answer.getByText(/would be recorded as Direct/)).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test('saves how a site remembers the way visitors arrived', async ({ page }) => {
      await signedIn(page);
      const spring = siteOf('funnel', 'Spring offer', [['Landing Page', 'landing']]);
      const api = await fakeSitesApi(page, { sites: [spring] });
      await page.goto(inHarbor(`/sites/funnels/${spring.id}/settings`));
      const form = main(page).getByRole('form', { name: 'Funnel settings' });
      const group = form.getByRole('radiogroup', { name: 'Remember how visitors arrived' });
      await expect(group.getByRole('radio')).toHaveCount(3);
      await expect(
        group.getByRole('radio', {
          name: 'Yes, unless their browser asks us not to (recommended)',
        }),
      ).toBeChecked();
      await expect(form.getByText(/This is not legal advice/)).toBeVisible();
      await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-site-arrival`);

      await group.getByRole('radio', { name: 'No', exact: true }).check();
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form.getByText('Settings saved.')).toBeVisible();
      expect(api.sent.at(-1)).toEqual({
        call: `PATCH /sites/${spring.id}`,
        body: { revision: spring.revision, keepArrival: 'never' },
      });
      await expect(group.getByRole('radio', { name: 'No', exact: true })).toBeChecked();
      await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    test('says on a contact that the arrival was carried from an earlier page, and shows all fields when asked', async ({
      page,
    }) => {
      const id = 'con_01m4bd188ff82s0add91b7pz63';
      const touches: ContactAttributions = {
        first: {
          touchedAt: '2026-10-12T08:30:00.000Z',
          medium: 'form',
          sessionSource: 'paid_search',
          utmSource: 'google',
          utmMedium: 'cpc',
          utmCampaign: 'spring-open-day',
          utmContent: null,
          utmTerm: null,
          matchType: null,
          campaignId: '4242',
          adGroupId: null,
          adId: null,
          referrerDomain: null,
          landingUrl: 'https://harborlights.example/offer',
          pageUrl: 'https://harborlights.example/offer/step-2',
          source: 'Google Ads',
          sourceRule: 'google_ads',
          arrivalCarried: true,
          clickIds: ['gclid'],
        },
        latest: null,
      };
      touches.latest = touches.first;
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
        route.fulfill({ json: { ...tags, items: [] } satisfies TagConfiguration }),
      );
      await page.route(`**/api/v1/contacts/${id}/attribution`, (route) =>
        route.fulfill({ json: touches }),
      );
      await page.goto(inHarbor(`/contacts/${id}`));
      const group = page.getByRole('group', { name: 'Attribution', exact: true });
      const first = group.getByRole('group', { name: 'First attribution' });
      await expect(first.getByText(/^Arrival carried from an earlier page/)).toBeVisible();
      // Both pages are said: where the visit began, and where the lead was taken.
      await expect(first.locator('dt')).toHaveText([
        'Lead source',
        'Session source',
        'Medium',
        'UTM source',
        'UTM medium',
        'UTM campaign',
        'Campaign ID',
        'Landing page',
        'Page',
        'When',
        'Click ids held',
      ]);
      await expect(said(first, 'Landing page')).toHaveText('https://harborlights.example/offer');
      await expect(said(first, 'Page')).toHaveText('https://harborlights.example/offer/step-2');
      expect(await violations(page)).toEqual([]);
      expect(await fits(page)).toBe(true);
      await shot(page, `${String(width)}-contact-carried`);

      await group.getByRole('button', { name: 'Show all fields' }).click();
      await expect(first.locator('dt')).toHaveCount(17);
      await expect(said(first, 'Ad ID')).toHaveText(/Not set/);
      expect(await violations(page)).toEqual([]);
      await group.getByRole('button', { name: 'Hide empty fields' }).click();
      await expect(first.locator('dt')).toHaveCount(11);
    });
  });
}

test('is in Settings beside Tags, with its three tabs in the top bar, and the command bar finds it', async ({
  page,
}) => {
  await signedIn(page);
  await leadSourcesApi(page, worldOf([springRule()]));
  await page.goto(inHarbor('/settings/tags'));
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Lead Sources', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/lead-sources')}$`));
  await expect(ruleNames(page)).toHaveCount(1);
  const tabs = page.getByRole('navigation', { name: 'Lead Sources' });
  await expect(tabs.getByRole('link')).toHaveText(['Rules', 'Tracking links', 'Check a link']);
  await tabs.getByRole('link', { name: 'Tracking links' }).click();
  await expect(page).toHaveURL(/\/settings\/lead-sources\/tracking-links$/);
  await expect(main(page).getByRole('radio', { name: 'Google Ads', exact: true })).toBeChecked();
  await tabs.getByRole('link', { name: 'Check a link' }).click();
  await expect(main(page).getByRole('form', { name: 'Check a link' })).toBeVisible();

  // The command bar names the page and its tabs.
  await page.route(/\/api\/v1\/search\?/, (route) => route.fulfill({ json: { items: [] } }));
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  const search = bar.getByRole('combobox', { name: 'Search or go to' });
  await page.keyboard.press('Control+k');
  await search.fill('lead sources');
  await bar.getByRole('option', { name: 'Lead Sources', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${inHarbor('/settings/lead-sources')}$`));
  await page.keyboard.press('Control+k');
  await search.fill('tracking links');
  await bar.getByRole('option', { name: 'Tracking links', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/lead-sources\/tracking-links$/);
});
