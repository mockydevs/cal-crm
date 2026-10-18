// Engagement scoring, against a stand-in for the API (scoring-fixtures.ts): Settings → Manage
// Scoring in GoHighLevel's layout (Add new rule, the Engagement Score tab, search, the
// Action / Calculation / Points table, paging), publishing the draft, and the contact's
// Contact Engagement Score section.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { emptyContactPanels } from './contact-panels';
import {
  at,
  createScoreRuleIn,
  deleteScoreRuleIn,
  isRefusal,
  profileOf,
  publishIn,
  renameIn,
  scoredContactId,
  scoringForms,
  scoringTagId,
  scoringTags,
  scoringWorldOf,
  setScoreIn,
  updateScoreRuleIn,
  type ScoringWorld,
} from './scoring-fixtures';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';

interface Api {
  readonly world: ScoringWorld;
  readonly writes: { readonly method: string; readonly path: string; readonly body: unknown }[];
}

async function scoringApi(page: Page, world: ScoringWorld = scoringWorldOf()): Promise<Api> {
  const api: Api = { world, writes: [] };
  const answer = (
    route: Parameters<Parameters<Page['route']>[1]>[0],
    value: unknown,
    status = 200,
  ) =>
    isRefusal(value)
      ? route.fulfill({
          status: value.status,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Refused', ...value },
        })
      : route.fulfill({ status, json: value });
  await page.route('**/api/v1/tag-configuration', (route) => route.fulfill({ json: scoringTags }));
  await page.route(/\/api\/v1\/forms(?:\?.*)?$/, (route) => route.fulfill({ json: scoringForms }));
  await page.route(/\/api\/v1\/scoring(?:\/.*)?$/, (route) => {
    const request = route.request();
    expect(request.headers()['business-id']).toBe(harbor.id);
    const path = new URL(request.url()).pathname.replace('/api/v1/scoring', '');
    const method = request.method();
    const body: unknown = request.postData() === null ? undefined : request.postDataJSON();
    if (method !== 'GET') api.writes.push({ method, path, body });
    if (method === 'GET') return answer(route, profileOf(world));
    if (path === '' && method === 'PUT') return answer(route, renameIn(world, body));
    if (path === '/publish') return answer(route, publishIn(world, body));
    if (path === '/rules') return answer(route, createScoreRuleIn(world, body), 201);
    const id = path.replace('/rules/', '');
    if (method === 'DELETE') {
      deleteScoreRuleIn(world, id);
      return route.fulfill({ status: 204 });
    }
    return answer(route, updateScoreRuleIn(world, id, body));
  });
  await page.route(/\/api\/v1\/contacts\/con_[^/]+\/engagement-score$/, (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: world.score });
    const body: unknown = request.postDataJSON();
    api.writes.push({ method: 'PUT', path: '/engagement-score', body });
    return route.fulfill({ json: setScoreIn(world, body) });
  });
  return api;
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('lists the rules in GoHighLevel’s layout, finds them, and pages through them', async ({
  page,
}) => {
  await signedIn(page);
  const world = scoringWorldOf();
  for (let number = 0; number < 10; number += 1)
    createScoreRuleIn(world, {
      when: { action: 'payment_received' },
      calculation: 'add',
      points: number + 2,
    });
  world.publishedRevision = world.revision;
  await scoringApi(page, world);
  await page.goto(inHarbor('/settings/scoring'));
  await expect(page.getByRole('heading', { name: 'Manage Scoring', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add new rule', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Engagement Score', exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'Scoring rules' });
  await expect(table.getByRole('columnheader')).toHaveText([
    'Action',
    'Calculation',
    'Points',
    'Actions',
  ]);
  await expect(table.getByRole('row')).toHaveCount(11);
  await expect(page.getByText('1 - 10 of 13', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('11 - 13 of 13', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search rules' }).fill('bounced');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('rowheader')).toHaveText(['if an email is - Bounced']);
  await expectNoAccessibilityViolations(page);
});

test('adds a rule to the draft and publishes it', async ({ page }) => {
  await signedIn(page);
  const api = await scoringApi(page);
  await page.goto(inHarbor('/settings/scoring'));
  await page.getByRole('button', { name: 'Add new rule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add new rule', exact: true });
  await choose(dialog.getByRole('combobox', { name: 'Action', exact: true }), 'form_submitted');
  await choose(
    dialog.getByRole('combobox', { name: 'Form', exact: true }),
    scoringForms.items[0]?.id ?? '',
  );
  await choose(
    dialog.getByRole('combobox', { name: 'Only contacts with the tag', exact: true }),
    scoringTagId(2),
  );
  await dialog.getByRole('spinbutton', { name: 'Points', exact: true }).fill('15');
  await expectNoAccessibilityViolations(page);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/rules',
      body: {
        when: { action: 'form_submitted', formId: scoringForms.items[0]?.id },
        hasTagId: scoringTagId(2),
        calculation: 'add',
        points: 15,
      },
    },
  ]);
  await expect(
    page.getByRole('rowheader', {
      name: 'if a form is submitted - Wedding enquiry and contact Has tag - VIP',
    }),
  ).toBeVisible();
  await expect(
    page.getByText('The draft has changes that score nothing until you publish them.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Every rule here scores what contacts do.')).toBeVisible();
  expect(api.writes.at(-1)).toEqual({ method: 'POST', path: '/publish', body: { revision: 4 } });
});

test('edits and deletes a rule from its menu', async ({ page }) => {
  await signedIn(page);
  const api = await scoringApi(page);
  await page.goto(inHarbor('/settings/scoring'));
  await page
    .getByRole('button', { name: 'Actions for if an email is - Bounced', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit rule', exact: true });
  await choose(dialog.getByRole('combobox', { name: 'Email event', exact: true }), 'unsubscribed');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('rowheader', { name: 'if an email is - Unsubscribed' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Actions for if an email is - Unsubscribed', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete this rule?', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByRole('rowheader', { name: 'if an email is - Unsubscribed' })).toHaveCount(
    0,
  );
  expect(api.writes.map((each) => each.method)).toEqual(['PUT', 'DELETE']);
});

test("shows and sets a contact's engagement score on the contact page", async ({ page }) => {
  await signedIn(page);
  await emptyContactPanels(page);
  const api = await scoringApi(page);
  await page.route(`**/api/v1/contacts/${scoredContactId}`, (route) =>
    route.fulfill({
      json: {
        id: scoredContactId,
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
  await page.goto(inHarbor(`/contacts/${scoredContactId}`));
  const section = page.getByRole('region', { name: 'Contact Engagement Score', exact: true });
  await section.getByRole('button', { name: 'Contact Engagement Score', exact: true }).click();
  await expect(section.getByTestId('engagement-score')).toHaveText('12');
  await section.getByRole('button', { name: 'Edit', exact: true }).click();
  await section.getByRole('spinbutton', { name: 'Engagement score', exact: true }).fill('30');
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByTestId('engagement-score')).toHaveText('30');
  expect(api.writes).toEqual([{ method: 'PUT', path: '/engagement-score', body: { score: 30 } }]);
  await expectNoAccessibilityViolations(page);
});

for (const width of [360, 1440]) {
  test(`is accessible and fits at ${String(width)} px, a deleted tag asked for again`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    const gone = scoringTagId(9);
    const world = scoringWorldOf();
    const [first, ...rest] = world.rules;
    if (first === undefined) throw new Error('No rule.');
    world.rules = [
      {
        ...first,
        when: { action: 'contact_tag', change: 'added', tagId: gone },
        problems: [
          { code: 'tag_missing', id: gone, message: 'A tag this rule names was deleted.' },
        ],
      },
      ...rest,
    ];
    const api = await scoringApi(page, world);
    await page.goto(inHarbor('/settings/scoring'));
    const said = 'if a tag is added - a deleted tag';
    await expect(page.getByRole('rowheader', { name: said })).toBeVisible();
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);
    await expectNoAccessibilityViolations(page);

    await page.getByRole('button', { name: `Actions for ${said}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit rule', exact: true });
    const tag = dialog.getByRole('combobox', { name: 'Tag', exact: true });
    await expect(tag).toHaveText(/\(deleted\)/);
    await expect(tag).toHaveAccessibleDescription('That tag was deleted. Choose another.');
    expect(await fits()).toBe(true);
    await expectNoAccessibilityViolations(page);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect(api.writes).toEqual([]);
    await choose(tag, scoringTagId(2));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(api.writes).toEqual([
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          when: { action: 'contact_tag', change: 'added', tagId: scoringTagId(2) },
        }),
      }),
    ]);
  });
}
