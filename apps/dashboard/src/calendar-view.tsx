// Calendars → Calendar view, laid out as GoHighLevel's: a toolbar with Today, the way to
// the period before and after, and the day, week or month switch; "Manage view" and "+ New"
// (an appointment, or a blocked slot) at the right; then the grid with every appointment
// and blocked slot `listCalendarEvents` answers for the days shown. The grid is drawn in
// the business's time zone, as GoHighLevel draws a sub-account's, and says which zone that
// is.
import { Trans, useLingui } from '@lingui/react/macro';
import { listCalendarEvents, type CalendarEvent } from '@repo/contracts';
import { Button, buttonVariants } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Select } from '@repo/ui/components/select';
import { cn } from '@repo/ui/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Plus, SlidersHorizontal } from 'lucide-react';
import { lazy, useEffect, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { AppointmentPanels, type OpenedAppointment } from './appointment-panels';
import {
  DAY_MINUTES,
  dayKey,
  daysOf,
  filterCount,
  noFilters,
  onDay,
  placedOn,
  sameDay,
  stepped,
  todayIn,
  wallClock,
  windowOf,
  type CalendarFilters,
  type CalendarViewMode,
} from './calendar-rules';
import {
  businessZone,
  eventsKey,
  useEventTimes,
  useMayBook,
  usePersonName,
  useStatusName,
  type BlockedEvent,
} from './calendar-shared';
import { RightPanel } from './conversation-extras-panel';
import { PanelContent } from './list-toolbar';
import { iconButtonClassName, listCardClassName, ListProblem, retryFaults } from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const BlockedDetails = lazy(async () => ({
  default: (await import('./calendar-event-panel')).BlockedDetails,
}));
const BlockedSlotForm = lazy(async () => ({
  default: (await import('./blocked-slot-form')).BlockedSlotForm,
}));
const ManageView = lazy(async () => ({
  default: (await import('./calendar-manage-view')).ManageView,
}));

/** The height of an hour in the day and week grids. */
const HOUR_PX = 56;
const MINUTE_PX = HOUR_PX / 60;
/** The most events a day of the month grid lists before "more". */
const MONTH_DAY_EVENTS = 3;

const blockClassNames: Readonly<Record<string, string>> = {
  booked: cn('border-l-[3px] border-primary bg-accent text-link'),
  confirmed: cn('border-l-[3px] border-success bg-success-subtle text-success'),
  completed: cn('border-l-[3px] border-input bg-secondary text-secondary-foreground'),
  cancelled: cn('border border-destructive bg-card text-destructive line-through'),
  no_show: cn('border-l-[3px] border-attention-foreground bg-attention text-attention-foreground'),
  invalid: cn('border border-destructive bg-card text-destructive line-through'),
  blocked: cn('border border-dashed border-input bg-muted text-body'),
};
const blockClassName = (event: CalendarEvent): string =>
  blockClassNames[event.kind === 'blocked' ? 'blocked' : event.status] ?? '';

const eventKey = (event: CalendarEvent): string => event.id;

/** The minute it is, read again as each minute passes. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

export interface CalendarViewProps {
  /** The appointment the address names, shown in the panel at the right. */
  readonly appointment: string | undefined;
  readonly onAppointment: (id: string | undefined) => void;
}

export function CalendarViewPage(props: CalendarViewProps): ReactElement {
  const business = useBusiness();
  return <CalendarView key={business.id} {...props} />;
}

function CalendarView({ appointment, onAppointment }: CalendarViewProps): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const zone = businessZone(business);
  const now = useNow();
  const today = todayIn(zone, now);
  const times = useEventTimes(zone);
  const statusName = useStatusName();
  const personName = usePersonName(business.id);
  const [view, setView] = useState<CalendarViewMode>('week');
  const [anchor, setAnchor] = useState(() => todayIn(zone));
  const [filters, setFilters] = useState<CalendarFilters>(noFilters);
  const [opened, setOpened] = useState<BlockedEvent>();
  // The blocked slot form: a new one, or the one pressed on the calendar.
  const [blocking, setBlocking] = useState<{ readonly slotId: string | undefined }>();
  const [notice, setNotice] = useState('');
  // The form that books or moves; the appointment whose details show is in the address.
  const [form, setForm] = useState<OpenedAppointment>();
  const mayBook = useMayBook(business.id);
  const panel: OpenedAppointment | undefined =
    form ?? (appointment === undefined ? undefined : { kind: 'view', id: appointment });
  const [managing, setManaging] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const days = daysOf(view, anchor);
  const { from, to } = windowOf(days, zone);
  const query = {
    from: from.toISOString(),
    to: to.toISOString(),
    type: filters.type,
    ...(filters.users.length === 0 ? {} : { users: filters.users.join(',') }),
    ...(filters.calendars.length === 0 ? {} : { calendars: filters.calendars.join(',') }),
  };
  const events = useQuery({
    queryKey: [...eventsKey(business.id), query],
    queryFn: () => apiIn(business.id).request(listCalendarEvents, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const items = events.data?.items ?? [];
  // Whether blocked slots can be added and changed here: the events' read says.
  const mayBlock = events.data?.canManage === true;

  // The day and week grids open on the working morning, as GoHighLevel's do.
  useEffect(() => {
    if (view !== 'month' && scrollerRef.current !== null)
      scrollerRef.current.scrollTop = 7 * HOUR_PX;
  }, [view]);

  const first = days[0] ?? anchor;
  const last = days.at(-1) ?? anchor;
  // A day is a date with no zone of its own (calendar-rules.ts), so it is named in UTC.
  const named = { timeZone: 'UTC' } as const;
  const period =
    view === 'day'
      ? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'full', ...named }).format(anchor)
      : view === 'week'
        ? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', ...named }).formatRange(
            first,
            last,
          )
        : new Intl.DateTimeFormat(i18n.locale, {
            month: 'long',
            year: 'numeric',
            ...named,
          }).format(anchor);
  const weekday = new Intl.DateTimeFormat(i18n.locale, { weekday: 'short', ...named });
  const fullDay = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'full', ...named });
  const hour = new Intl.DateTimeFormat(i18n.locale, { hour: 'numeric', ...named });
  const narrowed = filterCount(filters);

  /** A blocked slot shows its title to whoever may read it, as GoHighLevel's does. */
  const titleOf = (event: CalendarEvent): string => {
    if (event.kind === 'blocked')
      return event.title === null || event.title === '' ? t`Blocked slot` : event.title;
    return event.title === '' ? event.contact.name || t`Appointment` : event.title;
  };
  /** What a screen reader hears for an event: its name, its time, then its status or person. */
  const nameOf = (event: CalendarEvent): string => {
    const title = event.kind === 'blocked' ? t`Blocked slot` : titleOf(event);
    const span = times.span(event);
    const detail =
      event.kind === 'appointment'
        ? statusName(event.status)
        : (personName(event.user) ?? event.calendar?.name ?? '');
    return t`${title}, ${span}, ${detail}`;
  };
  const open = (event: CalendarEvent, trigger: HTMLElement): void => {
    returnFocusRef.current = trigger;
    if (event.kind === 'blocked') setOpened(event);
    else onAppointment(event.id);
  };
  const showDay = (day: Date): void => {
    setAnchor(day);
    setView('day');
  };

  return (
    <Page
      title={t`Calendars`}
      actions={
        mayBook || mayBlock ? (
          // GoHighLevel's "+ New": an appointment, or time nobody can book.
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants()}
              onClick={(event) => {
                returnFocusRef.current = event.currentTarget;
              }}
            >
              <Plus aria-hidden className="size-4" strokeWidth={2} />
              <Trans>New</Trans>
              <ChevronDown aria-hidden className="size-4" strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mayBook ? (
                <DropdownMenuItem
                  onClick={() => {
                    setForm({ kind: 'new' });
                  }}
                >
                  <Trans>Appointment</Trans>
                </DropdownMenuItem>
              ) : null}
              {mayBlock ? (
                <DropdownMenuItem
                  onClick={() => {
                    setBlocking({ slotId: undefined });
                  }}
                >
                  <Trans>Blocked slot</Trans>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
    >
      <p role="status" className="mb-3 text-sm text-body empty:hidden">
        {notice}
      </p>
      <section aria-label={t`Calendar view`} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setAnchor(todayIn(zone));
            }}
          >
            <Trans>Today</Trans>
          </Button>
          <div className="flex items-center">
            <button
              type="button"
              className={iconButtonClassName}
              aria-label={
                view === 'day'
                  ? t`Previous day`
                  : view === 'week'
                    ? t`Previous week`
                    : t`Previous month`
              }
              onClick={() => {
                setAnchor(stepped(view, anchor, -1));
              }}
            >
              <ChevronLeft aria-hidden className="size-5" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={iconButtonClassName}
              aria-label={
                view === 'day' ? t`Next day` : view === 'week' ? t`Next week` : t`Next month`
              }
              onClick={() => {
                setAnchor(stepped(view, anchor, 1));
              }}
            >
              <ChevronRight aria-hidden className="size-5" strokeWidth={1.8} />
            </button>
          </div>
          <p role="status" className="min-w-0 text-base font-medium wrap-anywhere text-foreground">
            {period}
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select
              aria-label={t`View`}
              className="w-auto min-w-36"
              value={view}
              onValueChange={(next) => {
                if (next === 'day' || next === 'week' || next === 'month') setView(next);
              }}
            >
              <option value="day">{t`Day view`}</option>
              <option value="week">{t`Week view`}</option>
              <option value="month">{t`Month view`}</option>
            </Select>
            <Button
              variant="secondary"
              onClick={(event) => {
                returnFocusRef.current = event.currentTarget;
                setManaging(true);
              }}
            >
              <SlidersHorizontal aria-hidden className="size-4" strokeWidth={1.8} />
              {narrowed === 0 ? (
                <Trans>Manage view</Trans>
              ) : (
                <Trans>Manage view ({narrowed})</Trans>
              )}
            </Button>
          </div>
        </div>
        {events.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading the calendar…</Trans>
          </p>
        ) : null}
        {events.isError ? (
          <ListProblem
            onRetry={() => {
              void events.refetch();
            }}
          >
            <Trans>The calendar couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {events.data?.truncated === true ? (
          <p className="text-sm text-body">
            <Trans>
              There is more in this period than one view can hold, so only the earliest events show.
              Choose a shorter view, or narrow it with Manage view.
            </Trans>
          </p>
        ) : null}
        {events.data !== undefined && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {narrowed === 0 ? (
              <Trans>Nothing is booked or blocked in this period.</Trans>
            ) : (
              <Trans>Nothing in this period matches the view.</Trans>
            )}
          </p>
        ) : null}

        {view === 'month' ? (
          <div
            role="region"
            aria-label={t`Calendar`}
            className="max-w-full overflow-x-auto rounded-lg border border-border"
          >
            <div className="grid min-w-[720px] grid-cols-7">
              {days.slice(0, 7).map((day) => (
                <div key={dayKey(day)} className="bg-muted px-2 py-2 text-xs font-medium text-body">
                  {weekday.format(day)}
                </div>
              ))}
              {days.map((day) => {
                const todays = items.filter((event) => onDay(event, day, zone));
                const more = todays.length - MONTH_DAY_EVENTS;
                const date = fullDay.format(day);
                const outside = day.getUTCMonth() !== anchor.getUTCMonth();
                return (
                  <div
                    key={dayKey(day)}
                    role="group"
                    aria-label={date}
                    className={`flex min-h-28 min-w-0 flex-col gap-1 border-t border-l border-border p-1 nth-[7n+1]:border-l-0 ${outside ? 'bg-muted' : ''}`}
                  >
                    <button
                      type="button"
                      aria-label={t`Show ${date}`}
                      aria-current={sameDay(day, today) ? 'date' : undefined}
                      className="inline-flex size-11 items-center justify-center self-start rounded-full text-sm font-medium text-body -outline-offset-2 hover:bg-secondary aria-[current=date]:bg-primary aria-[current=date]:text-primary-foreground lg:size-7"
                      onClick={() => {
                        showDay(day);
                      }}
                    >
                      {day.getUTCDate()}
                    </button>
                    {todays.length === 0 ? null : (
                      <ul className="flex min-w-0 flex-col gap-1">
                        {todays.slice(0, MONTH_DAY_EVENTS).map((event) => (
                          <li key={eventKey(event)} className="min-w-0">
                            <button
                              type="button"
                              aria-label={nameOf(event)}
                              className={`flex min-h-11 w-full min-w-0 items-center gap-1 rounded-control px-1.5 text-left text-xs -outline-offset-2 lg:min-h-6 ${blockClassName(event)}`}
                              onClick={(press) => {
                                open(event, press.currentTarget);
                              }}
                            >
                              <span className="shrink-0 font-medium">
                                {times.time(event.startsAt)}
                              </span>
                              <span className="truncate">{titleOf(event)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {more > 0 ? (
                      <button
                        type="button"
                        aria-label={t`${more} more on ${date}`}
                        className="inline-flex min-h-11 items-center self-start rounded-control px-1.5 text-xs font-medium text-link -outline-offset-2 hover:underline lg:min-h-6"
                        onClick={() => {
                          showDay(day);
                        }}
                      >
                        <Trans>+{more} more</Trans>
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            ref={scrollerRef}
            role="region"
            aria-label={t`Calendar`}
            className="relative max-h-[max(420px,calc(100dvh-300px))] max-w-full overflow-auto rounded-lg border border-border"
          >
            <div
              className={`grid ${view === 'week' ? 'min-w-[760px]' : ''}`}
              style={{
                gridTemplateColumns: `64px repeat(${String(days.length)}, minmax(0, 1fr))`,
              }}
            >
              <div className="sticky top-0 z-20 flex items-end border-b border-border bg-card px-1 pb-1 text-[11px] leading-tight wrap-anywhere text-muted-foreground">
                {times.zone}
              </div>
              {days.map((day) => {
                const isToday = sameDay(day, today);
                const date = fullDay.format(day);
                return (
                  <div
                    key={dayKey(day)}
                    className="sticky top-0 z-20 flex min-w-0 flex-col items-center gap-0.5 border-b border-l border-border bg-card py-1.5"
                  >
                    <span className={`text-xs font-medium ${isToday ? 'text-link' : 'text-body'}`}>
                      {weekday.format(day)}
                    </span>
                    <button
                      type="button"
                      aria-label={view === 'week' ? t`Show ${date}` : t`Show the week of ${date}`}
                      aria-current={isToday ? 'date' : undefined}
                      className="inline-flex size-11 items-center justify-center rounded-full text-base font-medium text-foreground -outline-offset-2 hover:bg-secondary aria-[current=date]:bg-primary aria-[current=date]:text-primary-foreground lg:size-8"
                      onClick={() => {
                        if (view === 'week') showDay(day);
                        else setView('week');
                      }}
                    >
                      {day.getUTCDate()}
                    </button>
                  </div>
                );
              })}
              <div aria-hidden>
                {Array.from({ length: 24 }, (_, index) => (
                  <div
                    key={index}
                    className="pr-1.5 text-right text-[11px] text-muted-foreground"
                    style={{ height: HOUR_PX }}
                  >
                    <span className="relative -top-2">
                      {index === 0 ? '' : hour.format(Date.UTC(2026, 0, 1, index))}
                    </span>
                  </div>
                ))}
              </div>
              {days.map((day) => {
                const placed = placedOn(day, items, zone);
                const minutesNow = wallClock(now.getTime(), zone).minutes;
                return (
                  <div
                    key={dayKey(day)}
                    role="group"
                    aria-label={fullDay.format(day)}
                    className="relative min-w-0 border-l border-border"
                    style={{ height: DAY_MINUTES * MINUTE_PX }}
                  >
                    {Array.from({ length: 24 }, (_, index) => (
                      <div
                        key={index}
                        aria-hidden
                        className={index === 0 ? '' : 'border-t border-border'}
                        style={{ height: HOUR_PX }}
                      />
                    ))}
                    {sameDay(day, today) ? (
                      <div
                        aria-hidden
                        data-now
                        className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-destructive"
                        style={{ top: minutesNow * MINUTE_PX }}
                      />
                    ) : null}
                    {placed.length === 0 ? null : (
                      <ul>
                        {placed.map(({ event, top, height, column, columns }) => (
                          <li
                            key={eventKey(event)}
                            className="absolute p-px"
                            style={{
                              top: top * MINUTE_PX,
                              height: height * MINUTE_PX,
                              left: `${String((column / columns) * 100)}%`,
                              width: `${String(100 / columns)}%`,
                            }}
                          >
                            <button
                              type="button"
                              aria-label={nameOf(event)}
                              className={`flex size-full min-w-0 flex-col overflow-hidden rounded-control px-1.5 py-0.5 text-left text-xs leading-tight -outline-offset-2 ${blockClassName(event)}`}
                              onClick={(press) => {
                                open(event, press.currentTarget);
                              }}
                            >
                              <span className="truncate font-medium">{titleOf(event)}</span>
                              <span className="truncate">
                                {times.time(event.startsAt)} – {times.time(event.endsAt)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <RightPanel
        open={opened !== undefined}
        onClose={() => {
          setOpened(undefined);
        }}
        returnFocus={returnFocusRef}
        title={<Trans>Blocked slot</Trans>}
      >
        {opened === undefined ? null : (
          <PanelContent>
            <BlockedDetails
              event={opened}
              zone={zone}
              onEdit={
                mayBlock
                  ? () => {
                      setBlocking({ slotId: opened.id });
                      setOpened(undefined);
                    }
                  : undefined
              }
            />
          </PanelContent>
        )}
      </RightPanel>

      <RightPanel
        open={blocking !== undefined}
        onClose={() => {
          setBlocking(undefined);
        }}
        returnFocus={returnFocusRef}
        title={
          blocking?.slotId === undefined ? (
            <Trans>New blocked slot</Trans>
          ) : (
            <Trans>Edit blocked slot</Trans>
          )
        }
      >
        {blocking === undefined ? null : (
          <PanelContent>
            <BlockedSlotForm
              client={apiIn(business.id)}
              businessId={business.id}
              zone={zone}
              slotId={blocking.slotId}
              onDone={(words) => {
                setNotice(words);
                setBlocking(undefined);
              }}
              onCancel={() => {
                setBlocking(undefined);
              }}
            />
          </PanelContent>
        )}
      </RightPanel>

      <AppointmentPanels
        opened={panel}
        returnFocus={returnFocusRef}
        onOpen={(next) => {
          if (next.kind === 'view') {
            setForm(undefined);
            onAppointment(next.id);
          } else setForm(next);
        }}
        onClose={() => {
          setForm(undefined);
          if (appointment !== undefined) onAppointment(undefined);
        }}
      />

      <RightPanel
        open={managing}
        onClose={() => {
          setManaging(false);
        }}
        returnFocus={returnFocusRef}
        title={<Trans>Manage view</Trans>}
        description={<Trans>Choose what the calendar shows.</Trans>}
      >
        {managing ? (
          <PanelContent>
            <ManageView filters={filters} onChange={setFilters} />
          </PanelContent>
        ) : null}
      </RightPanel>
    </Page>
  );
}
