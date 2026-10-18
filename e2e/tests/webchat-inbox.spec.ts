// Web chat on the whole product: the built server with its worker, the built dashboard and
// the built widget over a migrated Postgres, and a business's website on another origin. A
// team member sets the widget up in Settings, a visitor chats from the website, the message
// arrives in the Inbox marked unverified, and the reply typed in the Inbox shows in the
// visitor's chat. Nothing stands in for anything.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { contact, me } from '@repo/contracts';

import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, query, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.150'));

const PAGE = readFileSync(
  fileURLToPath(new URL('./webchat-test-page.html', import.meta.url)),
  'utf8',
);

interface Website {
  readonly origin: string;
  /** Sets the widget key the page carries. */
  show(key: string): void;
  close(): Promise<void>;
}

/**
 * A business's own website, on its own origin, with a policy a careful website has:
 * scripts and connections only to the CRM, and no inline script or style.
 */
async function startWebsite(): Promise<Website> {
  const crm = address('app');
  let key = '';
  const server: Server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src ${crm}; connect-src ${crm}; base-uri 'none'; form-action 'none'`,
      })
      .end(PAGE.replaceAll('{{CRM}}', crm).replaceAll('{{KEY}}', key));
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

let website: Website;
test.beforeEach(async () => {
  website = await startWebsite();
});
test.afterEach(async () => {
  await website.close();
});

const launcher = (page: Page): Locator => page.getByRole('button', { name: 'Chat with us' });
const panel = (page: Page): Locator => page.getByRole('dialog', { name: 'Chat with us' });
const audit = async (page: Page): Promise<unknown[]> =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
    .violations;

/** Signs someone in and adds a chat widget for the website in Settings. Returns its key. */
async function setUpWidget(page: Page, name: string): Promise<string> {
  const person = await newPerson();
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  await page.goto(inOurs('/settings/business'));
  await page.getByRole('link', { name: 'Go Back', exact: true }).click();
  await page.getByRole('link', { name: 'Sites', exact: true }).click();
  await page.getByRole('link', { name: 'Chat Widget', exact: true }).click();
  await page.getByRole('button', { name: 'Add a chat widget', exact: true }).click();
  const form = page.getByRole('region', { name: 'New chat widget', exact: true });
  await form.getByLabel('Name', { exact: true }).fill(name);
  // With a path and a trailing slash, as someone copies it from the address bar: the
  // server stores the origin alone.
  await form
    .getByLabel('Websites that may show this chat', { exact: true })
    .fill(`${website.origin}/`);
  await form.getByRole('button', { name: 'Add the widget', exact: true }).click();
  const card = page.getByRole('region', { name, exact: true });
  await expect(card.getByText(website.origin, { exact: true })).toBeVisible();
  const code = await card.getByText(/^<script async src=/).textContent();
  const key = /data-widget-key="([A-Za-z0-9_-]{32})"/.exec(code ?? '')?.[1];
  if (key === undefined) throw new Error(`No key in the code shown: ${code ?? ''}`);
  expect(code).toContain(`src="${address('app')}/webchat/widget.js"`);
  return key;
}

test('a visitor chats from a website, the Inbox marks them unverified, and the reply reaches their chat', async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = randomUUID().slice(0, 8);
  const key = await setUpWidget(page, `Website ${suffix}`);
  website.show(key);

  // A contact the business already has, with a conversation of her own.
  const api = `${address('app')}/api/v1`;
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === ours.slug);
  if (business === undefined) throw new Error('The web chat fixture has no business.');
  const mayaName = `Maya ${suffix}`;
  const mayaEmail = `maya-${suffix}@example.test`;
  const created = await page.request.post(`${api}/contacts`, {
    headers: { 'Business-Id': business.id, Origin: address('app') },
    data: { firstName: mayaName, emails: [mayaEmail] },
  });
  expect(created.status(), await created.text()).toBe(201);
  const maya = contact.parse(await created.json());
  const secret = `Maya's deposit is 400 dollars ${suffix}`;
  await query(
    `with thread as (
       insert into messaging.conversations (business_id, contact_id)
       select c.business_id, c.id from crm.contact_identities i
       join crm.contacts c on c.business_id = i.business_id and c.id = i.contact_id
       where i.value_normalized = $1
       returning business_id, id, contact_id
     )
     insert into messaging.messages (business_id, conversation_id, channel,
       channel_account_id, direction, status, body_text, author_kind, author_id)
     select thread.business_id, thread.id, 'webchat', account.id, 'inbound', 'received', $2,
       'contact', thread.contact_id
     from thread join messaging.channel_accounts account
       on account.business_id = thread.business_id and account.channel = 'webchat'
       and account.name = $3`,
    [mayaEmail, secret, `Website ${suffix}`],
  );
  const [holder] = await query<{ contact_id: string }>(
    `select contact_id from crm.contact_identities where value_normalized = $1`,
    [mayaEmail],
  );
  if (holder === undefined) throw new Error('The contact fixture was not stored.');

  // Someone else, on the website, types Maya's address as their own.
  // A context of its own: no session, no cookie. And no X-Forwarded-For of the test's: a
  // header added to the widget's cross-origin requests would need the server's leave in a
  // preflight, which a real visitor's browser never asks for.
  const visitorContext = await browser.newContext({
    extraHTTPHeaders: {},
    viewport: { width: 360, height: 740 },
  });
  const visitor = await visitorContext.newPage();
  const thrown: string[] = [];
  visitor.on('pageerror', (error) => thrown.push(error.message));
  await visitor.goto(`${website.origin}/`);
  await expect(launcher(visitor)).toBeVisible();
  expect(await audit(visitor)).toEqual([]);
  await launcher(visitor).click();
  const visitorName = `Mallory ${suffix}`;
  await panel(visitor).getByRole('textbox', { name: 'Name' }).fill(visitorName);
  await panel(visitor).getByRole('textbox', { name: 'Email' }).fill(mayaEmail.toUpperCase());
  await panel(visitor).getByRole('textbox', { name: 'Message' }).fill('What did I pay so far?');
  expect(await audit(visitor)).toEqual([]);
  await panel(visitor).getByRole('button', { name: 'Start chat' }).click();
  const log = panel(visitor).getByRole('log');
  await expect(log).toContainText('What did I pay so far?');
  // The typed address opened nothing of Maya's: the chat holds the visitor's words only.
  await expect(log).not.toContainText(secret);
  // No cookie from the CRM, and the panel fits a phone.
  expect(await visitorContext.cookies()).toEqual([]);
  expect(
    await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  // In the Inbox: a conversation of its own, marked unverified, naming who holds the address.
  await page.goto(inOurs('/inbox'));
  const list = page.getByRole('region', { name: 'Conversations', exact: true });
  const row = list.getByRole('link', { name: new RegExp(visitorName) });
  await expect(row).toContainText('What did I pay so far?');
  await expect(row).toContainText('Unverified');
  await expect(row).toContainText('Web chat');
  await row.click();
  const thread = page.getByRole('region', { name: visitorName, exact: true });
  const note = thread.getByRole('note', { name: 'Unverified identity', exact: true });
  await expect(note).toContainText('Their name and email address are only what they typed.');
  await expect(note).toContainText(`The email address they typed already belongs to ${mayaName}.`);
  await expect(note.getByRole('link', { name: `Open ${mayaName}`, exact: true })).toHaveAttribute(
    'href',
    new RegExp(`/contacts/${maya.id}$`),
  );
  const messages = page.getByRole('region', { name: `Messages with ${visitorName}`, exact: true });
  await expect(messages.locator('li[data-direction="inbound"]')).toHaveCount(1);
  await expect(messages).not.toContainText(secret);
  expect(await audit(page)).toEqual([]);

  // The database agrees: two contacts, and Maya's own conversation untouched.
  const [stored] = await query<{ separate: boolean; claimed: boolean; held: string }>(
    `select s.contact_id <> $1::uuid as separate, s.claimed_contact_id = $1::uuid as claimed,
       (select count(*) from crm.contact_identities i
        where i.business_id = s.business_id and i.contact_id = s.contact_id)::text as held
     from messaging.webchat_sessions s
     join crm.contact_identities own on own.business_id = s.business_id
       and own.contact_id = s.claimed_contact_id
     where own.value_normalized = $2`,
    [holder.contact_id, mayaEmail],
  );
  expect(stored).toEqual({ separate: true, claimed: true, held: '0' });
  const mayaMessages = await query<{ body_text: string }>(
    `select m.body_text from messaging.messages m
     join messaging.conversations v on v.business_id = m.business_id and v.id = m.conversation_id
     join crm.contact_identities i on i.business_id = v.business_id and i.contact_id = v.contact_id
     where i.value_normalized = $1`,
    [mayaEmail],
  );
  expect(mayaMessages.map((each) => each.body_text)).toEqual([secret]);

  // The reply is typed in the Inbox, with no address to choose, and reaches the chat as text.
  const form = page.getByRole('form', { name: `Reply to ${visitorName}`, exact: true });
  await expect(form.getByRole('combobox', { name: 'From', exact: true })).toContainText(
    `Website ${suffix}`,
  );
  await expect(form.getByText('The visitor, in their chat', { exact: true })).toBeVisible();
  const answer = '<b>Please</b> call us: we can only say that to the account holder.';
  await form.getByLabel(`Message to ${visitorName}`, { exact: true }).fill(answer);
  await form.getByRole('button', { name: 'Send chat message', exact: true }).click();
  const sent = messages.locator('li[data-direction="outbound"]');
  await expect(sent).toContainText(`Web chat to ${visitorName}, from you`);
  await expect(sent).toContainText(answer);
  // The list shows the reply as it was written, angle brackets and all.
  await expect(row).toContainText('Sent: <b>Please</b> call us');
  await expect(log).toContainText(answer, { timeout: 20_000 });
  expect(await log.locator('b, img, script, a').count()).toBe(0);
  expect(await audit(visitor)).toEqual([]);
  await visitor.screenshot({ path: testInfo.outputPath('widget-360.png') });
  await visitor.setViewportSize({ width: 1280, height: 800 });
  await expect(log).toBeVisible();
  expect(await audit(visitor)).toEqual([]);
  await visitor.screenshot({ path: testInfo.outputPath('widget-1280.png') });
  await visitor.setViewportSize({ width: 360, height: 740 });
  await page.screenshot({ path: testInfo.outputPath('inbox-webchat.png') });

  // The visitor answers; the open thread shows it without a reload.
  await panel(visitor).getByRole('textbox', { name: 'Message' }).fill('All right, thank you.');
  await panel(visitor).getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(log).toContainText('All right, thank you.');
  await expect(messages.locator('li[data-direction="inbound"]')).toHaveCount(2, {
    timeout: 20_000,
  });

  // Once the visitor ends the chat, a reply would reach nobody, and the Inbox says so.
  await panel(visitor).getByRole('button', { name: 'End chat' }).click();
  await expect(panel(visitor).getByRole('textbox', { name: 'Name' })).toBeVisible();
  await page.reload();
  await expect(
    page.getByText('Web chat: The visitor has left the chat, so a reply would reach nobody.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send chat message' })).toHaveCount(0);
  // The conversation, its messages and its mark stay for the team.
  await expect(note).toBeVisible();
  await expect(messages.locator('li[data-direction]')).toHaveCount(3);
  expect(thrown).toEqual([]);
  await visitorContext.close();
});

test('only the websites a widget lists get an answer, from the real server', async ({
  page,
  request,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const key = await setUpWidget(page, `Website ${suffix}`);
  const base = `${address('app')}/api/v1/public/webchat/${key}`;

  const allowed = await request.get(base, { headers: { origin: website.origin } });
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()['access-control-allow-origin']).toBe(website.origin);
  expect(allowed.headers()['set-cookie']).toBeUndefined();

  const port = new URL(website.origin).port;
  for (const origin of [
    `http://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    `${website.origin}.evil.test`,
    'https://evil.test',
    'null',
  ]) {
    const refused = await request.get(base, { headers: { origin } });
    expect(refused.status(), origin).toBe(403);
    expect(refused.headers()['access-control-allow-origin'], origin).toBeUndefined();
    const started = await request.post(`${base}/sessions`, {
      headers: { origin, 'content-type': 'application/json' },
      data: { marketingConsent: false },
    });
    expect(started.status(), origin).toBe(403);
  }
  // A key that was never made is the same refusal.
  const unknown = await request.get(`${address('app')}/api/v1/public/webchat/${'A'.repeat(32)}`, {
    headers: { origin: website.origin },
  });
  expect(unknown.status()).toBe(403);
  expect(unknown.headers()['access-control-allow-origin']).toBeUndefined();

  // Turned off in Settings, the widget answers nobody, at once.
  const card = page.getByRole('region', { name: `Website ${suffix}`, exact: true });
  await card.getByRole('button', { name: 'Turn chat off', exact: true }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Chat is off.' })).toBeVisible();
  const off = await request.get(base, { headers: { origin: website.origin } });
  expect(off.status()).toBe(403);
  expect(off.headers()['access-control-allow-origin']).toBeUndefined();
});
