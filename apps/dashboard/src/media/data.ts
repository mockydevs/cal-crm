// How Media Storage reaches the server: the keys its lists are kept under, and an upload
// sent so the page can show how far it is. The SDK sends with fetch, which says nothing
// while a body goes out; an upload here goes by XMLHttpRequest, to the same address, with
// the same headers.
import type { FileType, MediaKind, MediaSort } from '@repo/contracts';
import { failureOf, type UploadFailure } from './rules';

export interface MediaListFilter {
  /** A folder, the top of the library (null), or every folder (undefined). */
  readonly folderId: string | null | undefined;
  readonly search: string;
  readonly kind: MediaKind | undefined;
  readonly publicOnly: boolean;
  readonly sort: MediaSort;
}

export const mediaKeys = {
  all: (businessId: string) => ['b', businessId, 'media'] as const,
  list: (businessId: string, filter: MediaListFilter) =>
    ['b', businessId, 'media', 'files', filter] as const,
  folders: (businessId: string) => ['b', businessId, 'media', 'folders'] as const,
  usage: (businessId: string) => ['b', businessId, 'media', 'usage'] as const,
  file: (businessId: string, fileId: string) => ['b', businessId, 'media', 'file', fileId] as const,
};

/** What a list request sends: listMedia's query, as the contract has it. */
export interface MediaListQuery {
  readonly folder?: string;
  readonly search?: string;
  readonly kind?: MediaKind;
  readonly visibility?: 'public';
  readonly sort: MediaSort;
  readonly limit: number;
  readonly cursor?: string;
}

/** The query a list request sends for a filter. */
export function listQuery(filter: MediaListFilter, cursor: string | undefined): MediaListQuery {
  const searching = filter.search.trim() !== '';
  return {
    // A search and the public list read the whole library, whatever folder is open.
    ...(searching || filter.publicOnly || filter.folderId === undefined
      ? {}
      : { folder: filter.folderId ?? 'root' }),
    ...(searching ? { search: filter.search.trim() } : {}),
    ...(filter.kind === undefined ? {} : { kind: filter.kind }),
    ...(filter.publicOnly ? { visibility: 'public' as const } : {}),
    sort: filter.sort,
    limit: 50,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** What an upload takes back: the stored file, or problem details. */
const ACCEPT = 'application/json, application/problem+json';

export interface UploadRequest {
  readonly businessId: string;
  readonly file: Blob;
  readonly name: string;
  readonly type: FileType;
  readonly folderId: string | null;
  readonly onProgress: (sent: number) => void;
}

export type UploadOutcome =
  | { readonly ok: true; readonly fileId: string }
  | { readonly ok: false; readonly failure: UploadFailure | 'cancelled'; readonly detail?: string };

export interface RunningUpload {
  readonly done: Promise<UploadOutcome>;
  cancel(): void;
}

/** Sends one file into the library. It never rejects: every ending is an outcome. */
export function sendUpload(request: UploadRequest): RunningUpload {
  const query = new URLSearchParams({ filename: request.name, library: 'true' });
  if (request.folderId !== null) query.set('folder', request.folderId);
  const xhr = new XMLHttpRequest();
  const done = new Promise<UploadOutcome>((resolve) => {
    xhr.upload.addEventListener('progress', (event) => {
      request.onProgress(event.loaded);
    });
    xhr.addEventListener('load', () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText) as unknown;
      } catch {
        // A gateway's page, or nothing at all: the status says what there is to say.
        body = undefined;
      }
      if (xhr.status === 201 && typeof body === 'object' && body !== null && 'id' in body) {
        resolve({ ok: true, fileId: String(body.id) });
        return;
      }
      resolve({ ok: false, ...failureOf(xhr.status, body) });
    });
    xhr.addEventListener('error', () => {
      resolve({ ok: false, failure: 'connection' });
    });
    xhr.addEventListener('abort', () => {
      resolve({ ok: false, failure: 'cancelled' });
    });
  });
  xhr.open('POST', `/api/v1/files?${query.toString()}`);
  xhr.setRequestHeader('accept', ACCEPT);
  xhr.setRequestHeader('content-type', request.type);
  xhr.setRequestHeader('business-id', request.businessId);
  xhr.send(request.file);
  return {
    done,
    cancel() {
      xhr.abort();
    },
  };
}
