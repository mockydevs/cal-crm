// @vitest-environment jsdom
// The conversation list of Conversations: its tabs and filters as addresses, the search for
// one contact's conversation, and what ticking rows sends. The API is stood in for here;
// the same paths through a browser are in e2e/inbox.spec.ts.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  listConversations,
  type BulkConversationsResult,
  type Conversation,
  type ConversationList,
} from '@repo/contracts';
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contactId, conversationId, conversationOf, ken, messageId } from '../e2e/inbox-fixtures';
import { InboxList } from './inbox-list';
import { searchStringOf, type InboxSearch } from './inbox-search';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => {
  const client = {
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  };
  return { api: client, apiIn: () => client };
});
vi.mock('./workspace', async (original) => ({
  ...(await original<typeof import('./workspace')>()),
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const last = conversationOf().lastMessage;
if (last === null) throw new Error('The fixture has a last message.');
const mayaId = conversationId('1');
const kenId = conversationId('2');

interface World {
  conversations: Conversation[];
  canManage: boolean;
  canReply: boolean;
  bulk: (body: unknown) => BulkConversationsResult;
}
let world: World;

beforeEach(() => {
  server.calls = [];
  world = {
    conversations: [
      conversationOf({ id: mayaId, lastMessage: { ...last, id: messageId('2') } }),
      conversationOf({
        id: kenId,
        contact: ken,
        unreadCount: 0,
        needsReply: false,
        starred: true,
        lastMessage: { ...last, id: messageId('4') },
      }),
    ],
    canManage: true,
    canReply: true,
    bulk: () => ({ action: 'star', results: [], done: 0, unchanged: 0, skipped: 0 }),
  };
  server.answer = (operation, input) => {
    switch (operation) {
      case 'listConversations':
        return {
          canManage: world.canManage,
          canReply: world.canReply,
          items: world.conversations,
          nextCursor: null,
        } satisfies ConversationList;
      case 'listConversationAssignees':
        return { items: [], nextCursor: null };
      case 'listContacts':
        return {
          items: [{ id: contactId('2'), name: 'Ken Watanabe', email: 'ken@example.test' }],
          next: null,
        };
      case 'bulkUpdateConversations':
        return world.bulk((input as { body: unknown }).body);
      default:
        return undefined;
    }
  };
});

afterEach(() => {
  cleanup();
});

function Harness({
  search,
  go,
}: {
  readonly search: InboxSearch;
  readonly go: (search: InboxSearch, how?: { readonly replace?: boolean }) => void;
}): ReactElement {
  const list = useInfiniteQuery({
    queryKey: ['b', 'biz_test', 'inbox', 'list', search],
    queryFn: async () => {
      const { apiIn } = await import('./api');
      return apiIn('biz_test').request(listConversations, { query: {} });
    },
    initialPageParam: undefined,
    getNextPageParam: (page: ConversationList) => page.nextCursor ?? undefined,
  });
  return (
    <InboxList
      search={search}
      navigation={{ hrefFor: (to) => `/inbox${searchStringOf(to)}`, go }}
      list={list}
      summary={{ unreadConversations: 1, unreadMessages: 2, needsReply: 1 }}
      now={new Date('2026-10-09T12:00:00.000Z')}
      onOpen={vi.fn()}
    />
  );
}

function open(search: InboxSearch = {}): {
  user: ReturnType<typeof userEvent.setup>;
  go: ReturnType<typeof vi.fn<(search: InboxSearch, how?: { readonly replace?: boolean }) => void>>;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const go = vi.fn<(search: InboxSearch, how?: { readonly replace?: boolean }) => void>();
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <Harness search={search} go={go} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), go };
}

const rows = (): Promise<HTMLElement[]> => screen.findAllByRole('listitem');
const bulkCalls = (): unknown[] =>
  server.calls
    .filter((call) => call.operation === 'bulkUpdateConversations')
    .map((call) => (call.input as { body: unknown }).body);

describe('the tabs', () => {
  it('are links to each filtered list, with the current one marked', async () => {
    open({ conversation: mayaId, assignee: 'me' });
    const tabs = within(await screen.findByRole('navigation', { name: 'Conversation tabs' }));
    expect(tabs.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Unread1',
      'All',
      'Recent',
      'Starred',
    ]);
    expect(tabs.getByRole('link', { name: 'Recent' }).getAttribute('aria-current')).toBe('true');
    expect(tabs.getByRole('link', { name: /^Unread/ }).getAttribute('href')).toBe(
      `/inbox?conversation=${mayaId}&assignee=me&unread=unread`,
    );
    expect(tabs.getByRole('link', { name: 'All' }).getAttribute('href')).toBe(
      `/inbox?conversation=${mayaId}&status=all&assignee=me`,
    );
    expect(tabs.getByRole('link', { name: 'Starred' }).getAttribute('href')).toBe(
      `/inbox?conversation=${mayaId}&status=all&assignee=me&starred=only`,
    );
  });

  it('changes the address in place, without a new history entry', async () => {
    const { user, go } = open();
    await user.click(await screen.findByRole('link', { name: 'Starred' }));
    expect(go).toHaveBeenCalledWith({ status: 'all', starred: 'only' }, { replace: true });
  });

  it('shows a star on a starred conversation, in words too', async () => {
    open();
    const [maya, kenRow] = await rows();
    if (maya === undefined || kenRow === undefined) throw new Error('Two rows.');
    expect(within(kenRow).getByText('Starred')).toBeTruthy();
    expect(within(maya).queryByText('Starred')).toBeNull();
  });
});

describe('Filters', () => {
  it('stays folded until asked for, and says how many are chosen', async () => {
    const { user, go } = open({ channel: 'sms' });
    const button = await screen.findByRole('button', { name: /^Filters/ });
    // A filter in the address opens it, so what narrows the list is in sight.
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain('1 filter chosen');
    await user.click(screen.getByRole('button', { name: /^Needs reply/ }));
    expect(go).toHaveBeenCalledWith({ reply: 'needed', channel: 'sms' }, { replace: true });
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /^Needs reply/ })).toBeNull();
  });

  it('is folded when nothing is chosen there', async () => {
    open({ assignee: 'me', unread: 'unread' });
    const button = await screen.findByRole('button', { name: /^Filters/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('Filters');
  });
});

describe('the search', () => {
  it("finds a contact and narrows the list to that contact's conversation", async () => {
    const { user, go } = open({ unread: 'unread' });
    await user.type(await screen.findByRole('searchbox', { name: 'Search by contact' }), 'ken');
    const found = within(await screen.findByRole('group', { name: 'Matching contacts' }));
    expect(
      server.calls.filter((call) => call.operation === 'listContacts').map((call) => call.input),
    ).toEqual([{ query: { q: 'ken', limit: 6 } }]);
    await user.click(found.getByRole('button', { name: /Ken Watanabe/ }));
    expect(go).toHaveBeenCalledWith(
      { unread: 'unread', contact: contactId('2') },
      { replace: true },
    );
    expect(screen.queryByRole('group', { name: 'Matching contacts' })).toBeNull();
  });
});

describe('ticked conversations', () => {
  it('are marked read up to the message each row showed, then let go', async () => {
    world.bulk = () => ({
      action: 'mark_read',
      results: [
        { id: mayaId, outcome: 'done', reason: null },
        { id: kenId, outcome: 'unchanged', reason: null },
      ],
      done: 1,
      unchanged: 1,
      skipped: 0,
    });
    const { user } = open();
    await rows();
    expect(screen.queryByRole('group', { name: 'Selected conversations' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByText('2 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => {
      expect(screen.getByText('2 conversations marked as read.')).toBeTruthy();
    });
    expect(bulkCalls()).toEqual([
      {
        action: 'mark_read',
        items: [
          { id: mayaId, through: messageId('2') },
          { id: kenId, through: messageId('4') },
        ],
      },
    ]);
    expect(screen.queryByRole('group', { name: 'Selected conversations' })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select all' }).checked).toBe(
      false,
    );
  });

  it('says why one that was skipped was left as it was, in the dashboard words', async () => {
    world.bulk = () => ({
      action: 'mark_unread',
      results: [
        {
          id: kenId,
          outcome: 'skipped',
          reason: { code: 'nothing_to_mark_unread', message: 'Nothing to mark.' },
        },
      ],
      done: 0,
      unchanged: 0,
      skipped: 1,
    });
    const { user } = open();
    await rows();
    await user.click(screen.getByRole('checkbox', { name: 'Select Ken Watanabe' }));
    expect(screen.getByText('1 selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Mark as unread' }));
    await waitFor(() => {
      expect(
        screen.getByText(
          "1 couldn't be changed. The contact hasn't written in it, so there is nothing to mark as unread.",
        ),
      ).toBeTruthy();
    });
    expect(bulkCalls()).toEqual([{ action: 'mark_unread', ids: [kenId] }]);
    // The server's own sentence is never shown.
    expect(screen.queryByText(/Nothing to mark\./)).toBeNull();
  });

  it('says so when the request does not go through, and keeps the selection', async () => {
    world.bulk = () => {
      throw new Error('offline');
    };
    const { user } = open();
    await rows();
    await user.click(screen.getByRole('checkbox', { name: 'Select Maya Thompson' }));
    await user.click(screen.getByRole('button', { name: 'Star' }));
    expect((await screen.findByRole('alert')).textContent).toContain("That didn't go through.");
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('offers nothing to tick to someone who may only read', async () => {
    world.canManage = false;
    world.canReply = false;
    open();
    await rows();
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
  });
});
