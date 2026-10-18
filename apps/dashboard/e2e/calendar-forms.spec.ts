// Settings → Calendars in a real browser, against the stand-in API of
// calendar-settings-fixtures.ts: the list as the owner's GoHighLevel screenshot has it, with
// its groups and filters; "New calendar" (the type chooser, then the modal); and the full
// editor with its seven sections. It replaces the cases of the page before this one, which
// edited a calendar inline under the list. Nothing with no product behind it is drawn, so
// these cases also check that no greyed control or "not available" tab remains.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createCalendarInput,
  updateCalendarAvailabilityInput,
  updateCalendarInput,
  type CalendarConfiguration,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { calendarOf, danaId, leeId, senderId, type FakeApi } from './calendar-settings-fake';
import { fakeCalendarSettingsApi } from './calendar-settings-fixtures';
import { reachesRightGutter } from './lists';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';

const main = (page: Page): Locator => page.getByRole('main');
const row = (page: Page, name: string): Locator =>
  main(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name }) });
const tab = (page: Page, name: string): Locator => page.getByRole('tab', { name, exact: true });
const rail = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Calendar groups', exact: true });
const status = (page: Page, text: string): Locator =>
  main(page).getByRole('status').filter({ hasText: text });
const bodiesOf = (api: FakeApi, operation: string): unknown[] =>
  api.of(operation).map((call) => call.body);
const lastList = (api: FakeApi): Record<string, unknown> | undefined =>
  api.of('listCalendars').at(-1)?.query;

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** Presses Tab until something is focused, as someone with only a keyboard does. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 40; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

const tours = calendarOf('21', 'Venue tours');
const tastings = calendarOf('22', 'Tastings', {
  kind: 'round_robin',
  isActive: false,
  bookable: false,
});
const classes = calendarOf('23', 'Dance class', {
  kind: 'class',
  isActive: false,
  supported: false,
  bookable: false,
});
const consultation = calendarOf('31', 'Consultation', { isActive: false, bookable: false });
function saved(rest: Partial<CalendarConfiguration> = {}): CalendarConfiguration {
  return {
    calendar: consultation,
    members: [{ membershipId: danaId, weight: 1, locations: [] }],
    weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
    dateOverrides: [],
    revision: 'a'.repeat(64),
    canManage: true,
    ...rest,
  };
}
const editorOf = (id: string): string => inHarbor(`/settings/calendars/${id}`);
const section = async (page: Page, name: string, heading: string = name): Promise<void> => {
  await tab(page, name).click();
  await expect(page.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible();
};
const save = (page: Page): Promise<void> =>
  page.getByRole('button', { name: 'Save changes', exact: true }).click();

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

for (const width of [390, 1280])
  test(`lists the calendars as one page with one header, at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 900 });
    await fakeCalendarSettingsApi(page, {
      calendars: [tours, tastings, classes],
      groups: ['Sales'],
    });
    await page.goto(inHarbor('/settings/calendars'));

    // One header: the top bar names the page and holds its tabs; the page has the one
    // level-1 heading. Only what works is drawn: GoHighLevel's Preferences and Connections,
    // and its Service menu, Rooms and Equipment, have nothing behind them here.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Calendars']);
    const bar = page.getByRole('region', { name: 'Top bar', exact: true });
    await expect(bar.getByText('Settings', { exact: true })).toHaveCount(0);
    const tabs = bar.getByRole('navigation', { name: 'Calendars', exact: true });
    await expect(tabs.getByRole('link')).toHaveText(['Calendars', 'Availability']);
    await expect(tabs.getByRole('link', { name: 'Calendars', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(main(page).getByText(/available in this version/)).toHaveCount(0);
    if (width >= 1024)
      await expect(
        page
          .getByRole('navigation', { name: 'Settings' })
          .getByRole('link', { name: 'Calendars', exact: true }),
      ).toHaveAttribute('aria-current', 'page');

    await expect(rail(page).getByRole('button', { name: 'All calendars (3)' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(rail(page).getByRole('button', { name: 'Not grouped 3' })).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Sales 0', exact: true })).toBeVisible();

    const table = page
      .getByRole('region', { name: 'Calendars table', exact: true })
      .getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveText([
      'Calendar name',
      'Group',
      'Duration',
      'Type',
      'Status',
      'Date updated',
      'Actions',
    ]);
    await expect(row(page, 'Venue tours').getByRole('cell')).toContainText([
      '',
      '30 min',
      'Personal booking',
      'Active',
      'Oct 9, 2026',
    ]);
    await expect(row(page, 'Venue tours').getByText(`Id: ${tours.id}`)).toBeVisible();
    await expect(row(page, 'Tastings').getByRole('cell').nth(3)).toHaveText('Inactive');
    await expect(row(page, 'Dance class').getByRole('cell').nth(3)).toContainText(
      "Not bookable yet: this type can't take bookings yet.",
    );
    await expect(main(page).getByText('1 - 3 of 3')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
    // No greyed control that does nothing, on any row.
    await expect(main(page).getByRole('button', { name: /Integrations/ })).toHaveCount(0);
    await expect(main(page).locator('[aria-disabled="true"]')).toHaveCount(0);
    await expectAccessible(page);

    // The share action copies the public booking address; the id has its own button.
    await row(page, 'Venue tours')
      .getByRole('button', { name: 'Copy the booking link of Venue tours', exact: true })
      .click();
    await expect(status(page, 'Booking link copied.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${new URL(page.url()).origin}/book/bluebird-digital/${harbor.slug}/venue-tours`,
    );
    await row(page, 'Venue tours')
      .getByRole('button', { name: 'Copy the id of Venue tours', exact: true })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(tours.id);
  });

test('Availability leads to each person, and the removed tabs have no address', async ({
  page,
}) => {
  await fakeCalendarSettingsApi(page, { calendars: [tours] });
  // GoHighLevel's Preferences and Connections had pages that only said "not available".
  for (const gone of ['preferences', 'connections']) {
    await page.goto(inHarbor(`/settings/calendars/${gone}`));
    await expect(main(page).getByText(/available in this version/)).toHaveCount(0);
  }
  await page.goto(inHarbor('/settings/calendars'));
  const tabs = page.getByRole('navigation', { name: 'Calendars', exact: true });
  await tabs.getByRole('link', { name: 'Availability', exact: true }).click();
  await expect(tabs.getByRole('link', { name: 'Availability', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const people = main(page).getByRole('list', { name: 'People of this account', exact: true });
  await expect(people.getByRole('listitem')).toHaveText([
    'Dana BrooksOpen in Users',
    'Lee ParkOpen in Users',
  ]);
  await expect(
    people.getByRole('link', { name: 'Open in Users: Dana Brooks', exact: true }),
  ).toHaveAttribute('href', inHarbor(`/settings/team/${danaId}`));
  await expectAccessible(page);
});

test('an empty list, a failed list and failed groups each say so in their own place', async ({
  page,
}) => {
  const api = await fakeCalendarSettingsApi(page, { groups: ['Sales'] });
  await page.goto(inHarbor('/settings/calendars'));
  const region = page.getByRole('region', { name: 'Calendars', exact: true });
  await expect(
    region.getByText("Create a calendar to set your team's availability."),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New calendar', exact: true })).toBeVisible();
  await expectAccessible(page);

  const refused = new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
  api.refuse('listCalendars', refused);
  await page.reload();
  await expect(region.getByRole('alert')).toContainText("We couldn't load calendars.");
  await expect(rail(page).getByRole('button', { name: 'Sales 0', exact: true })).toBeVisible();
  await expect(rail(page).getByRole('alert')).toHaveCount(0);
  await expectAccessible(page);
  await region.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(region.getByRole('alert')).toHaveCount(0);

  api.refuse('listCalendarGroups', refused);
  await page.reload();
  await expect(rail(page).getByRole('alert')).toContainText("We couldn't load the groups.");
  await expect(
    rail(page).getByRole('button', { name: 'All calendars', exact: true }),
  ).toBeVisible();
  await expect(region.getByRole('alert')).toHaveCount(0);
  await expectAccessible(page);
  await rail(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'All calendars (0)' })).toBeVisible();
});

test('filters and the search ask the server, which also pages the list', async ({ page }) => {
  const many = Array.from({ length: 27 }, (_, index) =>
    calendarOf(String(index + 40), `Calendar ${String(index + 1).padStart(2, '0')}`),
  );
  const api = await fakeCalendarSettingsApi(page, {
    configurations: [saved({ calendar: tours })],
    calendars: [tastings, classes, ...many],
  });
  await page.goto(inHarbor('/settings/calendars'));
  await expect(row(page, 'Tastings')).toBeVisible();
  expect(lastList(api)).toEqual({ limit: '25' });
  await expect(main(page).getByText('1 - 25 of 30')).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(main(page).getByText('26 - 30 of 30')).toBeVisible();
  await expect(row(page, 'Venue tours')).toBeVisible();
  expect(lastList(api)).toEqual({ limit: '25', after: many[22]?.id });
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(row(page, 'Tastings')).toBeVisible();

  await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'inactive');
  await expect(main(page).getByText('1 - 2 of 2')).toBeVisible();
  expect(lastList(api)).toEqual({ limit: '25', status: 'inactive' });
  await choose(page.getByRole('combobox', { name: 'Type', exact: true }), 'class');
  await expect(row(page, 'Tastings')).toHaveCount(0);
  await expect(row(page, 'Dance class')).toBeVisible();
  expect(lastList(api)).toEqual({ limit: '25', status: 'inactive', kind: 'class' });

  await choose(page.getByRole('combobox', { name: 'Status', exact: true }), 'all');
  await choose(page.getByRole('combobox', { name: 'Type', exact: true }), 'all');
  await choose(page.getByRole('combobox', { name: 'Owned by', exact: true }), danaId);
  await expect(main(page).getByText('1 - 1 of 1')).toBeVisible();
  expect(lastList(api)).toEqual({ limit: '25', member: danaId });
  await choose(page.getByRole('combobox', { name: 'Owned by', exact: true }), 'anyone');

  await page.getByRole('searchbox', { name: 'Calendar/group name', exact: true }).fill('tast');
  // The search waits for typing to pause before it asks.
  await expect.poll(() => lastList(api)).toEqual({ limit: '25', q: 'tast' });
  await expect(main(page).getByText('1 - 1 of 1')).toBeVisible();
  await expect(row(page, 'Tastings')).toBeVisible();
});

test('groups are created, renamed and deleted, and filter the table', async ({ page }) => {
  const api = await fakeCalendarSettingsApi(page, {
    configurations: [saved()],
    calendars: [tours],
    groups: ['Sales'],
  });
  await page.goto(inHarbor('/settings/calendars'));
  await rail(page).getByRole('button', { name: 'New group', exact: true }).click();
  const naming = page.getByRole('dialog', { name: 'New group', exact: true });
  await naming.getByLabel('Group name', { exact: true }).fill('Sales');
  await naming.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(naming.getByRole('alert')).toHaveText('Another group already has this name.');
  await expectAccessible(page);
  await naming.getByLabel('Group name', { exact: true }).fill('Support');
  await naming.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(status(page, 'Group Support created.')).toBeVisible();
  await expect(rail(page).getByRole('button', { name: 'Support 0', exact: true })).toBeVisible();

  // A calendar put in the group in its editor is counted there, and found by the filter.
  await row(page, 'Consultation').getByRole('link', { name: 'Edit Consultation' }).click();
  await choose(page.getByLabel('Group', { exact: true }), await groupId(api, 'Support'));
  await save(page);
  await expect(status(page, 'Changes saved.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to calendars list', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'Support 1', exact: true })).toBeVisible();
  await expect(rail(page).getByRole('button', { name: 'Not grouped 1' })).toBeVisible();
  await expect(row(page, 'Consultation').getByRole('cell').first()).toHaveText('Support');
  await rail(page).getByRole('button', { name: 'Support 1', exact: true }).click();
  await expect(row(page, 'Venue tours')).toHaveCount(0);
  await expect(row(page, 'Consultation')).toBeVisible();
  await rail(page).getByRole('button', { name: 'Not grouped 1' }).click();
  await expect(row(page, 'Consultation')).toHaveCount(0);
  await expect(row(page, 'Venue tours')).toBeVisible();
  expect(lastList(api)).toEqual({ limit: '25', group: 'none' });

  await rail(page).getByRole('button', { name: 'Actions for the group Support' }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const renaming = page.getByRole('dialog', { name: 'Rename group', exact: true });
  await renaming.getByLabel('Group name', { exact: true }).fill('Success');
  await renaming.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'Success 1', exact: true })).toBeVisible();

  await rail(page).getByRole('button', { name: 'Actions for the group Success' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete the group Success?', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(rail(page).getByRole('button', { name: /^Success/ })).toHaveCount(0);
  // Its calendar is kept, in no group.
  await expect(rail(page).getByRole('button', { name: 'Not grouped 2' })).toBeVisible();
  await expect(rail(page).getByRole('button', { name: 'All calendars (2)' })).toBeVisible();
});

async function groupId(api: FakeApi, name: string): Promise<string> {
  const groups = (await api.ask({ operation: 'listCalendarGroups' })) as {
    items: { id: string; name: string }[];
  };
  const found = groups.items.find((each) => each.name === name);
  if (found === undefined) throw new Error(`No group named ${name} in the stand-in.`);
  return found.id;
}

test('deletes a calendar after asking, and shows why one with appointments stays', async ({
  page,
}) => {
  const api = await fakeCalendarSettingsApi(page, {
    calendars: [tours, tastings],
    booked: [tours.id],
  });
  await page.goto(inHarbor('/settings/calendars'));
  await row(page, 'Venue tours').getByRole('button', { name: 'Actions for Venue tours' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const refusing = page.getByRole('dialog', { name: 'Delete Venue tours?', exact: true });
  await refusing.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(refusing.getByRole('alert')).toHaveText(
    '"Venue tours" has appointments, so it can\'t be deleted. Make it inactive instead.',
  );
  await expectAccessible(page);
  await refusing.getByRole('button', { name: 'Cancel', exact: true }).click();

  await row(page, 'Tastings').getByRole('button', { name: 'Actions for Tastings' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete Tastings?', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(status(page, 'Tastings was deleted.')).toBeVisible();
  await expect(row(page, 'Tastings')).toHaveCount(0);
  expect(api.calendars().map((each) => each.name)).toEqual(['Venue tours']);
});

for (const width of [390, 1280])
  test(`New calendar asks for a type, then creates a draft, by keyboard alone, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fakeCalendarSettingsApi(page);
    await page.goto(inHarbor('/settings/calendars'));
    const opener = page.getByRole('button', { name: 'New calendar', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');

    const chooser = page.getByRole('dialog', { name: 'Choose calendar type', exact: true });
    await expect(chooser).toBeVisible();
    await expect(
      chooser.getByText(
        'Select a calendar type to set up your calendar and customize how appointments are scheduled.',
      ),
    ).toBeVisible();
    const types = chooser.getByRole('list', { name: 'Calendar types', exact: true });
    // Only the types that take bookings: the others come back when their booking is built.
    await expect(types.getByRole('button')).toHaveText([
      /^Personal bookingSchedules one-on-one meetings with a specific team member\.E\.g\.: Client meetings, private consultations\.$/,
      /^Round robinDistributes appointments among team members in a rotating order\.E\.g\.: Sales calls, onboarding sessions\.$/,
    ]);
    await expect(chooser.getByRole('button', { name: 'Explore more types' })).toHaveCount(0);
    await expectAccessible(page);

    const personal = chooser.getByRole('button', { name: /^Personal booking/ });
    await personal.focus();
    await page.keyboard.press('Enter');
    const modal = page.getByRole('dialog', { name: 'New calendar', exact: true });
    await expect(modal).toBeVisible();
    await expect(chooser).toHaveCount(0);
    // Our own public address, not the vendor's widget path.
    await expect(modal.getByText(`/book/bluebird-digital/${harbor.slug}/`)).toBeVisible();
    await expect(modal.getByText('Weekdays, 8:00 AM to 5:00 PM')).toBeVisible();
    await expectAccessible(page);

    await tabTo(page, modal.getByLabel('Calendar name', { exact: true }));
    await page.keyboard.type('Outbound reach');
    await expect(modal.getByLabel('Custom URL', { exact: true })).toHaveValue('outbound-reach');
    // Only people of the account: not Ava of the agency, not Sam who has not joined.
    const member = modal.getByRole('combobox', { name: 'Select team member', exact: true });
    await tabTo(page, member);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option')).toHaveText([
      'Select a team member',
      'Dana Brooks',
      'Lee Park',
    ]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(member).toContainText('Dana Brooks');
    const hours = modal.getByRole('region', { name: 'Booking availability', exact: true });
    await expect(hours.getByRole('listitem')).toHaveText([
      'DBDana BrooksWeekdays, 8:00 AM to 5:00 PM',
    ]);
    await expectAccessible(page);
    await tabTo(page, modal.getByRole('button', { name: 'Confirm', exact: true }));
    await page.keyboard.press('Enter');

    await expect(modal).toHaveCount(0);
    await expect(status(page, 'Outbound reach was created as a draft.')).toBeVisible();
    await expect(row(page, 'Outbound reach').getByRole('cell').nth(3)).toHaveText('Inactive');
    await expect(opener).toBeFocused();
    expect(bodiesOf(api, 'createCalendar').map((body) => createCalendarInput.parse(body))).toEqual([
      expect.objectContaining({
        name: 'Outbound reach',
        kind: 'personal',
        bookingSlug: 'outbound-reach',
        timezone: 'Africa/Nairobi',
        isActive: false,
        slotMinutes: 30,
        members: [{ membershipId: danaId, weight: 1, locations: [] }],
        weeklyHours: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          startTime: '08:00',
          endTime: '17:00',
        })),
      }),
    ]);
  });

test('"Advanced settings" opens the editor with what was typed', async ({ page }) => {
  const api = await fakeCalendarSettingsApi(page);
  await page.goto(inHarbor('/settings/calendars'));
  await page.getByRole('button', { name: 'New calendar', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose calendar type', exact: true });
  await chooser.getByRole('button', { name: /^Round robin/ }).click();
  const modal = page.getByRole('dialog', { name: 'New calendar', exact: true });
  await modal.getByLabel('Calendar name', { exact: true }).fill('Sales calls');
  await modal.getByRole('button', { name: 'Add description', exact: true }).click();
  await modal.getByLabel('Description', { exact: true }).fill('Every Tuesday.');
  await modal.getByRole('button', { name: 'Advanced settings', exact: true }).click();

  await expect(page).toHaveURL(/\/settings\/calendars\/new\?type=round_robin$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Create', exact: true })).toBeVisible();
  await expect(page.getByLabel('Calendar name', { exact: true })).toHaveValue('Sales calls');
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Every Tuesday.');
  await expect(page.getByLabel('Custom URL', { exact: true })).toHaveValue('sales-calls');
  await expect(page.getByRole('combobox', { name: 'Calendar type', exact: true })).toContainText(
    'Round robin',
  );
  // Nothing to copy before it is saved, so no button for it.
  await expect(page.getByRole('button', { name: 'Copy the booking link' })).toHaveCount(0);
  expect(api.of('createCalendar')).toHaveLength(0);
  await expectAccessible(page);
  await save(page);
  await expect(status(page, 'Calendar created.')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/calendars\/cal_[0-9a-z]+$/);
  expect(createCalendarInput.parse(bodiesOf(api, 'createCalendar')[0])).toMatchObject({
    name: 'Sales calls',
    description: 'Every Tuesday.',
    kind: 'round_robin',
    isActive: false,
  });
});

test('a draft of a type that cannot take bookings yet still lists and opens, and says so', async ({
  page,
}) => {
  const api = await fakeCalendarSettingsApi(page, {
    configurations: [saved({ calendar: classes, members: [] })],
  });
  // An address that names such a type starts a personal calendar instead.
  await page.goto(inHarbor('/settings/calendars/new?type=class'));
  await expect(page.getByRole('combobox', { name: 'Calendar type', exact: true })).toContainText(
    'Personal booking',
  );
  await page.goto(inHarbor('/settings/calendars'));
  await expect(row(page, 'Dance class').getByRole('cell').nth(3)).toContainText(
    "Not bookable yet: this type can't take bookings yet.",
  );
  await row(page, 'Dance class').getByRole('link', { name: 'Dance class', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dance class' })).toBeVisible();
  await expect(
    main(page).getByText(
      "This type of calendar can't take bookings yet, so it stays a draft. To take bookings, change its type to Personal booking or Round robin.",
    ),
  ).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Active', exact: true })).toHaveCount(0);
  await expectAccessible(page);
  await choose(page.getByRole('combobox', { name: 'Calendar type', exact: true }), 'round_robin');
  await expect(page.getByRole('switch', { name: 'Active', exact: true })).toBeVisible();
  expect(api.of('updateCalendar')).toHaveLength(0);
});

for (const width of [390, 1280])
  test(`the editor saves every section's fields, at ${String(width)}px`, async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width, height: 900 });
    const api = await fakeCalendarSettingsApi(page, {
      configurations: [saved({ calendar: { ...consultation, kind: 'round_robin' } })],
      groups: ['Sales'],
    });
    await page.goto(editorOf(consultation.id));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Consultation', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('tab')).toHaveText([
      'Basic details',
      'Staff & location',
      'Availability',
      'Booking rules',
    ]);

    // Basic details.
    await expect(page.getByRole('heading', { level: 2, name: 'Basic details' })).toBeVisible();
    await page.getByLabel('Calendar logo', { exact: true }).setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('logo'),
    });
    await expect(
      page.getByRole('img', { name: 'Calendar logo preview', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Calendar name', { exact: true }).fill('First consultation');
    await page.getByLabel('Description', { exact: true }).fill('Thirty minutes with us.');
    await page.getByLabel('Custom URL', { exact: true }).fill('first-consultation');
    await choose(page.getByLabel('Group', { exact: true }), await groupId(api, 'Sales'));
    await page.getByLabel('Meeting invite title', { exact: true }).fill('Call with ');
    await page.getByRole('button', { name: 'Insert a merge field', exact: true }).click();
    await page.getByRole('menuitem', { name: '{{contact.firstName}}', exact: true }).click();
    await expect(page.getByLabel('Meeting invite title', { exact: true })).toHaveValue(
      'Call with {{contact.firstName}}',
    );
    await page.getByLabel('Time zone', { exact: true }).fill('Europe/Paris');
    await expectAccessible(page);

    // Staff & location.
    await section(page, 'Staff & location', 'Staff & meeting location');
    await choose(
      page.getByRole('combobox', { name: 'Select staff & assign meeting location', exact: true }),
      [danaId, leeId],
    );
    await page.getByLabel('Booking weight for Lee Park', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Add location for Dana Brooks', exact: true }).click();
    await choose(
      page.getByRole('combobox', {
        name: 'Kind of meeting location 1 of Dana Brooks',
        exact: true,
      }),
      'address',
    );
    await page.getByLabel('Meeting location 1 of Dana Brooks', { exact: true }).fill('1 Pier Road');
    await page
      .getByRole('button', {
        name: 'Add display label to meeting location 1 of Dana Brooks',
        exact: true,
      })
      .click();
    await page
      .getByLabel('Display label of meeting location 1 of Dana Brooks', { exact: true })
      .fill('Office');
    await expectAccessible(page);

    // Availability.
    await section(page, 'Availability', 'Availability schedule');
    const booking = page.getByRole('region', { name: 'Booking availability', exact: true });
    await expect(booking.getByRole('listitem')).toHaveText([
      'DBDana BrooksMon, 9:00 AM to 5:00 PM',
      'LPLee ParkMon, 9:00 AM to 5:00 PM',
    ]);
    await choose(page.getByLabel('Day', { exact: true }), '2');
    await page.getByLabel('Start time', { exact: true }).fill('10:00');
    await page.getByRole('button', { name: 'Add date override', exact: true }).click();
    await page.getByLabel('Override date', { exact: true }).fill('2026-12-25');
    await page.getByRole('button', { name: 'Add date override', exact: true }).click();
    await page.getByLabel('Override date', { exact: true }).nth(1).fill('2027-01-01');
    await page.getByRole('button', { name: 'Add override hours', exact: true }).nth(1).click();
    await page.getByLabel('Override start time', { exact: true }).fill('10:00');
    await page.getByLabel('Override end time', { exact: true }).fill('12:00');
    await expectAccessible(page);

    // Booking rules.
    await section(page, 'Booking rules');
    await page.getByLabel('Meeting interval', { exact: true }).fill('15');
    await page.getByLabel('Meeting duration', { exact: true }).fill('1');
    await choose(
      page.getByRole('combobox', { name: 'Unit of Meeting duration', exact: true }),
      'hours',
    );
    await page.getByRole('button', { name: 'Add another duration', exact: true }).click();
    await page.getByLabel('Meeting duration 2', { exact: true }).fill('45');
    await page.getByLabel('Minimum scheduling notice', { exact: true }).fill('2');
    await choose(
      page.getByRole('combobox', { name: 'Unit of Minimum scheduling notice', exact: true }),
      'days',
    );
    await page.getByLabel('Date range', { exact: true }).fill('30');
    await page.getByRole('switch', { name: 'Count available days only', exact: true }).click();
    await page.getByLabel('Pre buffer time', { exact: true }).fill('10');
    await page.getByLabel('Post buffer time', { exact: true }).fill('5');
    await page.getByLabel('Maximum bookings per day', { exact: true }).fill('8');
    // Empty means one booking for each free host; a number caps each start time.
    await page.getByLabel('Maximum bookings per slot', { exact: true }).fill('2');
    await page.getByRole('switch', { name: 'Look busy', exact: true }).click();
    await page.getByLabel('Look busy percentage', { exact: true }).fill('25');
    await expectAccessible(page);

    // Advanced settings.
    const advanced = page.getByRole('button', { name: 'Advanced settings', exact: true });
    await expect(advanced).toHaveAttribute('aria-expanded', 'false');
    await advanced.click();
    await expect(page.getByRole('tab')).toHaveText([
      'Basic details',
      'Staff & location',
      'Availability',
      'Booking rules',
      'Confirmation consent',
      'Notifications & policies',
      'Widget appearance',
    ]);
    // No Integrations button, Payments or Booking channels: nothing behind them here.
    await expect(page.getByRole('button', { name: 'Integrations' })).toHaveCount(0);

    await section(page, 'Confirmation consent');
    await expect(page.getByRole('switch', { name: 'Consent checkbox', exact: true })).toBeChecked();
    await page.getByLabel('Consent wording', { exact: true }).fill('I agree.');
    await expectAccessible(page);

    await section(page, 'Notifications & policies', 'Notifications');
    await choose(page.getByLabel('Confirmation sender', { exact: true }), senderId);
    await page
      .getByRole('switch', {
        name: 'Skip assigning Contact if the Contact has already an assigned user.',
        exact: true,
      })
      .click();
    await page.getByLabel('Rescheduling link will expire', { exact: true }).fill('2');
    await choose(
      page.getByRole('combobox', { name: 'Unit of Rescheduling link will expire', exact: true }),
      'hours',
    );
    await page.getByRole('switch', { name: 'Allow cancellation of meeting', exact: true }).click();
    await expect(page.getByLabel('Cancellation link will expire', { exact: true })).toBeDisabled();
    await expectAccessible(page);

    await section(page, 'Widget appearance', 'Customizations');
    // Drawn on the booking page: nothing says it isn't.
    await expect(main(page).getByText(/doesn't draw/)).toHaveCount(0);
    await page.getByLabel('Calendar cover image', { exact: true }).setInputFiles({
      name: 'cover.png',
      mimeType: 'image/png',
      buffer: Buffer.from('cover'),
    });
    await expect(
      page.getByRole('img', { name: 'Calendar cover image preview', exact: true }),
    ).toBeVisible();
    // Uploaded into Media Storage and given a public address, so the page can show it.
    await expect(
      main(page).getByText(
        "Shown on the booking page. It's in Media Storage, at an address anyone can open.",
      ),
    ).toHaveCount(2);
    expect(api.of('uploadFile').map((call) => call.query?.['library'])).toEqual(['true', 'true']);
    expect(bodiesOf(api, 'updateMediaFile')).toEqual([{ public: true }, { public: true }]);
    await page.getByLabel('Primary color', { exact: true }).fill('#0F766E');
    await page.getByLabel('Background color', { exact: true }).fill('#fffbeb');
    await page.getByLabel('Button text', { exact: true }).fill('Book now');
    await expectAccessible(page);
    // Classic keeps the standard colours and words, as GoHighLevel's does.
    await page.getByRole('radio', { name: 'Classic', exact: true }).check();
    await expect(page.getByLabel('Primary color', { exact: true })).toHaveCount(0);
    await expect(
      main(page).getByText(
        'The classic widget keeps the standard colours and button text. Choose Neo to set your own.',
      ),
    ).toBeVisible();
    await expectAccessible(page);

    await save(page);
    await expect(status(page, 'Changes saved.')).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1, name: 'First consultation', exact: true }),
    ).toBeVisible();
    // The team, places and hours go first, then the settings on the revision that gave.
    expect(
      api.calls
        .filter((call) => call.operation.startsWith('updateCalendar'))
        .map((call) => call.operation),
    ).toEqual(['updateCalendarAvailability', 'updateCalendar']);
    expect(
      updateCalendarAvailabilityInput.parse(bodiesOf(api, 'updateCalendarAvailability')[0]),
    ).toEqual({
      members: [
        {
          membershipId: danaId,
          weight: 1,
          locations: [{ kind: 'address', value: '1 Pier Road', label: 'Office' }],
        },
        { membershipId: leeId, weight: 2, locations: [] },
      ],
      weeklyHours: [{ weekday: 2, startTime: '10:00', endTime: '17:00' }],
      dateOverrides: [
        { date: '2026-12-25', ranges: [] },
        { date: '2027-01-01', ranges: [{ startTime: '10:00', endTime: '12:00' }] },
      ],
      revision: '1'.padStart(64, '0'),
    });
    const settings = updateCalendarInput.parse(bodiesOf(api, 'updateCalendar')[0]);
    expect(settings).toMatchObject({
      name: 'First consultation',
      description: 'Thirty minutes with us.',
      kind: 'round_robin',
      bookingSlug: 'first-consultation',
      timezone: 'Europe/Paris',
      inviteTitle: 'Call with {{contact.firstName}}',
      groupId: await groupId(api, 'Sales'),
      slotIntervalMinutes: 15,
      slotMinutes: 60,
      extraDurationMinutes: [45],
      minNoticeMinutes: 2880,
      maxDaysAhead: 30,
      countAvailableDaysOnly: true,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 5,
      maxPerDay: 8,
      maxPerSlot: 2,
      lookBusyPercent: 25,
      consentEnabled: true,
      consentText: 'I agree.',
      confirmationSenderId: senderId,
      assignContactToMember: true,
      skipAssignIfOwned: true,
      allowReschedule: true,
      rescheduleCutoffMinutes: 120,
      allowCancel: false,
      cancelCutoffMinutes: null,
      widgetStyle: 'classic',
      primaryColor: '#0f766e',
      backgroundColor: '#fffbeb',
      buttonText: 'Book now',
      revision: '2'.padStart(64, '0'),
    });
    expect(settings.logoFileId).toMatch(/^file_/);
    expect(settings.coverFileId).toMatch(/^file_/);
  });

for (const width of [390, 1280])
  test(`shows and saves hours that run until midnight, and says when a member has left, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fakeCalendarSettingsApi(page, {
      configurations: [
        saved({
          // One member is still on the team; the other has left it.
          members: [
            { membershipId: danaId, weight: 1, locations: [] },
            { membershipId: null, weight: 1, locations: [] },
          ],
          weeklyHours: [{ weekday: 5, startTime: '18:00', endTime: '24:00' }],
          dateOverrides: [
            { date: '2026-12-31', ranges: [{ startTime: '20:00', endTime: '22:00' }] },
          ],
        }),
      ],
    });
    await page.goto(editorOf(consultation.id));
    await section(page, 'Staff & location', 'Staff & meeting location');
    await expect(
      main(page).getByText('Someone on this calendar is no longer on the business team.'),
    ).toBeVisible();
    await section(page, 'Availability', 'Availability schedule');

    // Saved midnight hours come back as the ticked box, with no end time to type.
    const weekly = page.getByRole('checkbox', { name: 'Open until midnight', exact: true });
    await expect(weekly).toBeChecked();
    await expect(page.getByLabel('End time', { exact: true })).toBeDisabled();
    // Unticking asks for an end again; ticking by keyboard gives midnight back.
    await weekly.uncheck();
    await expect(page.getByLabel('End time', { exact: true })).toHaveValue('23:59');
    await weekly.focus();
    await page.keyboard.press('Space');
    await expect(weekly).toBeChecked();

    const override = page.getByRole('checkbox', {
      name: 'Override open until midnight',
      exact: true,
    });
    await expect(override).not.toBeChecked();
    await expect(page.getByLabel('Override end time', { exact: true })).toHaveValue('22:00');
    await override.check();
    await expect(page.getByLabel('Override end time', { exact: true })).toBeDisabled();
    await expectAccessible(page);
    await save(page);
    await expect(status(page, 'Changes saved.')).toBeVisible();
    // The member who left is not sent back; the hours end at 24:00, not a minute before.
    expect(bodiesOf(api, 'updateCalendarAvailability')).toEqual([
      {
        members: [{ membershipId: danaId, weight: 1, locations: [] }],
        weeklyHours: [{ weekday: 5, startTime: '18:00', endTime: '24:00' }],
        dateOverrides: [{ date: '2026-12-31', ranges: [{ startTime: '20:00', endTime: '24:00' }] }],
        revision: '1'.padStart(64, '0'),
      },
    ]);
  });

test('offers Google Meet only to a member whose Google Calendar is connected', async ({ page }) => {
  await fakeCalendarSettingsApi(page, {
    configurations: [
      saved({
        members: [
          {
            membershipId: danaId,
            weight: 1,
            locations: [{ kind: 'google_meet', value: 'Google Meet', label: null }],
          },
          { membershipId: leeId, weight: 1, locations: [] },
        ],
      }),
    ],
  });
  // Dana's Google Calendar was connected and is now disconnected; Lee never connected one.
  await page.route('**/api/v1/integrations/google', (route) =>
    route.fulfill({
      json: {
        available: true,
        mine: null,
        team: [
          {
            membershipId: danaId,
            status: 'disconnected',
            disconnectedReason: 'expired_or_revoked',
            busyCheckedAt: null,
            busyFailing: false,
          },
        ],
      },
    }),
  );
  await page.goto(editorOf(consultation.id));
  await section(page, 'Staff & location', 'Staff & meeting location');
  await expect(
    main(page).getByText(
      "Dana Brooks's Google Calendar isn't connected, so no Meet can be made: bookings get their next location instead, or none.",
    ),
  ).toBeVisible();
  await expect(
    main(page).getByText(/Google Meet becomes a choice once Lee Park connects/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add location for Lee Park', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Kind of meeting location 1 of Lee Park', exact: true })
    .click();
  await expect(page.getByRole('option', { name: 'Address', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Google Meet', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expectAccessible(page);
});

test('preserves a stale editor draft and reloads only when requested', async ({ page }) => {
  const api = await fakeCalendarSettingsApi(page, { configurations: [saved()] });
  await page.goto(inHarbor('/settings/calendars'));
  await row(page, 'Consultation').getByRole('link', { name: 'Consultation', exact: true }).click();
  await page.getByLabel('Calendar name', { exact: true }).fill('Unsaved tour');
  api.touch(consultation.id, { name: 'Remote edit' });
  await save(page);
  await expect(main(page).getByRole('alert')).toContainText(
    'Calendar changed since you opened it.',
  );
  await expect(page.getByLabel('Calendar name', { exact: true })).toHaveValue('Unsaved tour');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Reload saved calendar', exact: true }).click();
  await expect(status(page, 'Calendar reloaded.')).toBeVisible();
  await expect(page.getByLabel('Calendar name', { exact: true })).toHaveValue('Remote edit');
  await expect(main(page).getByRole('alert')).toHaveCount(0);
});

test('lets someone without the permission look at calendars without changing them', async ({
  page,
}) => {
  const api = await fakeCalendarSettingsApi(page, {
    configurations: [saved()],
    groups: ['Sales'],
    canManage: false,
  });
  await page.goto(inHarbor('/settings/calendars'));
  await expect(row(page, 'Consultation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New calendar', exact: true })).toHaveCount(0);
  await expect(rail(page).getByRole('button', { name: 'New group', exact: true })).toHaveCount(0);
  // The row's menu offers only the embed code, which is theirs to copy.
  await row(page, 'Consultation').getByRole('button', { name: 'Actions for Consultation' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Embed code']);
  await page.keyboard.press('Escape');
  // The booking link is still theirs to copy, so the table keeps its Actions column.
  await expect(main(page).getByRole('columnheader')).toHaveCount(7);
  await row(page, 'Consultation').getByRole('link', { name: 'View Consultation' }).click();

  await expect(page.getByLabel('Calendar name', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Active', exact: true })).toBeDisabled();
  await section(page, 'Staff & location', 'Staff & meeting location');
  await expect(
    page.getByRole('combobox', { name: 'Select staff & assign meeting location', exact: true }),
  ).toBeDisabled();
  await section(page, 'Availability', 'Availability schedule');
  await expect(page.getByLabel('Start time', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add opening hours', exact: true })).toBeDisabled();
  await expectAccessible(page);
  expect(api.of('getCalendarUserAvailability')).toHaveLength(0);
  await page.getByRole('link', { name: 'Back to calendars list', exact: true }).click();
  await expect(row(page, 'Consultation')).toBeVisible();
});

test.describe('at 1920 px', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('the calendars list uses the whole width beside the settings list', async ({ page }) => {
    await fakeCalendarSettingsApi(page, { calendars: [tours, tastings] });
    await page.goto(inHarbor('/settings/calendars'));
    await expect(page.getByRole('table')).toBeVisible();
    expect(
      await reachesRightGutter(page, page.getByRole('region', { name: 'Calendars', exact: true })),
    ).toBe(true);
  });
});
