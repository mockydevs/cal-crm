// What the Calendar view and the Appointment list view both show of an event: an
// appointment's status as a pill, who it is with, and its time, in the business's zone.
// People are named from the business team, or by the name the event carries.
import { useLingui } from '@lingui/react/macro';
import {
  listAppointments,
  listCalendars,
  listTeam,
  type BusinessSummary,
  type Calendar,
  type CalendarEvent,
  type Team,
} from '@repo/contracts';
import { cn } from '@repo/ui/lib/utils';
import { useInfiniteQuery, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import { apiIn } from './api';
import { browserZone } from './calendar-rules';
import { retryFaults } from './settings-list';

export type AppointmentEvent = Extract<CalendarEvent, { kind: 'appointment' }>;
export type BlockedEvent = Extract<CalendarEvent, { kind: 'blocked' }>;
export type AppointmentStatus = AppointmentEvent['status'];
type Person = BlockedEvent['user'];

export const blockedSlotsKey = (businessId: string) => ['b', businessId, 'blocked-slots'] as const;

export const eventsKey = (businessId: string) => ['b', businessId, 'calendar-events'] as const;
export const appointmentsKey = (businessId: string) => ['b', businessId, 'appointments'] as const;
export const appointmentKey = (businessId: string, id: string) =>
  ['b', businessId, 'appointment', id] as const;

/**
 * Whether the person may book and change appointments, as `listAppointments` says: the
 * events the calendar reads say only whether they may manage calendars.
 */
export function useMayBook(businessId: string): boolean {
  const asked = useQuery({
    queryKey: [...appointmentsKey(businessId), 'may-book'],
    queryFn: () =>
      apiIn(businessId).request(listAppointments, { query: { view: 'upcoming', limit: 1 } }),
    retry: retryFaults,
  });
  return asked.data?.canManage === true;
}

/** A status in words. */
export function useStatusName(): (status: AppointmentStatus) => string {
  const { t } = useLingui();
  return (status) =>
    status === 'booked'
      ? t`Booked`
      : status === 'confirmed'
        ? t`Confirmed`
        : status === 'cancelled'
          ? t`Cancelled`
          : status === 'no_show'
            ? t`No show`
            : status === 'invalid'
              ? t`Invalid`
              : t`Completed`;
}

const pillClassNames: Readonly<Record<AppointmentStatus, string>> = {
  booked: cn('border-transparent bg-accent text-link'),
  confirmed: cn('border-success-line bg-success-subtle text-success'),
  completed: cn('border-transparent bg-secondary text-secondary-foreground'),
  cancelled: cn('border-destructive bg-card text-destructive'),
  no_show: cn('border-transparent bg-attention text-attention-foreground'),
  invalid: cn('border-destructive bg-card text-destructive'),
};

export function AppointmentStatusPill({
  status,
}: {
  readonly status: AppointmentStatus;
}): ReactElement {
  const name = useStatusName();
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${pillClassNames[status]}`}
    >
      {name(status)}
    </span>
  );
}

/** The business team, read once for the calendar pages and the calendar form. */
export function useTeam(businessId: string): UseQueryResult<Team> {
  return useQuery<Team>({
    queryKey: ['calendar-team', businessId],
    queryFn: () => apiIn(businessId).request(listTeam, {}),
    retry: retryFaults,
  });
}

/**
 * Every calendar of the business, for a filter to choose from: `listCalendars` answers 50
 * at a time, so the pages after the first are read as each one arrives.
 */
export function useCalendarChoices(businessId: string): {
  readonly items: readonly Calendar[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly retry: () => void;
} {
  const calendars = useInfiniteQuery({
    queryKey: ['b', businessId, 'calendar-choices'],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiIn(businessId).request(listCalendars, {
        query: { limit: 50, ...(pageParam === '' ? {} : { after: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: retryFaults,
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = calendars;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  return {
    items: calendars.data?.pages.flatMap((page) => page.items) ?? [],
    isPending: calendars.isPending,
    isError,
    retry: () => {
      void (calendars.data === undefined ? calendars.refetch() : fetchNextPage());
    },
  };
}

/**
 * Names a person an event carries: "You", their name on the team, or that they have left.
 * Someone who may not read the team still gets the name the event itself carries.
 */
export function usePersonName(businessId: string): (person: Person | null) => string | undefined {
  const { t } = useLingui();
  const team = useTeam(businessId).data;
  return (person) => {
    if (person === null) return undefined;
    if (person.you) return t`You`;
    if (person.membershipId === null) return t`Former team member`;
    const member = team?.members.find((each) => each.id === person.membershipId);
    if (member !== undefined) return member.name || member.email;
    return person.name === undefined || person.name === '' ? t`Team member` : person.name;
  };
}

/** The zone a business's calendar is drawn in: its own, or this machine's when not known. */
export function businessZone(business: Pick<BusinessSummary, 'timezone'>): string {
  return business.timezone ?? browserZone();
}

/**
 * Formats the times of events in the reader's language, in the zone given: the business's,
 * as the calendar is drawn in it, or this machine's when none is given.
 */
export function useEventTimes(timeZone?: string): {
  readonly time: (instant: string | Date) => string;
  readonly span: (event: { readonly startsAt: string; readonly endsAt: string }) => string;
  readonly zone: string;
} {
  const { i18n } = useLingui();
  const zone = timeZone ?? browserZone();
  const clock = new Intl.DateTimeFormat(i18n.locale, { timeStyle: 'short', timeZone: zone });
  const moment = new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  });
  return {
    time: (instant) => clock.format(new Date(instant)),
    span: (event) => moment.formatRange(new Date(event.startsAt), new Date(event.endsAt)),
    zone,
  };
}
