import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { address, asClient, inOurs } from '../servers.js';
import { newPerson, query, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.132'));

test('a refused mailbox shows both safe causes and saves no mailbox or pending credentials', async ({
  page,
}) => {
  const person = await newPerson();
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const email = `mailbox-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(inOurs('/settings/email'));
  await page.getByRole('button', { name: 'Add a mailbox', exact: true }).click();
  await page.getByLabel('Mailbox name', { exact: true }).fill('Refused fixture');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  for (const protocol of ['SMTP', 'IMAP']) {
    const group = page.getByRole('group', { name: protocol, exact: true });
    await group.getByLabel('Server', { exact: true }).fill('127.0.0.1');
    await group.getByLabel('Username', { exact: true }).fill('fixture-user');
    await group.getByLabel('Password or app password').fill('fixture-only-password');
  }
  await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
  for (const protocol of ['SMTP', 'IMAP']) {
    await expect(
      page.getByText(
        `${protocol}: This server address is not allowed. Use your provider's public mail server.`,
      ),
    ).toBeVisible();
    await expect(
      page
        .getByRole('group', { name: protocol, exact: true })
        .getByLabel('Password or app password'),
    ).toHaveValue('');
  }
  const attempts = await query<{ status: string; failure_code: string; secret_id: string | null }>(
    'select status, failure_code, secret_id from messaging.mailbox_connection_attempts where email_address=$1',
    [email],
  );
  expect(attempts).toEqual([
    { status: 'failed', failure_code: 'connection_failed', secret_id: null },
  ]);
  expect(await query('select id from messaging.mailboxes where email_address=$1', [email])).toEqual(
    [],
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add a mailbox', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Refused fixture', exact: true })).toHaveCount(0);
});
