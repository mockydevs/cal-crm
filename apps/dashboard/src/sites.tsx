// Sites → Funnels and Sites → Websites (laid out as GoHighLevel's): the funnels or the
// websites of the business, in folders one level deep, a page at a time as the server pages
// them. The module is one route: what follows /sites/ in the address says which page shows
// (sites-rules.ts), and a funnel's or website's own page and the dialogs that create one
// are fetched when they are first opened. Reading is open to the business; changing
// anything needs the permission the server reports with canManage.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  cloneSite,
  createSiteFolder,
  deleteSite,
  deleteSiteFolder,
  getSite,
  listSiteFolders,
  listSites,
  updateSite,
  updateSiteFolder,
  type SiteFolder,
  type SiteKind,
  type SiteSummary,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, FolderPlus, Plus } from 'lucide-react';
import { lazy, Suspense, useRef, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from './api';
import { ListSearch } from './list-toolbar';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  iconButtonClassName,
  listCardClassName,
  ListFooter,
  ListProblem,
  retryFaults,
  RowMenu,
  savingProblem,
  SmallDialog,
  tableClassName,
  tableRegionClassName,
  useSettled,
  ViewSwitch,
} from './settings-list';
import {
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type PageSize,
} from './settings-rules';
import { NotFound } from './shell/not-found';
import { Page } from './shell/page';
import { FormRefusal, NameDialog } from './sites-dialogs';
import { SitesLink, useSitesNavigate } from './sites-links';
import { listQueryOf, listSplat, placeOf, siteSplat, type SiteView } from './sites-rules';
import { useBusiness } from './workspace';

const SitePage = lazy(() => import('./site-page'));
const SiteCreateDialog = lazy(() => import('./sites-create'));
const SiteImportDialog = lazy(async () => ({
  default: (await import('./sites-create')).SiteImportDialog,
}));

/** The choice that stands for no folder: a select's choices each need a value. */
const HOME = 'home';

const linkClassName = 'font-medium text-link underline-offset-2 wrap-anywhere hover:underline';

type Opened =
  | { readonly kind: 'create' }
  | { readonly kind: 'import' }
  | { readonly kind: 'folder'; readonly folder: SiteFolder | undefined }
  | { readonly kind: 'delete-folder'; readonly folder: SiteFolder }
  | { readonly kind: 'rename'; readonly site: SiteSummary }
  | { readonly kind: 'move'; readonly site: SiteSummary }
  | { readonly kind: 'delete'; readonly site: SiteSummary };

/** The Sites module: whichever of its pages the address names. */
export function SitesPage({ splat }: { readonly splat: string | undefined }): ReactElement {
  const { t } = useLingui();
  const place = placeOf(splat);
  if (place.at === 'nowhere') return <NotFound />;
  if (place.at === 'list') {
    return (
      <SitesList
        key={`${place.kind}:${place.folderId ?? HOME}`}
        kind={place.kind}
        folderId={place.folderId}
      />
    );
  }
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted-foreground">
          {t`Loading…`}
        </p>
      }
    >
      <SitePage
        key={place.siteId}
        kind={place.kind}
        siteId={place.siteId}
        tab={place.tab}
        stepId={place.stepId}
      />
    </Suspense>
  );
}

function MoveDialog({
  site,
  folders,
  returnFocus,
  onClose,
  onMoved,
}: {
  readonly site: SiteSummary;
  readonly folders: readonly SiteFolder[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onMoved: () => Promise<void>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [destination, setDestination] = useState(site.folderId ?? HOME);
  const [problem, setProblem] = useState<string>();
  const move = useMutation({
    mutationFn: async () => {
      const api = apiIn(business.id);
      const current = await api.request(getSite, { params: { id: site.id } });
      return api.request(updateSite, {
        params: { id: site.id },
        body: { revision: current.revision, folderId: destination === HOME ? null : destination },
      });
    },
    onSuccess: onMoved,
    onError: (error) => {
      setProblem(
        savingProblem(error, t`It wasn't moved. Check your connection and try again.`).form,
      );
    },
  });
  return (
    <SmallDialog
      open
      title={<Trans>Move to folder</Trans>}
      description={site.name}
      returnFocus={returnFocus}
      onClose={() => {
        if (!move.isPending) onClose();
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(undefined);
          move.mutate();
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <Trans>Folder</Trans>
          <Select
            aria-label={t`Folder`}
            value={destination}
            disabled={move.isPending}
            onValueChange={setDestination}
          >
            <option value={HOME}>{t`Home (no folder)`}</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </Select>
        </label>
        <FormRefusal problem={{ fields: {}, form: problem }} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={move.isPending}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={move.isPending}>
            {move.isPending ? <Trans>Moving…</Trans> : <Trans>Move</Trans>}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

function SitesList({
  kind,
  folderId,
}: {
  readonly kind: SiteKind;
  readonly folderId: string | undefined;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const go = useSitesNavigate();
  const funnel = kind === 'funnel';
  const [text, setText] = useState('');
  const settled = useSettled(text);
  const [view, setView] = useState<SiteView>('recent');
  const [trail, setTrail] = useState(emptyTrail);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [opened, setOpened] = useState<Opened>();
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Another list starts at its first page.
  const asked = `${settled.trim()}:${view}`;
  const [shown, setShown] = useState(asked);
  if (shown !== asked) {
    setShown(asked);
    setTrail(emptyTrail);
  }

  const api = apiIn(business.id);
  const foldersKey = ['b', business.id, 'sites', 'folders', kind] as const;
  const folders = useQuery({
    queryKey: foldersKey,
    queryFn: () => api.request(listSiteFolders, { query: { kind } }),
    retry: retryFaults,
  });
  const query = listQueryOf({
    kind,
    folderId,
    text: settled,
    view,
    limit: pageSize,
    after: trailCursor(trail),
  });
  const sites = useQuery({
    queryKey: ['b', business.id, 'sites', 'list', query] as const,
    queryFn: () => api.request(listSites, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['b', business.id, 'sites', 'list'] }),
      cache.invalidateQueries({ queryKey: foldersKey }),
    ]);
  };

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
  const failed = (fallback: string) => (error: unknown) => {
    setProblem(savingProblem(error, fallback).form ?? fallback);
  };

  const clone = useMutation({
    mutationFn: (site: SiteSummary) =>
      api.request(cloneSite, { params: { id: site.id }, body: {} }),
    onSuccess: async (copy) => {
      await refresh();
      setNotice(words.copied(copy.name));
    },
    onError: (error) => {
      setNotice(
        savingProblem(error, t`It wasn't copied. Check your connection and try again.`).form ?? '',
      );
    },
  });
  const removeSite = useMutation({
    mutationFn: (site: SiteSummary) => api.request(deleteSite, { params: { id: site.id } }),
    onSuccess: async (_, site) => {
      await refresh();
      close(words.deleted(site.name));
    },
    onError: failed(t`It wasn't deleted. Check your connection and try again.`),
  });
  const removeFolder = useMutation({
    mutationFn: (folder: SiteFolder) =>
      api.request(deleteSiteFolder, { params: { id: folder.id } }),
    onSuccess: async (_, folder) => {
      await refresh();
      close(words.folderDeleted(folder.name));
    },
    onError: failed(t`The folder wasn't deleted. Check your connection and try again.`),
  });

  const listed = sites.data;
  const items = listed?.items ?? [];
  const canManage = listed?.canManage === true;
  const folderItems = folders.data?.items ?? [];
  const folder = folderItems.find((each) => each.id === folderId);
  const folderGone = folderId !== undefined && folders.isSuccess && folder === undefined;
  const searching = settled.trim() !== '';
  // Home lists its folders above its sites: on the first page, and not among search results.
  const folderRows = folderId === undefined && !searching && trail.index === 0 ? folderItems : [];
  const refused = sites.error instanceof ApiError && sites.error.status === 403;
  const turning = sites.isFetching && sites.isPlaceholderData;
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const title = funnel ? t`Funnels` : t`Websites`;
  // What is said about one site or folder, by its name.
  const words = {
    copied: (name: string) => t`Copied as ${name}.`,
    deleted: (name: string) => t`${name} was deleted.`,
    moved: (name: string) => t`${name} was moved.`,
    folderDeleted: (name: string) => t`The folder ${name} was deleted.`,
    actions: (name: string) => t`Actions for ${name}`,
    folderActions: (name: string) => t`Actions for the folder ${name}`,
  };
  const openedName =
    opened?.kind === 'delete'
      ? opened.site.name
      : opened?.kind === 'delete-folder'
        ? opened.folder.name
        : '';

  const createButton = (
    <Button
      onClick={(event) => {
        open({ kind: 'create' }, event.currentTarget);
      }}
    >
      <Plus aria-hidden className="size-4" strokeWidth={2} />
      {funnel ? <Trans>New funnel</Trans> : <Trans>New website</Trans>}
    </Button>
  );

  return (
    <Page
      title={title}
      actions={
        canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`${iconButtonClassName} border border-input bg-card`}
              aria-label={t`Create folder`}
              onClick={(event) => {
                open({ kind: 'folder', folder: undefined }, event.currentTarget);
              }}
            >
              <FolderPlus aria-hidden className="size-[18px]" strokeWidth={1.8} />
            </button>
            <Button
              variant="secondary"
              onClick={(event) => {
                open({ kind: 'import' }, event.currentTarget);
              }}
            >
              <Trans>Import</Trans>
            </Button>
            {createButton}
          </div>
        ) : undefined
      }
    >
      <p className="-mt-3 text-md text-muted-foreground">
        {funnel ? (
          <Trans>
            Create and manage funnels to generate leads, appointments and receive payments.
          </Trans>
        ) : (
          <Trans>Build websites to showcase your products and build a trusted brand.</Trans>
        )}
      </p>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {listed !== undefined && !canManage ? (
        <p className="text-md text-muted-foreground">
          {funnel ? (
            <Trans>
              You can look at funnels. Creating and changing them needs permission to manage sites.
            </Trans>
          ) : (
            <Trans>
              You can look at websites. Creating and changing them needs permission to manage sites.
            </Trans>
          )}
        </p>
      ) : null}
      <section aria-label={title} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-3">
          <nav aria-label={t`Folders`} className="min-w-0 flex-1 basis-40">
            <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
              <li>
                <SitesLink
                  splat={listSplat(kind)}
                  current={folderId === undefined}
                  className={`flex min-h-11 items-center rounded-control px-1 lg:min-h-8 ${linkClassName}`}
                >
                  <Trans>Home</Trans>
                </SitesLink>
              </li>
              {folder === undefined ? null : (
                <li className="flex min-w-0 items-center gap-1">
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span aria-current="page" className="min-w-0 font-medium wrap-anywhere">
                    {folder.name}
                  </span>
                </li>
              )}
            </ol>
          </nav>
          <ViewSwitch
            label={t`View`}
            value={view}
            onChange={setView}
            views={[
              { value: 'recent', label: <Trans>Recent</Trans> },
              { value: 'list', label: <Trans>List</Trans> },
            ]}
          />
          <ListSearch
            label={funnel ? t`Search funnels` : t`Search websites`}
            value={text}
            onChange={setText}
          />
        </div>
        {sites.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {refused ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            <Trans>You don't have permission to see this business's sites.</Trans>
          </p>
        ) : sites.isError ? (
          <ListProblem
            onRetry={() => {
              setTrail(emptyTrail);
              void sites.refetch();
            }}
          >
            {funnel ? (
              <Trans>The funnels couldn't be loaded.</Trans>
            ) : (
              <Trans>The websites couldn't be loaded.</Trans>
            )}
          </ListProblem>
        ) : null}
        {folderGone ? (
          <p role="alert" className="text-sm">
            <Trans>This folder is no longer here.</Trans>
          </p>
        ) : null}
        {listed !== undefined && items.length === 0 && folderRows.length === 0 ? (
          searching ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              {funnel ? <Trans>No funnels match.</Trans> : <Trans>No websites match.</Trans>}
            </p>
          ) : folderId !== undefined ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              <Trans>This folder is empty.</Trans>
            </p>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-md text-muted-foreground">
                {funnel ? (
                  <Trans>
                    Start by creating a funnel. All your funnels and folders will live here.
                  </Trans>
                ) : (
                  <Trans>
                    Start by creating a website. All your websites and folders will live here.
                  </Trans>
                )}
              </p>
              {canManage ? createButton : null}
            </div>
          )
        ) : null}
        {items.length + folderRows.length === 0 ? null : (
          <div
            role="region"
            aria-label={funnel ? t`Funnels table` : t`Websites table`}
            className={tableRegionClassName}
          >
            <table className={`${tableClassName} min-w-[560px]`}>
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Name</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-48`}>
                    <Trans>Last updated</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-36`}>
                    {funnel ? <Trans>Funnel steps</Trans> : <Trans>Website pages</Trans>}
                  </th>
                  {canManage ? (
                    <th scope="col" className={`${headerCellClassName} w-16`}>
                      <span className="sr-only">
                        <Trans>Actions</Trans>
                      </span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {folderRows.map((each) => (
                  <tr key={each.id} className="hover:bg-muted">
                    <th scope="row" className={`${cellClassName} text-left font-medium`}>
                      <span className="flex min-w-0 items-center gap-2">
                        <Folder
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                          strokeWidth={1.8}
                        />
                        <SitesLink splat={listSplat(kind, each.id)} className={linkClassName}>
                          {each.name}
                        </SitesLink>
                      </span>
                    </th>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      <time dateTime={each.updatedAt}>
                        {moment.format(new Date(each.updatedAt))}
                      </time>
                    </td>
                    <td className={cellClassName}>
                      {funnel ? (
                        <Plural value={each.siteCount} one="# Funnel" other="# Funnels" />
                      ) : (
                        <Plural value={each.siteCount} one="# Website" other="# Websites" />
                      )}
                    </td>
                    {canManage ? (
                      <td className={`${cellClassName} text-right`}>
                        <RowMenu
                          label={words.folderActions(each.name)}
                          onOpen={(trigger) => {
                            returnFocusRef.current = trigger;
                          }}
                          actions={[
                            {
                              label: t`Rename`,
                              onSelect: () => {
                                open({ kind: 'folder', folder: each }, returnFocusRef.current);
                              },
                            },
                            {
                              label: t`Delete`,
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
                      </td>
                    ) : null}
                  </tr>
                ))}
                {items.map((site) => (
                  <tr key={site.id} className="hover:bg-muted">
                    <th scope="row" className={`${cellClassName} text-left font-medium`}>
                      <SitesLink splat={siteSplat(kind, site.id)} className={linkClassName}>
                        {site.name}
                      </SitesLink>
                    </th>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      <time dateTime={site.updatedAt}>
                        {moment.format(new Date(site.updatedAt))}
                      </time>
                    </td>
                    <td className={cellClassName}>
                      {funnel ? (
                        <Plural value={site.stepCount} one="# Step" other="# Steps" />
                      ) : (
                        <Plural value={site.stepCount} one="# Page" other="# Pages" />
                      )}
                    </td>
                    {canManage ? (
                      <td className={`${cellClassName} text-right`}>
                        <RowMenu
                          label={words.actions(site.name)}
                          onOpen={(trigger) => {
                            returnFocusRef.current = trigger;
                          }}
                          actions={[
                            {
                              label: t`Rename`,
                              onSelect: () => {
                                open({ kind: 'rename', site }, returnFocusRef.current);
                              },
                            },
                            {
                              label: t`Move to folder`,
                              onSelect: () => {
                                open({ kind: 'move', site }, returnFocusRef.current);
                              },
                            },
                            {
                              label: t`Clone`,
                              immediate: true,
                              onSelect: () => {
                                setNotice('');
                                clone.mutate(site);
                              },
                            },
                            {
                              label: t`Delete`,
                              destructive: true,
                              onSelect: () => {
                                open({ kind: 'delete', site }, returnFocusRef.current);
                              },
                            },
                          ]}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {listed === undefined ? null : (
          <ListFooter
            perPageLabel={t`Rows per page`}
            pageSize={pageSize}
            onPageSize={(size) => {
              setPageSize(size);
              setTrail(emptyTrail);
            }}
            range={rangeOf({
              index: trail.index,
              pageSize,
              shown: items.length,
              total: listed.total,
            })}
            number={trail.index + 1}
            previous={trail.index > 0}
            next={listed.next !== null}
            busy={turning}
            onPrevious={() => {
              setTrail(trailBack);
            }}
            onNext={() => {
              setTrail(trailForward(trail, listed.next));
            }}
          />
        )}
      </section>

      {opened?.kind === 'folder' ? (
        <NameDialog
          key={opened.folder?.id ?? 'new'}
          title={
            opened.folder === undefined ? (
              <Trans>Create folder</Trans>
            ) : (
              <Trans>Rename folder</Trans>
            )
          }
          label={<Trans>Folder name</Trans>}
          initial={opened.folder?.name ?? ''}
          saveLabel={opened.folder === undefined ? <Trans>Create</Trans> : <Trans>Save</Trans>}
          savingLabel={<Trans>Saving…</Trans>}
          fallback={t`The folder wasn't saved. Check your connection and try again.`}
          returnFocus={returnFocusRef}
          onClose={close}
          save={async (name) => {
            const editing = opened.folder;
            await (editing === undefined
              ? api.request(createSiteFolder, { body: { kind, name } })
              : api.request(updateSiteFolder, {
                  params: { id: editing.id },
                  body: { name, revision: editing.revision },
                }));
            await refresh();
            close(editing === undefined ? t`Folder created.` : t`Folder renamed.`);
          }}
        />
      ) : null}
      {opened?.kind === 'rename' ? (
        <NameDialog
          key={opened.site.id}
          title={funnel ? <Trans>Rename funnel</Trans> : <Trans>Rename website</Trans>}
          label={funnel ? <Trans>Funnel name</Trans> : <Trans>Website name</Trans>}
          initial={opened.site.name}
          saveLabel={<Trans>Save</Trans>}
          savingLabel={<Trans>Saving…</Trans>}
          fallback={t`It wasn't renamed. Check your connection and try again.`}
          returnFocus={returnFocusRef}
          onClose={close}
          save={async (name) => {
            // A row carries no revision: the site is read for the one it is at now.
            const current = await api.request(getSite, { params: { id: opened.site.id } });
            await api.request(updateSite, {
              params: { id: opened.site.id },
              body: { revision: current.revision, name },
            });
            await refresh();
            close(t`Renamed to ${name}.`);
          }}
        />
      ) : null}
      {opened?.kind === 'move' ? (
        <MoveDialog
          key={opened.site.id}
          site={opened.site}
          folders={folderItems}
          returnFocus={returnFocusRef}
          onClose={close}
          onMoved={async () => {
            await refresh();
            close(words.moved(opened.site.name));
          }}
        />
      ) : null}
      <ConfirmDialog
        open={opened?.kind === 'delete'}
        title={funnel ? <Trans>Delete funnel</Trans> : <Trans>Delete website</Trans>}
        description={
          opened?.kind !== 'delete' ? null : funnel ? (
            <Trans>
              {openedName} will be deleted for good, with all its steps, pages, settings and
              statistics. This can't be undone.
            </Trans>
          ) : (
            <Trans>
              {openedName} will be deleted for good, with all its pages, settings and statistics.
              This can't be undone.
            </Trans>
          )
        }
        confirmLabel={t`Delete for good`}
        destructive
        busy={removeSite.isPending}
        problem={problem}
        returnFocus={returnFocusRef}
        onClose={close}
        onConfirm={() => {
          if (opened?.kind === 'delete') removeSite.mutate(opened.site);
        }}
      />
      <ConfirmDialog
        open={opened?.kind === 'delete-folder'}
        title={<Trans>Delete folder</Trans>}
        description={
          opened?.kind !== 'delete-folder' ? null : funnel ? (
            <Trans>
              The folder {openedName} will be deleted. Its funnels are kept and move to Home.
            </Trans>
          ) : (
            <Trans>
              The folder {openedName} will be deleted. Its websites are kept and move to Home.
            </Trans>
          )
        }
        confirmLabel={t`Delete folder`}
        destructive
        busy={removeFolder.isPending}
        problem={problem}
        returnFocus={returnFocusRef}
        onClose={close}
        onConfirm={() => {
          if (opened?.kind === 'delete-folder') removeFolder.mutate(opened.folder);
        }}
      />
      {opened?.kind === 'create' || opened?.kind === 'import' ? (
        <Suspense fallback={null}>
          {opened.kind === 'create' ? (
            <SiteCreateDialog
              kind={kind}
              folderId={folderId}
              returnFocus={returnFocusRef}
              onClose={close}
              onCreated={(site) => {
                void refresh();
                go(siteSplat(site.kind, site.id));
              }}
            />
          ) : (
            <SiteImportDialog
              folderId={folderId}
              returnFocus={returnFocusRef}
              onClose={close}
              onCreated={(site) => {
                void refresh();
                go(siteSplat(site.kind, site.id));
              }}
            />
          )}
        </Suspense>
      ) : null}
    </Page>
  );
}
