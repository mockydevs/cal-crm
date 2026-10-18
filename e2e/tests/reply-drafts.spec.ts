// Proposals and the inbox agent's reply drafts on the whole product, on an install of its
// own (global-setup.ts, "Draft day"): the built server with its worker and the built
// dashboard over a migrated Postgres. Nothing of the product is stood in for: mail arrives
// over IMAP from a real mail server, the worker drafts through the gateway, its adapter and
// its transport with a key it opened from the vault, and an approved reply leaves through
// the reply command, the outbound pipeline and SMTP.
//
// The world outside is local. The mail server is the test run's GreenMail, and Claude is a
// stand-in on this machine (apps/server/test/fake-claude.ts) that this file tells what to
// answer. No request leaves this machine, and no real provider is called.
//
// The day happens once on its install: the mailbox and the key stay connected, so this
// file is not written to be repeated against the same servers.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { contact, conversationAssistant, conversationList, me } from '@repo/contracts';

import { claudeAnswers, draftQuery, drafts, outboundTo, syncMailNow } from '../draft-day.js';
import { mailDeliveredTo, mailServer, sendMailFromOutside } from '../inbox-day.js';
import { address, asClient, draftDay } from '../servers.js';
import { signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.190'));

const MAILBOX = 'fixture@localhost.test';
const NIA = { name: 'Nia Mwangi', email: 'nia.mwangi@example.test' };
const DRAFT = 'Hi Nia, the barn is free on June 13. Shall I hold it for you?';
const SECOND_DRAFT = 'Hi Nia, yes, the barn seats 120 for dinner.';

const conversations = (page: Page): Locator =>
  page.getByRole('region', { name: 'Conversations', exact: true });
const rowOf = (page: Page, name: string): Locator =>
  conversations(page).getByRole('link', { name: new RegExp(name) });
const threadOf = (page: Page, name: string): Locator =>
  page.getByRole('region', { name: `Messages with ${name}`, exact: true });
const replyFormOf = (page: Page, name: string): Locator =>
  page.getByRole('form', { name: `Reply to ${name}`, exact: true });
const assistantOf = (page: Page): Locator =>
  page.getByRole('region', { name: 'Assistant', exact: true });

/** What the install has on record of the assistant's proposals for Nia's conversation. */
const proposals = () =>
  draftQuery<{
    kind: string;
    status: string;
    autonomy: string;
    edited: boolean;
    decided_by_kind: string | null;
    text: string | null;
  }>(
    `select p.kind, p.status, p.autonomy, p.edited, p.decided_by_kind,
            p.command -> 'input' -> 'reply' ->> 'text' as text
     from ai.proposals p
     join messaging.conversations c on c.business_id = p.business_id and c.id = p.conversation_id
     join crm.contact_identities i on i.business_id = c.business_id and i.contact_id = c.contact_id
     where i.value_normalized = $1
     order by p.created_at, p.id`,
    [NIA.email],
  );

test('Draft day: mail arrives, the assistant drafts, and nothing leaves until a person approves', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const mail = mailServer();

  await test.step('sign in', async () => {
    await page.goto(`${address('draftDay')}/sign-in`);
    await signInByLink(page, draftDay.owner.email, 1);
    await expect(page).toHaveURL(new RegExp(`^${address('draftDay')}/`));
  });
  const api = `${address('draftDay')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === draftDay.business.slug);
  if (business === undefined) throw new Error('The Draft day install has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('draftDay') };

  await test.step('connect a mailbox, and answer at any hour', async () => {
    await page.goto(drafts('/settings/email'));
    await page.getByRole('button', { name: 'Add a mailbox', exact: true }).click();
    await page.getByLabel('Email address', { exact: true }).fill(MAILBOX);
    await page.getByLabel('Mailbox name', { exact: true }).fill('Front desk');
    await page.getByLabel('Sender name', { exact: true }).fill(draftDay.business.name);
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

  await test.step('connect Claude: the key is sealed, and the worker’s test call answers', async () => {
    await page.goto(drafts('/settings/ai-models'));
    const providers = page.getByRole('region', { name: 'Providers' });
    await providers.getByRole('button', { name: 'Add Anthropic key' }).click();
    await providers.getByLabel('Anthropic API key').fill(draftDay.claudeKey);
    await providers.getByRole('button', { name: 'Save and test' }).click();
    await expect(providers.getByText(/Working · answered in \d+\.\d seconds/)).toBeVisible({
      timeout: 30_000,
    });
    expect(await page.content()).not.toContain(draftDay.claudeKey);
    // The business pays its own provider: until it says so, its key is saved and not used.
    await page.getByRole('radio', { name: "This business's own keys", exact: true }).click();
    await expect(
      page.getByRole('radio', { name: "This business's own keys", exact: true }),
    ).toBeChecked();
  });

  await test.step('a contact who agreed to service email', async () => {
    const created = await page.request.post(`${api}/contacts`, {
      headers,
      data: { firstName: 'Nia', lastName: 'Mwangi', emails: [NIA.email] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const saved = contact.parse(await created.json());
    await page.goto(drafts(`/contacts/${saved.id}?tab=dnd`));
    const panel = page.getByRole('region', { name: 'Consent', exact: true });
    await panel
      .getByRole('button', { name: 'Record consent for Service email', exact: true })
      .click();
    await panel
      .getByRole('group', { name: 'Record consent for Service email', exact: true })
      .getByLabel('How do you know?')
      .fill('Asked at the front desk to get replies this way.');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Consent recorded for Service email.');
  });

  const thread = threadOf(page, NIA.name);
  const form = replyFormOf(page, NIA.name);
  const assistant = assistantOf(page);
  const outbound = thread.locator('li[data-direction="outbound"]');

  await test.step('mail in: the assistant drafts a reply, and nothing is sent', async () => {
    // What the stand-in answers for her message, and for no other request it may get.
    await claudeAnswers([{ kind: 'text', text: DRAFT, when: 'Willow Park barn' }]);
    await page.goto(drafts('/inbox'));
    await sendMailFromOutside({
      from: { name: NIA.name, address: NIA.email },
      to: MAILBOX,
      subject: 'June 13',
      text: 'Is June 13 still open for the Willow Park barn?',
      messageId: 'draft-day-first@mail.example.test',
    });
    await syncMailNow();
    const row = rowOf(page, NIA.name);
    await expect(row).toContainText('Is June 13 still open', { timeout: 30_000 });
    await row.click();
    await expect(thread.locator('li[data-direction="inbound"]')).toHaveCount(1);

    // The draft arrives by itself, a few seconds after the mail: written by the worker
    // through the gateway, from her message.
    await expect(assistant.getByText('Suggested reply, waiting for you')).toBeVisible({
      timeout: 60_000,
    });
    await expect(assistant.getByText(DRAFT, { exact: true })).toBeVisible();
    await expect(assistant.getByRole('button', { name: 'Send it', exact: true })).toBeVisible();

    // "Ask first": the draft is a proposal and nothing else. No message was stored to go
    // out, nothing was handed to the pipeline, and nothing reached her mailbox.
    expect(await proposals()).toEqual([
      {
        kind: 'reply',
        status: 'pending',
        autonomy: 'ask',
        edited: false,
        decided_by_kind: null,
        text: DRAFT,
      },
    ]);
    expect(await outboundTo(NIA.email)).toEqual([]);
    expect(await mailDeliveredTo(NIA.email)).toEqual([]);
    await expect(outbound).toHaveCount(0);
    // The call is on the business's record as the assistant's, for replies.
    expect(
      await draftQuery(
        `select r.job, r.status, r.actor_kind, r.prompt_version from ai.requests r
         where r.job = 'replies' order by r.started_at`,
      ),
    ).toContainEqual({
      job: 'replies',
      status: 'ok',
      actor_kind: 'ai_agent',
      prompt_version: 'replies/1',
    });
  });

  await test.step('change it, then send: her words leave once, as the person’s reply', async () => {
    await assistant.getByRole('button', { name: 'Change it', exact: true }).click();
    const box = form.getByRole('textbox', { name: `Message to ${NIA.name}`, exact: true });
    await expect(box).toHaveValue(DRAFT);
    await expect(box).toBeFocused();
    await expect(form.getByLabel('Subject', { exact: true })).toHaveValue('Re: June 13');
    const edited = 'Hi Nia, the barn is free on June 13. I’ve pencilled you in.';
    await box.fill(edited);
    // Still nothing has left: editing is not sending.
    expect(await outboundTo(NIA.email)).toEqual([]);
    await form.getByRole('button', { name: 'Send email', exact: true }).click();

    const reply = outbound.filter({ hasText: edited });
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText('Sent', { timeout: 30_000 });
    await expect.poll(async () => (await mailDeliveredTo(NIA.email)).length).toBe(1);
    const [delivered] = await mailDeliveredTo(NIA.email);
    const raw = (delivered?.raw ?? '').replaceAll(/\r?\n[ \t]+/g, ' ');
    expect(delivered?.subject).toBe('Re: June 13');
    expect(raw).toContain('pencilled you in');
    expect(raw).not.toContain('Shall I hold it for you?');

    // One message, through the pipeline, written by the person and marked as drafted by
    // the assistant; the proposal is applied, edited, decided by a person.
    expect(await outboundTo(NIA.email)).toMatchObject([
      { body_text: edited, author_kind: 'user', proposed: true, dispatched: true },
    ]);
    expect(await proposals()).toMatchObject([
      { status: 'applied', edited: true, decided_by_kind: 'user', text: edited },
    ]);
    expect(
      await draftQuery(
        `select a.actor_kind, a.outcome, a.proposal_id is not null as proposed
         from audit.commands a where a.command = 'conversation.reply'`,
      ),
    ).toEqual([{ actor_kind: 'user', outcome: 'ok', proposed: true }]);
    // The card is no longer waiting, and offers nothing more to send.
    await expect(assistant.getByRole('button', { name: 'Send it', exact: true })).toHaveCount(0);
    await expect(
      assistant.getByText('You changed your assistant’s draft and sent it'),
    ).toBeVisible();
  });

  await test.step('she writes again: a new draft, sent as it is with one click, once', async () => {
    await claudeAnswers([{ kind: 'text', text: SECOND_DRAFT, when: 'seat for dinner' }]);
    await sendMailFromOutside({
      from: { name: NIA.name, address: NIA.email },
      to: MAILBOX,
      subject: 'Re: June 13',
      text: 'Lovely. How many does it seat for dinner?',
      messageId: 'draft-day-second@mail.example.test',
    });
    await syncMailNow();
    await expect(assistant.getByText(SECOND_DRAFT, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(await outboundTo(NIA.email)).toHaveLength(1);
    const send = assistant.getByRole('button', { name: 'Send it', exact: true });
    // Two clicks in a row send one message.
    await send.dblclick();
    await expect(outbound.filter({ hasText: SECOND_DRAFT })).toHaveCount(1);
    // The mailbox sends a few messages a minute, so the pipeline may hold this one for a
    // moment before it leaves: the thread says so, and then says it was sent.
    await expect(outbound.filter({ hasText: SECOND_DRAFT })).toContainText('Sent', {
      timeout: 120_000,
    });
    await expect.poll(async () => (await mailDeliveredTo(NIA.email)).length).toBe(2);
    expect(await outboundTo(NIA.email)).toHaveLength(2);
    expect((await proposals()).map(({ status, edited }) => ({ status, edited }))).toEqual([
      { status: 'applied', edited: true },
      { status: 'applied', edited: false },
    ]);
    // Nothing more arrives for her afterwards.
    await page.waitForTimeout(3000);
    expect(await mailDeliveredTo(NIA.email)).toHaveLength(2);
  });

  await test.step('a sent reply cannot be undone, and the product says so', async () => {
    const list = conversationList.parse(
      await (await page.request.get(`${api}/conversations?status=all`, { headers })).json(),
    );
    const mine = list.items.find((item) => item.contact.name === NIA.name);
    if (mine === undefined) throw new Error('Nia has no conversation.');
    const shown = conversationAssistant.parse(
      await (
        await page.request.get(`${api}/conversations/${mine.id}/assistant`, { headers })
      ).json(),
    );
    const [latest] = shown.proposals;
    expect(latest?.undo).toEqual({
      available: false,
      reason: 'message_sent',
      message: 'A message that was sent can’t be unsent.',
    });
    const undone = await page.request.post(`${api}/proposals/${latest?.id ?? ''}/undo`, {
      headers,
    });
    expect(undone.status()).toBe(409);
    expect(((await undone.json()) as { detail: string }).detail).toBe(
      'A message that was sent can’t be unsent.',
    );
    expect(await outboundTo(NIA.email)).toHaveLength(2);
  });

  await test.step('the model declines: the Inbox says so, and she is answered by hand', async () => {
    await claudeAnswers([{ kind: 'refusal', when: 'question the model declines' }]);
    await sendMailFromOutside({
      from: { name: NIA.name, address: NIA.email },
      to: MAILBOX,
      subject: 'Re: June 13',
      text: 'One more: a question the model declines to answer.',
      messageId: 'draft-day-third@mail.example.test',
    });
    await syncMailNow();
    await expect(thread.locator('li[data-direction="inbound"]')).toHaveCount(3, {
      timeout: 30_000,
    });
    await expect(assistant.getByRole('group', { name: 'No draft' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(assistant.getByRole('button', { name: 'Send it', exact: true })).toHaveCount(0);
    expect(await outboundTo(NIA.email)).toHaveLength(2);
    // The person can always write their own reply.
    await form
      .getByRole('textbox', { name: `Message to ${NIA.name}`, exact: true })
      .fill('I’ll call you about that.');
    await form.getByRole('button', { name: 'Send email', exact: true }).click();
    await expect
      .poll(async () => (await mailDeliveredTo(NIA.email)).length, { timeout: 120_000 })
      .toBe(3);
    expect((await outboundTo(NIA.email)).at(-1)).toMatchObject({
      body_text: 'I’ll call you about that.',
      author_kind: 'user',
      proposed: false,
    });
  });

  await test.step('a proposed change: applied by a person, then undone', async () => {
    // No assistant proposes a change of status yet, so the proposal is stored here as one
    // would store it: the command to close this conversation, made on its revision now.
    const list = conversationList.parse(
      await (await page.request.get(`${api}/conversations?status=all`, { headers })).json(),
    );
    const mine = list.items.find((item) => item.contact.name === NIA.name);
    if (mine === undefined) throw new Error('Nia has no conversation.');
    await draftQuery(
      `insert into ai.proposals (business_id, agent, kind, conversation_id, summary, command,
         after, autonomy, revision)
       select c.business_id, 'inbox', 'conversation_status', c.id, 'Close this conversation',
         jsonb_build_object('name', 'conversation.set_status', 'input',
           jsonb_build_object('id', $2::text, 'change',
             jsonb_build_object('status', 'closed', 'revision', $3::text))),
         jsonb_build_object('kind', 'conversation_status', 'from', 'open', 'to', 'closed', 'until', null),
         'ask', $3::text
       from messaging.conversations c
       join crm.contact_identities i on i.business_id = c.business_id and i.contact_id = c.contact_id
       where i.value_normalized = $1`,
      [NIA.email, mine.id, mine.revision],
    );
    const status = () =>
      draftQuery<{ status: string }>(
        `select c.status from messaging.conversations c
         join crm.contact_identities i on i.business_id = c.business_id and i.contact_id = c.contact_id
         where i.value_normalized = $1`,
        [NIA.email],
      );
    await page.reload();
    await expect(
      assistant.getByText('Your assistant suggests closing this conversation'),
    ).toBeVisible();
    // Proposed is not done: the conversation is still open.
    expect(await status()).toEqual([{ status: 'open' }]);
    await assistant.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(assistant.getByText('Closed on your assistant’s suggestion by you')).toBeVisible();
    expect(await status()).toEqual([{ status: 'closed' }]);
    await assistant.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(assistant.getByText('Undone: the conversation is open again.')).toBeVisible();
    expect(await status()).toEqual([{ status: 'open' }]);
    expect(
      await draftQuery(
        `select a.actor_kind, a.outcome, a.proposal_id is not null as proposed
         from audit.commands a where a.command = 'conversation.set_status' order by a.recorded_at`,
      ),
    ).toEqual([
      { actor_kind: 'user', outcome: 'ok', proposed: true },
      { actor_kind: 'user', outcome: 'ok', proposed: true },
    ]);
  });
});
