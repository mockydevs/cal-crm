// The trash: contacts, companies and deals moved there, most recently first, until they're
// restored or purged after the business's retention days. Purging can't be undone, so it
// asks first, in the row.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  listTrash,
  purgeRecord,
  restoreCompany,
  restoreContact,
  restoreDeal,
  type RecordKind,
  type TrashedRecord,
  type TrashList,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { EmptyState } from '@repo/ui/components/empty-state';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Select } from '@repo/ui/components/select';
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useCallback, useState, type ReactElement } from 'react';

import { apiIn } from './api';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const trashKey = (businessId: string) => ['b', businessId, 'trash'];

function useTrash(
  businessId: string,
  kind: RecordKind | undefined,
): UseInfiniteQueryResult<InfiniteData<TrashList>> {
  return useInfiniteQuery({
    queryKey: [...trashKey(businessId), kind ?? 'all'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(businessId).request(listTrash, {
        query: {
          ...(kind === undefined ? {} : { kind }),
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  });
}

export function TrashPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [kind, setKind] = useState<RecordKind>();
  const [confirming, setConfirming] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const pages = useTrash(business.id, kind);
  // Stable, so it focuses once, as the confirmation appears, not on every render.
  const focusOnMount = useCallback((element: HTMLButtonElement | null) => {
    element?.focus();
  }, []);
  const first = pages.data?.pages[0];
  const retentionDays = first?.retentionDays;
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  const date = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const kindName = (item: TrashedRecord) =>
    item.kind === 'contact' ? t`Contact` : item.kind === 'company' ? t`Company` : t`Deal`;
  const nameOf = (item: TrashedRecord) => item.name ?? t`Unnamed contact`;

  const act = async (item: TrashedRecord, action: 'restore' | 'purge') => {
    const client = apiIn(business.id);
    const params = { params: { id: item.id } };
    setBusy(item.id);
    setNotice(undefined);
    setProblem(undefined);
    try {
      if (action === 'purge') await client.request(purgeRecord, params);
      else if (item.kind === 'contact') await client.request(restoreContact, params);
      else if (item.kind === 'company') await client.request(restoreCompany, params);
      else await client.request(restoreDeal, params);
      const name = nameOf(item);
      setNotice(action === 'purge' ? t`${name} deleted forever.` : t`${name} restored.`);
      setConfirming(undefined);
      await cache.invalidateQueries({ queryKey: trashKey(business.id) });
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : t`That didn't work. Check your connection and try again.`,
      );
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Page title={t`Trash`}>
      {retentionDays === undefined ? null : (
        <p className="max-w-[760px] text-md text-muted-foreground">
          <Trans>
            Contacts, companies and deals moved to the trash stay here for {retentionDays} days with
            everything attached to them, then they're deleted for good.
          </Trans>
        </p>
      )}
      <Field className="w-full sm:w-52">
        <FieldLabel>
          <Trans>Show</Trans>
        </FieldLabel>
        <Select
          value={kind ?? 'all'}
          onValueChange={(value) => {
            setKind(
              value === 'contact' || value === 'company' || value === 'deal' ? value : undefined,
            );
          }}
        >
          <option value="all">{t`Everything`}</option>
          <option value="contact">{t`Contacts`}</option>
          <option value="company">{t`Companies`}</option>
          <option value="deal">{t`Deals`}</option>
        </Select>
      </Field>
      {pages.isPending ? (
        <p role="status">
          <Trans>Loading the trash…</Trans>
        </p>
      ) : pages.isError ? (
        <p role="alert">
          <Trans>We couldn't load the trash.</Trans>{' '}
          <Button
            variant="quiet"
            onClick={() => {
              void pages.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Trash2 strokeWidth={1.8} />}
          title={<Trans>The trash is empty</Trans>}
          description={<Trans>What you move to the trash waits here before it's deleted.</Trans>}
        />
      ) : (
        <ul aria-label={t`In the trash`} className="flex flex-col gap-3">
          {items.map((item) => {
            const name = nameOf(item);
            const trashedOn = date.format(new Date(item.trashedAt));
            const purgedOn = date.format(new Date(item.purgeAt));
            return (
              <li
                key={item.id}
                className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-[18px] sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{name}</p>
                  <p className="text-sm text-muted-foreground">
                    {kindName(item)} · <Trans>Trashed {trashedOn}</Trans> ·{' '}
                    <Trans>Deleted for good on {purgedOn}</Trans>
                  </p>
                  {/* A merge can't be undone, so a merged contact is never restored. */}
                  {item.mergedInto === null ? null : (
                    <p className="text-sm">
                      <Trans>
                        Merged into{' '}
                        <Link
                          to="/b/$slug/contacts/$contactId"
                          params={{ slug: business.slug, contactId: item.mergedInto }}
                          className="text-link underline"
                        >
                          the contact kept
                        </Link>
                      </Trans>
                    </p>
                  )}
                </div>
                {confirming === item.id ? (
                  <div
                    role="group"
                    aria-label={t`Delete ${name} forever?`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="text-sm">
                      <Trans>Delete {name} forever? This can't be undone.</Trans>
                    </span>
                    <Button
                      size="small"
                      disabled={busy === item.id}
                      onClick={() => {
                        void act(item, 'purge');
                      }}
                    >
                      <Trans>Delete forever</Trans>
                    </Button>
                    <Button
                      // The button that asked is gone: the keyboard lands on the safe choice.
                      ref={focusOnMount}
                      variant="quiet"
                      size="small"
                      onClick={() => {
                        setConfirming(undefined);
                      }}
                    >
                      <Trans>Keep</Trans>
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {item.mergedInto === null ? (
                      <Button
                        variant="secondary"
                        size="small"
                        aria-label={t`Restore ${name}`}
                        disabled={busy === item.id}
                        onClick={() => {
                          void act(item, 'restore');
                        }}
                      >
                        <Trans>Restore</Trans>
                      </Button>
                    ) : null}
                    {first?.canPurge === true ? (
                      <Button
                        variant="quiet"
                        size="small"
                        aria-label={t`Delete ${name} forever`}
                        disabled={busy === item.id}
                        onClick={() => {
                          setConfirming(item.id);
                        }}
                      >
                        <Trans>Delete forever</Trans>
                      </Button>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pages.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={pages.isFetchingNextPage}
          onClick={() => {
            void pages.fetchNextPage();
          }}
        >
          {pages.isFetchingNextPage ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
        </Button>
      ) : null}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <p role="status" className="text-sm empty:sr-only">
        {notice}
      </p>
    </Page>
  );
}
