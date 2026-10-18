// The Inbox on the whole product: the built server, its worker and the built dashboard over
// a migrated Postgres. Mail from the contact is stored the way the inbox sync stores it;
// everything else goes through the page, as a person would.
import { randomUUID } from 'node:crypto';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { contact, me } from '@repo/contracts';
import { mailbox } from '@repo/testing';

import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, query, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.140'));

const listOf = (page: Page): Locator =>
  page.getByRole('region', { name: 'Conversations', exact: true });
const inboxLink = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Conversations/ });

test('shows a conversation, updates as mail arrives, keeps a note inside the team and reports a refused reply', async ({
  page,
}) => {
  // Wide enough for the list and the thread side by side.
  await page.setViewportSize({ width: 1440, height: 900 });
  const person = await newPerson();
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const api = `${address('app')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('The inbox fixture has no business.');
  const suffix = randomUUID().slice(0, 8);
  const name = `Maya ${suffix}`;
  const email = `maya-${suffix}@example.test`;
  const created = await page.request.post(`${api}/contacts`, {
    headers: { 'Business-Id': business.id, Origin: address('app') },
    data: { firstName: name, emails: [email] },
  });
  expect(created.status(), await created.text()).toBe(201);
  expect(contact.parse(await created.json()).name).toBe(name);

  // A mailbox, and the contact's conversation in it. No worker opens this mailbox: its
  // sealed credentials are a placeholder, and nothing in this test is delivered by it.
  const [mail] = await query<{ business_id: string; id: string }>(
    `with business as (
       select id, agency_id from tenancy.businesses where slug = $1
     ), secret as (
       insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       select agency_id, id, 'mailbox.credentials', 1,
         decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex') from business
       returning id, business_id
     ), account as (
       insert into messaging.channel_accounts (business_id, channel, name)
       select business_id, 'email', $2 from secret returning business_id, id
     )
     insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
       smtp_port, smtp_security, smtp_username, secret_id)
     select account.business_id, account.id, $3, 'password', 'smtp.example.test', 465, 'tls',
       'fixture', secret.id from account, secret
     returning business_id, id`,
    [ours.slug, `Front desk ${suffix}`, `desk-${suffix}@harborlights.example`],
  );
  if (mail === undefined) throw new Error('The mailbox fixture was not stored.');
  const [stored] = await query<{ id: string }>(
    `insert into messaging.conversations (business_id, contact_id)
     select c.business_id, c.id from crm.contact_identities i
     join crm.contacts c on c.business_id = i.business_id and c.id = i.contact_id
     where i.business_id = $1 and i.value_normalized = $2
     returning id`,
    [mail.business_id, email],
  );
  if (stored === undefined) throw new Error('The conversation fixture was not stored.');
  /** A message from the contact, with the statements inbound.ts runs for a stored email. */
  const receive = async (text: string): Promise<void> => {
    await query(
      `insert into messaging.messages (business_id, conversation_id, channel,
         channel_account_id, direction, status, subject, body_text, from_address, author_kind,
         author_id)
       select v.business_id, v.id, 'email', $2, 'inbound', 'received', 'June 13', $3, $4,
         'contact', v.contact_id
       from messaging.conversations v where v.id = $1`,
      [stored.id, mail.id, text, email],
    );
    await query(
      `update messaging.conversations
       set status = 'open', snoozed_until = null, needs_reply = true,
           unread_count = unread_count + 1, last_message_at = now(), last_inbound_at = now()
       where id = $1`,
      [stored.id],
    );
  };
  await receive('Is June 13 still open?');

  // The list, the counts and the sidebar's badge.
  await page.goto(inOurs('/inbox'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Conversations', exact: true }),
  ).toBeVisible();
  const row = listOf(page).getByRole('link', { name: new RegExp(name) });
  await expect(row).toContainText('Is June 13 still open?');
  await expect(row).toContainText('Needs reply');
  await expect(row).toContainText('1 unread');
  await expect(inboxLink(page)).toContainText('unread conversation');
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);

  // More mail arrives while the list is on screen: it shows without a reload, counted.
  await receive('We would want DJ and video.');
  await expect(row).toContainText('We would want DJ and video.');
  await expect(row).toContainText('2 unread');

  // Opening it shows the thread and marks it read, for the list and the badge too.
  await row.click();
  const messages = page.getByRole('region', { name: `Messages with ${name}`, exact: true });
  await expect(messages.locator('li[data-direction="inbound"]')).toHaveCount(2);
  await expect(row).not.toContainText('unread');
  await expect
    .poll(async () =>
      query<{ unread_count: number; read_through_seq: string }>(
        'select unread_count, read_through_seq from messaging.conversations where id = $1',
        [stored.id],
      ),
    )
    .toEqual([{ unread_count: 0, read_through_seq: '2' }]);

  // And mail that arrives while the thread is open appears in it.
  await receive('Thursday at 3 works!');
  await expect(messages.locator('li[data-direction="inbound"]')).toHaveCount(3);
  await expect(messages).toContainText('Thursday at 3 works!');

  // An internal note: saved for the team, and nothing more.
  await page.getByRole('button', { name: 'Internal note', exact: true }).click();
  const noteForm = page.getByRole('form', { name: 'Internal note', exact: true });
  await noteForm
    .getByLabel('Note for your team', { exact: true })
    .fill('She haggles. Hold the price.');
  await noteForm.getByRole('button', { name: 'Save internal note', exact: true }).click();
  await expect(messages.locator('li[data-kind="note"]')).toContainText(
    'She haggles. Hold the price.',
  );
  expect(
    await query(
      `select m.channel, m.direction, m.status, m.channel_account_id, m.to_addresses,
         (select count(*)::int from messaging.outbound_dispatch d where d.id = m.id) as dispatches,
         (select count(*)::int from graphile_worker.jobs j where j.key = 'outbound:' || m.id::text) as jobs
       from messaging.messages m where m.conversation_id = $1 and m.channel = 'note'`,
      [stored.id],
    ),
  ).toEqual([
    {
      channel: 'note',
      direction: 'internal',
      status: 'note',
      channel_account_id: null,
      to_addresses: [],
      dispatches: 0,
      jobs: 0,
    },
  ]);

  // A reply: this contact withdrew her agreement to service email, so the pipeline refuses
  // it, and the page says so rather than pretending it went. (Writing in is the basis for
  // an answer only while nobody has recorded otherwise.)
  await query(
    `insert into messaging.consents
       (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
     select business_id, contact_id, 'email', 'transactional', 'withdrawn', 'user', 'system'
     from messaging.conversations where id = $1`,
    [stored.id],
  );
  await page.getByRole('button', { name: 'Reply to contact', exact: true }).click();
  const box = page.getByRole('textbox', { name: `Message to ${name}`, exact: true });
  await box.fill('Hi Maya, June 13 is open.');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  const refusal = page.getByRole('alert').filter({ hasText: "Your reply wasn't sent." });
  await expect(refusal).toContainText(
    'This contact withdrew their agreement to receive these messages.',
  );
  await expect(box).toHaveValue('Hi Maya, June 13 is open.');
  await expect(messages.locator('li[data-direction="outbound"]')).toContainText('Not sent');
  expect(
    await query(
      `select m.status, m.error_code, d.purpose, d.lane
       from messaging.messages m join messaging.outbound_dispatch d on d.id = m.id
       where m.conversation_id = $1 and m.direction = 'outbound'`,
      [stored.id],
    ),
  ).toEqual([
    { status: 'failed', error_code: 'consent_withdrawn', purpose: 'transactional', lane: 'reply' },
  ]);

  // Neither the note nor the refused reply reached the contact.
  expect(await mailbox({ apiUrl: address('mail') }).messagesTo(email)).toEqual([]);
});
