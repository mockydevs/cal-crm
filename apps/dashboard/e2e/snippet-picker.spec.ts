// Marketing, stage 1: a snippet put into a reply from the composer's picker, by its button
// and by a typed "/", filled in for the conversation's contact; Marketing's three pages at
// their addresses; and the earlier addresses, which lead to them. The API is stood in for,
// as in the other specs.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  sendConversationReplyInput,
  type ConversationComposer,
  type ThreadItem,
} from '@repo/contracts';
import type * as z from 'zod';
import { noAssistant } from './assistant-fixtures';
import { plainContactDetails } from './contact-panels';
import {
  fakeSnippetsApi,
  fakeTriggerLinksApi,
  linkOf,
  snippetFolderOf,
  snippetOf,
  type SnippetsApi,
} from './conversation-extras-fixtures';
import {
  bookings,
  composerOf,
  conversationId,
  conversationOf,
  maya,
  mayaPhone,
  messageId,
  messageOf,
} from './inbox-fixtures';
import { inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';
import { templateOf, templateServer } from './template-fixtures';

type Reply = z.output<typeof sendConversationReplyInput>;

const shots = 'reports/marketing-1';
const mayaId = conversationId('1');
const line = { id: bookings.id, name: 'Main line', address: '+15550100000' };

const axe = async (page: Page): Promise<unknown[]> =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze()
  ).violations;
const noOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const quick = snippetFolderOf(1, 'Quick replies');
const snippets = () => [
  snippetOf(1, 'Directions', 'Park at the back, by the blue door.'),
  snippetOf(
    2,
    'Hello',
    'Hi {{contact.first_name}}, thanks for writing. {{trigger_link.spring_offer}}',
    {
      folderId: quick.id,
      mergeFields: ['contact.first_name', 'trigger_link.spring_offer'],
    },
  ),
  snippetOf(3, 'Welcome', 'Welcome aboard, {{contact.first_name}}.', {
    type: 'email',
    subject: 'Welcome to Harbor Lights',
    folderId: quick.id,
    mergeFields: ['contact.first_name'],
  }),
  snippetOf(4, 'Pricing guide', 'Our day rate is $900, {{contact.first_name}}.', {
    type: 'email',
    subject: 'Our prices',
    mergeFields: ['contact.first_name'],
  }),
];
const mayasValues = {
  'contact.first_name': 'Maya',
  'trigger_link.spring_offer': 'https://harbor.example/l/abc123',
};

/** A text message can be sent as well as an email. */
const textAndEmail = (): ConversationComposer => {
  const email = composerOf().channels[0];
  if (email === undefined) throw new Error('No email channel.');
  return composerOf({
    suggestedChannel: 'sms',
    channels: [
      email,
      {
        channel: 'sms',
        available: true,
        unavailable: null,
        accounts: [line],
        recipients: [mayaPhone],
      },
    ],
  });
};

interface Inbox {
  readonly replies: Reply[];
  readonly snippets: SnippetsApi;
}

/** Stands in for one conversation of the Inbox, with Maya, and for the snippets. */
async function openConversation(
  page: Page,
  composer: ConversationComposer = composerOf(),
): Promise<Inbox> {
  await signedIn(page);
  const replies: Reply[] = [];
  const conversation = conversationOf({ id: mayaId });
  let thread: ThreadItem[] = [messageOf({ id: messageId('2') })];
  await page.route(/\/api\/v1\/inbox\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(/\/api\/v1\/inbox\/summary$/, (route) =>
    route.fulfill({ json: { unreadConversations: 1, unreadMessages: 2, needsReply: 1 } }),
  );
  await page.route(/\/api\/v1\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { canManage: true, canReply: true, items: [conversation], nextCursor: null },
    }),
  );
  await page.route(/\/api\/v1\/contacts\/con_[^/?]+$/, (route) =>
    route.fulfill({
      json: {
        id: maya.id,
        firstName: 'Maya',
        lastName: 'Thompson',
        name: maya.name,
        emails: ['maya@example.test'],
        phones: [],
        timeZone: null,
        doNotContact: false,
        preferencesRevision: 'a'.repeat(64),
        createdAt: '2026-10-01T09:00:00.000Z',
        updatedAt: '2026-10-01T09:00:00.000Z',
        trashedAt: null,
        canManage: true,
      },
    }),
  );
  await plainContactDetails(page);
  await page.route(/\/api\/v1\/records\/con_[^/]+\/fields$/, (route) =>
    route.fulfill({ json: { items: [], canManage: true, canConfirm: true } }),
  );
  await page.route(/\/api\/v1\/records\/con_[^/]+\/tags$/, (route) =>
    route.fulfill({ json: { items: [], canManage: true } }),
  );
  await page.route('**/api/v1/tag-configuration', (route) =>
    route.fulfill({ json: configurationOf([]) }),
  );
  await page.route(/\/api\/v1\/conversations\/cvn_[^/?]+(?:\/[a-z]+)?(?:\?.*)?$/, (route) => {
    const request = route.request();
    const action = /\/conversations\/cvn_[^/?]+\/([a-z]+)/.exec(
      new URL(request.url()).pathname,
    )?.[1];
    if (request.method() === 'GET')
      return route.fulfill({
        json:
          action === 'messages'
            ? { items: thread, nextCursor: null }
            : action === 'composer'
              ? composer
              : action === 'assistant'
                ? noAssistant()
                : conversation,
      });
    if (action === 'read') return route.fulfill({ json: { ...conversation, unreadCount: 0 } });
    if (action !== 'replies') return route.fulfill({ status: 404, json: {} });
    const reply = sendConversationReplyInput.parse(request.postDataJSON());
    replies.push(reply);
    const sent = messageOf({
      id: messageId(String(4 + replies.length)),
      direction: 'outbound',
      channel: reply.channel,
      author: { kind: 'user', name: 'Dana Brooks', you: true },
      status: 'queued',
      subject: reply.subject,
      text: reply.text,
      createdAt: new Date().toISOString(),
    });
    thread = [sent, ...thread];
    return route.fulfill({ status: 201, json: sent });
  });
  const api = await fakeSnippetsApi(page, { folders: [{ ...quick }], snippets: snippets() });
  api.values = { ...mayasValues };
  await page.goto(inHarbor(`/inbox?conversation=${mayaId}`));
  await expect(replyForm(page)).toBeVisible();
  return { replies, snippets: api };
}

const replyForm = (page: Page): Locator =>
  page.getByRole('form', { name: 'Reply to Maya Thompson', exact: true });
const message = (page: Page): Locator =>
  replyForm(page).getByRole('textbox', { name: 'Message to Maya Thompson', exact: true });
const snippetsButton = (page: Page): Locator =>
  replyForm(page).getByRole('button', { name: 'Snippets', exact: true });
const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'Snippets', exact: true });

for (const width of [1440, 360]) {
  test(`puts an email snippet into a reply from the Snippets button, filled in, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const inbox = await openConversation(page);
    await expect(snippetsButton(page)).toHaveAttribute('aria-expanded', 'false');
    await message(page).fill('Thanks for asking. ');
    await snippetsButton(page).click();
    await expect(snippetsButton(page)).toHaveAttribute('aria-expanded', 'true');

    // An email takes email snippets only, by folder, and the search holds the keyboard.
    const search = picker(page).getByRole('combobox', { name: 'Search email snippets' });
    await expect(search).toBeFocused();
    const list = picker(page).getByRole('listbox', { name: 'Email snippets', exact: true });
    await expect(list.getByRole('option')).toHaveCount(2);
    await expect(list.getByRole('group')).toHaveCount(2);
    await expect(list.getByRole('group', { name: 'Quick replies' }).getByRole('option')).toHaveText(
      [/^Welcome/],
    );
    await expect(list).not.toContainText('Directions');
    await expect(picker(page).getByRole('status')).toHaveText('2 snippets');
    expect(inbox.snippets.listed.at(-1)?.get('type')).toBe('email');
    // A merge field shows as one until it is filled in.
    await expect(list.getByText('{{contact.first_name}}').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    // Inside the window, whatever its width.
    const box = await picker(page).boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${shots}/picker-${String(width)}.png` });

    // Searched on the server; the arrows and Enter choose.
    await search.pressSequentially('pric');
    await expect(list.getByRole('option')).toHaveText([/^Pricing guide/]);
    expect(inbox.snippets.listed.at(-1)?.get('q')).toBe('pric');
    await expect(search).toHaveAttribute(
      'aria-activedescendant',
      (await list.getByRole('option').getAttribute('id')) ?? '',
    );
    await page.keyboard.press('Enter');

    // Filled in for Maya by the server, at the caret, and the keyboard is back in the message.
    await expect(picker(page)).toBeHidden();
    await expect(message(page)).toHaveValue('Thanks for asking. Our day rate is $900, Maya.');
    await expect(message(page)).toBeFocused();
    expect(inbox.snippets.rendered).toEqual([{ snippetId: snippets()[3]?.id, contactId: maya.id }]);
    // The reply's own subject is kept: it is what threads it.
    await expect(replyForm(page).getByLabel('Subject', { exact: true })).toHaveValue('Re: June 13');
    await expect(replyForm(page).getByText(/Still to fill in/)).toHaveCount(0);

    await replyForm(page).getByRole('button', { name: 'Send email', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Reply queued to send.' }),
    ).toBeVisible();
    expect(inbox.replies).toHaveLength(1);
    expect(inbox.replies[0]).toMatchObject({
      channel: 'email',
      subject: 'Re: June 13',
      text: 'Thanks for asking. Our day rate is $900, Maya.',
    });
  });
}

test('a "/" at the start of a word opens the picker, and the snippet takes its place', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const inbox = await openConversation(page, textAndEmail());
  await message(page).click();
  // Not inside a word, and not in a date.
  await page.keyboard.type('See you 10/12 and/or later. ');
  await expect(picker(page)).toBeHidden();
  await page.keyboard.type('/');
  const search = picker(page).getByRole('combobox', { name: 'Search text snippets' });
  await expect(search).toBeFocused();
  // A text message takes text snippets only.
  const list = picker(page).getByRole('listbox', { name: 'Text snippets', exact: true });
  await expect(list.getByRole('option')).toHaveText([/^Directions/, /^Hello/]);
  expect(inbox.snippets.listed.at(-1)?.get('type')).toBe('text');
  await page.keyboard.type('hel');
  await expect(list.getByRole('option')).toHaveText([/^Hello/]);
  await page.keyboard.press('Enter');
  await expect(picker(page)).toBeHidden();
  // The "/" is gone; the name and the trigger link are this contact's own.
  await expect(message(page)).toHaveValue(
    'See you 10/12 and/or later. Hi Maya, thanks for writing. https://harbor.example/l/abc123',
  );
  await expect(message(page)).toBeFocused();

  // It was typed in, so the browser's own undo takes it back.
  await page.keyboard.press('Control+z');
  await expect(message(page)).toHaveValue('See you 10/12 and/or later. /');
  await page.keyboard.press('Control+Shift+z');
  await expect(message(page)).toHaveValue(
    'See you 10/12 and/or later. Hi Maya, thanks for writing. https://harbor.example/l/abc123',
  );

  await replyForm(page).getByRole('button', { name: 'Send text message', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(inbox.replies[0]).toMatchObject({
    channel: 'sms',
    text: 'See you 10/12 and/or later. Hi Maya, thanks for writing. https://harbor.example/l/abc123',
  });
});

test('Escape closes the picker and leaves what was typed, and a press elsewhere closes it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConversation(page, textAndEmail());
  await message(page).click();
  await page.keyboard.type('Use /');
  await expect(picker(page).getByRole('combobox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toBeHidden();
  // The conversation is still open: only the picker closed.
  await expect(replyForm(page)).toBeVisible();
  await expect(message(page)).toHaveValue('Use /');
  await expect(message(page)).toBeFocused();
  // The same word does not open it again.
  await page.keyboard.type('tmp');
  await expect(message(page)).toHaveValue('Use /tmp');
  await expect(picker(page)).toBeHidden();

  await snippetsButton(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole('link', { name: 'Manage snippets' })).toHaveAttribute(
    'href',
    inHarbor('/marketing/snippets'),
  );
  await page.getByRole('heading', { level: 1, name: 'Conversations', exact: true }).click();
  await expect(picker(page)).toBeHidden();
  await expect(message(page)).toHaveValue('Use /tmp');
});

test('names a field the contact has no value for, and marks it in the message if put in unfilled', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const inbox = await openConversation(page, textAndEmail());
  inbox.snippets.values = { 'trigger_link.spring_offer': 'https://harbor.example/l/abc123' };
  await snippetsButton(page).click();
  await picker(page)
    .getByRole('option', { name: /^Hello/ })
    .click();
  const refusal = picker(page).getByRole('alert');
  await expect(refusal).toContainText(
    'Maya Thompson has no value for {{contact.first_name}}, which “Hello” uses.',
  );
  await expect(message(page)).toHaveValue('');
  expect(await axe(page)).toEqual([]);
  await refusal.getByRole('button', { name: 'Insert with the fields unfilled' }).click();
  await expect(picker(page)).toBeHidden();
  await expect(message(page)).toHaveValue(
    'Hi {{contact.first_name}}, thanks for writing. {{trigger_link.spring_offer}}',
  );
  await expect(replyForm(page).getByText(/Still to fill in/)).toHaveText(
    'Still to fill in: {{contact.first_name}}, {{trigger_link.spring_offer}}. A reply is sent as it is written, so replace each one before you send.',
  );
  expect(await axe(page)).toEqual([]);
  await message(page).fill('Hi Maya, thanks for writing.');
  await expect(replyForm(page).getByText(/Still to fill in/)).toHaveCount(0);
});

for (const moved of [
  { from: '/settings/templates', to: '/marketing/emails/templates', heading: 'Email templates' },
  { from: '/inbox/snippets', to: '/marketing/snippets', heading: 'Snippets' },
  { from: '/inbox/trigger-links', to: '/marketing/trigger-links', heading: 'Trigger Links' },
]) {
  test(`${moved.from} leads to ${moved.to}, keeping what its address carried`, async ({ page }) => {
    await signedIn(page);
    await templateServer(page, []);
    await fakeSnippetsApi(page);
    await fakeTriggerLinksApi(page);
    await page.goto(inHarbor(`${moved.from}?from=bookmark`));
    await expect(page.getByRole('heading', { level: 1, name: moved.heading })).toBeVisible();
    await expect(page).toHaveURL(inHarbor(`${moved.to}?from=bookmark`));
    await expect(page.getByRole('banner').getByRole('link', { name: 'Marketing' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
}

for (const width of [1440, 360]) {
  test(`Marketing has Emails, Snippets and Trigger Links, each a working page, at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signedIn(page);
    await templateServer(page, [templateOf({ name: 'Pricing guide' })]);
    await fakeSnippetsApi(page, { folders: [{ ...quick }], snippets: snippets() });
    await fakeTriggerLinksApi(page, {
      links: [linkOf(1, 'Spring Offer', 'https://harborlights.example/spring', { clicks: 3 })],
    });
    await page.goto(inHarbor('/marketing'));
    // Emails opens on Campaigns, the first of its pages (e2e/campaigns.spec.ts); Templates
    // is the page beside it.
    await expect(page).toHaveURL(inHarbor('/marketing/emails/campaigns'));
    await page
      .getByRole('navigation', { name: 'Emails', exact: true })
      .getByRole('link', { name: 'Templates' })
      .click();
    await expect(page).toHaveURL(inHarbor('/marketing/emails/templates'));
    await expect(page.getByRole('heading', { level: 1, name: 'Email templates' })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Marketing', exact: true }).getByRole('link');
    // Only what is built: no tab leads to a page that does nothing.
    await expect(tabs).toHaveText(['Emails', 'Snippets', 'Trigger Links']);
    await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'page');
    const emails = page.getByRole('navigation', { name: 'Emails', exact: true }).getByRole('link');
    await expect(emails).toHaveText(['Campaigns', 'Templates']);
    await expect(emails.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Pricing guide', { exact: true })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({
      path: `${shots}/emails-templates-${String(width)}.png`,
      fullPage: true,
    });

    await tabs.nth(1).click();
    await expect(page).toHaveURL(inHarbor('/marketing/snippets'));
    await expect(page.getByRole('heading', { level: 1, name: 'Snippets' })).toBeVisible();
    await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'page');
    const table = page.getByRole('region', { name: 'Snippets table', exact: true });
    await expect(table.getByRole('row')).toHaveCount(5);
    await table.getByRole('checkbox', { name: 'Select Directions', exact: true }).check();
    await expect(page.getByRole('group', { name: 'Selected snippets' })).toContainText(
      '1 selected',
    );
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: `${shots}/snippets-${String(width)}.png`, fullPage: true });

    await tabs.nth(2).click();
    await expect(page).toHaveURL(inHarbor('/marketing/trigger-links'));
    await expect(page.getByRole('heading', { level: 1, name: 'Trigger Links' })).toBeVisible();
    await expect(tabs.nth(2)).toHaveAttribute('aria-current', 'page');
    await expect(
      page.getByRole('region', { name: 'Links table', exact: true }).getByRole('row'),
    ).toHaveCount(2);
    expect(await axe(page)).toEqual([]);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: `${shots}/trigger-links-${String(width)}.png`, fullPage: true });
  });
}

test('Conversations lists Snippets and Trigger Links too, and both lead to Marketing’s pages', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConversation(page);
  const tabs = page
    .getByRole('navigation', { name: 'Conversations', exact: true })
    .getByRole('link');
  await expect(tabs).toHaveText([
    'Conversations',
    'Call history',
    'Manual Actions',
    'Snippets',
    'Trigger Links',
  ]);
  await expect(tabs.nth(3)).toHaveAttribute('href', inHarbor('/marketing/snippets'));
  await expect(tabs.nth(4)).toHaveAttribute('href', inHarbor('/marketing/trigger-links'));
  await tabs.nth(3).click();
  // One page, two doors: the page is Marketing's.
  await expect(page).toHaveURL(inHarbor('/marketing/snippets'));
  await expect(page.getByRole('heading', { level: 1, name: 'Snippets' })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Marketing', exact: true })
      .getByRole('link', { name: 'Snippets', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});
