// "Add to Workflow" on the contacts selected in the list (GoHighLevel's bulk action of that
// name): choose one published workflow, searched on the
// server, and each contact is enrolled by the rules a trigger keeps. A contact already in
// the workflow, or one it takes only once, is skipped and the action says why (Bulk
// Actions). Fetched when the button is first pressed.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  bulkUpdateContacts,
  listAutomations,
  type ContactBulkAction,
  type ContactBulkSelection,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type RefObject } from 'react';

import { apiIn } from './api';
import { SearchPicker } from './search-picker';
import { SmallDialog } from './settings-list';

export default function AddToWorkflowDialog({
  businessId,
  selection,
  count,
  returnFocus,
  onClose,
  onDone,
}: {
  readonly businessId: string;
  /** The contacts selected: the ones ticked, or every one the list holds. */
  readonly selection: ContactBulkSelection;
  /** How many contacts the selection holds, as the list counted them. */
  readonly count: number;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onDone: (action: ContactBulkAction) => void;
}): ReactElement {
  const { t } = useLingui();
  const api = apiIn(businessId);
  const pickerId = useId();
  const [typed, setTyped] = useState('');
  const [workflowId, setWorkflowId] = useState<string>();
  const [problem, setProblem] = useState<string>();
  // One request, however often it is sent: a retry answers the action the first one began.
  const [requestId] = useState(() => crypto.randomUUID());
  // Only a published workflow that is not paused can take contacts.
  const workflows = useQuery({
    queryKey: ['b', businessId, 'automations', 'active', typed],
    queryFn: () =>
      api.request(listAutomations, {
        query: { status: 'active', ...(typed === '' ? {} : { q: typed }) },
      }),
    placeholderData: keepPreviousData,
  });
  const items = (workflows.data?.items ?? []).map((each) => ({ id: each.id, name: each.name }));
  const chosenName = items.find((each) => each.id === workflowId)?.name;
  const run = useMutation({
    mutationFn: (id: string) =>
      api.request(bulkUpdateContacts, {
        body: { action: 'add_to_workflow', workflowId: id, selection, requestId },
      }),
    onSuccess: onDone,
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.status === 403
          ? t`You don't have permission to add contacts to workflows.`
          : error instanceof ApiError && error.status === 422
            ? (error.problem.errors?.[0]?.message ?? t`Choose a published workflow.`)
            : t`The contacts weren't added. Check your connection and try again.`,
      );
    },
  });
  const selectedText = plural(count, {
    one: '# contact is selected.',
    other: '# contacts are selected.',
  });
  return (
    <SmallDialog
      open
      onClose={() => {
        if (!run.isPending) onClose();
      }}
      title={<Trans>Add to Workflow</Trans>}
      description={t`${selectedText} Each is added to the workflow. A contact already in it, or one it takes only once, is skipped.`}
      returnFocus={returnFocus}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={pickerId} className="text-sm font-medium">
          <Trans>Select Workflow</Trans>
        </label>
        <SearchPicker
          id={pickerId}
          control
          label={t`Workflow`}
          placeholder={t`Select a workflow`}
          searchLabel={t`Search workflows`}
          items={items}
          selected={workflowId === undefined ? [] : [workflowId]}
          unlisted={() => chosenName ?? t`Chosen workflow`}
          loading={workflows.isPending}
          onRetry={
            workflows.isError
              ? () => {
                  void workflows.refetch();
                }
              : undefined
          }
          onSearch={setTyped}
          empty={t`No published workflows match.`}
          none={t`There are no published workflows yet. Publish one in Automation → Workflows.`}
          disabled={run.isPending}
          onChange={([next]) => {
            setProblem(undefined);
            setWorkflowId(next);
          }}
        />
      </div>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={run.isPending} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          disabled={workflowId === undefined || run.isPending}
          onClick={() => {
            if (workflowId !== undefined) run.mutate(workflowId);
          }}
        >
          {run.isPending ? <Trans>Working…</Trans> : <Trans>Add to Workflow</Trans>}
        </Button>
      </div>
    </SmallDialog>
  );
}
