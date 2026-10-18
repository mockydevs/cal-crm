import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mailboxSendingInput, type MailboxSendingSettings } from '@repo/contracts';
import { harbor, inHarbor, signedIn } from './session';

for (const width of [360, 1280]) {
  test(`mailbox sending limits save, survive reload and explain a provider pause at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    const mailboxId = 'mbx_01k8e2wzr0e008000000000001';
    await page.route('**/api/v1/mailboxes', (route) =>
      route.fulfill({
        json: {
          data: [
            {
              id: mailboxId,
              name: 'Work',
              email: 'dana@harborlights.example',
              displayName: 'Dana',
              status: 'active',
              createdAt: '2026-10-09T00:00:00.000Z',
              smtp: { host: 'mail.example.test', port: 465, security: 'tls', username: 'dana' },
              imap: { host: 'mail.example.test', port: 993, security: 'tls', username: 'dana' },
            },
          ],
        },
      }),
    );
    await page.route('**/api/v1/mailboxes/*/setup', (route) => route.fulfill({ json: null }));
    let settings: MailboxSendingSettings = {
      dailyLimit: 300,
      pacingPerMinute: 5,
      warmupEnabled: true,
      useForConversations: true,
      useForCampaigns: false,
      effectiveAutomatedDailyLimit: 50,
      warmupStartedAt: '2026-10-09T00:00:00.000Z',
      pausedUntil: '2099-01-01T12:00:00.000Z',
      pauseReason: 'provider_temporary',
    };
    let saved = 0;
    let refusals = 1;
    await page.route('**/api/v1/mailboxes/*/sending', async (route) => {
      expect(route.request().headers()['business-id']).toBe(harbor.id);
      if (route.request().method() === 'PUT') {
        const input = mailboxSendingInput.parse(route.request().postDataJSON());
        if (refusals > 0) {
          refusals -= 1;
          await route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Service unavailable',
              status: 503,
              detail: 'Sending settings are temporarily unavailable.',
            },
          });
          return;
        }
        settings = {
          ...settings,
          ...input,
          effectiveAutomatedDailyLimit: input.warmupEnabled ? 50 : input.dailyLimit,
        };
        saved += 1;
      }
      await route.fulfill({ json: settings });
    });
    await page.goto(inHarbor('/settings/email'));
    const form = page.getByRole('group', { name: 'Sending limits', exact: true });
    await expect(form.getByLabel('Daily cap', { exact: true })).toHaveValue('300');
    await expect(page.getByText('Your provider temporarily refused a send.')).toBeVisible();
    await form.getByLabel('Daily cap', { exact: true }).fill('80');
    await form.getByLabel('Messages per minute', { exact: true }).fill('2');
    await form.getByLabel('Warm up automated sending').uncheck();
    await form.getByLabel('Use for campaigns').check();
    await form.getByLabel('Use for conversations').uncheck();
    await form.getByRole('button', { name: 'Save sending settings' }).focus();
    await page.keyboard.press('Enter');
    await expect(form.getByRole('alert')).toHaveText(
      'Sending settings are temporarily unavailable.',
    );
    await expect(form.getByLabel('Daily cap', { exact: true })).toHaveValue('80');
    expect(saved).toBe(0);
    await form.getByRole('button', { name: 'Save sending settings' }).focus();
    await page.keyboard.press('Enter');
    await expect(form.getByRole('status')).toHaveText('Sending settings saved.');
    expect(saved).toBe(1);
    expect(settings).toMatchObject({
      dailyLimit: 80,
      pacingPerMinute: 2,
      warmupEnabled: false,
      useForConversations: false,
      useForCampaigns: true,
      pauseReason: 'provider_temporary',
    });
    await page.reload();
    await expect(form.getByLabel('Daily cap', { exact: true })).toHaveValue('80');
    await expect(form.getByLabel('Warm up automated sending')).not.toBeChecked();
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
    await page.screenshot({
      path: testInfo.outputPath(`sending-${String(width)}.png`),
      fullPage: true,
    });
  });
}
