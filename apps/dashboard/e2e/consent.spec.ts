// Consent on the contact page and quiet hours in Settings. The API is stood in for, as in
// the other specs: what the server enforces is tested against Postgres in
// packages/modules/messaging.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  consentChannels,
  consentPurposes,
  recordConsentInput,
  updateMessagingSettingsInput,
  type ConsentChange,
  type ConsentState,
  type ContactConsent,
  type MessagingSettings,
} from '@repo/contracts';
import { emptyContactPanels } from './contact-panels';
import { harbor, inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

const id = 'con_01m4bd188ff82s0add91b7pz63';
const at = '2026-10-08T12:00:00.000Z';
const noProof = {
  note: null,
  wording: null,
  keyword: null,
  ipAddress: null,
  pageUrl: null,
  linked: null,
};

function consentOf(
  states: Readonly<Record<string, ConsentState['status']>>,
  patch: Partial<ContactConsent> = {},
): ContactConsent {
  return {
    canManage: true,
    doNotContact: false,
    timeZone: 'Africa/Nairobi',
    current: consentChannels.flatMap((channel) =>
      consentPurposes.map((purpose): ConsentState => {
        const status = states[`${channel}:${purpose}`] ?? 'unknown';
        return {
          channel,
          purpose,
          status,
          source: status === 'unknown' ? null : 'user',
          recordedAt: status === 'unknown' ? null : at,
        };
      }),
    ),
    suppressions: [],
    history: [],
    historyTruncated: false,
    ...patch,
  };
}

async function contactPage(page: Page, canManage = true): Promise<void> {
  await emptyContactPanels(page);
  await page.route(`**/api/v1/contacts/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: 'Maya Thompson',
        emails: ['maya@example.com'],
        phones: [{ number: '+254712345678', display: '0712 345678' }],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        canManage,
      },
    }),
  );
  await page.route(`**/api/v1/records/${id}/tags`, (route) =>
    route.fulfill({ json: { items: [], canManage: false } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
}

const noOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const width of [360, 1440]) {
  test(`records and withdraws consent with proof from the keyboard at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    await contactPage(page);
    let consent = consentOf({ 'email:marketing': 'granted' });
    const recorded: unknown[] = [];
    let refusals = 1;
    await page.route(`**/api/v1/contacts/${id}/consent`, async (route) => {
      expect(route.request().headers()['business-id']).toBe(harbor.id);
      if (route.request().method() === 'POST') {
        const input = recordConsentInput.parse(route.request().postDataJSON());
        if (refusals > 0) {
          refusals -= 1;
          await route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Service unavailable',
              status: 503,
              detail: 'Consent is temporarily unavailable.',
            },
          });
          return;
        }
        recorded.push(input);
        const change: ConsentChange = {
          channel: input.channel,
          purpose: input.purpose,
          status: input.status,
          source: 'user',
          recordedAt: at,
          recordedBy: { kind: 'user', name: 'Dana Brooks', you: true },
          proof: { ...noProof, note: input.note },
        };
        consent = {
          ...consentOf({
            ...Object.fromEntries(
              consent.current.map((state) => [`${state.channel}:${state.purpose}`, state.status]),
            ),
            [`${input.channel}:${input.purpose}`]: input.status,
          }),
          history: [change, ...consent.history],
        };
        await route.fulfill({ status: 201, json: consent });
        return;
      }
      await route.fulfill({ json: consent });
    });
    await page.goto(inHarbor(`/contacts/${id}?tab=dnd`));
    const panel = page.getByRole('region', { name: 'Consent', exact: true });
    const email = panel.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: 'Marketing email', exact: true }),
    });
    await expect(email.getByText('Consent given')).toBeVisible();
    await expect(email.getByText('These can be sent.')).toBeVisible();
    const texts = panel.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: 'Marketing texts', exact: true }),
    });
    await expect(texts.getByText('No consent recorded')).toBeVisible();
    await expect(
      panel.getByText('No consent changes have been recorded for this contact.'),
    ).toBeVisible();

    // Record consent for texts: the note is required, and a failed save keeps it.
    await panel.getByRole('button', { name: 'Record consent for Marketing texts' }).focus();
    await page.keyboard.press('Enter');
    const form = panel.getByRole('group', { name: 'Record consent for Marketing texts' });
    const note = form.getByLabel('How do you know?');
    await expect(note).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(form.getByText('Say how you know, in at least 10 characters.')).toBeVisible();
    await note.fill('Asked by phone on 9 October to get offers by text.');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(form.getByRole('alert')).toHaveText('Consent is temporarily unavailable.');
    await expect(note).toHaveValue('Asked by phone on 9 October to get offers by text.');
    expect(recorded).toEqual([]);
    await form.getByRole('button', { name: 'Save' }).focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toHaveText('Consent recorded for Marketing texts.');
    await expect(texts.getByText('Consent given')).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Withdraw consent for Marketing texts' }),
    ).toBeFocused();
    expect(recorded).toEqual([
      {
        channel: 'sms',
        purpose: 'marketing',
        status: 'granted',
        note: 'Asked by phone on 9 October to get offers by text.',
        replacesWithdrawal: false,
      },
    ]);

    // Withdraw the email consent, then give it again: that needs the confirmation.
    await panel.getByRole('button', { name: 'Withdraw consent for Marketing email' }).click();
    await panel.getByLabel('How do you know?').fill('Emailed asking to stop the newsletter.');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByRole('status')).toHaveText('Withdrawal recorded for Marketing email.');
    await expect(email.getByText('Consent withdrawn')).toBeVisible();
    await expect(email.getByText("These aren't sent.")).toBeVisible();
    await panel.getByRole('button', { name: 'Record consent for Marketing email' }).click();
    await panel.getByLabel('How do you know?').fill('Asked in person to rejoin the newsletter.');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(
      panel.getByText('Confirm that the contact asked to get these messages again.'),
    ).toBeVisible();
    expect(recorded).toHaveLength(2);
    await panel
      .getByRole('checkbox', { name: /I confirm they asked to get these messages again/ })
      .check();
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(email.getByText('Consent given')).toBeVisible();
    expect(recorded.at(-1)).toMatchObject({ status: 'granted', replacesWithdrawal: true });

    // Every change is in the history with its note.
    await panel.getByText('History and proof (3)').click();
    await expect(panel.getByText('Note: Asked in person to rejoin the newsletter.')).toBeVisible();
    await expect(panel.getByText('Note: Emailed asking to stop the newsletter.')).toBeVisible();
    await expect(panel.getByText(/Recorded by You/).first()).toBeVisible();

    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`consent-${String(width)}.png`),
      fullPage: true,
    });
  });
}

test('shows what blocks sending, and no way to change consent without the permission', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 950 });
  await signedIn(page);
  await contactPage(page, false);
  let posts = 0;
  await page.route(`**/api/v1/contacts/${id}/consent`, async (route) => {
    if (route.request().method() === 'POST') posts += 1;
    await route.fulfill({
      json: consentOf(
        { 'email:marketing': 'granted', 'sms:marketing': 'withdrawn' },
        {
          canManage: false,
          doNotContact: true,
          timeZone: null,
          suppressions: [
            {
              channel: 'email',
              address: 'a-very-long-address-that-must-wrap-on-a-phone@subdomain.example.com',
              reason: 'hard_bounce',
              since: at,
              until: null,
            },
          ],
          history: [
            {
              channel: 'sms',
              purpose: 'marketing',
              status: 'withdrawn',
              source: 'keyword',
              recordedAt: at,
              recordedBy: { kind: 'contact', name: null, you: false },
              proof: { ...noProof, keyword: 'STOP', linked: 'message' },
            },
          ],
        },
      ),
    });
  });
  await page.goto(inHarbor(`/contacts/${id}?tab=dnd`));
  const panel = page.getByRole('region', { name: 'Consent', exact: true });
  await expect(panel.getByText(/Do not contact is on\./)).toBeVisible();
  await expect(panel.getByText(/can't be sent to: a message to it bounced\./)).toBeVisible();
  await expect(panel.getByText(/This contact has no time zone\./)).toBeVisible();
  await expect(panel.getByText("These aren't sent: do not contact is on.").first()).toBeVisible();
  await expect(panel.getByRole('button', { name: /consent/i })).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await panel.getByText('History and proof (1)').focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Keyword: STOP')).toBeVisible();
  await expect(panel.getByText('Kept with the message it came from.')).toBeVisible();
  expect(posts).toBe(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(await noOverflow(page)).toBe(true);
});

const settingsOf = (patch: Partial<MessagingSettings> = {}): MessagingSettings => ({
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
  contactDailyLimit: 10,
  revision: 'a'.repeat(64),
  canManage: true,
  heldMessages: 2,
  contactsWithoutTimeZone: 5,
  ...patch,
});

async function emailSettings(page: Page): Promise<void> {
  await page.route('**/api/v1/mailboxes', (route) => route.fulfill({ json: { data: [] } }));
}

for (const width of [360, 1440]) {
  test(`quiet hours save, refuse a stale save and survive reload at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    await emailSettings(page);
    let settings = settingsOf();
    let saved = 0;
    let stale = true;
    await page.route('**/api/v1/messaging-settings', async (route) => {
      expect(route.request().headers()['business-id']).toBe(harbor.id);
      if (route.request().method() === 'PUT') {
        const input = updateMessagingSettingsInput.parse(route.request().postDataJSON());
        if (stale) {
          // Someone else saved a limit of 25 first.
          stale = false;
          settings = settingsOf({ contactDailyLimit: 25, revision: 'b'.repeat(64) });
          await route.fulfill({
            status: 409,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              detail:
                'These settings changed after you opened them. Reload the page and try again.',
            },
          });
          return;
        }
        expect(input.revision).toBe(settings.revision);
        const { revision: _based, ...values } = input;
        settings = settingsOf({ ...values, revision: 'c'.repeat(64) });
        saved += 1;
      }
      await route.fulfill({ json: settings });
    });
    await page.goto(inHarbor('/settings/email'));
    const section = page.getByRole('region', { name: 'Quiet hours', exact: true });
    await expect(section.getByLabel('Quiet hours start')).toHaveValue('21:00');
    await expect(
      section.getByText('Messages wait from 21:00 until 08:00 the next morning.'),
    ).toBeVisible();
    await expect(section.getByText('2 messages are waiting for quiet hours to end.')).toBeVisible();
    // A contact with no zone of its own keeps the business's zone.
    await expect(
      section.getByText(
        "5 contacts have no time zone of their own. Their workflow and campaign messages keep quiet hours by the business's time zone.",
      ),
    ).toBeVisible();

    // The same start and end is refused before anything is sent.
    await section.getByLabel('Quiet hours start').fill('08:00');
    await section.getByRole('button', { name: 'Save quiet hours' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      section.getByText("Quiet hours can't start and end at the same time."),
    ).toBeVisible();

    await section.getByLabel('Quiet hours start').fill('22:30');
    await section.getByLabel('Quiet hours end').fill('07:00');
    await section.getByRole('button', { name: 'Save quiet hours' }).focus();
    await page.keyboard.press('Enter');
    await expect(section.getByRole('alert')).toContainText(
      'Someone else changed these settings while you had them open.',
    );
    await expect(section.getByLabel('Messages per contact in 24 hours')).toHaveValue('25');
    expect(saved).toBe(0);

    await section.getByLabel('Quiet hours start').fill('22:30');
    await section.getByLabel('Quiet hours end').fill('07:00');
    await section.getByLabel('Messages per contact in 24 hours').fill('4');
    await section.getByRole('button', { name: 'Save quiet hours' }).focus();
    await page.keyboard.press('Enter');
    await expect(section.getByRole('status')).toHaveText('Quiet hours saved.');
    expect(saved).toBe(1);
    expect(settings).toMatchObject({
      quietHoursEnabled: true,
      quietHoursStart: '22:30',
      quietHoursEnd: '07:00',
      contactDailyLimit: 4,
    });
    await page.reload();
    await expect(section.getByLabel('Quiet hours start')).toHaveValue('22:30');
    await expect(section.getByLabel('Messages per contact in 24 hours')).toHaveValue('4');

    // Off: the times no longer matter and messages go at any hour.
    await section.getByLabel('Hold messages during quiet hours').uncheck();
    await expect(
      section.getByText('Quiet hours are off: messages can go out at any time.'),
    ).toBeVisible();
    await expect(section.getByLabel('Quiet hours start')).toBeDisabled();

    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`quiet-hours-${String(width)}.png`),
      fullPage: true,
    });
  });
}

test('quiet hours are read-only for a role that cannot change them', async ({ page }) => {
  await signedIn(page);
  await emailSettings(page);
  let puts = 0;
  await page.route('**/api/v1/messaging-settings', async (route) => {
    if (route.request().method() === 'PUT') puts += 1;
    await route.fulfill({ json: settingsOf({ canManage: false }) });
  });
  await page.goto(inHarbor('/settings/email'));
  const section = page.getByRole('region', { name: 'Quiet hours', exact: true });
  await expect(section.getByLabel('Quiet hours start')).toBeDisabled();
  await expect(section.getByLabel('Messages per contact in 24 hours')).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Save quiet hours' })).toHaveCount(0);
  await expect(
    section.getByText("You can see these settings, but your role can't change them."),
  ).toBeVisible();
  expect(puts).toBe(0);
});
