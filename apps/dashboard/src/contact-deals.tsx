// A contact's opportunities on the contact page: the deals the contact is with, newest
// first, each with its pipeline and stage, its status and value, and whether the contact is
// its primary contact. The server answers at most fifty and says when there are more. An
// opportunity opens in its dialog on the Opportunities page. Someone who may add
// opportunities has "Add opportunity", which opens that dialog here with the contact as the
// new opportunity's primary contact (contact-deal-add.tsx, fetched then).
import { Trans, useLingui } from '@lingui/react/macro';
import { listContactDeals } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from 'react';

import { apiIn } from './api';
import { amountOf } from './deal-presentation';
import { DealStatus } from './deal-status';
import { useBusiness } from './workspace';

const AddDeal = lazy(() => import('./contact-deal-add'));

export function ContactDeals({
  contactId,
  contactName,
}: {
  readonly contactId: string;
  /**
   * What the contact is called, for an opportunity added from it. Left out, as in the
   * Conversations pane, the opportunities are listed and none is added here.
   */
  readonly contactName?: string | undefined;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const queryKey = ['b', business.id, 'contact-deals', contactId];
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');
  const addRef = useRef<HTMLButtonElement>(null);
  // The dialog is taken away when it closes, so the keyboard is put back on its button here.
  const wasAddingRef = useRef(false);
  useEffect(() => {
    if (wasAddingRef.current && !adding) addRef.current?.focus();
    wasAddingRef.current = adding;
  }, [adding]);
  const deals = useQuery({
    queryKey,
    queryFn: () =>
      apiIn(business.id).request(listContactDeals, { params: { id: contactId }, query: {} }),
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
  if (deals.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading opportunities…</Trans>
      </p>
    );
  if (deals.isError)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>
          <Trans>The opportunities couldn't be loaded.</Trans>
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            void deals.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  const { items, more, canManage } = deals.data;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>This contact is with no opportunity yet.</Trans>
        </p>
      ) : null}
      <ul
        aria-label={t`Opportunities of this contact`}
        className="flex min-w-0 flex-col gap-2"
        hidden={items.length === 0}
      >
        {items.map(({ deal, primary }) => {
          const pipelineName = deal.pipelineName;
          const stageName = deal.stageName;
          return (
            <li
              key={deal.id}
              className="flex min-w-0 flex-col gap-1 rounded-control border border-border p-2.5 text-sm"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Link
                  to="/b/$slug/deals"
                  params={{ slug: business.slug }}
                  search={{ deal: deal.id, pipelineId: deal.pipelineId, status: 'all' }}
                  className="min-w-0 font-medium wrap-anywhere text-link underline-offset-2 hover:underline"
                >
                  {deal.name}
                </Link>
                <DealStatus status={deal.status} />
                {primary ? (
                  <Badge variant="neutral" className="px-2 py-0.5 text-xs">
                    <Trans>Primary contact</Trans>
                  </Badge>
                ) : null}
              </span>
              <span className="wrap-anywhere text-body">
                <Trans>
                  {pipelineName}: {stageName}
                </Trans>
              </span>
              {deal.amount === null ? null : (
                <span className="font-medium text-foreground">{amountOf(deal)}</span>
              )}
            </li>
          );
        })}
      </ul>
      {more ? (
        <p className="text-sm text-muted-foreground">
          <Trans>This contact has more opportunities than are listed here.</Trans>
        </p>
      ) : null}
      {canManage && contactName !== undefined ? (
        <Button
          ref={addRef}
          variant="secondary"
          className="self-start"
          onClick={() => {
            setNotice('');
            setAdding(true);
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          <Trans>Add opportunity</Trans>
        </Button>
      ) : null}
      <p role="status" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {adding && contactName !== undefined ? (
        <Suspense fallback={null}>
          <AddDeal
            businessId={business.id}
            contact={{ id: contactId, name: contactName }}
            returnFocus={addRef}
            onClose={() => {
              setAdding(false);
            }}
            onSaved={(saved) => {
              const { name } = saved;
              setAdding(false);
              setNotice(t`${name} saved.`);
              void cache.invalidateQueries({ queryKey });
              void cache.invalidateQueries({ queryKey: ['deals', business.id] });
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
