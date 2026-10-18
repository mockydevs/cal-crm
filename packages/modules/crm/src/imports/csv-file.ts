// A stored file's bytes, read as the rows of a CSV file, a piece at a time: the file is
// never held whole, whatever its size. What is taken, and what is refused by name:
// - UTF-8, with or without a byte order mark. Bytes that are not UTF-8 (a file saved as
//   UTF-16, or as Windows-1252 with accented letters) are refused, never guessed at: a
//   wrong guess would store the wrong letters in thousands of contacts.
// - The delimiter is read from the first row unless the caller names it.
// - The first row is the header. A row with nothing in it is no row: it is not counted,
//   but it keeps its number, so a row's number is the one a spreadsheet shows.
// - A row may have fewer cells than the header (the rest are empty) and never more: a
//   comma inside an unquoted value shifts every column after it, and importing that would
//   put values in the wrong fields.
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
  MAX_IMPORT_CELL_LENGTH,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROW_LENGTH,
  MAX_IMPORT_ROWS,
} from '@repo/contracts';
import {
  createCsvParser,
  CsvError,
  detectCsvDelimiter,
  type CsvDelimiter,
  type CsvErrorCode,
  type CsvRecord,
} from '@repo/kernel';

export interface CsvFileLimits {
  /** Rows of data: the header and blank rows are not counted. */
  readonly rows: number;
  readonly columns: number;
  readonly cellLength: number;
  readonly rowLength: number;
}

export const IMPORT_FILE_LIMITS: CsvFileLimits = {
  rows: MAX_IMPORT_ROWS,
  columns: MAX_IMPORT_COLUMNS,
  cellLength: MAX_IMPORT_CELL_LENGTH,
  rowLength: MAX_IMPORT_ROW_LENGTH,
};

export type ImportFileProblem =
  CsvErrorCode | 'not_utf8' | 'nul_character' | 'header_missing' | 'too_many_rows';

/** Why a file can't be imported at all, and the row that shows it when one does. */
export class ImportFileError extends Error {
  override readonly name = 'ImportFileError';
  readonly code: ImportFileProblem;
  readonly row: number | undefined;

  constructor(code: ImportFileProblem, message: string, row?: number) {
    super(message);
    this.code = code;
    this.row = row;
  }
}

/** One row of data. */
export interface CsvRow {
  /** Its number in the file, as a spreadsheet shows it: the header is row 1. */
  readonly row: number;
  /** Its place among the rows of data, from 0: blank rows are not counted. */
  readonly index: number;
  /** As many cells as the row has: fewer than the header's, or more. Not trimmed. */
  readonly cells: readonly string[];
}

export interface CsvFile {
  readonly delimiter: CsvDelimiter;
  /** The first row's cells, trimmed. */
  readonly header: readonly string[];
  /** The rows of data, in the file's order. Read it once, to its end or not. */
  rows(): AsyncGenerator<CsvRow, void, void>;
  /** Stops reading and lets go of the file. Safe to call at any point, and twice. */
  close(): void;
}

// How much of the file is looked at to find the delimiter: its first row, or this much.
const DETECTION_LENGTH = 65_536;

const isBlank = (fields: readonly string[]): boolean =>
  fields.every((field) => field.trim() === '');

/** The file's records, decoded and parsed as the bytes arrive. */
async function* records(
  body: Readable,
  limits: CsvFileLimits,
  named: CsvDelimiter | undefined,
  found: (delimiter: CsvDelimiter) => void,
): AsyncGenerator<CsvRecord, void, void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (bytes?: Buffer): string => {
    try {
      return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
    } catch {
      throw new ImportFileError(
        'not_utf8',
        'This file is not saved as UTF-8. Save it as "CSV UTF-8" in your spreadsheet and upload it again.',
      );
    }
  };
  let parser: ReturnType<typeof createCsvParser> | undefined;
  let head = '';
  const parse = (text: string, last: boolean): CsvRecord[] => {
    if (text.includes('\u0000'))
      throw new ImportFileError(
        'nul_character',
        'This file holds characters that text cannot: it may be saved as UTF-16. Save it as "CSV UTF-8" in your spreadsheet and upload it again.',
      );
    try {
      if (parser === undefined) {
        head += text;
        // Wait for the whole first row, or enough of it, before choosing how to read it.
        if (!last && head.length < DETECTION_LENGTH && !/[\r\n]/.test(head)) return [];
        const delimiter = named ?? detectCsvDelimiter(head);
        found(delimiter);
        parser = createCsvParser({
          delimiter,
          maxFields: limits.columns,
          maxFieldLength: limits.cellLength,
          maxRecordLength: limits.rowLength,
        });
        const first = parser.push(head);
        head = '';
        return last ? [...first, ...parser.end()] : first;
      }
      return last ? [...parser.push(text), ...parser.end()] : parser.push(text);
    } catch (error) {
      if (error instanceof CsvError)
        throw new ImportFileError(error.code, error.message, error.row);
      throw error;
    }
  };
  for await (const chunk of body) yield* parse(decode(chunk as Buffer), false);
  yield* parse(decode(), true);
}

/**
 * Opens a file's bytes as CSV: reads its header and gives its rows of data. Throws
 * ImportFileError when the file can't be read as CSV, at once for the header and from
 * rows() for what comes after.
 */
export async function openCsvFile(
  body: Readable,
  options: { readonly delimiter?: CsvDelimiter | undefined; readonly limits?: CsvFileLimits } = {},
): Promise<CsvFile> {
  const limits = options.limits ?? IMPORT_FILE_LIMITS;
  let delimiter: CsvDelimiter = options.delimiter ?? ',';
  const source = records(body, limits, options.delimiter, (found) => {
    delimiter = found;
  });
  const close = (): void => {
    body.destroy();
  };
  try {
    const first = await source.next();
    if (first.done === true || isBlank(first.value.fields))
      throw new ImportFileError(
        'header_missing',
        'The first row of the file is empty. It must name the columns.',
        1,
      );
    const header = first.value.fields.map((cell) => cell.trim());
    return {
      delimiter,
      header,
      close,
      async *rows() {
        try {
          let index = 0;
          for await (const record of source) {
            if (isBlank(record.fields)) continue;
            if (index >= limits.rows)
              throw new ImportFileError(
                'too_many_rows',
                `This file has more than ${limits.rows.toLocaleString('en-US')} rows. Split it into smaller files and import them one after another.`,
                record.row,
              );
            yield { row: record.row, index, cells: record.fields };
            index += 1;
          }
        } finally {
          close();
        }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** A cell of a row by its column, trimmed; empty when the row has no such cell. */
export function cellOf(row: CsvRow, column: number): string {
  return (row.cells[column] ?? '').trim();
}
