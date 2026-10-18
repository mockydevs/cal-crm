// Settings → Calendars → Connections, against a faked API: connect Google, choose the
// linked and conflict calendars, see the team, and disconnect. Google itself is never
// reached: its consent page is answered here.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type {
  ChooseGoogleCalendarsInput,
  GoogleConnection,
  GoogleConnections,
} from '@repo/contracts';
import { inHarbor, signedIn } from './session';

const connected: GoogleConnection = {
  status: 'connected',
  disconnectedReason: null,
  email: 'dana@harborlights.example',
  linkedCalendarId: 'dana@harborlights.example',
  calendars: [
    {
      id: 'dana@harborlights.example',
      name: 'Dana',
      primary: true,
      accessRole: 'owner',
      checkConflicts: true,
    },
    { id: 'team', name: 'Team', primary: false, accessRole: 'writer', checkConflicts: false },
    {
      id: 'holidays',
      name: 'Holidays',
      primary: false,
      accessRole: 'reader',
      checkConflicts: false,
    },
  ],
  busyCheckedAt: new Date(Date.now() - 120_000).toISOString(),
  busyFailing: false,
  connectedAt: '2026-10-15T00:00:00.000Z',
};

for (const width of [360, 1280]) {
  test(`connects Google, chooses calendars and disconnects at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    let state: GoogleConnections = { available: true, mine: null, team: [] };
    let chosen: ChooseGoogleCalendarsInput | undefined;
    let disconnected = false;
    await page.route('**/api/v1/integrations/google', async (route) => {
      if (route.request().method() === 'DELETE') {
        disconnected = true;
        state = {
          ...state,
          mine:
            state.mine === null
              ? null
              : { ...state.mine, status: 'disconnected', disconnectedReason: 'member' },
        };
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ json: state });
    });
    await page.route('**/api/v1/integrations/google/connect', (route) =>
      route.fulfill({
        status: 201,
        json: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' },
      }),
    );
    // Google's consent page sends the browser back with the outcome, as the callback does.
    await page.route('https://accounts.google.com/**', (route) => {
      state = { ...state, mine: connected, team: [] };
      return route.fulfill({
        status: 302,
        headers: {
          location: new URL(
            inHarbor('/settings/calendars/connections?google=connected'),
            page.url(),
          ).href,
        },
      });
    });
    await page.route('**/api/v1/integrations/google/calendars', async (route) => {
      chosen = JSON.parse(route.request().postData() ?? '{}') as ChooseGoogleCalendarsInput;
      const mine: GoogleConnection = {
        ...connected,
        linkedCalendarId: chosen.linkedCalendarId,
        calendars: connected.calendars.map((calendar) => ({
          ...calendar,
          checkConflicts: chosen?.conflictCalendarIds.includes(calendar.id) ?? false,
        })),
      };
      state = { ...state, mine };
      return route.fulfill({ json: mine });
    });

    await page.goto(inHarbor('/settings/calendars/connections'));
    await expect(page.getByRole('link', { name: 'Connections' })).toBeVisible();
    await page.getByRole('button', { name: 'Connect Google' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Google Calendar is connected' }),
    ).toBeVisible();
    await expect(page.getByText('dana@harborlights.example')).toBeVisible();
    await expect(page.getByText(/Busy times read 2 minutes ago/)).toBeVisible();

    await page.getByRole('checkbox', { name: 'Holidays' }).check();
    await page.getByRole('combobox', { name: 'Linked calendar' }).click();
    await page.getByRole('option', { name: 'Team' }).click();
    // A reader-only calendar can't be linked.
    await expect(page.getByRole('option', { name: 'Holidays' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved. Your busy times are read again.')).toBeVisible();
    expect(chosen).toEqual({
      linkedCalendarId: 'team',
      conflictCalendarIds: ['dana@harborlights.example', 'holidays'],
    });

    const axe = await new AxeBuilder({ page }).analyze();
    await testInfo.attach('axe', { body: JSON.stringify(axe.violations, null, 2) });
    expect(axe.violations).toEqual([]);

    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('button', { name: 'Connect again' })).toBeVisible();
    await expect(
      page.getByText('You disconnected dana@harborlights.example.', { exact: false }),
    ).toBeVisible();
    expect(disconnected).toBe(true);
  });
}

test('hides Connections where the install has no Google client', async ({ page }) => {
  await signedIn(page);
  await page.goto(inHarbor('/settings/calendars/availability'));
  await expect(page.getByRole('link', { name: 'Availability' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connections' })).toHaveCount(0);
});

test('shows a manager each member’s status, and an expired connection to its member', async ({
  page,
}) => {
  await signedIn(page);
  await page.route('**/api/v1/integrations/google', (route) =>
    route.fulfill({
      json: {
        available: true,
        mine: { ...connected, status: 'disconnected', disconnectedReason: 'expired_or_revoked' },
        team: [
          {
            membershipId: 'mem_01k8e2wzr0e008000000000001',
            status: 'disconnected',
            disconnectedReason: 'expired_or_revoked',
            busyCheckedAt: null,
            busyFailing: false,
          },
        ],
      } satisfies GoogleConnections,
    }),
  );
  await page.goto(inHarbor('/settings/calendars/connections'));
  await expect(
    page.getByRole('alert').filter({ hasText: 'Google stopped accepting' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect again' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(
    table.getByText("Disconnected by Google: only this CRM's calendar is checked"),
  ).toBeVisible();
});
