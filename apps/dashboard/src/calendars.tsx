// Settings → Calendars, laid out as GoHighLevel's list in the owner's screenshot: the tabs
// Calendars and Availability, the groups at the left, and the calendars in a table that the
// server searches, filters and pages. "New calendar" asks for a type, then opens the modal;
// a row opens the full editor. GoHighLevel's Preferences and Connections tabs, its Service
// menu, Rooms and Equipment, and a row's Integrations button have nothing behind them here,
// so they are not drawn (owner's rule: nothing on screen that does nothing).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  deleteCalendar,
  listCalendarGroups,
  listCalendars,
  type BusinessSummary,
  type Calendar,
  type CalendarKind,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Pencil, Plus, Share2 } from 'lucide-react';
import { lazy, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { GroupsRail } from './calendar-groups-rail';
import { usePeople } from './calendar-settings-data';
import { EditCalendarLink, PersonLink, useCalendarNavigation } from './calendar-settings-links';
import {
  ALL,
  ANYONE,
  bookingAddress,
  calendarCarryKey,
  calendarGroupsKey,
  calendarKey,
  calendarNoticeKey,
  calendarsKey,
  listQuery,
  noFilters,
  type ListFilters,
} from './calendar-settings-rules';
import { kindNames } from './calendar-settings-words';
import { ListSearch, PanelContent } from './list-toolbar';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  iconButtonClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  RowMenu,
  tableClassName,
  tableRegionClassName,
  useSettled,
} from './settings-list';
import { emptyTrail, rangeOf, trailBack, trailCursor, trailForward } from './settings-rules';
import { usePageTitle } from './shell/page';

// Fetched when "New calendar" is first pressed: neither is needed to read the list.
const CalendarTypeDialog = lazy(() => import('./calendar-type-dialog'));
const NewCalendarDialog = lazy(() => import('./calendar-new-dialog'));
// Fetched when a row's "Embed code" is first chosen.
const CalendarEmbedDialog = lazy(() => import('./calendar-embed-dialog'));

const PAGE_SIZE = 25;
const kinds: readonly CalendarKind[] = [
  'personal',
  'round_robin',
  'class',
  'collective',
  'service',
  'event',
];
const statuses = ['active', 'inactive'] as const;

const pillClassName =
  'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap';
const emptyClassName = 'py-6 text-md text-muted-foreground';

/** The tabs the top bar shows for Settings → Calendars (shell/modules.ts): each is an address. */
export type CalendarsTab = 'calendars' | 'availability';

/** What one of the top bar's tabs shows. */
function TopPanel({
  shown,
  className,
  children,
}: {
  readonly shown: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement | null {
  return shown ? <div className={className}>{children}</div> : null;
}

/** A calendar's id under its name, with the button that copies it. */
function CalendarId({
  calendar,
  onCopied,
}: {
  readonly calendar: Calendar;
  readonly onCopied: (id: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const { id, name } = calendar;
  return (
    <span className="flex max-w-full min-w-0 items-center gap-1 text-xs text-body">
      <span className="min-w-0 truncate">
        <Trans>Id: {id}</Trans>
      </span>
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={t`Copy the id of ${name}`}
        title={t`Copy id`}
        onClick={() => {
          void navigator.clipboard.writeText(id).then(
            () => {
              setCopied(true);
              onCopied(id);
            },
            () => undefined,
          );
        }}
      >
        {copied ? (
          <Check aria-hidden className="size-4 text-success" strokeWidth={2} />
        ) : (
          <Copy aria-hidden className="size-4" strokeWidth={1.8} />
        )}
      </button>
    </span>
  );
}

function StatusCell({ calendar }: { readonly calendar: Calendar }): ReactElement {
  const stuck = !calendar.supported || (calendar.isActive && !calendar.bookable);
  return (
    <div className="flex flex-col items-start gap-0.5">
      {calendar.isActive ? (
        <span className={`${pillClassName} border-success-line bg-success-subtle text-success`}>
          <Trans>Active</Trans>
        </span>
      ) : (
        <span className={`${pillClassName} border-destructive bg-card text-destructive`}>
          <Trans>Inactive</Trans>
        </span>
      )}
      {stuck ? (
        <span className="text-xs text-body">
          <span className="font-medium">
            <Trans>Not bookable yet</Trans>
          </span>
          {': '}
          <span>
            {calendar.supported ? (
              <Trans>it needs its team.</Trans>
            ) : (
              <Trans>this type can't take bookings yet.</Trans>
            )}
          </span>
        </span>
      ) : null}
    </div>
  );
}

export function CalendarsPage({
  tab = 'calendars',
  client,
  business,
  agencySlug,
}: {
  /** Which of the top bar's tabs the address is. */
  readonly tab?: CalendarsTab;
  readonly client: Client;
  readonly business: BusinessSummary;
  /** The agency's slug: the first part of every public booking address. */
  readonly agencySlug: string;
}): ReactElement {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const navigation = useCalendarNavigation(business.slug);
  usePageTitle(t`Calendars`);
  const [filters, setFilters] = useState<ListFilters>(noFilters);
  const [search, setSearch] = useState('');
  const q = useSettled(search).trim();
  const [trail, setTrail] = useState(emptyTrail);
  // What the editor left to say, such as "Calendar deleted.": read once, then forgotten.
  const [notice, setNotice] = useState(
    () => cache.getQueryData<string>(calendarNoticeKey(business.id)) ?? '',
  );
  useEffect(() => {
    cache.removeQueries({ queryKey: calendarNoticeKey(business.id) });
  }, [cache, business.id]);
  const [dialogs, setDialogs] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [kind, setKind] = useState<CalendarKind>();
  const [deleting, setDeleting] = useState<Calendar>();
  const [deleteProblem, setDeleteProblem] = useState<string>();
  const [embedding, setEmbedding] = useState<{ name: string; address: string }>();
  const newButtonRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const after = trailCursor(trail);
  const asked = { ...filters, q };
  const list = useQuery({
    queryKey: [...calendarsKey(business.id), 'list', asked, after ?? ''],
    queryFn: () => client.request(listCalendars, { query: listQuery(asked, PAGE_SIZE, after) }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const groups = useQuery({
    queryKey: calendarGroupsKey(business.id),
    queryFn: () => client.request(listCalendarGroups, {}),
    retry: retryFaults,
  });
  const people = usePeople(client, business.id);
  const refresh = (): void => {
    void cache.invalidateQueries({ queryKey: calendarsKey(business.id) });
    void cache.invalidateQueries({ queryKey: calendarGroupsKey(business.id) });
  };
  const filter = (changed: Partial<ListFilters>): void => {
    setFilters((current) => ({ ...current, ...changed }));
    setTrail(emptyTrail);
  };

  const remove = useMutation({
    mutationFn: async (calendar: Calendar) => {
      await client.request(deleteCalendar, { params: { id: calendar.id } });
      return calendar;
    },
    onSuccess: (calendar) => {
      // The last row of a page is gone: show the page before it.
      if (list.data?.items.length === 1) setTrail(trailBack);
      setDeleting(undefined);
      const { name } = calendar;
      setNotice(t`${name} was deleted.`);
      cache.removeQueries({ queryKey: calendarKey(business.id, calendar.id) });
      refresh();
    },
    onError: (error) => {
      setDeleteProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`The calendar wasn't deleted. Try again.`)
          : t`The calendar wasn't deleted. Check your connection and try again.`,
      );
    },
  });

  const data = list.data;
  const canManage = data?.canManage === true;
  const items = data?.items ?? [];
  const turning = list.isFetching && list.isPlaceholderData;
  const filtered =
    q !== '' ||
    filters.status !== ALL ||
    filters.kind !== ALL ||
    filters.group !== ALL ||
    filters.member !== ANYONE;
  const range = rangeOf({
    index: trail.index,
    pageSize: PAGE_SIZE,
    shown: items.length,
    total: data?.total ?? items.length,
  });
  const { from, to, total } = range;
  const day = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const clock = new Intl.DateTimeFormat(i18n.locale, { timeStyle: 'short' });
  const deletingName = deleting?.name ?? '';

  return (
    <>
      <h1 className="sr-only">
        <Trans>Calendars</Trans>
      </h1>
      <TopPanel
        shown={tab === 'calendars'}
        className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start"
      >
        <GroupsRail
          client={client}
          groups={groups.data}
          failed={groups.isError}
          onRetry={() => {
            void groups.refetch();
          }}
          selected={filters.group}
          onSelect={(group) => {
            filter({ group });
          }}
          onChanged={(said) => {
            setNotice(said);
            refresh();
          }}
        />
        <section aria-label={t`Calendars`} className={`${listCardClassName} flex-1`}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select
              aria-label={t`Status`}
              className="w-auto max-w-full min-w-36"
              value={filters.status}
              onValueChange={(value) => {
                const status = statuses.find((each) => each === value) ?? ALL;
                filter({ status });
              }}
            >
              <option value={ALL}>{t`Status: All`}</option>
              <option value="active">{t`Status: Active`}</option>
              <option value="inactive">{t`Status: Inactive`}</option>
            </Select>
            <Select
              aria-label={t`Type`}
              className="w-auto max-w-full min-w-36"
              value={filters.kind}
              onValueChange={(value) => {
                filter({ kind: kinds.find((each) => each === value) ?? ALL });
              }}
            >
              <option value={ALL}>{t`Type: All`}</option>
              {kinds.map((each) => {
                const name = i18n._(kindNames[each]);
                return (
                  <option key={each} value={each}>
                    {t`Type: ${name}`}
                  </option>
                );
              })}
            </Select>
            <Select
              aria-label={t`Owned by`}
              className="w-auto max-w-full min-w-40"
              value={filters.member}
              onValueChange={(member) => {
                filter({ member });
              }}
            >
              <option value={ANYONE}>{t`Owned by: Anyone`}</option>
              {(people.data ?? []).map((person) => {
                const name = person.name === '' ? person.email : person.name;
                return (
                  <option key={person.membershipId} value={person.membershipId}>
                    {t`Owned by: ${name}`}
                  </option>
                );
              })}
            </Select>
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              <ListSearch
                label={t`Calendar/group name`}
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setTrail(emptyTrail);
                }}
              />
              {canManage ? (
                <Button
                  onClick={(event) => {
                    newButtonRef.current = event.currentTarget;
                    setDialogs(true);
                    setChoosing(true);
                  }}
                >
                  <Plus aria-hidden className="size-4" strokeWidth={2} />
                  <Trans>New calendar</Trans>
                </Button>
              ) : null}
            </div>
          </div>
          {data !== undefined && !canManage ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                You can see the calendars. Creating, changing and deleting them needs permission to
                manage calendars.
              </Trans>
            </p>
          ) : null}
          <p role="status" className="text-sm text-body empty:hidden">
            {notice}
          </p>
          {list.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading calendars…</Trans>
            </p>
          ) : null}
          {list.isError ? (
            <ListProblem
              onRetry={() => {
                void list.refetch();
              }}
            >
              <Trans>We couldn't load calendars.</Trans>
            </ListProblem>
          ) : null}
          {data !== undefined && items.length === 0 ? (
            <p className={`${emptyClassName} text-center`}>
              {filtered ? (
                <Trans>No calendars match.</Trans>
              ) : (
                <Trans>Create a calendar to set your team's availability.</Trans>
              )}
            </p>
          ) : null}
          {items.length === 0 ? null : (
            <div role="region" aria-label={t`Calendars table`} className={tableRegionClassName}>
              <table className={`${tableClassName} min-w-[1040px] table-fixed`}>
                <caption className="sr-only">
                  <Trans>Calendars</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Calendar name</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-36`}>
                      <Trans>Group</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-24`}>
                      <Trans>Duration</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-36`}>
                      <Trans>Type</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-44`}>
                      <Trans>Status</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-32`}>
                      <Trans>Date updated</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-44`}>
                      <Trans>Actions</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((calendar) => {
                    const { name } = calendar;
                    const minutes = calendar.slotMinutes;
                    const updated = new Date(calendar.updatedAt);
                    const address = bookingAddress(
                      window.location.origin,
                      agencySlug,
                      business.slug,
                      calendar.bookingSlug,
                    );
                    return (
                      <tr key={calendar.id} className="hover:bg-muted">
                        <th scope="row" className={`${cellClassName} text-left font-normal`}>
                          <div className="flex min-w-0 flex-col items-start">
                            <EditCalendarLink
                              slug={business.slug}
                              calendarId={calendar.id}
                              className="inline-flex min-h-11 max-w-full items-center rounded-control text-left font-medium wrap-anywhere text-link -outline-offset-2 hover:underline lg:min-h-7"
                            >
                              {name}
                            </EditCalendarLink>
                            <CalendarId
                              calendar={calendar}
                              onCopied={(id) => {
                                setNotice(t`Copied ${id}`);
                              }}
                            />
                          </div>
                        </th>
                        <td className={cellClassName}>
                          <span className="block truncate" title={calendar.groupName ?? ''}>
                            {calendar.groupName ?? ''}
                          </span>
                        </td>
                        <td className={`${cellClassName} whitespace-nowrap`}>
                          <Trans>{minutes} min</Trans>
                        </td>
                        <td className={cellClassName}>{i18n._(kindNames[calendar.kind])}</td>
                        <td className={cellClassName}>
                          <StatusCell calendar={calendar} />
                        </td>
                        <td className={cellClassName}>
                          <time dateTime={calendar.updatedAt} className="flex flex-col">
                            <span className="whitespace-nowrap">{day.format(updated)}</span>
                            <span className="text-xs whitespace-nowrap text-body">
                              {clock.format(updated)}
                            </span>
                          </time>
                        </td>
                        <td className={cellClassName}>
                          <span className="flex items-center gap-1">
                            <EditCalendarLink
                              slug={business.slug}
                              calendarId={calendar.id}
                              className={iconButtonClassName}
                              aria-label={canManage ? t`Edit ${name}` : t`View ${name}`}
                              title={canManage ? t`Edit` : t`View`}
                            >
                              <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                            </EditCalendarLink>
                            <button
                              type="button"
                              className={iconButtonClassName}
                              aria-label={t`Copy the booking link of ${name}`}
                              title={t`Copy booking link`}
                              onClick={() => {
                                void navigator.clipboard.writeText(address).then(
                                  () => {
                                    setNotice(t`Booking link copied.`);
                                  },
                                  () => undefined,
                                );
                              }}
                            >
                              <Share2 aria-hidden className="size-4" strokeWidth={1.8} />
                            </button>
                            <RowMenu
                              label={t`Actions for ${name}`}
                              onOpen={(trigger) => {
                                returnFocusRef.current = trigger;
                              }}
                              actions={[
                                // The booking page on the business's own website.
                                {
                                  label: t`Embed code`,
                                  onSelect: () => {
                                    setDialogs(true);
                                    setEmbedding({ name, address });
                                  },
                                },
                                ...(canManage
                                  ? [
                                      {
                                        label: t`Delete`,
                                        destructive: true,
                                        onSelect: () => {
                                          setDeleteProblem(undefined);
                                          setDeleting(calendar);
                                        },
                                      },
                                    ]
                                  : []),
                              ]}
                            />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data === undefined ? null : (
            <nav
              aria-label={t`Pages`}
              className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-sm text-body"
            >
              <p aria-busy={turning}>
                <Trans>
                  {from} - {to} of {total}
                </Trans>
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Previous page`}
                  disabled={trail.index === 0 || turning}
                  onClick={() => {
                    setTrail(trailBack);
                  }}
                >
                  <Trans>Previous</Trans>
                </Button>
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Next page`}
                  disabled={data.nextCursor === null || turning}
                  onClick={() => {
                    setTrail(trailForward(trail, data.nextCursor));
                  }}
                >
                  <Trans>Next</Trans>
                </Button>
              </div>
            </nav>
          )}
        </section>
      </TopPanel>
      <TopPanel shown={tab === 'availability'} className="flex min-w-0 flex-col gap-3">
        <p className="text-md text-muted-foreground">
          <Trans>
            Each person's own hours are set on their page in Settings, Users, under User
            availability. A calendar's hours are set in the calendar, under Availability.
          </Trans>
        </p>
        {people.isError ? (
          <p className="text-sm text-muted-foreground">
            <Trans>The team couldn't be loaded.</Trans>
          </p>
        ) : null}
        {people.data === undefined || people.data.length === 0 ? null : (
          <ul
            aria-label={t`People of this account`}
            className="flex min-w-0 flex-col divide-y divide-border rounded-lg border border-border bg-card sm:max-w-xl"
          >
            {people.data.map((person) => {
              const name = person.name === '' ? person.email : person.name;
              return (
                <li
                  key={person.membershipId}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 px-3 py-1"
                >
                  <span className="min-w-0 text-md wrap-anywhere">{name}</span>
                  <PersonLink
                    slug={business.slug}
                    membershipId={person.membershipId}
                    aria-label={t`Open in Users: ${name}`}
                    className="inline-flex min-h-11 items-center rounded-control text-sm font-medium text-link -outline-offset-2 hover:underline lg:min-h-8"
                  >
                    <Trans>Open in Users</Trans>
                  </PersonLink>
                </li>
              );
            })}
          </ul>
        )}
      </TopPanel>
      {dialogs ? (
        <PanelContent>
          <CalendarTypeDialog
            open={choosing}
            returnFocus={newButtonRef}
            onClose={() => {
              setChoosing(false);
            }}
            onChoose={(chosen) => {
              setChoosing(false);
              setKind(chosen);
            }}
          />
          <NewCalendarDialog
            kind={kind}
            client={client}
            business={business}
            agencySlug={agencySlug}
            readSchedules={canManage}
            returnFocus={newButtonRef}
            onClose={() => {
              setKind(undefined);
            }}
            onCreated={(configuration) => {
              setKind(undefined);
              cache.setQueryData(
                calendarKey(business.id, configuration.calendar.id),
                configuration,
              );
              const { name } = configuration.calendar;
              setNotice(t`${name} was created as a draft.`);
              setTrail(emptyTrail);
              refresh();
            }}
            onAdvanced={(draft) => {
              cache.setQueryData(calendarCarryKey(business.id), draft);
              navigation.toNew(draft.kind);
            }}
          />
          <CalendarEmbedDialog
            calendar={embedding}
            returnFocus={returnFocusRef}
            onClose={() => {
              setEmbedding(undefined);
            }}
          />
        </PanelContent>
      ) : null}
      <ConfirmDialog
        open={deleting !== undefined}
        returnFocus={returnFocusRef}
        title={<Trans>Delete {deletingName}?</Trans>}
        description={
          <Trans>
            Its team, hours and settings are deleted with it. A calendar that has appointments can't
            be deleted: make it inactive instead.
          </Trans>
        }
        confirmLabel={t`Delete`}
        destructive
        busy={remove.isPending}
        problem={deleteProblem}
        onClose={() => {
          if (!remove.isPending) setDeleting(undefined);
        }}
        onConfirm={() => {
          if (deleting !== undefined) remove.mutate(deleting);
        }}
      />
    </>
  );
}
