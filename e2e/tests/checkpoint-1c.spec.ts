// Checkpoint 1C, "Inbox day": connect a mailbox (score shown), email and SMS both ways,
// chat, STOP handling, and no double sends under retries. One person's day on an install of
// its own (global-setup.ts): the built server with its worker, the built dashboard and the
// built widget over a migrated Postgres, behind an HTTPS front.
//
// Nothing of the product is stood in for. The world outside it is local: the mail server
// is GreenMail, and Twilio is the stand-in of apps/server/test/fake-twilio.ts, which the
// real Twilio adapter talks to over HTTP. No message leaves this machine.
//
// The day happens once on its install: the mailbox and the number it connects stay
// connected, so this file is not written to be repeated against the same servers.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { contact, me } from '@repo/contracts';

import {
  dayQuery,
  mailDeliveredTo,
  mailServer,
  sendMailFromOutside,
  twilio,
} from '../inbox-day.js';
import { choose } from '../select.js';
import { address, asClient, inboxDay } from '../servers.js';
import { signInByLink } from '../signing-in.js';

// The install's certificate is made for the test run; the browser is told to accept it.
test.use({ ...asClient('203.0.113.160'), ignoreHTTPSErrors: true });

const MAILBOX = 'fixture@localhost.test';
const MAYA = { name: 'Maya Okafor', email: 'maya.okafor@example.test', phone: '+15558675310' };
const VISITOR = { name: 'Jordan Lee', email: 'jordan.lee@example.test' };

const WEBSITE_PAGE = readFileSync(
  fileURLToPath(new URL('./webchat-test-page.html', import.meta.url)),
  'utf8',
);

const day = (path = ''): string => `${address('inboxDay')}/b/${inboxDay.business.slug}${path}`;
const conversations = (page: Page): Locator =>
  page.getByRole('region', { name: 'Conversations', exact: true });
const rowOf = (page: Page, name: string): Locator =>
  conversations(page).getByRole('link', { name: new RegExp(name) });
const threadOf = (page: Page, name: string): Locator =>
  page.getByRole('region', { name: `Messages with ${name}`, exact: true });
const replyFormOf = (page: Page, name: string): Locator =>
  page.getByRole('form', { name: `Reply to ${name}`, exact: true });

/** Runs the worker's inbox sync now rather than at its next two-minute turn. */
const syncMailNow = (): Promise<unknown> =>
  dayQuery("select graphile_worker.add_job('mailboxes.schedule_syncs')");

/**
 * Queues the dispatch job of every outbound message once more, with the payload and the
 * queue private.enqueue_outbound gives it, and waits until the worker has run them all:
 * what a retried or a duplicated job does. Returns how many it queued.
 */
async function dispatchEverythingAgain(): Promise<number> {
  const queued = await dayQuery(
    `select graphile_worker.add_job('messaging.dispatch',
       payload := json_build_object('agencyId', b.agency_id, 'businessId', b.id,
         'correlationId', gen_random_uuid(), 'data', json_build_object('messageId', m.id)),
       queue_name := 'outbound:' || b.id::text)
     from messaging.messages m join tenancy.businesses b on b.id = m.business_id
     where m.direction = 'outbound'`,
  );
  await expect
    .poll(
      () =>
        dayQuery(
          "select id from graphile_worker.jobs where task_identifier = 'messaging.dispatch' limit 1",
        ),
      { timeout: 30_000 },
    )
    .toEqual([]);
  return queued.length;
}

/** A business's own website on another origin, with the chat widget's script tag. */
async function startWebsite(): Promise<{
  readonly origin: string;
  show(key: string): void;
  close(): Promise<void>;
}> {
  const crm = address('inboxDay');
  let key = '';
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src ${crm}; connect-src ${crm}; base-uri 'none'; form-action 'none'`,
      })
      .end(WEBSITE_PAGE.replaceAll('{{CRM}}', crm).replaceAll('{{KEY}}', key));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listening = server.address();
  if (listening === null || typeof listening === 'string') throw new Error('No port.');
  return {
    origin: `http://127.0.0.1:${String(listening.port)}`,
    show(next) {
      key = next;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

test('Inbox day: a mailbox connected and scored, email and text messages both ways, a web chat, STOP, and never a second send', async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const mail = mailServer();
  const account = await twilio.newAccount();
  /** The requests the stand-in got that created, or may have created, a message of ours. */
  const textsAtProvider = async () =>
    (await twilio.state()).messages.filter((each) => each.accountSid === account.accountSid);

  await test.step('sign in', async () => {
    await page.goto(`${address('inboxDay')}/sign-in`);
    await signInByLink(page, inboxDay.owner.email, 1);
    await expect(page).toHaveURL(new RegExp(`^${address('inboxDay')}/`));
  });
  const api = `${address('inboxDay')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === inboxDay.business.slug);
  if (business === undefined) throw new Error('The Inbox day install has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('inboxDay') };

  await test.step('connect a mailbox: its sign-ins are tested, and its setup score is shown', async () => {
    await page.goto(day('/settings/email'));
    await page.getByRole('button', { name: 'Add a mailbox', exact: true }).click();
    await page.getByLabel('Email address', { exact: true }).fill(MAILBOX);
    await page.getByLabel('Mailbox name', { exact: true }).fill('Front desk');
    await page.getByLabel('Sender name', { exact: true }).fill('Lakeside Studio');
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
    await expect(page.getByRole('heading', { name: 'Front desk', exact: true })).toBeVisible();
    // The first check runs by itself after connecting: the score, and what it is made of.
    // Each mailbox's setup is a region of its own, named for the mailbox.
    const setup = page.getByRole('region', { name: 'Mailbox setup: Front desk', exact: true });
    const score = setup.getByLabel('Mailbox setup score', { exact: true });
    await expect(score).toBeVisible({ timeout: 60_000 });
    await expect(score).toHaveAttribute('value', /^\d+$/);
    await expect(setup.getByText(/^\d+ \/ 100$/)).toBeVisible();
    // The sign-ins it just made over TLS count for it.
    await expect(
      setup
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: 'Connection', exact: true }) }),
    ).toContainText('Passed');
    // The passwords were sealed for the worker; no page shows them again.
    expect(await page.content()).not.toContain(mail.password);

    // This studio answers at any hour. (With quiet hours on, a reply inside the contact's
    // quiet hours, or the business's when nobody has set hers, waits.)
    await page.getByLabel('Hold messages during quiet hours').uncheck();
    await page.getByRole('button', { name: 'Save quiet hours', exact: true }).click();
    await expect(page.getByText('Quiet hours saved.', { exact: true })).toBeVisible();
  });

  const maya = await test.step('a contact who agreed to service email and texts', async () => {
    const created = await page.request.post(`${api}/contacts`, {
      headers,
      data: { firstName: 'Maya', lastName: 'Okafor', emails: [MAYA.email], phones: [MAYA.phone] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const saved = contact.parse(await created.json());
    await page.goto(day(`/contacts/${saved.id}?tab=dnd`));
    const panel = page.getByRole('region', { name: 'Consent', exact: true });
    for (const label of ['Service email', 'Service texts']) {
      await panel.getByRole('button', { name: `Record consent for ${label}`, exact: true }).click();
      await panel
        .getByRole('group', { name: `Record consent for ${label}`, exact: true })
        .getByLabel('How do you know?')
        .fill('Asked at the front desk to get replies this way.');
      await panel.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(panel.getByRole('status')).toHaveText(`Consent recorded for ${label}.`);
    }
    return saved;
  });

  const thread = threadOf(page, MAYA.name);
  const form = replyFormOf(page, MAYA.name);
  const inbound = thread.locator('li[data-direction="inbound"]');
  const outbound = thread.locator('li[data-direction="outbound"]');
  const writeReply = (text: string) =>
    form.getByLabel(`Message to ${MAYA.name}`, { exact: true }).fill(text);

  await test.step('email in: her message arrives in the open Inbox without a reload', async () => {
    await page.goto(day('/inbox'));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Conversations', exact: true }),
    ).toBeVisible();
    await expect(rowOf(page, MAYA.name)).toHaveCount(0);
    await sendMailFromOutside({
      from: { name: MAYA.name, address: MAYA.email },
      to: MAILBOX,
      subject: 'June 13',
      text: 'Is June 13 still open?',
      messageId: 'june-13-first@mail.example.test',
    });
    await syncMailNow();
    const row = rowOf(page, MAYA.name);
    await expect(row).toContainText('Is June 13 still open?', { timeout: 30_000 });
    await expect(row).toContainText('Needs reply');
    await expect(row).toContainText('1 unread');
    await row.click();
    await expect(inbound).toHaveCount(1);
    await expect(inbound).toContainText('Email from Maya Okafor');
  });

  await test.step('email out: the reply leaves by the connected mailbox, once', async () => {
    await expect(form.getByRole('combobox', { name: 'From', exact: true })).toContainText(
      `Front desk · ${MAILBOX}`,
    );
    await expect(form.getByLabel('Subject', { exact: true })).toHaveValue('Re: June 13');
    await writeReply('Yes, June 13 is open.');
    await form.getByRole('button', { name: 'Send email', exact: true }).click();
    const reply = outbound.filter({ hasText: 'Yes, June 13 is open.' });
    await expect(reply).toContainText('Email to Maya Okafor, from you');
    await expect(reply).toContainText('Sent', { timeout: 30_000 });
    await expect(reply).toContainText('sent from Front desk');
    await expect.poll(async () => (await mailDeliveredTo(MAYA.email)).length).toBe(1);
    const [delivered] = await mailDeliveredTo(MAYA.email);
    const raw = (delivered?.raw ?? '').replaceAll(/\r?\n[ \t]+/g, ' ');
    expect(delivered?.subject).toBe('Re: June 13');
    expect(raw).toMatch(new RegExp(`^From: .*<${MAILBOX}>`, 'm'));
    expect(raw).toContain('Yes, June 13 is open.');
    // She was answered: the conversation no longer waits for a reply.
    await expect(rowOf(page, MAYA.name)).not.toContainText('Needs reply');
  });

  const inboundWebhook =
    await test.step('connect Twilio and register the number it already owns', async () => {
      await page.goto(day('/settings/sms'));
      await page.getByRole('button', { name: 'Connect Twilio', exact: true }).click();
      await page.getByLabel('Label', { exact: true }).fill('Front desk line');
      await page.getByLabel('Account SID', { exact: true }).fill(account.accountSid);
      await page.getByLabel('Auth Token', { exact: true }).fill(account.authToken);
      await page.getByRole('button', { name: 'Test and connect', exact: true }).click();
      await expect(page.getByText('Twilio connected.', { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      // The address to paste into Twilio is shown this once.
      const shown = await page
        .getByText(new RegExp(`^${address('inboxDay')}/webhooks/twilio/[A-Za-z0-9_-]{43}/inbound$`))
        .textContent();
      if (shown === null) throw new Error('No inbound webhook address was shown.');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Front desk line', exact: true }),
      ).toBeVisible();
      await page.getByText('Numbers from Twilio', { exact: true }).click();
      await expect(page.getByText(account.number).first()).toBeVisible();
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Studio mobile');
      await page.getByRole('button', { name: 'Register', exact: true }).click();
      // The owner manages calls too, so the number shows in Phone System's inventory.
      await expect(
        page
          .getByRole('list', { name: 'Registered numbers', exact: true })
          .getByRole('heading', { name: 'Studio mobile', exact: true }),
      ).toBeVisible();
      // The Auth Token is sealed like the mailbox's passwords.
      expect(await page.content()).not.toContain(account.authToken);
      return shown;
    });

  /** Maya's phone sends a text: Twilio's signed inbound webhook. */
  const mayaTexts = (body: string): Promise<void> => {
    const sid = twilio.newMessageSid();
    return twilio.post(account, inboundWebhook, {
      AccountSid: account.accountSid,
      ApiVersion: '2010-04-01',
      MessageSid: sid,
      SmsSid: sid,
      From: MAYA.phone,
      To: account.number,
      Body: body,
      NumMedia: '0',
      NumSegments: '1',
    });
  };
  /** Twilio reports what became of a text message of ours. */
  const twilioReports = (callbackUrl: string, sid: string, status: string): Promise<void> =>
    twilio.post(account, callbackUrl, {
      AccountSid: account.accountSid,
      ApiVersion: '2010-04-01',
      MessageSid: sid,
      SmsSid: sid,
      MessageStatus: status,
      SmsStatus: status,
      From: account.number,
      To: MAYA.phone,
    });
  const sendText = async (text: string): Promise<Locator> => {
    await choose(form.getByRole('combobox', { name: 'Send by', exact: true }), {
      label: 'Text message',
    });
    await expect(form.getByRole('combobox', { name: 'From', exact: true })).toContainText(
      `Studio mobile · ${account.number}`,
    );
    await writeReply(text);
    await form.getByRole('button', { name: 'Send text message', exact: true }).click();
    return outbound.filter({ hasText: text });
  };

  await test.step('text message in: it joins her conversation while the thread is open', async () => {
    await page.goto(day('/inbox'));
    await rowOf(page, MAYA.name).click();
    await expect(inbound).toHaveCount(1);
    await mayaTexts('Can you text me the address?');
    await expect(inbound).toHaveCount(2, { timeout: 30_000 });
    await expect(inbound.last()).toContainText('Text message from Maya Okafor');
    await expect(inbound.last()).toContainText('Can you text me the address?');
    await expect(rowOf(page, MAYA.name)).toContainText('Needs reply');
  });

  await test.step("text message out: one request to the provider, then Twilio's delivery report", async () => {
    const reply = await sendText('12 Lake Road, the blue door.');
    await expect(reply).toContainText('Text message to Maya Okafor, from you');
    await expect(reply).toContainText('Sent', { timeout: 30_000 });
    const [request] = await textsAtProvider();
    expect(await textsAtProvider()).toHaveLength(1);
    const sent = new Map(request?.form);
    expect([...sent.keys()].sort()).toEqual(['Body', 'From', 'StatusCallback', 'To']);
    expect(sent.get('To')).toBe(MAYA.phone);
    expect(sent.get('From')).toBe(account.number);
    expect(sent.get('Body')).toBe('12 Lake Road, the blue door.');
    await twilioReports(sent.get('StatusCallback') ?? '', request?.sid ?? '', 'delivered');
    await expect(reply).toContainText('Delivered', { timeout: 30_000 });
  });

  await test.step('no double send: an answer nobody could read is never sent again, and its report settles it', async () => {
    // Twilio may or may not have created this one: a 502 from something in between.
    await twilio.failNextCreateUnreadably();
    const reply = await sendText('Parking is behind the studio.');
    await expect(reply).toContainText('Delivery not confirmed', { timeout: 30_000 });
    await expect(reply).toContainText("It wasn't sent again, to avoid a duplicate.");
    expect(await textsAtProvider()).toHaveLength(2);
    // Every dispatch job of the day runs again, as retries and duplicates would.
    expect(await dispatchEverythingAgain()).toBe(3);
    expect(await dispatchEverythingAgain()).toBe(3);
    expect(await textsAtProvider()).toHaveLength(2);
    expect(await mailDeliveredTo(MAYA.email)).toHaveLength(1);
    await expect(reply).toContainText('Delivery not confirmed');
    // The report names our message in its address, so it settles the send.
    const [, unreadable] = await textsAtProvider();
    expect(unreadable).toMatchObject({ sid: null, answered: 502 });
    const callbackUrl = new Map(unreadable?.form).get('StatusCallback') ?? '';
    await twilioReports(callbackUrl, twilio.newMessageSid(), 'delivered');
    await expect(reply).toContainText('Delivered', { timeout: 30_000 });
    await expect(reply).not.toContainText('Delivery not confirmed');
  });

  await test.step('web chat: a visitor on the website writes, and the reply reaches their chat', async () => {
    const website = await startWebsite();
    try {
      await page.goto(day('/settings/webchat'));
      await page.getByRole('button', { name: 'Add a chat widget', exact: true }).click();
      const widget = page.getByRole('region', { name: 'New chat widget', exact: true });
      await widget.getByLabel('Name', { exact: true }).fill('Studio website');
      await widget
        .getByLabel('Websites that may show this chat', { exact: true })
        .fill(website.origin);
      await widget.getByRole('button', { name: 'Add the widget', exact: true }).click();
      const card = page.getByRole('region', { name: 'Studio website', exact: true });
      const code = await card.getByText(/^<script async src=/).textContent();
      const key = /data-widget-key="([A-Za-z0-9_-]{32})"/.exec(code ?? '')?.[1];
      if (key === undefined) throw new Error(`No key in the code shown: ${code ?? ''}`);
      website.show(key);

      // The visitor's own browser: no session, and none of the test's headers.
      const visitorContext = await browser.newContext({
        extraHTTPHeaders: {},
        ignoreHTTPSErrors: true,
        viewport: { width: 360, height: 740 },
      });
      const visitor = await visitorContext.newPage();
      await visitor.goto(`${website.origin}/`);
      await visitor.getByRole('button', { name: 'Chat with us' }).click();
      const chat = visitor.getByRole('dialog', { name: 'Chat with us' });
      await chat.getByRole('textbox', { name: 'Name' }).fill(VISITOR.name);
      await chat.getByRole('textbox', { name: 'Email' }).fill(VISITOR.email);
      await chat
        .getByRole('textbox', { name: 'Message' })
        .fill('Do you rent the studio by the hour?');
      await chat.getByRole('button', { name: 'Start chat' }).click();
      const log = chat.getByRole('log');
      await expect(log).toContainText('Do you rent the studio by the hour?');

      await page.goto(day('/inbox'));
      const row = rowOf(page, VISITOR.name);
      await expect(row).toContainText('Do you rent the studio by the hour?');
      await expect(row).toContainText('Unverified');
      await row.click();
      const chatForm = replyFormOf(page, VISITOR.name);
      // The visitor typed an email address too, so the composer offers email first.
      await choose(chatForm.getByRole('combobox', { name: 'Send by', exact: true }), {
        label: 'Web chat',
      });
      await expect(chatForm.getByRole('combobox', { name: 'From', exact: true })).toContainText(
        'Studio website',
      );
      await chatForm
        .getByLabel(`Message to ${VISITOR.name}`, { exact: true })
        .fill('Yes: 40 dollars an hour, two hours at least.');
      await chatForm.getByRole('button', { name: 'Send chat message', exact: true }).click();
      await expect(
        threadOf(page, VISITOR.name).locator('li[data-direction="outbound"]'),
      ).toContainText('Yes: 40 dollars an hour, two hours at least.');
      await expect(log).toContainText('Yes: 40 dollars an hour, two hours at least.', {
        timeout: 20_000,
      });
      // The visitor answers, and the open thread shows it.
      await chat.getByRole('textbox', { name: 'Message' }).fill('Great, thank you.');
      await chat.getByRole('textbox', { name: 'Message' }).press('Enter');
      await expect(
        threadOf(page, VISITOR.name).locator('li[data-direction="inbound"]'),
      ).toHaveCount(2, { timeout: 20_000 });
      await visitorContext.close();
    } finally {
      await website.close();
    }
  });

  await test.step('STOP: her keyword withdraws consent with its proof, and the next text is refused at once', async () => {
    await rowOf(page, MAYA.name).click();
    await expect(inbound).toHaveCount(2);
    await mayaTexts('STOP');
    await expect(inbound).toHaveCount(3, { timeout: 30_000 });
    await expect(inbound.last()).toContainText('STOP');

    const refused = await sendText('See you on the 13th.');
    const alert = page.getByRole('alert').filter({ hasText: "Your reply wasn't sent." });
    await expect(alert).toContainText(
      'This contact withdrew their agreement to receive these messages.',
    );
    await expect(refused).toContainText('Not sent');
    // Nothing went to the provider for it.
    expect(await textsAtProvider()).toHaveLength(2);

    // Her page says so, and keeps the keyword as the proof.
    await page.goto(day(`/contacts/${maya.id}?tab=dnd`));
    const panel = page.getByRole('region', { name: 'Consent', exact: true });
    const serviceTexts = panel
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Service texts', exact: true }) });
    await expect(serviceTexts.getByText('Consent withdrawn')).toBeVisible();
    await expect(serviceTexts.getByText("These aren't sent.")).toBeVisible();
    await panel.getByText(/^History and proof \(\d+\)$/).click();
    await expect(panel.getByText('Keyword: STOP').first()).toBeVisible();
    // Email is another channel: her agreement to it stands.
    await expect(
      panel
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: 'Service email', exact: true }) })
        .getByText('Consent given'),
    ).toBeVisible();
  });

  await test.step('no double sends: after every job has run again, each message that left went to its provider once', async () => {
    expect(await dispatchEverythingAgain()).toBe(5);
    const provider = await twilio.state();
    // Each outbound message, with how often its provider was asked to send it.
    const ledger = await dayQuery<{ channel: string; text: string; status: string }>(
      `select channel, body_text as text, status from messaging.messages
       where direction = 'outbound' order by created_at, id`,
    );
    expect(ledger).toEqual([
      { channel: 'email', text: 'Yes, June 13 is open.', status: 'sent' },
      { channel: 'sms', text: '12 Lake Road, the blue door.', status: 'delivered' },
      { channel: 'sms', text: 'Parking is behind the studio.', status: 'delivered' },
      { channel: 'webchat', text: 'Yes: 40 dollars an hour, two hours at least.', status: 'sent' },
      { channel: 'sms', text: 'See you on the 13th.', status: 'failed' },
    ]);
    expect((await textsAtProvider()).map((each) => new Map(each.form).get('Body'))).toEqual([
      '12 Lake Road, the blue door.',
      'Parking is behind the studio.',
    ]);
    expect((await mailDeliveredTo(MAYA.email)).map((each) => each.subject)).toEqual([
      'Re: June 13',
    ]);
    // The mailbox's own test message is the only other mail the install ever sent.
    expect(await mailDeliveredTo(VISITOR.email)).toEqual([]);
    // Twilio was asked for the account, its numbers and those two messages; nothing else.
    expect(provider.unexpected).toEqual([]);
    expect(
      provider.reads
        .filter((each) => each.path.includes(account.accountSid))
        .map((each) => each.path.replace(/\?.*$/, '')),
    ).toEqual([
      `/2010-04-01/Accounts/${account.accountSid}.json`,
      `/2010-04-01/Accounts/${account.accountSid}/IncomingPhoneNumbers.json`,
    ]);
  });
});
