// Opportunities → Bulk Actions (GoHighLevel's page of the same name): the bulk actions that
// were run on opportunities, newest first, with who ran each, when, and what became of the
// opportunities named. The server runs a bulk action within its request, so each entry is
// finished when it is listed: there is no progress or status to show, and one that changed
// nothing is not listed.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  dealBulkActions,
  listDealBulkActions,
  type DealBulkAction,
  type DealBulkActionKind,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { useActorLabel } from './activity';
import { apiIn } from './api';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const EVERY_ACTION = 'all';

export function DealBulkActionsPage(): ReactElement {
  const business = useBusiness();
  return <BulkActions key={business.id} businessId={business.id} />;
}

function BulkActions({ businessId }: { readonly businessId: string }): ReactElement {
  const { t, i18n } = useLingui();
  const actorLabel = useActorLabel();
  const [action, setAction] = useState<DealBulkActionKind>();
  const history = useInfiniteQuery({
    queryKey: ['b', businessId, 'deal-bulk-actions', action ?? EVERY_ACTION],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(businessId).request(listDealBulkActions, {
        query: {
          ...(action === undefined ? {} : { action }),
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    retry: retryFaults,
  });
  const names: Readonly<Record<DealBulkActionKind, string>> = {
    assign_owner: t`Change owner`,
    move: t`Change pipeline and stage`,
    set_status: t`Change status`,
    trash: t`Delete opportunities`,
  };
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const items: DealBulkAction[] = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Page title={t`Bulk Actions`}>
      <p className="text-md text-muted-foreground">
        <Trans>Track the results of bulk actions run on opportunities.</Trans>
      </p>
      <section aria-label={t`Bulk actions`} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t`Action`}
            className="w-auto min-w-48"
            value={action ?? EVERY_ACTION}
            onValueChange={(next) => {
              setAction(dealBulkActions.find((each) => each === next));
            }}
          >
            <option value={EVERY_ACTION}>{t`All actions`}</option>
            {dealBulkActions.map((each) => (
              <option key={each} value={each}>
                {names[each]}
              </option>
            ))}
          </Select>
        </div>
        {history.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading bulk actions…</Trans>
          </p>
        ) : null}
        {history.isError ? (
          <ListProblem
            onRetry={() => {
              void history.refetch();
            }}
          >
            <Trans>We couldn't load the bulk actions.</Trans>
          </ListProblem>
        ) : null}
        {history.data !== undefined && !history.isError && items.length === 0 ? (
          <p className="py-6 text-center text-md text-muted-foreground">
            <Trans>No bulk actions found.</Trans>
          </p>
        ) : null}
        {history.isError || items.length === 0 ? null : (
          <div role="region" aria-label={t`Bulk actions table`} className={tableRegionClassName}>
            <table className={`${tableClassName} table-fixed`}>
              <caption className="sr-only">
                <Trans>Bulk actions on opportunities, newest first</Trans>
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Action</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} hidden sm:table-cell`}>
                    <Trans>User</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} hidden lg:table-cell`}>
                    <Trans>Created</Trans>
                  </th>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Completed</Trans>
                  </th>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Statistics</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => {
                  const { requested, done, unchanged, skipped } = entry;
                  return (
                    <tr key={entry.id} className="hover:bg-muted">
                      <th
                        scope="row"
                        className={`${cellClassName} text-left font-medium wrap-anywhere`}
                      >
                        {names[entry.action]}
                      </th>
                      <td className={`${cellClassName} hidden wrap-anywhere sm:table-cell`}>
                        {actorLabel(entry.actor)}
                      </td>
                      <td className={`${cellClassName} hidden lg:table-cell`}>
                        <time dateTime={entry.createdAt}>
                          {dates.format(new Date(entry.createdAt))}
                        </time>
                      </td>
                      <td className={cellClassName}>
                        <time dateTime={entry.completedAt}>
                          {dates.format(new Date(entry.completedAt))}
                        </time>
                      </td>
                      <td className={cellClassName}>
                        <Trans>
                          {requested} selected · {done} changed · {unchanged} unchanged · {skipped}{' '}
                          skipped
                        </Trans>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {history.hasNextPage ? (
          <Button
            variant="secondary"
            className="self-start"
            disabled={history.isFetchingNextPage}
            onClick={() => {
              void history.fetchNextPage();
            }}
          >
            {history.isFetchingNextPage ? t`Loading more…` : t`Load more bulk actions`}
          </Button>
        ) : null}
      </section>
    </Page>
  );
}
