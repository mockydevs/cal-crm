// Calendars → Appointment list view, against a stand-in for the API that answers as the
// server does and checks what it is sent against the contract.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  appointmentOf,
  danaId,
  fakeCalendarApi,
  leave,
  now,
  tasting,
  tastingsId,
  tour,
  walkthrough,
  zone,
} from './calendar-fixtures';
import { reachesRightGutter } from './lists';
import { choose, expectChoice } from './select';
import { inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

const table = (page: Page): Locator =>
  page.getByRole('region', { name: 'Appointments table', exact: true }).getByRole('table');
const titles = (page: Page): Locator => table(page).getByRole('rowheader');
const row = (page: Page, name: string): Locator =>
  table(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name, exact: true }) });
const tab = (page: Page, name: string): Locator =>
  page
    .getByRole('group', { name: 'Appointment lists', exact: true })
    .getByRole('button', { name, exact: true });
const range = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Pages', exact: true }).getByRole('status');
const count = (page: Page): Locator =>
  page.getByRole('region', { name: 'Appointments', exact: true }).getByRole('status').first();
const notice = (page: Page): Locator => page.locator('main p.sr-only[role="status"]');

// Earlier today, so it is over by the fixed time.
const morning = appointmentOf(4, 'Morning call', 14, '08:00', '08:30', { status: 'completed' });

test.use({ timezoneId: zone });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(now);
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`lists what is coming, the cancelled and everything at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [morning, tour, tasting, walkthrough, leave]);
    await page.goto(inHarbor('/calendar/appointments'));
    await expect(page.getByRole('heading', { level: 1, name: 'Appointments' })).toBeVisible();

    // Upcoming, soonest first, a page of twenty: what the server is asked.
    await expect(titles(page)).toHaveText(['Final walkthrough']);
    expect(api.lists.find((query) => query['limit'] === '20')).toEqual({
      view: 'upcoming',
      sort: 'startsAt',
      direction: 'asc',
      limit: '20',
    });
    await expect(tab(page, 'Upcoming')).toHaveAttribute('aria-pressed', 'true');
    await expect(count(page)).toHaveText('1 appointment');
    await expect(range(page)).toHaveText('1 - 1 of 1');
    const coming = row(page, 'Final walkthrough');
    await expect(coming.getByRole('link', { name: 'Maya Thompson', exact: true })).toBeVisible();
    await expect(coming.getByText('Booked', { exact: true })).toBeVisible();
    await expect(coming.getByText('Venue tours', { exact: true })).toBeVisible();
    await expect(coming.getByText('You', { exact: true })).toBeVisible();
    await expect(
      table(page).getByRole('columnheader', { name: `Appointment time (${zone})` }),
    ).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.getByRole('button', { name: 'New appointment', exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await testInfo.attach(`appointments-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    await tab(page, 'Cancelled').click();
    await expect(titles(page)).toHaveText(['Menu tasting']);
    await expect(row(page, 'Menu tasting').getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(row(page, 'Menu tasting').getByText('Unassigned', { exact: true })).toBeVisible();
    expect(api.lists.at(-1)?.['view']).toBe('cancelled');

    await tab(page, 'All').click();
    await expect(titles(page)).toHaveText([
      'Morning call',
      'Venue tour',
      'Menu tasting',
      'Final walkthrough',
    ]);
    await expect(count(page)).toHaveText('4 appointments');
    await expect(row(page, 'Venue tour').getByText('Lee Park', { exact: true })).toBeVisible();

    // A heading orders the list on the server; pressed again, the other way round.
    await table(page)
      .getByRole('columnheader', { name: 'Title', exact: true })
      .getByRole('button')
      .click();
    await expect(titles(page)).toHaveText([
      'Final walkthrough',
      'Menu tasting',
      'Morning call',
      'Venue tour',
    ]);
    expect(api.lists.at(-1)).toMatchObject({ view: 'all', sort: 'title', direction: 'asc' });
    await table(page)
      .getByRole('columnheader', { name: 'Title', exact: true })
      .getByRole('button')
      .click();
    await expect(titles(page).first()).toHaveText('Venue tour');
    expect(api.lists.at(-1)).toMatchObject({ sort: 'title', direction: 'desc' });
    await expectNoAccessibilityViolations(page);
  });

  test(`narrows the list by status, calendar, owner and title at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [morning, tour, tasting, walkthrough]);
    await page.goto(inHarbor('/calendar/appointments'));
    await expect(titles(page)).toHaveText(['Final walkthrough']);

    const calendar = page.getByLabel('Calendar', { exact: true });
    await choose(calendar, tastingsId);
    await expectChoice(calendar, tastingsId);
    await expect.poll(() => api.lists.at(-1)?.['calendar']).toBe(tastingsId);
    await expect(
      page.getByRole('heading', { name: 'No upcoming appointments', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Nothing matches the filters and the search.')).toBeVisible();
    await page.getByRole('button', { name: 'See all appointments', exact: true }).click();
    await expect(tab(page, 'All')).toHaveAttribute('aria-pressed', 'true');
    await expect(titles(page)).toHaveText(['Menu tasting']);

    await choose(calendar, 'all');
    const owner = page.getByLabel('Appointment owner', { exact: true });
    await choose(owner, danaId);
    await expect.poll(() => api.lists.at(-1)?.['user']).toBe(danaId);
    await expect(titles(page)).toHaveText(['Final walkthrough']);
    await choose(owner, 'all');

    const status = page.getByLabel('Status', { exact: true });
    await choose(status, 'completed');
    await expect.poll(() => api.lists.at(-1)?.['status']).toBe('completed');
    await expect(titles(page)).toHaveText(['Morning call']);
    await choose(status, 'all');

    await page.getByRole('searchbox', { name: 'Search by title', exact: true }).fill('TOUR');
    await expect(titles(page)).toHaveText(['Venue tour']);
    expect(api.lists.at(-1)).toMatchObject({ view: 'all', q: 'TOUR' });
    for (const control of [status, calendar, owner])
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(width < 1024 ? 44 : 36);
  });

  test(`opens an appointment from the list, moves it and cancels it at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [tour, walkthrough]);
    await page.goto(inHarbor('/calendar/appointments'));
    await row(page, 'Final walkthrough')
      .getByRole('button', { name: 'Final walkthrough', exact: true })
      .click();
    const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(details.getByText('Oct 16, 2026, 3:00 – 4:00 PM')).toBeVisible();
    await expect(details.getByText('The contact booked it', { exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    // Reschedule: the same panel with the time it has; the body carries the revision read.
    const revision = api.appointments.find((each) => each.id === walkthrough.id)?.revision;
    await details.getByRole('button', { name: 'Reschedule', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Reschedule appointment', exact: true });
    const starts = form.getByLabel(`Starts (${zone})`, { exact: true });
    await expect(starts).toHaveValue('2026-10-16T15:00');
    await starts.fill('2026-10-19T11:00');
    await expectNoAccessibilityViolations(page);
    await form.getByRole('button', { name: 'Move appointment', exact: true }).click();
    await expect(details.getByText('Oct 19, 2026, 11:00 AM – 12:00 PM')).toBeVisible();
    expect(api.sent.reschedule).toEqual([
      { revision, startsAt: '2026-10-19T08:00:00.000Z', ignoreAvailability: false },
    ]);
    await expect(notice(page)).toHaveText('Appointment moved.');
    await expect(details.getByText('Dana Brooks moved it', { exact: false })).toBeVisible();

    // Cancel asks first, and sends the reason with the revision the move gave.
    const moved = api.appointments.find((each) => each.id === walkthrough.id)?.revision;
    await details.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
    expect(api.sent.cancel).toEqual([]);
    const asking = details.getByRole('region', { name: 'Cancel this appointment', exact: true });
    await asking.getByLabel('Reason (optional)', { exact: true }).fill('Venue closed');
    await expectNoAccessibilityViolations(page);
    await asking.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
    await expect(details.getByText('Appointment cancelled.', { exact: true })).toBeVisible();
    expect(api.sent.cancel).toEqual([{ revision: moved, reason: 'Venue closed' }]);
    await expect(details.getByText('Venue closed', { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Close', exact: true }).click();

    // The list was read again: it is no longer coming.
    await expect(
      page.getByRole('heading', { name: 'No upcoming appointments', exact: true }),
    ).toBeVisible();
  });
}

test('walks the pages the server gives, a page size at a time', async ({ page }) => {
  const many = Array.from({ length: 12 }, (_, index) =>
    appointmentOf(
      index + 10,
      `Tour ${String(index + 1).padStart(2, '0')}`,
      15 + index,
      '09:00',
      '10:00',
    ),
  );
  const api = await fakeCalendarApi(page, many);
  await page.goto(inHarbor('/calendar/appointments'));
  await expect(titles(page)).toHaveCount(12);
  await choose(page.getByLabel('Appointments per page', { exact: true }), '10');
  await expect(titles(page)).toHaveCount(10);
  await expect(range(page)).toHaveText('1 - 10 of 12');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(titles(page)).toHaveText(['Tour 11', 'Tour 12']);
  await expect(range(page)).toHaveText('11 - 12 of 12');
  expect(api.lists.at(-1)).toMatchObject({ limit: '10', after: many[9]?.id });
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(titles(page).first()).toHaveText('Tour 01');
});

test('someone who may not change appointments reads the list and one appointment only', async ({
  page,
}) => {
  await fakeCalendarApi(page, [walkthrough], { canManage: false });
  await page.goto(inHarbor('/calendar/appointments'));
  await expect(titles(page)).toHaveText(['Final walkthrough']);
  await expect(page.getByRole('button', { name: 'New appointment', exact: true })).toHaveCount(0);
  await row(page, 'Final walkthrough')
    .getByRole('button', { name: 'Final walkthrough', exact: true })
    .click();
  const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
  await expect(details.getByText('Booked', { exact: true })).toBeVisible();
  await expect(details.getByRole('combobox')).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Reschedule', exact: true })).toHaveCount(0);
  await expect(
    details.getByRole('button', { name: 'Cancel appointment', exact: true }),
  ).toHaveCount(0);
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeCalendarApi(page, [walkthrough]);
    await page.goto(inHarbor('/calendar/appointments'));
    await expect(titles(page)).toHaveText(['Final walkthrough']);
    expect(
      await reachesRightGutter(
        page,
        page.getByRole('region', { name: 'Appointments', exact: true }),
      ),
    ).toBe(true);
  });
});
