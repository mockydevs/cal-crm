// What the "Verify day" tests (tests/email-verification.spec.ts) use on their own install
// (global-setup.ts): its database, for what the product does not show. Emailable is a
// stand-in on this machine (apps/server/test/fake-emailable.ts), and the mail server is
// the test run's GreenMail, shared with "Inbox day" (inbox-day.ts has the contact's side).
import type { Page } from '@playwright/test';
import { mailbox } from '@repo/testing';
import pg from 'pg';

import { address, verifyDay } from './servers.js';
import { askForSignInLink, emailTo } from './signing-in.js';

/**
 * Signs the install's owner in by the link of a new email. Each Verify day file signs the
 * same person in, in either order, so the link is the one sent after those already there.
 */
export async function signInToChecks(page: Page): Promise<void> {
  await page.goto(`${address('verifyDay')}/sign-in`);
  const sent = (await mailbox({ apiUrl: address('mail') }).messagesTo(verifyDay.owner.email))
    .length;
  await askForSignInLink(page, verifyDay.owner.email);
  await page.goto((await emailTo(verifyDay.owner.email, sent + 1)).link);
}

/** Reads or writes the "Verify day" install's database as crm_owner. */
export async function checksQuery<Row extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: address('verifyDayDatabase') });
  await client.connect();
  try {
    return (await client.query<Row>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

/** The dashboard's address for a page of the business, such as checks('/contacts'). */
export function checks(path = ''): string {
  return `${address('verifyDay')}/b/${verifyDay.business.slug}${path}`;
}

/**
 * Runs the worker's inbox sync now rather than at its next turn. A mailbox is read every
 * two minutes at most, so its last read is put two minutes back first.
 */
export async function syncChecksMailNow(): Promise<void> {
  await checksQuery(
    `update messaging.mailboxes set last_synced_at = last_synced_at - interval '2 minutes'
     where last_synced_at is not null`,
  );
  await checksQuery("select graphile_worker.add_job('mailboxes.schedule_syncs')");
}
