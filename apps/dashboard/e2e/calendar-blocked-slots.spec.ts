// Calendars → Calendar view: blocked slots and the business's time zone, against a stand-in
// for the API that answers as the server does. The browser runs in Los Angeles while the
// business is in Nairobi: everything on screen is Nairobi's.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  blockedSlot,
  blockedSlotInput,
  updateBlockedSlotInput,
  type BlockedSlot,
  type CalendarEvent,
} from '@repo/contracts';
import { danaId, fakeCalendarApi, now, tour, zone } from './calendar-fixtures';
import { choose } from './select';
import { dana, harbor, inHarbor, signedIn } from './session';

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(results.violations).toEqual([]);
}
const day = (page: Page, name: string): Locator => page.getByRole('group', { name, exact: true });

// A browser far from the business: what it shows must not follow this zone.
test.use({ timezoneId: 'America/Los_Angeles' });

/** The blocked slots the stand-in keeps, and what each call was sent. */
interface BlockedApi {
  readonly slots: BlockedSlot[];
  readonly sent: { create: unknown[]; update: unknown[]; remove: string[] };
}

async function fakeBlockedSlots(page: Page): Promise<BlockedApi> {
  const api: BlockedApi = { slots: [], sent: { create: [], update: [], remove: [] } };
  const calendarApi = await fakeCalendarApi(page, [tour]);
  // The events, with the blocked slots as they are now; registered after the stand-in's
  // own, so it answers first.
  await page.route(/\/api\/v1\/calendars\/events\?/, (route) => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    calendarApi.reads.push(query);
    const blocks: CalendarEvent[] = api.slots.map((slot) => ({
      kind: 'blocked',
      id: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      user:
        slot.member === null
          ? null
          : { membershipId: slot.member.membershipId, you: true, name: dana.name },
      calendar: slot.calendar,
      title: slot.title,
    }));
    return route.fulfill({
      json: { items: [tour, ...blocks], truncated: false, canManage: true },
    });
  });
  let made = 0;
  await page.route(/\/api\/v1\/calendars\/blocked-slots(?:\/[^?]*)?$/, async (route) => {
    const request = route.request();
    const id = /blocked-slots\/([^/?]+)/.exec(request.url())?.[1];
    const index = api.slots.findIndex((each) => each.id === id);
    if (request.method() === 'POST') {
      const body = blockedSlotInput.parse(request.postDataJSON());
      api.sent.create.push(body);
      made += 1;
      const slot = blockedSlot.parse({
        id: `blk_01h455vb4pex5vsknk084sn0${String(made).padStart(2, '0')}`,
        member: { membershipId: body.membershipId, you: true, name: dana.name },
        calendar: null,
        title: body.title,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        revision: 'e'.repeat(64),
      });
      api.slots.push(slot);
      return route.fulfill({ status: 201, json: slot });
    }
    const found = api.slots[index];
    if (found === undefined) return route.fulfill({ status: 404, json: {} });
    if (request.method() === 'GET') return route.fulfill({ json: found });
    if (request.method() === 'PUT') {
      const body = updateBlockedSlotInput.parse(request.postDataJSON());
      api.sent.update.push(body);
      const changed = { ...found, title: body.title, startsAt: body.startsAt, endsAt: body.endsAt };
      api.slots[index] = changed;
      return route.fulfill({ json: changed });
    }
    api.sent.remove.push(found.id);
    api.slots.splice(index, 1);
    return route.fulfill({ status: 204 });
  });
  return api;
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(now);
  await signedIn(
    page,
    dana,
    {},
    { agencyStaff: false, businesses: [{ ...harbor, timezone: zone }] },
  );
});

for (const width of [1440, 360]) {
  test(`blocks time from New, opens it on the calendar, and removes it, in the business's zone, at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await fakeBlockedSlots(page);
    await page.goto(inHarbor('/calendar'));

    // Nine in Nairobi, where the business is, though the browser is in Los Angeles.
    const wednesday = day(page, 'Wednesday, October 14, 2026');
    await expect(wednesday.getByRole('button', { name: /^Venue tour, / })).toContainText('9:00 AM');
    await expect(page.getByText(zone, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Blocked slot', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New blocked slot', exact: true });
    await form.getByLabel('Title', { exact: true }).fill('Staff training');
    await choose(form.getByLabel('Team member', { exact: true }), danaId);
    await form.getByLabel(`Starts (${zone})`, { exact: true }).fill('2026-10-15T09:00');
    await form.getByLabel(`Ends (${zone})`, { exact: true }).fill('2026-10-15T11:30');
    await expectNoAccessibilityViolations(page);
    await testInfo.attach(`new-blocked-slot-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await form.getByRole('button', { name: 'Block time', exact: true }).click();
    await expect(page.getByText('Blocked slot added.')).toBeVisible();
    // Typed by Nairobi's clock (UTC+3), not the browser's.
    expect(api.sent.create).toEqual([
      {
        title: 'Staff training',
        membershipId: danaId,
        calendarId: null,
        startsAt: '2026-10-15T06:00:00.000Z',
        endsAt: '2026-10-15T08:30:00.000Z',
      },
    ]);

    // It is on the calendar, where it was put; pressing it says whose it is and opens it.
    const thursday = day(page, 'Thursday, October 15, 2026');
    const block = thursday.getByRole('button', { name: /^Blocked slot, / });
    await expect(block).toContainText('Staff training');
    await block.click();
    const details = page.getByRole('dialog', { name: 'Blocked slot', exact: true });
    await expect(details.getByText('All their calendars', { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit blocked slot', exact: true });
    await expect(edit.getByLabel(`Starts (${zone})`, { exact: true })).toHaveValue(
      '2026-10-15T09:00',
    );
    await edit.getByRole('button', { name: 'Delete', exact: true }).click();
    await edit.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Blocked slot removed.')).toBeVisible();
    expect(api.sent.remove).toHaveLength(1);
    await expect(thursday.getByRole('button', { name: /^Blocked slot, / })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
