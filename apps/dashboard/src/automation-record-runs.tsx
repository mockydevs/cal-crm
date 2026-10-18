// A record's run history: every automation the
// record has been through, newest first, each leading to the run itself with the steps it
// took. On the record's own page, so it is small: the run is opened in the automation's
// builder, which has the rest.
import { Trans, useLingui } from '@lingui/react/macro';
import { listRecordAutomationRuns } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { momentWords, runOutcomeWords, runStatusWords } from './automation-run-words';
import { ContactPanel } from './contact-panels';
import { useBusiness } from './workspace';

// Asked for by few, so fetched when it is: the page keeps to its own size.
const Explanation = lazy(() => import('./automation-record-explain'));

export function RecordAutomationRuns({ recordId }: { readonly recordId: string }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [asking, setAsking] = useState(false);
  const runs = useInfiniteQuery({
    queryKey: ['b', business.id, 'record-automation-runs', recordId],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiIn(business.id).request(listRecordAutomationRuns, {
        params: { id: recordId },
        query: pageParam === '' ? {} : { after: pageParam },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <ContactPanel title={t`Workflows`}>
      {runs.isPending ? (
        <p aria-live="polite">
          <Trans>Loading automations…</Trans>
        </p>
      ) : null}
      {runs.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            <Trans>The automations couldn't be loaded.</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void runs.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {runs.isSuccess && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No automation has run for this contact.</Trans>
        </p>
      ) : null}
      {items.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col divide-y divide-border">
          {items.map((run) => {
            const started = momentWords(run.startedAt) ?? run.startedAt;
            const name = run.automationName;
            return (
              <li key={run.id} className="flex min-w-0 flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Link
                    to="/b/$slug/automations"
                    params={{ slug: business.slug }}
                    search={{ automation: run.automationId, view: 'runs', run: run.id }}
                    className="min-w-0 font-medium text-link underline-offset-2 hover:underline wrap-anywhere"
                    aria-label={t`${name}: open the run started ${started}`}
                  >
                    {name}
                  </Link>
                  <Badge variant={run.status === 'failed' ? 'attention' : 'neutral'}>
                    {runStatusWords(run.status)}
                  </Badge>
                </span>
                <span className="text-sm text-muted-foreground wrap-anywhere">
                  {runOutcomeWords(run, () => undefined)}{' '}
                  <Trans>
                    Started <time dateTime={run.startedAt}>{started}</time>.
                  </Trans>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {runs.hasNextPage ? (
        <Button
          variant="secondary"
          size="small"
          className="self-start"
          disabled={runs.isFetchingNextPage}
          onClick={() => {
            void runs.fetchNextPage();
          }}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
      <Button
        variant="quiet"
        size="small"
        className="self-start text-link hover:text-link"
        aria-expanded={asking}
        onClick={() => {
          setAsking(!asking);
        }}
      >
        <Trans>Why didn't a workflow run?</Trans>
      </Button>
      {asking ? (
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading…</Trans>
            </p>
          }
        >
          <Explanation recordId={recordId} />
        </Suspense>
      ) : null}
    </ContactPanel>
  );
}
