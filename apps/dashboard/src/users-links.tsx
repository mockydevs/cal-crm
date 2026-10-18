// The ways between the Users list and its Add and Edit pages. The agency's pages and a
// business's are the same screens at different addresses, so each link is written once here
// for both.
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';

/** Where the Users pages are: at the agency, or in the business with this slug. */
export type UsersPlace =
  { readonly kind: 'agency' } | { readonly kind: 'business'; readonly slug: string };

interface LinkProps {
  readonly place: UsersPlace;
  readonly className?: string;
  readonly title?: string;
  readonly 'aria-label'?: string;
  readonly children: ReactNode;
}

/** To the list of users. */
export function UsersLink({ place, children, ...rest }: LinkProps): ReactElement {
  return place.kind === 'agency' ? (
    <Link to="/agency/settings/team" {...rest}>
      {children}
    </Link>
  ) : (
    <Link to="/b/$slug/settings/team" params={{ slug: place.slug }} {...rest}>
      {children}
    </Link>
  );
}

/** To the Add user page. */
export function NewUserLink({ place, children, ...rest }: LinkProps): ReactElement {
  return place.kind === 'agency' ? (
    <Link to="/agency/settings/team/new" {...rest}>
      {children}
    </Link>
  ) : (
    <Link to="/b/$slug/settings/team/new" params={{ slug: place.slug }} {...rest}>
      {children}
    </Link>
  );
}

/** To the Edit user page of one person. */
export function EditUserLink({
  place,
  userId,
  children,
  ...rest
}: LinkProps & { readonly userId: string }): ReactElement {
  return place.kind === 'agency' ? (
    <Link to="/agency/settings/team/$userId" params={{ userId }} {...rest}>
      {children}
    </Link>
  ) : (
    <Link to="/b/$slug/settings/team/$userId" params={{ slug: place.slug, userId }} {...rest}>
      {children}
    </Link>
  );
}

/** To Settings → Calendars of a business, where a calendar's team and hours are set. */
export function CalendarSettingsLink({
  slug,
  className,
  children,
}: {
  readonly slug: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Link to="/b/$slug/settings/calendars" params={{ slug }} className={className}>
      {children}
    </Link>
  );
}

/** Goes back to the list, as after a save. */
export function useGoToUsers(place: UsersPlace): () => void {
  const navigate = useNavigate();
  return () => {
    void (place.kind === 'agency'
      ? navigate({ to: '/agency/settings/team' })
      : navigate({ to: '/b/$slug/settings/team', params: { slug: place.slug } }));
  };
}
