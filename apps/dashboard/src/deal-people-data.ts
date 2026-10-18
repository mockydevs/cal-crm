// Who an opportunity is with and whose it is, as the dialog reads it: one read, GET
// /deals/{id}/details, whose answer every change gives back, so the dialog replaces what it
// holds. A change of owner or of contacts names the revision the read gave; a stale one is
// refused, the latest is read again, and the dialog says so. A change of owner also moves
// the opportunity's own revision, so the opportunity is read again before the change counts
// as made: the form then saves from the new one.
import { useLingui } from '@lingui/react/macro';
import { getDealDetails, type DealDetails } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import { apiIn } from './api';

export const dealDetailsKey = (businessId: string, dealId: string): readonly string[] => [
  'b',
  businessId,
  'deal-details',
  dealId,
];

export function useDealDetails(businessId: string, dealId: string): UseQueryResult<DealDetails> {
  return useQuery({
    queryKey: dealDetailsKey(businessId, dealId),
    queryFn: () => apiIn(businessId).request(getDealDetails, { params: { id: dealId } }),
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
}

/** What the server said was wrong, in its own words when it gave any. */
export function refusalOf(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? (error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
        error.problem.detail ??
        error.message)
    : fallback;
}

/**
 * Sends one change to the details and holds the answer. A change someone else got in
 * before is refused: the latest is read again and the dialog says the change was not made.
 */
export function useDealDetailsChange(
  businessId: string,
  dealId: string,
): {
  readonly run: (change: () => Promise<DealDetails>) => void;
  readonly pending: boolean;
  readonly problem: string | undefined;
} {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const change = useMutation({
    mutationFn: (send: () => Promise<DealDetails>) => send(),
    onMutate: () => {
      setProblem(undefined);
    },
    onSuccess: async (details) => {
      cache.setQueryData(dealDetailsKey(businessId, dealId), details);
      // The cards and rows show the contact and the owner, and the timeline the change.
      void cache.invalidateQueries({ queryKey: ['deals', businessId] });
      void cache.invalidateQueries({ queryKey: ['b', businessId, 'activity', dealId] });
      await cache.invalidateQueries({ queryKey: ['deal', businessId, dealId] });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setProblem(
          t`Someone else changed this while you had it open, so your change wasn't saved. The latest is shown: make your change again.`,
        );
        await cache.invalidateQueries({ queryKey: dealDetailsKey(businessId, dealId) });
        return;
      }
      setProblem(
        refusalOf(error, t`The change wasn't saved. Check your connection and try again.`),
      );
    },
  });
  return { run: change.mutate, pending: change.isPending, problem };
}
