// The ways between the calendars list, the full editor and a person's own hours in
// Settings → Users. Written once here, so the screens name no address themselves.
import type { CalendarKind } from '@repo/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';

interface LinkProps {
  readonly slug: string;
  readonly className?: string;
  readonly title?: string;
  readonly 'aria-label'?: string;
  readonly children: ReactNode;
}

/** To the list of calendars. */
export function CalendarsLink({ slug, children, ...rest }: LinkProps): ReactElement {
  return (
    <Link to="/b/$slug/settings/calendars" params={{ slug }} {...rest}>
      {children}
    </Link>
  );
}

/** To the editor of one calendar. */
export function EditCalendarLink({
  slug,
  calendarId,
  children,
  ...rest
}: LinkProps & { readonly calendarId: string }): ReactElement {
  return (
    <Link to="/b/$slug/settings/calendars/$calendarId" params={{ slug, calendarId }} {...rest}>
      {children}
    </Link>
  );
}

/** To a person's page in Settings → Users, where their own hours are set. */
export function PersonLink({
  slug,
  membershipId,
  children,
  ...rest
}: LinkProps & { readonly membershipId: string }): ReactElement {
  return (
    <Link to="/b/$slug/settings/team/$userId" params={{ slug, userId: membershipId }} {...rest}>
      {children}
    </Link>
  );
}

export interface CalendarNavigation {
  readonly toList: () => void;
  /** The editor of a saved calendar, in place of the page showing. */
  readonly toCalendar: (calendarId: string) => void;
  /** The editor of a new calendar of a type. */
  readonly toNew: (kind: CalendarKind) => void;
}

export function useCalendarNavigation(slug: string): CalendarNavigation {
  const navigate = useNavigate();
  return {
    toList: () => {
      void navigate({ to: '/b/$slug/settings/calendars', params: { slug } });
    },
    toCalendar: (calendarId) => {
      void navigate({
        to: '/b/$slug/settings/calendars/$calendarId',
        params: { slug, calendarId },
        replace: true,
      });
    },
    toNew: (kind) => {
      void navigate({
        to: '/b/$slug/settings/calendars/new',
        params: { slug },
        search: { type: kind },
      });
    },
  };
}
