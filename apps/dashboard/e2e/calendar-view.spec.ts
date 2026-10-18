// Calendars → Calendar view, against a stand-in for the API that answers as the server
// does.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  fakeCalendarApi,
  leave,
  leeId,
  now,
  tasting,
  toursId,
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

const topBar = (page: Page): Locator => page.getByRole('region', { name: 'Top bar', exact: true });
const day = (page: Page, name: string): Locator => page.getByRole('group', { name, exact: true });
const period = (page: Page): Locator =>
  page.getByRole('region', { name: 'Calendar view', exact: true }).getByRole('status').first();

test.use({ timezoneId: zone });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(now);
  await signedIn(page);
});

for (const width of [1440, 360]) {
  test(`shows the week, an event's details, the month and a day at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [tour, tasting, walkthrough, leave]);
    await page.goto(inHarbor('/calendar'));
    await expect(page.getByRole('heading', { level: 1, name: 'Calendars' })).toBeVisible();

    // The module's tabs, as GoHighLevel has them; the calendar is the first.
    const tabs = topBar(page).getByRole('navigation', { name: 'Calendars' }).getByRole('link');
    // Setting calendars up has one place, Settings → Calendars, and no second door here.
    await expect(tabs).toHaveText(['Calendar view', 'Appointment list view']);
    await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'page');

    // This week, from Sunday, read as one window.
    await expect(period(page)).toHaveText('Oct 11 – 17, 2026');
    const wednesday = day(page, 'Wednesday, October 14, 2026');
    await expect(wednesday.getByRole('button', { name: /^Venue tour, / })).toBeVisible();
    expect(api.reads[0]).toEqual({
      from: '2026-10-10T21:00:00.000Z',
      to: '2026-10-17T21:00:00.000Z',
      type: 'all',
    });
    await expect(
      day(page, 'Thursday, October 15, 2026').getByRole('button', {
        name: /^Menu tasting, .*, Cancelled$/,
      }),
    ).toBeVisible();
    const friday = day(page, 'Friday, October 16, 2026');
    await expect(friday.getByRole('button', { name: /^Blocked slot, .*, You$/ })).toBeVisible();
    await expect(friday.getByRole('button', { name: /^Final walkthrough, / })).toBeVisible();
    await expect(page.getByText(zone, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Show Wednesday, October 14, 2026', exact: true }),
    ).toHaveAttribute('aria-current', 'date');
    await expect(page.locator('[data-now]')).toHaveCount(1);
    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await testInfo.attach(`calendar-week-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    // An appointment's details, at the right.
    const opener = wednesday.getByRole('button', { name: /^Venue tour, / });
    await opener.click();
    const panel = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(page).toHaveURL(inHarbor(`/calendar?appointment=${tour.id}`));
    await expectChoice(panel.getByLabel('Status', { exact: true }), 'confirmed');
    await expect(panel.getByRole('link', { name: 'Maya Thompson', exact: true })).toBeVisible();
    await expect(panel.getByText('Venue tours', { exact: true })).toBeVisible();
    await expect(panel.getByText('Lee Park', { exact: true })).toBeVisible();
    await expect(panel.getByText('Oct 14, 2026, 9:00 – 10:00 AM')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(inHarbor('/calendar'));
    await expect(opener).toBeFocused();

    // A blocked slot says whose it is and why.
    await friday.getByRole('button', { name: /^Blocked slot, / }).click();
    const blocked = page.getByRole('dialog', { name: 'Blocked slot', exact: true });
    await expect(blocked.getByText('Dentist', { exact: true })).toBeVisible();
    await blocked.getByRole('button', { name: 'Close', exact: true }).click();

    // The month, then a day from it.
    await choose(page.getByLabel('View', { exact: true }), 'month');
    await expectChoice(page.getByLabel('View', { exact: true }), 'month');
    await expect(period(page)).toHaveText('October 2026');
    await expect(
      day(page, 'Wednesday, October 14, 2026').getByRole('button', { name: /^Venue tour, / }),
    ).toBeVisible();
    expect(api.reads.at(-1)).toMatchObject({
      from: '2026-09-26T21:00:00.000Z',
      to: '2026-11-07T21:00:00.000Z',
    });
    await expectNoAccessibilityViolations(page);
    await page.getByRole('button', { name: 'Show Friday, October 16, 2026', exact: true }).click();
    await expect(period(page)).toHaveText('Friday, October 16, 2026');
    await expect(friday.getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
    await expect(period(page)).toHaveText('Saturday, October 17, 2026');
    await expect(page.getByText('Nothing is booked or blocked in this period.')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(period(page)).toHaveText('Wednesday, October 14, 2026');
  });

  test(`narrows the calendar from Manage view at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [tour, tasting, walkthrough, leave]);
    await page.goto(inHarbor('/calendar'));
    const wednesday = day(page, 'Wednesday, October 14, 2026');
    await expect(wednesday.getByRole('button', { name: /^Venue tour, / })).toBeVisible();

    await page.getByRole('button', { name: 'Manage view', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Manage view', exact: true });
    await panel.getByRole('checkbox', { name: 'Venue tours', exact: true }).check();
    await expect.poll(() => api.reads.at(-1)?.['calendars']).toBe(toursId);
    await panel.getByRole('radio', { name: 'Appointments', exact: true }).check();
    await expect.poll(() => api.reads.at(-1)?.['type']).toBe('appointments');
    await expect(panel.getByRole('checkbox', { name: 'Dana Brooks (you)' })).not.toBeChecked();
    for (const box of await panel.getByRole('checkbox').all())
      expect((await box.locator('xpath=..').boundingBox())?.height).toBeGreaterThanOrEqual(
        width < 1024 ? 44 : 36,
      );
    await expectNoAccessibilityViolations(page);
    await panel.getByRole('button', { name: 'Close', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Manage view (2)', exact: true })).toBeFocused();
    await expect(wednesday.getByRole('button', { name: /^Venue tour, / })).toBeVisible();
    await expect(
      day(page, 'Thursday, October 15, 2026').getByRole('button', { name: /^Menu tasting, / }),
    ).toHaveCount(0);
    await expect(
      day(page, 'Friday, October 16, 2026').getByRole('button', { name: /^Blocked slot, / }),
    ).toHaveCount(0);
  });
}

for (const width of [1440, 360]) {
  test(`books an appointment from the calendar, past a double booking, at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [tour]);
    await page.goto(inHarbor('/calendar'));
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Appointment', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New appointment', exact: true });
    const starts = form.getByLabel(`Starts (${zone})`, { exact: true });
    // The next half hour after a quarter past ten.
    await expect(starts).toHaveValue('2026-10-14T10:30');

    // Only a calendar that takes bookings is offered.
    await form.getByLabel('Calendar', { exact: true }).click();
    await expect(page.getByRole('option', { name: 'Venue tours', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Tastings', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await choose(form.getByLabel('Calendar', { exact: true }), toursId);
    await form.getByRole('searchbox', { name: 'Contact', exact: true }).fill('maya');
    await form.getByRole('button', { name: /^Maya Thompson/ }).click();
    await starts.fill('2026-10-14T09:30');
    await choose(form.getByLabel('Appointment owner', { exact: true }), leeId);
    await form.getByLabel('Title', { exact: true }).fill('Second tour');
    await form.getByLabel('Location', { exact: true }).fill('Pier 4');
    await form.getByLabel('Notes', { exact: true }).fill('Bring the floor plan.');
    await expect(form.getByLabel(`Ends (${zone})`, { exact: true })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    await testInfo.attach(`new-appointment-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    // Lee is with someone then: the server's words show beside the start.
    api.refuse('create', { status: 409, detail: 'This appointment time is unavailable.' });
    await form.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await expect(form.getByText('This appointment time is unavailable.')).toBeVisible();
    await expect(starts).toHaveAttribute('aria-invalid', 'true');
    await expectNoAccessibilityViolations(page);

    // Outside the calendar's hours on purpose: an end is asked for, and sent.
    await starts.fill('2026-10-14T19:00');
    await form.getByRole('checkbox', { name: 'Ignore availability', exact: true }).check();
    await form.getByLabel(`Ends (${zone})`, { exact: true }).fill('2026-10-14T19:45');
    await form.getByRole('button', { name: 'Book appointment', exact: true }).click();

    const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(details.getByText('Second tour', { exact: true })).toBeVisible();
    await expect(details.getByText('Bring the floor plan.', { exact: true })).toBeVisible();
    const [first, second] = api.sent.create as Record<string, unknown>[];
    expect(String(first?.['requestId'])).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).toEqual({
      requestId: first?.['requestId'],
      calendarId: toursId,
      contactId: 'con_01h455vb4pex5vsknk084sn02q',
      startsAt: '2026-10-14T06:30:00.000Z',
      ignoreAvailability: false,
      assignee: leeId,
      title: 'Second tour',
      status: 'confirmed',
      location: 'Pier 4',
      notes: 'Bring the floor plan.',
    });
    expect(second).toMatchObject({
      startsAt: '2026-10-14T16:00:00.000Z',
      endsAt: '2026-10-14T16:45:00.000Z',
      ignoreAvailability: true,
    });
    // Each try is a request of its own.
    expect(second?.['requestId']).not.toBe(first?.['requestId']);
    await expect(page).toHaveURL(/\/calendar\?appointment=appt_/);
    await details.getByRole('button', { name: 'Close', exact: true }).click();
    // The calendar was read again and draws it.
    await expect(
      day(page, 'Wednesday, October 14, 2026').getByRole('button', { name: /^Second tour, / }),
    ).toBeVisible();
  });

  test(`opens an appointment by its address and changes it at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [tour, walkthrough]);
    // Where a notification about an appointment leads.
    await page.goto(inHarbor(`/calendar?appointment=${walkthrough.id}`));
    const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(details.getByText('Final walkthrough', { exact: true })).toBeVisible();
    const status = details.getByLabel('Status', { exact: true });
    await expectChoice(status, 'booked');
    await expectNoAccessibilityViolations(page);

    // Someone else moves it first: the change is refused, and the panel reads it again.
    const opened = api.appointments.find((each) => each.id === walkthrough.id)?.revision;
    api.touch(walkthrough.id, { title: 'Final walkthrough (with caterer)' });
    await choose(status, 'confirmed');
    await expect(details.getByRole('alert')).toContainText(
      'Someone changed this appointment first.',
    );
    await expect(
      details.getByText('Final walkthrough (with caterer)', { exact: true }),
    ).toBeVisible();
    expect(api.sent.status).toEqual([{ revision: opened, status: 'confirmed' }]);
    await expectChoice(status, 'booked');

    // The next try carries the revision just read.
    const latest = api.appointments.find((each) => each.id === walkthrough.id)?.revision;
    await choose(status, 'no_show');
    await expect(details.getByText('Status changed.', { exact: true })).toBeVisible();
    expect(api.sent.status.at(-1)).toEqual({ revision: latest, status: 'no_show' });
    await expectChoice(status, 'no_show');
    // Not booked or confirmed any more: it cannot be moved.
    await expect(details.getByRole('button', { name: 'Reschedule', exact: true })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);

    // A status that needs its time back is refused when the time is taken.
    api.refuse('status', { status: 409, detail: 'This appointment time is unavailable.' });
    await choose(status, 'confirmed');
    await expect(details.getByRole('alert')).toHaveText('This appointment time is unavailable.');
  });
}

test('an appointment that is not there says so', async ({ page }) => {
  await fakeCalendarApi(page, [tour]);
  await page.goto(inHarbor('/calendar?appointment=appt_01h455vb4pex5vsknk084sn0zz'));
  await expect(
    page.getByRole('dialog', { name: 'Appointment', exact: true }).getByRole('alert'),
  ).toContainText('This appointment is no longer there.');
});

test('someone who may not book is offered no appointment under New', async ({ page }) => {
  await fakeCalendarApi(page, [tour], { canManage: false });
  await page.goto(inHarbor('/calendar'));
  await expect(
    day(page, 'Wednesday, October 14, 2026').getByRole('button', { name: /^Venue tour, / }),
  ).toBeVisible();
  // Blocking time is for whoever may manage calendars, which the events' read says this person may.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Blocked slot', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Appointment', exact: true })).toHaveCount(0);
});

test('says so when the calendar cannot be read, and reads it again', async ({ page }) => {
  let fail = true;
  await fakeCalendarApi(page, [tour]);
  await page.route(/\/api\/v1\/calendars\/events\?/, async (route) => {
    if (!fail) return route.fallback();
    await route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      json: { type: 'about:blank', title: 'Forbidden', status: 403 },
    });
  });
  await page.goto(inHarbor('/calendar'));
  const problem = page.getByRole('main').getByRole('alert');
  await expect(problem).toContainText("The calendar couldn't be loaded.");
  await expectNoAccessibilityViolations(page);
  fail = false;
  await problem.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    day(page, 'Wednesday, October 14, 2026').getByRole('button', { name: /^Venue tour, / }),
  ).toBeVisible();
});

test('reaches the appointment list from the tabs, and sets calendars up in Settings only', async ({
  page,
}) => {
  await fakeCalendarApi(page, [tour]);
  await page.goto(inHarbor('/calendar'));
  const tabs = topBar(page).getByRole('navigation', { name: 'Calendars' }).getByRole('link');

  await tabs.nth(1).click();
  await expect(page).toHaveURL(inHarbor('/calendar/appointments'));
  await expect(page.getByRole('heading', { level: 1, name: 'Appointments' })).toBeVisible();
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(tabs.nth(0)).not.toHaveAttribute('aria-current');

  // The calendars are set up in one place, Settings: there is no third tab here.
  await expect(tabs).toHaveCount(2);
  await page.goto(inHarbor('/settings/calendars'));
  await expect(page.getByRole('heading', { level: 1, name: 'Calendars' })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: 'Calendars', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('uses the whole width beside the sidebar', async ({ page }) => {
    await fakeCalendarApi(page, [tour]);
    await page.goto(inHarbor('/calendar'));
    await expect(
      day(page, 'Wednesday, October 14, 2026').getByRole('button', { name: /^Venue tour, / }),
    ).toBeVisible();
    expect(
      await reachesRightGutter(
        page,
        page.getByRole('region', { name: 'Calendar view', exact: true }),
      ),
    ).toBe(true);
  });
});
