import { conversationChannels, conversationStatuses, listConversations } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { conversationId } from '../e2e/inbox-fixtures';
import {
  conversationQueryOf,
  filtersOf,
  inboxSearch,
  searchStringOf,
  type InboxSearch,
} from './inbox-search';

describe('inboxSearch', () => {
  it('keeps what the page understands', () => {
    expect(
      inboxSearch({
        conversation: conversationId('1'),
        status: 'closed',
        assignee: 'me',
        reply: 'needed',
        unread: 'unread',
        starred: 'only',
        channel: 'email',
      }),
    ).toEqual({
      conversation: conversationId('1'),
      status: 'closed',
      assignee: 'me',
      reply: 'needed',
      unread: 'unread',
      starred: 'only',
      channel: 'email',
    });
  });

  it('drops everything else, the defaults included', () => {
    expect(
      inboxSearch({
        conversation: '<script>alert(1)</script>',
        status: 'open',
        assignee: 'anyone',
        reply: 'any',
        unread: 'any',
        starred: 'any',
        channel: 'pigeon',
        other: 'thing',
      }),
    ).toEqual({});
    expect(inboxSearch({ conversation: 7, status: ['closed'], channel: null })).toEqual({});
    expect(inboxSearch({ channel: 'constructor' })).toEqual({});
  });

  it.each(conversationChannels)('accepts the contract channel %s', (channel) => {
    expect(inboxSearch({ channel })).toEqual({ channel });
  });

  it.each(conversationStatuses.filter((status) => status !== 'open'))(
    'accepts the contract status %s',
    (status) => {
      expect(inboxSearch({ status })).toEqual({ status });
    },
  );
});

describe('conversationQueryOf', () => {
  const query = listConversations.query;

  it('asks for the defaults by sending nothing', () => {
    expect(conversationQueryOf({})).toEqual({});
    expect(query.parse(conversationQueryOf({}))).toMatchObject({
      status: 'open',
      assignee: 'anyone',
      reply: 'any',
      unread: 'any',
      starred: 'any',
    });
  });

  it('sends each filter as the contract names it, and never the open conversation', () => {
    const search: InboxSearch = {
      conversation: conversationId('1'),
      status: 'all',
      assignee: 'unassigned',
      reply: 'needed',
      unread: 'unread',
      starred: 'only',
      channel: 'sms',
    };
    const asked = conversationQueryOf(filtersOf(search), 'cursor_1');
    expect(asked).toEqual({
      status: 'all',
      assignee: 'unassigned',
      reply: 'needed',
      unread: 'unread',
      starred: 'only',
      channel: 'sms',
      after: 'cursor_1',
    });
    expect(query.safeParse(asked).success).toBe(true);
  });

  it('makes the same key for the same filters whatever order the address had them in', () => {
    expect(JSON.stringify(filtersOf({ channel: 'email', status: 'closed' }))).toBe(
      JSON.stringify(filtersOf({ status: 'closed', channel: 'email' })),
    );
  });

  it('writes a search as an address', () => {
    expect(searchStringOf({})).toBe('');
    expect(searchStringOf({ status: 'closed', conversation: conversationId('1') })).toBe(
      `?conversation=${conversationId('1')}&status=closed`,
    );
    expect(
      inboxSearch(
        Object.fromEntries(
          new URLSearchParams(searchStringOf({ reply: 'needed', channel: 'webchat' })),
        ),
      ),
    ).toEqual({ reply: 'needed', channel: 'webchat' });
  });
});
