// What the "Draft day" tests (tests/reply-drafts.spec.ts) use on their own install
// (global-setup.ts): its database, for what the product does not show, and its stand-in for
// Claude, which a test tells what to answer. The mail server is the test run's GreenMail,
// shared with "Inbox day" (inbox-day.ts has the contact's side of it). No test reaches a
// real provider.
import pg from 'pg';

import type { FakeClaudeAnswer } from '../apps/server/test/fake-claude.js';
import { address, draftDay } from './servers.js';

/** Reads or writes the "Draft day" install's database as crm_owner. */
export async function draftQuery<Row extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: address('draftDayDatabase') });
  await client.connect();
  try {
    return (await client.query<Row>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

/** The dashboard's address for a page of the business, such as drafts('/inbox'). */
export function drafts(path = ''): string {
  return `${address('draftDay')}/b/${draftDay.business.slug}${path}`;
}

/**
 * Tells the stand-in for Claude what to answer. Each answer names the request it is for by
 * a phrase of the message being answered (`when`), because the mail server is shared: a
 * message another test sent may reach this install too, and must not take the answer.
 */
export async function claudeAnswers(
  answers: readonly (FakeClaudeAnswer & { readonly when: string })[],
): Promise<void> {
  const response = await fetch(`${address('draftDayClaude')}/__script`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(answers),
  });
  if (response.status !== 204)
    throw new Error(`The stand-in refused the script: ${String(response.status)}.`);
}

/**
 * Runs the worker's inbox sync now rather than at its next turn. A mailbox is read every
 * two minutes at most, so the day is moved on by that much first: its last read is put
 * two minutes back. Nothing else about the mailbox is touched.
 */
export async function syncMailNow(): Promise<void> {
  await draftQuery(
    `update messaging.mailboxes set last_synced_at = last_synced_at - interval '2 minutes'
     where last_synced_at is not null`,
  );
  await draftQuery("select graphile_worker.add_job('mailboxes.schedule_syncs')");
}

/** What has left, or waits to leave, the business for one address: messages and their dispatch. */
export function outboundTo(recipient: string): Promise<
  {
    status: string;
    body_text: string;
    author_kind: string;
    proposed: boolean;
    dispatched: boolean;
  }[]
> {
  return draftQuery(
    `select m.status, m.body_text, m.author_kind, m.proposal_id is not null as proposed,
            d.id is not null as dispatched
     from messaging.messages m
     left join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
     where m.direction = 'outbound' and $1 = any(m.to_addresses)
     order by m.seq`,
    [recipient],
  );
}
