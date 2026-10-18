// Media Storage's dialogs: naming a folder or a file, choosing where to move something, and
// looking at a file with what is known about it.
import { Trans, useLingui } from '@lingui/react/macro';
import { getMediaFile, type MediaFile, type MediaFolder, type MediaUse } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, FileText, Globe, Lock, Music } from 'lucide-react';
import { useId, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { apiIn } from '../api';
import { AutomationDialog } from '../automation-dialog';
import { SmallDialog } from '../settings-list';
import { mediaKeys } from './data';
import { folderOptions } from './rules';
import { useSizeWords } from './uploads';

/** A dialog that asks for one name, and says what is wrong with it. */
export function NameDialog({
  title,
  label,
  initial,
  confirmLabel,
  busy,
  problem,
  check,
  returnFocus,
  onSubmit,
  onClose,
}: {
  readonly title: ReactNode;
  readonly label: string;
  readonly initial: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  /** Why the server refused the last try. */
  readonly problem: string | undefined;
  /** What is wrong with a name before it is sent, if anything. */
  readonly check: (name: string) => string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const id = useId();
  const [name, setName] = useState(initial);
  const [tried, setTried] = useState(false);
  const fault = tried ? check(name) : undefined;
  const shown = fault ?? problem;
  return (
    <SmallDialog open onClose={onClose} title={title} returnFocus={returnFocus}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (check(name) === undefined) onSubmit(name.trim());
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          <Input
            id={id}
            value={name}
            maxLength={255}
            autoComplete="off"
            aria-invalid={shown === undefined ? undefined : true}
            aria-describedby={shown === undefined ? undefined : `${id}-problem`}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {shown === undefined ? null : (
            <p id={`${id}-problem`} role="alert" className="text-sm text-destructive">
              {shown}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

/** The value a folder choice uses for the top of the library. */
const TOP = 'top';

/** Asks where to move files or a folder: the top of the library, or a folder. */
export function MoveDialog({
  title,
  folders,
  current,
  excluded,
  busy,
  problem,
  returnFocus,
  onSubmit,
  onClose,
}: {
  readonly title: ReactNode;
  readonly folders: readonly MediaFolder[];
  /** Where it is now, which the choice starts on. */
  readonly current: string | null;
  /** Folders that can't be chosen: a moved folder itself and what is inside it. */
  readonly excluded?: ReadonlySet<string>;
  readonly busy: boolean;
  readonly problem: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onSubmit: (folderId: string | null) => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [target, setTarget] = useState(current ?? TOP);
  const options = folderOptions(folders).filter((option) => excluded?.has(option.id) !== true);
  return (
    <SmallDialog open onClose={onClose} title={title} returnFocus={returnFocus}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(target === TOP ? null : target);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">
            <Trans>Move to</Trans>
          </label>
          <Select id={id} value={target} onValueChange={setTarget}>
            <option value={TOP}>{t`My Media (top level)`}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {`${'– '.repeat(option.depth)}${option.name}`}
              </option>
            ))}
          </Select>
        </div>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={busy}>
            <Trans>Move</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

/** Where a file is used, in words. */
export function useUseWords(): (use: MediaUse) => string {
  const { t } = useLingui();
  return (use) => {
    switch (use) {
      case 'business_logo':
        return t`The business's logo`;
      case 'agency_logo':
        return t`The agency's logo`;
      case 'user_picture':
        return t`A person's picture`;
      case 'calendar':
        return t`A calendar's logo or cover`;
      case 'message_attachment':
        return t`A message's attachment`;
      case 'import':
        return t`An import`;
      case 'site_template':
        return t`A site template's preview`;
      case 'record_file':
        return t`A contact's documents`;
      case 'contact_export':
        return t`An export of contacts`;
    }
  };
}

/** A file, shown as large as the window allows, with what is known about it. */
export function PreviewDialog({
  businessId,
  file,
  kindWords,
  onCopyLink,
  onDownload,
  onClose,
}: {
  readonly businessId: string;
  readonly file: MediaFile;
  readonly kindWords: string;
  readonly onCopyLink: () => void;
  readonly onDownload: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const sizeWords = useSizeWords();
  const useWords = useUseWords();
  const detail = useQuery({
    queryKey: mediaKeys.file(businessId, file.id),
    queryFn: () => apiIn(businessId).request(getMediaFile, { params: { id: file.id } }),
  });
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const name = file.name;
  const facts: readonly (readonly [string, ReactNode])[] = [
    [t`Type`, kindWords],
    [t`Size`, sizeWords(file.size)],
    [t`Modified`, dates.format(new Date(file.updatedAt))],
    [t`Uploaded`, dates.format(new Date(file.createdAt))],
    [
      t`Sharing`,
      file.public ? (
        <span key="public" className="inline-flex items-center gap-1.5">
          <Globe aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Public: anyone with the link can open it</Trans>
        </span>
      ) : (
        <span key="private" className="inline-flex items-center gap-1.5">
          <Lock aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Private</Trans>
        </span>
      ),
    ],
  ];
  return (
    <AutomationDialog
      open
      wide
      title={name}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-control bg-secondary">
        {file.previewUrl === null ? (
          <FileText aria-hidden className="size-12 text-muted-foreground" strokeWidth={1.4} />
        ) : file.kind === 'image' ? (
          <img
            src={file.previewUrl}
            alt={name}
            className="max-h-[60dvh] max-w-full object-contain"
          />
        ) : file.kind === 'video' ? (
          // Someone's own recording: there is no captions file to offer with it.
          // eslint-disable-next-line jsx-a11y-x/media-has-caption
          <video
            src={file.previewUrl}
            controls
            preload="metadata"
            aria-label={name}
            className="max-h-[60dvh] w-full bg-foreground"
          />
        ) : file.kind === 'audio' ? (
          <div className="flex w-full flex-col items-center gap-4 p-6">
            <Music aria-hidden className="size-10 text-muted-foreground" strokeWidth={1.4} />
            {/* Someone's own recording: there is no captions file to offer with it. */}
            {/* eslint-disable-next-line jsx-a11y-x/media-has-caption */}
            <audio
              src={file.previewUrl}
              controls
              preload="metadata"
              aria-label={name}
              className="w-full"
            />
          </div>
        ) : (
          <iframe src={file.previewUrl} title={name} className="h-[60dvh] w-full bg-card" />
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0 wrap-anywhere">{value}</dd>
          </div>
        ))}
        {file.publicUrl === null ? null : (
          <div className="contents">
            <dt className="text-muted-foreground">
              <Trans>Public link</Trans>
            </dt>
            <dd className="min-w-0 wrap-anywhere">{file.publicUrl}</dd>
          </div>
        )}
        {detail.data === undefined || detail.data.usedIn.length === 0 ? null : (
          <div className="contents">
            <dt className="text-muted-foreground">
              <Trans>Used in</Trans>
            </dt>
            <dd className="min-w-0">{detail.data.usedIn.map(useWords).join(', ')}</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" data-initial-focus onClick={onCopyLink}>
          <Copy aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Copy link</Trans>
        </Button>
        <Button variant="secondary" onClick={onDownload}>
          <Download aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Download</Trans>
        </Button>
      </div>
    </AutomationDialog>
  );
}
