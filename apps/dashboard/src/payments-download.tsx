// The PDF of a quote, an invoice or a receipt, saved as a file. The server draws it and
// names it (INV-0007.pdf); the bytes the SDK hands back are saved through a link that
// exists only for the click. What happened is said by the page that holds the button:
// `onDone` and `onFailed` are handed the words.
import { useLingui } from '@lingui/react/macro';
import {
  getReceiptPdf,
  getSalesDocumentPdf,
  printedFileName,
  type FileDownload,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { ReactElement } from 'react';
import { apiIn } from './api';
import { iconButtonClassName } from './settings-list';
import { useBusiness } from './workspace';

/** Saves a file the API answered with, under the server's name for it. Returns that name. */
export function saveFile(file: FileDownload, fallbackName: string): string {
  const name = file.filename === '' ? fallbackName : file.filename;
  const url = URL.createObjectURL(
    new Blob([file.content], {
      type: file.contentType === '' ? 'application/pdf' : file.contentType,
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Once the browser has taken the click: the address is of no use to anyone after it.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
  return name;
}

export interface PdfSource {
  readonly of: 'quote' | 'invoice' | 'receipt';
  readonly id: string;
  /** Its number, or null for a draft that has none yet. */
  readonly number: string | null;
}

/** Downloads a PDF and says what happened through the page that asked. */
export function useDownloadPdf({
  onDone,
  onFailed,
}: {
  readonly onDone: (message: string) => void;
  readonly onFailed: (message: string) => void;
}): { readonly run: (source: PdfSource) => void; readonly pending: boolean } {
  const { t } = useLingui();
  const business = useBusiness();
  const download = useMutation({
    mutationFn: (source: PdfSource) => {
      const api = apiIn(business.id);
      const params = { params: { id: source.id } };
      return source.of === 'receipt'
        ? api.request(getReceiptPdf, params)
        : api.request(getSalesDocumentPdf, params);
    },
    onSuccess: (file, source) => {
      // The server names it; should it not, the name the server would have given.
      const name = saveFile(
        file,
        printedFileName(source.number, source.of === 'receipt' ? 'receipt' : `${source.of}-draft`),
      );
      onDone(t`Downloaded ${name}.`);
    },
    onError: (error) => {
      const fallback = t`The PDF wasn't downloaded. Check your connection and try again.`;
      onFailed(error instanceof ApiError ? (error.problem.detail ?? fallback) : fallback);
    },
  });
  return { run: download.mutate, pending: download.isPending };
}

/**
 * The button that downloads a PDF: with its words on a page, or as an icon in a row
 * (`label` is then what a screen reader calls it).
 */
export function DownloadPdf({
  source,
  label,
  icon = false,
  onDone,
  onFailed,
}: {
  readonly source: PdfSource;
  readonly label: string;
  readonly icon?: boolean;
  readonly onDone: (message: string) => void;
  readonly onFailed: (message: string) => void;
}): ReactElement {
  const download = useDownloadPdf({ onDone, onFailed });
  const run = (): void => {
    download.run(source);
  };
  if (icon)
    return (
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={label}
        title={label}
        disabled={download.pending}
        onClick={run}
      >
        <Download aria-hidden className="size-4" strokeWidth={1.8} />
      </button>
    );
  return (
    <Button variant="secondary" disabled={download.pending} onClick={run}>
      <Download aria-hidden className="size-4" strokeWidth={1.8} />
      {label}
    </Button>
  );
}
