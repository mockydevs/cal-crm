import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  createCsvParser,
  CsvError,
  detectCsvDelimiter,
  formatCsvRecord,
  type CsvParserOptions,
  type CsvRecord,
} from './index.js';

/** Every record of a whole text, as their fields. */
function parse(text: string, options: CsvParserOptions = {}): string[][] {
  const parser = createCsvParser(options);
  return [...parser.push(text), ...parser.end()].map((record) => record.fields);
}

/** The same, fed in the pieces given. */
function parseInPieces(pieces: readonly string[], options: CsvParserOptions = {}): CsvRecord[] {
  const parser = createCsvParser(options);
  return [...pieces.flatMap((piece) => parser.push(piece)), ...parser.end()];
}

function errorOf(text: string, options: CsvParserOptions = {}): CsvError {
  try {
    parse(text, options);
  } catch (error) {
    if (error instanceof CsvError) return error;
    throw error;
  }
  throw new Error('The text was parsed.');
}

// RFC 4180, section 2, rule by rule. Each expected value is written out by hand.
describe('createCsvParser', () => {
  it('reads records separated by CRLF, with or without one after the last', () => {
    expect(parse('aaa,bbb,ccc\r\nzzz,yyy,xxx\r\n')).toEqual([
      ['aaa', 'bbb', 'ccc'],
      ['zzz', 'yyy', 'xxx'],
    ]);
    expect(parse('aaa,bbb,ccc\r\nzzz,yyy,xxx')).toEqual([
      ['aaa', 'bbb', 'ccc'],
      ['zzz', 'yyy', 'xxx'],
    ]);
  });

  it('takes a line feed or a carriage return alone as the end of a record too', () => {
    expect(parse('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parse('a,b\rc,d\r')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps spaces as part of a field', () => {
    expect(parse(' a , b ')).toEqual([[' a ', ' b ']]);
  });

  it('reads a quoted field with commas, line breaks and doubled quotes inside it', () => {
    expect(parse('"aaa","b\r\nbb","c,cc"\r\n"say ""hi""",,""')).toEqual([
      ['aaa', 'b\r\nbb', 'c,cc'],
      ['say "hi"', '', ''],
    ]);
    expect(parse('"line one\nline two\rline three"')).toEqual([['line one\nline two\rline three']]);
  });

  it('keeps an empty last field, and reads an empty line as a record of one empty field', () => {
    expect(parse('a,\r\n,\r\n')).toEqual([
      ['a', ''],
      ['', ''],
    ]);
    expect(parse('a\r\n\r\nb')).toEqual([['a'], [''], ['b']]);
    expect(parse('')).toEqual([]);
    expect(parse('\r\n')).toEqual([['']]);
  });

  it('leaves a byte order mark out of the first field, and keeps one anywhere else', () => {
    expect(parse('\uFEFFname,email\r\n\uFEFFMaya,x')).toEqual([
      ['name', 'email'],
      ['\uFEFFMaya', 'x'],
    ]);
    expect(parse('\uFEFF"name",email')).toEqual([['name', 'email']]);
  });

  it('keeps values that a spreadsheet would run as formulas exactly as they are', () => {
    expect(parse('=1+1,+2,-3,@SUM(A1),"=HYPERLINK(""http://x.test"",""y"")"')).toEqual([
      ['=1+1', '+2', '-3', '@SUM(A1)', '=HYPERLINK("http://x.test","y")'],
    ]);
  });

  it('numbers each record from 1, counting empty lines, whatever line breaks are inside quotes', () => {
    expect(parseInPieces(['h\r\n"a\r\nb"\r\n\r\nc'])).toEqual([
      { row: 1, fields: ['h'] },
      { row: 2, fields: ['a\r\nb'] },
      { row: 3, fields: [''] },
      { row: 4, fields: ['c'] },
    ]);
  });

  it('reads the same records however the text is cut into pieces', () => {
    const text = '\uFEFF"a ""x""",b\r\n"c\r\nd",\r\ne,f\r\n';
    const whole = parseInPieces([text]);
    expect(whole.map((record) => record.fields)).toEqual([
      ['a "x"', 'b'],
      ['c\r\nd', ''],
      ['e', 'f'],
    ]);
    for (let cut = 0; cut <= text.length; cut += 1)
      expect(parseInPieces([text.slice(0, cut), text.slice(cut)])).toEqual(whole);
    // One UTF-16 unit at a time: the smallest pieces a decoder can hand over.
    const units = Array.from({ length: text.length }, (_unit, index) => text.charAt(index));
    expect(parseInPieces(units)).toEqual(whole);
  });

  it('reads another delimiter when told to, and then a comma is data', () => {
    expect(parse('a;b,c;"d;e"\r\n', { delimiter: ';' })).toEqual([['a', 'b,c', 'd;e']]);
    expect(parse('a\tb\t"c\td"', { delimiter: '\t' })).toEqual([['a', 'b', 'c\td']]);
  });

  it('refuses a quote inside an unquoted field, naming the record', () => {
    const error = errorOf('a,b\r\nc,d"e\r\n');
    expect(error).toMatchObject({ code: 'stray_quote', row: 2 });
    expect(error.message).toBe('Row 2 has a quotation mark inside a value that is not quoted.');
  });

  it('refuses text after a closing quote', () => {
    expect(errorOf('"a"b,c')).toMatchObject({ code: 'text_after_quote', row: 1 });
    expect(errorOf('x\r\n"a" ,c')).toMatchObject({ code: 'text_after_quote', row: 2 });
  });

  it('refuses a quoted field that never closes, naming the record it began in', () => {
    const error = errorOf('a\r\nb,"c\r\nd\r\ne');
    expect(error).toMatchObject({ code: 'unterminated_quote', row: 2 });
    expect(error.message).toBe('Row 2 opens a quotation mark that is never closed.');
  });

  it('refuses a field, a record or a field count over its limit, as soon as it is passed', () => {
    expect(errorOf('ab,abc', { maxFieldLength: 2 })).toMatchObject({
      code: 'field_too_long',
      row: 1,
    });
    expect(parse('ab,ab', { maxFieldLength: 2 })).toEqual([['ab', 'ab']]);
    expect(errorOf('ab,ab\r\nabc,ab', { maxRecordLength: 4 })).toMatchObject({
      code: 'record_too_long',
      row: 2,
    });
    expect(parse('ab,ab', { maxRecordLength: 4 })).toEqual([['ab', 'ab']]);
    expect(errorOf('a,b,c', { maxFields: 2 })).toMatchObject({ code: 'too_many_fields', row: 1 });
    expect(parse('a,b', { maxFields: 2 })).toEqual([['a', 'b']]);
  });

  it('stops at an over-long quoted field without waiting for its end', () => {
    const parser = createCsvParser({ maxFieldLength: 8 });
    expect(() => parser.push(`"${'x'.repeat(9)}`)).toThrow(CsvError);
  });

  it('gives nothing more once it has ended or refused', () => {
    const ended = createCsvParser();
    ended.push('a');
    expect(ended.end()).toEqual([{ row: 1, fields: ['a'] }]);
    expect(() => ended.push('b')).toThrow('The parser has already ended.');
    expect(() => ended.end()).toThrow('The parser has already ended.');
    const refused = createCsvParser();
    expect(() => refused.push('a"')).toThrow(CsvError);
    expect(() => refused.push('b')).toThrow('The parser has already ended.');
  });
});

const field = fc.oneof(
  fc.string(),
  fc.string({
    unit: fc.constantFrom(
      'a',
      ',',
      ';',
      '"',
      '\r',
      '\n',
      ' ',
      '=',
      '\t',
      '\uFF1D',
      '\uFF0D',
      '\uFEFF',
    ),
  }),
);
// What OWASP's CSV Injection page lists as starting a formula: = + - @, a tab, a carriage
// return, a line feed, and the full-width forms of the four signs; a sign counts after
// leading spaces too, which some spreadsheets trim.
const STARTS_A_FORMULA = /^(?:[\t\r\n]|\p{Zs}*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/u;
const records = fc.array(fc.array(field, { minLength: 1, maxLength: 6 }), { maxLength: 8 });
const delimiter = fc.constantFrom(',', ';', '\t', '|');

describe('formatCsvRecord', () => {
  it('quotes a field only where it must, and doubles the quotes inside it', () => {
    expect(formatCsvRecord(['aaa', 'b,b', 'say "hi"', 'two\r\nlines', '', ' padded '])).toBe(
      'aaa,"b,b","say ""hi""","two\r\nlines",, padded \r\n',
    );
  });

  it('quotes a field that holds the delimiter in use, and not a comma that is then data', () => {
    expect(formatCsvRecord(['a;b', 'c,d'], { delimiter: ';' })).toBe('"a;b";c,d\r\n');
  });

  it('quotes a first field that starts with a byte order mark, so a reader keeps it', () => {
    expect(formatCsvRecord(['\uFEFFa'])).toBe('"\uFEFFa"\r\n');
  });

  // OWASP, CSV Injection: a cell starting with one of the characters above is run by a
  // spreadsheet, so each is given a leading apostrophe, every cell is quoted, and every
  // quote inside is doubled.
  it('makes every cell safe to open in a spreadsheet when asked to', () => {
    expect(
      formatCsvRecord(
        ['=1+1', '+2', '-3', '@SUM(A1)', '\tx', '\rx', 'plain', '', "'=kept", 'a",=1+1'],
        { spreadsheetSafe: true },
      ),
    ).toBe(
      '"\'=1+1","\'+2","\'-3","\'@SUM(A1)","\'\tx","\'\rx","plain","","\'=kept","a"",=1+1"\r\n',
    );
    // A line feed first, and the full-width signs some locales read as the plain ones.
    expect(
      formatCsvRecord(['\n=1+1', '＝1+1', '＋2', '－3', '＠SUM(A1)', 'a＝b'], {
        spreadsheetSafe: true,
      }),
    ).toBe('"\'\n=1+1","\'＝1+1","\'＋2","\'－3","\'＠SUM(A1)","a＝b"\r\n');
  });

  // Some spreadsheets trim the spaces before a cell's first character when they read it, so
  // spaces, a no-break space or an ideographic space before a sign are as dangerous.
  it('also guards a cell whose sign comes after leading spaces', () => {
    expect(
      formatCsvRecord([' =1+1', '  +2', ' -3', '　@SUM(A1)', ' ＝1+1', ' plain'], {
        spreadsheetSafe: true,
      }),
    ).toBe('"\' =1+1","\'  +2","\' -3","\'　@SUM(A1)","\' ＝1+1"," plain"\r\n');
  });

  it('reads back what it wrote, for any records, any delimiter and any cutting into pieces', () => {
    fc.assert(
      fc.property(
        records,
        delimiter,
        fc.array(fc.nat(), { maxLength: 6 }),
        (given, chosen, cuts) => {
          const text = given
            .map((record) => formatCsvRecord(record, { delimiter: chosen }))
            .join('');
          const places = [...new Set(cuts.map((cut) => cut % (text.length + 1)))].sort(
            (left, right) => left - right,
          );
          const pieces = [0, ...places].map((start, index) =>
            text.slice(start, places[index] ?? text.length),
          );
          expect(
            parseInPieces(pieces, { delimiter: chosen }).map((record) => record.fields),
          ).toEqual(given);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('writes no cell a spreadsheet would run, and loses nothing, when made safe', () => {
    fc.assert(
      fc.property(records, (given) => {
        const text = given
          .map((record) => formatCsvRecord(record, { spreadsheetSafe: true }))
          .join('');
        const read = parse(text);
        for (const cell of read.flat()) expect(cell).not.toMatch(STARTS_A_FORMULA);
        // Taking the apostrophe back off gives the cell as it was.
        const restored = read.map((record, row) =>
          record.map((cell, column) =>
            STARTS_A_FORMULA.test(given[row]?.[column] ?? '') ? cell.slice(1) : cell,
          ),
        );
        expect(restored).toEqual(given);
        // Every cell is quoted: no cell begins anywhere but after a quote.
        for (const line of given.map((record) =>
          formatCsvRecord(record, { spreadsheetSafe: true }),
        ))
          expect(line.startsWith('"') && line.endsWith('"\r\n')).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('detectCsvDelimiter', () => {
  it('finds the delimiter the first record uses most, outside quotes', () => {
    expect(detectCsvDelimiter('name,email,phone\r\na,b,c')).toBe(',');
    expect(detectCsvDelimiter('name;email;phone\r\na;b;c')).toBe(';');
    expect(detectCsvDelimiter('name\temail\tphone')).toBe('\t');
    expect(detectCsvDelimiter('name|email|phone')).toBe('|');
    expect(detectCsvDelimiter('"Last, First";email;phone')).toBe(';');
    expect(detectCsvDelimiter('\uFEFF"a;b;c;d",x,y')).toBe(',');
  });

  it('says comma for one column, for a tie and for nothing at all', () => {
    expect(detectCsvDelimiter('email\r\na;b;c')).toBe(',');
    expect(detectCsvDelimiter('a,b;c')).toBe(',');
    expect(detectCsvDelimiter('')).toBe(',');
  });

  it('reads no further than the first record', () => {
    expect(detectCsvDelimiter('a,b\r\nc;d;e;f')).toBe(',');
    expect(detectCsvDelimiter('"a\r\n;;;",b')).toBe(',');
  });
});
