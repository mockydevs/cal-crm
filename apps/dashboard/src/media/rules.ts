// What Media Storage works out before it draws: which type a chosen file is and whether it
// may be uploaded, the folder trail, sizes in words' units, and the queue of uploads.
// Nothing here touches the browser or the server, so all of it is tested as plain
// functions.
import {
  fileTypes,
  mediaFileName,
  mediaKindOf,
  type FileType,
  type MediaFolder,
  type MediaKind,
} from '@repo/contracts';

/** What a browser calls a type the server knows under another name. */
const aliases: Readonly<Record<string, FileType>> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'application/csv': 'text/csv',
};

/** The type of a file a browser gave no type for, by the end of its name. */
const byExtension: Readonly<Record<string, FileType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
};

const isFileType = (type: string): type is FileType =>
  (fileTypes as readonly string[]).includes(type);

/**
 * The type to send a chosen file as: the browser's own name for it when the server takes
 * it, that name's usual spelling, or what the end of the file's name says. Undefined when
 * it is none the server stores. The server checks the bytes whatever is sent.
 */
export function uploadType(file: {
  readonly name: string;
  readonly type: string;
}): FileType | undefined {
  const given = file.type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (isFileType(given)) return given;
  const alias = aliases[given];
  if (alias !== undefined) return alias;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  // A spreadsheet program's name for a CSV file is believed only of a file named .csv.
  if (given === 'application/vnd.ms-excel') return extension === 'csv' ? 'text/csv' : undefined;
  // No type, or the name browsers give what they do not know: the end of the file's name.
  return given === '' || given === 'application/octet-stream' ? byExtension[extension] : undefined;
}

/** What a file input offers, for all files or for one group of them. */
export function acceptOf(kinds?: readonly MediaKind[]): string {
  return fileTypes
    .filter((type) => kinds === undefined || kinds.includes(mediaKindOf(type)))
    .join(',');
}

export type UploadRefusal = 'type' | 'too_large' | 'empty';

/** Why a chosen file is not sent at all, when the page already knows the server would refuse. */
export function refusalOf(
  file: { readonly name: string; readonly type: string; readonly size: number },
  limits: { readonly maxFileBytes: number | undefined; readonly kinds?: readonly MediaKind[] },
): UploadRefusal | undefined {
  const type = uploadType(file);
  if (type === undefined) return 'type';
  if (limits.kinds !== undefined && !limits.kinds.includes(mediaKindOf(type))) return 'type';
  if (file.size === 0) return 'empty';
  if (limits.maxFileBytes !== undefined && file.size > limits.maxFileBytes) return 'too_large';
  return undefined;
}

/** A size as a number and its unit, for the page to put in words: 1536 is 1.5 KB. */
export function sizeOf(bytes: number): {
  readonly value: string;
  readonly unit: 'B' | 'KB' | 'MB' | 'GB';
} {
  if (bytes < 1024) return { value: String(bytes), unit: 'B' };
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below ten, none above: 1.5 KB, 12 MB.
  const shown =
    value < 10
      ? (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, '')
      : String(Math.round(value));
  return { value: shown, unit: units[unit] ?? 'GB' };
}

/** What is wrong with a new name, in the API's own words, or undefined when it is fine. */
export function nameProblem(name: string): string | undefined {
  const parsed = mediaFileName.safeParse(name);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

/** A file's name without its last extension, and that extension with its dot. */
export function splitName(name: string): { readonly stem: string; readonly extension: string } {
  const at = name.lastIndexOf('.');
  return at <= 0
    ? { stem: name, extension: '' }
    : { stem: name.slice(0, at), extension: name.slice(at) };
}

/** The folders from the top of the library down to this one; none for the top itself. */
export function trailOf(folders: readonly MediaFolder[], folderId: string | null): MediaFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: MediaFolder[] = [];
  for (
    let at = folderId === null ? undefined : byId.get(folderId);
    at !== undefined && !trail.includes(at);
    at = at.parentId === null ? undefined : byId.get(at.parentId)
  )
    trail.unshift(at);
  return trail;
}

/** The folders directly inside one, or at the top, by name. */
export function childrenOf(
  folders: readonly MediaFolder[],
  folderId: string | null,
): MediaFolder[] {
  return folders
    .filter((folder) => folder.parentId === folderId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** A folder and everything inside it: where it can't be moved to. */
export function insideOf(folders: readonly MediaFolder[], folderId: string): Set<string> {
  const inside = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders)
      if (folder.parentId !== null && inside.has(folder.parentId) && !inside.has(folder.id)) {
        inside.add(folder.id);
        grew = true;
      }
  }
  return inside;
}

/** Every folder with how deep it sits, in the order a tree is read: for a "move to" list. */
export function folderOptions(
  folders: readonly MediaFolder[],
): { readonly id: string; readonly name: string; readonly depth: number }[] {
  const options: { id: string; name: string; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    if (depth > folders.length) return;
    for (const folder of childrenOf(folders, parentId)) {
      options.push({ id: folder.id, name: folder.name, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return options;
}

// The upload queue ---------------------------------------------------------------------

export type UploadFailure =
  | UploadRefusal
  /** The server's own refusal, in its words. */
  | 'refused'
  /** A gateway answered instead of the server (502 to 504). */
  | 'no_answer'
  | 'connection';

export interface UploadItem {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  /** Where it goes: a folder, or the top of the library. */
  readonly folderId: string | null;
  readonly state: 'waiting' | 'uploading' | 'done' | 'failed' | 'cancelled';
  /** Bytes sent so far. */
  readonly sent: number;
  readonly failure?: UploadFailure;
  /** The server's words for a refusal. */
  readonly detail?: string;
}

export type UploadEvent =
  | {
      readonly type: 'add';
      readonly items: readonly Pick<UploadItem, 'id' | 'name' | 'size' | 'folderId'>[];
    }
  | {
      readonly type: 'refuse';
      readonly item: Pick<UploadItem, 'id' | 'name' | 'size' | 'folderId'>;
      readonly failure: UploadRefusal;
    }
  | { readonly type: 'start'; readonly id: number }
  | { readonly type: 'progress'; readonly id: number; readonly sent: number }
  | { readonly type: 'done'; readonly id: number }
  | {
      readonly type: 'fail';
      readonly id: number;
      readonly failure: UploadFailure;
      readonly detail?: string;
    }
  | { readonly type: 'cancel'; readonly id: number }
  | { readonly type: 'retry'; readonly id: number }
  | { readonly type: 'clear' };

const change = (
  queue: readonly UploadItem[],
  id: number,
  next: (item: UploadItem) => UploadItem,
): UploadItem[] => queue.map((item) => (item.id === id ? next(item) : item));

/** The queue after something happened to it. An event for an upload that is over changes nothing. */
export function uploadQueue(queue: readonly UploadItem[], event: UploadEvent): UploadItem[] {
  switch (event.type) {
    case 'add':
      return [
        ...queue,
        ...event.items.map((item) => ({ ...item, state: 'waiting' as const, sent: 0 })),
      ];
    case 'refuse':
      return [...queue, { ...event.item, state: 'failed', sent: 0, failure: event.failure }];
    case 'start':
      return change(queue, event.id, (item) =>
        item.state === 'waiting' ? { ...item, state: 'uploading' } : item,
      );
    case 'progress':
      return change(queue, event.id, (item) =>
        item.state === 'uploading'
          ? { ...item, sent: Math.max(item.sent, Math.min(event.sent, item.size)) }
          : item,
      );
    case 'done':
      return change(queue, event.id, (item) =>
        item.state === 'uploading' ? { ...item, state: 'done', sent: item.size } : item,
      );
    case 'fail':
      return change(queue, event.id, (item) =>
        item.state === 'uploading' || item.state === 'waiting'
          ? {
              ...item,
              state: 'failed',
              failure: event.failure,
              ...(event.detail === undefined ? {} : { detail: event.detail }),
            }
          : item,
      );
    case 'cancel':
      return change(queue, event.id, (item) =>
        item.state === 'uploading' || item.state === 'waiting'
          ? { ...item, state: 'cancelled' }
          : item,
      );
    case 'retry':
      return change(queue, event.id, (item) =>
        // A file the page itself refused would be refused again.
        item.state === 'failed' && !isRefusal(item.failure)
          ? {
              id: item.id,
              name: item.name,
              size: item.size,
              folderId: item.folderId,
              state: 'waiting',
              sent: 0,
            }
          : item.state === 'cancelled'
            ? { ...item, state: 'waiting', sent: 0 }
            : item,
      );
    case 'clear':
      return queue.filter((item) => item.state === 'waiting' || item.state === 'uploading');
  }
}

const isRefusal = (failure: UploadFailure | undefined): boolean =>
  failure === 'type' || failure === 'too_large' || failure === 'empty';

/** Whether sending it again could go differently. */
export function canRetry(item: UploadItem): boolean {
  return item.state === 'cancelled' || (item.state === 'failed' && !isRefusal(item.failure));
}

/** The uploads to start now, so that at most `limit` run at once, oldest first. */
export function nextUploads(queue: readonly UploadItem[], limit: number): UploadItem[] {
  const running = queue.filter((item) => item.state === 'uploading').length;
  return queue.filter((item) => item.state === 'waiting').slice(0, Math.max(0, limit - running));
}

/** How far an upload is, as a whole percentage. */
export function percentOf(item: UploadItem): number {
  if (item.state === 'done') return 100;
  return item.size === 0 ? 0 : Math.min(100, Math.floor((item.sent / item.size) * 100));
}

/** Why the server did not take an upload, from its answer's status and body. */
export function failureOf(
  status: number,
  body: unknown,
): { readonly failure: UploadFailure; readonly detail?: string } {
  if (status === 0) return { failure: 'connection' };
  if (status >= 502 && status <= 504) return { failure: 'no_answer' };
  if (status === 413) return { failure: 'too_large' };
  const code =
    typeof body === 'object' && body !== null && 'errors' in body && Array.isArray(body.errors)
      ? (body.errors as { code?: unknown }[])[0]?.code
      : undefined;
  if (code === 'unsupported_type' || code === 'type_mismatch') return { failure: 'type' };
  const detail =
    typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string'
      ? body.detail
      : undefined;
  return { failure: 'refused', ...(detail === undefined ? {} : { detail }) };
}
