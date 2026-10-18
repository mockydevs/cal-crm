// What a record's files share on the contact page: uploading files to the record or to one
// of its file upload fields, opening one through a short-lived link, deleting one after
// asking, and a file's line in a list. Loaded with the parts that use it, never with the
// page itself.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createRecordFileLink,
  deleteRecordFile,
  documentContentTypes,
  documentFormatOf,
  uploadRecordFile,
  type DocumentFormat,
  type RecordFile,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { FileText, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { ConfirmDialog } from './settings-list';
import { useBusiness } from './workspace';

/** The file picker's accept list for these formats: extensions and their types. */
export function acceptOf(formats: readonly DocumentFormat[]): string {
  return formats
    .flatMap((format) => [
      `.${format}`,
      ...(format === 'jpg' ? ['.jpeg'] : []),
      documentContentTypes[format],
    ])
    .join(',');
}

/** What every query of a record's files is kept under, so one change refreshes them all. */
export const recordFilesKey = (businessId: string, recordId: string) =>
  ['b', businessId, 'record-files', recordId] as const;

/** A problem as the API said it, or the page's own words. */
export function problemOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError)
    return error.problem.errors?.[0]?.message ?? error.problem.detail ?? error.message;
  return fallback;
}

/**
 * Uploads files one after another, to the record or to one of its fields; the files the
 * server refused are named with its reason, and the others are kept.
 */
export function useUploadRecordFiles(
  recordId: string,
  fieldId?: string,
): UseMutationResult<string[], Error, readonly File[]> {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (chosen: readonly File[]) => {
      const refused: string[] = [];
      for (const file of chosen) {
        const format = documentFormatOf(file.name);
        try {
          await apiIn(business.id).request(uploadRecordFile, {
            params: { id: recordId },
            query: { filename: file.name, ...(fieldId === undefined ? {} : { field: fieldId }) },
            // The server reads the format from the name and checks the bytes; this type is
            // only what the request says.
            upload: {
              content: file,
              type:
                format === undefined ? 'application/octet-stream' : documentContentTypes[format],
            },
          });
        } catch (error) {
          const name = file.name;
          const reason = problemOf(error, t`It couldn't be uploaded.`);
          refused.push(t`${name}: ${reason}`);
        }
      }
      return refused;
    },
    onSettled: () =>
      Promise.all([
        cache.invalidateQueries({ queryKey: recordFilesKey(business.id, recordId) }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'record-fields', recordId] }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', recordId] }),
      ]),
  });
}

/** Opens a file: a five-minute link, made for whoever may see the record, saved as the file. */
export function useOpenRecordFile(
  recordId: string,
): UseMutationResult<void, Error, Pick<RecordFile, 'id' | 'filename'>> {
  const business = useBusiness();
  return useMutation({
    mutationFn: async (file: Pick<RecordFile, 'id' | 'filename'>) => {
      const link = await apiIn(business.id).request(createRecordFileLink, {
        params: { id: recordId, fileId: file.id },
      });
      const anchor = document.createElement('a');
      anchor.href = link.url;
      // eslint-disable-next-line lingui/no-unlocalized-strings -- link types, not words
      anchor.rel = 'noopener noreferrer';
      // On the dashboard's own address the browser saves the file under its name. On
      // another, it ignores that, so the file opens in a tab of its own, never in place of
      // the page.
      if (new URL(link.url, window.location.href).origin === window.location.origin)
        anchor.download = file.filename;
      else anchor.target = '_blank';
      anchor.click();
    },
  });
}

/** Asks, then deletes an uploaded file for good. */
export function DeleteRecordFile({
  recordId,
  file,
  onDeleted,
}: {
  readonly recordId: string;
  readonly file: Pick<RecordFile, 'id' | 'filename'>;
  readonly onDeleted?: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [asking, setAsking] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const name = file.filename;
  const remove = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(deleteRecordFile, { params: { id: recordId, fileId: file.id } }),
    onSuccess: async () => {
      setAsking(false);
      onDeleted?.();
      await Promise.all([
        cache.invalidateQueries({ queryKey: recordFilesKey(business.id, recordId) }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'record-fields', recordId] }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', recordId] }),
      ]);
    },
  });
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={t`Delete ${name}`}
        title={t`Delete ${name}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-control text-muted-foreground outline-none hover:bg-muted hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring lg:size-8"
        onClick={() => {
          remove.reset();
          setAsking(true);
        }}
      >
        <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
      </button>
      <ConfirmDialog
        open={asking}
        title={t`Delete ${name}?`}
        description={t`The file is deleted for good, for everyone. This can't be undone.`}
        confirmLabel={t`Delete file`}
        destructive
        busy={remove.isPending}
        problem={
          remove.isError
            ? problemOf(remove.error, t`The file wasn't deleted. Try again.`)
            : undefined
        }
        returnFocus={buttonRef}
        onConfirm={() => {
          remove.mutate();
        }}
        onClose={() => {
          setAsking(false);
        }}
      />
    </>
  );
}

/** A file's name, which opens it, and its size; what else a list shows goes beside it. */
export function FileName({
  recordId,
  file,
}: {
  readonly recordId: string;
  readonly file: Pick<RecordFile, 'id' | 'filename' | 'size'>;
}): ReactElement {
  const { t, i18n } = useLingui();
  const open = useOpenRecordFile(recordId);
  const size = new Intl.NumberFormat(i18n.locale, {
    style: 'unit',
    unit: file.size >= 1024 * 1024 ? 'megabyte' : 'kilobyte',
    maximumFractionDigits: 1,
  }).format(file.size / (file.size >= 1024 * 1024 ? 1024 * 1024 : 1024));
  const name = file.filename;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <Button
        variant="quiet"
        size="small"
        className="h-auto min-h-11 justify-start gap-2 px-1 text-left lg:min-h-8"
        aria-label={t`Download ${name}`}
        disabled={open.isPending}
        onClick={() => {
          open.mutate(file);
        }}
      >
        <FileText aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
        <span className="min-w-0 break-all text-link underline">{name}</span>
      </Button>
      <span className="px-1 text-xs text-muted-foreground">{size}</span>
      {open.isError ? (
        <span role="alert" className="px-1 text-xs text-destructive">
          {problemOf(open.error, t`The file couldn't be opened. Try again.`)}
        </span>
      ) : null}
    </span>
  );
}

/** A hidden file picker behind a button. */
export function UploadButton({
  formats,
  multiple,
  disabled,
  busy,
  label,
  onChosen,
}: {
  readonly formats: readonly DocumentFormat[];
  readonly multiple: boolean;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly label: string;
  readonly onChosen: (files: readonly File[]) => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        tabIndex={-1}
        aria-hidden
        accept={acceptOf(formats)}
        multiple={multiple}
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = '';
          if (chosen.length > 0) onChosen(chosen);
        }}
      />
      <Button
        variant="secondary"
        size="small"
        disabled={disabled || busy}
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        {busy ? <Trans>Uploading…</Trans> : label}
      </Button>
    </>
  );
}
