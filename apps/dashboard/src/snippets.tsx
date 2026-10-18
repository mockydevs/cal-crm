// Marketing → Snippets (laid out as GoHighLevel's): text a person keeps to put into a
// message. The list is the server's, a page at a time, searched and filtered there. Reading
// is open to the business; changing anything needs the permission to manage templates,
// which the server says with canManage. Rows are ticked to move or delete several at once:
// the ones ticked on the page showing.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createSnippetFolder,
  deleteSnippet,
  deleteSnippetFolder,
  listSnippetFolders,
  listSnippets,
  moveSnippets,
  renameSnippetFolder,
  snippetTypes,
  type SnippetFolder,
  type SnippetSummary,
  type SnippetType,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { RightPanel } from './conversation-extras-panel';
import { ListSearch } from './list-toolbar';
import { noRejection, type Rejection } from './problems';
import {
  cellClassName,
  ConfirmDialog,
  FolderChip,
  FormProblem,
  headerCellClassName,
  isStale,
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
import { Page } from './shell/page';
import { NO_FOLDER, SnippetPanel, type SnippetPanelFor } from './snippet-panel';
import { mergePieces } from './snippet-picker-rules';
import { useBusiness } from './workspace';

const ANY_FOLDER = 'any';
const ANY_TYPE = 'any';

type Opened =
  | { readonly kind: 'snippet'; readonly panel: SnippetPanelFor }
  | { readonly kind: 'folder'; readonly folder: SnippetFolder | undefined }
  | { readonly kind: 'move'; readonly snippets: readonly SnippetSummary[] }
  | { readonly kind: 'delete-snippets'; readonly snippets: readonly SnippetSummary[] }
  | { readonly kind: 'delete-folder'; readonly folder: SnippetFolder };

const snippetsKey = (businessId: string) => ['b', businessId, 'snippets'] as const;
const foldersKey = (businessId: string) => ['b', businessId, 'snippet-folders'] as const;

const checkboxClassName = 'size-4 shrink-0 accent-primary';
// Room for a finger around the box, which is small.
const tickClassName = 'flex size-11 items-center justify-center lg:size-8';
/** Whether the server said the snippet is not there, which for a delete is what was asked. */
const alreadyGone = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

export function SnippetsPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const [view, setView] = useState<'snippets' | 'folders'>('snippets');
  const [search, setSearch] = useState('');
  const q = useSettled(search).trim();
  const [folder, setFolder] = useState(ANY_FOLDER);
  const [type, setType] = useState<SnippetType | typeof ANY_TYPE>(ANY_TYPE);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const [opened, setOpened] = useState<Opened>();
  const [notice, setNotice] = useState('');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const after = trailCursor(trail);
  const snippets = useQuery({
    queryKey: [...snippetsKey(business.id), { q, folder, type, pageSize, after }],
    queryFn: () =>
      api.request(listSnippets, {
        query: {
          limit: pageSize,
          ...(q === '' ? {} : { q }),
          ...(type === ANY_TYPE ? {} : { type }),
          ...(folder === ANY_FOLDER ? {} : { folder }),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const folders = useQuery({
    queryKey: foldersKey(business.id),
    queryFn: () => api.request(listSnippetFolders, {}),
    retry: retryFaults,
  });
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: snippetsKey(business.id) }),
      cache.invalidateQueries({ queryKey: foldersKey(business.id) }),
    ]);
  };
  const close = (message = '') => {
    setOpened(undefined);
    setNotice(message);
  };
  const open = (next: Opened, trigger: HTMLElement | null) => {
    returnFocusRef.current = trigger;
    setOpened(next);
    setNotice('');
  };

  const remove = useMutation({
    mutationFn: async (target: Opened) => {
      if (target.kind === 'delete-snippets')
        // One at a time: the API deletes one. A snippet someone else deleted meanwhile is
        // gone, which is what was asked, so trying again after a failure picks up where it
        // stopped.
        for (const each of target.snippets)
          await api
            .request(deleteSnippet, { params: { snippetId: each.id } })
            .catch((error: unknown) => {
              if (!alreadyGone(error)) throw error;
            });
      else if (target.kind === 'delete-folder')
        await api.request(deleteSnippetFolder, { params: { folderId: target.folder.id } });
      return target;
    },
    onSuccess: async (target) => {
      // Every row of a page is gone: show the page before it.
      if (
        target.kind === 'delete-snippets' &&
        target.snippets.length >= (snippets.data?.items.length ?? 0)
      )
        setTrail(trailBack);
      await refresh();
      // A filter on a folder that is gone would show nothing, for no reason anyone can see.
      if (target.kind === 'delete-folder' && folder === target.folder.id) setFolder(ANY_FOLDER);
      if (target.kind === 'delete-snippets') setTicked(new Set());
      const deleted = target.kind === 'delete-snippets' ? target.snippets.length : 0;
      close(
        target.kind === 'delete-folder'
          ? t`Folder deleted.`
          : deleted === 1
            ? t`Snippet deleted.`
            : plural(deleted, { one: '# snippet deleted.', other: '# snippets deleted.' }),
      );
    },
    // Some of several may be gone already: the list says which are left.
    onError: () => refresh(),
  });

  const canManage = snippets.data?.canManage === true;
  const day = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const folderItems = folders.data?.items ?? [];
  const items = snippets.data?.items ?? [];
  const total = snippets.data?.total ?? 0;
  const range = rangeOf({ index: trail.index, pageSize, shown: items.length, total });
  const filtered = q !== '' || folder !== ANY_FOLDER || type !== ANY_TYPE;
  // What is ticked is what is ticked on the page showing: a row on another page, or one
  // a search has hidden, is not acted on.
  const chosen = items.filter((each) => ticked.has(each.id));
  const someTicked = chosen.length > 0 && chosen.length < items.length;
  useEffect(() => {
    if (selectAllRef.current !== null) selectAllRef.current.indeterminate = someTicked;
  }, [someTicked]);
  const removing = opened?.kind === 'delete-snippets' || opened?.kind === 'delete-folder';
  const removingCount = opened?.kind === 'delete-snippets' ? opened.snippets.length : 0;
  const movingCount = opened?.kind === 'move' ? opened.snippets.length : 0;
  const actionsFor = (name: string) => t`Actions for ${name}`;
  const selectLabel = (name: string) => t`Select ${name}`;
  const typeNames: Record<SnippetType, string> = { text: t`Text`, email: t`Email` };
  const removingName =
    opened?.kind === 'delete-snippets'
      ? (opened.snippets[0]?.name ?? '')
      : opened?.kind === 'delete-folder'
        ? opened.folder.name
        : '';
  const panel = opened?.kind === 'snippet' ? opened.panel : undefined;

  return (
    <Page
      title={t`Snippets`}
      actions={
        canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={(event) => {
                open({ kind: 'folder', folder: undefined }, event.currentTarget);
              }}
            >
              <Trans>New folder</Trans>
            </Button>
            <Button
              onClick={(event) => {
                open({ kind: 'snippet', panel: { mode: 'new' } }, event.currentTarget);
              }}
            >
              <Plus aria-hidden className="size-4" strokeWidth={2} />
              <Trans>New snippet</Trans>
            </Button>
          </div>
        ) : undefined
      }
    >
      <p className="text-md text-muted-foreground">
        <Trans>
          Write a message once and keep it as a snippet, so the same answer reads the same every
          time.
        </Trans>
      </p>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {snippets.data !== undefined && !canManage ? (
        <p className="text-md text-muted-foreground">
          <Trans>You can read snippets. Changing them needs permission to manage templates.</Trans>
        </p>
      ) : null}
      <div>
        <ViewSwitch
          label={t`Snippets or folders`}
          value={view}
          onChange={setView}
          views={[
            { value: 'snippets', label: t`All snippets` },
            { value: 'folders', label: t`Folders` },
          ]}
        />
      </div>
      {view === 'snippets' ? (
        <section aria-label={t`All snippets`} className={listCardClassName}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Select
                aria-label={t`Type`}
                className="w-auto max-w-full min-w-32"
                value={type}
                onValueChange={(next) => {
                  setType(snippetTypes.find((each) => each === next) ?? ANY_TYPE);
                  setTrail(emptyTrail);
                }}
              >
                <option value={ANY_TYPE}>{t`All types`}</option>
                {snippetTypes.map((each) => (
                  <option key={each} value={each}>
                    {typeNames[each]}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={t`Folder`}
                className="w-auto max-w-full min-w-40"
                value={folder}
                onValueChange={(next) => {
                  setFolder(next);
                  setTrail(emptyTrail);
                }}
              >
                <option value={ANY_FOLDER}>{t`All folders`}</option>
                <option value={NO_FOLDER}>{t`No folder`}</option>
                {folderItems.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </Select>
            </div>
            <ListSearch
              label={t`Search snippets`}
              value={search}
              onChange={(next) => {
                setSearch(next);
                setTrail(emptyTrail);
              }}
            />
          </div>
          {snippets.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading snippets…</Trans>
            </p>
          ) : null}
          {snippets.isError ? (
            <ListProblem
              onRetry={() => {
                void snippets.refetch();
              }}
            >
              <Trans>The snippets couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {snippets.data !== undefined && items.length === 0 ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              {filtered ? (
                <Trans>No snippets match.</Trans>
              ) : (
                <Trans>No snippets yet. Add one to keep a message you write often.</Trans>
              )}
            </p>
          ) : null}
          {chosen.length === 0 ? null : (
            <div
              role="group"
              aria-label={t`Selected snippets`}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-control bg-muted px-3 py-2"
            >
              <p className="text-sm font-medium">
                {plural(chosen.length, { one: '# selected', other: '# selected' })}
              </p>
              <Button
                size="small"
                variant="secondary"
                onClick={(event) => {
                  open({ kind: 'move', snippets: chosen }, event.currentTarget);
                }}
              >
                <Trans>Move to folder</Trans>
              </Button>
              <Button
                size="small"
                variant="secondary"
                className="text-destructive"
                onClick={(event) => {
                  remove.reset();
                  open({ kind: 'delete-snippets', snippets: chosen }, event.currentTarget);
                }}
              >
                <Trans>Delete</Trans>
              </Button>
              <Button
                size="small"
                variant="quiet"
                onClick={() => {
                  setTicked(new Set());
                }}
              >
                <Trans>Clear selection</Trans>
              </Button>
            </div>
          )}
          {items.length === 0 ? null : (
            <div role="region" aria-label={t`Snippets table`} className={tableRegionClassName}>
              <table className={`${tableClassName} min-w-[940px] table-fixed`}>
                <caption className="sr-only">
                  <Trans>Snippets</Trans>
                </caption>
                <thead>
                  <tr>
                    {canManage ? (
                      <th scope="col" className={`${headerCellClassName} w-[68px] lg:w-14`}>
                        <label className={tickClassName}>
                          <input
                            ref={selectAllRef}
                            type="checkbox"
                            aria-label={t`Select every snippet on this page`}
                            className={checkboxClassName}
                            checked={chosen.length === items.length}
                            onChange={(event) => {
                              setTicked(
                                event.target.checked
                                  ? new Set(items.map((each) => each.id))
                                  : new Set(),
                              );
                            }}
                          />
                        </label>
                      </th>
                    ) : null}
                    <th scope="col" className={`${headerCellClassName} w-[22%]`}>
                      <Trans>Name</Trans>
                    </th>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Body</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[16%]`}>
                      <Trans>Folder</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-20`}>
                      <Trans>Type</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-32`}>
                      <Trans>Date updated</Trans>
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
                  {items.map((snippet) => (
                    <tr key={snippet.id} className="hover:bg-muted">
                      {canManage ? (
                        <td className={cellClassName}>
                          <label className={tickClassName}>
                            <input
                              type="checkbox"
                              aria-label={selectLabel(snippet.name)}
                              className={checkboxClassName}
                              checked={ticked.has(snippet.id)}
                              onChange={(event) => {
                                const next = new Set(chosen.map((each) => each.id));
                                if (event.target.checked) next.add(snippet.id);
                                else next.delete(snippet.id);
                                setTicked(next);
                              }}
                            />
                          </label>
                        </td>
                      ) : null}
                      <th
                        scope="row"
                        className={`${cellClassName} text-left font-medium wrap-anywhere text-foreground`}
                      >
                        {snippet.name}
                      </th>
                      <td className={`${cellClassName} truncate`} title={snippet.bodyPreview}>
                        {snippet.subject === null ? null : (
                          <span className="font-medium text-foreground">{snippet.subject}: </span>
                        )}
                        {mergePieces(snippet.bodyPreview).map((piece) =>
                          piece.field ? (
                            <code
                              key={piece.at}
                              className="rounded-sm bg-muted px-1 font-mono text-xs text-body"
                            >
                              {piece.text}
                            </code>
                          ) : (
                            piece.text
                          ),
                        )}
                      </td>
                      <td className={cellClassName}>
                        {snippet.folderName === null ? null : (
                          <FolderChip name={snippet.folderName} />
                        )}
                      </td>
                      <td className={cellClassName}>{typeNames[snippet.type]}</td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {day.format(new Date(snippet.updatedAt))}
                      </td>
                      {canManage ? (
                        <td className={`${cellClassName} text-right`}>
                          <RowMenu
                            label={actionsFor(snippet.name)}
                            onOpen={(trigger) => {
                              returnFocusRef.current = trigger;
                            }}
                            actions={[
                              {
                                label: t`Edit`,
                                onSelect: () => {
                                  open(
                                    { kind: 'snippet', panel: { mode: 'edit', id: snippet.id } },
                                    returnFocusRef.current,
                                  );
                                },
                              },
                              {
                                label: t`Duplicate`,
                                onSelect: () => {
                                  open(
                                    { kind: 'snippet', panel: { mode: 'copy', id: snippet.id } },
                                    returnFocusRef.current,
                                  );
                                },
                              },
                              {
                                label: t`Move to folder`,
                                onSelect: () => {
                                  open(
                                    { kind: 'move', snippets: [snippet] },
                                    returnFocusRef.current,
                                  );
                                },
                              },
                              {
                                label: t`Delete`,
                                destructive: true,
                                onSelect: () => {
                                  remove.reset();
                                  open(
                                    { kind: 'delete-snippets', snippets: [snippet] },
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
                </tbody>
              </table>
            </div>
          )}
          {snippets.data === undefined ? null : (
            <ListFooter
              perPageLabel={t`Rows per page`}
              pageSize={pageSize}
              onPageSize={(size) => {
                setPageSize(size);
                setTrail(emptyTrail);
              }}
              range={range}
              number={trail.index + 1}
              previous={trail.index > 0}
              next={snippets.data.next !== null}
              busy={snippets.isFetching && snippets.isPlaceholderData}
              onPrevious={() => {
                setTrail(trailBack);
              }}
              onNext={() => {
                setTrail(trailForward(trail, snippets.data.next));
              }}
            />
          )}
        </section>
      ) : (
        <section aria-label={t`Folders`} className={listCardClassName}>
          {folders.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading folders…</Trans>
            </p>
          ) : null}
          {folders.isError ? (
            <ListProblem
              onRetry={() => {
                void folders.refetch();
              }}
            >
              <Trans>The folders couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {folders.data !== undefined && folderItems.length === 0 ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              <Trans>No folders yet. Folders keep related snippets together.</Trans>
            </p>
          ) : null}
          {folderItems.length === 0 ? null : (
            <div role="region" aria-label={t`Folders table`} className={tableRegionClassName}>
              <table className={tableClassName}>
                <caption className="sr-only">
                  <Trans>Snippet folders</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Folder name</Trans>
                    </th>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Number of snippets</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} max-sm:hidden`}>
                      <Trans>Created</Trans>
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
                  {folderItems.map((each) => (
                    <tr key={each.id} className="hover:bg-muted">
                      <th
                        scope="row"
                        className={`${cellClassName} text-left font-medium wrap-anywhere text-foreground`}
                      >
                        {each.name}
                      </th>
                      <td className={cellClassName}>{each.snippetCount}</td>
                      <td className={`${cellClassName} whitespace-nowrap max-sm:hidden`}>
                        {day.format(new Date(each.createdAt))}
                      </td>
                      {canManage ? (
                        <td className={`${cellClassName} text-right`}>
                          <RowMenu
                            label={actionsFor(each.name)}
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
                                  remove.reset();
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
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <RightPanel
        open={panel !== undefined}
        onClose={close}
        returnFocus={returnFocusRef}
        title={
          panel?.mode === 'edit' ? (
            <Trans>Edit snippet</Trans>
          ) : panel?.mode === 'copy' ? (
            <Trans>Duplicate snippet</Trans>
          ) : (
            <Trans>New snippet</Trans>
          )
        }
        description={<Trans>A text or an email you can put into a message.</Trans>}
      >
        {panel === undefined ? null : (
          <SnippetPanel
            key={panel.mode === 'new' ? 'new' : `${panel.mode}:${panel.id}`}
            opened={panel}
            folders={folderItems}
            onCancel={close}
            onSaved={async (created) => {
              await refresh();
              close(created ? t`Snippet created.` : t`Snippet saved.`);
            }}
          />
        )}
      </RightPanel>

      <SmallDialog
        open={opened?.kind === 'folder'}
        onClose={close}
        returnFocus={returnFocusRef}
        title={
          opened?.kind === 'folder' && opened.folder !== undefined ? (
            <Trans>Rename folder</Trans>
          ) : (
            <Trans>New folder</Trans>
          )
        }
      >
        {opened?.kind === 'folder' ? (
          <FolderForm
            key={
              opened.folder === undefined ? 'new' : `${opened.folder.id}:${opened.folder.revision}`
            }
            folder={opened.folder}
            onCancel={close}
            onSaved={async (created) => {
              await refresh();
              close(created ? t`Folder created.` : t`Folder renamed.`);
            }}
            onReload={(latest) => {
              setOpened({ kind: 'folder', folder: latest });
            }}
          />
        ) : null}
      </SmallDialog>

      <SmallDialog
        open={opened?.kind === 'move'}
        onClose={close}
        returnFocus={returnFocusRef}
        title={<Trans>Move to folder</Trans>}
        description={
          opened?.kind !== 'move'
            ? undefined
            : movingCount === 1
              ? opened.snippets[0]?.name
              : plural(movingCount, { one: '# snippet', other: '# snippets' })
        }
      >
        {opened?.kind === 'move' ? (
          <MoveForm
            snippets={opened.snippets}
            folders={folderItems}
            onCancel={close}
            onMoved={async () => {
              // Moved out of the folder the list is filtered to, as the page's last rows.
              if (folder !== ANY_FOLDER && movingCount >= items.length) setTrail(trailBack);
              await refresh();
              setTicked(new Set());
              close(
                movingCount === 1
                  ? t`Snippet moved.`
                  : plural(movingCount, { one: '# snippet moved.', other: '# snippets moved.' }),
              );
            }}
          />
        ) : null}
      </SmallDialog>

      <ConfirmDialog
        open={removing}
        returnFocus={returnFocusRef}
        title={
          opened?.kind === 'delete-folder' ? (
            <Trans>Delete the folder {removingName}?</Trans>
          ) : opened?.kind !== 'delete-snippets' ? null : removingCount === 1 ? (
            <Trans>Delete {removingName}?</Trans>
          ) : (
            plural(removingCount, { one: 'Delete # snippet?', other: 'Delete # snippets?' })
          )
        }
        description={
          opened?.kind === 'delete-folder' ? (
            <Trans>Its snippets are kept, in no folder.</Trans>
          ) : opened?.kind !== 'delete-snippets' ? null : removingCount === 1 ? (
            <Trans>
              The snippet is deleted for good. Messages it was put into keep their text.
            </Trans>
          ) : (
            <Trans>
              The snippets are deleted for good. Messages they were put into keep their text.
            </Trans>
          )
        }
        confirmLabel={t`Delete`}
        destructive
        busy={remove.isPending}
        problem={
          remove.isError
            ? remove.error instanceof ApiError
              ? (remove.error.problem.detail ?? t`It wasn't deleted. Try again.`)
              : t`It wasn't deleted. Check your connection and try again.`
            : undefined
        }
        onClose={close}
        onConfirm={() => {
          if (opened !== undefined) remove.mutate(opened);
        }}
      />
    </Page>
  );
}

function FolderForm({
  folder,
  onCancel,
  onSaved,
  onReload,
}: {
  readonly folder: SnippetFolder | undefined;
  readonly onCancel: () => void;
  readonly onSaved: (created: boolean) => Promise<void>;
  readonly onReload: (latest: SnippetFolder) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [name, setName] = useState(folder?.name ?? '');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const save = useMutation({
    mutationFn: () =>
      folder === undefined
        ? api.request(createSnippetFolder, { body: { name } })
        : api.request(renameSnippetFolder, {
            params: { folderId: folder.id },
            body: { name, revision: folder.revision },
          }),
    onSuccess: () => onSaved(folder === undefined),
    onError: (error) => {
      setProblem(
        savingProblem(error, t`The folder wasn't saved. Check your connection and try again.`),
      );
    },
  });
  const reload = useMutation({
    mutationFn: async () => {
      const latest = (await api.request(listSnippetFolders, {})).items.find(
        (each) => each.id === folder?.id,
      );
      if (latest === undefined) throw new Error('The folder is gone.');
      return latest;
    },
    onSuccess: onReload,
    onError: () => {
      setProblem({
        fields: {},
        form: t`The saved version couldn't be loaded. It may have been deleted.`,
      });
    },
  });
  return (
    <Form<Record<string, unknown>>
      errors={problem.fields}
      onFormSubmit={() => {
        setProblem(noRejection);
        save.mutate();
      }}
    >
      <Field name="name">
        <FieldLabel>
          <Trans>Folder name</Trans>
        </FieldLabel>
        <Input
          required
          maxLength={80}
          autoComplete="off"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <FieldError />
      </Field>
      <FormProblem
        problem={problem}
        stale={isStale(save.error)}
        busy={reload.isPending}
        onReload={() => {
          reload.mutate();
        }}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          disabled={save.isPending}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={save.isPending || name.trim() === ''}>
          {folder === undefined ? t`Create folder` : t`Rename`}
        </Button>
      </div>
    </Form>
  );
}

function MoveForm({
  snippets,
  folders,
  onCancel,
  onMoved,
}: {
  /** The snippets to move: one from its row's menu, or the ones ticked. */
  readonly snippets: readonly SnippetSummary[];
  readonly folders: readonly SnippetFolder[];
  readonly onCancel: () => void;
  readonly onMoved: () => Promise<void>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  // Where they are now, when they are all in one place; else no folder, to choose from.
  const shared = snippets.every((each) => each.folderId === snippets[0]?.folderId)
    ? snippets[0]?.folderId
    : null;
  const [folder, setFolder] = useState(shared ?? NO_FOLDER);
  const folderId = folders.find((each) => each.id === folder)?.id ?? null;
  const move = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(moveSnippets, {
        body: { snippetIds: snippets.map((each) => each.id), folderId },
      }),
    onSuccess: onMoved,
  });
  return (
    <Form<Record<string, unknown>>
      onFormSubmit={() => {
        move.mutate();
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        <Trans>Folder</Trans>
        <Select aria-label={t`Folder`} value={folder} onValueChange={setFolder}>
          <option value={NO_FOLDER}>{t`No folder`}</option>
          {folders.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </Select>
      </label>
      {move.isError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {move.error instanceof ApiError
            ? (move.error.problem.detail ?? t`It wasn't moved. Try again.`)
            : t`It wasn't moved. Check your connection and try again.`}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          disabled={move.isPending}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          type="submit"
          disabled={move.isPending || snippets.every((each) => each.folderId === folderId)}
        >
          <Trans>Move</Trans>
        </Button>
      </div>
    </Form>
  );
}
