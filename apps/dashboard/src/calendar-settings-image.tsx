// The drop zone for a calendar's logo or cover, apart from the other shared pieces
// (calendar-settings-parts.tsx) so that only the two sections that show it fetch it, with
// the Media Storage calls it makes.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createFileLink,
  getMediaFile,
  updateMediaFile,
  uploadFile,
  type MediaFile,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UploadCloud } from 'lucide-react';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { labelClassName, noteClassName, Problem } from './calendar-settings-parts';
import { imageAccept, imageMegabytes, imageProblem } from './calendar-settings-rules';

/** A refusal in the server's words, or `fallback`. */
function refusalOf(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? fallback)
    : fallback;
}

/**
 * Where a logo or a cover is chosen or dropped. The public booking page shows it, so it is
 * uploaded into Media Storage and given a public address at once, as a site's picture is;
 * the form keeps its id, and the picture shown here is read back through a link to the
 * stored file. A picture that is private, or that was stored outside Media Storage, is not
 * on the page, and the zone says so with what to do.
 */
export function ImageDrop({
  client,
  businessId,
  label,
  hint,
  alt,
  fileId,
  disabled,
  onChange,
}: {
  readonly client: Client;
  readonly businessId: string;
  readonly label: string;
  /** Under the zone: the formats, the size and the dimensions that suit it. */
  readonly hint: ReactNode;
  /** What the picture shown is, such as "Calendar logo preview". */
  readonly alt: string;
  readonly fileId: string | null;
  readonly disabled: boolean;
  readonly onChange: (fileId: string | null) => void;
}): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [problem, setProblem] = useState<string>();
  const preview = useQuery({
    queryKey: ['calendar-image', businessId, fileId],
    queryFn: () =>
      client.request(createFileLink, { params: { id: fileId ?? '' }, body: { expiresIn: 3600 } }),
    enabled: fileId !== null,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  // Whether the booking page can show it: only a Media Storage file with a public address.
  const media = useQuery({
    queryKey: ['calendar-image-media', businessId, fileId],
    queryFn: () => client.request(getMediaFile, { params: { id: fileId ?? '' } }),
    enabled: fileId !== null,
    retry: false,
  });
  const cache = useQueryClient();
  const known = (file: MediaFile): void => {
    void cache.invalidateQueries({ queryKey: ['calendar-image-media', businessId, file.id] });
  };
  const notPublic = t`The image is saved, but it couldn't be given a public address, so the booking page doesn't show it.`;
  const publish = useMutation({
    mutationFn: (fileId: string) =>
      client.request(updateMediaFile, { params: { id: fileId }, body: { public: true } }),
    onSuccess: known,
    onError: (error) => {
      setProblem(`${notPublic} ${refusalOf(error, t`Try again.`)}`);
    },
  });
  const upload = useMutation({
    mutationFn: (file: File) =>
      client.request(uploadFile, {
        query: { filename: file.name, library: 'true' },
        upload: { content: file, type: file.type },
      }),
    onSuccess: (stored) => {
      onChange(stored.id);
      publish.mutate(stored.id);
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? refusalOf(error, t`The image wasn't uploaded. Try again.`)
          : t`The image wasn't uploaded. Check your connection and try again.`,
      );
    },
  });
  const off = disabled || upload.isPending || publish.isPending;
  const gone = media.error instanceof ApiError && media.error.status === 404;
  const megabytes = imageMegabytes;
  const take = (file: File | undefined): void => {
    if (file === undefined || off) return;
    const refused = imageProblem(file);
    if (refused !== undefined) {
      setProblem(
        refused === 'size'
          ? t`That image is bigger than ${megabytes} MB. Choose a smaller one.`
          : t`Choose a PNG, JPEG, GIF or WebP image.`,
      );
      return;
    }
    setProblem(undefined);
    upload.mutate(file);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={`${id}-label`} className={labelClassName}>
        {label}
      </span>
      <div
        className={`relative flex min-w-0 flex-col items-center gap-2 rounded-lg border border-dashed border-input bg-card px-4 py-6 text-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${
          off ? 'opacity-60' : 'hover:bg-muted'
        }`}
      >
        {fileId !== null && preview.data !== undefined ? (
          <img
            src={preview.data.url}
            alt={alt}
            className="max-h-24 max-w-full rounded-lg object-contain"
          />
        ) : (
          <span className="flex size-11 items-center justify-center rounded-full bg-muted text-body">
            <UploadCloud aria-hidden className="size-5" strokeWidth={1.8} />
          </span>
        )}
        <span className="text-sm text-body">
          <Trans>
            <span className="font-medium text-link">Click to upload</span> or drag and drop
          </Trans>
        </span>
        <span id={`${id}-hint`} className="text-xs text-body">
          {hint}
        </span>
        <input
          id={id}
          type="file"
          accept={imageAccept}
          // Over the whole zone, so a press anywhere on it opens the picker and a file
          // dropped anywhere on it is taken, as the browser's own file input does.
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          disabled={off}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // The same file can be chosen again after a refusal.
            event.target.value = '';
            take(file);
          }}
        />
      </div>
      {upload.isPending ? (
        <p role="status" className={noteClassName}>
          <Trans>Uploading…</Trans>
        </p>
      ) : null}
      {fileId !== null && preview.isError ? (
        <p className={noteClassName}>
          <Trans>The image is saved, but its preview couldn't be loaded.</Trans>
        </p>
      ) : null}
      {fileId === null || upload.isPending || publish.isPending ? null : media.data?.public ===
        true ? (
        <p className={noteClassName}>
          <Trans>
            Shown on the booking page. It's in Media Storage, at an address anyone can open.
          </Trans>
        </p>
      ) : media.data?.public === false ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <p className={noteClassName}>
            <Trans>
              This image is private in Media Storage, so the booking page doesn't show it.
            </Trans>
          </p>
          {disabled ? null : (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                setProblem(undefined);
                publish.mutate(fileId);
              }}
            >
              <Trans>Make it public</Trans>
            </Button>
          )}
        </div>
      ) : gone ? (
        <p className={noteClassName}>
          <Trans>
            This image isn't in Media Storage, so the booking page doesn't show it. Upload it again
            to show it.
          </Trans>
        </p>
      ) : null}
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      {fileId === null || disabled ? null : (
        <Button
          variant="quiet"
          size="small"
          className="self-start"
          disabled={off}
          onClick={() => {
            setProblem(undefined);
            onChange(null);
          }}
        >
          <Trans>Remove image</Trans>
        </Button>
      )}
    </div>
  );
}
