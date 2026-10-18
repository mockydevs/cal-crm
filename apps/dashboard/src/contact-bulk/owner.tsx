// Contacts → Change owner on the contacts selected: a member of the team, or no owner, as a
// change on the contact page makes it.
import { Trans, useLingui } from '@lingui/react/macro';
import { listTaskAssignees } from '@repo/contracts';
import { Select } from '@repo/ui/components/select';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { apiIn } from '../api';
import { BulkDialogShell, labelClassName, type BulkDialogProps } from './parts';

const NO_OWNER = 'none';

export default function OwnerDialog(props: BulkDialogProps): ReactElement {
  const { t } = useLingui();
  const api = apiIn(props.businessId);
  const [owner, setOwner] = useState(NO_OWNER);
  const people = useInfiniteQuery({
    queryKey: ['b', props.businessId, 'task-assignees'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      api.request(listTaskAssignees, {
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 60_000,
  });
  const team = people.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <BulkDialogShell
      {...props}
      title={t`Change owner`}
      description={t`Each gets the owner chosen, as a change on the contact page does.`}
      timing={false}
      missing={undefined}
      confirm="apply"
      bodyOf={({ delivery: _now, ...common }) => ({
        action: 'assign_owner',
        owner: owner === NO_OWNER ? null : owner,
        ...common,
      })}
    >
      {(pending) => (
        <label className={labelClassName}>
          <Trans>New owner</Trans>
          <Select
            aria-label={t`New owner`}
            value={owner}
            disabled={pending}
            onValueChange={setOwner}
          >
            <option value={NO_OWNER}>{t`No owner`}</option>
            {team.map((person) => (
              <option key={person.id} value={person.id}>
                {person.you ? t`You` : (person.name ?? t`Team member`)}
              </option>
            ))}
          </Select>
          {people.isError ? (
            <span role="alert" className="font-normal">
              <Trans>People couldn't be loaded.</Trans>
            </span>
          ) : null}
        </label>
      )}
    </BulkDialogShell>
  );
}
