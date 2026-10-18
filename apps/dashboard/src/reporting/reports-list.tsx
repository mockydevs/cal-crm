// Reporting → Custom reports: the "Reports overview" list, as GoHighLevel's: search, a
// table of the saved reports with who made each and when, a menu for each row, rows per
// page and paging, and "+ New report" from blank or from the Template Library. There is no
// Schedule frequency column: schedules are not built yet, and nothing shows that does
// nothing. Making, renaming, cloning and deleting need the permission to manage reports,
// which the server says with canManage.
import { Trans, useLingui } from '@lingui/react/macro';
import { cloneReport, deleteReport, listReports, type ReportList } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { EllipsisVertical, Plus } from 'lucide-react';
import { lazy, Suspense, useRef, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListProblem,
  tableClassName,
  tableRegionClassName,
  useSettled,
} from '../list-table';
import { emptyTrail, trailBack, trailCursor, trailForward } from '../settings-rules';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import { iconButtonClassName, isForbidden, reportingKeys, retryFaults } from './keys';
import { NoAccess, SearchBox, Switch } from './parts';

type Item = ReportList['items'][number];

const pageSizes = [10, 15, 25, 50] as const;
type PageSize = (typeof pageSizes)[number];

type Opened =
  | { readonly kind: 'new' }
  | { readonly kind: 'rename'; readonly item: Item }
  | { readonly kind: 'delete'; readonly item: Item };

/** What a refused change says: the server's sentence, or the page's own. */
const wordsOf = (error: unknown, fallback: string): string =>
  error instanceof ApiError
    ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? fallback)
    : fallback;

// The dialogs come with the first one opened.
const dialogs = (): Promise<typeof import('./reports-dialogs')> => import('./reports-dialogs');
const NewReportDialog = lazy(async () => ({ default: (await dialogs()).NewReportDialog }));
const RenameDialog = lazy(async () => ({ default: (await dialogs()).RenameDialog }));
const DeleteDialog = lazy(async () => ({ default: (await dialogs()).DeleteDialog }));

interface RowAction {
  readonly label: string;
  readonly destructive?: boolean;
  /** True for an action that opens a dialog, which then takes the keyboard. */
  readonly opens?: boolean;
  readonly onSelect: (trigger: HTMLElement | null) => void;
}

/**
 * A row's menu of actions. An action that opens a dialog hands it the keyboard, and the
 * dialog gives it back to this button when it closes; any other action leaves the keyboard
 * on the button.
 */
function RowActions({
  label,
  actions,
}: {
  readonly label: string;
  readonly actions: readonly RowAction[];
}): ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingRef = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger ref={triggerRef} aria-label={label} className={iconButtonClassName}>
        <EllipsisVertical aria-hidden className="size-5" strokeWidth={1.8} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        finalFocus={() => {
          const opening = openingRef.current;
          openingRef.current = false;
          return !opening;
        }}
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            className={action.destructive === true ? 'text-destructive' : undefined}
            onClick={() => {
              openingRef.current = action.opens === true;
              action.onSelect(triggerRef.current);
            }}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ReportsListPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useSettled(search).trim();
  const [pageSize, setPageSize] = useState<PageSize>(15);
  const [trail, setTrail] = useState(emptyTrail);
  const [opened, setOpened] = useState<Opened>();
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const after = trailCursor(trail);
  const list = useQuery({
    queryKey: [...reportingKeys.reports(business.id), { q, pageSize, after }],
    queryFn: () =>
      api.request(listReports, {
        query: {
          limit: pageSize,
          ...(q === '' ? {} : { q }),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const refresh = (): Promise<void> =>
    cache.invalidateQueries({ queryKey: reportingKeys.reports(business.id) });
  const open = (next: Opened, trigger: HTMLElement | null): void => {
    returnFocusRef.current = trigger;
    setProblem(undefined);
    setNotice('');
    setOpened(next);
  };
  const close = (message = ''): void => {
    setOpened(undefined);
    setProblem(undefined);
    setNotice(message);
  };
  const show = (id: string, edit: boolean): void => {
    void navigate({
      to: '/b/$slug/reports/$reportId',
      params: { slug: business.slug, reportId: id },
      search: edit ? { edit: true } : {},
    });
  };

  const clone = useMutation({
    mutationFn: (item: Item) => api.request(cloneReport, { params: { id: item.id }, body: {} }),
    onSuccess: async (copy) => {
      await refresh();
      const name = copy.name;
      setNotice(t`Made ${name}.`);
    },
    onError: (error) => {
      setNotice(wordsOf(error, t`The report couldn't be cloned.`));
    },
  });
  const remove = useMutation({
    mutationFn: (item: Item) =>
      api.request(deleteReport, { params: { id: item.id }, body: { revision: item.revision } }),
    onSuccess: async () => {
      // The last row of a page is gone: show the page before it.
      if (list.data?.items.length === 1) setTrail(trailBack);
      await refresh();
      close(t`Report deleted.`);
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t`This report changed since the list was read. Close this, and try again.`
          : wordsOf(error, t`The report couldn't be deleted.`),
      );
      if (error instanceof ApiError && error.status === 409) void refresh();
    },
  });

  const forbidden = isForbidden(list.error);
  const canManage = list.data?.canManage === true;
  const items = list.data?.items ?? [];
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const turning = list.isFetching && list.isPlaceholderData;
  const pageNumber = trail.index + 1;
  const makerOf = (item: Item): string =>
    item.createdBy.kind === 'template_library'
      ? t`Template Library`
      : (item.createdBy.name ?? (item.createdBy.kind === 'user' ? t`A team member` : t`Unknown`));

  if (forbidden)
    return (
      <Page title={t`Reports overview`}>
        <NoAccess />
      </Page>
    );

  return (
    <Page
      title={t`Reports overview`}
      actions={
        canManage ? (
          <Button
            onClick={(event) => {
              open({ kind: 'new' }, event.currentTarget);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>New report</Trans>
          </Button>
        ) : undefined
      }
    >
      <p role="status" className="sr-only">
        {notice}
      </p>
      <section aria-label={t`Custom reports`} className={listCardClassName}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SearchBox
            label={t`Search reports`}
            value={search}
            onChange={(next) => {
              setSearch(next);
              setTrail(emptyTrail);
            }}
          />
        </div>
        {list.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading reports…</Trans>
          </p>
        ) : null}
        {list.isError ? (
          <ListProblem
            onRetry={() => {
              void list.refetch();
            }}
          >
            <Trans>The reports couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {list.data !== undefined && items.length === 0 ? (
          <p className="py-8 text-center text-md text-muted-foreground">
            {q !== '' ? (
              <Trans>No reports match.</Trans>
            ) : canManage ? (
              <Trans>
                No reports yet. Make one from blank, or start from the Template Library.
              </Trans>
            ) : (
              <Trans>No reports yet.</Trans>
            )}
          </p>
        ) : null}
        {items.length === 0 ? null : (
          <div role="region" aria-label={t`Reports table`} className={tableRegionClassName}>
            <table className={`${tableClassName} min-w-[640px]`}>
              <caption className="sr-only">
                <Trans>Custom reports</Trans>
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Report name</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-48`}>
                    <Trans>Created at</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-48`}>
                    <Trans>Created by</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-16`}>
                    <Trans>Actions</Trans>
                  </th>
                </tr>
              </thead>
              <tbody aria-busy={turning}>
                {items.map((item) => {
                  const name = item.name;
                  return (
                    <tr key={item.id} className="hover:bg-muted">
                      <th
                        scope="row"
                        className={`${cellClassName} text-left font-medium wrap-anywhere`}
                      >
                        <Link
                          to="/b/$slug/reports/$reportId"
                          params={{ slug: business.slug, reportId: item.id }}
                          className="inline-flex min-h-11 items-center text-link hover:underline lg:min-h-8"
                        >
                          {item.name}
                        </Link>
                      </th>
                      <td className={cellClassName}>
                        <time dateTime={item.createdAt}>
                          {dates.format(new Date(item.createdAt))}
                        </time>
                      </td>
                      <td className={`${cellClassName} wrap-anywhere`}>{makerOf(item)}</td>
                      <td className={`${cellClassName} text-right`}>
                        <RowActions
                          label={t`Actions for ${name}`}
                          actions={[
                            {
                              label: t`Open`,
                              onSelect: () => {
                                show(item.id, false);
                              },
                            },
                            ...(canManage
                              ? [
                                  {
                                    label: t`Rename`,
                                    opens: true,
                                    onSelect: (trigger: HTMLElement | null) => {
                                      open({ kind: 'rename', item }, trigger);
                                    },
                                  },
                                  {
                                    label: t`Clone`,
                                    onSelect: () => {
                                      setNotice('');
                                      clone.mutate(item);
                                    },
                                  },
                                  {
                                    label: t`Delete`,
                                    destructive: true,
                                    opens: true,
                                    onSelect: (trigger: HTMLElement | null) => {
                                      open({ kind: 'delete', item }, trigger);
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.data === undefined ? null : (
          <nav
            aria-label={t`Pages`}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-body"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span aria-hidden className="text-muted-foreground">
                <Trans>Rows per page</Trans>
              </span>
              <Switch
                label={t`Rows per page`}
                value={String(pageSize)}
                onChange={(value) => {
                  const size = pageSizes.find((each) => String(each) === value);
                  if (size === undefined) return;
                  setPageSize(size);
                  setTrail(emptyTrail);
                }}
                views={pageSizes.map((size) => ({ value: String(size), label: String(size) }))}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="quiet"
                size="small"
                aria-label={t`Previous page`}
                disabled={trail.index === 0 || turning}
                onClick={() => {
                  setTrail(trailBack);
                }}
              >
                <Trans>Previous</Trans>
              </Button>
              <p role="status" aria-busy={turning}>
                <Trans>Page {pageNumber}</Trans>
              </p>
              <Button
                variant="quiet"
                size="small"
                aria-label={t`Next page`}
                disabled={list.data.nextCursor === null || turning}
                onClick={() => {
                  const next = list.data.nextCursor;
                  setTrail((current) => trailForward(current, next));
                }}
              >
                <Trans>Next</Trans>
              </Button>
            </div>
          </nav>
        )}
      </section>
      <Suspense fallback={null}>
        {opened?.kind === 'new' ? (
          <NewReportDialog
            businessId={business.id}
            returnFocus={returnFocusRef}
            onClose={() => {
              close();
            }}
            onCreated={(id) => {
              void refresh();
              show(id, true);
            }}
          />
        ) : null}
        {opened?.kind === 'rename' ? (
          <RenameDialog
            businessId={business.id}
            item={opened.item}
            returnFocus={returnFocusRef}
            onClose={() => {
              close();
            }}
            onRenamed={async () => {
              await refresh();
              close(t`Report renamed.`);
            }}
          />
        ) : null}
        {opened?.kind === 'delete' ? (
          <DeleteDialog
            name={opened.item.name}
            busy={remove.isPending}
            problem={problem}
            returnFocus={returnFocusRef}
            onConfirm={() => {
              remove.mutate(opened.item);
            }}
            onClose={() => {
              close();
            }}
          />
        ) : null}
      </Suspense>
    </Page>
  );
}
