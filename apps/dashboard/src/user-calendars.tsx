// The Calendar configuration tab of Edit user: the business's calendars the person is on
// the team of, read-only. The list of calendars does not say who is on each, so each
// calendar's own read is asked for; fetched when the tab is first opened.
import { Trans } from '@lingui/react/macro';
import { getCalendar, type Calendar } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { useQueries } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { retryFaults } from './settings-list';
import { CalendarSettingsLink } from './users-links';
import { usersKey } from './users-rules';

const noteClassName = 'text-md text-muted-foreground';

/** The calendars of the business that the person is on the team of. */
export default function MemberCalendars({
  client,
  workspace,
  slug,
  membershipId,
  calendars,
}: {
  readonly client: Client;
  readonly workspace: string;
  readonly slug: string;
  readonly membershipId: string;
  readonly calendars: readonly Calendar[];
}): ReactElement {
  // The list of calendars does not say who is on each: each calendar's own read does.
  const teams = useQueries({
    queries: calendars.map((calendar) => ({
      queryKey: [...usersKey(workspace), 'calendar-team', calendar.id],
      queryFn: () => client.request(getCalendar, { params: { id: calendar.id } }),
      retry: retryFaults,
    })),
  });
  if (teams.some((team) => team.isPending))
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading calendars…</Trans>
      </p>
    );
  if (teams.some((team) => team.isError))
    return (
      <p role="alert" className="text-sm text-destructive">
        <Trans>The calendars couldn't be loaded. Reload the page to try again.</Trans>
      </p>
    );
  const theirs = calendars.filter(
    (_, index) =>
      teams[index]?.data?.members.some((member) => member.membershipId === membershipId) === true,
  );
  if (theirs.length === 0)
    return (
      <p className={noteClassName}>
        <Trans>
          This person isn't on any calendar yet. Add them to a calendar's team in{' '}
          <CalendarSettingsLink slug={slug} className="text-link underline underline-offset-2">
            Settings, Calendars
          </CalendarSettingsLink>
          .
        </Trans>
      </p>
    );
  return (
    <>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {theirs.map((calendar) => (
          <li
            key={calendar.id}
            className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5"
          >
            <span className="min-w-0 font-medium wrap-anywhere">{calendar.name}</span>
            <span className="text-sm text-muted-foreground">
              {calendar.kind === 'personal' ? (
                <Trans>Personal</Trans>
              ) : calendar.kind === 'round_robin' ? (
                <Trans>Round robin</Trans>
              ) : (
                <Trans>Collective</Trans>
              )}
              {' · '}
              {calendar.isActive ? <Trans>Active</Trans> : <Trans>Draft</Trans>}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        <Trans>
          A calendar's team and hours are set in{' '}
          <CalendarSettingsLink slug={slug} className="text-link underline underline-offset-2">
            Settings, Calendars
          </CalendarSettingsLink>
          .
        </Trans>
      </p>
    </>
  );
}
