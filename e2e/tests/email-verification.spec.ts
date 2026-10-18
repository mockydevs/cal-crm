// Email verification on the whole product, on an install of its own (global-setup.ts,
// "Verify day"): the built server with its worker and the built dashboard over a migrated
// Postgres. Nothing of the product is stood in for: the key is sealed by the app and
// opened by the worker, the check runs as a job through the email-checks adapter, and a
// reply goes through the reply command and the outbound pipeline.
//
// The world outside is local. Emailable is a stand-in on this machine
// (apps/server/test/fake-emailable.ts): it finds an address undeliverable when its local
// part starts with "nobody", and deliverable otherwise. DNS is answered by the install's
// server itself, and mail comes in through the test run's GreenMail. No request leaves this
// machine, and Emailable is never called.
//
// The provider and the mailbox stay connected, so this file is not written to be repeated
// against the same servers.
import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { contact, conversationList, me } from '@repo/contracts';

import { mailServer, sendMailFromOutside } from '../inbox-day.js';
import { address, asClient, verifyDay } from '../servers.js';
import { checks, checksQuery as query, signInToChecks, syncChecksMailNow } from '../verify-day.js';

test.use(asClient('203.0.113.200'));

const MAILBOX = 'fixture@localhost.test';

const fieldsOf = (page: Page): Locator => page.getByRole('region', { name: 'Fields', exact: true });
const badge = (page: Page, label: string, shown: string): Locator =>
  fieldsOf(page).getByRole('button', {
    name: `${label}: what this means for ${shown}`,
    exact: true,
  });
const menuOf = (page: Page, shown: string): Locator =>
  fieldsOf(page).getByRole('button', { name: `Email verification for ${shown}` });

/** What the install keeps of the checks of one address: the ledger and the result. */
const checked = (shown: string) =>
  query<{ status: string | null; depth: string | null; provider: string | null; ledger: number }>(
    `select v.status, v.depth, v.provider,
       (select count(*)::int from messaging.email_verification_checks c
        where c.business_id = v.business_id and c.address_normalized = v.address_normalized) as ledger
     from messaging.email_verifications v where v.address_normalized = $1`,
    [shown],
  );

/** Asks for a check from the address's menu and waits for the worker's result to show. */
async function verify(page: Page, shown: string, result: string): Promise<void> {
  await menuOf(page, shown).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Verify email' }).click();
  // The row reads the details again by itself while the check runs.
  await expect(badge(page, result, shown)).toBeVisible({ timeout: 30_000 });
}

test('Verify day: Emailable connected in Settings, addresses checked on the contact page, and an invalid one stops a reply', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const good = `ok-${suffix}@example.test`;
  const gone = { name: `Nobody ${suffix}`, email: `nobody-${suffix}@example.test` };
  const mail = mailServer();

  await signInToChecks(page);
  const api = `${address('verifyDay')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === verifyDay.business.slug);
  if (business === undefined) throw new Error('The Verify day install has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('verifyDay') };

  await test.step('connect Emailable: a wrong key is refused, the right one is tested and kept', async () => {
    await page.goto(checks('/settings/email'));
    const section = page.getByRole('region', { name: 'Email Verification' });
    await expect(
      section.getByText('Mailbox checks need a verification provider. Domain checks still run.'),
    ).toBeVisible();
    await section.getByRole('button', { name: 'Connect Emailable' }).click();
    const key = section.getByLabel('Emailable API key');
    await key.fill('test_fake_not_the_key');
    await section.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(section.getByRole('alert')).toHaveText(
      'The verification provider could not confirm this key.',
    );
    await key.fill(verifyDay.emailableKey);
    await section.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(section.getByText('Emailable connected')).toBeVisible();
    await expect(section.getByText('250 credits left.')).toBeVisible();
    await expect(section.getByText('Test mode', { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(verifyDay.emailableKey);
  });

  await test.step('a mailbox for replies, at any hour', async () => {
    await page.getByRole('button', { name: 'Add a mailbox', exact: true }).click();
    await page.getByLabel('Email address', { exact: true }).fill(MAILBOX);
    await page.getByLabel('Mailbox name', { exact: true }).fill('Front desk');
    await page.getByLabel('Sender name', { exact: true }).fill(verifyDay.business.name);
    for (const [protocol, port] of [
      ['SMTP', mail.smtpPort],
      ['IMAP', mail.imapPort],
    ] as const) {
      const group = page.getByRole('group', { name: protocol, exact: true });
      await group.getByLabel('Server', { exact: true }).fill('localhost');
      await group.getByLabel('Port', { exact: true }).fill(String(port));
      await group.getByLabel('Username', { exact: true }).fill(mail.username);
      await group.getByLabel('Password or app password').fill(mail.password);
    }
    await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
    await expect(page.getByText('Mailbox connected.', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByLabel('Hold messages during quiet hours').uncheck();
    await page.getByRole('button', { name: 'Save quiet hours', exact: true }).click();
    await expect(page.getByText('Quiet hours saved.', { exact: true })).toBeVisible();
  });

  await test.step('verify an address on a contact, then block and unblock it', async () => {
    const created = await page.request.post(`${api}/contacts`, {
      headers,
      data: { firstName: `Checked ${suffix}`, emails: [good] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const saved = contact.parse(await created.json());
    await page.goto(checks(`/contacts/${saved.id}`));
    await expect(badge(page, 'Not verified', good)).toBeVisible();

    await verify(page, good, 'Verified');
    // The mailbox was checked by the provider, once, with a test key that uses no credit.
    expect(await checked(good)).toEqual([
      { status: 'valid', depth: 'mailbox', provider: 'emailable', ledger: 1 },
    ]);

    await menuOf(page, good).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Block email' }).click();
    const block = page.getByRole('dialog', { name: `Block ${good}?` });
    await block.getByRole('textbox', { name: 'Reason (optional)' }).fill('Asked us to stop');
    await block.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(block).toBeHidden();
    await expect(badge(page, 'Blocked', good)).toBeVisible();
    await expect(
      fieldsOf(page).getByText(`${good} is blocked. No email is sent to it.`),
    ).toBeVisible();

    await menuOf(page, good).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Unblock' }).click();
    await expect(badge(page, 'Verified', good)).toBeVisible();
    expect(
      await query<{ reason: string; live: boolean }>(
        `select reason, expires_at is null or expires_at > now() as live
         from messaging.suppressions where address_normalized = $1`,
        [good],
      ),
    ).toEqual([{ reason: 'manual', live: false }]);
  });

  await test.step('an address found invalid is blocked, and a reply to it is not sent', async () => {
    await page.goto(checks('/inbox'));
    await sendMailFromOutside({
      from: { name: gone.name, address: gone.email },
      to: MAILBOX,
      subject: `Rooms ${suffix}`,
      text: `Do you have a room free in May? (${suffix})`,
      messageId: `verify-day-${suffix}@mail.example.test`,
    });
    await syncChecksMailNow();
    const row = page
      .getByRole('region', { name: 'Conversations', exact: true })
      .getByRole('link', { name: new RegExp(gone.name) });
    await expect(row).toBeVisible({ timeout: 60_000 });
    const list = conversationList.parse(
      await (await page.request.get(`${api}/conversations?status=all`, { headers })).json(),
    );
    const writer = list.items.find((item) => item.contact.name === gone.name);
    if (writer === undefined) throw new Error('The mail made no conversation.');

    await page.goto(checks(`/contacts/${writer.contact.id}`));
    await verify(page, gone.email, 'Blocked');
    expect(await checked(gone.email)).toEqual([
      { status: 'invalid', depth: 'mailbox', provider: 'emailable', ledger: 1 },
    ]);

    await page.goto(checks('/inbox'));
    await row.click();
    const form = page.getByRole('form', { name: `Reply to ${gone.name}`, exact: true });
    await form
      .getByRole('textbox', { name: `Message to ${gone.name}`, exact: true })
      .fill('Yes, two rooms are free in May.');
    await form.getByRole('button', { name: 'Send email', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: "Your reply wasn't sent." }),
    ).toBeVisible();
    await expect
      .poll(() =>
        query<{ status: string; error_code: string | null }>(
          `select status, error_code from messaging.messages
           where direction = 'outbound' and $1 = any(to_addresses)`,
          [gone.email],
        ),
      )
      .toEqual([{ status: 'failed', error_code: 'suppressed' }]);
  });
});
