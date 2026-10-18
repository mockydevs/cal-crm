// Under "Sync edits to template", while it is on: the other workflow actions that use the
// template, since an edit made here reaches each one that syncs with it. Fetched when an
// email that syncs is opened, with the inventory's own contract.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { listTemplateWorkflowActions } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { apiIn } from '../api';
import { useBusiness } from '../workspace';
import { modeWords, otherUses } from './rules';

const hintClassName = 'text-sm text-muted-foreground';

export default function OtherUses({
  templateId,
  automationId,
  step,
}: {
  readonly templateId: string;
  /** The workflow and the action this panel is of, which are not "other". */
  readonly automationId: string | undefined;
  readonly step: string | undefined;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const uses = useQuery({
    queryKey: ['b', business.id, 'template-workflow-actions', templateId],
    queryFn: () =>
      apiIn(business.id).request(listTemplateWorkflowActions, {
        params: { id: templateId },
        query: { limit: 100 },
      }),
    staleTime: 30_000,
  });
  const others = otherUses(uses.data?.items ?? [], { automation: automationId, step });
  if (uses.isPending)
    return (
      <p role="status" className={hintClassName}>
        <Trans>Looking for other workflows that use this template…</Trans>
      </p>
    );
  if (uses.isError)
    return (
      <p className={hintClassName}>
        <Trans>The other workflows that use this template couldn't be listed.</Trans>
      </p>
    );
  if (others.length === 0)
    return (
      <p className={hintClassName}>
        <Trans>No other workflow action uses this template.</Trans>
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        <Trans>Other workflow actions that use this template</Trans>
      </span>
      <ul
        aria-label={t`Other workflow actions that use this template`}
        className="flex min-w-0 list-disc flex-col gap-0.5 pl-5 text-md"
      >
        {others.map((use) => (
          <li key={use.key} className="wrap-anywhere">
            {use.name} <span className="text-muted-foreground">({modeWords(use.mode)})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
