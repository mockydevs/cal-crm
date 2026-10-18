// The Overview tab of Automation: the business's workflows in four numbers. Each is counted
// from the list of workflows, read to its end, because that is what the server has;
// enrollments over time and trigger analysis have no source yet and so are not drawn.
import { Trans, useLingui } from '@lingui/react/macro';
import { listAutomations } from '@repo/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import { apiIn } from './api';
import { automationListKey } from './automation-list';
import { overviewOf } from './automation-list-rules';
import { ListProblem } from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

export function AutomationOverview(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const automations = useInfiniteQuery({
    queryKey: [...automationListKey(business.id), 'overview'],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiIn(business.id).request(listAutomations, {
        query: pageParam === '' ? {} : { after: pageParam },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  // The numbers are of every workflow, so every page is read before any is shown.
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = automations;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const complete = automations.data !== undefined && !hasNextPage;
  const totals = overviewOf(automations.data?.pages.flatMap((page) => page.items) ?? []);
  const number = new Intl.NumberFormat(i18n.locale);
  const cards: readonly (readonly [string, number, string])[] = [
    [t`Total workflows`, totals.workflows, t`Every workflow that is not deleted.`],
    [t`Published workflows`, totals.published, t`Workflows that start for new contacts now.`],
    [t`Total enrollments`, totals.enrolled, t`Every time a workflow has started for a record.`],
    [t`Active enrollments`, totals.active, t`Runs that are going or waiting right now.`],
  ];
  return (
    <Page title={t`Overview`}>
      {isError ? (
        <ListProblem
          onRetry={() => {
            void automations.refetch();
          }}
        >
          <Trans>We couldn't load the workflows.</Trans>
        </ListProblem>
      ) : complete ? (
        <dl className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map(([name, value, meaning]) => (
            <div
              key={name}
              className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-card p-5"
            >
              <dt className="text-sm font-medium text-body">{name}</dt>
              <dd className="text-[30px] leading-9 font-medium text-foreground tabular-nums">
                {number.format(value)}
              </dd>
              <dd className="text-sm text-muted-foreground">{meaning}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the numbers…</Trans>
        </p>
      )}
    </Page>
  );
}
