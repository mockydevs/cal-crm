// The bell in the top bar, against a stand-in for the API that answers as the server does.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Notification } from '@repo/contracts';
import { idOf } from './settings-fixtures';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

function notificationOf(number: number, rest: Partial<Notification>): Notification {
  return {
    id: idOf('ntf', number),
    kind: 'task.assigned',
    target: { kind: 'task', id: idOf('task', number) },
    record: null,
    title: 'Call the venue back',
    body: null,
    actor: { kind: 'user', name: 'Eli Frost', you: false },
    readAt: null,
    createdAt: new Date(Date.now() - number * 60 * 60_000).toISOString(),
    ...rest,
  };
}

interface NotificationsApi {
  items: Notification[];
  readAllThrough: string[];
}

/** Stands in for the list, the count and the two ways of marking read. */
async function fakeNotificationsApi(page: Page, items: Notification[]): Promise<NotificationsApi> {
  const api: NotificationsApi = { items, readAllThrough: [] };
  const count = (): { unread: number; more: boolean } => ({
    unread: api.items.filter((each) => each.readAt === null).length,
    more: false,
  });
  await page.route('**/api/v1/notifications/unread-count', (route) =>
    route.fulfill({ json: count() }),
  );
  await page.route(/\/api\/v1\/notifications(?:\?.*)?$/, (route) => {
    const state = new URL(route.request().url()).searchParams.get('state') ?? 'all';
    return route.fulfill({
      json: {
        items: api.items.filter((each) => state === 'all' || each.readAt === null),
        nextCursor: null,
      },
    });
  });
  await page.route(/\/api\/v1\/notifications\/[^/]+\/read$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const at = api.items.findIndex((each) => each.id === id);
    const old = api.items[at];
    if (old === undefined) throw new Error('No such notification.');
    const read = { ...old, readAt: '2026-10-11T09:00:00.000Z' };
    api.items[at] = read;
    return route.fulfill({ json: read });
  });
  await page.route('**/api/v1/notifications/read-all', (route) => {
    const { through } = route.request().postDataJSON() as { through: string };
    api.readAllThrough.push(through);
    api.items = api.items.map((each) => ({ ...each, readAt: '2026-10-11T09:00:00.000Z' }));
    return route.fulfill({ json: count() });
  });
  return api;
}

const bell = (page: Page): Locator =>
  page
    .getByRole('region', { name: 'Top bar', exact: true })
    .getByRole('button', { name: /^Notifications/ });
const panel = (page: Page): Locator => page.getByRole('dialog', { name: 'Notifications' });

const seeded = (): Notification[] => [
  notificationOf(1, {
    kind: 'conversation.assigned',
    target: { kind: 'conversation', id: idOf('cvn', 7) },
    record: { id: idOf('con', 7), name: 'Mara Ellison', trashed: false },
    title: null,
  }),
  notificationOf(2, {}),
  notificationOf(30, {
    kind: 'automation.notice',
    target: { kind: 'automation', id: idOf('aut', 3) },
    title: 'New lead follow-up',
    body: 'A new lead asked about spring dates.',
    actor: { kind: 'automation', name: 'New lead follow-up', you: false },
    readAt: '2026-10-10T09:00:00.000Z',
  }),
];

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`counts the unread, lists them and marks them read at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fakeNotificationsApi(page, seeded());
    await page.goto(inHarbor('/contacts/bulk-actions'));
    await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread');
    await expect(bell(page)).toContainText('2');

    await bell(page).click();
    const rows = panel(page).getByRole('list', { name: 'Notifications' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(
      'Eli Frost assigned you the conversation with Mara Ellison.',
    );
    await expect(rows.nth(0)).toContainText('1 hour ago');
    await expect(rows.nth(1)).toContainText('Eli Frost assigned you a task: Call the venue back');
    // A workflow's notice is the words its step was given.
    await expect(rows.nth(2)).toContainText('A new lead asked about spring dates.');
    await expect(rows.nth(2)).toContainText('yesterday');
    await expectNoAccessibilityViolations(page);

    await panel(page).getByRole('button', { name: 'Unread', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await panel(page).getByRole('button', { name: 'All', exact: true }).click();
    await expect(rows).toHaveCount(3);

    // Everything shown is marked read, up to the newest one shown.
    await panel(page).getByRole('button', { name: 'Mark all as read', exact: true }).click();
    await expect(bell(page)).toHaveAccessibleName('Notifications');
    expect(api.readAllThrough).toEqual([idOf('ntf', 1)]);
    await expect(
      panel(page).getByRole('button', { name: 'Mark all as read', exact: true }),
    ).toBeDisabled();
  });
}

test('opening one marks it read and goes to what it is about', async ({ page }) => {
  const api = await fakeNotificationsApi(page, seeded());
  await page.goto(inHarbor('/contacts/bulk-actions'));
  await bell(page).click();
  await panel(page)
    .getByRole('link', { name: /Eli Frost assigned you the conversation with Mara Ellison/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/inbox\\?conversation=${idOf('cvn', 7)}$`));
  await expect(panel(page)).toBeHidden();
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');
  expect(api.items[0]?.readAt).not.toBeNull();
});

test('says so when there are none', async ({ page }) => {
  await fakeNotificationsApi(page, []);
  await page.goto(inHarbor('/contacts/bulk-actions'));
  await expect(bell(page)).toHaveAccessibleName('Notifications');
  await bell(page).click();
  await expect(panel(page).getByText('No notifications yet.', { exact: true })).toBeVisible();
  await expect(
    panel(page).getByRole('button', { name: 'Mark all as read', exact: true }),
  ).toBeDisabled();
});

test('says a contact you follow wrote, and opens the conversation', async ({ page }) => {
  const api = await fakeNotificationsApi(page, [
    notificationOf(1, {
      kind: 'message.received_following',
      target: { kind: 'conversation', id: idOf('cvn', 9) },
      record: { id: idOf('con', 9), name: 'Lena Ortiz', trashed: false },
      title: null,
      actor: { kind: 'contact', name: 'Lena Ortiz', you: false },
    }),
  ]);
  await page.goto(inHarbor('/contacts/bulk-actions'));
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');
  await bell(page).click();
  await panel(page)
    .getByRole('link', { name: /Lena Ortiz, whom you follow, sent a message\./ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/inbox\\?conversation=${idOf('cvn', 9)}$`));
  expect(api.items[0]?.readAt).not.toBeNull();
});
