// A contact's appointments on the contact page, as GoHighLevel's Appointments panel has
// them: Upcoming and Past, a search by title, and for each appointment its status, time,
// calendar and owner. Upcoming is what starts from the moment the panel opened, soonest
// first; Past is what started before it, latest first, so every appointment is in one of
// the two, a cancelled one with its status. Read from `GET /appointments?contact=` twenty
// at a time.
//
// Times are in the business's zone, as the Calendar draws them. An appointment opens in
// the same right-hand panel as on the Calendars pages; its title is also a link to it on
// the Calendar, for a new tab. Someone who may book has "Book appointment", which opens
// the New appointment form with this contact chosen. Fetched when the panel is first
// shown (contact-workspace.tsx), with the panel's parts.
import { Trans, useLingui } from '@lingui/react/macro';
import { listAppointments, type AppointmentRow } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarDays, Plus } from 'lucide-react';
import { useRef, useState, type MouseEvent, type ReactElement } from 'react';
import { apiIn } from './api';
import { AppointmentPanels, type OpenedAppointment } from './appointment-panels';
import {
  appointmentsKey,
  AppointmentStatusPill,
  businessZone,
  useEventTimes,
} from './calendar-shared';
import { ContactPanel, PanelEmpty } from './contact-panels';
import { ListSearch } from './list-toolbar';
import { ListProblem, retryFaults, useSettled, ViewSwitch } from './settings-list';
import { useBusiness } from './workspace';

type When = 'upcoming' | 'past';

/** How many appointments a page of the panel holds. */
const PAGE = 20;

interface ContactAppointmentsQuery {
  readonly view: 'all';
  readonly contact: string;
  readonly sort: 'startsAt';
  readonly direction: 'asc' | 'desc';
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly q?: string;
}

/** What the panel asks the server for: one tab of one contact's appointments. */
function queryOf(contactId: string, when: When, from: string, q: string): ContactAppointmentsQuery {
  return {
    view: 'all',
    contact: contactId,
    sort: 'startsAt',
    ...(when === 'upcoming'
      ? { from, direction: 'asc' as const }
      : { to: from, direction: 'desc' as const }),
    limit: PAGE,
    ...(q === '' ? {} : { q }),
  };
}

function Owner({ assignee }: { readonly assignee: AppointmentRow['assignee'] }): ReactElement {
  if (assignee === null)
    return (
      <span className="text-muted-foreground">
        <Trans>Unassigned</Trans>
      </span>
    );
  if (assignee.you) return <Trans>You</Trans>;
  if (assignee.name === '') return <Trans>Former team member</Trans>;
  return <>{assignee.name}</>;
}

export function ContactAppointments({
  contactId,
  contactName,
  readOnly = false,
}: {
  readonly contactId: string;
  /** What the contact is called, for the New appointment form. */
  readonly contactName: string;
  /** A contact in the trash is read, and nothing is booked for it. */
  readonly readOnly?: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const times = useEventTimes(businessZone(business));
  const [when, setWhen] = useState<When>('upcoming');
  const [search, setSearch] = useState('');
  const q = useSettled(search).trim();
  // The moment that parts Upcoming from Past, fixed while the panel is open, so the pages
  // of a tab follow on from one another.
  const [from] = useState(() => new Date().toISOString());
  const [opened, setOpened] = useState<OpenedAppointment>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const open = (next: OpenedAppointment, trigger: HTMLElement): void => {
    returnFocusRef.current = trigger;
    setOpened(next);
  };

  const query = queryOf(contactId, when, from, q);
  const list = useInfiniteQuery({
    queryKey: [...appointmentsKey(business.id), 'contact', contactId, query],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiIn(business.id).request(listAppointments, {
        query: { ...query, ...(pageParam === '' ? {} : { after: pageParam }) },
      }),
    getNextPageParam: (page) => page.next ?? undefined,
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const canBook = list.data?.pages[0]?.canManage === true && !readOnly;
  const searching = search.trim() !== q || list.isPlaceholderData;
  const none = list.data !== undefined && items.length === 0 && !searching;
  const zone = times.zone;

  const book = canBook ? (
    <Button
      variant="secondary"
      onClick={(event) => {
        open({ kind: 'new', contact: { id: contactId, name: contactName } }, event.currentTarget);
      }}
    >
      <Plus aria-hidden className="size-4" strokeWidth={2} />
      <Trans>Book appointment</Trans>
    </Button>
  ) : null;

  return (
    // The one way to book: beside the title, or in the empty Upcoming tab's own words.
    <ContactPanel
      title={t`Appointments`}
      action={none && q === '' && when === 'upcoming' ? null : book}
    >
      <ViewSwitch
        label={t`Appointment lists`}
        value={when}
        onChange={setWhen}
        views={[
          { value: 'upcoming', label: t`Upcoming` },
          { value: 'past', label: t`Past` },
        ]}
      />
      <ListSearch label={t`Search appointments`} value={search} onChange={setSearch} />
      {list.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading appointments…</Trans>
        </p>
      ) : null}
      {list.isError ? (
        <ListProblem
          onRetry={() => {
            void (list.isFetchNextPageError ? list.fetchNextPage() : list.refetch());
          }}
        >
          {list.isFetchNextPageError ? (
            <Trans>More appointments couldn't be loaded. Those listed are still here.</Trans>
          ) : (
            <Trans>The appointments couldn't be loaded.</Trans>
          )}
        </ListProblem>
      ) : null}
      {none && q !== '' ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No appointments match your search.</Trans>
        </p>
      ) : none ? (
        <PanelEmpty
          icon={<CalendarDays />}
          title={when === 'upcoming' ? t`No upcoming appointments.` : t`No past appointments.`}
          description={
            when === 'upcoming'
              ? t`Appointments booked for this contact from now on show here.`
              : t`Appointments of this contact that have started show here.`
          }
          action={when === 'upcoming' ? book : null}
        />
      ) : null}
      {items.length === 0 ? null : (
        <>
          <p className="text-xs text-muted-foreground">
            {total === 1 ? (
              <Trans>1 appointment, times in {zone}</Trans>
            ) : (
              <Trans>
                {total} appointments, times in {zone}
              </Trans>
            )}
          </p>
          <ul
            aria-label={when === 'upcoming' ? t`Upcoming appointments` : t`Past appointments`}
            className="flex min-w-0 flex-col gap-2"
          >
            {items.map((row) => {
              const title = row.title === '' ? t`Untitled` : row.title;
              return (
                <li
                  key={row.id}
                  className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-card p-2.5 text-sm"
                >
                  <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <Link
                      to="/b/$slug/calendar"
                      params={{ slug: business.slug }}
                      search={{ appointment: row.id }}
                      className="inline-flex min-h-11 min-w-0 items-center font-medium wrap-anywhere text-link underline-offset-2 hover:underline lg:min-h-7"
                      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                        // A plain click opens it here; a modified one opens the Calendar.
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        open({ kind: 'view', id: row.id }, event.currentTarget);
                      }}
                    >
                      {title}
                    </Link>
                    <AppointmentStatusPill status={row.status} />
                  </span>
                  <time dateTime={row.startsAt} className="text-foreground">
                    {times.span(row)}
                  </time>
                  <span className="wrap-anywhere text-body">
                    {row.calendar.name} · <Owner assignee={row.assignee} />
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={list.isFetchingNextPage || searching}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {list.isFetchingNextPage ? t`Loading…` : t`Show more appointments`}
        </Button>
      ) : null}

      <AppointmentPanels
        opened={opened}
        returnFocus={returnFocusRef}
        onOpen={setOpened}
        onClose={() => {
          setOpened(undefined);
        }}
      />
    </ContactPanel>
  );
}
