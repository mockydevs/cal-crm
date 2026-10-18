// A contact's Appointments panel: the contact's appointments, upcoming and past, opened in
// the appointment panel, booked from the contact, and their notes written. Against a
// stand-in for the API that answers as the server does and checks what it is sent against
// the contract.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  appointmentOf,
  fakeCalendarApi,
  now,
  tasting,
  tour,
  toursId,
  walkthrough,
  zone,
} from './calendar-fixtures';
import { emptyContactPanels } from './contact-panels';
import { choose } from './select';
import { harbor, inHarbor, signedIn, worksIn } from './session';
import { configurationOf } from './tag-fixtures';

const maya = tour.contact.id;
const at = '2026-10-01T09:00:00.000Z';
// Someone else's appointment: never on Maya's page.
const other = appointmentOf(5, 'Another client', 17, '09:00', '10:00', {
  contact: { id: 'con_01h455vb4pex5vsknk084sn05q', name: 'Ali Hassan', trashed: false },
});

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}

/** Maya's contact page, with nothing in its other panels. */
async function mayasPage(page: Page): Promise<void> {
  await emptyContactPanels(page);
  await page.route(`**/api/v1/contacts/${maya}`, (route) =>
    route.fulfill({
      json: {
        id: maya,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: ['maya@example.test'],
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
  await page.route(`**/api/v1/records/${maya}/tags`, (route) =>
    route.fulfill({ json: { items: [], canManage: true } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
}

const panelOf = (page: Page): Locator =>
  page.getByRole('region', { name: 'Appointments', exact: true });
const titlesIn = (list: Locator): Locator => list.getByRole('listitem').getByRole('link');
const lists = (page: Page): Locator =>
  panelOf(page).getByRole('group', { name: 'Appointment lists', exact: true });

/** Opens the panel: from the rail on a wide screen, from the row of sections on a narrow one. */
async function openAppointments(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: /^Contact (?:panels|sections)$/ })
    .getByRole('link', { name: 'Appointments', exact: true })
    .click();
  await expect(page).toHaveURL(inHarbor(`/contacts/${maya}?view=appointments`));
}

test.use({ timezoneId: zone });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(now);
  await signedIn(page);
  await mayasPage(page);
});

for (const width of [1440, 360]) {
  test(`lists the contact's appointments, upcoming and past, and opens one at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [tour, tasting, walkthrough, other]);
    await page.goto(inHarbor(`/contacts/${maya}`));
    await openAppointments(page);
    const panel = panelOf(page);

    // What starts from now, soonest first, a cancelled one with its status.
    const upcoming = panel.getByRole('list', { name: 'Upcoming appointments', exact: true });
    await expect(titlesIn(upcoming)).toHaveText(['Menu tasting', 'Final walkthrough']);
    await expect(
      upcoming.getByRole('listitem').first().getByText('Cancelled', { exact: true }),
    ).toBeVisible();
    await expect(upcoming.getByRole('listitem').last()).toContainText('Venue tours · You');
    await expect(
      panel.getByText(`2 appointments, times in ${zone}`, { exact: true }),
    ).toBeVisible();
    expect(api.lists.at(-1)).toEqual({
      view: 'all',
      contact: maya,
      sort: 'startsAt',
      from: now.toISOString(),
      direction: 'asc',
      limit: '20',
    });
    await expect(lists(page).getByRole('button', { name: 'Upcoming' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await testInfo.attach(`contact-appointments-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    // What has started, latest first.
    await lists(page).getByRole('button', { name: 'Past', exact: true }).click();
    const past = panel.getByRole('list', { name: 'Past appointments', exact: true });
    await expect(titlesIn(past)).toHaveText(['Venue tour']);
    expect(api.lists.at(-1)).toMatchObject({ to: now.toISOString(), direction: 'desc' });

    // A title is a link to the appointment on the Calendar; a click opens it here.
    const link = past.getByRole('link', { name: 'Venue tour', exact: true });
    await expect(link).toHaveAttribute('href', inHarbor(`/calendar?appointment=${tour.id}`));
    await link.click();
    const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(details.getByText('Venue tour', { exact: true })).toBeVisible();
    await expect(details.getByText('Lee Park', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(inHarbor(`/contacts/${maya}?view=appointments`));
    await expectNoAccessibilityViolations(page);
    await details.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(details).toHaveCount(0);
    await expect(link).toBeFocused();

    // A search by title, on the server.
    await panel.getByRole('searchbox', { name: 'Search appointments', exact: true }).fill('zzz');
    await expect(
      panel.getByText('No appointments match your search.', { exact: true }),
    ).toBeVisible();
    expect(api.lists.at(-1)).toMatchObject({ q: 'zzz', contact: maya });
  });

  test(`books an appointment for the contact from the panel at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [tour, other]);
    await page.goto(inHarbor(`/contacts/${maya}?view=appointments`));
    const panel = panelOf(page);
    // Nothing coming: the empty panel says so, and books from its own words.
    await expect(panel.getByText('No upcoming appointments.', { exact: true })).toBeVisible();
    const book = panel.getByRole('button', { name: 'Book appointment', exact: true });
    await expect(book).toHaveCount(1);
    expect((await book.boundingBox())?.height).toBeGreaterThanOrEqual(width < 1024 ? 44 : 36);
    await book.click();

    const form = page.getByRole('dialog', { name: 'New appointment', exact: true });
    // The contact is chosen already, and can still be taken off.
    await expect(form.getByText('Maya Thompson', { exact: true })).toBeVisible();
    await expect(
      form.getByRole('button', { name: 'Remove Maya Thompson', exact: true }),
    ).toBeVisible();
    await expect(form.getByRole('searchbox', { name: 'Contact', exact: true })).toHaveCount(0);
    await choose(form.getByLabel('Calendar', { exact: true }), toursId);
    await expect(form.getByLabel(`Starts (${zone})`, { exact: true })).toHaveValue(
      '2026-10-14T10:30',
    );
    await expectNoAccessibilityViolations(page);
    await testInfo.attach(`contact-book-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await form.getByRole('button', { name: 'Book appointment', exact: true }).click();

    const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(details.getByText('Venue tours', { exact: true }).first()).toBeVisible();
    expect(api.sent.create).toEqual([
      {
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        calendarId: toursId,
        contactId: maya,
        startsAt: '2026-10-14T07:30:00.000Z',
        ignoreAvailability: false,
        status: 'confirmed',
        notes: '',
      },
    ]);
    // The contact's page stays where it was, and its list is read again with the new one.
    await expect(page).toHaveURL(inHarbor(`/contacts/${maya}?view=appointments`));
    await details.getByRole('button', { name: 'Close', exact: true }).click();
    const upcoming = panel.getByRole('list', { name: 'Upcoming appointments', exact: true });
    await expect(titlesIn(upcoming)).toHaveText(['Venue tours']);
    await expectNoAccessibilityViolations(page);
  });

  test(`writes an appointment's notes, past a note someone saved first, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeCalendarApi(page, [walkthrough]);
    await page.goto(inHarbor(`/contacts/${maya}?view=appointments`));
    await panelOf(page).getByRole('link', { name: 'Final walkthrough', exact: true }).click();
    const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(details.getByText('No notes yet.', { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Add notes', exact: true }).click();
    const box = details.getByRole('textbox', { name: 'Notes', exact: true });
    await box.fill('Bring the floor plan.\nAsk about parking.');
    await expectNoAccessibilityViolations(page);

    // Lee saved a note meanwhile: the save is refused, Lee's words show, and ours stay.
    const opened = api.appointments[0]?.revision;
    api.touch(walkthrough.id, { notes: 'Lee: the client prefers mornings.' });
    const touched = api.appointments[0]?.revision;
    await details.getByRole('button', { name: 'Save notes', exact: true }).click();
    await expect(details.getByText(/Someone changed this appointment first/)).toBeVisible();
    await expect(details.getByText('The notes now read:', { exact: true })).toBeVisible();
    await expect(
      details.getByText('Lee: the client prefers mornings.', { exact: true }),
    ).toBeVisible();
    await expect(box).toHaveValue('Bring the floor plan.\nAsk about parking.');
    await box.fill('Lee: the client prefers mornings.\nBring the floor plan.');
    await details.getByRole('button', { name: 'Save notes', exact: true }).click();
    await expect(details.getByText('Notes saved.', { exact: true })).toBeVisible();
    await expect(box).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Edit notes', exact: true })).toBeVisible();

    // The first try named the revision it read; the second, the one read again.
    expect(api.sent.notes).toEqual([
      { revision: opened, notes: 'Bring the floor plan.\nAsk about parking.' },
      { revision: touched, notes: 'Lee: the client prefers mornings.\nBring the floor plan.' },
    ]);
    expect(api.appointments[0]?.notes).toBe(
      'Lee: the client prefers mornings.\nBring the floor plan.',
    );
    await expectNoAccessibilityViolations(page);
  });
}

test('offers no booking and no note writing to someone who may not change appointments', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fakeCalendarApi(page, [walkthrough], { canManage: false });
  await page.goto(inHarbor(`/contacts/${maya}?view=appointments`));
  const panel = panelOf(page);
  await expect(panel.getByRole('link', { name: 'Final walkthrough', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Book appointment' })).toHaveCount(0);
  await panel.getByRole('link', { name: 'Final walkthrough', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
  await expect(details.getByText('Final walkthrough', { exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: /notes/ })).toHaveCount(0);
});

test.describe("in a browser in another zone than the business's", () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test("shows and books times in the business's zone", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await worksIn(page, { agencyStaff: false, businesses: [{ ...harbor, timezone: zone }] });
    const api = await fakeCalendarApi(page, [walkthrough]);
    await page.goto(inHarbor(`/contacts/${maya}?view=appointments`));
    const panel = panelOf(page);
    await expect(panel.getByText(`1 appointment, times in ${zone}`, { exact: true })).toBeVisible();
    // Three in the afternoon in Nairobi, not five in the morning in Los Angeles.
    await expect(panel.getByRole('listitem')).toContainText(/Oct 16, 2026, 3:00\s?–\s?4:00\sPM/);

    await panel.getByRole('button', { name: 'Book appointment', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New appointment', exact: true });
    const starts = form.getByLabel(`Starts (${zone})`, { exact: true });
    // The next half hour after a quarter past ten in Nairobi.
    await expect(starts).toHaveValue('2026-10-14T10:30');
    await choose(form.getByLabel('Calendar', { exact: true }), toursId);
    await starts.fill('2026-10-14T11:00');
    await form.getByRole('button', { name: 'Book appointment', exact: true }).click();
    const details = page.getByRole('dialog', { name: 'Appointment', exact: true });
    await expect(details.getByText(`(${zone})`, { exact: true })).toBeVisible();
    expect(api.sent.create).toMatchObject([{ startsAt: '2026-10-14T08:00:00.000Z' }]);
  });
});
