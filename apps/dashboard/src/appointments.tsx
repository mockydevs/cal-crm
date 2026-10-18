// Calendars → Appointment list view, laid out as GoHighLevel's: the tabs Upcoming,
// Cancelled and All over one table, read from `listAppointments` a page at a time. The
// tabs, the chips, the title search and the two sortable headings are what that endpoint
// filters and orders by, and no others. A title opens the appointment in the panel at the
// right; booking and changing need the permission the server reports.
import { Trans, useLingui } from '@lingui/react/macro';
import { appointmentStatuses, listAppointments } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { AppointmentPanels, type OpenedAppointment } from './appointment-panels';
import {
  ANY,
  appointmentQueryOf,
  narrowed,
  noAppointmentFilters,
  ordered,
  soonestFirst,
  type AppointmentFilters,
  type AppointmentOrder,
  type AppointmentSort,
} from './appointment-rules';
import {
  appointmentsKey,
  AppointmentStatusPill,
  businessZone,
  useCalendarChoices,
  useEventTimes,
  useStatusName,
  useTeam,
} from './calendar-shared';
import { ContactName } from './conversation-extras-panel';
import { CountChip, ListSearch } from './list-toolbar';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListFooter,
  ListProblem,
  retryFaults,
  sortButtonClassName,
  tableClassName,
  tableRegionClassName,
  useSettled,
  ViewSwitch,
} from './settings-list';
import {
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type PageSize,
} from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

/** Whether the page asked for was anchored on an appointment that is no longer there. */
function cursorGone(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.problem.errors?.some((each) => each.path === '/after') === true
  );
}

export function AppointmentsPage(): ReactElement {
  const business = useBusiness();
  return <Appointments key={business.id} />;
}

function Appointments(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const times = useEventTimes(businessZone(business));
  const statusName = useStatusName();
  const team = useTeam(business.id);
  const calendars = useCalendarChoices(business.id);
  const [filters, setFilters] = useState<AppointmentFilters>(noAppointmentFilters);
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<AppointmentOrder>(soonestFirst);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const [opened, setOpened] = useState<OpenedAppointment>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Another list starts at its first page.
  const q = useSettled(search);
  const asked = { ...filters, q };
  const narrow = (next: Partial<AppointmentFilters>): void => {
    setFilters({ ...filters, ...next });
    setTrail(emptyTrail);
  };
  const [searched, setSearched] = useState(q);
  if (searched !== q) {
    setSearched(q);
    setTrail(emptyTrail);
  }

  const query = appointmentQueryOf(asked, order, pageSize, trailCursor(trail));
  const list = useQuery({
    queryKey: [...appointmentsKey(business.id), 'page', query],
    queryFn: () => apiIn(business.id).request(listAppointments, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const canManage = list.data?.canManage === true;
  const turning = list.isFetching && list.isPlaceholderData;
  const zone = times.zone;
  const tab = filters.view;
  const open = (next: OpenedAppointment, trigger: HTMLElement): void => {
    returnFocusRef.current = trigger;
    setOpened(next);
  };

  const sortable = (sort: AppointmentSort, label: ReactNode, className: string): ReactElement => {
    const mine = order.sort === sort;
    const ascending = order.direction === 'asc';
    return (
      <th
        scope="col"
        aria-sort={mine ? (ascending ? 'ascending' : 'descending') : undefined}
        className={`${headerCellClassName} ${className}`}
      >
        <button
          type="button"
          className={sortButtonClassName}
          onClick={() => {
            setOrder(ordered(order, sort));
            setTrail(emptyTrail);
          }}
        >
          {label}
          {mine ? (
            ascending ? (
              <ArrowUp aria-hidden className="size-3.5" strokeWidth={2} />
            ) : (
              <ArrowDown aria-hidden className="size-3.5" strokeWidth={2} />
            )
          ) : null}
        </button>
      </th>
    );
  };

  return (
    <Page
      title={t`Appointments`}
      actions={
        canManage ? (
          <Button
            onClick={(event) => {
              open({ kind: 'new' }, event.currentTarget);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>New appointment</Trans>
          </Button>
        ) : undefined
      }
    >
      <div>
        <ViewSwitch
          label={t`Appointment lists`}
          value={tab}
          onChange={(view) => {
            narrow({ view });
          }}
          views={[
            { value: 'upcoming', label: t`Upcoming` },
            { value: 'cancelled', label: t`Cancelled` },
            { value: 'all', label: t`All` },
          ]}
        />
      </div>
      <section aria-label={t`Appointments`} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 items-center gap-2 text-sm font-medium text-body">
            <Trans>Status</Trans>
            <Select
              aria-label={t`Status`}
              className="w-auto min-w-36 rounded-full"
              value={filters.status}
              onValueChange={(value) => {
                narrow({ status: appointmentStatuses.find((each) => each === value) ?? ANY });
              }}
            >
              <option value={ANY}>{t`Any status`}</option>
              {appointmentStatuses.map((status) => (
                <option key={status} value={status}>
                  {statusName(status)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-0 items-center gap-2 text-sm font-medium text-body">
            <Trans>Calendar</Trans>
            <Select
              aria-label={t`Calendar`}
              className="w-auto min-w-44 rounded-full"
              value={filters.calendar}
              onValueChange={(calendar) => {
                narrow({ calendar });
              }}
            >
              <option value={ANY}>{t`All calendars`}</option>
              {calendars.items.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </Select>
          </label>
          {team.data === undefined ? null : (
            <label className="flex min-w-0 items-center gap-2 text-sm font-medium text-body">
              <Trans>Appointment owner</Trans>
              <Select
                aria-label={t`Appointment owner`}
                className="w-auto min-w-40 rounded-full"
                value={filters.user}
                onValueChange={(user) => {
                  narrow({ user });
                }}
              >
                <option value={ANY}>{t`Anyone`}</option>
                {team.data.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name || member.email}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {list.data === undefined ? null : (
            <CountChip>
              {total === 1 ? <Trans>1 appointment</Trans> : <Trans>{total} appointments</Trans>}
            </CountChip>
          )}
          <div className="ml-auto flex min-w-0 flex-1 justify-end">
            <ListSearch label={t`Search by title`} value={search} onChange={setSearch} />
          </div>
        </div>
        {calendars.isError ? (
          <ListProblem onRetry={calendars.retry}>
            <Trans>The calendars to filter by couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {list.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading appointments…</Trans>
          </p>
        ) : null}
        {list.isError ? (
          <ListProblem
            onRetry={() => {
              if (cursorGone(list.error)) setTrail(emptyTrail);
              else void list.refetch();
            }}
          >
            <Trans>Appointments couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {list.data !== undefined && rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <h2 className="text-base font-medium text-foreground">
              {tab === 'upcoming' ? (
                <Trans>No upcoming appointments</Trans>
              ) : tab === 'cancelled' ? (
                <Trans>No cancelled appointments</Trans>
              ) : (
                <Trans>No appointments</Trans>
              )}
            </h2>
            <p className="text-md text-muted-foreground">
              {narrowed(asked) ? (
                <Trans>Nothing matches the filters and the search.</Trans>
              ) : tab === 'upcoming' ? (
                <Trans>Appointments that are booked and not yet over show here.</Trans>
              ) : tab === 'cancelled' ? (
                <Trans>Appointments that were cancelled show here.</Trans>
              ) : (
                <Trans>Nothing has been booked yet.</Trans>
              )}
            </p>
            {tab === 'all' ? null : (
              <Button
                onClick={() => {
                  narrow({ view: 'all' });
                }}
              >
                <Trans>See all appointments</Trans>
              </Button>
            )}
          </div>
        ) : null}
        {rows.length === 0 ? null : (
          <div role="region" aria-label={t`Appointments table`} className={tableRegionClassName}>
            <table className={`${tableClassName} min-w-[960px] table-fixed`}>
              <caption className="sr-only">
                <Trans>Appointments</Trans>
              </caption>
              <thead>
                <tr>
                  {sortable('title', <Trans>Title</Trans>, 'w-[22%]')}
                  <th scope="col" className={`${headerCellClassName} w-[18%]`}>
                    <Trans>Contact</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-32`}>
                    <Trans>Status</Trans>
                  </th>
                  {sortable('startsAt', <Trans>Appointment time ({zone})</Trans>, '')}
                  <th scope="col" className={`${headerCellClassName} w-[15%]`}>
                    <Trans>Calendar</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-[15%]`}>
                    <Trans>Appointment owner</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted">
                    <th scope="row" className={`${cellClassName} text-left font-normal`}>
                      <button
                        type="button"
                        className="inline-flex min-h-11 max-w-full items-center rounded-control text-left font-medium wrap-anywhere text-link -outline-offset-2 hover:underline lg:min-h-7"
                        onClick={(event) => {
                          open({ kind: 'view', id: row.id }, event.currentTarget);
                        }}
                      >
                        {row.title === '' ? t`Untitled` : row.title}
                      </button>
                    </th>
                    <td className={`${cellClassName} wrap-anywhere`}>
                      <ContactName contact={row.contact} />
                    </td>
                    <td className={cellClassName}>
                      <AppointmentStatusPill status={row.status} />
                    </td>
                    <td className={cellClassName}>
                      <time dateTime={row.startsAt}>{times.span(row)}</time>
                    </td>
                    <td className={`${cellClassName} wrap-anywhere`}>{row.calendar.name}</td>
                    <td className={`${cellClassName} wrap-anywhere`}>
                      {row.assignee === null ? (
                        <span className="text-muted-foreground">
                          <Trans>Unassigned</Trans>
                        </span>
                      ) : row.assignee.you ? (
                        <Trans>You</Trans>
                      ) : row.assignee.name === '' ? (
                        <Trans>Former team member</Trans>
                      ) : (
                        row.assignee.name
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data === undefined ? null : (
          <ListFooter
            perPageLabel={t`Appointments per page`}
            pageSize={pageSize}
            onPageSize={(size) => {
              setPageSize(size);
              setTrail(emptyTrail);
            }}
            range={rangeOf({ index: trail.index, pageSize, shown: rows.length, total })}
            number={trail.index + 1}
            previous={trail.index > 0}
            next={list.data.next !== null}
            busy={turning}
            onPrevious={() => {
              setTrail(trailBack);
            }}
            onNext={() => {
              setTrail(trailForward(trail, list.data.next));
            }}
          />
        )}
      </section>

      <AppointmentPanels
        opened={opened}
        returnFocus={returnFocusRef}
        onOpen={setOpened}
        onClose={() => {
          setOpened(undefined);
        }}
      />
    </Page>
  );
}
