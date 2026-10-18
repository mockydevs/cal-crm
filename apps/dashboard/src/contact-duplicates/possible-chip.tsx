// "Possible duplicates (n)" on a contact's page: the contacts that may be the same person,
// found by the same signs as Manage Duplicates. Pressing it opens the same review. Nothing
// shows while there are none. Reject is there for whoever may manage duplicates.
import { Trans } from '@lingui/react/macro';
import { getMyPermissions, listPossibleDuplicates } from '@repo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';

import { apiIn } from '../api';
import { useBusiness } from '../workspace';
import { duplicatesKey } from './keys';
import { ReviewPanel } from './review-panel';

export default function PossibleDuplicates({
  contactId,
}: {
  readonly contactId: string;
}): ReactElement | null {
  const business = useBusiness();
  const queryClient = useQueryClient();
  const openerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const found = useQuery({
    queryKey: [...duplicatesKey(business.id), 'contact', contactId],
    queryFn: () =>
      apiIn(business.id).request(listPossibleDuplicates, { params: { id: contactId } }),
  });
  const grants = useQuery({
    queryKey: ['b', business.id, 'my-permissions'],
    queryFn: () => apiIn(business.id).request(getMyPermissions, {}),
    staleTime: 60_000,
  });
  const count = found.data?.count ?? 0;
  const mayManage = grants.data?.permissions.includes('contacts.merge') === true;
  // While the review is open it stays, even once its last group is rejected.
  if (found.data === undefined || (count === 0 && !open)) return null;
  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-haspopup="dialog"
        className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full bg-attention px-3 text-sm font-medium text-attention-foreground hover:opacity-90 lg:min-h-8"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Users aria-hidden className="size-4" strokeWidth={1.8} />
        <Trans>Possible duplicates ({count})</Trans>
      </button>
      <ReviewPanel
        open={open}
        groups={found.data.groups}
        canReject={mayManage}
        canMerge={mayManage}
        returnFocus={openerRef}
        onClose={() => {
          setOpen(false);
        }}
        onRejected={() => {
          void queryClient.invalidateQueries({ queryKey: duplicatesKey(business.id) });
        }}
      />
    </>
  );
}
