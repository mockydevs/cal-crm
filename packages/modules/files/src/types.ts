// The types a file may have (widened for the media library): a short list, and
// images, PDFs, videos and sounds must start with their format's signature, so a renamed
// file can't pass as one. SVG and HTML are refused, because a browser runs the scripts they
// can carry.
import type { FileType } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';

/** Bytes at an offset, or undefined for any value there. */
type Pattern = readonly (number | undefined)[];

const ascii = (text: string): Pattern => Array.from(Buffer.from(text, 'ascii'));

interface Allowed {
  /** Any one of these must match the file's first bytes; none means no check. */
  readonly signatures: readonly Pattern[];
  /** Shown in the browser rather than downloaded: raster images only. */
  readonly inline: boolean;
}

const any = undefined;
// ISO base media (ISO/IEC 14496-12): a box's four-byte length, then its type, "ftyp".
const isoMedia: Pattern = [any, any, any, any, ...ascii('ftyp')];
// An MPEG audio frame starts with eleven set bits; a file with an ID3v2 tag with "ID3".
const mpegAudio: readonly Pattern[] = [
  ascii('ID3'),
  [0xff, 0xfb],
  [0xff, 0xfa],
  [0xff, 0xf3],
  [0xff, 0xf2],
];

const allowed: ReadonlyMap<string, Allowed> = new Map(
  Object.entries({
    // PNG (RFC 2083, section 3.1): 137 80 78 71 13 10 26 10.
    'image/png': { signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], inline: true },
    // JPEG: the start-of-image marker FF D8, then the next marker's FF.
    'image/jpeg': { signatures: [[0xff, 0xd8, 0xff]], inline: true },
    // GIF: "GIF87a" or "GIF89a".
    'image/gif': { signatures: [ascii('GIF87a'), ascii('GIF89a')], inline: true },
    // WebP (RFC 9649): a RIFF container, its length, then "WEBP".
    'image/webp': {
      signatures: [
        [...ascii('RIFF'), undefined, undefined, undefined, undefined, ...ascii('WEBP')],
      ],
      inline: true,
    },
    // PDF (ISO 32000): "%PDF-".
    'application/pdf': { signatures: [ascii('%PDF-')], inline: false },
    'text/plain': { signatures: [], inline: false },
    'text/csv': { signatures: [], inline: false },
    'video/mp4': { signatures: [isoMedia], inline: false },
    // WebM is Matroska, which is EBML (RFC 8794): 1A 45 DF A3.
    'video/webm': { signatures: [[0x1a, 0x45, 0xdf, 0xa3]], inline: false },
    'audio/mpeg': { signatures: mpegAudio, inline: false },
    // WAVE: a RIFF container, its length, then "WAVE".
    'audio/wav': {
      signatures: [[...ascii('RIFF'), any, any, any, any, ...ascii('WAVE')]],
      inline: false,
    },
    // Ogg (RFC 3533): every page starts with "OggS".
    'audio/ogg': { signatures: [ascii('OggS')], inline: false },
    'audio/mp4': { signatures: [isoMedia], inline: false },
  } satisfies Record<FileType, Allowed>),
);

/** How many of a file's first bytes the check needs. */
export const HEAD_BYTES = 12;

function matches(head: Uint8Array, pattern: Pattern): boolean {
  return (
    head.length >= pattern.length &&
    pattern.every((byte, at) => byte === undefined || head[at] === byte)
  );
}

/**
 * The file's type, from the one it was sent with (a Content-Type, parameters ignored), when
 * it's on the list and its first bytes agree.
 */
export function checkType(
  declared: string | undefined,
  head: Uint8Array,
): { contentType: string; inline: boolean } {
  const contentType = declared?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const type = allowed.get(contentType);
  if (type === undefined) {
    throw new ValidationError([
      {
        path: '',
        code: 'unsupported_type',
        message:
          'Upload a PNG, JPEG, GIF or WebP image, an MP4 or WebM video, an MP3, WAV, Ogg or M4A sound, a PDF, or a plain text or CSV file.',
      },
    ]);
  }
  if (type.signatures.length > 0 && !type.signatures.some((pattern) => matches(head, pattern))) {
    throw new ValidationError([
      {
        path: '',
        code: 'type_mismatch',
        message: `The file isn't the ${contentType} it says it is.`,
      },
    ]);
  }
  return { contentType, inline: type.inline };
}

/** Whether a stored file of this type is shown in the browser rather than downloaded. */
export function showsInline(contentType: string): boolean {
  return allowed.get(contentType)?.inline ?? false;
}
