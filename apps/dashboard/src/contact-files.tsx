// The contact's Documents panel, as GoHighLevel's: every file on the contact, sorted into
// All, Internal (uploaded here or to a file upload field), Sent and Received (the
// conversation's attachments), with a search by name, an upload button, and a short-lived
// link to save each. Fetched when the panel is first opened.
import { Trans, useLingui } from '@lingui/react/macro';
import { documentFormats, listRecordFiles, type RecordFile } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';
import { useActorLabel } from './activity';
import { apiIn } from './api';
import {
  DeleteRecordFile,
  FileName,
  problemOf,
  recordFilesKey,
  UploadButton,
  useUploadRecordFiles,
} from './contact-files-parts';
import { ContactPanel, PanelEmpty } from './contact-panels';
import { useBusiness } from './workspace';

type Folder = 'all' | RecordFile['folder'];
const folders: readonly Folder[] = ['all', 'internal', 'sent', 'received'];
/** GoHighLevel's mobile app takes up to ten files in one upload. */
const MAX_AT_ONCE = 10;

export default function ContactFiles({
  contactId,
  readOnly,
}: {
  readonly contactId: string;
  /** True for a contact in the trash: its files are listed and none is added or deleted. */
  readonly readOnly: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const actorLabel = useActorLabel();
  const [folder, setFolder] = useState<Folder>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);
  const files = useInfiniteQuery({
    queryKey: [...recordFilesKey(business.id, contactId), folder, q],
    queryFn: ({ pageParam }) =>
      apiIn(business.id).request(listRecordFiles, {
        params: { id: contactId },
        query: {
          folder,
          limit: 50,
          ...(q === '' ? {} : { q }),
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const upload = useUploadRecordFiles(contactId);
  const [tooMany, setTooMany] = useState(false);
  const items = files.data?.pages.flatMap((page) => page.items) ?? [];
  const canUpload = !readOnly && files.data?.pages[0]?.canUpload === true;
  const names: Readonly<Record<Folder, string>> = {
    all: t`All`,
    internal: t`Internal`,
    sent: t`Sent`,
    received: t`Received`,
  };
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const uploadButton = canUpload ? (
    <UploadButton
      formats={documentFormats}
      multiple
      disabled={false}
      busy={upload.isPending}
      label={t`Upload`}
      onChosen={(chosen) => {
        setTooMany(chosen.length > MAX_AT_ONCE);
        upload.mutate(chosen.slice(0, MAX_AT_ONCE));
      }}
    />
  ) : null;
  const empty = files.data !== undefined && items.length === 0;
  return (
    <ContactPanel title={t`Documents`} action={uploadButton}>
      {/* One folder shows at a time: a set of toggle buttons, the pressed one showing. */}
      <div role="group" aria-label={t`Folders`} className="flex flex-wrap gap-1">
        {folders.map((each) => (
          <button
            key={each}
            type="button"
            aria-pressed={each === folder}
            className={
              each === folder
                ? 'min-h-11 rounded-control bg-secondary px-3 text-sm font-medium text-link lg:min-h-8'
                : 'min-h-11 rounded-control px-3 text-sm text-body hover:bg-muted lg:min-h-8'
            }
            onClick={() => {
              setFolder(each);
            }}
          >
            {names[each]}
          </button>
        ))}
      </div>
      <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
        <Trans>Search documents</Trans>
        <input
          type="search"
          maxLength={200}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          className="min-h-11 min-w-0 rounded-control border border-input bg-card px-3 text-md"
        />
      </label>
      {tooMany ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Upload at most ten files at a time. The first ten were uploaded.</Trans>
        </p>
      ) : null}
      {(upload.data ?? []).map((refused, index) => (
        <p key={`${String(index)}:${refused}`} role="alert" className="text-sm text-destructive">
          {refused}
        </p>
      ))}
      {files.isPending ? (
        <p aria-live="polite">
          <Trans>Loading documents…</Trans>
        </p>
      ) : null}
      {files.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{problemOf(files.error, t`The documents couldn't be loaded.`)}</p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void files.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {empty ? (
        <PanelEmpty
          icon={<FolderOpen />}
          title={q === '' ? t`No documents yet` : t`No document matches`}
          description={
            q === ''
              ? t`Files uploaded here or to a file field, and files in this contact's messages, show here.`
              : t`Try another part of the file's name.`
          }
        />
      ) : (
        <ul aria-label={t`Documents of this contact`} className="flex min-w-0 flex-col gap-2">
          {items.map((file) => {
            const field = file.field?.label;
            return (
              <li
                key={file.id}
                className="flex min-w-0 items-start gap-1 rounded-control border border-border p-2"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <FileName recordId={contactId} file={file} />
                  <span className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground">
                    <Badge variant="neutral" className="px-2 py-0 text-xs">
                      {names[file.folder]}
                    </Badge>
                    {field === undefined ? null : (
                      <Badge variant="neutral" className="px-2 py-0 text-xs">
                        {t`Field: ${field}`}
                      </Badge>
                    )}
                    {file.addedBy === null
                      ? null
                      : actorLabel({ ...file.addedBy, name: file.addedBy.name ?? null })}
                    <time dateTime={file.createdAt}>{dates.format(new Date(file.createdAt))}</time>
                  </span>
                </span>
                {!readOnly && file.removable ? (
                  <DeleteRecordFile recordId={contactId} file={file} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {files.hasNextPage ? (
        <Button
          variant="secondary"
          size="small"
          className="self-start"
          disabled={files.isFetchingNextPage}
          onClick={() => {
            void files.fetchNextPage();
          }}
        >
          <Trans>Show more documents</Trans>
        </Button>
      ) : null}
    </ContactPanel>
  );
}
