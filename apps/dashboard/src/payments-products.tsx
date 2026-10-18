// Payments → Products: the products and services the business sells, each with its rate, a
// page at a time as the server pages them. One is added or changed in a panel at the right;
// one that a quote or an invoice names is archived, never deleted. Anyone in the business
// reads the catalogue; changing it needs the permission the server reports with canManage.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  archiveProduct,
  deleteProduct,
  listProducts,
  restoreProduct,
  type Product,
  type ProductKind,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { Switch } from './automation-switch';
import { RightPanel } from './conversation-extras-panel';
import { ListSearch } from './list-toolbar';
import {
  Chip,
  FilterChips,
  PageIntro,
  Pager,
  ReadOnlyNote,
  Refused,
  useFormats,
  useProfile,
} from './payments-parts';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  iconButtonClassName,
  isStale,
  listCardClassName,
  ListProblem,
  retryFaults,
  savingProblem,
  tableClassName,
  tableRegionClassName,
  useSettled,
} from './settings-list';
import { emptyTrail, trailBack, trailCursor, trailForward } from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const ProductPanel = lazy(() => import('./payments-product-panel'));

const PAGE_SIZE = 50;
type KindFilter = 'all' | ProductKind;

type Opened =
  | { readonly at: 'panel'; readonly product: Product | undefined }
  | { readonly at: 'delete'; readonly product: Product };

export default function ProductsPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const formats = useFormats();
  const profile = useProfile();
  const [text, setText] = useState('');
  const settled = useSettled(text);
  const [kind, setKind] = useState<KindFilter>('all');
  const [archived, setArchived] = useState(false);
  const [trail, setTrail] = useState(emptyTrail);
  const [opened, setOpened] = useState<Opened>();
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const archivedId = useId();

  // Another list starts at its first page.
  const asked = `${settled.trim()}:${kind}:${String(archived)}`;
  const [shown, setShown] = useState(asked);
  if (shown !== asked) {
    setShown(asked);
    setTrail(emptyTrail);
  }

  const q = settled.trim();
  const after = trailCursor(trail);
  const query = {
    ...(q === '' ? {} : { q }),
    ...(kind === 'all' ? {} : { kind }),
    archived: archived ? ('true' as const) : ('false' as const),
    ...(after === undefined ? {} : { after }),
    limit: PAGE_SIZE,
  };
  const listKey = ['b', business.id, 'payments', 'products'] as const;
  const products = useQuery({
    queryKey: [...listKey, query] as const,
    queryFn: () => api.request(listProducts, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const refresh = (): Promise<void> => cache.invalidateQueries({ queryKey: listKey });

  const open = (next: Opened, trigger: HTMLElement | null): void => {
    returnFocusRef.current = trigger;
    setOpened(next);
    setNotice('');
    setProblem(undefined);
  };
  const close = (message = ''): void => {
    setOpened(undefined);
    setNotice(message);
    setProblem(undefined);
  };

  const words = {
    archived: (name: string) => t`${name} was archived.`,
    restored: (name: string) => t`${name} is in use again.`,
    deleted: (name: string) => t`${name} was deleted.`,
    edit: (name: string) => t`Edit ${name}`,
    archive: (name: string) => t`Archive ${name}`,
    restore: (name: string) => t`Restore ${name}`,
    remove: (name: string) => t`Delete ${name}`,
  };
  const shelve = useMutation({
    mutationFn: (product: Product) =>
      api.request(product.archived ? restoreProduct : archiveProduct, {
        params: { id: product.id },
        body: { revision: product.revision },
      }),
    onSuccess: async (saved) => {
      await refresh();
      setNotice(saved.archived ? words.archived(saved.name) : words.restored(saved.name));
    },
    onError: (error) => {
      void refresh();
      setNotice(
        isStale(error)
          ? t`Someone changed it since this list was read. The list is up to date now; try again.`
          : (savingProblem(error, t`It wasn't changed. Check your connection and try again.`)
              .form ?? ''),
      );
    },
  });
  const remove = useMutation({
    mutationFn: (product: Product) => api.request(deleteProduct, { params: { id: product.id } }),
    onSuccess: async (_, product) => {
      await refresh();
      close(words.deleted(product.name));
    },
    onError: (error) => {
      const fallback = t`It wasn't deleted. Check your connection and try again.`;
      setProblem(savingProblem(error, fallback).form ?? fallback);
    },
  });

  const listed = products.data;
  const items = listed?.items ?? [];
  const canManage = listed?.canManage === true;
  const refused = products.error instanceof ApiError && products.error.status === 403;
  const turning = products.isFetching && products.isPlaceholderData;
  const kindNames: Readonly<Record<ProductKind, string>> = {
    product: t`Product`,
    service: t`Service`,
  };
  const addButton = (
    <Button
      onClick={(event) => {
        open({ at: 'panel', product: undefined }, event.currentTarget);
      }}
    >
      <Plus aria-hidden className="size-4" strokeWidth={2} />
      <Trans>Add product</Trans>
    </Button>
  );
  const deleting = opened?.at === 'delete' ? opened.product.name : '';

  return (
    <Page title={t`Products`} actions={canManage ? addButton : undefined}>
      <PageIntro>
        <Trans>
          The products and services you sell, with their rates, for quotes and invoices.
        </Trans>
      </PageIntro>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {listed !== undefined && !canManage ? (
        <ReadOnlyNote>
          <Trans>
            You can look at the products. Adding and changing them needs permission to manage
            payments.
          </Trans>
        </ReadOnlyNote>
      ) : null}
      <section aria-label={t`Products`} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-3">
          <FilterChips
            label={t`Kind`}
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: t`All` },
              { value: 'product', label: t`Products` },
              { value: 'service', label: t`Services` },
            ]}
          />
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">
            <span className="flex items-center gap-2 text-sm text-body">
              <Switch aria-labelledby={archivedId} checked={archived} onChange={setArchived} />
              <span id={archivedId}>
                <Trans>Archived</Trans>
              </span>
            </span>
            <ListSearch label={t`Search products`} value={text} onChange={setText} />
          </div>
        </div>
        {products.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {refused ? (
          <Refused />
        ) : products.isError ? (
          <ListProblem
            onRetry={() => {
              setTrail(emptyTrail);
              void products.refetch();
            }}
          >
            <Trans>The products couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {listed !== undefined && items.length === 0 ? (
          q !== '' || kind !== 'all' ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              <Trans>No products match.</Trans>
            </p>
          ) : archived ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              <Trans>Nothing is archived.</Trans>
            </p>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-md text-muted-foreground">
                <Trans>
                  Add what you sell once, with its rate, and pick it on every quote and invoice.
                </Trans>
              </p>
              {canManage ? addButton : null}
            </div>
          )
        ) : null}
        {items.length === 0 ? null : (
          <div role="region" aria-label={t`Products table`} className={tableRegionClassName}>
            <table className={`${tableClassName} min-w-[760px]`}>
              <caption className="sr-only">
                <Trans>Products</Trans>
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Name</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-24`}>
                    <Trans>Kind</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-28`}>
                    <Trans>Code</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-24`}>
                    <Trans>Unit</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-36 text-right`}>
                    <Trans>Rate</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-24 text-right`}>
                    <Trans>Tax</Trans>
                  </th>
                  {canManage ? (
                    <th scope="col" className={`${headerCellClassName} w-32`}>
                      <span className="sr-only">
                        <Trans>Actions</Trans>
                      </span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {items.map((product) => (
                  <tr key={product.id} className="hover:bg-muted">
                    <th scope="row" className={`${cellClassName} text-left`}>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium wrap-anywhere text-foreground">
                          {product.name}
                        </span>
                        {product.description === '' ? null : (
                          <span className="line-clamp-1 text-xs font-normal text-muted-foreground">
                            {product.description}
                          </span>
                        )}
                      </span>
                    </th>
                    <td className={cellClassName}>
                      <Chip tone={product.kind === 'service' ? 'info' : 'neutral'}>
                        {kindNames[product.kind]}
                      </Chip>
                    </td>
                    <td className={`${cellClassName} wrap-anywhere`}>{product.sku ?? '—'}</td>
                    <td className={`${cellClassName} wrap-anywhere`}>
                      {product.unit === '' ? '—' : product.unit}
                    </td>
                    <td
                      className={`${cellClassName} text-right font-medium whitespace-nowrap text-foreground`}
                    >
                      {formats.money(product.unitPrice, product.currency)}
                    </td>
                    <td className={`${cellClassName} text-right whitespace-nowrap`}>
                      {product.taxRate === null ? t`Default` : formats.percent(product.taxRate)}
                    </td>
                    {canManage ? (
                      <td className={`${cellClassName} text-right whitespace-nowrap`}>
                        <button
                          type="button"
                          className={iconButtonClassName}
                          aria-label={words.edit(product.name)}
                          onClick={(event) => {
                            open({ at: 'panel', product }, event.currentTarget);
                          }}
                        >
                          <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          className={iconButtonClassName}
                          aria-label={
                            product.archived
                              ? words.restore(product.name)
                              : words.archive(product.name)
                          }
                          disabled={shelve.isPending}
                          onClick={() => {
                            setNotice('');
                            shelve.mutate(product);
                          }}
                        >
                          {product.archived ? (
                            <ArchiveRestore aria-hidden className="size-4" strokeWidth={1.8} />
                          ) : (
                            <Archive aria-hidden className="size-4" strokeWidth={1.8} />
                          )}
                        </button>
                        {product.used ? null : (
                          <button
                            type="button"
                            className={`${iconButtonClassName} text-destructive hover:text-destructive`}
                            aria-label={words.remove(product.name)}
                            onClick={(event) => {
                              open({ at: 'delete', product }, event.currentTarget);
                            }}
                          >
                            <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                          </button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {listed === undefined ? null : (
          <Pager
            number={trail.index + 1}
            previous={trail.index > 0}
            next={listed.nextCursor !== null}
            busy={turning}
            onPrevious={() => {
              setTrail(trailBack);
            }}
            onNext={() => {
              setTrail(trailForward(trail, listed.nextCursor));
            }}
          />
        )}
      </section>

      <RightPanel
        open={opened?.at === 'panel'}
        title={
          opened?.at === 'panel' && opened.product !== undefined ? (
            <Trans>Edit product</Trans>
          ) : (
            <Trans>Add product</Trans>
          )
        }
        description={<Trans>What it is called, what one of it is, and its rate before tax.</Trans>}
        returnFocus={returnFocusRef}
        onClose={close}
      >
        {opened?.at === 'panel' ? (
          <Suspense fallback={null}>
            <ProductPanel
              key={opened.product?.id ?? 'new'}
              product={opened.product}
              currency={profile.data?.currency ?? opened.product?.currency ?? ''}
              onCancel={() => {
                close();
              }}
              onSaved={async (saved, created) => {
                await refresh();
                const name = saved.name;
                close(created ? t`${name} was added.` : t`${name} was saved.`);
              }}
            />
          </Suspense>
        ) : null}
      </RightPanel>
      <ConfirmDialog
        open={opened?.at === 'delete'}
        title={<Trans>Delete product</Trans>}
        description={
          <Trans>
            {deleting} will be deleted for good. No quote or invoice names it, so nothing else
            changes.
          </Trans>
        }
        confirmLabel={t`Delete for good`}
        destructive
        busy={remove.isPending}
        problem={problem}
        returnFocus={returnFocusRef}
        onClose={close}
        onConfirm={() => {
          if (opened?.at === 'delete') remove.mutate(opened.product);
        }}
      />
    </Page>
  );
}
