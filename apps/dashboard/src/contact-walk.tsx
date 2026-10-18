// A contact opened from the list shows where it is in that list, with arrows to the one
// before and the one after, so the list can be walked without going back to it.
//
// The list is the one the person was looking at: the same filters, order and pages, read
// from where they are already cached, and the next page asked for when the walk reaches the
// end of what has loaded. Nothing new is asked of the server. What the walk follows is kept
// only while the app stays open: after a reload the contact shows without the arrows.
import { Trans, useLingui } from '@lingui/react/macro';
import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, type ReactElement } from 'react';
import {
  useContactCount,
  useContactPages,
  type ContactsSearch,
  type ListFilters,
} from './contact-pages';
import type { ContactSearch } from './contact-search';
import { useBusiness } from './workspace';

/** The list a contact was opened from. */
export interface ContactWalk {
  readonly filters: ListFilters;
  /** Which opening of the list: a saved view opened again reads its pages again. */
  readonly generation: number;
  /** The list's address, to go back to it as it was. */
  readonly search: ContactsSearch;
}

const walkKey = (businessId: string): readonly string[] => ['b', businessId, 'contact-walk'];

/** Remembers the list a contact is being opened from, for that contact's page. */
export function rememberContactWalk(
  cache: QueryClient,
  businessId: string,
  walk: ContactWalk,
): void {
  cache.setQueryData(walkKey(businessId), walk);
}

/** The list the person last opened a contact from in this business, if any. */
export function useContactWalk(): ContactWalk | undefined {
  const business = useBusiness();
  // Never fetched: it is only ever put there by the list.
  return useQuery<ContactWalk>({ queryKey: walkKey(business.id), queryFn: skipToken }).data;
}

const nowhere: ListFilters = { q: '', sort: 'newest', createdFrom: undefined };

const arrowClassName =
  'flex size-11 shrink-0 items-center justify-center rounded-control text-body hover:bg-muted hover:text-foreground lg:size-9';

/** The contact's place in the list it was opened from, and the way to its neighbours. */
export function ContactWalker({
  contactId,
  search,
}: {
  readonly contactId: string;
  /** The page's own address, kept from one contact to the next: the same panel stays open. */
  readonly search: ContactSearch;
}): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const walk = useContactWalk();
  const pages = useContactPages(business.id, walk?.filters ?? nowhere, walk?.generation ?? 0, {
    enabled: walk !== undefined,
    // The list as it was when the contact was opened from it.
    staleTime: Infinity,
  });
  // How many the list holds, as the list itself asked: already there, so not asked again.
  const counted = useContactCount(business.id, walk?.filters ?? nowhere, walk?.generation ?? 0, {
    enabled: walk !== undefined,
    staleTime: Infinity,
  }).data;
  const ids = pages.data?.pages.flatMap((page) => page.items.map((item) => item.id)) ?? [];
  const at = ids.indexOf(contactId);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  const atEnd = walk !== undefined && at >= 0 && at === ids.length - 1;
  useEffect(() => {
    if (atEnd && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [atEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);
  if (walk === undefined || at < 0) return null;
  const position = at + 1;
  // The server's count when it has one for the whole list; else what has loaded, and
  // whether there is more.
  const whole = counted?.exact === true && counted.count >= ids.length;
  const count = whole ? counted.count : ids.length;
  const orMore = !whole && hasNextPage;
  const neighbours = [
    { id: ids[at - 1], label: t`Previous contact`, icon: ChevronLeft },
    { id: ids[at + 1], label: t`Next contact`, icon: ChevronRight },
  ];
  return (
    <div role="group" aria-label={t`Place in the list`} className="ml-auto flex items-center">
      <p className="px-1 text-sm whitespace-nowrap text-muted-foreground">
        <span aria-hidden>
          {position}/{count}
          {orMore ? '+' : ''}
        </span>
        <span className="sr-only">
          {orMore ? (
            <Trans>
              Contact {position} of {count} or more
            </Trans>
          ) : (
            <Trans>
              Contact {position} of {count}
            </Trans>
          )}
        </span>
      </p>
      {neighbours.map(({ id, label, icon: Icon }) =>
        id === undefined ? (
          <span key={label} aria-hidden className={`${arrowClassName} opacity-40`}>
            <Icon className="size-[18px]" strokeWidth={2} />
          </span>
        ) : (
          <Link
            key={label}
            to="/b/$slug/contacts/$contactId"
            params={{ slug: business.slug, contactId: id }}
            search={search}
            aria-label={label}
            title={label}
            className={arrowClassName}
          >
            <Icon aria-hidden className="size-[18px]" strokeWidth={2} />
          </Link>
        ),
      )}
    </div>
  );
}
