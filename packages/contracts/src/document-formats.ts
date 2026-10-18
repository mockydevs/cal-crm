// The formats a record's documents may have, and how a file's name says its format. Plain
// values with no schema, so the field settings can name them without the files API.

/**
 * The formats a record's documents may have: GoHighLevel's list for a file upload field
 * (PDF, Word, JPEG, PNG, GIF, CSV and Excel). A file's format is read from its name and
 * checked against its first bytes, never taken from the type a browser sent.
 */
export const documentFormats = [
  'pdf',
  'doc',
  'docx',
  'jpg',
  'png',
  'gif',
  'csv',
  'xls',
  'xlsx',
] as const;
export type DocumentFormat = (typeof documentFormats)[number];

/** The type a stored document of each format is kept and served as. */
export const documentContentTypes: Readonly<Record<DocumentFormat, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  csv: 'text/csv',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The format a file name says, by its extension, or undefined for any other name. */
export function documentFormatOf(filename: string): DocumentFormat | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  const format = extension === 'jpeg' ? 'jpg' : extension;
  return documentFormats.find((each) => each === format);
}

/** The most files one file upload field holds on a record. */
export const MAX_FIELD_FILES = 10;
