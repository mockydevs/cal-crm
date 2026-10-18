// What the three tabs of Settings → External Tracking share: the page's heading and line, as
// GoHighLevel's, the reads of the API, and the looks of a card.
import { useLingui } from '@lingui/react/macro';
import { getExternalTracking, getMyPermissions, type ExternalTracking } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { apiIn } from '../api';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';

export const cardClassName =
  'flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4 sm:p-5';

export const settingsKey = (businessId: string) => ['b', businessId, 'external-tracking'] as const;

/** Twice for a fault of the server or the connection; never for an answer that would repeat. */
export const retryFaults = (failures: number, error: unknown): boolean =>
  !(error instanceof ApiError && error.status < 500) && failures < 2;

export function useTrackingSettings(): UseQueryResult<ExternalTracking, unknown> {
  const business = useBusiness();
  return useQuery({
    queryKey: settingsKey(business.id),
    queryFn: (): Promise<ExternalTracking> => apiIn(business.id).request(getExternalTracking, {}),
    retry: retryFaults,
  });
}

export function useMayManageSites(): boolean {
  const business = useBusiness();
  const grants = useQuery({
    queryKey: ['b', business.id, 'my-permissions'],
    queryFn: () => apiIn(business.id).request(getMyPermissions, {}),
    retry: retryFaults,
  });
  return grants.data?.permissions.includes('sites.manage') === true;
}

/** What went wrong, in the server's words when it said any. */
export function problemOf(error: unknown, otherwise: string): string {
  if (!(error instanceof ApiError)) return otherwise;
  return error.problem.detail ?? otherwise;
}

export function TrackingFrame({ children }: { readonly children: ReactNode }): ReactElement {
  const { t } = useLingui();
  return (
    <Page title={t`External Tracking`}>
      <p className="text-md text-muted-foreground">
        {t`Use our tracking script on your external sites to bring all your analytics - all in one place, with no extra tools needed.`}
      </p>
      {children}
    </Page>
  );
}
