// The conversation list's tabs and views, in GoHighLevel's names, as the filters the server
// already has: Unread is `unread`, All is every status, Recent is the default (what is not
// closed or snoozed away), and Starred is the team's stars. The views are who the
// conversations are assigned to. This file belongs to the page's own chunk; inbox-search.ts
// loads with the app.
import { filtersOf, type InboxFilters } from './inbox-search';

export const inboxTabs = ['unread', 'all', 'recent', 'starred'] as const;
export type InboxTab = (typeof inboxTabs)[number];

/** The tab the filters show. A status chosen under Filters narrows All. */
export function tabOf(filters: InboxFilters): InboxTab {
  if (filters.starred !== undefined) return 'starred';
  if (filters.unread !== undefined) return 'unread';
  return filters.status === undefined ? 'recent' : 'all';
}

/** The filters with a tab chosen: the other filters stay as they are. */
export function withTab(filters: InboxFilters, tab: InboxTab): InboxFilters {
  const { status: _status, unread: _unread, starred: _starred, ...kept } = filters;
  return filtersOf({
    ...kept,
    ...(tab === 'unread' ? { unread: 'unread' as const } : {}),
    ...(tab === 'all' || tab === 'starred' ? { status: 'all' as const } : {}),
    ...(tab === 'starred' ? { starred: 'only' as const } : {}),
  });
}

/** Team inbox, My inbox, Unassigned, or one teammate's membership id. */
export type InboxView = string;

export function viewOf(filters: InboxFilters): InboxView {
  if (filters.assignee === undefined) return 'team';
  return filters.assignee === 'me' ? 'mine' : filters.assignee;
}

export function withView(filters: InboxFilters, view: InboxView): InboxFilters {
  const { assignee: _assignee, ...kept } = filters;
  return filtersOf(view === 'team' ? kept : { ...kept, assignee: view === 'mine' ? 'me' : view });
}

/** How many filters are chosen under Filters: a status, a channel, needs reply. */
export function moreFilterCountOf(filters: InboxFilters): number {
  return (
    (filters.status === 'snoozed' || filters.status === 'closed' ? 1 : 0) +
    (filters.channel === undefined ? 0 : 1) +
    (filters.reply === undefined ? 0 : 1)
  );
}

/**
 * Why a list is empty: there are no conversations at all, the tab has none, or what was
 * chosen besides the tab matches none.
 */
export function emptyKindOf(filters: InboxFilters): 'none' | 'unread' | 'starred' | 'filtered' {
  const tab = tabOf(filters);
  if (JSON.stringify(filtersOf(filters)) !== JSON.stringify(withTab({}, tab))) return 'filtered';
  return tab === 'unread' || tab === 'starred' ? tab : 'none';
}
