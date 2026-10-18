// A contact's time zone and do-not-contact setting on the contact page. The API is stood
// in for, as in the other specs: what the server enforces is tested against Postgres in
// packages/modules/crm and packages/modules/messaging.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { consentChannels, consentPurposes, type ContactConsent } from '@repo/contracts';
import * as z from 'zod';
import { emptyContactPanels } from './contact-panels';
import { harbor, inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

const id = 'con_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';
const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
const third = 'c'.repeat(64);

interface Settings {
  timeZone: string | null;
  doNotContact: boolean;
  preferencesRevision: string;
}

// What the panel may send: the settings and their revision, and nothing else of the contact.
const sent = z.strictObject({
  timeZone: z.string().nullable().optional(),
  doNotContact: z.boolean().optional(),
  doNotContactReason: z.string().min(10).max(1000).optional(),
  preferencesRevision: z.string().regex(/^[0-9a-f]{64}$/),
});
type Sent = z.infer<typeof sent>;

const contactOf = (settings: Settings, canManage: boolean): Record<string, unknown> => ({
  id,
  firstName: 'Maya',
  lastName: 'Thompson',
  name: 'Maya Thompson',
  emails: ['maya@example.com'],
  phones: [{ number: '+254712345678', display: '0712 345678' }],
  ...settings,
  createdAt: at,
  updatedAt: at,
  trashedAt: null,
  canManage,
});

const consentOf = (settings: Settings): ContactConsent => ({
  canManage: true,
  doNotContact: settings.doNotContact,
  timeZone: settings.timeZone,
  current: consentChannels.flatMap((channel) =>
    consentPurposes.map((purpose) => ({
      channel,
      purpose,
      status: 'unknown' as const,
      source: null,
      recordedAt: null,
    })),
  ),
  suppressions: [],
  history: [],
  historyTruncated: false,
});

/**
 * The contact page over a server that keeps one contact's settings. A change based on an
 * old revision is refused with a conflict, as the contact command refuses it.
 */
async function contactPage(
  page: Page,
  start: Settings,
  canManage = true,
): Promise<{ changes: Sent[]; refusals: () => number; set: (next: Settings) => void }> {
  let settings = start;
  let refused = 0;
  const changes: Sent[] = [];
  const revisions = [second, third];
  await emptyContactPanels(page);
  await page.route(`**/api/v1/contacts/${id}`, async (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    if (route.request().method() !== 'PATCH') {
      await route.fulfill({ json: contactOf(settings, canManage) });
      return;
    }
    const change = sent.parse(route.request().postDataJSON());
    if (change.preferencesRevision !== settings.preferencesRevision) {
      refused += 1;
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        json: {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail:
            "This contact's time zone or do not contact setting changed after you opened it. Reload the page and try again.",
        },
      });
      return;
    }
    changes.push(change);
    settings = {
      timeZone: change.timeZone === undefined ? settings.timeZone : change.timeZone,
      doNotContact: change.doNotContact ?? settings.doNotContact,
      preferencesRevision: revisions.shift() ?? first,
    };
    await route.fulfill({ json: contactOf(settings, canManage) });
  });
  // The server's own list of zones: here, every zone this runtime knows.
  await page.route('**/api/v1/time-zones', (route) =>
    route.fulfill({ json: { items: [...Intl.supportedValuesOf('timeZone'), 'UTC'].sort() } }),
  );
  await page.route(`**/api/v1/contacts/${id}/consent`, (route) =>
    route.fulfill({ json: consentOf(settings) }),
  );
  await page.route(`**/api/v1/records/${id}/tags`, (route) =>
    route.fulfill({ json: { items: [], canManage: false } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  return {
    changes,
    refusals: () => refused,
    set: (next) => {
      settings = next;
    },
  };
}

const noOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const reason = 'Asked by phone on 9 October not to be contacted.';

for (const width of [360, 1440]) {
  test(`sets a time zone and turns do not contact on from the keyboard at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const server = await contactPage(page, {
      timeZone: null,
      doNotContact: false,
      preferencesRevision: first,
    });
    await page.goto(inHarbor(`/contacts/${id}?tab=dnd`));
    const panel = page.getByRole('region', { name: 'Time zone and do not contact', exact: true });
    await expect(panel.getByText(/This contact has no time zone\./)).toBeVisible();
    await expect(panel.getByText('Off', { exact: true })).toBeVisible();

    // The time zone: search about four hundred zones, choose with Enter, save with Enter.
    await panel.getByRole('button', { name: 'Set time zone' }).focus();
    await page.keyboard.press('Enter');
    const box = panel.getByRole('combobox', { name: 'Time zone' });
    await expect(box).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    // The list fills as it opens, so its length is asked for until it is all there.
    await expect.poll(() => list.getByRole('option').count()).toBeGreaterThan(300);
    await page.keyboard.type('east africa nairobi');
    await expect(list.getByRole('option')).toHaveCount(1);
    await expect(list.getByRole('option')).toContainText('Africa/Nairobi');
    await expect(list.getByRole('option')).toContainText('East Africa Time');
    // The list stays inside the window, on a phone too.
    expect(await noOverflow(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(list).toBeHidden();
    await expect(box).toHaveValue('Africa/Nairobi');
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('Time zone saved.');
    await expect(panel.getByRole('button', { name: 'Change time zone' })).toBeFocused();
    await expect(panel.getByText('Africa/Nairobi', { exact: true })).toBeVisible();
    await expect(panel.getByText(/East Africa Time/)).toBeVisible();
    expect(server.changes).toEqual([{ timeZone: 'Africa/Nairobi', preferencesRevision: first }]);

    // Do not contact: a reason and a confirmation, or nothing is sent.
    await panel.getByRole('button', { name: 'Turn on do not contact' }).focus();
    await page.keyboard.press('Enter');
    const form = panel.getByRole('group', { name: 'Turn on do not contact' });
    const why = form.getByLabel('Why?');
    await expect(why).toBeFocused();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByText('Say why, in at least 10 characters.')).toBeVisible();
    await why.fill(reason);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByRole('alert')).toHaveText(
      'Confirm that no messages should be sent to this contact.',
    );
    expect(server.changes).toHaveLength(1);
    await why.focus();
    await page.keyboard.press('Tab');
    await expect(form.getByRole('checkbox')).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('Do not contact is on.');
    await expect(panel.getByRole('button', { name: 'Turn off do not contact' })).toBeFocused();
    await expect(panel.getByText('On', { exact: true })).toBeVisible();
    expect(server.changes.at(-1)).toEqual({
      doNotContact: true,
      doNotContactReason: reason,
      preferencesRevision: second,
    });
    // The consent panel below reads the same contact again and says the same.
    await expect(
      page
        .getByRole('region', { name: 'Consent', exact: true })
        .getByText(/Do not contact is on\./),
    ).toBeVisible();

    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`contact-preferences-${String(width)}.png`),
      fullPage: true,
    });
  });
}

test("doesn't write over a change someone else made while the form was open", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 950 });
  await signedIn(page);
  const server = await contactPage(page, {
    timeZone: 'Africa/Nairobi',
    doNotContact: false,
    preferencesRevision: first,
  });
  await page.goto(inHarbor(`/contacts/${id}?tab=dnd`));
  const panel = page.getByRole('region', { name: 'Time zone and do not contact', exact: true });
  await panel.getByRole('button', { name: 'Turn on do not contact' }).click();
  await panel.getByLabel('Why?').fill(reason);
  await panel.getByRole('checkbox').check();
  // Meanwhile someone else moves the contact to London.
  server.set({ timeZone: 'Europe/London', doNotContact: false, preferencesRevision: second });
  await panel.getByRole('button', { name: 'Save' }).click();

  await expect(panel.getByRole('alert')).toContainText(
    "Someone else changed this contact while you had it open, so your change wasn't saved.",
  );
  await expect(panel.getByRole('alert')).toContainText(
    'The latest is shown here: make your change again.',
  );
  await expect(panel.getByText('Europe/London', { exact: true })).toBeVisible();
  await expect(panel.getByText('Off', { exact: true })).toBeVisible();
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  expect(server.refusals()).toBe(1);
  expect(server.changes).toEqual([]);

  // Asked again from what is shown now, it is saved.
  await panel.getByRole('button', { name: 'Turn on do not contact' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByLabel('Why?').fill(reason);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('status')).toHaveText('Do not contact is on.');
  expect(server.changes).toEqual([
    { doNotContact: true, doNotContactReason: reason, preferencesRevision: second },
  ]);
  expect(await noOverflow(page)).toBe(true);
});

test('removes a time zone, and shows the settings without a way to change them to a role that may not', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 950 });
  await signedIn(page);
  const server = await contactPage(page, {
    timeZone: 'America/New_York',
    doNotContact: true,
    preferencesRevision: first,
  });
  await page.goto(inHarbor(`/contacts/${id}?tab=dnd`));
  const panel = page.getByRole('region', { name: 'Time zone and do not contact', exact: true });
  await expect(panel.getByText('America/New York', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Change time zone' }).click();
  const box = panel.getByRole('combobox', { name: 'Time zone' });
  await expect(box).toHaveValue('America/New York');
  await panel.getByRole('button', { name: 'Clear time zone' }).click();
  await expect(box).toHaveValue('');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('status')).toHaveText('Time zone removed.');
  await expect(panel.getByText(/This contact has no time zone\./)).toBeVisible();
  expect(server.changes).toEqual([{ timeZone: null, preferencesRevision: first }]);

  const reader = await page.context().newPage();
  await reader.setViewportSize({ width: 360, height: 950 });
  await signedIn(reader);
  const untouched = await contactPage(
    reader,
    { timeZone: 'America/New_York', doNotContact: true, preferencesRevision: first },
    false,
  );
  await reader.goto(inHarbor(`/contacts/${id}?tab=dnd`));
  const shown = reader.getByRole('region', { name: 'Time zone and do not contact', exact: true });
  await expect(shown.getByText('America/New York', { exact: true })).toBeVisible();
  await expect(shown.getByText('On', { exact: true })).toBeVisible();
  await expect(shown.getByRole('button')).toHaveCount(0);
  await expect(shown.getByRole('combobox')).toHaveCount(0);
  expect(untouched.changes).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page: reader })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
});
