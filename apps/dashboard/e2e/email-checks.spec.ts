import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Mailbox, MailboxSetup, MailboxSetupCheck } from '@repo/contracts';
import { harbor, inHarbor, signedIn } from './session';

const id = 'mbx_01k8e2wzr0e008000000000001';
const startedAt = '2026-10-09T00:00:00.000Z';
const login = {
  host: 'mail.example.test',
  port: 465,
  security: 'tls',
  username: 'dana@example.test',
} as const;
const mailbox: Mailbox = {
  id,
  name: 'Work',
  email: 'dana@example.test',
  displayName: 'Dana',
  status: 'active',
  createdAt: startedAt,
  smtp: login,
  imap: { ...login, port: 993 },
};

function report(dmarcFixed: boolean): MailboxSetup {
  const checks: MailboxSetupCheck[] = (
    [
      ['connection', 0],
      ['encryption', 10],
      ['spf', 15],
      ['dkim', 20],
      ['dmarc', 14],
      ['dmarc_enforcement', 4],
      ['reverse_dns', 10],
      ['mx', 6],
      ['blocklists', 15],
      ['unsubscribe', 6],
    ] as const
  ).map(([key, pointsPossible]) => {
    const fail =
      key === 'encryption' || key === 'dmarc_enforcement' || (key === 'dmarc' && !dmarcFixed);
    return {
      key,
      status: fail ? 'fail' : 'pass',
      reason: fail ? 'no_record' : 'verified',
      pointsPossible,
      pointsAwarded: fail ? 0 : pointsPossible,
      ...(key === 'dmarc' && !dmarcFixed
        ? {
            fix: {
              kind: 'record' as const,
              type: 'TXT' as const,
              name: '_dmarc.example.test',
              value: 'v=DMARC1; p=none',
            },
          }
        : {}),
    };
  });
  return {
    mailboxId: id,
    state: 'finished',
    method: 'check_mailbox',
    trigger: 'manual',
    startedAt,
    finishedAt: '2026-10-09T00:00:02.000Z',
    score: dmarcFixed ? 86 : 72,
    checks,
  };
}

for (const width of [360, 1280]) {
  test(`The Dashboard links a mailbox regression to its setup at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    await page.route('**/api/v1/mailbox-setup-alerts', (route) =>
      route.fulfill({
        json: {
          data: [{ mailboxId: id, name: 'Work', checkKey: 'mx', failedAt: startedAt }],
          hasMore: false,
        },
      }),
    );
    await page.route('**/api/v1/mailboxes', (route) =>
      route.fulfill({ json: { data: [mailbox] } }),
    );
    await page.route(`**/api/v1/mailboxes/${id}/setup`, (route) =>
      route.fulfill({ json: report(false) }),
    );
    await page.goto(inHarbor('/'));
    await expect(
      page.getByRole('heading', { name: 'Mailbox needs attention', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Work: Receiving mail needs attention' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Email Services', exact: true })).toBeVisible();
    await expect(page.getByRole('meter', { name: 'Mailbox setup score' })).toHaveAttribute(
      'value',
      '72',
    );
  });
  test(`email setup shows exact fixes and checks again from 72 to 86 at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    let current = report(false);
    let pending = false;
    await page.route('**/api/v1/mailboxes', (route) =>
      route.fulfill({ json: { data: [mailbox] } }),
    );
    const waiting: MailboxSetup = {
      mailboxId: id,
      state: 'pending',
      method: 'self',
      trigger: 'manual',
      startedAt,
      finishedAt: null,
      score: null,
      checks: [],
    };
    await page.route(`**/api/v1/mailboxes/${id}/setup`, (route) =>
      route.fulfill({ json: pending ? waiting : current }),
    );
    await page.route(`**/api/v1/mailboxes/${id}/checks`, async (route) => {
      expect(route.request().headers()['business-id']).toBe(harbor.id);
      expect(route.request().postData()).toBeNull();
      pending = true;
      await route.fulfill({ status: 201, json: waiting });
    });
    await page.goto(inHarbor('/settings/email'));
    const score = page.getByRole('meter', { name: 'Mailbox setup score' });
    await expect(score).toHaveAttribute('value', '72');
    await expect(page.getByText('_dmarc.example.test', { exact: true })).toBeVisible();
    await expect(page.getByText('v=DMARC1; p=none', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Copy DMARC record value' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('v=DMARC1; p=none');
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        value: () => Promise.reject(new DOMException('Fixture refusal.', 'NotAllowedError')),
      });
    });
    await page.getByRole('button', { name: 'Copy DMARC record value' }).click();
    await expect(
      page.getByRole('status').filter({
        hasText: 'Copying didn’t work: select the value and copy it.',
      }),
    ).toBeVisible();
    const check = page.getByRole('button', { name: 'Check again', exact: true });
    await check.focus();
    await page.keyboard.press('Enter');
    await expect(check).toBeDisabled();
    await expect(page.getByText('Checking mailbox setup…', { exact: true })).toBeVisible();
    current = report(true);
    pending = false;
    await expect(score).toHaveAttribute('value', '86');
    await expect(check).toBeEnabled();
    await page.reload();
    await expect(score).toHaveAttribute('value', '86');
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
    await page.screenshot({ path: testInfo.outputPath('email-setup-score.png'), fullPage: true });
  });
}
