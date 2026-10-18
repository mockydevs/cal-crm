// "Why didn't this run?": what one workflow did for one contact, or why it did not start
// (docs/AUTOMATIONS.md, "Why an automation did not start"). The server answers from what is
// on record and never guesses; this shows its sentence first, then the run, or the latest
// times an event came and the workflow did not start, each with the server's own
// explanation. Its own chunk: the pages that offer it fetch it when someone asks.
import { Trans, useLingui } from '@lingui/react/macro';
import { explainAutomationContact } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { useId, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import { comparedOf, reasonHeading, stateHeading } from './automation-explain-words';
import { momentWords, runStatusWords } from './automation-run-words';
import { stepLabel } from './automation-summary';
import { useBusiness } from './workspace';

export interface AutomationExplanationProps {
  readonly automationId: string;
  readonly contactId: string;
  /** A link to one run of the workflow, as the page that shows this makes its links. */
  readonly runLink: (runId: string, children: ReactNode) => ReactElement;
}

export default function AutomationExplanation({
  automationId,
  contactId,
  runLink,
}: AutomationExplanationProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const answer = useQuery({
    queryKey: ['b', business.id, 'automation-explain', automationId, contactId],
    queryFn: () =>
      apiIn(business.id).request(explainAutomationContact, {
        params: { id: automationId },
        query: { contactId },
      }),
    // What the server answered is its answer; only a request that never arrived is tried again.
    retry: (failures, error) => !(error instanceof ApiError) && failures < 2,
  });
  if (answer.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Looking at what is on record…</Trans>
      </p>
    );
  if (answer.isError)
    return (
      <div role="alert" className="flex min-w-0 flex-col items-start gap-2 text-sm">
        <p>
          {answer.error instanceof ApiError && answer.error.status === 403 ? (
            <Trans>You don't have permission to read this workflow's runs.</Trans>
          ) : (
            <Trans>We couldn't read what is on record for this contact.</Trans>
          )}
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            void answer.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  const { data } = answer;
  const { run } = data;
  const at = run?.currentAction ?? undefined;
  const where =
    at === undefined
      ? undefined
      : (at.label ?? (at.type === null ? undefined : stepLabel(at.type)) ?? at.step);
  const days = data.evaluationsKeptDays;
  const started = run === null ? undefined : (momentWords(run.startedAt) ?? run.startedAt);
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5 text-sm"
    >
      <p
        id={headingId}
        className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
      >
        {stateHeading(data.state)}
      </p>
      <p className="text-md font-medium text-foreground wrap-anywhere">{data.summary}</p>
      {run === null ? null : (
        <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-[minmax(6rem,auto)_minmax(0,1fr)]">
          <dt className="text-xs font-medium text-muted-foreground">
            <Trans>Status</Trans>
          </dt>
          <dd className="min-w-0">
            <Badge variant={run.status === 'failed' ? 'attention' : 'neutral'}>
              {runStatusWords(run.status)}
            </Badge>
          </dd>
          {where === undefined ? null : (
            <>
              <dt className="text-xs font-medium text-muted-foreground">
                <Trans>Where it is</Trans>
              </dt>
              <dd className="min-w-0 wrap-anywhere">{where}</dd>
            </>
          )}
          {data.ended === null ? null : (
            <>
              <dt className="text-xs font-medium text-muted-foreground">
                <Trans>How it ended</Trans>
              </dt>
              <dd className="min-w-0 wrap-anywhere">{data.ended}</dd>
            </>
          )}
          <dt className="text-xs font-medium text-muted-foreground">
            <Trans>The run</Trans>
          </dt>
          <dd className="min-w-0 wrap-anywhere">
            {runLink(run.id, <Trans>Open the run started {started}</Trans>)}
          </dd>
        </dl>
      )}
      {run !== null || data.evaluations.length === 0 ? null : (
        <ol
          aria-label={t`The latest times it did not start`}
          className="flex min-w-0 list-none flex-col divide-y divide-border"
        >
          {data.evaluations.map((evaluation) => {
            const when = momentWords(evaluation.evaluatedAt) ?? evaluation.evaluatedAt;
            const compared = comparedOf(evaluation.detail);
            return (
              <li
                key={evaluation.id}
                className="flex min-w-0 flex-col gap-1 py-2.5 first:pt-0 last:pb-0"
              >
                <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium text-foreground">
                    {reasonHeading(evaluation.reason)}
                  </span>
                  <time dateTime={evaluation.evaluatedAt} className="text-xs text-muted-foreground">
                    {when}
                  </time>
                </span>
                <span className="wrap-anywhere text-body">{evaluation.explanation}</span>
                {compared.length === 0 ? null : (
                  <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                    {compared.map((each) => (
                      <div key={each.label} className="contents">
                        <dt className="font-medium text-muted-foreground">{each.label}</dt>
                        <dd className="min-w-0 wrap-anywhere text-body">{each.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {run === null ? (
        <p className="text-xs text-muted-foreground">
          {data.evaluations.length === 0 ? (
            <Trans>
              No event this workflow listens for is on record for this contact. Each time a workflow
              does not start is kept for {days} days.
            </Trans>
          ) : (
            <Trans>Each time a workflow does not start is kept for {days} days.</Trans>
          )}
        </p>
      ) : null}
    </section>
  );
}
