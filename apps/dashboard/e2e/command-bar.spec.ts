import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Deal, FoundRecord } from '@repo/contracts';
import { agencyStaff, inHarbor, northwind, signedIn } from './session';
import { emptyRecordWork } from './contact-panels';

// The command bar, against the built dashboard with the API stood in for. The real server
// is exercised by @repo/e2e.

// Ids the server made: the contract checks each wraps a UUIDv7.
const maya: FoundRecord = {
  id: 'con_01m4bd188ff82s0add91b7pz63',
  kind: 'contact',
  name: 'Maya Lee',
  detail: 'maya@example.com',
};
const leeFamily: FoundRecord = {
  id: 'com_01m4bd9fteedat3be9bqgx2047',
  kind: 'company',
  name: 'Lee Family',
  detail: 'leefamily.example',
};
const wedding: FoundRecord = {
  id: 'deal_01m4bdmgqwfgatd5ch0pqddfxm',
  kind: 'deal',
  name: 'Lee wedding',
  detail: 'Weddings · New lead',
};

/** An API whose search finds the records whose names hold the search, and records each. */
async function fakeSearch(
  page: Page,
  records: readonly FoundRecord[] = [maya, leeFamily, wedding],
): Promise<{ searched: string[] }> {
  const searched: string[] = [];
  await page.route(/\/api\/v1\/search\?/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    searched.push(q);
    return route.fulfill({
      json: {
        items: records.filter((record) => record.name?.toLowerCase().includes(q.toLowerCase())),
      },
    });
  });
  return { searched };
}

/**
 * The Opportunities page's answers, with the deal the bar finds, which its dialog then
 * opens. It keeps the deal as the server would: a save changes it and its revision, and is
 * recorded.
 */
async function fakeDeals(page: Page, changes: Partial<Deal> = {}): Promise<{ saved: unknown[] }> {
  await emptyRecordWork(page);
  await page.route(/\/api\/v1\/records\/deal_[^/]+\/activity(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await page.route(/\/api\/v1\/records\/deal_[^/]+\/fields$/, (route) =>
    route.fulfill({ json: { items: [], canManage: false, canConfirm: false } }),
  );
  const at = '2026-10-08T12:00:00.000Z';
  const pipelineId = 'pipe_01m4bd188ff82s0add91b7pz63';
  const stageId = 'stage_01m4bd188ff82s0add91b7pz63';
  const saved: unknown[] = [];
  let current: Deal = {
    id: wedding.id,
    name: 'Lee wedding',
    pipelineId,
    stageId,
    pipelineName: 'Weddings',
    stageName: 'New lead',
    amount: null,
    currency: 'KES',
    expectedCloseDate: null,
    status: 'open',
    outcomeReason: null,
    closedAt: null,
    stageEnteredAt: at,
    createdAt: at,
    updatedAt: at,
    trashedAt: null,
    revision: 'a'.repeat(64),
    canManage: true,
    ...changes,
  };
  await page.route('**/api/v1/pipelines', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: pipelineId,
            name: 'Weddings',
            description: '',
            archived: false,
            stages: [{ id: stageId, name: 'New lead', description: '', archived: false }],
          },
        ],
        revision: 'b'.repeat(64),
        canManage: false,
      },
    }),
  );
  await page.route(/\/api\/v1\/deals(?:[/?].*)?$/, (route) => {
    const request = route.request();
    if (!request.url().includes(wedding.id))
      return route.fulfill({ json: { items: [], next: null, canManage: current.canManage } });
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as Partial<Deal>;
      saved.push(body);
      current = {
        ...current,
        ...body,
        revision: String.fromCharCode(98 + saved.length).repeat(64),
      };
    }
    return route.fulfill({ json: current });
  });
  return { saved };
}

const bar = (page: Page) => page.getByRole('dialog', { name: 'Command bar' });
const searchBox = (page: Page) => bar(page).getByRole('combobox', { name: 'Search or go to' });

/** Opens the bar by keyboard, once the shell, which listens for the shortcut, is there. */
async function openBar(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /^Search/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(searchBox(page)).toBeFocused();
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens with Ctrl+K wherever focus is, and closes with Escape, back where it was', async ({
    page,
  }) => {
    await signedIn(page);
    await fakeSearch(page);
    await page.goto(inHarbor('/trash'));
    const show = page.getByLabel('Show');
    await show.focus();

    await page.keyboard.press('Control+k');

    await expect(searchBox(page)).toBeFocused();
    await expect(bar(page).getByRole('option', { name: 'Contacts' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect(show).toBeFocused();
    await page.keyboard.press('Meta+k');
    await expect(searchBox(page)).toBeFocused();
    await page.keyboard.press('Control+k');
    await expect(bar(page)).toBeHidden();
  });

  test('finds records as you type, and goes to one with the arrows and Enter', async ({ page }) => {
    await signedIn(page);
    const { searched } = await fakeSearch(page);
    await fakeDeals(page);
    await page.goto(inHarbor());

    await openBar(page);
    await page.keyboard.type('lee');

    const options = bar(page).getByRole('option');
    await expect(options).toHaveText([
      /Maya Lee\s*maya@example.com/,
      /Lee Family\s*leefamily.example/,
      /Lee wedding\s*Weddings · New lead/,
    ]);
    expect(searched.at(-1)).toBe('lee');
    // The first is highlighted; Enter would go there. Down twice, to the deal.
    await expect(options.first()).toHaveAttribute('data-highlighted', '');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(2)).toHaveAttribute('data-highlighted', '');
    await page.keyboard.press('Enter');

    await expect(bar(page)).toBeHidden();
    // The opportunity opens in its dialog, named in the address until it's closed.
    const editor = page.getByRole('dialog', { name: 'Edit Lee wedding', exact: true });
    await expect(editor.getByLabel('Opportunity name')).toHaveValue('Lee wedding');
    await expect(page).toHaveURL(inHarbor(`/deals?deal=${wedding.id}`));
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/deals'));
  });

  test('opens a deal read-only for someone who may not change it', async ({ page }) => {
    await signedIn(page);
    await fakeSearch(page);
    const { saved } = await fakeDeals(page, { canManage: false });
    await page.goto(inHarbor());

    await openBar(page);
    await page.keyboard.type('wedding');
    await expect(bar(page).getByRole('option').first()).toContainText('Lee wedding');
    await page.keyboard.press('Enter');

    const details = page.getByRole('dialog', { name: 'Lee wedding', exact: true });
    await expect(details.getByLabel('Opportunity name')).toHaveValue('Lee wedding');
    await expect(details.getByLabel('Opportunity name')).toBeDisabled();
    await expect(details.getByRole('button', { name: 'Update' })).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Move to trash' })).toHaveCount(0);
    // The button at its foot, not the cross in its corner.
    const close = details.getByRole('button', { name: 'Close', exact: true }).last();
    await expect(close).toBeFocused();
    await close.click();
    await expect(details).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/deals'));
    expect(saved).toEqual([]);
  });

  test('opens a deal in the trash read-only, saying so', async ({ page }) => {
    await signedIn(page);
    await fakeSearch(page);
    await fakeDeals(page, { trashedAt: '2026-10-08T13:00:00.000Z' });
    await page.goto(inHarbor());

    await openBar(page);
    await page.keyboard.type('wedding');
    await expect(bar(page).getByRole('option').first()).toContainText('Lee wedding');
    await page.keyboard.press('Enter');

    const details = page.getByRole('dialog', { name: 'Lee wedding', exact: true });
    await expect(details).toContainText('This opportunity is in the trash.');
    await expect(details.getByRole('combobox', { name: 'Stage', exact: true })).toBeDisabled();
    await expect(details.getByRole('button', { name: 'Update' })).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Move to trash' })).toHaveCount(0);
  });

  test('reopens a deal it saved with what was saved', async ({ page }) => {
    await signedIn(page);
    await fakeSearch(page);
    const { saved } = await fakeDeals(page);
    await page.goto(inHarbor());
    const editor = page.getByRole('dialog', { name: /^Edit Lee wedding/ });

    for (const name of ['Lee wedding party', 'Lee wedding reception']) {
      await openBar(page);
      await page.keyboard.type('wedding');
      await expect(bar(page).getByRole('option').first()).toContainText('Lee wedding');
      await page.keyboard.press('Enter');
      await expect(editor.getByLabel('Opportunity name')).toHaveValue(
        saved.length === 0 ? 'Lee wedding' : 'Lee wedding party',
      );
      await editor.getByLabel('Opportunity name').fill(name);
      await editor.getByRole('button', { name: 'Update', exact: true }).click();
      await expect(editor).toBeHidden();
    }

    // The second save sent the revision the first one made.
    expect(saved).toMatchObject([
      { name: 'Lee wedding party', revision: 'a'.repeat(64) },
      { name: 'Lee wedding reception', revision: 'c'.repeat(64) },
    ]);
  });

  test('opens the opportunity the bar names over an unsaved new one only once asked, and closing clears both', async ({
    page,
  }) => {
    await signedIn(page);
    await fakeSearch(page);
    await fakeDeals(page);
    await page.goto(inHarbor('/deals'));
    const add = page.getByRole('button', { name: 'Add opportunity', exact: true });
    await add.click();
    const adding = page.getByRole('dialog', { name: 'Add new opportunity', exact: true });
    await adding.getByLabel('Opportunity name').fill('An unsaved idea');

    // The shortcut works over the dialog too.
    await page.keyboard.press('Control+k');
    await expect(searchBox(page)).toBeFocused();
    await page.keyboard.type('wedding');
    await expect(bar(page).getByRole('option').first()).toContainText('Lee wedding');
    await page.keyboard.press('Enter');

    // Going to another opportunity would drop the draft, so it asks first.
    const guard = page.getByRole('dialog', { name: 'You have unsaved changes', exact: true });
    await expect(guard).toBeVisible();
    // Nothing has moved yet: the address still names the new opportunity.
    expect(new URL(page.url()).searchParams.get('deal')).toBe('new');
    await guard.getByRole('button', { name: 'Discard changes', exact: true }).click();

    const editor = page.getByRole('dialog', { name: 'Edit Lee wedding', exact: true });
    await expect(editor.getByLabel('Opportunity name')).toHaveValue('Lee wedding');
    await expect(adding).toHaveCount(0);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/deals'));
    // Both are closed: the unsaved new opportunity doesn't come back.
    await expect(adding).toHaveCount(0);
    await expect(add).toBeEnabled();
  });

  test("waits for a named opportunity before Add opportunity, and offers it when that one can't be opened", async ({
    page,
  }) => {
    await signedIn(page);
    await fakeSearch(page);
    await fakeDeals(page);
    let answer: (found: boolean) => void = () => undefined;
    const answered = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    await page.route(`**/api/v1/deals/${wedding.id}`, async (route) => {
      if (await answered) return route.fallback();
      return route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: { type: 'about:blank', title: 'Not Found', status: 404 },
      });
    });
    await page.goto(inHarbor(`/deals?deal=${wedding.id}`));
    const add = page.getByRole('button', { name: 'Add opportunity', exact: true });

    // While the opportunity the address names loads, nothing else opens.
    await expect(add).toBeDisabled();
    answer(false);

    await expect(page.getByRole('alert')).toContainText("That opportunity can't be opened.");
    await expect(add).toBeEnabled();
    await add.click();
    await expect(
      page.getByRole('dialog', { name: 'Add new opportunity', exact: true }),
    ).toBeVisible();
    // The address now names the new one, not the one that couldn't be opened.
    await expect(page).toHaveURL(inHarbor('/deals?deal=new'));
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('goes to a contact, a company and a page', async ({ page }) => {
    await signedIn(page);
    await fakeSearch(page);
    await page.goto(inHarbor());

    for (const [typed, name, path] of [
      ['maya', 'Maya Lee', `/contacts/${maya.id}`],
      ['family', 'Lee Family', `/contacts/companies/${leeFamily.id}`],
      ['pipelin', 'Pipelines', '/deals/pipelines'],
      ['custom fie', 'Custom Fields', '/settings/custom-fields'],
      ['custom val', 'Custom Values', '/settings/custom-values'],
      ['import da', 'Import Data', '/settings/import'],
      ['email camp', 'Email Campaigns', '/marketing/emails/campaigns'],
      ['email templ', 'Email Templates', '/marketing/emails/templates'],
      ['snippe', 'Snippets', '/marketing/snippets'],
      ['trigger li', 'Trigger Links', '/marketing/trigger-links'],
      ['attribution rep', 'Attribution report', '/reports/attribution'],
      ['appointment rep', 'Appointment report', '/reports/appointments'],
    ] as const) {
      await openBar(page);
      await page.keyboard.type(typed);
      await expect(bar(page).getByRole('option').first()).toContainText(name);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(inHarbor(path));
    }
  });

  test('moves to another business the person may enter', async ({ page }) => {
    await signedIn(page, undefined, undefined, agencyStaff);
    await fakeSearch(page, []);
    await page.goto(inHarbor());

    await openBar(page);
    await page.keyboard.type('north');
    await expect(bar(page).getByRole('group', { name: 'Businesses' })).toContainText(
      northwind.name,
    );
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(`/b/${northwind.slug}`);
  });

  test('says when nothing is found', async ({ page }) => {
    await signedIn(page);
    await fakeSearch(page, []);
    await page.goto(inHarbor());

    await openBar(page);
    await page.keyboard.type('zzz');

    await expect(bar(page)).toContainText('Nothing found for “zzz”.');
  });

  test('opens from the Search button, which names its shortcut', async ({ page }) => {
    await signedIn(page);
    await fakeSearch(page);
    await page.goto(inHarbor());

    const button = page.getByRole('button', { name: /Search/ });
    await expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    await button.click();

    await expect(searchBox(page)).toBeFocused();
  });
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('fits the screen', async ({ page }) => {
    await signedIn(page);
    await fakeSearch(page);
    await page.goto(inHarbor());

    await openBar(page);
    await page.keyboard.type('lee');

    await expect(bar(page).getByRole('option')).toHaveCount(3);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoAccessibilityViolations(page);
  });
});
