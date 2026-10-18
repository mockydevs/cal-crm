import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { connectMailboxInput, type ConnectMailboxInput, type Mailbox } from '@repo/contracts';
import { harbor, inHarbor, signedIn } from './session';

for (const width of [360, 1280]) {
  test(`email discovers servers, explains a failed sign-in and connects after retry at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await signedIn(page);
    let mailboxes: Mailbox[] = [];
    let submitted: ConnectMailboxInput | undefined;
    let tests = 0;
    const attemptId = 'mtry_01k8e2wzr0e008000000000001';
    const mailboxId = 'mbx_01k8e2wzr0e008000000000001';
    const createdAt = '2026-10-09T00:00:00.000Z';
    await page.route('**/api/v1/mailboxes', (route) =>
      route.fulfill({ json: { data: mailboxes } }),
    );
    await page.route('**/api/v1/mailboxes/*/setup', (route) => route.fulfill({ json: null }));
    await page.route('**/api/v1/mailboxes/discovery', (route) =>
      route.fulfill({
        json: {
          domain: 'gmail.com',
          detectedProvider: 'google',
          authentication: 'app_password_or_oauth',
          warnings: [],
          smtp: {
            host: 'smtp.gmail.com',
            port: 465,
            security: 'tls',
            source: 'provider',
            requiresConfirmation: false,
          },
          imap: {
            host: 'imap.gmail.com',
            port: 993,
            security: 'tls',
            source: 'provider',
            requiresConfirmation: false,
          },
        },
      }),
    );
    await page.route('**/api/v1/mailbox-connection-attempts', async (route) => {
      expect(route.request().headers()['business-id']).toBe(harbor.id);
      submitted = connectMailboxInput.parse(route.request().postDataJSON());
      tests += 1;
      await route.fulfill({
        status: 201,
        json: { id: attemptId, createdAt, status: 'pending', mailboxId: null, result: null },
      });
    });
    await page.route(`**/api/v1/mailbox-connection-attempts/${attemptId}`, async (route) => {
      if (tests === 1) {
        await route.fulfill({
          json: {
            id: attemptId,
            createdAt,
            status: 'failed',
            mailboxId: null,
            failure: 'connection_failed',
            result: {
              smtp: { status: 'pass', code: 'connected', port: 465 },
              imap: { status: 'fail', code: 'authentication', port: 993 },
            },
          },
        });
        return;
      }
      if (submitted === undefined) throw new Error('No connection request.');
      const { password: _smtpPassword, ...smtp } = submitted.smtp;
      const { password: _imapPassword, ...imap } = submitted.imap;
      mailboxes = [
        {
          id: mailboxId,
          createdAt,
          email: submitted.email,
          name: submitted.name,
          displayName: submitted.displayName,
          smtp,
          imap,
          status: 'active',
        },
      ];
      await route.fulfill({
        json: {
          id: attemptId,
          createdAt,
          status: 'connected',
          mailboxId,
          result: {
            smtp: { status: 'pass', code: 'connected', port: 465 },
            imap: { status: 'pass', code: 'connected', port: 993 },
          },
        },
      });
    });
    await page.goto(inHarbor('/settings/email'));
    await expect(page.getByRole('heading', { name: 'Email Services', exact: true })).toBeVisible({
      timeout: 5000,
    });
    await page.getByRole('button', { name: 'Add a mailbox', exact: true }).click();
    await page.getByLabel('Email address', { exact: true }).fill('dana@gmail.com');
    await page.getByRole('button', { name: 'Find server settings' }).click();
    const smtp = page.getByRole('group', { name: 'SMTP', exact: true });
    const imap = page.getByRole('group', { name: 'IMAP', exact: true });
    await expect(smtp.getByLabel('Server', { exact: true })).toHaveValue('smtp.gmail.com');
    await expect(imap.getByLabel('Server', { exact: true })).toHaveValue('imap.gmail.com');
    await page.getByLabel('Mailbox name', { exact: true }).fill('Work');
    await smtp.getByLabel('Password or app password').fill('fixture-app-password');
    await imap.getByLabel('Password or app password').fill('fixture-app-password');
    await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
    await expect(page.getByText('IMAP: The server rejected the password.')).toBeVisible();
    expect(mailboxes).toEqual([]);
    await expect(smtp.getByLabel('Password or app password')).toHaveValue('');
    await smtp.getByLabel('Password or app password').fill('correct-fixture-password');
    await imap.getByLabel('Password or app password').fill('correct-fixture-password');
    await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
    await expect(page.getByText('Mailbox connected.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();
    expect(submitted).toMatchObject({
      email: 'dana@gmail.com',
      smtp: { host: 'smtp.gmail.com', username: 'dana@gmail.com' },
    });
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
    await page.screenshot({ path: testInfo.outputPath('email-connected.png'), fullPage: true });
  });
}

test('requires confirmation for a guessed mail server before sending credentials', async ({
  page,
}) => {
  await signedIn(page);
  await page.route('**/api/v1/mailboxes', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/v1/mailboxes/discovery', (route) =>
    route.fulfill({
      json: {
        domain: 'example.test',
        detectedProvider: null,
        authentication: 'password',
        warnings: [],
        smtp: {
          host: 'mx.provider.test',
          port: 587,
          security: 'starttls',
          source: 'mx',
          requiresConfirmation: true,
        },
        imap: {
          host: 'mx.provider.test',
          port: 993,
          security: 'tls',
          source: 'mx',
          requiresConfirmation: true,
        },
      },
    }),
  );
  await page.goto(inHarbor('/settings/email'));
  await page.getByRole('button', { name: 'Add a mailbox', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill('person@example.test');
  await page.getByRole('button', { name: 'Find server settings' }).click();
  await expect(page.getByRole('button', { name: 'Test and connect' })).toBeDisabled();
  await page
    .getByRole('checkbox', { name: 'I confirmed these suggested servers with my provider.' })
    .check();
  await expect(page.getByRole('button', { name: 'Test and connect' })).toBeEnabled();
  await page.getByLabel('Email address', { exact: true }).fill('someone@other.test');
  await expect(
    page.getByRole('checkbox', { name: 'I confirmed these suggested servers with my provider.' }),
  ).toHaveCount(0);
});

test('shows the permission refusal without exposing connection controls', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/v1/mailboxes', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      json: {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Mailbox management is not granted.',
      },
    }),
  );
  await page.goto(inHarbor('/settings/email'));
  await expect(page.getByText('You need permission to manage mailboxes.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Add a mailbox' })).toHaveCount(0);
});
