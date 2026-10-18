// Settings → Custom Fields (laid out as GoHighLevel's): the fields of every object, a page
// at a time from the server, filtered and searched there, each with its folder and its
// merge key; and the folders they are grouped in. A field is created and edited in a panel
// at the right (custom-field-panel.tsx), which is fetched when it is first opened. A field
// is archived, never deleted: its values stay.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  createFieldFolder,
  deleteFieldFolder,
  listCustomFields,
  listFieldFolders,
  mergeToken,
  moveFieldsToFolder,
  renameFieldFolder,
  updateField,
  type CustomField,
  type FieldFolder,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  FolderInput,
  Lock,
  Pencil,
  Plus,
} from 'lucide-react';
import { lazy, Suspense, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  fieldKinds,
  fieldSources,
  kindOf,
  typeOfKind,
  useFieldSourceNames,
  useFieldTypeNames,
} from './custom-field-words';
import { ListSearch } from './list-toolbar';
import { noRejection, type Rejection } from './problems';
import {
  cellClassName,
  ConfirmDialog,
  FolderChip,
  FormProblem,
  headerCellClassName,
  iconButtonClassName,
  isStale,
  listCardClassName,
  ListFooter,
  ListProblem,
  MergeToken,
  retryFaults,
  RowMenu,
  savingProblem,
  SmallDialog,
  sortButtonClassName,
  tableClassName,
  tableRegionClassName,
  useSettled,
  ViewSwitch,
} from './settings-list';
import {
  createdPresets,
  createdSince,
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type CreatedPreset,
  type PageSize,
} from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const FieldPanel = lazy(() => import('./custom-field-panel'));

const ALL = 'all';
const archivedChoices = ['exclude', 'only', 'include'] as const;

type Opened =
  | { readonly kind: 'panel'; readonly field: CustomField | undefined }
  | { readonly kind: 'folder'; readonly folder: FieldFolder | undefined }
  | { readonly kind: 'move'; readonly field: CustomField }
  | { readonly kind: 'archive'; readonly field: CustomField }
  | { readonly kind: 'delete-folder'; readonly folder: FieldFolder };

export const customFieldsKey = (businessId: string) => ['b', businessId, 'custom-fields'] as const;
export const fieldFoldersKey = (businessId: string) => ['b', businessId, 'field-folders'] as const;

const filterClassName = 'w-auto max-w-full min-w-40';

export function CustomFieldsPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const typeNames = useFieldTypeNames();
  const sourceNames = useFieldSourceNames();
  const [objectKey, setObjectKey] = useState(ALL);
  const [view, setView] = useState<'fields' | 'folders'>('fields');
  const [valueType, setValueType] = useState<string>(ALL);
  const [created, setCreated] = useState<CreatedPreset>('any');
  const [source, setSource] = useState<string>(ALL);
  const [archived, setArchived] = useState<(typeof archivedChoices)[number]>('exclude');
  const [newestFirst, setNewestFirst] = useState(true);
  const [search, setSearch] = useState('');
  const q = useSettled(search).trim();
  const [folderSearch, setFolderSearch] = useState('');
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const [opened, setOpened] = useState<Opened>();
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // "The last 7 days" is counted from when the page was opened, so paging asks one question.
  const [now] = useState(() => new Date());

  const after = trailCursor(trail);
  const createdFrom = createdSince(created, now);
  const chosenKind = fieldKinds.find((each) => each === valueType);
  // Radio select and Checkbox are choices shown their own way; a dropdown is shown as one.
  const type = chosenKind === undefined ? undefined : typeOfKind(chosenKind);
  const actor = fieldSources.find((each) => each === source);
  const filters = { objectKey, type, createdFrom, actor, archived, newestFirst, q };
  const fields = useQuery({
    queryKey: [...customFieldsKey(business.id), { ...filters, pageSize, after }],
    queryFn: () =>
      api.request(listCustomFields, {
        query: {
          archived,
          sort: newestFirst ? 'created_desc' : 'created_asc',
          limit: pageSize,
          ...(objectKey === ALL ? {} : { objectKey }),
          ...(type === undefined
            ? {}
            : {
                valueType: type.valueType,
                ...(type.display !== undefined
                  ? { display: type.display }
                  : type.valueType === 'single_choice' || type.valueType === 'multi_choice'
                    ? { display: 'dropdown' as const }
                    : {}),
              }),
          ...(actor === undefined ? {} : { source: actor }),
          ...(createdFrom === undefined ? {} : { createdFrom }),
          ...(q === '' ? {} : { q }),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const folders = useQuery({
    queryKey: fieldFoldersKey(business.id),
    queryFn: () => api.request(listFieldFolders, { query: {} }),
    retry: retryFaults,
  });
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: customFieldsKey(business.id) }),
      cache.invalidateQueries({ queryKey: fieldFoldersKey(business.id) }),
      // What the record pages and the lists read the fields from.
      cache.invalidateQueries({ queryKey: ['b', business.id, 'fields'] }),
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
  const again = () => {
    setTrail(emptyTrail);
  };

  const confirm = useMutation({
    mutationFn: async (target: Opened) => {
      if (target.kind === 'archive') {
        const { field } = target;
        await api.request(updateField, {
          params: { fieldId: field.id },
          body: {
            label: field.label,
            description: field.description,
            options: field.options,
            aiFillSources: field.aiFillSources,
            aiOverwrite: field.aiOverwrite,
            archived: !field.archived,
            revision: field.revision,
          },
        });
      } else if (target.kind === 'delete-folder')
        await api.request(deleteFieldFolder, { params: { folderId: target.folder.id } });
      return target;
    },
    onSuccess: async (target) => {
      // The last row of a page left the list: show the page before it.
      if (target.kind === 'archive' && archived !== 'include' && fields.data?.items.length === 1)
        setTrail(trailBack);
      await refresh();
      close(
        target.kind === 'delete-folder'
          ? t`Folder deleted.`
          : target.kind === 'archive' && target.field.archived
            ? t`Field restored.`
            : t`Field archived.`,
      );
    },
    onError: async (error) => {
      // Someone else saved it first: the list shows their version, to act on again.
      if (isStale(error)) await refresh();
    },
  });

  const canManage = fields.data?.canManage === true;
  const date = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const objects = fields.data?.objects ?? [];
  const objectLabel = (key: string): string =>
    objects.find((each) => each.key === key)?.label ?? key;
  const shownObjects = objects.filter((each) => objectKey === ALL || each.key === objectKey);
  const fieldCount = shownObjects.reduce((sum, each) => sum + each.fields, 0);
  const folderCount = shownObjects.reduce((sum, each) => sum + each.folders, 0);
  const allCount = objects.reduce((sum, each) => sum + each.fields, 0);
  const items = fields.data?.items ?? [];
  const range = rangeOf({
    index: trail.index,
    pageSize,
    shown: items.length,
    total: fields.data?.total ?? 0,
  });
  const filtered =
    q !== '' ||
    type !== undefined ||
    actor !== undefined ||
    created !== 'any' ||
    archived !== 'exclude';
  const folderItems = (folders.data?.items ?? []).filter(
    (each) =>
      (objectKey === ALL || each.objectKey === objectKey) &&
      each.name
        .toLocaleLowerCase(i18n.locale)
        .includes(folderSearch.trim().toLocaleLowerCase(i18n.locale)),
  );
  const createdNames: Readonly<Record<CreatedPreset, string>> = {
    any: t`Created: any time`,
    '7': t`Created: last 7 days`,
    '30': t`Created: last 30 days`,
    '90': t`Created: last 90 days`,
  };
  const archivedNames: Readonly<Record<(typeof archivedChoices)[number], string>> = {
    exclude: t`Status: active`,
    only: t`Status: archived`,
    include: t`Status: all`,
  };
  const confirming = opened?.kind === 'archive' || opened?.kind === 'delete-folder';
  const editLabel = (name: string) => t`Edit ${name}`;
  const moveLabel = (name: string) => t`Move ${name} to a folder`;
  const archiveLabel = (name: string) => t`Archive ${name}`;
  const restoreLabel = (name: string) => t`Restore ${name}`;
  const actionsFor = (name: string) => t`Actions for ${name}`;
  const confirmingName =
    opened?.kind === 'archive'
      ? opened.field.label
      : opened?.kind === 'delete-folder'
        ? opened.folder.name
        : '';

  return (
    <Page title={t`Custom Fields`}>
      <p className="text-md text-muted-foreground">
        <Trans>
          Create and manage custom fields for your objects to capture and organize data. Describe
          each one so the assistant knows what belongs there.
        </Trans>
      </p>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {fields.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading fields…</Trans>
        </p>
      ) : null}
      {fields.isError ? (
        <ListProblem
          onRetry={() => {
            void fields.refetch();
          }}
        >
          <Trans>The fields couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {fields.data === undefined ? null : (
        <>
          {canManage ? null : (
            <p className="text-md text-muted-foreground">
              <Trans>Owners and admins manage fields. Everyone on the team can read them.</Trans>
            </p>
          )}
          <div
            role="group"
            aria-label={t`Object`}
            className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]"
          >
            {[{ key: ALL, label: t`All`, fields: allCount }, ...objects].map((each) => (
              <button
                key={each.key}
                type="button"
                aria-pressed={objectKey === each.key}
                className="flex min-h-16 min-w-0 flex-col items-start justify-center gap-0.5 rounded-card border border-border bg-card px-4 py-2.5 text-left hover:border-input aria-pressed:border-primary aria-pressed:bg-accent"
                onClick={() => {
                  setObjectKey(each.key);
                  again();
                }}
              >
                <span className="max-w-full truncate text-sm font-medium text-foreground">
                  {each.label}
                </span>
                <span className="text-xs text-body">
                  <Plural value={each.fields} one="# field" other="# fields" />
                </span>
              </button>
            ))}
          </div>
          <section aria-label={t`Fields and folders`} className={listCardClassName}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ViewSwitch
                label={t`Fields or folders`}
                value={view}
                onChange={setView}
                views={[
                  { value: 'fields', label: <Trans>Fields {fieldCount}</Trans> },
                  { value: 'folders', label: <Trans>Folders {folderCount}</Trans> },
                ]}
              />
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={(event) => {
                      open({ kind: 'folder', folder: undefined }, event.currentTarget);
                    }}
                  >
                    <Trans>Create folder</Trans>
                  </Button>
                  <Button
                    onClick={(event) => {
                      open({ kind: 'panel', field: undefined }, event.currentTarget);
                    }}
                  >
                    <Plus aria-hidden className="size-4" strokeWidth={2} />
                    <Trans>Create field</Trans>
                  </Button>
                </div>
              ) : null}
            </div>
            {view === 'fields' ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Select
                      aria-label={t`Field type`}
                      className={filterClassName}
                      value={valueType}
                      onValueChange={(next) => {
                        setValueType(next);
                        again();
                      }}
                    >
                      <option value={ALL}>{t`Field type: all`}</option>
                      {fieldKinds.map((each) => (
                        <option key={each} value={each}>
                          {typeNames[each]}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label={t`Created`}
                      className={filterClassName}
                      value={created}
                      onValueChange={(next) => {
                        setCreated(createdPresets.find((each) => each === next) ?? 'any');
                        again();
                      }}
                    >
                      {createdPresets.map((each) => (
                        <option key={each} value={each}>
                          {createdNames[each]}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label={t`Source`}
                      className={filterClassName}
                      value={source}
                      onValueChange={(next) => {
                        setSource(next);
                        again();
                      }}
                    >
                      <option value={ALL}>{t`Source: all`}</option>
                      {fieldSources.map((each) => (
                        <option key={each} value={each}>
                          {sourceNames[each]}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label={t`Status`}
                      className={filterClassName}
                      value={archived}
                      onValueChange={(next) => {
                        setArchived(archivedChoices.find((each) => each === next) ?? 'exclude');
                        again();
                      }}
                    >
                      {archivedChoices.map((each) => (
                        <option key={each} value={each}>
                          {archivedNames[each]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <ListSearch
                    label={t`Search fields`}
                    value={search}
                    onChange={(next) => {
                      setSearch(next);
                      again();
                    }}
                  />
                </div>
                {items.length === 0 ? (
                  <p className="py-6 text-center text-md text-muted-foreground">
                    {filtered ? (
                      <Trans>No fields match.</Trans>
                    ) : (
                      <Trans>No fields yet. Add a field for the facts your team needs.</Trans>
                    )}
                  </p>
                ) : (
                  <div role="region" aria-label={t`Fields table`} className={tableRegionClassName}>
                    <table className={`${tableClassName} min-w-[980px] table-fixed`}>
                      <caption className="sr-only">
                        <Trans>Fields</Trans>
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className={`${headerCellClassName} w-[26%]`}>
                            <Trans>Field name</Trans>
                          </th>
                          <th scope="col" className={`${headerCellClassName} w-[14%]`}>
                            <Trans>Field type</Trans>
                          </th>
                          <th scope="col" className={`${headerCellClassName} w-[15%]`}>
                            <Trans>Folder name</Trans>
                          </th>
                          <th scope="col" className={headerCellClassName}>
                            <Trans>Key</Trans>
                          </th>
                          <th
                            scope="col"
                            aria-sort={newestFirst ? 'descending' : 'ascending'}
                            className={`${headerCellClassName} w-32`}
                          >
                            <button
                              type="button"
                              className={sortButtonClassName}
                              title={
                                newestFirst
                                  ? t`Sort by created, oldest first`
                                  : t`Sort by created, newest first`
                              }
                              onClick={() => {
                                setNewestFirst(!newestFirst);
                                again();
                              }}
                            >
                              <Trans>Created</Trans>
                              {newestFirst ? (
                                <ArrowDown aria-hidden className="size-3.5" strokeWidth={2} />
                              ) : (
                                <ArrowUp aria-hidden className="size-3.5" strokeWidth={2} />
                              )}
                            </button>
                          </th>
                          {canManage ? (
                            <th scope="col" className={`${headerCellClassName} w-36`}>
                              <Trans>Actions</Trans>
                            </th>
                          ) : null}
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((field) => (
                          <tr key={field.id} className="hover:bg-muted">
                            <th scope="row" className={`${cellClassName} text-left font-normal`}>
                              <span className="flex min-w-0 flex-col">
                                <span className="flex min-w-0 items-center gap-2">
                                  <span className="truncate font-medium text-foreground">
                                    {field.label}
                                  </span>
                                  {field.archived ? (
                                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                                      <Trans>Archived</Trans>
                                    </span>
                                  ) : null}
                                </span>
                                <span
                                  className="truncate text-xs text-body"
                                  title={field.description}
                                >
                                  {objectKey === ALL ? `${objectLabel(field.objectKey)} · ` : null}
                                  {field.description}
                                </span>
                              </span>
                            </th>
                            <td className={`${cellClassName} truncate`}>
                              {typeNames[kindOf(field)]}
                            </td>
                            <td className={cellClassName}>
                              <FolderChip name={field.folderName} />
                            </td>
                            <td className={cellClassName}>
                              {field.mergeKey === null ? (
                                <code className="font-mono text-xs">{field.key}</code>
                              ) : (
                                <MergeToken
                                  token={mergeToken(field.mergeKey)}
                                  onCopied={(token) => {
                                    setNotice(t`Copied ${token}`);
                                  }}
                                />
                              )}
                            </td>
                            <td className={`${cellClassName} whitespace-nowrap`}>
                              {date.format(new Date(field.createdAt))}
                            </td>
                            {canManage ? (
                              <td className={cellClassName}>
                                <span className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    className={iconButtonClassName}
                                    aria-label={editLabel(field.label)}
                                    title={t`Edit`}
                                    onClick={(event) => {
                                      open({ kind: 'panel', field }, event.currentTarget);
                                    }}
                                  >
                                    <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                                  </button>
                                  <button
                                    type="button"
                                    className={iconButtonClassName}
                                    aria-label={moveLabel(field.label)}
                                    title={t`Move to folder`}
                                    onClick={(event) => {
                                      open({ kind: 'move', field }, event.currentTarget);
                                    }}
                                  >
                                    <FolderInput aria-hidden className="size-4" strokeWidth={1.8} />
                                  </button>
                                  <button
                                    type="button"
                                    className={iconButtonClassName}
                                    aria-label={
                                      field.archived
                                        ? restoreLabel(field.label)
                                        : archiveLabel(field.label)
                                    }
                                    title={field.archived ? t`Restore` : t`Archive`}
                                    onClick={(event) => {
                                      confirm.reset();
                                      open({ kind: 'archive', field }, event.currentTarget);
                                    }}
                                  >
                                    {field.archived ? (
                                      <ArchiveRestore
                                        aria-hidden
                                        className="size-4"
                                        strokeWidth={1.8}
                                      />
                                    ) : (
                                      <Archive aria-hidden className="size-4" strokeWidth={1.8} />
                                    )}
                                  </button>
                                </span>
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <ListFooter
                  perPageLabel={t`Fields per page`}
                  pageSize={pageSize}
                  onPageSize={(size) => {
                    setPageSize(size);
                    again();
                  }}
                  range={range}
                  number={trail.index + 1}
                  previous={trail.index > 0}
                  next={fields.data.next !== null}
                  busy={fields.isFetching && fields.isPlaceholderData}
                  onPrevious={() => {
                    setTrail(trailBack);
                  }}
                  onNext={() => {
                    setTrail(trailForward(trail, fields.data.next));
                  }}
                />
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <ListSearch
                    label={t`Search folders`}
                    value={folderSearch}
                    onChange={setFolderSearch}
                  />
                </div>
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
                    <Trans>No folders match.</Trans>
                  </p>
                ) : null}
                {folderItems.length === 0 ? null : (
                  <div role="region" aria-label={t`Folders table`} className={tableRegionClassName}>
                    <table className={tableClassName}>
                      <caption className="sr-only">
                        <Trans>Field folders</Trans>
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className={headerCellClassName}>
                            <Trans>Folder name</Trans>
                          </th>
                          <th scope="col" className={headerCellClassName}>
                            <Trans>Object</Trans>
                          </th>
                          <th scope="col" className={headerCellClassName}>
                            <Trans>Number of fields</Trans>
                          </th>
                          <th scope="col" className={`${headerCellClassName} max-sm:hidden`}>
                            <Trans>Created</Trans>
                          </th>
                          <th scope="col" className={headerCellClassName}>
                            <Trans>Actions</Trans>
                          </th>
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
                            <td className={cellClassName}>{objectLabel(each.objectKey)}</td>
                            <td className={cellClassName}>{each.fieldCount}</td>
                            <td className={`${cellClassName} whitespace-nowrap max-sm:hidden`}>
                              {date.format(new Date(each.createdAt))}
                            </td>
                            <td className={cellClassName}>
                              {each.system ? (
                                <span
                                  className="inline-flex items-center gap-1.5 text-xs text-body"
                                  title={t`This folder comes with the object. It can't be renamed or deleted.`}
                                >
                                  <Lock aria-hidden className="size-3.5" strokeWidth={1.8} />
                                  <Trans>System folder</Trans>
                                </span>
                              ) : canManage ? (
                                <RowMenu
                                  label={actionsFor(each.name)}
                                  onOpen={(trigger) => {
                                    returnFocusRef.current = trigger;
                                  }}
                                  actions={[
                                    {
                                      label: t`Rename`,
                                      onSelect: () => {
                                        open(
                                          { kind: 'folder', folder: each },
                                          returnFocusRef.current,
                                        );
                                      },
                                    },
                                    {
                                      label: t`Delete`,
                                      destructive: true,
                                      onSelect: () => {
                                        confirm.reset();
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
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}

      {opened?.kind === 'panel' ? (
        <Suspense fallback={null}>
          <FieldPanel
            key={opened.field === undefined ? 'new' : `${opened.field.id}:${opened.field.revision}`}
            field={opened.field}
            objects={objects}
            folders={folders.data?.items ?? []}
            startObject={objectKey === ALL ? undefined : objectKey}
            returnFocus={returnFocusRef}
            onClose={close}
            onSaved={async (created) => {
              await refresh();
              close(created ? t`Field created.` : t`Field saved.`);
            }}
            onReload={(latest) => {
              setOpened({ kind: 'panel', field: latest });
            }}
          />
        </Suspense>
      ) : null}

      <SmallDialog
        open={opened?.kind === 'folder'}
        onClose={close}
        returnFocus={returnFocusRef}
        title={
          opened?.kind === 'folder' && opened.folder !== undefined ? (
            <Trans>Rename folder</Trans>
          ) : (
            <Trans>Create folder</Trans>
          )
        }
      >
        {opened?.kind === 'folder' ? (
          <FolderForm
            key={
              opened.folder === undefined ? 'new' : `${opened.folder.id}:${opened.folder.revision}`
            }
            folder={opened.folder}
            objects={objects}
            startObject={objectKey === ALL ? undefined : objectKey}
            onCancel={close}
            onSaved={async (made) => {
              await refresh();
              close(made ? t`Folder created.` : t`Folder renamed.`);
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
        description={opened?.kind === 'move' ? opened.field.label : undefined}
      >
        {opened?.kind === 'move' ? (
          <MoveForm
            field={opened.field}
            folders={(folders.data?.items ?? []).filter(
              (each) => each.objectKey === opened.field.objectKey,
            )}
            onCancel={close}
            onMoved={async () => {
              await refresh();
              close(t`Field moved.`);
            }}
          />
        ) : null}
      </SmallDialog>

      <ConfirmDialog
        open={confirming}
        returnFocus={returnFocusRef}
        title={
          opened?.kind === 'delete-folder' ? (
            <Trans>Delete the folder {confirmingName}?</Trans>
          ) : opened?.kind === 'archive' ? (
            opened.field.archived ? (
              <Trans>Restore {confirmingName}?</Trans>
            ) : (
              <Trans>Archive {confirmingName}?</Trans>
            )
          ) : null
        }
        description={
          opened?.kind === 'delete-folder' ? (
            <Trans>
              Its fields, and their values, move to the object's system folder. Nothing is lost.
            </Trans>
          ) : opened?.kind === 'archive' ? (
            opened.field.archived ? (
              <Trans>The field is listed with the active fields again.</Trans>
            ) : (
              <Trans>
                A field is archived, not deleted: the field and its values are kept, and you can
                restore it from the archived fields.
              </Trans>
            )
          ) : null
        }
        confirmLabel={
          opened?.kind === 'delete-folder'
            ? t`Delete`
            : opened?.kind === 'archive' && opened.field.archived
              ? t`Restore`
              : t`Archive`
        }
        destructive={opened?.kind === 'delete-folder'}
        busy={confirm.isPending}
        problem={
          confirm.isError
            ? confirm.error instanceof ApiError
              ? (confirm.error.problem.detail ?? t`It wasn't saved. Try again.`)
              : t`It wasn't saved. Check your connection and try again.`
            : undefined
        }
        onClose={close}
        onConfirm={() => {
          if (opened !== undefined) confirm.mutate(opened);
        }}
      />
    </Page>
  );
}

function FolderForm({
  folder,
  objects,
  startObject,
  onCancel,
  onSaved,
  onReload,
}: {
  readonly folder: FieldFolder | undefined;
  readonly objects: readonly { readonly key: string; readonly label: string }[];
  readonly startObject: string | undefined;
  readonly onCancel: () => void;
  readonly onSaved: (created: boolean) => Promise<void>;
  readonly onReload: (latest: FieldFolder) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [name, setName] = useState(folder?.name ?? '');
  const [objectKey, setObjectKey] = useState(
    folder?.objectKey ?? startObject ?? objects[0]?.key ?? 'contact',
  );
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const save = useMutation({
    mutationFn: () =>
      folder === undefined
        ? api.request(createFieldFolder, { body: { objectKey, name } })
        : api.request(renameFieldFolder, {
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
      const latest = (await api.request(listFieldFolders, { query: {} })).items.find(
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
      {folder === undefined ? (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <Trans>Add to object</Trans>
          <Select aria-label={t`Add to object`} value={objectKey} onValueChange={setObjectKey}>
            {objects.map((each) => (
              <option key={each.key} value={each.key}>
                {each.label}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
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
  field,
  folders,
  onCancel,
  onMoved,
}: {
  readonly field: CustomField;
  /** The folders of the field's own object. */
  readonly folders: readonly FieldFolder[];
  readonly onCancel: () => void;
  readonly onMoved: () => Promise<void>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [folderId, setFolderId] = useState<string>(field.folderId);
  const target = folders.find((each) => each.id === folderId);
  const move = useMutation({
    mutationFn: async () => {
      if (target === undefined) throw new Error('No folder chosen.');
      return apiIn(business.id).request(moveFieldsToFolder, {
        params: { folderId: target.id },
        body: { fieldIds: [field.id] },
      });
    },
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
        <Select aria-label={t`Folder`} value={folderId} onValueChange={setFolderId}>
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
          disabled={move.isPending || target === undefined || target.id === field.folderId}
        >
          <Trans>Move</Trans>
        </Button>
      </div>
    </Form>
  );
}
