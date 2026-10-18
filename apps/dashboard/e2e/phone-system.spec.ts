import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  grant,
  lee,
  phoneSettings,
  revisions,
  standInPhoneSystem,
  voiceNumber,
  type PhoneSystemState,
} from './phone-system-fixtures';
import { inHarbor, signedIn } from './session';

const textLine = voiceNumber({
  id: 'phn_01k8e2wzr0e008000000000002',
  e164: '+12125550188',
  capabilities: ['sms', 'mms'],
  status: 'active',
  isDefault: false,
  name: 'Text line',
  ownerId: null,
  voice: null,
});

async function openPhoneSystem(page: Page, state: PhoneSystemState): Promise<void> {
  await signedIn(page);
  await grant(page, ['sms.manage', 'phone.manage']);
  await page.route('**/api/v1/sms-connections', (route) =>
    route.fulfill({ json: { data: [], unavailable: null } }),
  );
  await standInPhoneSystem(page, state);
  await page.goto(inHarbor('/settings/sms'));
  await expect(page.getByRole('heading', { name: 'Phone System', exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

const accessible = async (page: Page): Promise<void> => {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
};

const fitsWidth = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
};

for (const width of [360, 1280]) {
  test(`configures a number and the voice settings, and both are there after a reload at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const state: PhoneSystemState = {
      settings: phoneSettings(),
      numbers: [voiceNumber(), textLine],
      saves: [],
    };
    await openPhoneSystem(page, state);
    await expect(page.getByRole('heading', { name: "Calls aren't available yet" })).toBeVisible();
    await expect(page.getByText("The server's own sentence")).toHaveCount(0);
    const front = page.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: 'Front desk', level: 3 }),
    });
    await expect(front.getByText('Default', { exact: true })).toBeVisible();
    await expect(front.getByText('20 seconds')).toBeVisible();
    await accessible(page);
    await fitsWidth(page);

    await page.getByRole('searchbox', { name: 'Search numbers' }).fill('212 555');
    await expect(page.getByRole('heading', { name: 'Front desk', level: 3 })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Text line', level: 3 })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search numbers' }).fill('');

    await page.getByRole('button', { name: 'Edit configuration of Front desk' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit configuration' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Friendly name').fill('Main line');
    await dialog.getByRole('tab', { name: 'Call forwarding' }).click();
    await dialog.getByLabel('Second, an outside number').fill('+14155550177');
    await dialog.getByLabel('Ring for (seconds)').fill('30');
    await dialog.getByRole('switch', { name: 'Voicemail backup' }).click();
    await dialog.getByRole('tab', { name: 'Advanced settings' }).click();
    await dialog.getByRole('switch', { name: 'Whisper message' }).click();
    await dialog.getByLabel('Whisper', { exact: true }).fill('A call from the website.');
    await accessible(page);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Main line saved.')).toBeVisible();
    expect(state.saves[0]).toMatchObject({
      name: 'Main line',
      revision: revisions[0],
      voice: {
        routing: { forwardTo: '+14155550177', ringTimeoutSeconds: 30, voicemailBackup: false },
        advanced: { whisper: { enabled: true, message: 'A call from the website.' } },
      },
    });

    await page.getByRole('tab', { name: 'Voice settings' }).click();
    const voice = page.getByRole('form', { name: 'Voice settings' });
    await voice.getByLabel('Business fallback number').fill('+14155550100');
    await voice.getByRole('switch', { name: 'Text a caller back after a missed call' }).click();
    await voice.getByLabel('Text', { exact: true }).fill('Sorry we missed you.');
    await accessible(page);
    await fitsWidth(page);
    await voice.getByRole('button', { name: 'Save changes' }).click();
    await expect(voice.getByText('Settings saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Main line', level: 3 })).toBeVisible({
      timeout: 15_000,
    });
    const main = page.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: 'Main line', level: 3 }),
    });
    await expect(main.getByText('30 seconds')).toBeVisible();
    await expect(main.getByText('Dana Brooks').first()).toBeVisible();
    await page.getByRole('button', { name: 'Edit configuration of Main line' }).click();
    await dialog.getByRole('tab', { name: 'Call forwarding' }).click();
    await expect(dialog.getByLabel('Second, an outside number')).toHaveValue('+14155550177');
    await expect(dialog.getByLabel('Ring for (seconds)')).toHaveValue('30');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('tab', { name: 'Voice settings' }).click();
    await expect(voice.getByLabel('Business fallback number')).toHaveValue('+14155550100');
    await expect(voice.getByLabel('Text', { exact: true })).toHaveValue('Sorry we missed you.');
    await page.screenshot({ path: testInfo.outputPath('phone-system.png'), fullPage: true });
  });
}

test('recovers when someone else saved the number first', async ({ page }) => {
  const state: PhoneSystemState = {
    settings: phoneSettings(),
    numbers: [voiceNumber()],
    saves: [],
  };
  await openPhoneSystem(page, state);
  await page.getByRole('button', { name: 'Edit configuration of Front desk' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit configuration' });
  await expect(dialog.getByLabel('Friendly name')).toHaveValue('Front desk');
  // Someone else assigns the number to Lee meanwhile.
  state.numbers = [voiceNumber({ name: 'Reception', ownerId: lee, revision: revisions[1] })];
  await dialog.getByLabel('Friendly name').fill('Mine');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText(/changed since you opened them/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Reload number' }).click();
  await expect(dialog.getByLabel('Friendly name')).toHaveValue('Reception');
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await dialog.getByLabel('Friendly name').fill('Reception desk');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves.map((save) => save.revision)).toEqual([revisions[0], revisions[1]]);
  await expect(page.getByRole('heading', { name: 'Reception desk', level: 3 })).toBeVisible();
});

test('makes a number that takes calls the default, and says when its settings are newer', async ({
  page,
}) => {
  const sales = voiceNumber({
    id: 'phn_01k8e2wzr0e008000000000003',
    e164: '+14155550199',
    name: 'Sales',
    isDefault: false,
  });
  const state: PhoneSystemState = {
    settings: phoneSettings(),
    numbers: [voiceNumber(), sales, textLine],
    saves: [],
  };
  await openPhoneSystem(page, state);
  await expect(page.getByRole('button', { name: 'Make Text line the default number' })).toHaveCount(
    0,
  );
  // Someone else saves the voice settings first: the first try is refused and read again.
  state.settings = phoneSettings({ revision: revisions[1] });
  const readAgain = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/phone-system/settings') &&
      response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'Make Sales the default number' }).click();
  await expect(page.getByText(/The voice settings changed since they were loaded/)).toBeVisible();
  await readAgain;
  await page.getByRole('button', { name: 'Make Sales the default number' }).click();
  await expect(page.getByText('Sales is now the default number.')).toBeVisible();
  const salesRow = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: 'Sales', level: 3 }),
  });
  await expect(salesRow.getByText('Default', { exact: true })).toBeVisible();
  expect(state.settings.defaultNumberId).toBe(sales.id);
});

test('gives a role that manages only SMS its Twilio connection and registered numbers', async ({
  page,
}) => {
  await signedIn(page);
  await grant(page, ['sms.manage']);
  const asked: string[] = [];
  await page.route(/\/api\/v1\/(phone-system\/|team$)/, (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  await page.route('**/api/v1/sms-connections', (route) =>
    route.fulfill({ json: { data: [], unavailable: null } }),
  );
  await page.route('**/api/v1/phone-numbers', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'phn_01k8e2wzr0e008000000000001',
            name: 'Front desk',
            e164: '+14155550123',
            connectionId: 'smsc_01k8e2wzr0e008000000000001',
            capabilities: ['sms', 'mms'],
            status: 'active',
            createdAt: '2026-10-09T00:00:00.000Z',
          },
        ],
      },
    }),
  );
  await page.goto(inHarbor('/settings/sms'));
  await expect(page.getByRole('button', { name: 'Connect Twilio', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { name: 'Registered phone numbers' })).toBeVisible();
  await expect(page.getByText('Front desk', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Voice settings' })).toHaveCount(0);
  await accessible(page);
  expect(asked).toEqual([]);
});

test('gives a role that manages only calls no Twilio credentials', async ({ page }) => {
  const asked: string[] = [];
  // No SMS credentials, and no Team read: members come from the Phone System's own list.
  await page.route(/\/api\/v1\/(sms-connections|phone-numbers|team)$/, (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  await signedIn(page);
  await grant(page, ['phone.manage']);
  await standInPhoneSystem(page, {
    settings: phoneSettings(),
    numbers: [voiceNumber()],
    saves: [],
  });
  await page.goto(inHarbor('/settings/sms'));
  await expect(page.getByRole('heading', { name: 'Front desk', level: 3 })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Connecting a Twilio account and registering numbers/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Twilio' })).toHaveCount(0);
  await accessible(page);
  expect(asked).toEqual([]);
});
