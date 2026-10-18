// CSV as RFC 4180 describes it (https://www.rfc-editor.org/rfc/rfc4180, section 2), read a
// piece at a time so a file is never held whole, and written back.
//
// Where the RFC is stricter than files in the wild, this reads what it must and refuses the
// rest by name:
// - a record ends at CRLF (the RFC's rule), and also at a line feed or a carriage return
//   alone, which spreadsheets on other systems write;
// - an empty line is a record of one empty field, so records are numbered as a spreadsheet
//   numbers its rows;
// - a quote inside an unquoted field, text after a closing quote and a quote never closed
//   are refused: guessing what was meant would put the wrong text in the wrong column.
// A byte order mark at the very start is not data. Nothing else is trimmed or changed: a
// value starting with = is the text it is.

/** The characters a file may separate its fields with. */
export const csvDelimiters = [',', ';', '\t', '|'] as const;

export type CsvDelimiter = (typeof csvDelimiters)[number];

export interface CsvParserOptions {
  /** A comma unless said otherwise. */
  readonly delimiter?: CsvDelimiter;
  /** The most characters one field may hold. */
  readonly maxFieldLength?: number;
  /** The most characters one record's fields may hold together. */
  readonly maxRecordLength?: number;
  /** The most fields one record may have. */
  readonly maxFields?: number;
}

export interface CsvRecord {
  /** Its place in the file, from 1: the row a spreadsheet shows it on. */
  readonly row: number;
  readonly fields: string[];
}

export type CsvErrorCode =
  | 'stray_quote'
  | 'text_after_quote'
  | 'unterminated_quote'
  | 'field_too_long'
  | 'record_too_long'
  | 'too_many_fields';

const explanations: Readonly<Record<CsvErrorCode, string>> = {
  stray_quote: 'has a quotation mark inside a value that is not quoted.',
  text_after_quote: 'has text right after a closing quotation mark.',
  unterminated_quote: 'opens a quotation mark that is never closed.',
  field_too_long: 'has a value that is too long.',
  record_too_long: 'is too long.',
  too_many_fields: 'has too many columns.',
};

/** Why a text isn't CSV this reads, and the record that shows it. */
export class CsvError extends Error {
  override readonly name = 'CsvError';
  readonly code: CsvErrorCode;
  readonly row: number;

  constructor(code: CsvErrorCode, row: number) {
    super(`Row ${String(row)} ${explanations[code]}`);
    this.code = code;
    this.row = row;
  }
}

export interface CsvParser {
  /** The records the text completes, in order. Throws CsvError at the first fault. */
  push(text: string): CsvRecord[];
  /** The last record, when the text didn't end with a line break. */
  end(): CsvRecord[];
}

const QUOTE = '"';
const BYTE_ORDER_MARK = '\uFEFF';

/** Where the parser is within a field. */
type Place = 'field_start' | 'unquoted' | 'quoted' | 'quote_in_quoted';

export function createCsvParser(options: CsvParserOptions = {}): CsvParser {
  const delimiter = options.delimiter ?? ',';
  const maxFieldLength = options.maxFieldLength ?? Number.POSITIVE_INFINITY;
  const maxRecordLength = options.maxRecordLength ?? Number.POSITIVE_INFINITY;
  const maxFields = options.maxFields ?? Number.POSITIVE_INFINITY;

  let place: Place = 'field_start';
  let fields: string[] = [];
  let field = '';
  // The record's length so far, without the field being read.
  let recordLength = 0;
  // The record being read: a quote that never closes is reported where it opened.
  let row = 1;
  // No text has come yet: a byte order mark is only one at the very start.
  let first = true;
  // A carriage return ended the last record: a line feed right after it is the same break.
  let afterCarriageReturn = false;
  let ended = false;

  const fail = (code: CsvErrorCode): never => {
    ended = true;
    throw new CsvError(code, row);
  };

  /** Adds text to the field being read, within the limits. */
  const grow = (text: string): void => {
    field += text;
    if (field.length > maxFieldLength) fail('field_too_long');
    if (recordLength + field.length > maxRecordLength) fail('record_too_long');
  };

  const endField = (): void => {
    if (fields.length >= maxFields) fail('too_many_fields');
    fields.push(field);
    recordLength += field.length;
    field = '';
    place = 'field_start';
  };

  const endRecord = (out: CsvRecord[]): void => {
    endField();
    out.push({ row, fields });
    fields = [];
    recordLength = 0;
    row += 1;
  };

  return {
    push(text) {
      if (ended) throw new Error('The parser has already ended.');
      const out: CsvRecord[] = [];
      let at = 0;
      if (first && text.length > 0) {
        first = false;
        if (text.startsWith(BYTE_ORDER_MARK)) at = 1;
      }
      // Runs of ordinary characters are taken in one slice, from `from` to the character
      // that ends them.
      let from = at;
      const take = (until: number): void => {
        if (until > from) grow(text.slice(from, until));
      };
      for (; at < text.length; at += 1) {
        const character = text[at];
        if (afterCarriageReturn) {
          afterCarriageReturn = false;
          if (character === '\n') {
            from = at + 1;
            continue;
          }
        }
        if (place === 'quoted') {
          if (character === QUOTE) {
            take(at);
            from = at + 1;
            place = 'quote_in_quoted';
          }
          continue;
        }
        if (place === 'quote_in_quoted') {
          if (character === QUOTE) {
            // A doubled quote is one quote of the field.
            from = at;
            place = 'quoted';
            continue;
          }
          if (character !== delimiter && character !== '\r' && character !== '\n')
            fail('text_after_quote');
        }
        if (character === delimiter) {
          take(at);
          from = at + 1;
          endField();
        } else if (character === '\r' || character === '\n') {
          take(at);
          from = at + 1;
          endRecord(out);
          afterCarriageReturn = character === '\r';
        } else if (character === QUOTE) {
          if (place !== 'field_start') fail('stray_quote');
          from = at + 1;
          place = 'quoted';
        } else if (place === 'field_start') {
          place = 'unquoted';
        }
      }
      // What is left belongs to the field being read. Taking it now also holds a field
      // with no end to its limit, a piece at a time.
      if (place === 'unquoted' || place === 'quoted') take(text.length);
      return out;
    },

    end() {
      if (ended) throw new Error('The parser has already ended.');
      if (place === 'quoted') fail('unterminated_quote');
      ended = true;
      const out: CsvRecord[] = [];
      // Nothing after the last line break is no record; anything else is the last one.
      if (place !== 'field_start' || fields.length > 0) endRecord(out);
      return out;
    },
  };
}

/**
 * The delimiter a file's first record uses most, outside quotes; a comma when it uses
 * none, or two equally. Give it the start of the file: it reads no further than the first
 * record's end.
 */
export function detectCsvDelimiter(head: string): CsvDelimiter {
  const counts = new Map<string, number>(csvDelimiters.map((each) => [each, 0]));
  let quoted = false;
  for (const character of head) {
    if (character === QUOTE) quoted = !quoted;
    else if (!quoted && (character === '\r' || character === '\n')) break;
    else if (!quoted && counts.has(character))
      counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let best: CsvDelimiter = ',';
  for (const each of csvDelimiters)
    if ((counts.get(each) ?? 0) > (counts.get(best) ?? 0)) best = each;
  return best;
}

export interface CsvFormatOptions {
  /** A comma unless said otherwise. */
  readonly delimiter?: CsvDelimiter;
  /**
   * For a file people open in a spreadsheet, holding text they didn't write. A spreadsheet
   * may run a cell as a formula when it starts with = + - @, a tab, a carriage return, a
   * line feed, or the full-width form of one of the four signs. So each such cell is given
   * a leading apostrophe, every cell is quoted, and every quote inside is doubled (OWASP,
   * "CSV Injection", https://owasp.org/www-community/attacks/CSV_Injection). The
   * apostrophe is in the file: reading it back gives the cell with it. OWASP notes that
   * Excel may undo this when it saves the file and opens it again; the file is for reading.
   */
  readonly spreadsheetSafe?: boolean;
}

// The characters OWASP's page lists, in its order; the last four are the full-width signs.
// A sign after leading spaces (any Unicode space, such as a no-break or an ideographic one)
// counts too: some spreadsheets trim them before they read the cell.
const RUNS_AS_FORMULA = /^(?:[\t\r\n]|[\p{Zs}]*[=+\-@＝＋－＠])/u;

/** One record as a line of CSV, ending in CRLF. */
export function formatCsvRecord(fields: readonly string[], options: CsvFormatOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  const safe = options.spreadsheetSafe === true;
  const cells = fields.map((value) => {
    const cell = safe && RUNS_AS_FORMULA.test(value) ? `'${value}` : value;
    const mustQuote =
      safe ||
      cell.includes(delimiter) ||
      cell.includes(QUOTE) ||
      cell.includes('\r') ||
      cell.includes('\n') ||
      // Unquoted at the start of a file, it would be read as the file's byte order mark.
      cell.startsWith(BYTE_ORDER_MARK);
    return mustQuote ? `${QUOTE}${cell.replaceAll(QUOTE, QUOTE + QUOTE)}${QUOTE}` : cell;
  });
  return `${cells.join(delimiter)}\r\n`;
}
