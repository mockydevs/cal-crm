// "Why didn't a workflow run?" on a contact's page: choose one of the business's workflows,
// and read what it did for this contact or why it did not start (automation-explain.tsx).
// Its own chunk, fetched when the question is first asked, so the contact's page carries
// none of it.
import { Trans, useLingui } from '@lingui/react/macro';
import { listAutomations } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import AutomationExplanation from './automation-explain';
import { useBusiness } from './workspace';

export default function RecordExplanation({
  recordId,
}: {
  readonly recordId: string;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const chooseId = useId();
  const [automationId, setAutomationId] = useState('');
  const workflows = useQuery({
    // Under the list's own key, so publishing or renaming elsewhere reads them again.
    queryKey: ['b', business.id, 'automations', 'explain-choices'],
    queryFn: () => apiIn(business.id).request(listAutomations, { query: {} }),
    staleTime: 30_000,
  });
  if (workflows.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading the workflows…</Trans>
      </p>
    );
  if (workflows.isError)
    return (
      <div role="alert" className="flex min-w-0 flex-col items-start gap-2 text-sm">
        <p>
          <Trans>The workflows couldn't be loaded.</Trans>
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            void workflows.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  const { items } = workflows.data;
  if (items.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>This business has no workflows yet.</Trans>
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <label htmlFor={chooseId} className="text-xs font-medium text-muted-foreground">
        <Trans>Workflow</Trans>
      </label>
      <select
        id={chooseId}
        className="min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-2.5 text-md text-foreground lg:min-h-9"
        value={automationId}
        onChange={(event) => {
          setAutomationId(event.target.value);
        }}
      >
        <option value="">{t`Choose a workflow`}</option>
        {items.map((each) => (
          <option key={each.id} value={each.id}>
            {each.name}
          </option>
        ))}
      </select>
      {automationId === '' ? null : (
        <AutomationExplanation
          key={automationId}
          automationId={automationId}
          contactId={recordId}
          runLink={(runId, children) => (
            <Link
              to="/b/$slug/automations"
              params={{ slug: business.slug }}
              search={{ automation: automationId, view: 'runs', run: runId }}
              className="font-medium text-link underline-offset-2 hover:underline"
            >
              {children}
            </Link>
          )}
        />
      )}
    </div>
  );
}
