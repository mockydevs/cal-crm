// Google Calendar as the calendar screens other than Connections need it: whether the
// install connects Google and each member's connection, and the New appointment form's
// "Google not checked" line. Fetched on its own, so the form's chunk doesn't carry it.
import { Trans } from '@lingui/react/macro';
import { getGoogleConnections, type GoogleConnections } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { apiIn } from './api';
import { googleConnectionsKey, googleStatusOf } from './calendar-connections-rules';
import { retryFaults } from './settings-list';

/** The same query as Settings → Calendars → Connections, so a change there shows here. */
export function useGoogleConnections(
  businessId: string,
  client: Client = apiIn(businessId),
): UseQueryResult<GoogleConnections> {
  return useQuery<GoogleConnections>({
    queryKey: googleConnectionsKey(businessId),
    queryFn: () => client.request(getGoogleConnections, {}),
    retry: retryFaults,
  });
}

/**
 * Said under the appointment's owner when their Google Calendar is disconnected: their
 * conflicts are this CRM's alone. Nothing while the status isn't known.
 */
export default function GoogleUncheckedNote({
  businessId,
  owner,
}: {
  readonly businessId: string;
  readonly owner: { readonly id: string; readonly name: string };
}): ReactElement | null {
  const google = useGoogleConnections(businessId).data;
  if (googleStatusOf(google, owner.id) !== 'disconnected') return null;
  const ownerName = owner.name;
  return (
    <p role="note" className="text-sm leading-normal text-muted-foreground">
      <Trans>
        Google not checked: {ownerName}'s Google Calendar is disconnected, so only this CRM's
        calendar is checked for conflicts.
      </Trans>
    </p>
  );
}
