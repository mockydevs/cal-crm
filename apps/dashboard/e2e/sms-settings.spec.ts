import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type {
  ConnectSmsInput,
  PhoneNumber,
  RegisterPhoneNumberInput,
  SmsConnection,
} from '@repo/contracts';
import { grant } from './phone-system-fixtures';
import { harbor, inHarbor, signedIn as signedInToBusiness } from './session';

/** Someone whose role manages SMS and not calls (phone-system.spec.ts covers calls). */
async function signedIn(page: Page): Promise<void> {
  await signedInToBusiness(page);
  await grant(page, ['sms.manage']);
}

const attemptId = 'smst_01k8e2wzr0e008000000000001';
const connectionId = 'smsc_01k8e2wzr0e008000000000001';
const createdAt = '2026-10-09T00:00:00.000Z';

for (const width of [360, 1280]) {
  test(`connects Twilio, discloses the webhook URL once and registers a number at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    let connections: SmsConnection[] = [];
    let registered: PhoneNumber[] = [];
    let submitted: ConnectSmsInput | undefined;
    let registeredInput: RegisterPhoneNumberInput | undefined;
    await page.route('**/api/v1/sms-connections', (route) =>
      route.fulfill({ json: { data: connections, unavailable: null } }),
    );
    await page.route(`**/api/v1/sms-connections/${connectionId}/numbers`, (route) =>
      route.fulfill({
        json: {
          data: [
            {
              providerNumberRef: 'PN00000000000000000000000000000001',
              e164: '+15551234567',
              friendlyName: 'Main line',
              capabilities: ['sms', 'mms'],
              registeredAs: null,
              seenAt: createdAt,
            },
          ],
        },
      }),
    );
    await page.route('**/api/v1/phone-numbers', async (route) => {
      if (route.request().method() === 'POST') {
        registeredInput = JSON.parse(
          route.request().postData() ?? '{}',
        ) as RegisterPhoneNumberInput;
        registered = [
          {
            id: 'phn_01k8e2wzr0e008000000000001',
            name: registeredInput.name,
            e164: '+15551234567',
            connectionId,
            capabilities: ['sms', 'mms'],
            status: 'active',
            createdAt,
          },
        ];
        await route.fulfill({
          status: 201,
          json: {
            id: 'phn_01k8e2wzr0e008000000000001',
            name: registeredInput.name,
            e164: '+15551234567',
            connectionId,
            capabilities: ['sms', 'mms'],
            status: 'active',
            createdAt,
          },
        });
        return;
      }
      await route.fulfill({ json: { data: registered } });
    });
    await page.route('**/api/v1/sms-connection-attempts', async (route) => {
      expect(route.request().headers()['business-id']).toBe(harbor.id);
      submitted = JSON.parse(route.request().postData() ?? '{}') as ConnectSmsInput;
      await route.fulfill({
        status: 201,
        json: {
          attempt: {
            id: attemptId,
            createdAt,
            status: 'pending',
            connectionId: null,
            result: null,
          },
          inboundWebhookUrl: 'https://crm.example/webhooks/twilio/tok_once',
        },
      });
    });
    await page.route(`**/api/v1/sms-connection-attempts/${attemptId}`, async (route) => {
      connections = [
        {
          id: connectionId,
          provider: 'twilio',
          label: submitted?.label ?? '',
          accountSid: submitted?.accountSid ?? '',
          status: 'connected',
          accountType: 'full',
          accountStatus: 'active',
          warnings: [],
          lastCheckedAt: createdAt,
          createdAt,
        },
      ];
      await route.fulfill({
        json: {
          id: attemptId,
          createdAt,
          status: 'connected',
          connectionId,
          result: {
            accountType: 'full',
            accountStatus: 'active',
            subaccount: false,
            numbersFound: 1,
          },
        },
      });
    });
    await page.goto(inHarbor('/settings/sms'));
    await expect(page.getByRole('heading', { name: 'Phone System', exact: true })).toBeVisible({
      timeout: 5000,
    });
    await page.getByRole('button', { name: 'Connect Twilio', exact: true }).click();
    await page.getByLabel('Label', { exact: true }).fill('Front desk');
    await page
      .getByLabel('Account SID', { exact: true })
      .fill('AC00000000000000000000000000000001');
    await page.getByLabel('Auth Token', { exact: true }).fill('fixture-auth-token');
    await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
    await expect(page.getByText('Twilio connected.', { exact: true })).toBeVisible();
    await expect(
      page.getByText('https://crm.example/webhooks/twilio/tok_once', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Front desk', exact: true })).toBeVisible();
    await page.getByText('Numbers from Twilio', { exact: true }).click();
    await expect(page.getByText('+15551234567').first()).toBeVisible();
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Front line');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText('Registered phone numbers', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading').filter({ hasText: 'Front line' })).toHaveCount(0);
    await expect(page.getByText('Front line', { exact: true })).toBeVisible();
    expect(registeredInput).toMatchObject({ connectionId, name: 'Front line' });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('sms-connected.png'), fullPage: true });
  });
}

test('shows the permission refusal without exposing connection controls', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/v1/sms-connections', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      json: {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'SMS management is not granted.',
      },
    }),
  );
  await page.goto(inHarbor('/settings/sms'));
  await expect(page.getByText('You need permission to manage SMS.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Connect Twilio' })).toHaveCount(0);
});

test('explains a failed Twilio connection and keeps the account SID typed', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/v1/sms-connections', (route) =>
    route.fulfill({ json: { data: [], unavailable: null } }),
  );
  await page.route('**/api/v1/sms-connection-attempts', (route) =>
    route.fulfill({
      status: 201,
      json: {
        attempt: { id: attemptId, createdAt, status: 'pending', connectionId: null, result: null },
        inboundWebhookUrl: null,
      },
    }),
  );
  await page.route(`**/api/v1/sms-connection-attempts/${attemptId}`, (route) =>
    route.fulfill({
      json: {
        id: attemptId,
        createdAt,
        status: 'failed',
        connectionId: null,
        failure: 'authentication',
        result: null,
      },
    }),
  );
  await page.goto(inHarbor('/settings/sms'));
  await page.getByRole('button', { name: 'Connect Twilio', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Front desk');
  await page.getByLabel('Account SID', { exact: true }).fill('AC00000000000000000000000000000001');
  await page.getByLabel('Auth Token', { exact: true }).fill('wrong-token');
  await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
  await expect(page.getByText('Twilio rejected the Account SID or token.')).toBeVisible();
  await expect(page.getByLabel('Account SID', { exact: true })).toHaveValue(
    'AC00000000000000000000000000000001',
  );
});

for (const width of [360, 1280]) {
  test(`says why text messages are unavailable on an install without a secure public address at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    await page.route('**/api/v1/sms-connections', (route) =>
      route.fulfill({
        json: {
          data: [],
          unavailable: {
            code: 'public_address_unsuitable',
            message: "The server's own sentence, which the page does not show.",
          },
        },
      }),
    );
    await page.route('**/api/v1/phone-numbers', (route) => route.fulfill({ json: { data: [] } }));
    await page.goto(inHarbor('/settings/sms'));
    await expect(page.getByRole('heading', { name: 'Phone System', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const notice = page.getByRole('alert').filter({ hasText: "can't be sent or received" });
    await expect(notice).toHaveText(
      "Text messages can't be sent or received on this install yet. Twilio reports deliveries and incoming messages to the install's public address, and it only reports to a secure one: an https address with no underscore in its name. Ask whoever runs this install to set its public address (PUBLIC_URL) to one. You can still connect an account and register numbers now; they will start working once the address is set.",
    );
    await expect(page.getByText("The server's own sentence")).toHaveCount(0);
    // Connecting is still offered: the account can be made ready before the address is.
    await expect(page.getByRole('button', { name: 'Connect Twilio', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((each) => each.impact === 'serious' || each.impact === 'critical'),
    ).toEqual([]);
  });
}
