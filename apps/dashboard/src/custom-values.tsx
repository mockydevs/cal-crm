// Settings → Custom Values (laid out as GoHighLevel's): text a business writes once and
// uses in many messages as {{custom_values.key}}. The list is the server's, a page at a
// time, searched and filtered there; a value's key is made when it is created and never
// changes. Reading is open to the business; changing anything needs the permission to
// manage templates, which the server says with canManage.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createCustomValue,
  createCustomValueFolder,
  deleteCustomValue,
  deleteCustomValueFolder,
  listCustomValueFolders,
  listCustomValues,
  mergeKeyFromName,
  mergeToken,
  moveCustomValues,
  renameCustomValueFolder,
  updateCustomValue,
  CUSTOM_VALUE_LIMITS,
  type CustomValue,
  type CustomValueFolder,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
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
  MergeToken,
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
import { useBusiness } from './workspace';

/** The Folder choice's value for "no folder": never a folder's id. */
const NO_FOLDER = 'none';
const ANY_FOLDER = 'any';

type Opened =
  | { readonly kind: 'value'; readonly value: CustomValue | undefined }
  | { readonly kind: 'folder'; readonly folder: CustomValueFolder | undefined }
  | { readonly kind: 'move'; readonly value: CustomValue }
  | { readonly kind: 'delete-value'; readonly value: CustomValue }
  | { readonly kind: 'delete-folder'; readonly folder: CustomValueFolder };

const valuesKey = (businessId: string) => ['b', businessId, 'custom-values'] as const;
const foldersKey = (businessId: string) => ['b', businessId, 'custom-value-folders'] as const;

export function CustomValuesPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const [view, setView] = useState<'values' | 'folders'>('values');
  const [search, setSearch] = useState('');
  const q = useSettled(search).trim();
  const [folder, setFolder] = useState(ANY_FOLDER);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const [opened, setOpened] = useState<Opened>();
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const after = trailCursor(trail);
  const values = useQuery({
    queryKey: [...valuesKey(business.id), { q, folder, pageSize, after }],
    queryFn: () =>
      api.request(listCustomValues, {
        query: {
          limit: pageSize,
          ...(q === '' ? {} : { q }),
          ...(folder === ANY_FOLDER ? {} : { folder }),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const folders = useQuery({
    queryKey: foldersKey(business.id),
    queryFn: () => api.request(listCustomValueFolders, { query: {} }),
    retry: retryFaults,
  });
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: valuesKey(business.id) }),
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
      if (target.kind === 'delete-value')
        await api.request(deleteCustomValue, { params: { valueId: target.value.id } });
      else if (target.kind === 'delete-folder')
        await api.request(deleteCustomValueFolder, { params: { folderId: target.folder.id } });
      return target;
    },
    onSuccess: async (target) => {
      // The last row of a page is gone: show the page before it.
      if (target.kind === 'delete-value' && values.data?.items.length === 1) setTrail(trailBack);
      await refresh();
      // A filter on a folder that is gone would show nothing, for no reason anyone can see.
      if (target.kind === 'delete-folder' && folder === target.folder.id) setFolder(ANY_FOLDER);
      close(target.kind === 'delete-folder' ? t`Folder deleted.` : t`Custom value deleted.`);
    },
  });

  const canManage = values.data?.canManage === true;
  const date = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const folderItems = folders.data?.items ?? [];
  const items = values.data?.items ?? [];
  const total = values.data?.total ?? 0;
  const range = rangeOf({ index: trail.index, pageSize, shown: items.length, total });
  const filtered = q !== '' || folder !== ANY_FOLDER;
  const removing = opened?.kind === 'delete-value' || opened?.kind === 'delete-folder';
  const actionsFor = (name: string) => t`Actions for ${name}`;
  const removingName =
    opened?.kind === 'delete-value'
      ? opened.value.name
      : opened?.kind === 'delete-folder'
        ? opened.folder.name
        : '';
  const removingToken = opened?.kind === 'delete-value' ? mergeToken(opened.value.mergeKey) : '';

  return (
    <Page
      title={t`Custom Values`}
      actions={
        canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={(event) => {
                open({ kind: 'folder', folder: undefined }, event.currentTarget);
              }}
            >
              <Trans>Add folder</Trans>
            </Button>
            <Button
              onClick={(event) => {
                open({ kind: 'value', value: undefined }, event.currentTarget);
              }}
            >
              <Plus aria-hidden className="size-4" strokeWidth={2} />
              <Trans>Add custom value</Trans>
            </Button>
          </div>
        ) : undefined
      }
    >
      <p className="text-md text-muted-foreground">
        <Trans>
          Add, edit and delete your custom values: text you write once and use in any message by its
          key.
        </Trans>
      </p>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {values.data !== undefined && !canManage ? (
        <p className="text-md text-muted-foreground">
          <Trans>
            You can read custom values. Changing them needs permission to manage templates.
          </Trans>
        </p>
      ) : null}
      <div>
        <ViewSwitch
          label={t`Custom values or folders`}
          value={view}
          onChange={setView}
          views={[
            { value: 'values', label: t`All values` },
            { value: 'folders', label: t`Folders` },
          ]}
        />
      </div>
      {view === 'values' ? (
        <section aria-label={t`All values`} className={listCardClassName}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select
              aria-label={t`Folder`}
              className="w-auto max-w-full min-w-44"
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
            <ListSearch
              label={t`Search values`}
              value={search}
              onChange={(next) => {
                setSearch(next);
                setTrail(emptyTrail);
              }}
            />
          </div>
          {values.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading custom values…</Trans>
            </p>
          ) : null}
          {values.isError ? (
            <ListProblem
              onRetry={() => {
                void values.refetch();
              }}
            >
              <Trans>The custom values couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {values.data !== undefined && items.length === 0 ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              {filtered ? (
                <Trans>No custom values match.</Trans>
              ) : (
                <Trans>No custom values yet. Add one to use it in your messages.</Trans>
              )}
            </p>
          ) : null}
          {items.length === 0 ? null : (
            <div role="region" aria-label={t`Custom values table`} className={tableRegionClassName}>
              <table className={`${tableClassName} min-w-[860px] table-fixed`}>
                <caption className="sr-only">
                  <Trans>Custom values</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={`${headerCellClassName} w-[22%]`}>
                      <Trans>Name</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[16%]`}>
                      <Trans>Folder</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[30%]`}>
                      <Trans>Key</Trans>
                    </th>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Value</Trans>
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
                  {items.map((value) => (
                    <tr key={value.id} className="hover:bg-muted">
                      <th
                        scope="row"
                        className={`${cellClassName} text-left font-medium wrap-anywhere text-foreground`}
                      >
                        {value.name}
                      </th>
                      <td className={cellClassName}>
                        {value.folderName === null ? null : <FolderChip name={value.folderName} />}
                      </td>
                      <td className={cellClassName}>
                        <MergeToken
                          token={mergeToken(value.mergeKey)}
                          onCopied={(token) => {
                            setNotice(t`Copied ${token}`);
                          }}
                        />
                      </td>
                      <td className={`${cellClassName} truncate`} title={value.value}>
                        {value.value}
                      </td>
                      {canManage ? (
                        <td className={`${cellClassName} text-right`}>
                          <RowMenu
                            label={actionsFor(value.name)}
                            onOpen={(trigger) => {
                              returnFocusRef.current = trigger;
                            }}
                            actions={[
                              {
                                label: t`Edit`,
                                onSelect: () => {
                                  open({ kind: 'value', value }, returnFocusRef.current);
                                },
                              },
                              {
                                label: t`Move to folder`,
                                onSelect: () => {
                                  open({ kind: 'move', value }, returnFocusRef.current);
                                },
                              },
                              {
                                label: t`Delete`,
                                destructive: true,
                                onSelect: () => {
                                  remove.reset();
                                  open({ kind: 'delete-value', value }, returnFocusRef.current);
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
          {values.data === undefined ? null : (
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
              next={values.data.next !== null}
              busy={values.isFetching && values.isPlaceholderData}
              onPrevious={() => {
                setTrail(trailBack);
              }}
              onNext={() => {
                setTrail(trailForward(trail, values.data.next));
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
              <Trans>No folders yet. Folders keep related custom values together.</Trans>
            </p>
          ) : null}
          {folderItems.length === 0 ? null : (
            <div role="region" aria-label={t`Folders table`} className={tableRegionClassName}>
              <table className={tableClassName}>
                <caption className="sr-only">
                  <Trans>Custom value folders</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Folder name</Trans>
                    </th>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Number of values</Trans>
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
                      <td className={cellClassName}>{each.valueCount}</td>
                      <td className={`${cellClassName} whitespace-nowrap max-sm:hidden`}>
                        {date.format(new Date(each.createdAt))}
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

      <SmallDialog
        open={opened?.kind === 'value'}
        onClose={close}
        returnFocus={returnFocusRef}
        title={
          opened?.kind === 'value' && opened.value !== undefined ? (
            <Trans>Edit custom value</Trans>
          ) : (
            <Trans>Add custom value</Trans>
          )
        }
      >
        {opened?.kind === 'value' ? (
          <ValueForm
            key={opened.value === undefined ? 'new' : `${opened.value.id}:${opened.value.revision}`}
            value={opened.value}
            folders={folderItems}
            onCancel={close}
            onSaved={async (created) => {
              await refresh();
              close(created ? t`Custom value created.` : t`Custom value saved.`);
            }}
            onReload={(latest) => {
              setOpened({ kind: 'value', value: latest });
            }}
          />
        ) : null}
      </SmallDialog>

      <SmallDialog
        open={opened?.kind === 'folder'}
        onClose={close}
        returnFocus={returnFocusRef}
        title={
          opened?.kind === 'folder' && opened.folder !== undefined ? (
            <Trans>Rename folder</Trans>
          ) : (
            <Trans>Add folder</Trans>
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
        description={opened?.kind === 'move' ? opened.value.name : undefined}
      >
        {opened?.kind === 'move' ? (
          <MoveForm
            value={opened.value}
            folders={folderItems}
            onCancel={close}
            onMoved={async () => {
              // Moved out of the folder the list is filtered to, as the page's last row.
              if (folder !== ANY_FOLDER && items.length === 1) setTrail(trailBack);
              await refresh();
              close(t`Custom value moved.`);
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
          ) : opened?.kind === 'delete-value' ? (
            <Trans>Delete {removingName}?</Trans>
          ) : null
        }
        description={
          opened?.kind === 'delete-folder' ? (
            <Trans>Its custom values are kept, in no folder.</Trans>
          ) : opened?.kind === 'delete-value' ? (
            <Trans>
              A message that still uses {removingToken} is not sent until the key is taken out of
              it, or a value with that key exists again.
            </Trans>
          ) : null
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

function ValueForm({
  value,
  folders,
  onCancel,
  onSaved,
  onReload,
}: {
  readonly value: CustomValue | undefined;
  readonly folders: readonly CustomValueFolder[];
  readonly onCancel: () => void;
  readonly onSaved: (created: boolean) => Promise<void>;
  /** The saved version, to edit in place of the one someone else has since changed. */
  readonly onReload: (latest: CustomValue) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [name, setName] = useState(value?.name ?? '');
  const [text, setText] = useState(value?.value ?? '');
  const [folder, setFolder] = useState(value?.folderId ?? NO_FOLDER);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const folderId = folders.find((each) => each.id === folder)?.id ?? null;
  const save = useMutation({
    mutationFn: () =>
      value === undefined
        ? api.request(createCustomValue, { body: { name, value: text, folderId } })
        : api.request(updateCustomValue, {
            params: { valueId: value.id },
            body: { name, value: text, folderId, revision: value.revision },
          }),
    onSuccess: () => onSaved(value === undefined),
    onError: (error) => {
      setProblem(
        savingProblem(
          error,
          t`The custom value wasn't saved. Check your connection and try again.`,
        ),
      );
    },
  });
  const reload = useMutation({
    mutationFn: async () => {
      if (value === undefined) throw new Error('Nothing saved to reload.');
      // There is no read of one value: its key finds it, and never changes.
      const found = await api.request(listCustomValues, {
        query: { q: value.key, limit: CUSTOM_VALUE_LIMITS.page },
      });
      const latest = found.items.find((each) => each.id === value.id);
      if (latest === undefined) throw new Error('The value is gone.');
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
  const token = mergeToken(value?.mergeKey ?? `custom_values.${mergeKeyFromName(name, 'value')}`);
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
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          required
          maxLength={120}
          autoComplete="off"
          placeholder={t`Enter custom value name`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        {name.trim() === '' && value === undefined ? null : (
          <FieldDescription>
            {value === undefined ? (
              <Trans>
                Key: <code className="font-mono text-xs">{token}</code>. A number is added if that
                key is taken. It never changes afterwards.
              </Trans>
            ) : (
              <Trans>
                Key: <code className="font-mono text-xs">{token}</code>. Renaming the value keeps
                this key.
              </Trans>
            )}
          </FieldDescription>
        )}
        <FieldError />
      </Field>
      <Field name="value">
        <FieldLabel>
          <Trans>Value</Trans>
        </FieldLabel>
        <Textarea
          rows={3}
          maxLength={CUSTOM_VALUE_LIMITS.value}
          placeholder={t`Enter custom value (optional)`}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <FieldError />
      </Field>
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
          {value === undefined ? t`Create` : t`Save changes`}
        </Button>
      </div>
    </Form>
  );
}

function FolderForm({
  folder,
  onCancel,
  onSaved,
  onReload,
}: {
  readonly folder: CustomValueFolder | undefined;
  readonly onCancel: () => void;
  readonly onSaved: (created: boolean) => Promise<void>;
  readonly onReload: (latest: CustomValueFolder) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const [name, setName] = useState(folder?.name ?? '');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const save = useMutation({
    mutationFn: () =>
      folder === undefined
        ? api.request(createCustomValueFolder, { body: { name } })
        : api.request(renameCustomValueFolder, {
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
      const latest = (await api.request(listCustomValueFolders, { query: {} })).items.find(
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
  value,
  folders,
  onCancel,
  onMoved,
}: {
  readonly value: CustomValue;
  readonly folders: readonly CustomValueFolder[];
  readonly onCancel: () => void;
  readonly onMoved: () => Promise<void>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [folder, setFolder] = useState(value.folderId ?? NO_FOLDER);
  const folderId = folders.find((each) => each.id === folder)?.id ?? null;
  const move = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(moveCustomValues, {
        body: { valueIds: [value.id], folderId },
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
        <Button type="submit" disabled={move.isPending || folderId === value.folderId}>
          <Trans>Move</Trans>
        </Button>
      </div>
    </Form>
  );
}
