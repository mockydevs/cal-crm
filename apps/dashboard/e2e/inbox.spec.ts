// The Inbox, against a stand-in for the API that keeps conversations in memory and checks
// every write against the contract, and a stand-in for the realtime socket that says
// "something changed in this business" when a test asks it to.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import {
  addConversationNoteInput,
  assignConversationInput,
  bulkConversationsInput,
  conversation as conversationSchema,
  listConversations,
  markConversationReadInput,
  sendConversationReplyInput,
  setConversationStatusInput,
  type BulkConversationsInput,
  type BulkConversationsResult,
  type Conversation,
  type ConversationAssistant,
  type ConversationComposer,
  type ThreadItem,
  type ThreadMessage,
} from '@repo/contracts';
import type * as z from 'zod';
import { noAssistant } from './assistant-fixtures';
import { plainContactDetails } from './contact-panels';
import {
  accountId,
  bookings,
  composerOf,
  conversationId,
  conversationOf,
  dana,
  disturbedChat,
  ken,
  leftChat,
  maya,
  mayaEmail,
  mayaOtherEmail,
  mayaPhone,
  membershipId,
  messageId,
  messageOf,
  noteOf,
  openChat,
  siteChat,
  sofia,
} from './inbox-fixtures';
import { reachesRightGutter } from './lists';
import { choose } from './select';
import { harbor, inHarbor, signedIn } from './session';
import { configurationOf } from './tag-fixtures';

type Reply = z.output<typeof sendConversationReplyInput>;

/** What the stand-in server holds, and what the page asked of it. */
interface World {
  conversations: Conversation[];
  /** Each conversation's items, newest first, as the API answers. */
  threads: Record<string, ThreadItem[]>;
  composer: ConversationComposer;
  /** What the assistant proposes: nothing here, a business with no AI connected. Its own
   * tests are in assistant.spec.ts. */
  assistant: ConversationAssistant;
  canManage: boolean;
  canReply: boolean;
  replies: Reply[];
  notes: string[];
  reads: { conversation: string; through: string }[];
  /** What was asked of many conversations at once: read, unread, star, unstar. */
  bulk: BulkConversationsInput[];
  /** What a reply becomes: queued, unless a test says the pipeline refuses or holds it. */
  outcome: (reply: Reply) => Partial<ThreadMessage>;
  /** Called before a reply is answered: a test can hold the answer, or cut the line. */
  beforeReply: (route: Route) => Promise<'answer' | 'handled'>;
}

const mayaId = conversationId('1');
const kenId = conversationId('2');
const sofiaId = conversationId('3');
const firstMessage = messageOf({
  id: messageId('1'),
  text: 'Hi! We’re getting married on June 13. Is that date still open?',
  createdAt: '2026-10-08T21:38:00.000Z',
});
const secondMessage = messageOf({ id: messageId('2') });

function world(overrides: Partial<World> = {}): World {
  return {
    conversations: [
      conversationOf({
        id: mayaId,
        lastMessage: {
          id: secondMessage.id,
          preview: 'Is June 13 still open? We’d want DJ and video.',
          direction: 'inbound',
          channel: 'email',
          status: 'received',
          at: '2026-10-09T07:58:00.000Z',
        },
      }),
      conversationOf({
        id: kenId,
        contact: ken,
        unreadCount: 0,
        needsReply: false,
        assignee: { membershipId: null, name: 'Dana Brooks', you: true },
        lastActivityAt: '2026-10-09T06:12:00.000Z',
        lastMessage: {
          id: messageId('4'),
          preview: 'Thursday at 3 works for us.',
          direction: 'outbound',
          channel: 'email',
          status: 'delivered',
          at: '2026-10-09T06:12:00.000Z',
        },
      }),
      conversationOf({
        id: sofiaId,
        contact: sofia,
        status: 'closed',
        unreadCount: 0,
        needsReply: false,
        lastActivityAt: '2026-09-28T09:41:00.000Z',
        lastMessage: {
          preview: 'Thanks! Looking at the guide now.',
          direction: 'inbound',
          channel: 'webchat',
          status: 'received',
          at: '2026-09-28T09:41:00.000Z',
        },
      }),
    ],
    threads: {
      [mayaId]: [secondMessage, firstMessage],
      [kenId]: [
        messageOf({
          id: messageId('4'),
          direction: 'outbound',
          status: 'delivered',
          author: { kind: 'user', name: 'Dana Brooks', you: true },
          text: 'Thursday at 3 works for us.',
          subject: null,
        }),
      ],
      [sofiaId]: [],
    },
    composer: composerOf(),
    assistant: noAssistant(),
    canManage: true,
    canReply: true,
    replies: [],
    notes: [],
    reads: [],
    bulk: [],
    outcome: () => ({ status: 'queued' }),
    beforeReply: () => Promise.resolve('answer'),
    ...overrides,
  };
}

const problem = (route: Route, status: number, title: string, detail: string): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    json: { type: 'about:blank', title, status, detail },
  });

/** Stands in for the Inbox's API. Every write is parsed with the contract's own schema. */
async function inboxApi(page: Page, state: World): Promise<void> {
  const find = (id: string): Conversation | undefined =>
    state.conversations.find((each) => each.id === id);
  // What the person may do comes with each conversation, as the API answers it.
  const shown = (each: Conversation): Conversation => ({
    ...each,
    canManage: state.canManage,
    canReply: state.canReply,
  });
  const replace = (next: Conversation): Conversation => {
    state.conversations = state.conversations.map((each) => (each.id === next.id ? next : each));
    return conversationSchema.parse(shown(next));
  };
  let revisions = 0;
  const revised = (): string => String(++revisions).padStart(64, 'b');

  // Who a conversation can be given to: the person signed in and one teammate.
  await page.route(/\/api\/v1\/inbox\/assignees(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        items: [
          { id: membershipId('1'), name: 'Dana Brooks', you: true },
          { id: membershipId('2'), name: 'Sam Lee', you: false },
        ],
        nextCursor: null,
      },
    }),
  );

  await page.route(/\/api\/v1\/inbox\/summary$/, (route) => {
    const open = state.conversations.filter((each) => each.status === 'open');
    return route.fulfill({
      json: {
        unreadConversations: open.filter((each) => each.unreadCount > 0).length,
        unreadMessages: open.reduce((sum, each) => sum + each.unreadCount, 0),
        needsReply: open.filter((each) => each.needsReply).length,
      },
    });
  });

  await page.route(/\/api\/v1\/conversations(?:\?.*)?$/, (route) => {
    expect(route.request().headers()['business-id']).toBe(harbor.id);
    const asked = listConversations.query.parse(
      Object.fromEntries(new URL(route.request().url()).searchParams),
    );
    const items = state.conversations
      .filter((each) => asked.status === 'all' || each.status === asked.status)
      .filter((each) => asked.reply === 'any' || each.needsReply)
      .filter((each) => asked.unread === 'any' || each.unreadCount > 0)
      .filter((each) => asked.starred === 'any' || each.starred === true)
      .filter((each) => asked.contactId === undefined || each.contact.id === asked.contactId)
      .filter((each) => asked.channel === undefined || each.lastMessage?.channel === asked.channel)
      .filter(
        (each) =>
          asked.assignee === 'anyone' ||
          (asked.assignee === 'me' && each.assignee?.you === true) ||
          (asked.assignee === 'unassigned' && each.assignee === null),
      )
      .toSorted((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
      .map(shown);
    return route.fulfill({
      json: { canManage: state.canManage, canReply: state.canReply, items, nextCursor: null },
    });
  });

  // Many conversations at once. Read state and stars are the team's.
  await page.route(/\/api\/v1\/conversations\/bulk$/, async (route) => {
    const input = bulkConversationsInput.parse(route.request().postDataJSON());
    state.bulk.push(input);
    const ids = input.action === 'mark_read' ? input.items.map((item) => item.id) : input.ids;
    const results: BulkConversationsResult['results'] = ids.map((id) => {
      const current = find(id);
      if (current === undefined) {
        return {
          id,
          outcome: 'skipped',
          reason: { code: 'not_found', message: 'No such conversation.' },
        };
      }
      const wrote = (state.threads[id] ?? []).some(
        (item) => item.kind === 'message' && item.direction === 'inbound',
      );
      if (input.action === 'mark_unread' && !wrote) {
        return {
          id,
          outcome: 'skipped',
          reason: { code: 'nothing_to_mark_unread', message: 'Nothing to mark unread.' },
        };
      }
      const next: Conversation =
        input.action === 'star' || input.action === 'unstar'
          ? { ...current, starred: input.action === 'star' }
          : { ...current, unreadCount: input.action === 'mark_unread' ? 1 : 0 };
      const same =
        (next.starred === true) === (current.starred === true) &&
        next.unreadCount > 0 === current.unreadCount > 0;
      if (same) return { id, outcome: 'unchanged', reason: null };
      replace(next);
      return { id, outcome: 'done', reason: null };
    });
    const count = (outcome: string): number =>
      results.filter((each) => each.outcome === outcome).length;
    await route.fulfill({
      json: {
        action: input.action,
        results,
        done: count('done'),
        unchanged: count('unchanged'),
        skipped: count('skipped'),
      } satisfies BulkConversationsResult,
    });
  });

  // The contact a conversation is with, for the pane at the right and the list's search.
  const contactOf = (known: Conversation['contact']): Record<string, unknown> => {
    const [firstName = '', lastName = ''] = known.name.split(' ');
    return {
      id: known.id,
      firstName,
      lastName,
      name: known.name,
      emails: [`${firstName.toLowerCase()}@example.test`],
      phones: [],
      timeZone: null,
      doNotContact: false,
      preferencesRevision: 'a'.repeat(64),
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
      trashedAt: null,
      canManage: true,
    };
  };
  await page.route(/\/api\/v1\/contacts\/con_[^/?]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const known = state.conversations.find((each) => each.contact.id === id)?.contact;
    return known === undefined
      ? problem(route, 404, 'Not Found', 'No such contact.')
      : route.fulfill({ json: contactOf(known) });
  });
  await page.route(/\/api\/v1\/contacts\?/, (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase();
    return route.fulfill({
      json: {
        items: state.conversations
          .map((each) => each.contact)
          .filter((each) => each.name.toLowerCase().includes(q))
          .map((each) => ({
            id: each.id,
            name: each.name,
            email: `${(each.name.split(' ')[0] ?? '').toLowerCase()}@example.test`,
            phone: null,
            createdAt: '2026-10-01T09:00:00.000Z',
          })),
        next: null,
        canManage: true,
      },
    });
  });
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

  await page.route(/\/api\/v1\/conversations\/cvn_[^/?]+(?:\/[a-z]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const [, id = '', action = ''] =
      /\/conversations\/(cvn_[^/?]+)(?:\/([a-z]+))?/.exec(new URL(request.url()).pathname) ?? [];
    const current = find(id);
    if (current === undefined) {
      await problem(route, 404, 'Not Found', 'No such conversation.');
      return;
    }
    const thread = state.threads[id] ?? [];
    if (request.method() === 'GET') {
      await route.fulfill({
        json:
          action === 'messages'
            ? { items: thread, nextCursor: null }
            : action === 'composer'
              ? { ...state.composer, canReply: state.canReply && state.composer.canReply }
              : action === 'assistant'
                ? state.assistant
                : shown(current),
      });
      return;
    }
    if (action === 'read') {
      const { through } = markConversationReadInput.parse(request.postDataJSON());
      state.reads.push({ conversation: id, through });
      // Only messages stored after that one stay unread.
      const after = thread.findIndex((item) => item.id === through);
      const unread = thread
        .slice(0, Math.max(after, 0))
        .filter((item) => item.kind === 'message' && item.direction === 'inbound').length;
      await route.fulfill({ json: replace({ ...current, unreadCount: unread }) });
      return;
    }
    if (action === 'assignee') {
      const input = assignConversationInput.parse(request.postDataJSON());
      if (input.revision !== current.revision) {
        await problem(route, 409, 'Conflict', 'The conversation changed.');
        return;
      }
      await route.fulfill({
        json: replace({
          ...current,
          assignee:
            input.assignee === null ? null : { membershipId: null, name: 'Dana Brooks', you: true },
          revision: revised(),
        }),
      });
      return;
    }
    if (action === 'status') {
      const input = setConversationStatusInput.parse(request.postDataJSON());
      if (input.revision !== current.revision) {
        await problem(route, 409, 'Conflict', 'The conversation changed.');
        return;
      }
      await route.fulfill({
        json: replace({
          ...current,
          status: input.status,
          snoozedUntil: input.status === 'snoozed' ? new Date(input.until).toISOString() : null,
          needsReply: input.status === 'open' ? current.needsReply : false,
          revision: revised(),
        }),
      });
      return;
    }
    if (action === 'notes') {
      const { text } = addConversationNoteInput.parse(request.postDataJSON());
      state.notes.push(text);
      const note = noteOf({
        id: messageId(String.fromCodePoint(96 + state.notes.length)),
        text,
        createdAt: new Date().toISOString(),
      });
      state.threads[id] = [note, ...thread];
      await route.fulfill({ status: 201, json: note });
      return;
    }
    if (action === 'replies') {
      const reply = sendConversationReplyInput.parse(request.postDataJSON());
      if ((await state.beforeReply(route)) === 'handled') return;
      // The same key again answers with the message it already made.
      const known = state.replies.findIndex((each) => each.idempotencyKey === reply.idempotencyKey);
      if (known === -1) state.replies.push(reply);
      const index = known === -1 ? state.replies.length : known + 1;
      const account =
        [bookings, dana, siteChat].find((each) => each.id === reply.accountId) ?? null;
      const message = messageOf({
        id: messageId(String(4 + index)),
        direction: 'outbound',
        channel: reply.channel,
        account,
        author: { kind: 'user', name: 'Dana Brooks', you: true },
        status: 'queued',
        subject: reply.subject,
        text: reply.text,
        from: account?.address ?? null,
        to: [mayaEmail, mayaOtherEmail]
          .filter((each) => each.id === reply.to)
          .map((each) => each.address),
        createdAt: new Date().toISOString(),
        ...state.outcome(reply),
      });
      state.threads[id] = [message, ...thread.filter((item) => item.id !== message.id)];
      await route.fulfill({ status: 201, json: message });
      return;
    }
    await problem(route, 404, 'Not Found', 'No such route.');
  });
}

/**
 * Stands in for the realtime socket (socket.io 4 over Engine.IO 4, websocket only): it
 * opens the connection as the server does, and returns a way to send the one event the
 * dashboard listens for, "business.changed".
 */
async function realtime(page: Page): Promise<{ changed: (businessId?: string) => void }> {
  const sockets: { send: (frame: string) => void }[] = [];
  await page.routeWebSocket(/\/socket\.io\//, (socket) => {
    socket.send(
      `0${JSON.stringify({ sid: 'e2e', upgrades: [], pingInterval: 600_000, pingTimeout: 600_000, maxPayload: 1_000_000 })}`,
    );
    socket.onMessage((frame) => {
      // "40": the client asks to join the default namespace; the server agrees.
      if (typeof frame === 'string' && frame.startsWith('40')) {
        socket.send(`40${JSON.stringify({ sid: 'e2e-socket' })}`);
        sockets.push(socket);
      }
    });
  });
  return {
    changed: (businessId = harbor.id) => {
      for (const socket of sockets) {
        socket.send(`42${JSON.stringify(['business.changed', { businessId }])}`);
      }
    },
  };
}

async function openInbox(page: Page, state: World, search = ''): Promise<void> {
  await signedIn(page);
  await inboxApi(page, state);
  await page.goto(inHarbor(`/inbox${search}`));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Conversations', exact: true }),
  ).toBeVisible();
}

const listOf = (page: Page): Locator =>
  page.getByRole('region', { name: 'Conversations', exact: true });
const threadOf = (page: Page, name = 'Maya Thompson'): Locator =>
  page.getByRole('region', { name, exact: true });
const messagesOf = (page: Page, name = 'Maya Thompson'): Locator =>
  page.getByRole('region', { name: `Messages with ${name}`, exact: true });
const rowOf = (page: Page, name: string): Locator =>
  listOf(page).getByRole('link', { name: new RegExp(name) });
const noOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const axe = async (page: Page): Promise<unknown[]> =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
    .violations;

test('lists open conversations, newest first, with what each needs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInbox(page, world());
  const rows = listOf(page).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Maya Thompson');
  await expect(rows.nth(0)).toContainText('Is June 13 still open? We’d want DJ and video.');
  await expect(rows.nth(0)).toContainText('Needs reply');
  await expect(rows.nth(0)).toContainText('2 unread');
  await expect(rows.nth(0)).toContainText('Email');
  await expect(rows.nth(0)).toContainText('Unassigned');
  await expect(rows.nth(1)).toContainText('Ken Watanabe');
  await expect(rows.nth(1)).toContainText('Sent: Thursday at 3 works for us.');
  await expect(rows.nth(1)).toContainText('Assigned to you');
  await expect(rows.nth(1)).not.toContainText('Needs reply');
  await expect(rows.nth(1)).not.toContainText('unread');
  await expect(
    page.getByText('1 unread conversation · 1 needs reply', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Choose a conversation to read it and reply.')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  expect(await noOverflow(page)).toBe(true);
});

test('filters by status, assignment, needs reply and channel, in the address', async ({ page }) => {
  const state = world();
  await openInbox(page, state);
  const list = listOf(page);
  // Status, channel and needs reply are under Filters, folded away until asked for.
  const filters = list.getByRole('button', { name: /^Filters/ });
  await expect(filters).toHaveAttribute('aria-expanded', 'false');
  await expect(list.getByRole('button', { name: /^Needs reply/ })).toBeHidden();
  await filters.click();
  await expect(filters).toHaveAttribute('aria-expanded', 'true');
  await list.getByRole('button', { name: /^Needs reply/ }).click();
  await expect(page).toHaveURL(/reply=needed/);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(rowOf(page, 'Maya Thompson')).toBeVisible();
  await expect(list.getByRole('button', { name: /^Needs reply/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(filters).toContainText('1 filter chosen');
  await list.getByRole('button', { name: /^Needs reply/ }).click();
  await expect(page).not.toHaveURL(/reply=/);
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // The inbox views are who the conversations are assigned to.
  const view = list.getByRole('combobox', { name: 'Inbox view', exact: true });
  await expect(view).toHaveText('Team inbox');
  await choose(view, 'mine');
  await expect(page).toHaveURL(/assignee=me/);
  await expect(view).toHaveText('My inbox');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(rowOf(page, 'Ken Watanabe')).toBeVisible();
  await choose(view, 'unassigned');
  await expect(page).toHaveURL(/assignee=unassigned/);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(rowOf(page, 'Maya Thompson')).toBeVisible();
  await choose(view, 'team');
  await expect(page).not.toHaveURL(/assignee=/);

  await choose(list.getByRole('combobox', { name: 'Status', exact: true }), 'closed');
  await expect(page).toHaveURL(/status=closed/);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(rowOf(page, 'Sofia Marin')).toContainText('Closed');
  await expect(rowOf(page, 'Sofia Marin')).toContainText('Web chat');

  await choose(list.getByRole('combobox', { name: 'Channel', exact: true }), 'sms');
  await expect(list.getByRole('heading', { name: 'Nothing matches these filters' })).toBeVisible();
  await list.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page).not.toHaveURL(/status=|channel=/);
  await expect(list.getByRole('listitem')).toHaveCount(2);
});

test('says so when there are no conversations, and when they fail to load', async ({ page }) => {
  await openInbox(page, world({ conversations: [], threads: {} }));
  await expect(page.getByRole('heading', { name: 'No conversations yet' })).toBeVisible();
  await expect(page.getByText('Nothing unread', { exact: true })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.route(/\/api\/v1\/conversations(?:\?.*)?$/, (route) =>
    problem(route, 500, 'Internal Server Error', 'Something went wrong on our side.'),
  );
  await page.reload();
  await expect(listOf(page).getByRole('alert')).toContainText("Conversations couldn't be loaded.", {
    timeout: 20_000,
  });
});

test('the tabs show unread, every, recent and starred conversations', async ({ page }) => {
  const state = world();
  state.conversations = state.conversations.map((each) =>
    each.id === sofiaId ? { ...each, starred: true } : each,
  );
  await openInbox(page, state);
  const list = listOf(page);
  const tabs = list.getByRole('navigation', { name: 'Conversation tabs', exact: true });
  const tab = (name: string | RegExp): Locator => tabs.getByRole('link', { name });
  // GoHighLevel's four, in its order. Recent is what is not closed or snoozed away.
  await expect(tabs.getByRole('link')).toHaveText(['Unread1', 'All', 'Recent', 'Starred']);
  await expect(tab('Recent')).toHaveAttribute('aria-current', 'true');
  await expect(list.getByRole('listitem')).toHaveCount(2);

  await tab(/^Unread/).click();
  await expect(page).toHaveURL(/unread=unread/);
  await expect(tab(/^Unread/)).toHaveAttribute('aria-current', 'true');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(rowOf(page, 'Maya Thompson')).toBeVisible();

  await tab('All').click();
  await expect(page).toHaveURL(/status=all/);
  await expect(page).not.toHaveURL(/unread=/);
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(rowOf(page, 'Sofia Marin')).toContainText('Closed');

  // A star is the team's, and shows on a closed conversation too.
  await tab('Starred').click();
  await expect(page).toHaveURL(/starred=only/);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(rowOf(page, 'Sofia Marin')).toContainText('Starred');
  await expect(tabs.locator('[aria-current="true"]')).toHaveText('Starred');

  await tab('Recent').click();
  await expect(page).not.toHaveURL(/starred=|status=|unread=/);
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(rowOf(page, 'Maya Thompson')).not.toContainText('Starred');

  // A tab with nothing in it says so in its own words.
  state.conversations = state.conversations.map((each) => ({ ...each, starred: false }));
  await tab('Starred').click();
  await expect(list.getByRole('heading', { name: 'No starred conversations' })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
});

test('finds one contact by name and shows that contact’s conversation', async ({ page }) => {
  const state = world();
  await openInbox(page, state);
  const list = listOf(page);
  await list.getByRole('searchbox', { name: 'Search by contact', exact: true }).fill('ken');
  const found = list.getByRole('group', { name: 'Matching contacts', exact: true });
  await expect(found.getByRole('button')).toHaveCount(1);
  await found.getByRole('button', { name: /Ken Watanabe/ }).click();
  await expect(page).toHaveURL(new RegExp(`contact=${ken.id}`));
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(rowOf(page, 'Ken Watanabe')).toBeVisible();
  await expect(list.getByRole('searchbox', { name: 'Search by contact', exact: true })).toHaveValue(
    '',
  );
  await list.getByRole('button', { name: 'Show every contact', exact: true }).click();
  await expect(page).not.toHaveURL(/contact=/);
  await expect(list.getByRole('listitem')).toHaveCount(2);
  // Nobody by that name: it says so, and the list stays as it was.
  await list.getByRole('searchbox', { name: 'Search by contact', exact: true }).fill('zed');
  await expect(list.getByText('No contacts match.', { exact: true })).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(2);
});

test('stars a conversation and marks it unread again from the thread', async ({ page }) => {
  const state = world();
  await openInbox(page, state, `?conversation=${mayaId}`);
  const thread = threadOf(page);
  await expect.poll(() => state.reads.length).toBe(1);
  await expect(rowOf(page, 'Maya Thompson')).not.toContainText('unread');

  await thread.getByRole('button', { name: 'Star conversation', exact: true }).click();
  await expect(
    thread.getByRole('status').filter({ hasText: 'Conversation starred.' }),
  ).toBeVisible();
  expect(state.bulk.at(-1)).toEqual({ action: 'star', ids: [mayaId] });
  await expect(rowOf(page, 'Maya Thompson')).toContainText('Starred');
  const star = thread.getByRole('button', { name: 'Remove star', exact: true });
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await star.click();
  await expect(thread.getByRole('status').filter({ hasText: 'Star removed.' })).toBeVisible();
  await expect(rowOf(page, 'Maya Thompson')).not.toContainText('Starred');

  // Marked unread, it stays unread while it stays open here: reading it again is not
  // recorded behind the person's back.
  await thread.getByRole('button', { name: 'Mark as unread', exact: true }).click();
  await expect(thread.getByRole('status').filter({ hasText: 'Marked as unread.' })).toBeVisible();
  expect(state.bulk.at(-1)).toEqual({ action: 'mark_unread', ids: [mayaId] });
  await expect(rowOf(page, 'Maya Thompson')).toContainText('1 unread');
  await page.waitForTimeout(500);
  expect(state.reads).toHaveLength(1);
  await expect(rowOf(page, 'Maya Thompson')).toContainText('1 unread');

  // A conversation the contact never wrote in has nothing to mark, in the dashboard's words.
  await rowOf(page, 'Ken Watanabe').click();
  const kens = threadOf(page, 'Ken Watanabe');
  await kens.getByRole('button', { name: 'Mark as unread', exact: true }).click();
  await expect(kens.getByRole('alert')).toContainText(
    "The contact hasn't written in it, so there is nothing to mark as unread.",
  );
  await expect(kens.getByRole('alert')).not.toContainText('Nothing to mark unread.');
});

test('marks ticked conversations read, and stars them, together', async ({ page }) => {
  const state = world();
  await openInbox(page, state);
  const list = listOf(page);
  const actions = list.getByRole('group', { name: 'Selected conversations', exact: true });
  await expect(actions).toHaveCount(0);
  await list.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  await expect(list.getByText('2 selected', { exact: true })).toBeVisible();
  await expect(list.getByRole('checkbox', { name: 'Select Maya Thompson' })).toBeChecked();
  await actions.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(
    list.getByRole('status').filter({ hasText: '2 conversations marked as read.' }),
  ).toBeVisible();
  // Each is read up to the message its row showed, and no further.
  expect(state.bulk).toEqual([
    {
      action: 'mark_read',
      items: [
        { id: mayaId, through: secondMessage.id },
        { id: kenId, through: messageId('4') },
      ],
    },
  ]);
  await expect(rowOf(page, 'Maya Thompson')).not.toContainText('unread');
  await expect(
    page.getByText('0 unread conversations · 1 needs reply', { exact: true }),
  ).toBeVisible();
  // The selection is let go once it is done.
  await expect(actions).toHaveCount(0);
  await expect(list.getByRole('checkbox', { name: 'Select all', exact: true })).not.toBeChecked();

  await list.getByRole('checkbox', { name: 'Select Ken Watanabe', exact: true }).check();
  await expect(list.getByText('1 selected', { exact: true })).toBeVisible();
  await actions.getByRole('button', { name: 'Star', exact: true }).click();
  await expect(
    list.getByRole('status').filter({ hasText: '1 conversation starred.' }),
  ).toBeVisible();
  await expect(rowOf(page, 'Ken Watanabe')).toContainText('Starred');
  await expect(rowOf(page, 'Maya Thompson')).not.toContainText('Starred');
  expect(state.bulk.at(-1)).toEqual({ action: 'star', ids: [kenId] });
});

test('someone who may only read is offered no boxes to tick and no star', async ({ page }) => {
  const state = world({ canManage: false, canReply: false });
  await openInbox(page, state, `?conversation=${mayaId}`);
  await expect(messagesOf(page).locator('li[data-direction]')).toHaveCount(2);
  await expect(listOf(page).getByRole('checkbox')).toHaveCount(0);
  await expect(
    threadOf(page).getByRole('button', { name: /Star conversation|Remove star|Mark as unread/ }),
  ).toHaveCount(0);
  expect(state.bulk).toEqual([]);
});

const detailsOf = (page: Page): Locator =>
  page.getByRole('region', { name: 'Contact Details', exact: true });

test('shows the contact’s details beside the thread on a wide window', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInbox(page, world(), `?conversation=${mayaId}`);
  const thread = threadOf(page);
  const details = detailsOf(page);
  // Three panes: the list, the thread and the contact, each in sight.
  await expect(listOf(page)).toBeVisible();
  await expect(messagesOf(page).locator('li[data-direction]')).toHaveCount(2);
  await expect(details.getByText('Maya Thompson', { exact: true })).toBeVisible();
  await expect(details.getByRole('link', { name: 'Open contact', exact: true })).toHaveAttribute(
    'href',
    new RegExp(`/contacts/${maya.id}$`),
  );
  await expect(details.getByRole('button', { name: 'All fields', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The pane has the one link to the contact: the thread's header keeps to the conversation.
  await expect(page.getByRole('link', { name: 'Open contact', exact: true })).toHaveCount(1);
  const toggle = thread.getByRole('button', { name: 'Contact details', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await noOverflow(page)).toBe(true);
  expect(await axe(page)).toEqual([]);

  // Each pane scrolls by itself: the page does not grow past the window.
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);

  // Another conversation shows that contact.
  await rowOf(page, 'Ken Watanabe').click();
  await expect(details.getByText('Ken Watanabe', { exact: true })).toBeVisible();
  await expect(details.getByText('Maya Thompson', { exact: true })).toHaveCount(0);

  // Closed, the thread takes the room, and the keyboard goes back to it.
  await details.getByRole('button', { name: 'Close contact details', exact: true }).click();
  await expect(details).toHaveCount(0);
  const kens = threadOf(page, 'Ken Watanabe');
  await expect(kens.getByRole('heading', { name: 'Ken Watanabe', exact: true })).toBeFocused();
  await expect(kens.getByRole('link', { name: 'Open contact', exact: true })).toBeVisible();
  const reopen = kens.getByRole('button', { name: 'Contact details', exact: true });
  await expect(reopen).toHaveAttribute('aria-expanded', 'false');
  await reopen.click();
  await expect(details).toBeFocused();
  await expect(details.getByText('Ken Watanabe', { exact: true })).toBeVisible();
});

test('fills the window’s width at 1920px', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openInbox(page, world(), `?conversation=${mayaId}`);
  await expect(detailsOf(page).getByText('Maya Thompson', { exact: true })).toBeVisible();
  expect(await reachesRightGutter(page, detailsOf(page))).toBe(true);
  // The thread takes what the list and the contact leave it.
  const [list, thread, details] = await Promise.all([
    listOf(page).boundingBox(),
    threadOf(page).boundingBox(),
    detailsOf(page).boundingBox(),
  ]);
  if (list === null || thread === null || details === null) throw new Error('Three panes.');
  expect(list.x).toBeLessThan(thread.x);
  expect(thread.x + thread.width).toBeLessThanOrEqual(details.x);
  expect(thread.width).toBeGreaterThan(list.width + details.width);
  expect(await noOverflow(page)).toBe(true);
  // With the contact closed, the thread reaches the gutter itself.
  await detailsOf(page).getByRole('button', { name: 'Close contact details', exact: true }).click();
  await expect(detailsOf(page)).toHaveCount(0);
  expect(await reachesRightGutter(page, threadOf(page))).toBe(true);
});

test('below the wide layout the contact’s details take the thread’s place when asked for', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const state = world();
  await openInbox(page, state);
  await rowOf(page, 'Maya Thompson').click();
  const thread = threadOf(page);
  await expect(messagesOf(page).locator('li[data-direction]')).toHaveCount(2);
  await expect(detailsOf(page)).toHaveCount(0);
  await expect(thread.getByRole('link', { name: 'Open contact', exact: true })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Message to Maya Thompson', exact: true })
    .fill('Half a reply');
  await thread.getByRole('button', { name: 'Contact details', exact: true }).click();
  const details = detailsOf(page);
  await expect(details).toBeFocused();
  await expect(details.getByText('Maya Thompson', { exact: true })).toBeVisible();
  await expect(thread).toBeHidden();
  await expect(listOf(page)).toBeHidden();
  expect(await noOverflow(page)).toBe(true);
  expect(await axe(page)).toEqual([]);
  await details.getByRole('button', { name: 'Close contact details', exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(thread.getByRole('heading', { name: 'Maya Thompson', exact: true })).toBeFocused();
  // What was being written is still there.
  await expect(
    page.getByRole('textbox', { name: 'Message to Maya Thompson', exact: true }),
  ).toHaveValue('Half a reply');
});

test('opening a conversation shows its thread and marks it read', async ({ page }) => {
  const state = world();
  await openInbox(page, state);
  await rowOf(page, 'Maya Thompson').click();
  await expect(page).toHaveURL(new RegExp(`conversation=${mayaId}`));
  const thread = threadOf(page);
  await expect(thread.getByRole('heading', { name: 'Maya Thompson', exact: true })).toBeFocused();
  const messages = messagesOf(page).locator('li[data-direction]');
  await expect(messages).toHaveCount(2);
  // Oldest first, each with its channel, its sender and its state in words.
  await expect(messages.nth(0)).toContainText('getting married on June 13');
  await expect(messages.nth(0)).toContainText('Email from Maya Thompson');
  await expect(messages.nth(0)).toContainText('Received');
  await expect(messages.nth(1)).toContainText('Is June 13 still open?');
  await expect
    .poll(() => state.reads)
    .toEqual([{ conversation: mayaId, through: secondMessage.id }]);
  await expect(rowOf(page, 'Maya Thompson')).not.toContainText('unread');
  await expect(
    page.getByText('0 unread conversations · 1 needs reply', { exact: true }),
  ).toBeVisible();
  // Read once: nothing asks again while nothing new arrives.
  await page.waitForTimeout(500);
  expect(state.reads).toHaveLength(1);
});

test('a new message shows in the list and the thread without a reload', async ({ page }) => {
  const state = world();
  const socket = await realtime(page);
  await openInbox(page, state, `?conversation=${mayaId}`);
  await expect(messagesOf(page).locator('li[data-direction]')).toHaveCount(2);
  await expect.poll(() => state.reads.length).toBe(1);

  // Ken writes while Maya's conversation is the open one: his stays unread.
  const fromKen = messageOf({
    id: messageId('5'),
    author: { kind: 'contact', name: 'Ken Watanabe', you: false },
    text: 'Do you also do photo booths?',
    createdAt: '2026-10-09T09:12:00.000Z',
  });
  state.threads[kenId] = [fromKen, ...(state.threads[kenId] ?? [])];
  state.conversations = state.conversations.map((each) =>
    each.id === kenId
      ? {
          ...each,
          unreadCount: 1,
          needsReply: true,
          lastActivityAt: fromKen.createdAt,
          lastMessage: {
            preview: fromKen.text,
            direction: 'inbound',
            channel: 'email',
            status: 'received',
            at: fromKen.createdAt,
          },
        }
      : each,
  );
  socket.changed();
  await expect(rowOf(page, 'Ken Watanabe')).toContainText('Do you also do photo booths?');
  await expect(rowOf(page, 'Ken Watanabe')).toContainText('1 unread');
  await expect(listOf(page).getByRole('listitem').nth(0)).toContainText('Ken Watanabe');
  await expect(
    page.getByText('1 unread conversation · 2 need reply', { exact: true }),
  ).toBeVisible();
  expect(state.reads).toHaveLength(1);

  // Maya writes into the open thread: it appears, is announced, and is read at once.
  const fromMaya = messageOf({
    id: messageId('6'),
    text: 'Also, could you do Friday instead?',
    createdAt: '2026-10-09T09:20:00.000Z',
  });
  state.threads[mayaId] = [fromMaya, ...(state.threads[mayaId] ?? [])];
  state.conversations = state.conversations.map((each) =>
    each.id === mayaId ? { ...each, unreadCount: 1, lastActivityAt: fromMaya.createdAt } : each,
  );
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  socket.changed();
  await expect(messagesOf(page).getByText('Also, could you do Friday instead?')).toBeVisible();
  await expect(threadOf(page).getByText('New message from Maya Thompson')).toBeAttached();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(focused);
  await expect
    .poll(() => state.reads.at(-1))
    .toEqual({ conversation: mayaId, through: fromMaya.id });
  await expect(rowOf(page, 'Maya Thompson')).not.toContainText('unread');

  // A change in another business is none of this page's business.
  const reads = state.reads.length;
  state.conversations = state.conversations.map((each) =>
    each.id === kenId ? { ...each, unreadCount: 7 } : each,
  );
  socket.changed('biz_01k8e2wzr0e008000000000002');
  await page.waitForTimeout(500);
  await expect(rowOf(page, 'Ken Watanabe')).toContainText('1 unread');
  expect(state.reads).toHaveLength(reads);
});

test('replies by email from a chosen account to a chosen address', async ({ page }) => {
  const state = world();
  await openInbox(page, state, `?conversation=${mayaId}`);
  const form = page.getByRole('form', { name: 'Reply to Maya Thompson', exact: true });
  await expect(form.getByLabel('Subject', { exact: true })).toHaveValue('Re: June 13');
  await choose(form.getByRole('combobox', { name: 'From', exact: true }), dana.id);
  await choose(form.getByRole('combobox', { name: 'To', exact: true }), mayaOtherEmail.id);
  await form.getByLabel('Message to Maya Thompson', { exact: true }).fill('June 13 is open.');
  await form.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(state.replies).toHaveLength(1);
  expect(state.replies[0]).toMatchObject({
    channel: 'email',
    accountId: dana.id,
    to: mayaOtherEmail.id,
    subject: 'Re: June 13',
    text: 'June 13 is open.',
  });
  expect(state.replies[0]?.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  const sent = messagesOf(page).locator('li[data-direction="outbound"]');
  await expect(sent).toHaveCount(1);
  await expect(sent).toContainText('Email to Maya Thompson, from you');
  await expect(sent).toContainText('June 13 is open.');
  await expect(sent).toContainText('Queued to send');
  await expect(sent).toContainText('sent from Dana Brooks');
  await expect(form.getByLabel('Message to Maya Thompson', { exact: true })).toHaveValue('');
});

/** Sofia wrote through the chat on the website, typing an address Maya already holds. */
function chatWorld(chat: ConversationComposer['channels'][number]): World {
  const state = world();
  return {
    ...state,
    conversations: state.conversations.map((each) =>
      each.id === sofiaId
        ? {
            ...each,
            status: 'open',
            needsReply: true,
            unreadCount: 1,
            unverified: true,
            claimedContact: maya,
            lastActivityAt: '2026-10-09T08:30:00.000Z',
          }
        : each,
    ),
    threads: {
      ...state.threads,
      [sofiaId]: [
        messageOf({
          id: messageId('8'),
          channel: 'webchat',
          account: siteChat,
          author: { kind: 'contact', name: 'Sofia Marin', you: false },
          subject: null,
          text: 'Do you have Friday free?',
          from: null,
          to: [],
          createdAt: '2026-10-09T08:30:00.000Z',
        }),
      ],
    },
    composer: composerOf({ channels: [chat], suggestedSubject: null }),
  };
}

test('marks a web chat conversation unverified, and names who holds the address typed', async ({
  page,
}) => {
  await openInbox(page, chatWorld(openChat));
  // In the list, beside what else the conversation needs. Nobody else is marked.
  await expect(rowOf(page, 'Sofia Marin')).toContainText('Unverified');
  await expect(rowOf(page, 'Maya Thompson')).not.toContainText('Unverified');
  await rowOf(page, 'Sofia Marin').click();
  const note = threadOf(page, 'Sofia Marin').getByRole('note', {
    name: 'Unverified identity',
    exact: true,
  });
  await expect(note).toContainText('Unverified: this person wrote through web chat.');
  await expect(note).toContainText('Their name and email address are only what they typed.');
  await expect(note).toContainText(
    'The email address they typed already belongs to Maya Thompson. They were kept as a separate contact',
  );
  // The contact that holds the address is one click away, to compare the two.
  await expect(note.getByRole('link', { name: 'Open Maya Thompson', exact: true })).toHaveAttribute(
    'href',
    new RegExp(`/contacts/${maya.id}$`),
  );
  await expect(messagesOf(page, 'Sofia Marin')).toContainText('Web chat from Sofia Marin');
  // A conversation by email says nothing of the kind.
  await rowOf(page, 'Maya Thompson').click();
  await expect(threadOf(page).getByRole('note', { name: 'Unverified identity' })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
});

test('answers a visitor in their chat, with no address to choose', async ({ page }) => {
  const state = chatWorld(openChat);
  await openInbox(page, state, `?conversation=${sofiaId}`);
  const form = page.getByRole('form', { name: 'Reply to Sofia Marin', exact: true });
  await expect(form.getByRole('combobox', { name: 'From', exact: true })).toContainText(
    'Harbor website',
  );
  await expect(form.getByText('The visitor, in their chat', { exact: true })).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'To', exact: true })).toHaveCount(0);
  await expect(form.getByLabel('Subject', { exact: true })).toHaveCount(0);
  await expect(form.getByLabel('Message to Sofia Marin', { exact: true })).toHaveAttribute(
    'maxlength',
    '2000',
  );
  await form.getByLabel('Message to Sofia Marin', { exact: true }).fill('Friday is free.');
  await form.getByRole('button', { name: 'Send chat message', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(state.replies).toHaveLength(1);
  expect(state.replies[0]).toMatchObject({
    channel: 'webchat',
    accountId: siteChat.id,
    to: null,
    subject: null,
    text: 'Friday is free.',
  });
  const sent = messagesOf(page, 'Sofia Marin').locator('li[data-direction="outbound"]');
  await expect(sent).toContainText('Web chat to Sofia Marin, from you');
  await expect(sent).toContainText('Friday is free.');
  expect(await axe(page)).toEqual([]);
});

test('says the visitor has left the chat, and sends nothing into it', async ({ page }) => {
  const state = chatWorld(leftChat);
  await openInbox(page, state, `?conversation=${sofiaId}`);
  await expect(page.getByText("You can't reply to Sofia Marin from here yet.")).toBeVisible();
  await expect(
    page.getByText('Web chat: The visitor has left the chat, so a reply would reach nobody.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send/ })).toHaveCount(0);
  // The team can still write down what they would have said.
  await page.getByRole('button', { name: 'Internal note', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Internal note', exact: true })).toBeVisible();
  expect(state.replies).toHaveLength(0);
});

test('says do not disturb stops web chat, and sends nothing into it', async ({ page }) => {
  const state = chatWorld(disturbedChat);
  await openInbox(page, state, `?conversation=${sofiaId}`);
  await expect(
    page.getByText(
      'Web chat: Do not disturb is on for this contact, so nothing can be sent on this channel.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send chat message', exact: true })).toHaveCount(0);
  expect(state.replies).toHaveLength(0);
  expect(await axe(page)).toEqual([]);
});

test('shows a channel with no account as unavailable, and why', async ({ page }) => {
  await openInbox(page, world(), `?conversation=${mayaId}`);
  const form = page.getByRole('form', { name: 'Reply to Maya Thompson', exact: true });
  // In the dashboard's words for the server's code, never the server's own sentence.
  await expect(
    form.getByText(
      "Text message: Text messages can't be sent: this install isn't set up to deliver them.",
    ),
  ).toBeVisible();
  await expect(form.getByText("SMS isn't connected yet.")).toHaveCount(0);
  await form.getByRole('combobox', { name: 'Send by', exact: true }).click();
  const options = page.getByRole('listbox').getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(1)).toHaveText('Text message (unavailable)');
  await expect(options.nth(1)).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(form.getByRole('button', { name: 'Send text message' })).toHaveCount(0);
});

test('starts a reply on the channel the contact last wrote on, and keeps a choice once made', async ({
  page,
}) => {
  const [email] = composerOf().channels;
  if (email === undefined) throw new Error('The fixture offers no email.');
  const frontDesk = { id: accountId('3'), name: 'Front desk', address: '+15550100000' };
  // Maya has two email addresses, and her last message came by text. The server says so.
  const state = world({
    threads: {
      [mayaId]: [
        messageOf({
          id: messageId('7'),
          channel: 'sms',
          account: frontDesk,
          subject: null,
          text: 'Running ten minutes late!',
          from: mayaPhone.address,
          to: [frontDesk.address],
          createdAt: '2026-10-09T08:20:00.000Z',
        }),
        secondMessage,
        firstMessage,
      ],
    },
    composer: composerOf({
      channels: [
        email,
        {
          channel: 'sms',
          available: true,
          unavailable: null,
          accounts: [frontDesk],
          recipients: [mayaPhone],
        },
      ],
      suggestedChannel: 'sms',
    }),
  });
  await openInbox(page, state, `?conversation=${mayaId}`);
  const form = page.getByRole('form', { name: 'Reply to Maya Thompson', exact: true });
  const sendBy = form.getByRole('combobox', { name: 'Send by', exact: true });
  await expect(sendBy).toHaveText('Text message');
  await expect(form.getByRole('button', { name: 'Send text message', exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Send email', exact: true })).toHaveCount(0);
  await expect(form.getByLabel('Subject', { exact: true })).toHaveCount(0);
  await form.getByLabel('Message to Maya Thompson', { exact: true }).fill('No rush, see you soon.');
  await form.getByRole('button', { name: 'Send text message', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(state.replies).toHaveLength(1);
  expect(state.replies[0]).toMatchObject({
    channel: 'sms',
    accountId: frontDesk.id,
    to: mayaPhone.id,
    subject: null,
    text: 'No rush, see you soon.',
  });

  // Email is still there to choose, and once chosen it stays chosen for this conversation.
  await sendBy.click();
  await page.getByRole('listbox').getByRole('option', { name: 'Email', exact: true }).click();
  await expect(sendBy).toHaveText('Email');
  await expect(form.getByRole('button', { name: 'Send email', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Internal note', exact: true }).click();
  await page.getByRole('button', { name: 'Reply to contact', exact: true }).click();
  await expect(sendBy).toHaveText('Email');
  expect(await axe(page)).toEqual([]);
});

test('offers no reply at all when nothing can send, but still takes a note', async ({ page }) => {
  const state = world({
    composer: composerOf({
      channels: [
        {
          channel: 'email',
          available: true,
          unavailable: null,
          accounts: [],
          recipients: [mayaEmail],
        },
      ],
    }),
  });
  await openInbox(page, state, `?conversation=${mayaId}`);
  await expect(page.getByText("You can't reply to Maya Thompson from here yet.")).toBeVisible();
  await expect(page.getByText("Email: Email isn't connected yet.", { exact: false })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Reply to Maya Thompson' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Send/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Internal note', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Internal note', exact: true })).toBeVisible();
});

test('an internal note is saved for the team and never sent', async ({ page }) => {
  const state = world();
  await openInbox(page, state, `?conversation=${mayaId}`);
  // A reply half written must not ride along with the note.
  await page
    .getByRole('textbox', { name: 'Message to Maya Thompson', exact: true })
    .fill('Half a reply');
  await page.getByRole('button', { name: 'Internal note', exact: true }).click();
  const form = page.getByRole('form', { name: 'Internal note', exact: true });
  await expect(
    form.getByText('Internal note: only your team sees this. It is never sent to Maya Thompson.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send/ })).toHaveCount(0);
  await expect(form.getByLabel('Note for your team', { exact: true })).toHaveValue('');
  await form.getByLabel('Note for your team', { exact: true }).fill('She haggles. Hold the price.');
  await form.getByRole('button', { name: 'Save internal note', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Note saved. Only your team sees it.' }),
  ).toBeVisible();
  expect(state.notes).toEqual(['She haggles. Hold the price.']);
  expect(state.replies).toEqual([]);
  const note = messagesOf(page).locator('li[data-kind="note"]');
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Internal note');
  await expect(note).toContainText('Only your team sees this');
  await expect(note).toContainText('She haggles. Hold the price.');
  await expect(messagesOf(page).locator('li[data-direction="outbound"]')).toHaveCount(0);
  // The reply is still where it was left.
  await page.getByRole('button', { name: 'Reply to contact', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Message to Maya Thompson', exact: true }),
  ).toHaveValue('Half a reply');
  expect(state.replies).toEqual([]);
});

test('a double submit sends once, and a retry after a lost connection reuses its key', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const keys: string[] = [];
  const state = world({
    beforeReply: async (route) => {
      attempts++;
      const body = sendConversationReplyInput.parse(route.request().postDataJSON());
      keys.push(body.idempotencyKey);
      if (attempts === 1) {
        await held;
        return 'answer';
      }
      if (attempts === 2) {
        await route.abort('connectionfailed');
        return 'handled';
      }
      return 'answer';
    },
  });
  await openInbox(page, state, `?conversation=${mayaId}`);
  const box = page.getByRole('textbox', { name: 'Message to Maya Thompson', exact: true });
  const send = page.getByRole('button', { name: 'Send email', exact: true });
  await box.fill('June 13 is open.');
  await send.dblclick();
  await expect.poll(() => attempts).toBe(1);
  await expect(send).toBeDisabled();
  release?.();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(attempts).toBe(1);
  expect(state.replies).toHaveLength(1);
  await expect(messagesOf(page).locator('li[data-direction="outbound"]')).toHaveCount(1);

  // The next message loses its connection, then goes on the second try, once.
  await box.fill('Shall we talk Thursday?');
  await send.click();
  await expect(page.getByRole('alert').filter({ hasText: "The reply wasn't sent." })).toContainText(
    "Trying again won't send it twice.",
  );
  await expect(box).toHaveValue('Shall we talk Thursday?');
  await send.click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(keys).toHaveLength(3);
  expect(keys[1]).toBe(keys[2]);
  expect(keys[1]).not.toBe(keys[0]);
  expect(state.replies).toHaveLength(2);
  await expect(messagesOf(page).locator('li[data-direction="outbound"]')).toHaveCount(2);
});

test('explains a reply the pipeline refused, and one it is holding', async ({ page }) => {
  const state = world({
    outcome: () => ({
      status: 'failed',
      problem: { code: 'consent_required', message: 'Maya has not agreed to receive email.' },
    }),
  });
  await openInbox(page, state, `?conversation=${mayaId}`);
  const box = page.getByRole('textbox', { name: 'Message to Maya Thompson', exact: true });
  await box.fill('June 13 is open.');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  const refusal = page.getByRole('alert').filter({ hasText: "Your reply wasn't sent." });
  await expect(refusal).toContainText('Nothing reached Maya Thompson.');
  await expect(refusal).toContainText(
    "This contact hasn't agreed to receive messages on this channel.",
  );
  await expect(refusal).not.toContainText('Maya has not agreed to receive email.');
  await expect(box).toHaveValue('June 13 is open.');
  const refused = messagesOf(page).locator('li[data-direction="outbound"]');
  await expect(refused).toContainText('Not sent');
  await expect(refused).toContainText(
    "This contact hasn't agreed to receive messages on this channel.",
  );

  state.outcome = () => ({
    status: 'queued',
    held: {
      code: 'quiet_hours',
      message: "It's outside Maya's contact hours.",
      until: '2026-10-10T05:00:00.000Z',
    },
  });
  await box.fill('Good morning, Maya.');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  const waiting = page.getByRole('status').filter({ hasText: 'Your reply is waiting to send.' });
  await expect(waiting).toContainText("It hasn't reached Maya Thompson yet.");
  await expect(waiting).toContainText("It's quiet hours where this contact is.");
  await expect(waiting).not.toContainText("It's outside Maya's contact hours.");
  await expect(waiting).toContainText('It will be tried again on');
  await expect(box).toHaveValue('');
  await expect(
    messagesOf(page).locator('li[data-direction="outbound"]').filter({ hasText: 'Good morning' }),
  ).toContainText('Waiting to send');
});

test('someone who may only read sees the thread, and nothing to write or change', async ({
  page,
}) => {
  const state = world({ canManage: false, canReply: false });
  await openInbox(page, state, `?conversation=${mayaId}`);
  await expect(messagesOf(page).locator('li[data-direction]')).toHaveCount(2);
  await expect(page.getByText('You can read this conversation.', { exact: false })).toBeVisible();
  const thread = threadOf(page);
  await expect(thread.getByRole('textbox')).toHaveCount(0);
  await expect(thread.getByRole('form')).toHaveCount(0);
  await expect(
    thread.getByRole('button', { name: /Send|Save internal note|Close conversation/ }),
  ).toHaveCount(0);
  await expect(thread.getByRole('combobox', { name: 'Assigned to', exact: true })).toHaveCount(0);
  await expect(thread.getByRole('combobox', { name: 'Snooze', exact: true })).toHaveCount(0);
  // Reading isn't theirs to record either.
  await page.waitForTimeout(500);
  expect(state.reads).toEqual([]);
  await expect(rowOf(page, 'Maya Thompson')).toContainText('2 unread');
});

test('assigns, snoozes, closes and reopens a conversation', async ({ page }) => {
  const state = world();
  await openInbox(page, state, `?conversation=${mayaId}`);
  const thread = threadOf(page);
  await choose(thread.getByRole('combobox', { name: 'Assigned to', exact: true }), 'me');
  await expect(
    thread.getByRole('status').filter({ hasText: 'Conversation assigned.' }),
  ).toBeVisible();
  await expect(rowOf(page, 'Maya Thompson')).toContainText('Assigned to you');

  await choose(thread.getByRole('combobox', { name: 'Snooze', exact: true }), 'tomorrow');
  await expect(
    thread.getByRole('status').filter({ hasText: 'Conversation snoozed.' }),
  ).toBeVisible();
  await expect(thread.getByText(/^Snoozed until /)).toBeVisible();
  // It left the open list, and stays open here.
  await expect(rowOf(page, 'Maya Thompson')).toHaveCount(0);
  await thread.getByRole('button', { name: 'Reopen conversation', exact: true }).click();
  await expect(
    thread.getByRole('status').filter({ hasText: 'Conversation reopened.' }),
  ).toBeVisible();
  await expect(rowOf(page, 'Maya Thompson')).toBeVisible();

  await thread.getByRole('button', { name: 'Close conversation', exact: true }).click();
  await expect(
    thread.getByRole('status').filter({ hasText: 'Conversation closed.' }),
  ).toBeVisible();
  await expect(thread.getByText('Closed', { exact: true })).toBeVisible();
  await expect(rowOf(page, 'Maya Thompson')).toHaveCount(0);
  expect(state.conversations.find((each) => each.id === mayaId)?.status).toBe('closed');
});

test('says when someone else changed the conversation first', async ({ page }) => {
  const state = world();
  await openInbox(page, state, `?conversation=${mayaId}`);
  const thread = threadOf(page);
  await expect(
    thread.getByRole('button', { name: 'Close conversation', exact: true }),
  ).toBeVisible();
  state.conversations = state.conversations.map((each) =>
    each.id === mayaId
      ? {
          ...each,
          assignee: { membershipId: null, name: 'Priya Shah', you: false },
          revision: 'c'.repeat(64),
        }
      : each,
  );
  await thread.getByRole('button', { name: 'Close conversation', exact: true }).click();
  await expect(thread.getByRole('alert')).toContainText(
    'Someone else just changed this conversation.',
  );
  await expect(rowOf(page, 'Maya Thompson')).toContainText('Assigned to Priya Shah');
  await thread.getByRole('button', { name: 'Close conversation', exact: true }).click();
  await expect(
    thread.getByRole('status').filter({ hasText: 'Conversation closed.' }),
  ).toBeVisible();
});

test('shows what a contact wrote as text, never as markup', async ({ page }) => {
  const hostile =
    '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script> see https://example.test/guide and javascript:window.pwned=3';
  const state = world();
  state.threads[mayaId] = [messageOf({ id: messageId('7'), text: hostile, subject: '<b>Hi</b>' })];
  state.conversations = state.conversations.map((each) =>
    each.id === mayaId
      ? {
          ...each,
          contact: { ...each.contact, name: '<i>Maya</i>' },
          lastMessage: each.lastMessage && { ...each.lastMessage, preview: '<u>preview</u>' },
        }
      : each,
  );
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  await openInbox(page, state, `?conversation=${mayaId}`);
  const messages = messagesOf(page, '<i>Maya</i>');
  await expect(
    messages.getByText('<script>window.pwned=2</script>', { exact: false }),
  ).toBeVisible();
  await expect(messages.getByText('<b>Hi</b>', { exact: true })).toBeVisible();
  await expect(rowOf(page, '<i>Maya</i>')).toContainText('<u>preview</u>');
  await expect(messages.locator('img, script, b, iframe')).toHaveCount(0);
  await expect(listOf(page).locator('i, u')).toHaveCount(0);
  const links = messages.getByRole('link');
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute('href', 'https://example.test/guide');
  await expect(links).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false);
  expect(dialogs).toBe(0);
});

test('keeps a draft when switching between conversations', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInbox(page, world(), `?conversation=${mayaId}`);
  await page
    .getByRole('textbox', { name: 'Message to Maya Thompson', exact: true })
    .fill('June 13 is');
  await rowOf(page, 'Ken Watanabe').click();
  await expect(threadOf(page, 'Ken Watanabe')).toBeVisible();
  await expect(page.getByLabel('Message to Ken Watanabe', { exact: true })).toHaveValue('');
  await rowOf(page, 'Maya Thompson').click();
  await expect(
    page.getByRole('textbox', { name: 'Message to Maya Thompson', exact: true }),
  ).toHaveValue('June 13 is');
});

test('works from the keyboard alone', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = world();
  await openInbox(page, state);
  await rowOf(page, 'Maya Thompson').focus();
  await page.keyboard.press('Enter');
  await expect(
    threadOf(page).getByRole('heading', { name: 'Maya Thompson', exact: true }),
  ).toBeFocused();
  const box = page.getByRole('textbox', { name: 'Message to Maya Thompson', exact: true });
  // Tab from the heading reaches the composer without a pointer.
  for (let presses = 0; presses < 30; presses++) {
    if (await box.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(box).toBeFocused();
  await page.keyboard.type('June 13 is open.');
  // Enter in the box is a new line, never a send.
  await page.keyboard.press('Enter');
  expect(state.replies).toHaveLength(0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Reply queued to send.' })).toBeVisible();
  expect(state.replies).toHaveLength(1);
  expect(state.replies[0]?.text).toBe('June 13 is open.');
  // The keyboard is back in the box, ready for the next message.
  await expect(box).toBeFocused();
});

for (const width of [360, 1440])
  test(`fits ${String(width)}px with no sideways scrolling, and passes axe`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const state = world();
    state.threads[mayaId] = [
      noteOf(),
      messageOf({
        id: messageId('8'),
        direction: 'outbound',
        status: 'failed',
        author: { kind: 'user', name: 'Dana Brooks', you: true },
        problem: { code: 'consent_required', message: 'Maya has not agreed to receive email.' },
        text: 'A long unbroken address: https://example.test/' + 'a'.repeat(300),
        subject: 'Re: June 13',
      }),
      secondMessage,
      firstMessage,
    ];
    await openInbox(page, state);
    expect(await noOverflow(page)).toBe(true);
    expect(await axe(page)).toEqual([]);
    await rowOf(page, 'Maya Thompson').click();
    const thread = threadOf(page);
    await expect(messagesOf(page).locator('li[data-direction]')).toHaveCount(3);
    await expect(
      page.getByRole('textbox', { name: 'Message to Maya Thompson', exact: true }),
    ).toBeVisible();
    if (width === 360) {
      // One pane at a time, with a way back that returns the keyboard to the row.
      await expect(listOf(page)).toBeHidden();
      await thread.getByRole('link', { name: 'Back to conversations', exact: true }).click();
      await expect(listOf(page)).toBeVisible();
      await expect(rowOf(page, 'Maya Thompson')).toBeFocused();
      await rowOf(page, 'Maya Thompson').click();
    } else {
      await expect(listOf(page)).toBeVisible();
      await expect(thread.getByRole('link', { name: 'Back to conversations' })).toBeHidden();
      await expect(rowOf(page, 'Maya Thompson')).toHaveAttribute('aria-current', 'true');
    }
    await expect(messagesOf(page).locator('li[data-kind="note"]')).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Internal note', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Internal note', exact: true })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('inbox.png'), fullPage: true });
  });

test('says when a conversation in the address cannot be found', async ({ page }) => {
  await openInbox(page, world(), `?conversation=${conversationId('9')}`);
  await expect(page.getByRole('alert')).toContainText("This conversation can't be found.");
  await expect(page.getByRole('textbox')).toHaveCount(0);
});
