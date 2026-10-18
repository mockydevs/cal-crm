// What Settings → Calendars reads beside the calendars themselves: the people who can be
// put on one, and the time zone a new calendar starts in.
import { getBusinessProfile, listUsers, type User } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { calendarPeopleKey, eligiblePeople, type Person } from './calendar-settings-rules';
import { retryFaults } from './settings-list';

/** Every person of the business's own team who has joined: the list comes a page at a time. */
async function accountPeople(client: Client): Promise<Person[]> {
  const items: User[] = [];
  let after: string | undefined;
  do {
    const page = await client.request(listUsers, {
      query: { type: 'account', limit: 100, ...(after === undefined ? {} : { after }) },
    });
    items.push(...page.items);
    after = page.next ?? undefined;
  } while (after !== undefined && items.length < 1000);
  return eligiblePeople(items);
}

/** The people a calendar can be given: only users on the account (decision 2). */
export function usePeople(client: Client, businessId: string): UseQueryResult<Person[], unknown> {
  return useQuery({
    queryKey: calendarPeopleKey(businessId),
    queryFn: () => accountPeople(client),
    retry: retryFaults,
    staleTime: 60_000,
  });
}

/**
 * The time zone a new calendar starts in: the business's own, or the browser's while the
 * profile is unread or cannot be read.
 */
export function useBusinessTimeZone(
  client: Client,
  businessId: string,
): { readonly timezone: string; readonly settled: boolean } {
  const profile = useQuery({
    queryKey: ['calendar-business-zone', businessId],
    queryFn: () => client.request(getBusinessProfile, {}),
    retry: false,
    staleTime: 10 * 60 * 1000,
  });
  return {
    timezone: profile.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    settled: !profile.isPending,
  };
}
