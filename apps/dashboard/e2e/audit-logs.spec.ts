// Settings → Audit Logs, against a stand-in for `GET /audit-log` that filters and pages as
// the server does and keeps every question it was asked.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AuditListEntry } from '@repo/contracts';
import { reachesRightGutter } from './lists';
import { choose, expectChoice } from './select';
import { inHarbor, signedIn } from './session';

const contactId = 'con_01m4bd188ff82s0add91b7pz63';
const taskId = 'task_01m4bd188ff82s0add91b7pz63';
const lee = { id: 'mem_01m4bd188ff82s0add91b7pz64', name: 'Lee Park', you: false };
const dana = { id: 'mem_01m4bd188ff82s0add91b7pz63', name: 'Dana Brooks', you: true };

const base32 = '0123456789abcdefghjkmnpqrstvwxyz';
const suffix = (number: number): string =>
  `${base32.charAt(Math.floor(number / 32) % 32)}${base32.charAt(number % 32)}`;

function entryOf(number: number, rest: Partial<AuditListEntry> = {}): AuditListEntry {
  return {
    id: `aud_01m4bd188ff82s0add91b7pz${suffix(number)}`,
    at: new Date(Date.UTC(2026, 9, 8, 9, 30) - number * 3_600_000).toISOString(),
    command: 'contact.update',
    outcome: 'ok',
    errorCode: null,
    actor: { kind: 'user', name: 'Dana Brooks', you: true },
    proposed: false,
    events: [{ id: `evt_01m4bd188ff82s0add91b7pz${suffix(number)}`, type: 'contact.updated' }],
    detail: {},
    module: 'contacts',
    action: 'updated',
    record: { kind: 'contact', id: contactId, name: 'Maya Thompson', exists: true },
    recordCount: 1,
    ...rest,
  };
}

const seeded = (): AuditListEntry[] => [
  entryOf(0, { detail: { reason: 'Asked by phone.' } }),
  entryOf(1, {
    command: 'task.bulk_update',
    module: 'tasks',
    record: null,
    recordCount: 4,
    events: [],
    actor: { kind: 'user', name: 'Lee Park', you: false },
  }),
  entryOf(2, {
    command: 'task.delete',
    module: 'tasks',
    action: 'deleted',
    record: { kind: 'task', id: taskId, name: null, exists: false },
    actor: { kind: 'automation', name: null, you: false },
    events: [],
  }),
  entryOf(3, {
    command: 'pipeline.create',
    module: 'opportunities',
    action: 'created',
    record: { kind: 'pipeline', id: 'pipe_01m4bd188ff82s0add91b7pz63', name: null, exists: null },
    events: [],
  }),
];

interface AuditApi {
  entries: AuditListEntry[];
  /** The attempts that were refused: what `outcome=denied` lists. */
  denied: AuditListEntry[];
  readonly asked: URLSearchParams[];
  /** Two entries a page, so paging shows with few of them. */
  pageSize: number;
}

async function fakeAuditApi(page: Page, entries: AuditListEntry[]): Promise<AuditApi> {
  const api: AuditApi = { entries, denied: [], asked: [], pageSize: 50 };
  await page.route(/\/api\/v1\/tasks\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [dana, lee], nextCursor: null } }),
  );
  await page.route(/\/api\/v1\/audit-log(?:\?.*)?$/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    api.asked.push(query);
    const member = query.get('member');
    const from = query.get('from');
    const before = query.get('before');
    const subject = query.get('subject');
    const matched = (query.get('outcome') === 'denied' ? api.denied : api.entries).filter(
      (entry) =>
        (member === null ||
          (member === 'me'
            ? entry.actor.you
            : entry.actor.name === lee.name && member === lee.id)) &&
        (query.get('module') === null || entry.module === query.get('module')) &&
        (query.get('action') === null || entry.action === query.get('action')) &&
        (subject === null || entry.record?.id === subject) &&
        (from === null || entry.at >= from) &&
        (before === null || entry.at < before),
    );
    const start = matched.findIndex((entry) => entry.id === query.get('after')) + 1;
    const items = matched.slice(start, start + api.pageSize);
    return route.fulfill({
      json: {
        items,
        next: start + api.pageSize < matched.length ? (items.at(-1)?.id ?? null) : null,
      },
    });
  });
  return api;
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const table = (page: Page): Locator =>
  page.getByRole('region', { name: 'Audit log table', exact: true }).getByRole('table');
const bodyRows = (page: Page): Locator => table(page).locator('tbody').getByRole('row');
const filter = (page: Page, name: string): Locator =>
  page.getByRole('combobox', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test.describe(`${String(width)} px`, () => {
    test.use({ viewport: { width, height: 1000 }, timezoneId: 'Africa/Nairobi' });

    test('lists who changed what, and each filter asks the server its own question', async ({
      page,
    }, testInfo) => {
      const api = await fakeAuditApi(page, seeded());
      api.denied = [
        entryOf(9, {
          outcome: 'denied',
          errorCode: 'forbidden',
          record: null,
          recordCount: 0,
          events: [],
          command: 'contact.trash',
          action: 'deleted',
          actor: { kind: 'user', name: 'Lee Park', you: false },
        }),
      ];
      await page.goto(inHarbor('/settings/audit-logs'));
      await expect(
        page.getByRole('heading', { level: 1, name: 'Audit Logs', exact: true }),
      ).toBeVisible();
      await expect(page).toHaveTitle('Audit Logs · Harbor Lights Events');
      await expect(table(page).getByRole('columnheader')).toHaveText([
        'Name',
        'Module',
        'Action',
        'Done By',
        'Date & Time (Africa/Nairobi)',
        'Details',
      ]);
      await expect(bodyRows(page)).toHaveCount(4);
      expect(api.asked.at(-1)?.toString()).toBe('');
      const first = bodyRows(page).nth(0);
      await expect(first.getByRole('link', { name: 'Maya Thompson', exact: true })).toHaveAttribute(
        'href',
        inHarbor(`/contacts/${contactId}`),
      );
      await expect(first).toContainText(contactId);
      await expect(first.getByRole('cell').nth(0)).toHaveText('Contacts');
      await expect(first.getByRole('cell').nth(1)).toHaveText('UpdatedContact changed');
      await expect(first.getByRole('cell').nth(2)).toHaveText('You');
      await expect(first.locator('time')).toHaveText(/Oct 8, 2026, 12:30/);
      await expect(bodyRows(page).nth(1).getByRole('rowheader')).toHaveText('4 records');
      await expect(bodyRows(page).nth(2).getByRole('rowheader')).toContainText(
        'task (no longer exists)',
      );
      await expect(bodyRows(page).nth(2).getByRole('link')).toHaveCount(0);
      await expect(bodyRows(page).nth(2).getByRole('cell').nth(2)).toHaveText('Automation');
      await expect(bodyRows(page).nth(3).getByRole('rowheader')).toContainText('pipeline');
      await expect(
        page.getByText('A bulk action is listed as Updated whatever it did', { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("a contact's ID finds changes to the contact, not to its tasks", {
          exact: false,
        }),
      ).toBeVisible();
      await expectNoAccessibilityViolations(page);

      await choose(filter(page, 'User'), lee.id);
      await expect(bodyRows(page)).toHaveCount(1);
      expect(api.asked.at(-1)?.toString()).toBe(`member=${lee.id}`);
      await choose(filter(page, 'User'), 'any');

      await choose(filter(page, 'Module'), 'tasks');
      await expect(bodyRows(page)).toHaveCount(2);
      expect(api.asked.at(-1)?.toString()).toBe('module=tasks');
      await choose(filter(page, 'Action'), 'deleted');
      await expect(bodyRows(page)).toHaveCount(1);
      expect(api.asked.at(-1)?.toString()).toBe('module=tasks&action=deleted');
      await choose(filter(page, 'Module'), 'any');
      await choose(filter(page, 'Action'), 'any');
      await expect(bodyRows(page)).toHaveCount(4);

      // A day in the reader's own time zone: Nairobi is three hours ahead.
      const range = page.getByRole('group', { name: 'Date range', exact: true });
      await range.getByLabel('From day', { exact: true }).fill('2026-10-08');
      await range.getByLabel('To day', { exact: true }).fill('2026-10-08');
      await expect.poll(() => api.asked.at(-1)?.get('before')).toBe('2026-10-08T21:00:00.000Z');
      expect(api.asked.at(-1)?.get('from')).toBe('2026-10-07T21:00:00.000Z');
      await range.getByLabel('To day', { exact: true }).fill('2026-10-01');
      await expect(page.getByRole('main').getByRole('alert')).toHaveText(
        'The range ends before it starts.',
      );
      await expect(table(page)).toHaveCount(0);
      await range.getByLabel('From day', { exact: true }).fill('');
      await range.getByLabel('To day', { exact: true }).fill('');
      await expect(bodyRows(page)).toHaveCount(4);

      const search = page.getByRole('searchbox', { name: 'Search by record ID', exact: true });
      await search.fill(contactId);
      await expect(bodyRows(page)).toHaveCount(1);
      expect(api.asked.at(-1)?.toString()).toBe(`subject=${contactId}`);
      await search.fill('con_nothing');
      await expect(
        page.getByText('Nothing in the audit log matches.', { exact: true }),
      ).toBeVisible();
      await search.fill('');
      await expect(bodyRows(page)).toHaveCount(4);

      // The list opens on what changed something; the refused attempts are asked for.
      await expectChoice(filter(page, 'Show'), 'ok');
      await choose(filter(page, 'Show'), 'denied');
      await expect(bodyRows(page)).toHaveCount(1);
      expect(api.asked.at(-1)?.toString()).toBe('outcome=denied');
      await expect(bodyRows(page).nth(0).getByRole('rowheader')).toHaveText('No record');

      await expectNoAccessibilityViolations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 360)
        for (const button of await bodyRows(page).nth(0).getByRole('button').all())
          expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: testInfo.outputPath('audit-logs.png'), fullPage: true });
    });

    test('walks the pages by cursor and opens an entry to see what it holds', async ({ page }) => {
      const api = await fakeAuditApi(page, seeded());
      api.pageSize = 2;
      await page.goto(inHarbor('/settings/audit-logs'));
      const pages = page.getByRole('navigation', { name: 'Pages', exact: true });
      await expect(pages.getByRole('status')).toHaveText('Page 1');
      await expect(bodyRows(page)).toHaveCount(2);
      await expect(
        pages.getByRole('button', { name: 'Previous page', exact: true }),
      ).toBeDisabled();
      await pages.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(pages.getByRole('status')).toHaveText('Page 2');
      expect(api.asked.at(-1)?.get('after')).toBe(api.entries[1]?.id);
      await expect(bodyRows(page).nth(0).getByRole('cell').nth(1)).toContainText('Deleted');
      await expect(pages.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
      await pages.getByRole('button', { name: 'Previous page', exact: true }).click();
      await expect(pages.getByRole('status')).toHaveText('Page 1');

      const open = bodyRows(page)
        .nth(0)
        .getByRole('button', { name: /^Details of Contact changed/ });
      await open.click();
      const panel = page.getByRole('dialog', { name: 'Audit log entry', exact: true });
      await expect(panel).toContainText('Values before and after a change are not recorded.');
      await expect(panel).toContainText('Contact changed');
      await expect(panel).toContainText('Reason: Asked by phone.');
      await expect(panel).toContainText('contact.update');
      await expect(panel).toContainText('Changes made');
      await expect(panel).toContainText(api.entries[0]?.id ?? 'no entry');
      await expect(panel.getByRole('link', { name: 'Maya Thompson', exact: true })).toBeVisible();
      await expect(
        panel.getByRole('list', { name: 'What it reported', exact: true }).getByRole('listitem'),
      ).toHaveText(['Contact updated']);
      await expectNoAccessibilityViolations(page);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(open).toBeFocused();
    });

    test('tells someone without the permission that they need it', async ({ page }) => {
      await page.route(/\/api\/v1\/audit-log(?:\?.*)?$/, (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          json: { type: 'about:blank', title: 'Forbidden', status: 403 },
        }),
      );
      await page.goto(inHarbor('/settings/audit-logs'));
      await expect(page.getByRole('main').getByRole('alert')).toHaveText(
        'You need permission to read audit logs.',
      );
      await expect(page.getByRole('main').getByRole('combobox')).toHaveCount(0);
      await expect(page.getByRole('table')).toHaveCount(0);
      await expectNoAccessibilityViolations(page);
    });
  });
}

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the settings list', async ({ page }) => {
    await fakeAuditApi(page, seeded());
    await page.goto(inHarbor('/settings/audit-logs'));
    await expect(bodyRows(page)).toHaveCount(4);
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'Audit log', exact: true })),
    ).toBe(true);
    await expect(
      page
        .getByRole('navigation', { name: 'Settings', exact: true })
        .getByRole('link', { name: 'Audit Logs', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  });
});
