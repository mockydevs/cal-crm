import { listConversations } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { contactId, membershipId } from '../e2e/inbox-fixtures';
import { conversationQueryOf } from './inbox-search';
import {
  emptyKindOf,
  inboxTabs,
  moreFilterCountOf,
  tabOf,
  viewOf,
  withTab,
  withView,
} from './inbox-tabs';

describe('the list tabs', () => {
  it('reads the tab from the filters: Recent unless the address says otherwise', () => {
    expect(tabOf({})).toBe('recent');
    expect(tabOf({ unread: 'unread' })).toBe('unread');
    expect(tabOf({ status: 'all' })).toBe('all');
    expect(tabOf({ status: 'all', starred: 'only' })).toBe('starred');
    // A status chosen under Filters narrows every conversation, so All is the tab.
    expect(tabOf({ status: 'closed' })).toBe('all');
    expect(tabOf({ reply: 'needed', channel: 'sms', assignee: 'me' })).toBe('recent');
  });

  it.each(inboxTabs)('choosing %s shows that tab', (tab) => {
    expect(tabOf(withTab({}, tab))).toBe(tab);
    expect(tabOf(withTab({ status: 'closed', unread: 'unread', starred: 'only' }, tab))).toBe(tab);
  });

  it('asks the server what each tab means', () => {
    const asked = (tab: (typeof inboxTabs)[number]) =>
      listConversations.query.parse(conversationQueryOf(withTab({}, tab)));
    // Recent is what is not closed or snoozed away: the list's default.
    expect(asked('recent')).toMatchObject({ status: 'open', unread: 'any', starred: 'any' });
    expect(asked('unread')).toMatchObject({ status: 'open', unread: 'unread', starred: 'any' });
    expect(asked('all')).toMatchObject({ status: 'all', unread: 'any', starred: 'any' });
    expect(asked('starred')).toMatchObject({ status: 'all', unread: 'any', starred: 'only' });
  });

  it('keeps the other filters when the tab changes', () => {
    const kept = {
      assignee: 'me',
      reply: 'needed',
      channel: 'email',
      contact: contactId('1'),
    } as const;
    expect(withTab({ ...kept, unread: 'unread' }, 'starred')).toEqual({
      ...kept,
      status: 'all',
      starred: 'only',
    });
    expect(withTab({ ...kept, status: 'all', starred: 'only' }, 'recent')).toEqual(kept);
  });
});

describe('the inbox views', () => {
  it('reads the view from who the conversations are assigned to', () => {
    expect(viewOf({})).toBe('team');
    expect(viewOf({ assignee: 'me' })).toBe('mine');
    expect(viewOf({ assignee: 'unassigned' })).toBe('unassigned');
    expect(viewOf({ assignee: membershipId('2') })).toBe(membershipId('2'));
  });

  it('changes only the assignment, and back', () => {
    const filters = { status: 'all', channel: 'sms' } as const;
    expect(withView(filters, 'mine')).toEqual({ ...filters, assignee: 'me' });
    expect(withView(filters, 'unassigned')).toEqual({ ...filters, assignee: 'unassigned' });
    expect(withView(filters, membershipId('2'))).toEqual({
      ...filters,
      assignee: membershipId('2'),
    });
    expect(withView({ ...filters, assignee: 'me' }, 'team')).toEqual(filters);
    for (const view of ['team', 'mine', 'unassigned', membershipId('2')])
      expect(viewOf(withView({}, view))).toBe(view);
  });
});

describe('what Filters holds', () => {
  it('counts the filters chosen there, which the tabs and the view do not show', () => {
    expect(moreFilterCountOf({})).toBe(0);
    expect(moreFilterCountOf({ status: 'all', unread: 'unread', assignee: 'me' })).toBe(0);
    expect(moreFilterCountOf({ status: 'closed', channel: 'sms', reply: 'needed' })).toBe(3);
    expect(moreFilterCountOf({ status: 'snoozed', starred: 'only' })).toBe(1);
  });
});

describe('an empty list', () => {
  it('says there is nothing yet when nothing narrows it', () => {
    expect(emptyKindOf({})).toBe('none');
    expect(emptyKindOf({ status: 'all' })).toBe('none');
  });

  it('names the tab when only the tab narrows it', () => {
    expect(emptyKindOf({ unread: 'unread' })).toBe('unread');
    expect(emptyKindOf({ status: 'all', starred: 'only' })).toBe('starred');
  });

  it('says nothing matches when anything else narrows it', () => {
    expect(emptyKindOf({ assignee: 'me' })).toBe('filtered');
    expect(emptyKindOf({ unread: 'unread', channel: 'sms' })).toBe('filtered');
    expect(emptyKindOf({ status: 'closed' })).toBe('filtered');
    expect(emptyKindOf({ contact: contactId('1') })).toBe('filtered');
  });
});
