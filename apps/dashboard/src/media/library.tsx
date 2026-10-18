// The media library as a person works in it (laid out as GoHighLevel's Media Storage):
// folders, a grid or a list of files, search over the whole library, sort, a type filter,
// uploads by button or by dropping files on the page, and what can be done to a file. The
// Media Storage page shows it whole; the media picker shows the same library to choose one
// file from.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createFileLink,
  createMediaFolder,
  deleteMedia,
  listMedia,
  listMediaFolders,
  getMediaUsage,
  MAX_FILE_LINK_SECONDS,
  mediaKinds,
  mediaSorts,
  moveMedia,
  removeMediaFolder,
  updateMediaFile,
  updateMediaFolder,
  type MediaFile,
  type MediaFolder,
  type MediaKind,
  type MediaSort,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ChevronRight,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Music,
  Upload,
} from 'lucide-react';
import {
  useCallback,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiIn } from '../api';
import { ListSearch } from '../list-toolbar';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  iconButtonClassName,
  ListProblem,
  retryFaults,
  RowMenu,
  tableClassName,
  tableRegionClassName,
  useSettled,
  type RowAction,
} from '../settings-list';
import { listQuery, mediaKeys, type MediaListFilter } from './data';
import { MoveDialog, NameDialog, PreviewDialog } from './dialogs';
import { acceptOf, childrenOf, insideOf, nameProblem, trailOf } from './rules';
import { UploadList, useSizeWords, useUploads } from './uploads';

type Open =
  | { readonly kind: 'new-folder' }
  | { readonly kind: 'rename-file'; readonly file: MediaFile }
  | { readonly kind: 'rename-folder'; readonly folder: MediaFolder }
  | { readonly kind: 'move-files'; readonly files: readonly MediaFile[] }
  | { readonly kind: 'move-folder'; readonly folder: MediaFolder }
  | { readonly kind: 'delete-files'; readonly files: readonly MediaFile[] }
  | { readonly kind: 'delete-folder'; readonly folder: MediaFolder }
  | { readonly kind: 'preview'; readonly file: MediaFile };

export interface MediaLibraryProps {
  readonly businessId: string;
  /**
   * `manage` is the Media Storage page. `pick` is the picker: a file is chosen with one
   * press, and nothing is renamed, moved or deleted from there.
   */
  readonly mode: 'manage' | 'pick';
  /** Only these groups of types, for a picker that wants pictures alone. */
  readonly kinds?: readonly MediaKind[];
  readonly onChoose?: (file: MediaFile) => void;
  /** Lays the library out: the page puts the buttons beside its title. */
  readonly frame: (parts: {
    readonly actions: ReactNode;
    readonly body: ReactNode;
  }) => ReactElement;
}

const KindIcon = ({ kind }: { readonly kind: MediaKind }): ReactElement => {
  const Icon =
    kind === 'image' ? ImageIcon : kind === 'video' ? Film : kind === 'audio' ? Music : FileText;
  return <Icon aria-hidden className="size-8 text-muted-foreground" strokeWidth={1.4} />;
};

/** A picture's thumbnail, or its type's icon when there is none or it does not load. */
function Thumbnail({ file }: { readonly file: MediaFile }): ReactElement {
  const [failed, setFailed] = useState(false);
  return file.kind === 'image' && file.previewUrl !== null && !failed ? (
    <img
      src={file.previewUrl}
      alt=""
      loading="lazy"
      decoding="async"
      className="size-full object-cover"
      onError={() => {
        setFailed(true);
      }}
    />
  ) : (
    <KindIcon kind={file.kind} />
  );
}

const ANY_KIND = 'all';
/** What a drag carries when it carries files (the HTML drag and drop API's own word). */
const DRAGGED_FILES = 'Files';

export function MediaLibrary({
  businessId,
  mode,
  kinds,
  onChoose,
  frame,
}: MediaLibraryProps): ReactElement {
  const { t, i18n } = useLingui();
  const client = apiIn(businessId);
  const queryClient = useQueryClient();
  const sizeWords = useSizeWords();
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const [folderId, setFolderId] = useState<string | null>(null);
  const [scope, setScope] = useState<'mine' | 'public'>('mine');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MediaSort>('modified_desc');
  const [kind, setKind] = useState<MediaKind | undefined>(
    kinds?.length === 1 ? kinds[0] : undefined,
  );
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<Open>();
  const [problem, setProblem] = useState<string>();
  const [notice, setNotice] = useState('');
  const [dropping, setDropping] = useState(false);

  const settledSearch = useSettled(search);
  const searching = settledSearch.trim() !== '';
  const flat = searching || scope === 'public';
  const filter: MediaListFilter = {
    folderId,
    search: settledSearch,
    kind,
    publicOnly: scope === 'public',
    sort,
  };

  const folders = useQuery({
    queryKey: mediaKeys.folders(businessId),
    queryFn: () => client.request(listMediaFolders, {}),
    retry: retryFaults,
  });
  const usage = useQuery({
    queryKey: mediaKeys.usage(businessId),
    queryFn: () => client.request(getMediaUsage, {}),
    retry: retryFaults,
  });
  const files = useInfiniteQuery({
    queryKey: mediaKeys.list(businessId, filter),
    queryFn: ({ pageParam }) => client.request(listMedia, { query: listQuery(filter, pageParam) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: mediaKeys.all(businessId) }),
    [queryClient, businessId],
  );
  const uploads = useUploads({
    businessId,
    maxFileBytes: usage.data?.maxFileBytes,
    kinds,
    onUploaded: () => {
      void refresh();
    },
  });

  const allFolders = folders.data?.items ?? [];
  // The server filters by one group of types; a picker that takes two or three of them
  // leaves the rest out here.
  const items = (files.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (item) => kinds === undefined || kinds.includes(item.kind),
  );
  const canManage = files.data?.pages[0]?.canManage ?? false;
  const canPublish = files.data?.pages[0]?.canPublish ?? false;
  const managing = mode === 'manage' && canManage;
  const trail = trailOf(allFolders, folderId);
  const here = flat ? [] : childrenOf(allFolders, folderId);
  const chosen = items.filter((item) => selected.has(item.id));
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });

  const kindWords = (each: MediaKind): string =>
    each === 'image'
      ? t`Image`
      : each === 'video'
        ? t`Video`
        : each === 'audio'
          ? t`Audio`
          : t`Document`;
  const kindsWords = (each: MediaKind): string =>
    each === 'image'
      ? t`Images`
      : each === 'video'
        ? t`Videos`
        : each === 'audio'
          ? t`Audio`
          : t`Documents`;
  const sortWords: Readonly<Record<MediaSort, string>> = {
    modified_desc: t`Modified: Newest First`,
    modified_asc: t`Modified: Oldest First`,
    name_asc: t`Name: A to Z`,
    name_desc: t`Name: Z to A`,
    size_desc: t`Size: Largest First`,
    size_asc: t`Size: Smallest First`,
  };

  const close = (): void => {
    setOpen(undefined);
    setProblem(undefined);
  };
  const show = (next: Open): void => {
    setProblem(undefined);
    setOpen(next);
  };
  const wordsOf = (error: unknown, fallback: string): string =>
    error instanceof ApiError && error.problem.status >= 502 && error.problem.status <= 504
      ? t`The server didn't answer just then, so nothing was changed. Wait a moment and try again.`
      : error instanceof ApiError
        ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? fallback)
        : fallback;
  /** What every change does when it is over: the lists are read again, and the dialog closes. */
  const settled = (said: string) => ({
    onSuccess: async () => {
      setNotice(said);
      close();
      setSelected(new Set());
      await refresh();
    },
    onError: (error: unknown) => {
      setProblem(wordsOf(error, t`That didn't work. Check your connection and try again.`));
    },
  });

  const createFolder = useMutation({
    mutationFn: (name: string) =>
      client.request(createMediaFolder, { body: { name, parentId: folderId } }),
    ...settled(t`Folder created.`),
  });
  const renameFolder = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      client.request(updateMediaFolder, { params: { id: input.id }, body: { name: input.name } }),
    ...settled(t`Folder renamed.`),
  });
  const moveFolder = useMutation({
    mutationFn: (input: { id: string; parentId: string | null }) =>
      client.request(updateMediaFolder, {
        params: { id: input.id },
        body: { parentId: input.parentId },
      }),
    ...settled(t`Folder moved.`),
  });
  const deleteFolder = useMutation({
    mutationFn: (id: string) => client.request(removeMediaFolder, { params: { id } }),
    ...settled(t`Folder deleted. What it held is now in the folder above.`),
  });
  const renameFile = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      client.request(updateMediaFile, { params: { id: input.id }, body: { name: input.name } }),
    ...settled(t`File renamed.`),
  });
  const moveFiles = useMutation({
    mutationFn: (input: { ids: string[]; folderId: string | null }) =>
      client.request(moveMedia, { body: input }),
    ...settled(t`Moved.`),
  });
  const deleteFiles = useMutation({
    mutationFn: (ids: string[]) => client.request(deleteMedia, { body: { ids } }),
    ...settled(t`Deleted.`),
  });
  const publish = useMutation({
    mutationFn: (input: { file: MediaFile; public: boolean }) =>
      client.request(updateMediaFile, {
        params: { id: input.file.id },
        body: { public: input.public },
      }),
    onSuccess: async (saved) => {
      const name = saved.name;
      setNotice(
        saved.public
          ? t`"${name}" is public now. Copy its link to use it in a page or an email.`
          : t`"${name}" is private again. Its public link has stopped working.`,
      );
      await refresh();
    },
    onError: (error) => {
      setNotice(wordsOf(error, t`That didn't work. Check your connection and try again.`));
    },
  });
  const busy =
    createFolder.isPending ||
    renameFolder.isPending ||
    moveFolder.isPending ||
    deleteFolder.isPending ||
    renameFile.isPending ||
    moveFiles.isPending ||
    deleteFiles.isPending;

  /** A link that opens the file: its public address, or a signed one that lasts as given. */
  const linkTo = async (file: MediaFile, seconds: number): Promise<string> =>
    file.publicUrl ??
    (
      await client.request(createFileLink, {
        params: { id: file.id },
        body: { expiresIn: seconds },
      })
    ).url;
  const copyLink = async (file: MediaFile): Promise<void> => {
    try {
      await navigator.clipboard.writeText(await linkTo(file, MAX_FILE_LINK_SECONDS));
      setNotice(
        file.public
          ? t`Public link copied.`
          : t`Link copied. It works for 7 days; make the file public for a link that lasts.`,
      );
    } catch {
      setNotice(t`The link couldn't be copied. Try again.`);
    }
  };
  const download = async (file: MediaFile): Promise<void> => {
    try {
      const anchor = document.createElement('a');
      anchor.href = await linkTo({ ...file, publicUrl: null }, 300);
      anchor.download = file.name;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      setNotice(t`The download couldn't be started. Try again.`);
    }
  };

  const addFiles = (list: FileList | null): void => {
    if (list === null || list.length === 0) return;
    uploads.add([...list], flat ? null : folderId);
  };
  const dropHandlers = !canManage
    ? {}
    : {
        onDragEnter: (event: DragEvent) => {
          if (!event.dataTransfer.types.includes(DRAGGED_FILES)) return;
          event.preventDefault();
          setDropping(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!event.dataTransfer.types.includes(DRAGGED_FILES)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: (event: DragEvent) => {
          // Leaving for a child is still inside.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropping(false);
        },
        onDrop: (event: DragEvent) => {
          if (!event.dataTransfer.types.includes(DRAGGED_FILES)) return;
          event.preventDefault();
          setDropping(false);
          addFiles(event.dataTransfer.files);
        },
      };

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const openFolder = (id: string | null): void => {
    setFolderId(id);
    setSelected(new Set());
  };

  const fileActions = (file: MediaFile): RowAction[] => [
    {
      label: t`Preview`,
      onSelect: () => {
        show({ kind: 'preview', file });
      },
    },
    ...(managing
      ? [
          {
            label: t`Rename`,
            onSelect: () => {
              show({ kind: 'rename-file', file });
            },
          },
          {
            label: t`Move`,
            onSelect: () => {
              show({ kind: 'move-files', files: [file] });
            },
          },
        ]
      : []),
    {
      label: t`Copy link`,
      immediate: true,
      onSelect: () => {
        void copyLink(file);
      },
    },
    ...(managing && (canPublish || file.public)
      ? [
          {
            label: file.public ? t`Make private` : t`Make public`,
            immediate: true,
            onSelect: () => {
              publish.mutate({ file, public: !file.public });
            },
          },
        ]
      : []),
    {
      label: t`Download`,
      immediate: true,
      onSelect: () => {
        void download(file);
      },
    },
    ...(managing
      ? [
          {
            label: t`Delete`,
            destructive: true,
            onSelect: () => {
              show({ kind: 'delete-files', files: [file] });
            },
          },
        ]
      : []),
  ];
  const folderActions = (folder: MediaFolder): RowAction[] => [
    {
      label: t`Rename`,
      onSelect: () => {
        show({ kind: 'rename-folder', folder });
      },
    },
    {
      label: t`Move`,
      onSelect: () => {
        show({ kind: 'move-folder', folder });
      },
    },
    {
      label: t`Delete`,
      destructive: true,
      onSelect: () => {
        show({ kind: 'delete-folder', folder });
      },
    },
  ];
  const rememberTrigger = (trigger: HTMLElement | null): void => {
    returnFocusRef.current = trigger;
  };
  const press = (file: MediaFile): void => {
    if (mode === 'pick') onChoose?.(file);
    else show({ kind: 'preview', file });
  };
  const pressLabel = (file: MediaFile): string => {
    const name = file.name;
    return mode === 'pick' ? t`Choose ${name}` : t`Preview ${name}`;
  };
  const metaOf = (file: MediaFile): string =>
    `${sizeWords(file.size)} · ${dates.format(new Date(file.updatedAt))}`;

  const actions = !canManage ? null : (
    <div className="flex flex-wrap items-center gap-2">
      {scope === 'public' || searching ? null : (
        <button
          type="button"
          aria-label={t`New folder`}
          title={t`New folder`}
          className={`${iconButtonClassName} border border-input bg-card`}
          onClick={(event) => {
            returnFocusRef.current = event.currentTarget;
            show({ kind: 'new-folder' });
          }}
        >
          <FolderPlus aria-hidden className="size-5" strokeWidth={1.8} />
        </button>
      )}
      <input
        ref={fileInputRef}
        id={inputId}
        type="file"
        multiple
        accept={acceptOf(kinds)}
        aria-label={t`Choose files to upload`}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          addFiles(event.target.files);
          // The same file can be chosen again after a failure.
          event.target.value = '';
        }}
      />
      <Button
        onClick={() => {
          fileInputRef.current?.click();
        }}
      >
        <Upload aria-hidden className="size-4" strokeWidth={1.8} />
        <Trans>Upload</Trans>
      </Button>
    </div>
  );

  const count = usage.data?.files ?? 0;
  const held = usage.data === undefined ? '' : sizeWords(usage.data.bytes);
  const quotaBytes = usage.data?.quotaBytes ?? null;
  const quota =
    quotaBytes === null
      ? undefined
      : { used: sizeWords(usage.data?.businessBytes ?? 0), of: sizeWords(quotaBytes) };
  const quotaUsed = quota?.used ?? '';
  const quotaOf = quota?.of ?? '';
  const selectedCount = chosen.length;
  // What the open dialog is about, by name or by number, for its title.
  const openName =
    open === undefined || open.kind === 'new-folder'
      ? ''
      : 'folder' in open
        ? open.folder.name
        : 'file' in open
          ? open.file.name
          : (open.files[0]?.name ?? '');
  const openCount = open !== undefined && 'files' in open ? open.files.length : 0;
  const openedName = trail.at(-1)?.name ?? t`My Media`;

  const body = (
    <div className="relative flex min-w-0 flex-col gap-4" {...dropHandlers}>
      {usage.data === undefined ? null : (
        <p className="text-sm text-muted-foreground" data-testid="media-usage">
          {count === 1 ? (
            <Trans>1 file · {held}</Trans>
          ) : (
            <Trans>
              {count} files · {held}
            </Trans>
          )}
          {quota === undefined ? null : (
            <>
              {' · '}
              <Trans>
                {quotaUsed} of {quotaOf} used by this business
              </Trans>
            </>
          )}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {canPublish ? (
          <Select
            aria-label={t`Which files to show`}
            className="w-auto max-w-full min-w-36"
            value={scope}
            onValueChange={(next) => {
              setScope(next === 'public' ? 'public' : 'mine');
              setSelected(new Set());
            }}
          >
            <option value="mine">{t`My Media`}</option>
            <option value="public">{t`Public files`}</option>
          </Select>
        ) : null}
        <div className="flex min-w-0 flex-1 basis-64 [&>form]:max-w-none">
          <ListSearch
            label={t`Search the entire media library`}
            value={search}
            onChange={setSearch}
          />
        </div>
        <Select
          aria-label={t`Sort by`}
          className="w-auto max-w-full min-w-52"
          value={sort}
          onValueChange={(next) => {
            setSort(mediaSorts.find((each) => each === next) ?? 'modified_desc');
          }}
        >
          {mediaSorts.map((each) => (
            <option key={each} value={each}>
              {sortWords[each]}
            </option>
          ))}
        </Select>
        {kinds?.length === 1 ? null : (
          <Select
            aria-label={t`Type of file`}
            className="w-auto max-w-full min-w-32"
            value={kind ?? ANY_KIND}
            onValueChange={(next) => {
              setKind(mediaKinds.find((each) => each === next));
            }}
          >
            <option value={ANY_KIND}>{t`All`}</option>
            {mediaKinds
              .filter((each) => kinds === undefined || kinds.includes(each))
              .map((each) => (
                <option key={each} value={each}>
                  {kindsWords(each)}
                </option>
              ))}
          </Select>
        )}
        <div role="group" aria-label={t`View`} className="inline-flex rounded-lg bg-muted p-1">
          {(
            [
              ['grid', t`Grid view`, LayoutGrid],
              ['list', t`List view`, List],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={view === value}
              className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground -outline-offset-2 aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm lg:size-7"
              onClick={() => {
                setView(value);
              }}
            >
              <Icon aria-hidden className="size-4" strokeWidth={1.8} />
            </button>
          ))}
        </div>
      </div>

      <p role="status" className={notice === '' ? 'sr-only' : 'text-sm text-body'}>
        {notice}
      </p>
      <UploadList uploads={uploads} maxFileBytes={usage.data?.maxFileBytes} />

      {flat ? (
        <p className="text-sm font-medium">
          {searching ? <Trans>Results from the whole library</Trans> : <Trans>Public files</Trans>}
        </p>
      ) : (
        <nav aria-label={t`Folder path`}>
          <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            <li>
              {trail.length === 0 ? (
                <span aria-current="page" className="font-medium">
                  <Trans>Folders</Trans>
                </span>
              ) : (
                <button
                  type="button"
                  className="rounded-control px-1 text-primary hover:underline"
                  onClick={() => {
                    openFolder(null);
                  }}
                >
                  <Trans>Folders</Trans>
                </button>
              )}
            </li>
            {trail.map((folder, index) => (
              <li key={folder.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {index === trail.length - 1 ? (
                  <span aria-current="page" className="truncate font-medium">
                    {folder.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="truncate rounded-control px-1 text-primary hover:underline"
                    onClick={() => {
                      openFolder(folder.id);
                    }}
                  >
                    {folder.name}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}

      {managing && selectedCount > 0 ? (
        <div
          role="group"
          aria-label={t`Selected files`}
          className="flex flex-wrap items-center gap-2 rounded-control bg-accent px-3 py-2 text-sm"
        >
          <span className="font-medium">
            {selectedCount === 1 ? (
              <Trans>1 selected</Trans>
            ) : (
              <Trans>{selectedCount} selected</Trans>
            )}
          </span>
          <Button
            variant="secondary"
            size="small"
            onClick={(event) => {
              returnFocusRef.current = event.currentTarget;
              show({ kind: 'move-files', files: chosen });
            }}
          >
            <Trans>Move</Trans>
          </Button>
          <Button
            variant="secondary"
            size="small"
            className="border-destructive text-destructive"
            onClick={(event) => {
              returnFocusRef.current = event.currentTarget;
              show({ kind: 'delete-files', files: chosen });
            }}
          >
            <Trans>Delete</Trans>
          </Button>
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              setSelected(new Set());
            }}
          >
            <Trans>Clear selection</Trans>
          </Button>
        </div>
      ) : null}

      {folders.isError ? (
        <ListProblem
          onRetry={() => {
            void folders.refetch();
          }}
        >
          <Trans>We couldn't load the folders.</Trans>
        </ListProblem>
      ) : null}
      {here.length === 0 ? null : (
        <ul
          aria-label={t`Folders`}
          className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3"
        >
          {here.map((folder) => {
            const name = folder.name;
            const inside = folder.fileCount;
            return (
              <li
                key={folder.id}
                className="flex min-w-0 items-center gap-1 rounded-card border border-border bg-card pr-1"
              >
                <button
                  type="button"
                  aria-label={t`Open folder ${name}`}
                  className="flex min-h-14 min-w-0 flex-1 items-center gap-2.5 rounded-card px-3 text-left -outline-offset-2 hover:bg-secondary"
                  onClick={() => {
                    openFolder(folder.id);
                  }}
                >
                  <Folder aria-hidden className="size-5 shrink-0 text-primary" strokeWidth={1.8} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium" title={name}>
                      {name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {inside === 1 ? <Trans>1 file</Trans> : <Trans>{inside} files</Trans>}
                    </span>
                  </span>
                </button>
                {managing ? (
                  <RowMenu
                    label={t`Actions for folder ${name}`}
                    actions={folderActions(folder)}
                    onOpen={rememberTrigger}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {files.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading files…</Trans>
        </p>
      ) : files.isError ? (
        <ListProblem
          onRetry={() => {
            void files.refetch();
          }}
        >
          <Trans>We couldn't load the files.</Trans>
        </ListProblem>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-input bg-card px-6 py-12 text-center">
          <ImageIcon aria-hidden className="size-9 text-muted-foreground" strokeWidth={1.4} />
          <p className="text-md font-medium">
            <Trans>No media files found</Trans>
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            {searching || kind !== undefined || scope === 'public' ? (
              <Trans>Nothing matches. Try another search or filter.</Trans>
            ) : canManage ? (
              <Trans>
                Upload files with the Upload button, or drop them anywhere on this page.
              </Trans>
            ) : (
              <Trans>Files your team uploads here will show in this list.</Trans>
            )}
          </p>
        </div>
      ) : view === 'grid' ? (
        <ul
          aria-label={t`Files`}
          className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3"
        >
          {items.map((file) => {
            const name = file.name;
            const isSelected = selected.has(file.id);
            return (
              <li
                key={file.id}
                className={`group relative flex min-w-0 flex-col overflow-hidden rounded-card border bg-card ${
                  isSelected ? 'border-primary ring-1 ring-primary' : 'border-border'
                }`}
              >
                <button
                  type="button"
                  aria-label={pressLabel(file)}
                  className="flex aspect-4/3 w-full items-center justify-center overflow-hidden bg-secondary -outline-offset-2"
                  onClick={(event) => {
                    returnFocusRef.current = event.currentTarget;
                    press(file);
                  }}
                >
                  <Thumbnail file={file} />
                </button>
                <div className="flex min-w-0 items-start gap-1 p-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium" title={name}>
                      {name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{metaOf(file)}</span>
                    {file.public ? (
                      <span className="inline-flex items-center gap-1 text-xs text-body">
                        <Globe aria-hidden className="size-3.5" strokeWidth={1.8} />
                        <Trans>Public</Trans>
                      </span>
                    ) : null}
                  </div>
                  {mode === 'manage' ? (
                    <RowMenu
                      label={t`Actions for ${name}`}
                      actions={fileActions(file)}
                      onOpen={rememberTrigger}
                    />
                  ) : null}
                </div>
                {managing ? (
                  <label className="absolute top-1.5 left-1.5 inline-flex size-9 items-center justify-center rounded-control bg-card/90 lg:size-7">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={t`Select ${name}`}
                      checked={isSelected}
                      onChange={() => {
                        toggle(file.id);
                      }}
                    />
                  </label>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={tableRegionClassName} role="region" aria-label={t`Files`}>
          <table className={tableClassName}>
            <thead>
              <tr>
                {managing ? (
                  <th scope="col" className={`${headerCellClassName} w-10`}>
                    <span className="sr-only">
                      <Trans>Select</Trans>
                    </span>
                  </th>
                ) : null}
                <th scope="col" className={headerCellClassName}>
                  <Trans>Name</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Type</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Size</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Modified</Trans>
                </th>
                {mode === 'manage' ? (
                  <th scope="col" className={`${headerCellClassName} w-12`}>
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {items.map((file) => {
                const name = file.name;
                return (
                  <tr key={file.id} className={selected.has(file.id) ? 'bg-accent' : undefined}>
                    {managing ? (
                      <td className={cellClassName}>
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          aria-label={t`Select ${name}`}
                          checked={selected.has(file.id)}
                          onChange={() => {
                            toggle(file.id);
                          }}
                        />
                      </td>
                    ) : null}
                    <td className={`${cellClassName} max-w-0 min-w-56`}>
                      <button
                        type="button"
                        aria-label={pressLabel(file)}
                        className="flex w-full min-w-0 items-center gap-2.5 rounded-control text-left -outline-offset-2 hover:underline"
                        onClick={(event) => {
                          returnFocusRef.current = event.currentTarget;
                          press(file);
                        }}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-control bg-secondary [&_svg]:size-5">
                          <Thumbnail file={file} />
                        </span>
                        <span className="truncate font-medium" title={name}>
                          {name}
                        </span>
                        {file.public ? (
                          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-body">
                            <Globe aria-hidden className="size-3.5" strokeWidth={1.8} />
                            <Trans>Public</Trans>
                          </span>
                        ) : null}
                      </button>
                    </td>
                    <td className={`${cellClassName} whitespace-nowrap`}>{kindWords(file.kind)}</td>
                    <td className={`${cellClassName} whitespace-nowrap`}>{sizeWords(file.size)}</td>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      {dates.format(new Date(file.updatedAt))}
                    </td>
                    {mode === 'manage' ? (
                      <td className={`${cellClassName} text-right`}>
                        <RowMenu
                          label={t`Actions for ${name}`}
                          actions={fileActions(file)}
                          onOpen={rememberTrigger}
                        />
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {files.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-center"
          disabled={files.isFetchingNextPage}
          onClick={() => {
            void files.fetchNextPage();
          }}
        >
          {files.isFetchingNextPage ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
        </Button>
      ) : null}

      {dropping ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-card border-2 border-dashed border-primary bg-accent/90 p-6 text-center text-md font-medium text-foreground"
        >
          <Trans>Drop files to upload them to {openedName}</Trans>
        </div>
      ) : null}

      {open?.kind === 'new-folder' ? (
        <NameDialog
          title={<Trans>New folder</Trans>}
          label={t`Folder name`}
          initial=""
          confirmLabel={t`Create folder`}
          busy={busy}
          problem={problem}
          check={(name) =>
            name.trim() === ''
              ? t`Give the folder a name.`
              : name.trim().length > 120
                ? t`Use at most 120 characters.`
                : undefined
          }
          returnFocus={returnFocusRef}
          onSubmit={(name) => {
            createFolder.mutate(name);
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'rename-folder' ? (
        <NameDialog
          title={<Trans>Rename folder</Trans>}
          label={t`Folder name`}
          initial={open.folder.name}
          confirmLabel={t`Rename`}
          busy={busy}
          problem={problem}
          check={(name) =>
            name.trim() === ''
              ? t`Give the folder a name.`
              : name.trim().length > 120
                ? t`Use at most 120 characters.`
                : undefined
          }
          returnFocus={returnFocusRef}
          onSubmit={(name) => {
            renameFolder.mutate({ id: open.folder.id, name });
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'rename-file' ? (
        <NameDialog
          title={<Trans>Rename file</Trans>}
          label={t`File name`}
          initial={open.file.name}
          confirmLabel={t`Rename`}
          busy={busy}
          problem={problem}
          check={nameProblem}
          returnFocus={returnFocusRef}
          onSubmit={(name) => {
            renameFile.mutate({ id: open.file.id, name });
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'move-files' ? (
        <MoveDialog
          title={
            open.files.length === 1 ? (
              <Trans>Move "{openName}"</Trans>
            ) : (
              <Trans>Move {openCount} files</Trans>
            )
          }
          folders={allFolders}
          current={open.files[0]?.folderId ?? null}
          busy={busy}
          problem={problem}
          returnFocus={returnFocusRef}
          onSubmit={(target) => {
            moveFiles.mutate({ ids: open.files.map((file) => file.id), folderId: target });
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'move-folder' ? (
        <MoveDialog
          title={<Trans>Move folder "{openName}"</Trans>}
          folders={allFolders}
          current={open.folder.parentId}
          excluded={insideOf(allFolders, open.folder.id)}
          busy={busy}
          problem={problem}
          returnFocus={returnFocusRef}
          onSubmit={(target) => {
            moveFolder.mutate({ id: open.folder.id, parentId: target });
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'delete-files' ? (
        <ConfirmDialog
          open
          title={
            open.files.length === 1 ? (
              <Trans>Delete "{openName}"?</Trans>
            ) : (
              <Trans>Delete {openCount} files?</Trans>
            )
          }
          description={
            <Trans>
              This can't be undone. The file is removed from storage, and any link to it stops
              working.
            </Trans>
          }
          confirmLabel={t`Delete`}
          destructive
          busy={busy}
          problem={problem}
          returnFocus={returnFocusRef}
          onConfirm={() => {
            deleteFiles.mutate(open.files.map((file) => file.id));
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'delete-folder' ? (
        <ConfirmDialog
          open
          title={<Trans>Delete folder "{openName}"?</Trans>}
          description={
            <Trans>
              Only the folder goes. The files and folders inside it move to the folder above, and no
              file is deleted.
            </Trans>
          }
          confirmLabel={t`Delete folder`}
          destructive
          busy={busy}
          problem={problem}
          returnFocus={returnFocusRef}
          onConfirm={() => {
            deleteFolder.mutate(open.folder.id);
          }}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'preview' ? (
        <PreviewDialog
          businessId={businessId}
          file={open.file}
          kindWords={kindWords(open.file.kind)}
          onCopyLink={() => {
            void copyLink(open.file);
          }}
          onDownload={() => {
            void download(open.file);
          }}
          onClose={close}
        />
      ) : null}
    </div>
  );

  return frame({ actions, body });
}
