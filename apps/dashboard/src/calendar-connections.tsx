// Settings → Calendars → Connections, as GoHighLevel's Calendar Settings →
// Connections: each person connects their own Google account, chooses the one calendar
// their appointments are added to (the linked calendar) and the calendars whose busy time
// keeps bookings away (conflict calendars). Managers see every member's status, never a
// token. Nothing here is drawn on an install without Google's OAuth client.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  chooseGoogleCalendars,
  connectGoogle,
  disconnectGoogle,
  getGoogleConnections,
  GOOGLE_CONFLICT_CALENDARS_MAX,
  refreshGoogleCalendars,
  type GoogleConnectOutcome,
  type GoogleConnection,
  type GoogleConnections,
  type GoogleTeamConnection,
  type BusinessSummary,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactElement } from 'react';
import {
  choiceChanged,
  choiceInput,
  googleConnectionsKey,
  linkableCalendars,
  NO_LINKED_CALENDAR,
  savedChoice,
  toggledConflict,
  type CalendarChoice,
} from './calendar-connections-rules';
import { usePeople } from './calendar-settings-data';
import { timeAgo } from './notification-rules';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import { usePageTitle } from './shell/page';

const cardClassName = 'flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4 sm:p-5';

/** The server's words for a refusal, or the page's own. */
function problemOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.problem.detail ?? fallback) : fallback;
}

function OutcomeNotice({ outcome }: { readonly outcome: GoogleConnectOutcome }): ReactElement {
  const words: Record<GoogleConnectOutcome, ReactElement> = {
    connected: (
      <Trans>
        Google Calendar is connected. Your calendars are being read; this takes a moment.
      </Trans>
    ),
    denied: (
      <Trans>Google Calendar wasn't connected: access wasn't allowed on Google's page.</Trans>
    ),
    scopes_missing: (
      <Trans>
        Google Calendar wasn't connected: Google didn't give every permission. Connect again and
        tick every box.
      </Trans>
    ),
    expired: <Trans>That connection took too long or was already used. Connect again.</Trans>,
    failed: <Trans>Google Calendar couldn't be connected. Try again.</Trans>,
  };
  return (
    <p
      role={outcome === 'connected' ? 'status' : 'alert'}
      className={
        outcome === 'connected'
          ? 'rounded-md border bg-muted/40 p-3 text-sm'
          : 'rounded-md border border-destructive/40 p-3 text-sm font-medium text-destructive'
      }
    >
      {words[outcome]}
    </p>
  );
}

function DisconnectedNotice({
  connection,
}: {
  readonly connection: GoogleConnection;
}): ReactElement {
  const { email } = connection;
  return (
    <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
      {connection.disconnectedReason === 'expired_or_revoked' ? (
        <Trans>
          Google stopped accepting the connection for {email}. Until you connect again, bookings
          check only this CRM's calendar, not your Google Calendar.
        </Trans>
      ) : connection.disconnectedReason === 'membership_ended' ? (
        <Trans>
          {email} was disconnected when you left this business's team. Bookings don't check it.
        </Trans>
      ) : (
        <Trans>You disconnected {email}. Bookings check only this CRM's calendar.</Trans>
      )}
    </p>
  );
}

function ConnectCard({
  client,
  again,
}: {
  readonly client: Client;
  /** Whether a connection was made before: the button says "Connect again". */
  readonly again: boolean;
}): ReactElement {
  const { t } = useLingui();
  const connect = useMutation({
    mutationFn: () => client.request(connectGoogle, {}),
    onSuccess: (started) => {
      // Google's own page, in this tab: it sends the browser back here.
      window.location.assign(started.authorizationUrl);
    },
  });
  return (
    <section aria-labelledby="google-connect" className={cardClassName}>
      <div className="flex flex-col gap-1">
        <h2 id="google-connect" className="text-base font-semibold">
          <Trans>Google Calendar</Trans>
        </h2>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Connect your Google account: times you're busy in Google aren't offered for booking, and
            your appointments are added to your Google Calendar.
          </Trans>
        </p>
      </div>
      <div>
        <Button
          disabled={connect.isPending}
          onClick={() => {
            connect.mutate();
          }}
        >
          {again ? <Trans>Connect again</Trans> : <Trans>Connect Google</Trans>}
        </Button>
      </div>
      {connect.isError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problemOf(connect.error, t`Google couldn't be reached from here. Try again.`)}
        </p>
      ) : null}
    </section>
  );
}

function ConnectedCard({
  client,
  businessId,
  connection,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly connection: GoogleConnection;
}): ReactElement {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const linkedId = useId();
  const conflictsId = useId();
  const [choice, setChoice] = useState<CalendarChoice>(() => savedChoice(connection));
  const [saved, setSaved] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  // One moment for the times shown, taken when the card is drawn.
  const [now] = useState(() => Date.now());
  const refresh = () => cache.invalidateQueries({ queryKey: googleConnectionsKey(businessId) });
  const save = useMutation({
    mutationFn: (chosen: CalendarChoice) =>
      client.request(chooseGoogleCalendars, { body: choiceInput(chosen) }),
    onSuccess: () => {
      setSaved(true);
    },
    onSettled: refresh,
  });
  const reread = useMutation({
    mutationFn: () => client.request(refreshGoogleCalendars, {}),
    onSettled: refresh,
  });
  const disconnect = useMutation({
    mutationFn: () => client.request(disconnectGoogle, {}),
    onSuccess: () => {
      setDisconnecting(false);
    },
    onSettled: refresh,
  });
  const linkable = linkableCalendars(connection);
  const nameOf = ({ name, primary }: { readonly name: string; readonly primary: boolean }) =>
    primary ? t`${name} (primary)` : name;
  const changed = choiceChanged(connection, choice);
  const reading = connection.status === 'connecting';
  const checked = connection.busyCheckedAt;
  const readAgo = checked === null ? '' : timeAgo(checked, now, i18n.locale);

  return (
    <section aria-labelledby="google-connected" className={cardClassName}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="google-connected" className="text-base font-semibold">
            <Trans>Google Calendar</Trans>
          </h2>
          <p className="text-sm break-all">{connection.email}</p>
          <p className="text-sm text-muted-foreground" role="status">
            {reading ? (
              <Trans>Reading your calendars…</Trans>
            ) : checked === null ? (
              <Trans>Your busy times haven't been read yet.</Trans>
            ) : (
              <Trans>Busy times read {readAgo}.</Trans>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={reread.isPending}
            onClick={() => {
              reread.mutate();
            }}
          >
            <Trans>Refresh</Trans>
          </Button>
          <Button
            ref={disconnectRef}
            variant="secondary"
            onClick={() => {
              setDisconnecting(true);
            }}
          >
            <Trans>Disconnect</Trans>
          </Button>
        </div>
      </div>
      {connection.busyFailing ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
          <Trans>
            Google isn't answering. Until it does, times not read from Google in the last 15 minutes
            aren't offered for you.
          </Trans>
        </p>
      ) : null}
      {reading ? null : (
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate(choice);
          }}
        >
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={linkedId} className="text-sm font-medium">
              <Trans>Linked calendar</Trans>
            </label>
            <p className="text-sm text-muted-foreground">
              <Trans>Where your new appointments are added.</Trans>
            </p>
            <Select
              id={linkedId}
              className="max-w-md"
              value={choice.linkedCalendarId ?? NO_LINKED_CALENDAR}
              onValueChange={(value) => {
                setSaved(false);
                setChoice((current) => ({
                  ...current,
                  linkedCalendarId: value === NO_LINKED_CALENDAR ? null : value,
                }));
              }}
            >
              <option value={NO_LINKED_CALENDAR}>{t`Don't add appointments to Google`}</option>
              {linkable.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {nameOf(calendar)}
                </option>
              ))}
            </Select>
          </div>
          <fieldset className="flex min-w-0 flex-col gap-1" aria-describedby={conflictsId}>
            <legend className="text-sm font-medium">
              <Trans>Conflict calendars</Trans>
            </legend>
            <p id={conflictsId} className="text-sm text-muted-foreground">
              <Trans>
                Times you're busy in these calendars aren't offered for booking. Check at most{' '}
                {GOOGLE_CONFLICT_CALENDARS_MAX}.
              </Trans>
            </p>
            {connection.calendars.map((calendar) => (
              <label key={calendar.id} className="flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  className="size-4 shrink-0"
                  checked={choice.conflictCalendarIds.includes(calendar.id)}
                  onChange={(event) => {
                    setSaved(false);
                    setChoice((current) =>
                      toggledConflict(connection, current, calendar.id, event.target.checked),
                    );
                  }}
                />
                <span className="min-w-0 break-words">{nameOf(calendar)}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!changed || save.isPending}>
              <Trans>Save</Trans>
            </Button>
            {saved && !changed ? (
              <p role="status" className="text-sm text-muted-foreground">
                <Trans>Saved. Your busy times are read again.</Trans>
              </p>
            ) : null}
            {save.isError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {problemOf(save.error, t`That wasn't saved. Check your connection and try again.`)}
              </p>
            ) : null}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={disconnecting}
        returnFocus={disconnectRef}
        title={<Trans>Disconnect Google Calendar?</Trans>}
        description={
          <Trans>
            Bookings stop checking your Google Calendar, and new appointments aren't added to it.
            Appointments already added stay there. Google's access is revoked.
          </Trans>
        }
        confirmLabel={t`Disconnect`}
        destructive
        busy={disconnect.isPending}
        problem={
          disconnect.isError
            ? problemOf(disconnect.error, t`It wasn't disconnected. Try again.`)
            : undefined
        }
        onClose={() => {
          if (!disconnect.isPending) setDisconnecting(false);
        }}
        onConfirm={() => {
          disconnect.mutate();
        }}
      />
    </section>
  );
}

function TeamTable({
  client,
  businessId,
  team,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly team: readonly GoogleTeamConnection[];
}): ReactElement {
  const { t, i18n } = useLingui();
  const people = usePeople(client, businessId);
  const [now] = useState(() => Date.now());
  const nameOf = (membershipId: string) =>
    people.data?.find((person) => person.membershipId === membershipId)?.name ?? t`A team member`;
  const statusOf = (row: GoogleTeamConnection) => {
    if (row.status === 'connecting') return t`Reading calendars`;
    if (row.status === 'disconnected')
      return row.disconnectedReason === 'expired_or_revoked'
        ? t`Disconnected by Google: only this CRM's calendar is checked`
        : t`Disconnected`;
    return row.busyFailing ? t`Connected, but Google isn't answering` : t`Connected`;
  };
  return (
    <section aria-labelledby="google-team" className="flex min-w-0 flex-col gap-2">
      <h2 id="google-team" className="text-base font-semibold">
        <Trans>Team connections</Trans>
      </h2>
      {team.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nobody on the team has connected a calendar yet.</Trans>
        </p>
      ) : (
        <div className={listCardClassName}>
          <div className={tableRegionClassName}>
            <table className={tableClassName}>
              <thead>
                <tr>
                  <th className={headerCellClassName}>
                    <Trans>Team member</Trans>
                  </th>
                  <th className={headerCellClassName}>
                    <Trans>Google Calendar</Trans>
                  </th>
                  <th className={headerCellClassName}>
                    <Trans>Busy times read</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {team.map((row) => (
                  <tr key={row.membershipId}>
                    <td className={cellClassName}>{nameOf(row.membershipId)}</td>
                    <td className={cellClassName}>{statusOf(row)}</td>
                    <td className={cellClassName}>
                      {row.busyCheckedAt === null
                        ? '—'
                        : timeAgo(row.busyCheckedAt, now, i18n.locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

export function CalendarConnectionsPage({
  client,
  business,
  outcome,
}: {
  readonly client: Client;
  readonly business: BusinessSummary;
  /** What Google's consent page came to, from the address it sent the browser back to. */
  readonly outcome: GoogleConnectOutcome | undefined;
}): ReactElement {
  const { t } = useLingui();
  usePageTitle(t`Calendars`);
  const read = useQuery({
    queryKey: googleConnectionsKey(business.id),
    queryFn: (): Promise<GoogleConnections> => client.request(getGoogleConnections, {}),
    retry: retryFaults,
    // While the worker reads a new connection's calendars, look again every few seconds.
    refetchInterval: (query) => (query.state.data?.mine?.status === 'connecting' ? 3000 : false),
  });
  const data = read.data;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <h1 className="sr-only">
        <Trans>Calendars</Trans>
      </h1>
      {outcome === undefined ? null : <OutcomeNotice outcome={outcome} />}
      {read.isError ? (
        <ListProblem
          onRetry={() => {
            void read.refetch();
          }}
        >
          <Trans>Your calendar connections couldn't be loaded.</Trans>
        </ListProblem>
      ) : data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : !data.available ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No calendar can be connected on this install.</Trans>
        </p>
      ) : (
        <>
          {data.mine?.status === 'disconnected' ? (
            <DisconnectedNotice connection={data.mine} />
          ) : null}
          {data.mine === null || data.mine.status === 'disconnected' ? (
            <ConnectCard client={client} again={data.mine !== null} />
          ) : (
            <ConnectedCard
              // A reading that brought another list of calendars starts the form again.
              key={`${data.mine.connectedAt}:${data.mine.calendars.map((each) => each.id).join(' ')}`}
              client={client}
              businessId={business.id}
              connection={data.mine}
            />
          )}
          {data.team === null ? null : (
            <TeamTable client={client} businessId={business.id} team={data.team} />
          )}
        </>
      )}
    </div>
  );
}
