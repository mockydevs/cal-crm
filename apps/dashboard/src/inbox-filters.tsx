// What stands above the conversation list, as GoHighLevel has it: the inbox view (Team
// inbox, My inbox, Unassigned or one teammate's), the four tabs (Unread, All, Recent,
// Starred), a search for one contact's conversation, and Filters, which stays folded until
// it is asked for. Every choice lives in the address, so a filtered inbox can be linked to.
// Only what `GET /conversations` filters by is here.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { InboxSummary } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { MorePeople, teammatesOf, useAssignees } from './inbox-assignees';
import { badgeCount } from './inbox-badge';
import { retryRead } from './inbox-data';
import { InboxLink, type InboxNavigation } from './inbox-link';
import { filtersOf, isTeammate, type InboxFilters, type InboxSearch } from './inbox-search';
import {
  inboxTabs,
  moreFilterCountOf,
  tabOf,
  viewOf,
  withTab,
  withView,
  type InboxTab,
} from './inbox-tabs';
import { useBusiness } from './workspace';

const labelClassName = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
const tabClassName =
  'inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 border-b-2 border-transparent px-1 text-sm text-body hover:text-foreground aria-[current=true]:border-primary aria-[current=true]:font-medium aria-[current=true]:text-link lg:min-h-9';
const toggleClassName =
  'inline-flex min-h-11 items-center gap-1.5 self-start rounded-full border border-border bg-card px-3.5 text-sm text-foreground aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:font-medium aria-pressed:text-primary-foreground lg:min-h-9';

export interface InboxListHeaderProps {
  /** The id of the page's heading, which names the list. */
  readonly headingId: string;
  readonly search: InboxSearch;
  readonly navigation: InboxNavigation;
  readonly summary: InboxSummary | undefined;
}

export function InboxListHeader({
  headingId,
  search,
  navigation,
  summary,
}: InboxListHeaderProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const people = useAssignees(business.id, true);
  const filtersId = useId();
  const filters = filtersOf(search);
  const [filtersOpen, setFiltersOpen] = useState(() => moreFilterCountOf(filters) > 0);
  const unnamed = t`Unnamed team member`;
  // A teammate named in the address keeps an option even before their page is read.
  const teammates = teammatesOf(
    people.data?.pages,
    filters.assignee !== undefined && isTeammate(filters.assignee)
      ? { id: filters.assignee, name: t`A teammate` }
      : undefined,
  );
  const open = search.conversation === undefined ? {} : { conversation: search.conversation };
  /** The address with these filters, keeping the open conversation open. */
  const filter = (next: InboxFilters): void => {
    navigation.go({ ...open, ...next }, { replace: true });
  };
  const without = (name: keyof InboxFilters): InboxFilters => {
    const { [name]: _dropped, ...rest } = filters;
    return rest;
  };

  const unread = summary?.unreadConversations ?? 0;
  const waiting = summary?.needsReply ?? 0;
  const unreadWords = plural(unread, {
    one: '# unread conversation',
    other: '# unread conversations',
  });
  const waitingWords = plural(waiting, { one: '# needs reply', other: '# need reply' });
  const tab = tabOf(filters);
  const tabWords: Readonly<Record<InboxTab, string>> = {
    unread: t`Unread`,
    all: t`All`,
    recent: t`Recent`,
    starred: t`Starred`,
  };
  const chosen = moreFilterCountOf(filters);

  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-b px-3 pt-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 id={headingId} className="text-lg leading-tight font-semibold">
            <Trans>Conversations</Trans>
          </h1>
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {summary === undefined
              ? ''
              : unread === 0 && waiting === 0
                ? t`Nothing unread`
                : t`${unreadWords} · ${waitingWords}`}
          </p>
        </div>
        <Button
          variant="secondary"
          size="small"
          aria-expanded={filtersOpen}
          aria-controls={filtersId}
          onClick={() => {
            setFiltersOpen(!filtersOpen);
          }}
        >
          <SlidersHorizontal aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Filters</Trans>
          {chosen === 0 ? null : (
            <span className="rounded-full bg-accent px-1.5 text-xs font-medium text-link">
              <span aria-hidden>{chosen}</span>
              <span className="sr-only">
                {plural(chosen, { one: '# filter chosen', other: '# filters chosen' })}
              </span>
            </span>
          )}
        </Button>
      </div>

      <Select
        aria-label={t`Inbox view`}
        value={viewOf(filters)}
        onValueChange={(value) => {
          filter(withView(filters, value));
        }}
      >
        <option value="team">
          <Trans>Team inbox</Trans>
        </option>
        <option value="mine">
          <Trans>My inbox</Trans>
        </option>
        <option value="unassigned">
          <Trans>Unassigned</Trans>
        </option>
        {teammates.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name ?? unnamed}
          </option>
        ))}
      </Select>
      <MorePeople people={people} />

      <div
        id={filtersId}
        role="group"
        aria-label={t`Filters`}
        hidden={!filtersOpen}
        className="grid min-w-0 grid-cols-2 gap-2 rounded-lg bg-panel p-2.5"
      >
        <label className={labelClassName}>
          <Trans>Status</Trans>
          <Select
            value={filters.status ?? 'open'}
            onValueChange={(value) => {
              filter(
                value === 'snoozed' || value === 'closed' || value === 'all'
                  ? { ...filters, status: value }
                  : without('status'),
              );
            }}
          >
            <option value="open">
              <Trans>Open</Trans>
            </option>
            <option value="snoozed">
              <Trans>Snoozed</Trans>
            </option>
            <option value="closed">
              <Trans>Closed</Trans>
            </option>
            <option value="all">
              <Trans>All</Trans>
            </option>
          </Select>
        </label>
        <label className={labelClassName}>
          <Trans>Channel</Trans>
          <Select
            value={filters.channel ?? 'any'}
            onValueChange={(value) => {
              filter(
                value === 'email' || value === 'sms' || value === 'webchat'
                  ? { ...filters, channel: value }
                  : without('channel'),
              );
            }}
          >
            <option value="any">
              <Trans>Every channel</Trans>
            </option>
            <option value="email">
              <Trans>Email</Trans>
            </option>
            <option value="sms">
              <Trans>Text message</Trans>
            </option>
            <option value="webchat">
              <Trans>Web chat</Trans>
            </option>
          </Select>
        </label>
        <button
          type="button"
          aria-pressed={filters.reply === 'needed'}
          className={`${toggleClassName} col-span-2`}
          onClick={() => {
            filter(filters.reply === 'needed' ? without('reply') : { ...filters, reply: 'needed' });
          }}
        >
          <Trans>Needs reply</Trans>
          {summary === undefined ? null : <span>{badgeCount(summary.needsReply)}</span>}
        </button>
      </div>

      <ContactSearch
        onChoose={(contact) => {
          filter({ ...filters, contact });
        }}
      />

      <nav aria-label={t`Conversation tabs`} className="-mb-px grid min-w-0 grid-cols-4">
        {inboxTabs.map((each) => (
          <InboxLink
            key={each}
            to={{ ...open, ...withTab(filters, each) }}
            navigation={navigation}
            replace
            {...(each === tab ? { 'aria-current': 'true' as const } : {})}
            className={tabClassName}
          >
            <span className="min-w-0 truncate">{tabWords[each]}</span>
            {each === 'unread' && unread > 0 ? (
              <span className="rounded-full bg-accent px-1.5 text-xs font-medium text-link">
                {badgeCount(unread)}
              </span>
            ) : null}
          </InboxLink>
        ))}
      </nav>
    </div>
  );
}

/**
 * What is typed, once typing pauses, so the server isn't asked for every key. Kept here
 * rather than taken from settings-list.tsx, which would bring the settings lists' menus
 * and dialogs into the Inbox's code.
 */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);
  return settled;
}

/**
 * Finds a contact by what is typed, and narrows the list to that contact's conversation.
 * The server searches contacts; it has no search over conversations or their messages.
 */
function ContactSearch({
  onChoose,
}: {
  readonly onChoose: (contactId: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const inputId = useId();
  const [text, setText] = useState('');
  const q = useSettled(text).trim();
  const found = useQuery({
    queryKey: ['b', business.id, 'inbox', 'contact-search', q],
    queryFn: async () => (await import('./inbox-contact-search')).searchContacts(business.id, q),
    enabled: q !== '',
    retry: retryRead,
  });
  const label = t`Search by contact`;
  return (
    <form
      role="search"
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="relative min-w-0">
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.8}
        />
        <Input
          id={inputId}
          type="search"
          autoComplete="off"
          maxLength={200}
          placeholder={label}
          value={text}
          className="pl-9"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </div>
      {q === '' || text.trim() === '' ? null : found.isError ? (
        <p role="alert" className="text-sm">
          <Trans>Contacts couldn't be searched.</Trans>
        </p>
      ) : found.data === undefined ? null : found.data.items.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>No contacts match.</Trans>
        </p>
      ) : (
        <div
          role="group"
          aria-label={t`Matching contacts`}
          className="flex min-w-0 flex-col rounded-lg border border-border"
        >
          {found.data.items.map((each) => {
            const name = each.name ?? each.email ?? t`Unnamed`;
            return (
              <button
                key={each.id}
                type="button"
                className="flex min-h-11 w-full min-w-0 flex-col items-start justify-center rounded-control border-t border-border px-3 py-1.5 text-left text-md -outline-offset-2 first:border-t-0 hover:bg-muted lg:min-h-9"
                onClick={() => {
                  onChoose(each.id);
                  setText('');
                }}
              >
                <span className="wrap-anywhere text-foreground">{name}</span>
                {each.email === null || each.email === name ? null : (
                  <span className="text-xs wrap-anywhere text-muted-foreground">{each.email}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </form>
  );
}
