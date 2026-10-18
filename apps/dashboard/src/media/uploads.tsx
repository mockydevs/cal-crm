// Uploads into the media library: the queue a page keeps while files go up, two at a time,
// and the rows that show how far each one is, with a way to stop it and plain words for why
// one failed.
import { Trans, useLingui } from '@lingui/react/macro';
import type { MediaKind } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { CircleAlert, CircleCheck, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, type ReactElement } from 'react';
import { sendUpload, type RunningUpload, type UploadRequest } from './data';
import {
  canRetry,
  nextUploads,
  percentOf,
  refusalOf,
  sizeOf,
  uploadQueue,
  uploadType,
  type UploadItem,
} from './rules';

/** How many files go up at once. */
const TOGETHER = 2;

export interface Uploads {
  readonly queue: readonly UploadItem[];
  /** Queues files for a folder, or the top of the library. */
  add(files: readonly File[], folderId: string | null): void;
  cancel(id: number): void;
  retry(id: number): void;
  /** Forgets everything that is over. */
  clear(): void;
}

export function useUploads(options: {
  readonly businessId: string;
  /** The largest file the server takes, once the page knows it. */
  readonly maxFileBytes: number | undefined;
  /** Only these groups of types, for a picker that wants pictures alone. */
  readonly kinds?: readonly MediaKind[] | undefined;
  /** Told each file's id as the server stores it. */
  readonly onUploaded: (fileId: string) => void;
  /** Replaced in tests. */
  readonly send?: (request: UploadRequest) => RunningUpload;
}): Uploads {
  const { businessId, maxFileBytes, kinds, onUploaded, send = sendUpload } = options;
  const [queue, dispatch] = useReducer(uploadQueue, []);
  const nextIdRef = useRef(1);
  const filesRef = useRef(new Map<number, File>());
  const runningRef = useRef(new Map<number, RunningUpload>());
  const uploadedRef = useRef(onUploaded);
  useEffect(() => {
    uploadedRef.current = onUploaded;
  }, [onUploaded]);

  useEffect(() => {
    for (const item of nextUploads(queue, TOGETHER)) {
      const file = filesRef.current.get(item.id);
      const type = file === undefined ? undefined : uploadType(file);
      if (file === undefined || type === undefined || runningRef.current.has(item.id)) continue;
      dispatch({ type: 'start', id: item.id });
      const upload = send({
        businessId,
        file,
        name: item.name,
        type,
        folderId: item.folderId,
        onProgress: (sent) => {
          dispatch({ type: 'progress', id: item.id, sent });
        },
      });
      runningRef.current.set(item.id, upload);
      void upload.done.then((outcome) => {
        runningRef.current.delete(item.id);
        if (outcome.ok) {
          dispatch({ type: 'done', id: item.id });
          uploadedRef.current(outcome.fileId);
        } else if (outcome.failure !== 'cancelled') {
          dispatch({
            type: 'fail',
            id: item.id,
            failure: outcome.failure,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          });
        }
      });
    }
  }, [queue, businessId, send]);

  // A page that goes away takes its uploads with it.
  useEffect(() => {
    const uploads = runningRef.current;
    return () => {
      for (const upload of uploads.values()) upload.cancel();
    };
  }, []);

  const add = useCallback(
    (chosen: readonly File[], folderId: string | null) => {
      const accepted: { id: number; name: string; size: number; folderId: string | null }[] = [];
      for (const file of chosen) {
        const item = { id: nextIdRef.current, name: file.name, size: file.size, folderId };
        nextIdRef.current += 1;
        const refusal = refusalOf(file, {
          maxFileBytes,
          ...(kinds === undefined ? {} : { kinds }),
        });
        if (refusal !== undefined) {
          dispatch({ type: 'refuse', item, failure: refusal });
          continue;
        }
        filesRef.current.set(item.id, file);
        accepted.push(item);
      }
      if (accepted.length > 0) dispatch({ type: 'add', items: accepted });
    },
    [maxFileBytes, kinds],
  );
  const cancel = useCallback((id: number) => {
    dispatch({ type: 'cancel', id });
    runningRef.current.get(id)?.cancel();
  }, []);
  const retry = useCallback((id: number) => {
    dispatch({ type: 'retry', id });
  }, []);
  const clear = useCallback(() => {
    dispatch({ type: 'clear' });
  }, []);
  return { queue, add, cancel, retry, clear };
}

/** A size in words: 1.5 KB. */
export function useSizeWords(): (bytes: number) => string {
  const { t } = useLingui();
  return (bytes) => {
    const { value, unit } = sizeOf(bytes);
    if (unit === 'B') return t`${value} bytes`;
    if (unit === 'KB') return t`${value} KB`;
    if (unit === 'MB') return t`${value} MB`;
    return t`${value} GB`;
  };
}

function useFailureWords(maxFileBytes: number | undefined): (item: UploadItem) => string {
  const { t } = useLingui();
  const sizeWords = useSizeWords();
  return ({ failure, detail }) => {
    if (failure === 'type')
      return t`This type of file can't be uploaded here. Use a PNG, JPEG, GIF or WebP image, an MP4 or WebM video, an MP3, WAV, Ogg or M4A sound, a PDF, or a text or CSV file.`;
    if (failure === 'too_large') {
      if (maxFileBytes === undefined) return t`This file is too large to upload.`;
      const limit = sizeWords(maxFileBytes);
      return t`This file is too large. The limit is ${limit}.`;
    }
    if (failure === 'empty') return t`This file is empty, so there is nothing to upload.`;
    if (failure === 'no_answer')
      return t`The server didn't answer just then, so this file wasn't uploaded. Wait a moment and try again.`;
    if (failure === 'connection')
      return t`The upload didn't get through. Check your connection and try again.`;
    // The server's own refusal, in its words when it gave any.
    return detail ?? t`The server didn't take this file.`;
  };
}

/** The uploads of this visit to the page, newest last; nothing when there are none. */
export function UploadList({
  uploads,
  maxFileBytes,
}: {
  readonly uploads: Uploads;
  readonly maxFileBytes: number | undefined;
}): ReactElement | null {
  const { t } = useLingui();
  const sizeWords = useSizeWords();
  const failureWords = useFailureWords(maxFileBytes);
  const { queue } = uploads;
  if (queue.length === 0) return null;
  const active = queue.filter((item) => item.state === 'waiting' || item.state === 'uploading');
  const over = queue.length - active.length;
  const count = active.length;
  return (
    <section
      aria-label={t`Uploads`}
      className="flex flex-col gap-2 rounded-card border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {count > 0 ? (
            count === 1 ? (
              <Trans>Uploading 1 file</Trans>
            ) : (
              <Trans>Uploading {count} files</Trans>
            )
          ) : (
            <Trans>Uploads</Trans>
          )}
        </h2>
        {over > 0 ? (
          <Button
            variant="quiet"
            size="small"
            onClick={() => {
              uploads.clear();
            }}
          >
            <Trans>Clear finished</Trans>
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1.5">
        {queue.map((item) => {
          const percent = percentOf(item);
          const name = item.name;
          return (
            <li
              key={item.id}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-secondary/50 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 basis-40 truncate font-medium" title={name}>
                {name}
              </span>
              <span className="shrink-0 text-muted-foreground">{sizeWords(item.size)}</span>
              {item.state === 'uploading' || item.state === 'waiting' ? (
                <>
                  <span
                    role="progressbar"
                    aria-label={t`Upload of ${name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    className="h-1.5 min-w-24 flex-1 basis-32 overflow-hidden rounded-full bg-border"
                  >
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${String(percent)}%` }}
                    />
                  </span>
                  <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
                    {item.state === 'waiting' ? <Trans>Waiting</Trans> : `${String(percent)}%`}
                  </span>
                  <Button
                    variant="quiet"
                    size="small"
                    className="px-2.5"
                    aria-label={t`Cancel upload of ${name}`}
                    onClick={() => {
                      uploads.cancel(item.id);
                    }}
                  >
                    <X aria-hidden className="size-4" strokeWidth={1.8} />
                  </Button>
                </>
              ) : item.state === 'done' ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-success">
                  <CircleCheck aria-hidden className="size-4" strokeWidth={1.8} />
                  <Trans>Uploaded</Trans>
                </span>
              ) : (
                <>
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    {item.state === 'cancelled' ? (
                      <Trans>Cancelled</Trans>
                    ) : (
                      <>
                        <CircleAlert
                          aria-hidden
                          className="size-4 text-destructive"
                          strokeWidth={1.8}
                        />
                        <span className="text-destructive">
                          <Trans>Not uploaded</Trans>
                        </span>
                      </>
                    )}
                  </span>
                  {canRetry(item) ? (
                    <Button
                      variant="quiet"
                      size="small"
                      aria-label={t`Try uploading ${name} again`}
                      onClick={() => {
                        uploads.retry(item.id);
                      }}
                    >
                      <RotateCcw aria-hidden className="size-4" strokeWidth={1.8} />
                      <Trans>Try again</Trans>
                    </Button>
                  ) : null}
                  {item.state === 'failed' ? (
                    <p role="alert" className="basis-full text-sm text-destructive">
                      {failureWords(item)}
                    </p>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
