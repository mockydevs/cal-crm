// The media library's rules that need no database: how a page is ordered and continued, how
// a search and a type filter read a row, and which bytes a request for a range gets.
import { mediaSorts, type MediaKind, type MediaSort } from '@repo/contracts';
import type { ByteRange } from '@repo/storage';

/** What a sort orders by, and how its value is read back from a cursor. */
export interface SortSpec {
  /** The expression, on files.files as f. One of a fixed list: never a caller's text. */
  readonly expression: 'f.updated_at' | 'lower(f.filename)' | 'f.size_bytes';
  readonly cast: 'timestamptz' | 'text' | 'bigint';
  readonly direction: 'asc' | 'desc';
}

export const sortSpecs: Readonly<Record<MediaSort, SortSpec>> = {
  modified_desc: { expression: 'f.updated_at', cast: 'timestamptz', direction: 'desc' },
  modified_asc: { expression: 'f.updated_at', cast: 'timestamptz', direction: 'asc' },
  name_asc: { expression: 'lower(f.filename)', cast: 'text', direction: 'asc' },
  name_desc: { expression: 'lower(f.filename)', cast: 'text', direction: 'desc' },
  size_desc: { expression: 'f.size_bytes', cast: 'bigint', direction: 'desc' },
  size_asc: { expression: 'f.size_bytes', cast: 'bigint', direction: 'asc' },
};

/** Where a page ended: the sort it was read in, the last row's sort value and its id. */
export interface Cursor {
  readonly sort: MediaSort;
  /** The value as Postgres wrote it as text, so it compares exactly when cast back. */
  readonly value: string;
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.sort, cursor.value, cursor.id])).toString('base64url');
}

/** The cursor, or undefined when the text is not one this server wrote. */
export function decodeCursor(text: string): Cursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
  const [sort, value, id] = parsed as unknown[];
  const known = mediaSorts.find((name) => name === sort);
  if (known === undefined || typeof value !== 'string' || typeof id !== 'string') return undefined;
  if (!UUID.test(id)) return undefined;
  return { sort: known, value, id };
}

/** A search's text as a LIKE pattern that matches it anywhere, its own % and _ taken literally. */
export function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The stored types of a group, as LIKE patterns; a document is whatever matches none. */
export const kindPatterns: Readonly<Record<Exclude<MediaKind, 'document'>, string>> = {
  image: 'image/%',
  video: 'video/%',
  audio: 'audio/%',
};

/** Whether a browser shows the type in a page: what a preview address is made for. */
export function previewable(contentType: string): boolean {
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/') ||
    contentType === 'application/pdf'
  );
}

/** Whether a public address shows the type in place rather than downloading it. */
export function publicInline(contentType: string): boolean {
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/')
  );
}

/**
 * The bytes a Range header asks for of a body of this size (RFC 9110, section 14.1.2):
 * one range of bytes, clamped to the body. Undefined when there is no header, or one this
 * server does not serve in part (another unit, several ranges, not a range at all): the
 * whole body is the answer then, as the RFC allows. 'unsatisfiable' when the range lies
 * past the end, which is a 416.
 */
export function rangeOf(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (match === null) return undefined;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return undefined;
  if (first === '') {
    // The last n bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return undefined;
  return { start, end };
}

/** The moment a preview address is signed from: the hour's start, so it is the same all hour. */
export function previewSignedFrom(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
}

/** How long a preview address lasts from there: between one and two hours from now. */
export const PREVIEW_SECONDS = 2 * 60 * 60;
