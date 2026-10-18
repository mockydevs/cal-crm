// What the "Automation day" test (tests/checkpoint-1e.spec.ts) uses to be the world outside
// its install: a website that shows the business's form, a lead's phone, and the passing of
// days. None of it is the product. The mail server and the Twilio stand-in are the test
// run's own (inbox-day.ts); the form is sent as the embed on a website sends it.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';

import { postTwilioWebhook, type FakeTwilioAccount } from '../apps/server/test/fake-twilio.js';
import { address } from './servers.js';

/** Reads or writes the "Automation day" install's database as crm_owner. */
export async function flowQuery<Row extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: address('automationDayDatabase') });
  await client.connect();
  try {
    return (await client.query<Row>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  return Object.fromEntries(Object.entries(value));
}

/**
 * The automation of docs/AUTOMATIONS.md section 2, read from the document itself so the
 * checkpoint can't drift from it.
 */
export function documentedAutomation(): Record<string, unknown> {
  const spec = readFileSync(new URL('../docs/AUTOMATIONS.md', import.meta.url), 'utf8');
  for (const [, body] of spec.matchAll(/```json\n([\s\S]*?)```/g)) {
    const block = objectOf(JSON.parse(body ?? '{}'));
    if ('steps' in block && 'triggers' in block) return block;
  }
  throw new Error('docs/AUTOMATIONS.md has no automation document.');
}

/** The website the business put its form on. */
export const WEBSITE = 'https://www.meadowlane.example';

/**
 * Sends the form as its embed does from the business's website: reads what the form shows
 * (which says when it was shown), waits as a person filling it in would, and sends the
 * answers with the boxes ticked. The server sees the website's origin on both requests.
 */
export async function submitForm(
  publicKey: string,
  answers: {
    readonly values: Readonly<Record<string, string>>;
    readonly consents: Readonly<Record<string, boolean>>;
  },
): Promise<void> {
  const base = `${address('automationDayDirect')}/api/v1/public/forms/${publicKey}`;
  const shown = await fetch(base, { headers: { origin: WEBSITE } });
  if (!shown.ok) throw new Error(`The form was not shown: ${String(shown.status)}.`);
  const { renderToken } = objectOf(await shown.json());
  // A form sent sooner than a person could fill it in is refused.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const sent = await fetch(`${base}/submissions`, {
    method: 'POST',
    headers: { origin: WEBSITE, 'content-type': 'application/json' },
    body: JSON.stringify({
      clientSubmissionId: randomUUID(),
      renderToken,
      values: answers.values,
      consents: answers.consents,
      pageUrl: `${WEBSITE}/quote`,
    }),
  });
  if (sent.status !== 201)
    throw new Error(`The form was answered ${String(sent.status)}: ${await sent.text()}`);
}

/** A lead's phone sends a text: Twilio's signed inbound webhook, delivered to this install. */
export async function textFrom(
  account: FakeTwilioAccount,
  inboundWebhook: string,
  from: string,
  body: string,
): Promise<void> {
  const sid = `SM${randomUUID().replaceAll('-', '')}`;
  const answer = await postTwilioWebhook({
    url: inboundWebhook,
    deliverTo: address('automationDayDirect'),
    authToken: account.authToken,
    params: {
      AccountSid: account.accountSid,
      ApiVersion: '2010-04-01',
      MessageSid: sid,
      SmsSid: sid,
      From: from,
      To: account.number,
      Body: body,
      NumMedia: '0',
      NumSegments: '1',
    },
  });
  if (answer.status !== 200 || answer.body !== '<Response/>')
    throw new Error(`The webhook was answered ${String(answer.status)}: ${answer.body}`);
}

/**
 * Lets the waits of every run that is waiting end now, as the days they wait for would:
 * each wait's end is moved into the past, and the worker's own sweep, which runs every
 * minute, is asked to run at once. Nothing else about a run is touched: the step that
 * follows runs as it would have.
 */
export async function daysPass(): Promise<void> {
  await flowQuery(
    `update automation.enrolments set wake_at = now() - interval '1 second'
     where status = 'waiting' and wake_at > now()`,
  );
  await flowQuery("select graphile_worker.add_job('automations.schedule_due')");
}
