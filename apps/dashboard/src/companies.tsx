import { Trans } from '@lingui/react/macro';
import { getCompany, type Company } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { apiIn } from './api';

export const companyKey = (businessId: string, id: string): readonly string[] => [
  'b',
  businessId,
  'companies',
  id,
];
export function useCompany(businessId: string, id: string): UseQueryResult<Company> {
  return useQuery({
    queryKey: companyKey(businessId, id),
    queryFn: () => apiIn(businessId).request(getCompany, { params: { id } }),
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status === 404) && failures < 3,
  });
}
export function CompanyLoading({
  query,
}: {
  readonly query: UseQueryResult<Company>;
}): ReactElement | null {
  if (query.isPending)
    return (
      <p role="status">
        <Trans>Loading company…</Trans>
      </p>
    );
  if (query.error instanceof ApiError && query.error.status === 404)
    return (
      <p role="alert">
        <Trans>This company doesn't exist, or it belongs to another business.</Trans>
      </p>
    );
  if (query.isError)
    return (
      <div role="alert">
        <p>
          <Trans>The company couldn't be loaded.</Trans>
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            void query.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  return null;
}
