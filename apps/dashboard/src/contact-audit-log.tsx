// A record's audit log: the commands that changed it, newest first, with who ran each and,
// for a do-not-contact change, the reason given. It needs the permission to read audit
// logs, which the contact's details say the reader has. Fetched when the dialog first
// opens.
import { Trans } from '@lingui/react/macro';
import { listRecordAudit } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ReactElement, RefObject } from 'react';

import { apiIn } from './api';
import { AuditEntrySummary } from './audit-entry';
import { SmallDialog } from './settings-list';
import { useBusiness } from './workspace';

export default function ContactAuditLog({
  recordId,
  returnFocus,
  onClose,
}: {
  readonly recordId: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const business = useBusiness();
  const log = useInfiniteQuery({
    queryKey: ['b', business.id, 'audit-log', recordId],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(business.id).request(listRecordAudit, {
        params: { id: recordId },
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
  const entries = log.data?.pages.flatMap((page) => page.items) ?? [];
  const forbidden = log.error instanceof ApiError && log.error.status === 403;
  return (
    <SmallDialog
      open
      onClose={onClose}
      title={<Trans>Audit logs</Trans>}
      description={<Trans>Who changed this contact, and when. Newest first.</Trans>}
      returnFocus={returnFocus}
    >
      {log.isPending ? (
        <p role="status" className="text-sm">
          <Trans>Loading the audit log…</Trans>
        </p>
      ) : null}
      {log.isError && entries.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            {forbidden ? (
              <Trans>You need permission to read audit logs.</Trans>
            ) : (
              <Trans>The audit log couldn't be loaded.</Trans>
            )}
          </p>
          {forbidden ? null : (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void log.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          )}
        </div>
      ) : null}
      {log.data !== undefined && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nothing has been recorded for this contact yet.</Trans>
        </p>
      ) : null}
      {entries.length === 0 ? null : (
        <ol className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex min-w-0 flex-col gap-1 border-t border-border py-2.5 text-sm first:border-t-0"
            >
              <AuditEntrySummary entry={entry} />
            </li>
          ))}
        </ol>
      )}
      {log.hasNextPage ? (
        <Button
          variant="secondary"
          size="small"
          className="self-start"
          disabled={log.isFetchingNextPage}
          onClick={() => {
            void log.fetchNextPage();
          }}
        >
          {log.isFetchingNextPage ? <Trans>Loading…</Trans> : <Trans>Load older entries</Trans>}
        </Button>
      ) : null}
    </SmallDialog>
  );
}
