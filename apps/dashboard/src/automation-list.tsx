// The Workflows list: every workflow of the business as a table, in folders, with what each
// has enrolled and its numbers on request, and the workflows deleted in the last days with
// the way to bring one back. Everything shown is what the automation API answers.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AUTOMATION_DELETED_DAYS,
  createAutomation,
  deleteAutomation,
  deleteAutomationFolder,
  getAutomation,
  listAutomationFolders,
  listAutomations,
  moveAutomation,
  restoreAutomation,
  type AutomationSummary,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { EmptyState } from '@repo/ui/components/empty-state';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, Folder, GitBranch, Search } from 'lucide-react';
import { Fragment, lazy, Suspense, useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  copyName,
  folderPath,
  foldersIn,
  isNarrowed,
  listQuery,
  listStatuses,
  type ListStatus,
  type Opened,
} from './automation-list-rules';
import { SearchLink, type AutomationsNavigation } from './automation-navigation';
import type { RecipesDialogProps } from './automation-recipes';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  iconButtonClassName,
  listCardClassName,
  ListProblem,
  RowMenu,
  tableClassName,
  tableRegionClassName,
  useSettled,
} from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

// Export and import are fetched when first asked for.
const ImportDialog = lazy(() => import('./automation-transfer'));
// The ready-made workflows, with their words (lingui.config.ts): fetched when first asked for.
const RecipesDialog = lazy(async () => {
  const [dialog, words] = await Promise.all([
    import('./automation-recipes'),
    import('./automation-words'),
  ]);
  await words.loadAutomationWords();
  return dialog;
});
// So are the dialogs that name and move things and a row's numbers: the list itself is
// what everyone opening the page waits for.
const ListDialogs = lazy(async () => ({
  default: (await import('./automation-list-parts')).ListDialogs,
}));
const StatsStrip = lazy(async () => ({
  default: (await import('./automation-list-parts')).StatsStrip,
}));

export const automationListKey = (businessId: string): readonly string[] => [
  'b',
  businessId,
  'automations',
];

const ANY_STATUS = 'any';

/** What went wrong with a request, in the server's words when it gave any. */
function refusalOf(error: unknown, fallback: string, forbidden: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 403) return forbidden;
  return error.problem.errors?.[0]?.message ?? error.problem.detail ?? fallback;
}

const tabClassName =
  'flex min-h-11 items-center border-b-2 border-transparent px-1 text-sm font-medium text-body hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-link lg:min-h-9';

/** Published in the success colours with their outline; every other status a neutral pill. */
function StatusPill({ status }: { readonly status: AutomationSummary['status'] }): ReactElement {
  const className =
    status === 'active'
      ? 'border-success-line bg-success-subtle text-success'
      : 'border-transparent bg-secondary text-secondary-foreground';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${className}`}
    >
      {status === 'active' ? (
        <Trans>Published</Trans>
      ) : status === 'paused' ? (
        <Trans>Paused</Trans>
      ) : status === 'archived' ? (
        <Trans>Deleted</Trans>
      ) : (
        <Trans>Draft</Trans>
      )}
    </span>
  );
}

export function AutomationList({
  folder: folderInAddress,
  deleted,
  recipe,
  navigation,
}: {
  /** The folder the address names; the top level without one. */
  readonly folder: string | undefined;
  /** Whether the address is the Deleted list. */
  readonly deleted: boolean;
  /** The recipe the address opens "Start from a recipe" on, and its calendar. */
  readonly recipe?: RecipesDialogProps['initial'];
  readonly navigation: AutomationsNavigation;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const searchId = useId();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<ListStatus>();
  const [typed, setTyped] = useState('');
  const q = useSettled(typed);
  const [opened, setOpened] = useState<Opened>();
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();

  const folders = useQuery({
    queryKey: [...automationListKey(business.id), 'folders'],
    queryFn: () => api.request(listAutomationFolders, {}),
  });
  const folderItems = folders.data?.items ?? [];
  // A folder the address names that is gone is the top level.
  const path = deleted ? [] : folderPath(folderItems, folderInAddress);
  const folder = path.at(-1);
  const narrowed = isNarrowed({ status, q });
  const query = listQuery({ deleted, folder: folder?.id, status, q });
  const automations = useInfiniteQuery({
    queryKey: [...automationListKey(business.id), 'list', query],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api.request(listAutomations, {
        query: { ...query, ...(pageParam === '' ? {} : { after: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !folders.isPending,
    // While a new search or filter loads, the rows on screen stay: no flash of an empty
    // list, and a row's open menu is not closed under the pointer.
    placeholderData: keepPreviousData,
  });
  const canManage = automations.data?.pages[0]?.canManage === true;
  const items = automations.data?.pages.flatMap((page) => page.items) ?? [];
  const folderRows = deleted || narrowed ? [] : foldersIn(folderItems, folder?.id);
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const days = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const number = new Intl.NumberFormat(i18n.locale);
  const when = (moment: string | null | undefined, format = dates): string =>
    moment === null || moment === undefined ? '' : format.format(new Date(moment));

  const refresh = (): Promise<void> =>
    cache.invalidateQueries({ queryKey: automationListKey(business.id) });
  const open = (next: Opened, trigger: HTMLElement | null): void => {
    returnFocusRef.current = trigger;
    setOpened(next);
    setNotice('');
    setProblem(undefined);
  };
  const close = (): void => {
    setOpened(undefined);
  };
  const done = (message: string): void => {
    setOpened(undefined);
    setNotice(message);
    void refresh();
  };

  const create = useMutation({
    mutationFn: async (number: number) => {
      const { automation } = await api.request(createAutomation, {
        // As GoHighLevel names a new workflow; the builder's first bar renames it.
        body: {
          document: { name: t`New Workflow : ${number}`, triggers: [], steps: {} },
        },
      });
      if (folder !== undefined)
        await api.request(moveAutomation, {
          params: { id: automation.id },
          body: { folderId: folder.id },
        });
      return automation;
    },
    onSuccess: (automation) => {
      void refresh();
      navigation.go({ automation: automation.id });
    },
    onError: (error) => {
      void refresh();
      setProblem(
        refusalOf(
          error,
          t`We couldn't create the workflow. Check your connection and try again.`,
          t`You don't have permission to create workflows.`,
        ),
      );
    },
  });
  // The import dialog's code is fetched when it is first asked for, and the dialog then stays.
  const [importing, setImporting] = useState(false);
  const [importWanted, setImportWanted] = useState(false);
  // An address that names a recipe opens the dialog on it.
  const [recipes, setRecipes] = useState(recipe !== undefined);
  const [recipesWanted, setRecipesWanted] = useState(recipe !== undefined);
  // Exporting, with its words, lives with the import dialog: fetched when first asked for.
  const exportOne = async (source: AutomationSummary): Promise<void> => {
    try {
      const { exportWorkflow } = await import('./automation-transfer');
      const result = await exportWorkflow(api, source);
      if (result.ok) setNotice(result.words);
      else setProblem(result.words);
    } catch {
      setProblem(t`We couldn't export the workflow. Check your connection and try again.`);
    }
  };
  const duplicate = useMutation({
    mutationFn: async (source: AutomationSummary) => {
      const original = await api.request(getAutomation, { params: { id: source.id } });
      const { automation } = await api.request(createAutomation, {
        body: { document: { ...original.draft, name: copyName(source.name, t`(copy)`) } },
      });
      if (source.folderId !== null && source.folderId !== undefined)
        await api.request(moveAutomation, {
          params: { id: automation.id },
          body: { folderId: source.folderId },
        });
      return automation;
    },
    onSuccess: (automation) => {
      const { name } = automation;
      done(t`Created ${name} as a draft.`);
    },
    onError: (error) => {
      void refresh();
      setProblem(
        refusalOf(
          error,
          t`We couldn't duplicate the workflow. Try again.`,
          t`You don't have permission to create workflows.`,
        ),
      );
    },
  });
  const restore = useMutation({
    mutationFn: (automation: AutomationSummary) =>
      api.request(restoreAutomation, { params: { id: automation.id } }),
    onSuccess: (automation) => {
      const { name } = automation;
      done(
        automation.status === 'paused'
          ? t`Restored ${name}. It is paused: nothing new starts until it is published again.`
          : t`Restored ${name} as a draft.`,
      );
    },
    onError: (error) => {
      setProblem(
        refusalOf(
          error,
          t`We couldn't restore the workflow. Try again.`,
          t`You don't have permission to restore workflows.`,
        ),
      );
    },
  });
  const remove = useMutation({
    mutationFn: async (target: Opened) => {
      if (target.kind === 'delete')
        await api.request(deleteAutomation, { params: { id: target.automation.id } });
      else if (target.kind === 'delete-folder')
        await api.request(deleteAutomationFolder, { params: { id: target.folder.id } });
      return target;
    },
    onSuccess: (target) => {
      done(target.kind === 'delete-folder' ? t`Folder deleted.` : t`Workflow deleted.`);
    },
  });

  const actions = canManage ? (
    <div className="flex flex-wrap gap-2">
      {deleted ? null : (
        <Button
          variant="secondary"
          onClick={(event) => {
            open({ kind: 'create-folder' }, event.currentTarget);
          }}
        >
          <Trans>Create folder</Trans>
        </Button>
      )}
      {deleted ? null : (
        <Button
          variant="secondary"
          onClick={() => {
            setProblem(undefined);
            setNotice('');
            setImportWanted(true);
            setImporting(true);
          }}
        >
          <Trans>Import workflow</Trans>
        </Button>
      )}
      {deleted ? null : (
        <Button
          variant="secondary"
          onClick={() => {
            setProblem(undefined);
            setNotice('');
            setRecipesWanted(true);
            setRecipes(true);
          }}
        >
          <Trans>Start from a recipe</Trans>
        </Button>
      )}
      <Button
        disabled={create.isPending}
        onClick={() => {
          setProblem(undefined);
          setNotice('');
          create.mutate(Date.now());
        }}
      >
        <Trans>Create workflow</Trans>
      </Button>
    </div>
  ) : undefined;

  const removing = opened?.kind === 'delete' || opened?.kind === 'delete-folder';
  const removingName =
    opened?.kind === 'delete'
      ? opened.automation.name
      : opened?.kind === 'delete-folder'
        ? opened.folder.name
        : '';
  const failed = folders.isError || automations.isError;
  const loaded = !failed && automations.data !== undefined;
  const empty = loaded && items.length === 0 && folderRows.length === 0;
  const columns = deleted ? 4 : 8;

  return (
    <Page title={t`Workflows list`} actions={actions}>
      {importWanted ? (
        <Suspense fallback={null}>
          <ImportDialog
            open={importing}
            onOpenChange={setImporting}
            onImported={(automation) => {
              void refresh();
              navigation.go({ automation: automation.id });
            }}
          />
        </Suspense>
      ) : null}
      {recipesWanted ? (
        <Suspense fallback={null}>
          <RecipesDialog
            open={recipes}
            initial={recipe}
            onOpenChange={(open) => {
              setRecipes(open);
              // Closed, the address no longer names the recipe: going back does not reopen it.
              if (!open && recipe !== undefined)
                navigation.go(folderInAddress === undefined ? {} : { folder: folderInAddress }, {
                  replace: true,
                });
            }}
            onCreated={(automation) => {
              void refresh();
              navigation.go({ automation: automation.id });
            }}
          />
        </Suspense>
      ) : null}
      <p role="status" className="sr-only">
        {notice}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
          {problem}
        </p>
      )}
      <nav aria-label={t`Workflow lists`} className="flex flex-wrap gap-x-5 border-b border-border">
        <SearchLink
          to={{}}
          navigation={navigation}
          className={tabClassName}
          {...(deleted ? {} : { 'aria-current': 'page' as const })}
        >
          <Trans>All workflows</Trans>
        </SearchLink>
        <SearchLink
          to={{ list: 'deleted' }}
          navigation={navigation}
          className={tabClassName}
          {...(deleted ? { 'aria-current': 'page' as const } : {})}
        >
          <Trans>Deleted</Trans>
        </SearchLink>
      </nav>
      <section
        aria-label={deleted ? t`Deleted workflows` : t`All workflows`}
        className={listCardClassName}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          {deleted ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                A deleted workflow stays here for {AUTOMATION_DELETED_DAYS} days, then is removed
                for good.
              </Trans>
            </p>
          ) : (
            <Select
              aria-label={t`Status`}
              className="w-auto max-w-full min-w-40"
              value={status ?? ANY_STATUS}
              onValueChange={(next) => {
                setStatus(listStatuses.find((each) => each === next));
              }}
            >
              <option value={ANY_STATUS}>{t`All statuses`}</option>
              <option value="active">{t`Published`}</option>
              <option value="draft">{t`Draft`}</option>
              <option value="paused">{t`Paused`}</option>
            </Select>
          )}
          <form
            role="search"
            className="relative min-w-0 flex-1 basis-48 sm:max-w-64"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <label htmlFor={searchId} className="sr-only">
              <Trans>Search workflows</Trans>
            </label>
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              strokeWidth={1.8}
            />
            <Input
              id={searchId}
              type="search"
              autoComplete="off"
              maxLength={120}
              placeholder={t`Search workflows`}
              value={typed}
              className="pl-9"
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </form>
        </div>
        {deleted ? null : (
          <nav aria-label={t`Folders`}>
            <ol className="flex flex-wrap items-center gap-1 text-sm text-body">
              <li className="flex items-center gap-1">
                {folder === undefined ? (
                  <span aria-current="page" className="py-1 font-medium text-foreground">
                    <Trans>Home</Trans>
                  </span>
                ) : (
                  <SearchLink
                    to={{}}
                    navigation={navigation}
                    className="py-1 text-link underline-offset-2 hover:underline"
                  >
                    <Trans>Home</Trans>
                  </SearchLink>
                )}
              </li>
              {path.map((each) => (
                <li key={each.id} className="flex min-w-0 items-center gap-1">
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  {each === folder ? (
                    <span
                      aria-current="page"
                      className="py-1 font-medium wrap-anywhere text-foreground"
                    >
                      {each.name}
                    </span>
                  ) : (
                    <SearchLink
                      to={{ folder: each.id }}
                      navigation={navigation}
                      className="py-1 wrap-anywhere text-link underline-offset-2 hover:underline"
                    >
                      {each.name}
                    </SearchLink>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        {!failed && automations.data === undefined ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading workflows…</Trans>
          </p>
        ) : null}
        {failed ? (
          <ListProblem
            onRetry={() => {
              void folders.refetch();
              void automations.refetch();
            }}
          >
            <Trans>We couldn't load the workflows.</Trans>
          </ListProblem>
        ) : null}
        {empty && !deleted && !narrowed && folder === undefined ? (
          <EmptyState
            icon={<GitBranch strokeWidth={1.8} />}
            title={<Trans>No workflows yet</Trans>}
            description={
              canManage ? (
                <Trans>
                  Create one, then add what sets it off, such as a new contact or a submitted form.
                </Trans>
              ) : (
                <Trans>Workflows set up for this business are listed here.</Trans>
              )
            }
          />
        ) : empty ? (
          <p className="py-6 text-center text-md text-muted-foreground">
            {deleted ? (
              <Trans>
                No workflow has been deleted in the last {AUTOMATION_DELETED_DAYS} days.
              </Trans>
            ) : narrowed ? (
              <Trans>No workflows match.</Trans>
            ) : (
              <Trans>This folder is empty.</Trans>
            )}
          </p>
        ) : null}
        {!loaded || empty ? null : (
          <div role="region" aria-label={t`Workflows table`} className={tableRegionClassName}>
            <table className={`${tableClassName} ${deleted ? 'min-w-[640px]' : 'min-w-[980px]'}`}>
              <caption className="sr-only">
                {deleted ? <Trans>Deleted workflows</Trans> : <Trans>Workflows</Trans>}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Name</Trans>
                  </th>
                  {deleted ? (
                    <>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Deleted on</Trans>
                      </th>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Removed for good on</Trans>
                      </th>
                    </>
                  ) : (
                    <>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Status</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} text-right`}>
                        <Trans>Total enrolled</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} text-right`}>
                        <Trans>Active enrolled</Trans>
                      </th>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Last updated</Trans>
                      </th>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Created on</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} w-16`}>
                        <Trans>Stats</Trans>
                      </th>
                    </>
                  )}
                  <th scope="col" className={`${headerCellClassName} w-16`}>
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {folderRows.map((each) => {
                  const { name } = each;
                  return (
                    <tr key={each.id} className="hover:bg-muted">
                      <th scope="row" className={`${cellClassName} h-14 text-left font-medium`}>
                        <SearchLink
                          to={{ folder: each.id }}
                          navigation={navigation}
                          aria-label={t`Open the folder ${name}`}
                          className="inline-flex min-h-11 max-w-full items-center gap-2 wrap-anywhere text-foreground underline-offset-2 hover:underline lg:min-h-8"
                        >
                          <Folder
                            aria-hidden
                            className="size-4.5 shrink-0 text-muted-foreground"
                            strokeWidth={1.8}
                          />
                          {name}
                        </SearchLink>
                      </th>
                      <td className={cellClassName} />
                      <td className={cellClassName} />
                      <td className={cellClassName} />
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {when(each.updatedAt)}
                      </td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {when(each.createdAt)}
                      </td>
                      <td className={cellClassName} />
                      <td className={`${cellClassName} text-right`}>
                        {folders.data?.canManage === true ? (
                          <RowMenu
                            label={t`Actions for the folder ${name}`}
                            onOpen={(trigger) => {
                              returnFocusRef.current = trigger;
                            }}
                            actions={[
                              {
                                label: t`Rename`,
                                onSelect: () => {
                                  open(
                                    { kind: 'rename-folder', folder: each },
                                    returnFocusRef.current,
                                  );
                                },
                              },
                              {
                                label: t`Delete folder`,
                                destructive: true,
                                onSelect: () => {
                                  open(
                                    { kind: 'delete-folder', folder: each },
                                    returnFocusRef.current,
                                  );
                                },
                              },
                            ]}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {items.map((automation) => {
                  const { name } = automation;
                  const showing = expanded.includes(automation.id);
                  return deleted ? (
                    <tr key={automation.id} className="hover:bg-muted">
                      <th
                        scope="row"
                        className={`${cellClassName} h-14 text-left font-medium wrap-anywhere text-foreground`}
                      >
                        {name}
                      </th>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {when(automation.deletedAt)}
                      </td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {when(automation.purgeAt, days)}
                      </td>
                      <td className={`${cellClassName} text-right`}>
                        {canManage ? (
                          <Button
                            variant="secondary"
                            size="small"
                            aria-label={t`Restore ${name}`}
                            disabled={restore.isPending}
                            onClick={() => {
                              setProblem(undefined);
                              restore.mutate(automation);
                            }}
                          >
                            <Trans>Restore</Trans>
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ) : (
                    <Fragment key={automation.id}>
                      <tr className="hover:bg-muted">
                        <th scope="row" className={`${cellClassName} h-14 text-left font-medium`}>
                          <span className="flex min-w-0 items-center gap-1">
                            <SearchLink
                              to={{ automation: automation.id }}
                              navigation={navigation}
                              className="inline-flex min-h-11 min-w-0 items-center wrap-anywhere text-link underline-offset-2 hover:underline lg:min-h-8"
                            >
                              {name}
                            </SearchLink>
                            <a
                              href={navigation.hrefFor({ automation: automation.id })}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={t`Open ${name} in a new tab`}
                              className={iconButtonClassName}
                            >
                              <ExternalLink aria-hidden className="size-4" strokeWidth={1.8} />
                            </a>
                          </span>
                        </th>
                        <td className={cellClassName}>
                          <StatusPill status={automation.status} />
                        </td>
                        <td className={`${cellClassName} text-right tabular-nums`}>
                          <SearchLink
                            to={{ automation: automation.id, view: 'runs' }}
                            navigation={navigation}
                            aria-label={t`Enrollment history of ${name}`}
                            className="inline-flex min-h-11 items-center text-link underline-offset-2 hover:underline lg:min-h-8"
                          >
                            {number.format(automation.totalEnrolled ?? 0)}
                          </SearchLink>
                        </td>
                        <td className={`${cellClassName} text-right tabular-nums`}>
                          {number.format(automation.activeEnrolled ?? 0)}
                        </td>
                        <td className={`${cellClassName} whitespace-nowrap`}>
                          {when(automation.updatedAt)}
                        </td>
                        <td className={`${cellClassName} whitespace-nowrap`}>
                          {when(automation.createdAt)}
                        </td>
                        <td className={cellClassName}>
                          <button
                            type="button"
                            className={iconButtonClassName}
                            aria-expanded={showing}
                            aria-label={t`Stats for ${name}`}
                            onClick={() => {
                              setExpanded((current) =>
                                showing
                                  ? current.filter((id) => id !== automation.id)
                                  : [...current, automation.id],
                              );
                            }}
                          >
                            {showing ? (
                              <ChevronDown aria-hidden className="size-5" strokeWidth={1.8} />
                            ) : (
                              <ChevronRight aria-hidden className="size-5" strokeWidth={1.8} />
                            )}
                          </button>
                        </td>
                        <td className={`${cellClassName} text-right`}>
                          {canManage ? (
                            <RowMenu
                              label={t`Actions for ${name}`}
                              onOpen={(trigger) => {
                                returnFocusRef.current = trigger;
                              }}
                              actions={[
                                {
                                  label: t`Rename`,
                                  onSelect: () => {
                                    open({ kind: 'rename', automation }, returnFocusRef.current);
                                  },
                                },
                                {
                                  label: t`Move to folder`,
                                  onSelect: () => {
                                    open({ kind: 'move', automation }, returnFocusRef.current);
                                  },
                                },
                                {
                                  label: t`Duplicate`,
                                  immediate: true,
                                  onSelect: () => {
                                    setProblem(undefined);
                                    setNotice('');
                                    duplicate.mutate(automation);
                                  },
                                },
                                {
                                  label: t`Export`,
                                  immediate: true,
                                  onSelect: () => {
                                    setProblem(undefined);
                                    setNotice('');
                                    void exportOne(automation);
                                  },
                                },
                                {
                                  label: t`Delete workflow`,
                                  destructive: true,
                                  onSelect: () => {
                                    open({ kind: 'delete', automation }, returnFocusRef.current);
                                  },
                                },
                              ]}
                            />
                          ) : null}
                        </td>
                      </tr>
                      {showing ? (
                        <tr>
                          <td colSpan={columns} className="border-t border-border bg-muted p-4">
                            <Suspense
                              fallback={
                                <p role="status" className="text-sm text-muted-foreground">
                                  <Trans>Loading the numbers…</Trans>
                                </p>
                              }
                            >
                              <StatsStrip automation={automation} />
                            </Suspense>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {automations.hasNextPage ? (
          <Button
            variant="secondary"
            className="self-start"
            disabled={automations.isFetchingNextPage}
            onClick={() => {
              void automations.fetchNextPage();
            }}
          >
            <Trans>Load more</Trans>
          </Button>
        ) : null}
      </section>

      {opened === undefined ||
      opened.kind === 'delete' ||
      opened.kind === 'delete-folder' ? null : (
        <Suspense fallback={null}>
          <ListDialogs
            opened={opened}
            parentId={folder?.id ?? null}
            folders={folderItems}
            returnFocus={returnFocusRef}
            onDone={done}
            onClose={close}
          />
        </Suspense>
      )}
      <ConfirmDialog
        open={removing}
        title={
          opened?.kind === 'delete-folder' ? (
            <Trans>Delete this folder?</Trans>
          ) : (
            <Trans>Delete this workflow?</Trans>
          )
        }
        description={
          opened?.kind === 'delete-folder' ? (
            <Trans>
              {removingName}: the workflows and folders in it move up one level. None is deleted.
            </Trans>
          ) : (
            <Trans>
              {removingName}: nothing new starts it, and every contact in it now is taken out. It
              stays under Deleted for {AUTOMATION_DELETED_DAYS} days, where it can be restored.
            </Trans>
          )
        }
        confirmLabel={opened?.kind === 'delete-folder' ? t`Delete folder` : t`Delete workflow`}
        destructive
        busy={remove.isPending}
        problem={
          remove.isError
            ? refusalOf(
                remove.error,
                t`We couldn't delete it. Try again.`,
                t`You don't have permission to delete this.`,
              )
            : undefined
        }
        returnFocus={returnFocusRef}
        onConfirm={() => {
          if (opened !== undefined) remove.mutate(opened);
        }}
        onClose={() => {
          remove.reset();
          close();
        }}
      />
    </Page>
  );
}
