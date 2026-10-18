// A record's documents: PDFs, Word and Excel files, pictures and CSV. A document's format is
// read from its name, must be one the caller allows, and its first bytes must be that
// format's: the type a browser sends is never trusted (a CSV often comes as Excel's). The
// file is then stored under the format's own type.
import { documentContentTypes, documentFormatOf, type DocumentFormat } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';

/** Bytes at an offset, or undefined for any value there. */
type Pattern = readonly (number | undefined)[];

const ascii = (text: string): Pattern => Array.from(Buffer.from(text, 'ascii'));
// A ZIP archive's local file header (PKWARE APPNOTE 4.3.7): Word and Excel files since 2007.
const zip: Pattern = [0x50, 0x4b, 0x03, 0x04];
// A Compound File Binary (MS-CFB 2.2): Word 97-2003 and Excel 97-2003 files.
const compound: Pattern = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const signatures: Readonly<Record<DocumentFormat, readonly Pattern[]>> = {
  pdf: [ascii('%PDF-')],
  doc: [compound],
  docx: [zip],
  jpg: [[0xff, 0xd8, 0xff]],
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  gif: [ascii('GIF87a'), ascii('GIF89a')],
  // Text has no signature; a NUL byte says it is not text.
  csv: [],
  xls: [compound],
  xlsx: [zip],
};

/**
 * Whether a CSV's first bytes can be a table: text, so no NUL byte, and not markup, which
 * a browser could read as a page: nothing but white space before a '<'.
 */
function isTable(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  const first = head.find(
    (byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d,
  );
  return first !== 0x3c;
}

/** How many of a file's first bytes the check needs. */
export const DOCUMENT_HEAD_BYTES = 512;

const matches = (head: Uint8Array, pattern: Pattern): boolean =>
  head.length >= pattern.length &&
  pattern.every((byte, at) => byte === undefined || head[at] === byte);

const formatNames: Readonly<Record<DocumentFormat, string>> = {
  pdf: 'PDF',
  doc: 'DOC',
  docx: 'DOCX',
  jpg: 'JPG',
  png: 'PNG',
  gif: 'GIF',
  csv: 'CSV',
  xls: 'XLS',
  xlsx: 'XLSX',
};

/**
 * The format and stored type of a document named filename whose first bytes are head,
 * when its name's extension is one of the formats allowed and the bytes agree.
 */
export function checkDocument(
  filename: string,
  head: Uint8Array,
  allowed: readonly DocumentFormat[],
): { format: DocumentFormat; contentType: string } {
  const format = documentFormatOf(filename);
  if (format === undefined || !allowed.includes(format))
    throw new ValidationError([
      {
        path: '/filename',
        code: 'unsupported_type',
        message: `Upload a file of one of these formats: ${allowed.map((each) => formatNames[each]).join(', ')}.`,
      },
    ]);
  const patterns = signatures[format];
  const agrees =
    patterns.length === 0 ? isTable(head) : patterns.some((pattern) => matches(head, pattern));
  if (!agrees)
    throw new ValidationError([
      {
        path: '/filename',
        code: 'type_mismatch',
        message: `The file isn't the ${formatNames[format]} file its name says it is.`,
      },
    ]);
  return { format, contentType: documentContentTypes[format] };
}
