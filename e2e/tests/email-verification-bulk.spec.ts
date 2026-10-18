// Verify emails from the contact list, on the whole product's "Verify day" install
// (global-setup.ts): the built server with its worker and the built dashboard over a
// migrated Postgres. A person ticks contacts, reads in the confirm dialog what the check
// would do, and starts it; the worker checks each address through the email-checks adapter
// against the local stand-in for Emailable (apps/server/test/fake-emailable.ts: a local
// part starting with "nobody" is undeliverable). The list then reads and filters what was
// found. No request leaves this machine, and Emailable is never called.
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { contact, contactList, me } from '@repo/contracts';

import { address, asClient, verifyDay } from '../servers.js';
import { checks, checksQuery as query, signInToChecks } from '../verify-day.js';

test.use(asClient('203.0.113.201'));

/** What the install keeps of one address: the result and how many checks were made. */
const checked = (shown: string) =>
  query<{ status: string | null; depth: string | null; ledger: number }>(
    `select v.status, v.depth,
       (select count(*)::int from messaging.email_verification_checks c
        where c.business_id = v.business_id and c.address_normalized = v.address_normalized) as ledger
     from messaging.email_verifications v where v.address_normalized = $1`,
    [shown],
  );

test('Verify day: Verify emails checks the ticked contacts, keeps a current result, and the list filters by what it found', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const good = `ok-bulk-${suffix}@example.test`;
  const gone = `nobody-bulk-${suffix}@example.test`;
  const kept = `kept-bulk-${suffix}@example.test`;

  await signInToChecks(page);
  const api = `${address('verifyDay')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === verifyDay.business.slug);
  if (business === undefined) throw new Error('The Verify day install has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('verifyDay') };

  // Emailable connected, as Settings → Email Services connects it (email-verification.spec.ts
  // drives that page); connecting again with the same key keeps it connected. It is
  // disconnected again at the end, as that file expects to find it before it connects.
  const connected = await page.request.put(`${api}/email-verification/provider`, {
    headers,
    data: { apiKey: verifyDay.emailableKey },
  });
  expect(connected.status(), await connected.text()).toBe(200);

  try {
    for (const [lastName, email] of [
      ['Good', good],
      ['Gone', gone],
      ['Kept', kept],
      ['Nomail', null],
    ] as const) {
      const created = await page.request.post(`${api}/contacts`, {
        headers,
        data: { firstName: `Bulk${suffix}`, lastName, emails: email === null ? [] : [email] },
      });
      expect(created.status(), await created.text()).toBe(201);
      contact.parse(await created.json());
    }
    // One address was checked a week ago: a current result, kept at no cost.
    await query(
      `insert into messaging.email_verifications (business_id, address_normalized, status, depth, checked_at)
     select b.id, $1, 'valid', 'mailbox', now() - interval '7 days'
     from tenancy.businesses b where b.slug = $2`,
      [kept, verifyDay.business.slug],
    );

    await test.step('the confirm dialog says what the check will do, and Verify starts it', async () => {
      await page.goto(checks(`/contacts?q=Bulk${suffix}`));
      const table = page.getByRole('region', { name: 'Contacts table', exact: true });
      await expect(
        table.getByRole('link', { name: `Bulk${suffix} Good`, exact: true }),
      ).toBeVisible();
      await page.getByRole('checkbox', { name: 'Select all contacts on this page' }).check();
      const bar = page.getByRole('group', { name: 'Bulk actions' });
      await expect(bar).toContainText('4 selected');
      await bar.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Verify emails' }).click();
      const dialog = page.getByRole('dialog', { name: 'Verify emails' });
      await expect(dialog.getByText('4 contacts in the selection.')).toBeVisible();
      await expect(
        dialog.getByText('1 already has a current result: kept as it is, at no cost.'),
      ).toBeVisible();
      await expect(
        dialog.getByText('2 will be checked, 2 of them using a provider credit.'),
      ).toBeVisible();
      await dialog.getByRole('button', { name: 'Verify 4 contacts' }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step('the worker checks each address once, and leaves the current one alone', async () => {
      await expect
        .poll(async () => (await checked(good))[0], { timeout: 60_000 })
        .toEqual({ status: 'valid', depth: 'mailbox', ledger: 1 });
      await expect
        .poll(async () => (await checked(gone))[0], { timeout: 60_000 })
        .toEqual({ status: 'invalid', depth: 'mailbox', ledger: 1 });
      expect((await checked(kept))[0]).toEqual({ status: 'valid', depth: 'mailbox', ledger: 0 });
      const [action] = await query<{ done: number; unchanged: number; skipped: number }>(
        `select done_count as done, unchanged_count as unchanged, skipped_count as skipped
       from crm.contact_bulk_actions where action = 'verify_emails' order by created_at desc limit 1`,
      );
      expect(action).toEqual({ done: 2, unchanged: 1, skipped: 1 });
    });

    await test.step('the list reads and filters what verification found', async () => {
      const filter = JSON.stringify({
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [{ field: 'emailVerification', operator: 'any_of', values: ['invalid'] }],
          },
        ],
      });
      const listed = contactList.parse(
        await (
          await page.request.get(
            `${api}/contacts?q=Bulk${suffix}&include=emailVerification&filter=${encodeURIComponent(filter)}`,
            { headers },
          )
        ).json(),
      );
      expect(listed.items.map((item) => [item.email, item.emailVerification])).toEqual([
        [gone, 'invalid'],
      ]);
    });
  } finally {
    const disconnected = await page.request.delete(`${api}/email-verification/provider`, {
      headers,
    });
    expect(disconnected.status(), await disconnected.text()).toBe(200);
  }
});
