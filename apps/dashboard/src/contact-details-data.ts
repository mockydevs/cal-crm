// A contact's details as the contact page reads them: one read, GET /contacts/{id}/details,
// whose answer every change gives back, so the page replaces what it holds. A change names
// the revision the read gave; a stale one is refused, the latest is read again, and the
// page says so. The parts of the page that show the details are in contact-details.tsx,
// fetched after the page.
import { useLingui } from '@lingui/react/macro';
import { getContactDetails, type ContactDetails } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import { apiIn } from './api';
import { contactKey } from './contacts';
import { useBusiness } from './workspace';

export const contactDetailsKey = (businessId: string, contactId: string): readonly string[] => [
  'b',
  businessId,
  'contact-details',
  contactId,
];

export function useContactDetails(contactId: string): UseQueryResult<ContactDetails> {
  const business = useBusiness();
  return useQuery({
    queryKey: contactDetailsKey(business.id, contactId),
    queryFn: () => apiIn(business.id).request(getContactDetails, { params: { id: contactId } }),
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
}

/**
 * Sends one change to the details and holds the answer. A change someone else got in
 * before is refused: the latest is read again and the page says the change was not made.
 */
export function useDetailsChange(contactId: string): {
  readonly run: (change: () => Promise<ContactDetails>) => void;
  readonly pending: boolean;
  readonly problem: string | undefined;
  readonly clear: () => void;
} {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const change = useMutation({
    mutationFn: (send: () => Promise<ContactDetails>) => send(),
    onMutate: () => {
      setProblem(undefined);
    },
    onSuccess: async (details) => {
      cache.setQueryData(contactDetailsKey(business.id, contactId), details);
      // The contact answers its addresses and do not contact too, and the timeline the change.
      await Promise.all([
        cache.invalidateQueries({ queryKey: contactKey(business.id, contactId) }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', contactId] }),
      ]);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setProblem(
          t`Someone else changed this while you had it open, so your change wasn't saved. The latest is shown: make your change again.`,
        );
        await cache.invalidateQueries({ queryKey: contactDetailsKey(business.id, contactId) });
        return;
      }
      setProblem(
        error instanceof ApiError
          ? (error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
              error.problem.detail ??
              error.message)
          : t`The change wasn't saved. Check your connection and try again.`,
      );
    },
  });
  return {
    run: change.mutate,
    pending: change.isPending,
    problem,
    clear: () => {
      setProblem(undefined);
    },
  };
}
